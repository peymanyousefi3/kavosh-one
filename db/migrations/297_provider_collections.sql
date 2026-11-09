-- Principal first enters processor receivable/customer credit. It is not bank
-- cash,tuition income,another tax charge or an automatic invoice allocation.
CREATE TABLE public.provider_collections(
 academy_id uuid NOT NULL,id uuid NOT NULL,invoice_id uuid NOT NULL,student_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,
 inspection_id uuid NOT NULL,start_id uuid NOT NULL,account_id text NOT NULL,livemode boolean NOT NULL,charge_id text NOT NULL,
 amount_minor numeric NOT NULL CHECK(amount_minor>0 AND amount_minor=trunc(amount_minor) AND amount_minor<1e38),
 collector_id uuid NOT NULL,collector_version integer NOT NULL,method_id uuid NOT NULL,method_version integer NOT NULL,
 holding_account uuid NOT NULL,holding_version integer NOT NULL,credit_account uuid NOT NULL,credit_version integer NOT NULL,
 received_at timestamptz NOT NULL,received_on date NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,account_id,livemode,charge_id),
 FOREIGN KEY(academy_id,invoice_id,student_id,class_id,hub_id) REFERENCES public.tuition_invoices(academy_id,id,student_id,class_id,hub_id),
 FOREIGN KEY(academy_id,inspection_id) REFERENCES public.checkout_provider_inspections(academy_id,id),FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id),
 FOREIGN KEY(academy_id,collector_id,collector_version) REFERENCES public.finance_collector_revisions(academy_id,collector_id,version),FOREIGN KEY(academy_id,method_id,method_version) REFERENCES public.finance_payment_method_revisions(academy_id,method_id,version),
 FOREIGN KEY(academy_id,holding_account,holding_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,credit_account,credit_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.provider_collections ENABLE ROW LEVEL SECURITY;ALTER TABLE public.provider_collections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.provider_collections USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.provider_collections FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write();
GRANT SELECT,INSERT ON public.provider_collections TO kavosh_runtime;
CREATE INDEX receipt_provider_reference ON public.tuition_receipts(academy_id,reference) WHERE reversal_id IS NULL AND reference<>'';
CREATE FUNCTION public.provider_collection_source(p_inspection uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('inspectionId',i.id,'startId',s.id,'requestId',r.id,'invoiceId',r.invoice_id,'studentId',r.student_id,'classId',r.class_id,'hubId',r.hub_id,
 'accountId',a.draft->>'accountId','livemode',a.draft->'livemode','chargeId',i.inspection->>'chargeId','amountMinor',trunc(r.amount_minor)::text,'currencyId',r.currency_id,'currencyCode',r.currency_code,'unitScale',r.unit_scale,
 'inspection',i.inspection,'recordedAt',i.received_at,'manualReferenceExists',EXISTS(SELECT 1 FROM public.tuition_receipts m WHERE m.academy_id=i.academy_id AND m.reversal_id IS NULL AND m.reference=i.inspection->>'chargeId'),'collectionId',(SELECT c.id FROM public.provider_collections c WHERE c.academy_id=i.academy_id AND c.account_id=a.draft->>'accountId' AND c.livemode=(a.draft->>'livemode')::boolean AND c.charge_id=i.inspection->>'chargeId'))
 FROM public.checkout_provider_inspections i JOIN public.payment_checkout_dispatch_starts s ON s.academy_id=i.academy_id AND s.id=i.start_id
 JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.payment_checkout_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id
 WHERE i.id=p_inspection AND NOT i.object_conflict AND i.inspection->>'state'='captured'
 AND i.id=(SELECT n.id FROM public.checkout_provider_inspections n WHERE n.academy_id=i.academy_id AND n.start_id=i.start_id ORDER BY n.received_at DESC,n.id DESC LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM(VALUES('session',i.inspection->>'sessionId'),('payment',i.inspection->>'paymentId'),('charge',i.inspection->>'chargeId')) o(kind,id)
 WHERE NOT EXISTS(SELECT 1 FROM public.checkout_provider_object_bindings b WHERE b.academy_id=i.academy_id AND b.account_id=a.draft->>'accountId' AND b.livemode=(a.draft->>'livemode')::boolean AND b.kind=o.kind AND b.object_id=o.id AND b.start_id=i.start_id))
$$;
CREATE FUNCTION public.guard_provider_collection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE src jsonb;p record;c record;m record;h record;l record;zone text;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PROVIDER_COLLECTION_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM public.lock_collector_funds(NEW.collector_id,NEW.holding_account);
 PERFORM id FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=NEW.invoice_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':checkout-provider:'||NEW.account_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':provider-charge:'||NEW.charge_id,0));
 src:=public.provider_collection_source(NEW.inspection_id);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF src IS NULL OR src->>'collectionId' IS NOT NULL OR src->'manualReferenceExists' IS DISTINCT FROM 'false'::jsonb OR(src->>'invoiceId')::uuid IS DISTINCT FROM NEW.invoice_id OR(src->>'startId')::uuid IS DISTINCT FROM NEW.start_id
 OR src->>'accountId' IS DISTINCT FROM NEW.account_id OR(src->>'livemode')::boolean IS DISTINCT FROM NEW.livemode OR src->>'chargeId' IS DISTINCT FROM NEW.charge_id OR(src->>'amountMinor')::numeric IS DISTINCT FROM NEW.amount_minor
 OR p.id IS NULL OR p.action IS DISTINCT FROM 'finance.provider-collection.record' OR p.status IS DISTINCT FROM 'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.privacy_capability IS DISTINCT FROM 'receipts.edit'
 OR p.review_context->'source' IS DISTINCT FROM src OR NOT public.report_comment_human_verified(NEW.created_by) OR NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND status='active')
 THEN RAISE EXCEPTION 'PROVIDER_COLLECTION_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 IF p.scope->'recordContext' IS DISTINCT FROM jsonb_build_object('hubId',NEW.hub_id,'classId',NEW.class_id,'studentId',NEW.student_id) THEN RAISE EXCEPTION 'PROVIDER_COLLECTION_SCOPE_INVALID' USING ERRCODE='23514';END IF;
 IF p.payload IS DISTINCT FROM jsonb_build_object('invoiceId',NEW.invoice_id,'inspectionId',NEW.inspection_id,'collector',jsonb_build_object('id',NEW.collector_id,'version',NEW.collector_version),'method',jsonb_build_object('id',NEW.method_id,'version',NEW.method_version),
 'holdingAccount',jsonb_build_object('id',NEW.holding_account,'version',NEW.holding_version),'creditAccount',jsonb_build_object('id',NEW.credit_account,'version',NEW.credit_version),'receivedAt',p.payload->>'receivedAt','period',p.payload->'period','reason',NEW.reason)
 OR(p.payload->>'receivedAt')::timestamptz IS DISTINCT FROM NEW.received_at THEN RAISE EXCEPTION 'PROVIDER_COLLECTION_PAYLOAD_INVALID' USING ERRCODE='23514';END IF;
 SELECT x.*,v.active,v.accounts INTO c FROM public.finance_collectors x JOIN public.finance_collector_revisions v ON v.academy_id=x.academy_id AND v.collector_id=x.id AND v.version=x.version WHERE x.academy_id=NEW.academy_id AND x.id=NEW.collector_id;
 SELECT x.*,v.active INTO m FROM public.finance_payment_methods x JOIN public.finance_payment_method_revisions v ON v.academy_id=x.academy_id AND v.method_id=x.id AND v.version=x.version WHERE x.academy_id=NEW.academy_id AND x.id=NEW.method_id;
 SELECT * INTO h FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.holding_account;
 SELECT * INTO l FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.credit_account;
 IF c.id IS NULL OR c.version IS DISTINCT FROM NEW.collector_version OR NOT c.active OR c.custody<>'third_party' OR(c.hub_id IS NOT NULL AND c.hub_id<>NEW.hub_id)
 OR m.id IS NULL OR m.version IS DISTINCT FROM NEW.method_version OR NOT m.active OR m.category NOT IN('credit_card','debit_card') OR(m.hub_id IS NOT NULL AND m.hub_id<>NEW.hub_id)
 OR h.id IS NULL OR h.version IS DISTINCT FROM NEW.holding_version OR NOT h.active OR h.operational_role<>'collector_receivable' OR h.currency_id IS DISTINCT FROM(src->>'currencyId')::uuid OR h.unit_scale IS DISTINCT FROM(src->>'unitScale')::integer OR(h.hub_id IS NOT NULL AND h.hub_id<>NEW.hub_id)
 OR l.id IS NULL OR l.version IS DISTINCT FROM NEW.credit_version OR NOT l.active OR l.kind<>'liability' OR l.normal_balance<>'credit' OR l.currency_id IS DISTINCT FROM h.currency_id OR l.unit_scale IS DISTINCT FROM h.unit_scale OR(l.hub_id IS NOT NULL AND l.hub_id<>NEW.hub_id)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.accounts) a WHERE a->>'id'=NEW.holding_account::text AND a->>'version'=NEW.holding_version::text AND a->>'currencyId'=h.currency_id::text)
 THEN RAISE EXCEPTION 'PROVIDER_COLLECTION_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) AND(p.requester_id=NEW.created_by OR NEW.student_id=NEW.created_by OR c.person_id=NEW.created_by OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=NEW.student_id AND guardian_id=NEW.created_by)) THEN RAISE EXCEPTION 'PROVIDER_COLLECTION_UPPER_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT time_zone INTO zone FROM public.classes WHERE academy_id=NEW.academy_id AND id=NEW.class_id;
 IF NEW.received_on IS DISTINCT FROM(NEW.received_at AT TIME ZONE zone)::date THEN RAISE EXCEPTION 'PROVIDER_COLLECTION_DATE_INVALID' USING ERRCODE='23514';END IF;NEW.created_at=transaction_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER provider_collection_guard BEFORE INSERT OR UPDATE OR DELETE ON public.provider_collections FOR EACH ROW EXECUTE FUNCTION public.guard_provider_collection();
-- A late manual entry with the same charge reference must not book the same
-- money again. Same charge lock on BOTH paths also covers different invoices.
CREATE FUNCTION public.guard_manual_provider_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.reference<>'' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':provider-charge:'||NEW.reference,0));
  IF EXISTS(SELECT 1 FROM public.provider_collections WHERE academy_id=NEW.academy_id AND charge_id=NEW.reference) THEN RAISE EXCEPTION 'PROVIDER_CHARGE_ALREADY_RECORDED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_manual_provider_reference BEFORE INSERT ON public.tuition_receipts FOR EACH ROW EXECUTE FUNCTION public.guard_manual_provider_reference();
CREATE FUNCTION public.complete_provider_collection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;j record;BEGIN
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF p.status IS DISTINCT FROM 'applied' OR p.reviewer_id IS DISTINCT FROM NEW.created_by OR j.id IS NULL OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.posted_by IS DISTINCT FROM NEW.created_by OR j.posted_on IS DISTINCT FROM NEW.received_on OR j.purpose<>'activity' OR j.reverses_id IS NOT NULL OR j.line_count<>2
 OR j.period_id IS DISTINCT FROM(p.payload#>>'{period,id}')::uuid OR j.period_version IS DISTINCT FROM(p.payload#>>'{period,version}')::integer
 OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=1 AND account_id=NEW.holding_account AND account_version=NEW.holding_version AND side='debit' AND amount_minor=NEW.amount_minor)
 OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=2 AND account_id=NEW.credit_account AND account_version=NEW.credit_version AND side='credit' AND amount_minor=NEW.amount_minor)
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.id AND actor_id=NEW.created_by AND created_at=transaction_timestamp() AND action='finance.provider-collection.recorded' AND changes=jsonb_build_object('approvalId',NEW.approval_id,'severity','critical','invoiceApplied',false,'bankSettled',false))
 THEN RAISE EXCEPTION 'PROVIDER_COLLECTION_POSTING_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER provider_collection_complete AFTER INSERT ON public.provider_collections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_provider_collection();
CREATE FUNCTION public.provider_collection_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND NEW.action='finance.provider-collection.record' AND NOT EXISTS(SELECT 1 FROM public.provider_collections c WHERE c.academy_id=NEW.academy_id AND c.id=NEW.target_id AND c.approval_id=NEW.id AND c.created_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PROVIDER_COLLECTION_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER provider_collection_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.provider_collection_effect_required();
CREATE FUNCTION public.provider_collection_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE hubs uuid[];ch uuid;mh uuid;BEGIN
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','checkouts.view','scope',NEW.scope),jsonb_build_object('capability','invoices.view','scope',NEW.scope),jsonb_build_object('capability','receipts.view','scope',NEW.scope));
 SELECT array_agg(hub_id ORDER BY id) INTO hubs FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id IN((NEW.payload#>>'{holdingAccount,id}')::uuid,(NEW.payload#>>'{creditAccount,id}')::uuid);
 IF cardinality(hubs) IS DISTINCT FROM 2 THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('accounts.view',hubs),public.approval_hub_binding('journals.view',hubs));END IF;
 SELECT hub_id INTO ch FROM public.finance_collectors WHERE academy_id=NEW.academy_id AND id=(NEW.payload#>>'{collector,id}')::uuid;
 SELECT hub_id INTO mh FROM public.finance_payment_methods WHERE academy_id=NEW.academy_id AND id=(NEW.payload#>>'{method,id}')::uuid;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('collectors.view',ARRAY[ch]),public.approval_hub_binding('payment-methods.view',ARRAY[mh]));RETURN NEW;
END $$;
CREATE TRIGGER zz_provider_collection_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='finance.provider-collection.record') EXECUTE FUNCTION public.provider_collection_privacy();
-- Extend the existing custody subledger in place,not a parallel balance.
DO $$ DECLARE definition text;BEGIN definition:=pg_get_viewdef('public.collector_fund_events'::regclass,true);
 EXECUTE 'CREATE OR REPLACE VIEW public.collector_fund_events WITH(security_invoker=true) AS '||rtrim(definition,E';\n ')||' UNION ALL SELECT c.academy_id,c.collector_id,c.holding_account,j.id,j.posted_on,c.amount_minor FROM public.provider_collections c JOIN public.finance_journals j ON j.academy_id=c.academy_id AND j.id=c.id';
END $$;
CREATE FUNCTION public.guard_provider_collection_correction() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.reverses_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.provider_collections WHERE academy_id=NEW.academy_id AND id=NEW.reverses_id) THEN RAISE EXCEPTION 'PROVIDER_COLLECTION_CORRECTION_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER provider_collection_correction BEFORE INSERT ON public.finance_journals FOR EACH ROW EXECUTE FUNCTION public.guard_provider_collection_correction();
REVOKE ALL ON FUNCTION public.provider_collection_source(uuid),public.guard_provider_collection(),public.complete_provider_collection(),public.provider_collection_effect_required(),public.provider_collection_privacy() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_provider_collection_correction() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_manual_provider_reference() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provider_collection_source(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 297 $$;

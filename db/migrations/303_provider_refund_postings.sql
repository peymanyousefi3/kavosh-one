-- Completed external refunds are recorded,never executed,by this workflow.
CREATE TABLE public.provider_refund_postings(
 academy_id uuid NOT NULL,id uuid NOT NULL,collection_id uuid NOT NULL,inspection_id uuid NOT NULL,refund_id text NOT NULL,
 account_id text NOT NULL,livemode boolean NOT NULL,amount_minor numeric NOT NULL CHECK(amount_minor>0 AND amount_minor=trunc(amount_minor) AND amount_minor<1e38),
 credit_version integer NOT NULL,holding_version integer NOT NULL,posted_on date NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,account_id,livemode,refund_id),
 FOREIGN KEY(academy_id,collection_id) REFERENCES public.provider_collections(academy_id,id),FOREIGN KEY(academy_id,inspection_id) REFERENCES public.checkout_refund_inspections(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX provider_refund_collection ON public.provider_refund_postings(academy_id,collection_id,posted_on,id);
ALTER TABLE public.provider_refund_postings ENABLE ROW LEVEL SECURITY;ALTER TABLE public.provider_refund_postings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.provider_refund_postings USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.provider_refund_postings FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write();
GRANT SELECT,INSERT ON public.provider_refund_postings TO kavosh_runtime;
CREATE FUNCTION public.provider_refund_source(p_collection uuid,p_inspection uuid,p_refund text,p_on date,p_exclude uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE c record;f record;r jsonb;latest jsonb;h record;l record;s jsonb;amount numeric;self_amount numeric:=0;booked uuid;manual boolean;
BEGIN
 SELECT pc.*,q.currency_id,q.currency_code,q.unit_scale,cl.time_zone INTO c FROM public.provider_collections pc JOIN public.payment_checkout_dispatch_starts st ON st.academy_id=pc.academy_id AND st.id=pc.start_id JOIN public.payment_checkout_attempts a ON a.academy_id=st.academy_id AND a.id=st.attempt_id JOIN public.payment_checkout_requests q ON q.academy_id=a.academy_id AND q.id=a.request_id JOIN public.classes cl ON cl.academy_id=pc.academy_id AND cl.id=pc.class_id WHERE pc.id=p_collection;
 SELECT * INTO f FROM public.checkout_refund_inspections WHERE academy_id=c.academy_id AND id=p_inspection AND start_id=c.start_id;
 IF c.id IS NULL OR f.id IS NULL OR f.object_conflict OR f.refund_inspection->>'state'<>'refund_page' OR f.refund_inspection->>'chargeId'<>c.charge_id OR p_on IS NULL OR p_on NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN RETURN NULL;END IF;
 SELECT value INTO r FROM jsonb_array_elements(f.refund_inspection->'refunds') WHERE value->>'id'=p_refund;
 SELECT e.value INTO latest FROM public.checkout_refund_inspections n CROSS JOIN LATERAL jsonb_array_elements(n.refund_inspection->'refunds') e WHERE n.academy_id=c.academy_id AND n.start_id=c.start_id AND e.value->>'id'=p_refund ORDER BY n.received_at DESC,n.id DESC LIMIT 1;
 IF r IS NULL OR r->>'status' IS DISTINCT FROM 'succeeded' OR latest IS DISTINCT FROM r OR r->>'currency'<>lower(c.currency_code)
 OR NOT EXISTS(SELECT 1 FROM public.checkout_refund_object_bindings b WHERE b.academy_id=c.academy_id AND b.account_id=c.account_id AND b.livemode=c.livemode AND b.refund_id=p_refund AND b.start_id=c.start_id AND b.charge_id=c.charge_id AND b.amount=(r->>'amount')::numeric AND b.currency=r->>'currency')
 OR EXISTS(SELECT 1 FROM public.checkout_refund_inspections bad WHERE bad.academy_id=c.academy_id AND bad.start_id=c.start_id AND bad.object_conflict AND bad.refund_inspection->'refunds' @> jsonb_build_array(jsonb_build_object('id',p_refund))) THEN RETURN NULL;END IF;
 amount:=(r->>'amount')::numeric*power(10::numeric,c.unit_scale)/power(10::numeric,(f.refund_inspection->>'providerUnitScale')::integer);
 IF amount<>trunc(amount) OR amount<=0 OR amount>c.amount_minor OR p_on<c.received_on OR p_on<(to_timestamp((r->>'createdAt')::double precision) AT TIME ZONE c.time_zone)::date THEN RETURN NULL;END IF;
 SELECT * INTO h FROM public.finance_account_catalogue WHERE academy_id=c.academy_id AND id=c.holding_account;SELECT * INTO l FROM public.finance_account_catalogue WHERE academy_id=c.academy_id AND id=c.credit_account;
 IF h.id IS NULL OR l.id IS NULL OR NOT h.active OR NOT l.active OR h.operational_role<>'collector_receivable' OR l.kind<>'liability' OR l.normal_balance<>'credit' OR h.currency_id<>c.currency_id OR l.currency_id<>c.currency_id OR h.unit_scale<>c.unit_scale OR l.unit_scale<>c.unit_scale THEN RETURN NULL;END IF;
 s:=public.dated_customer_credit_source(c.id,c.invoice_id,p_on::timestamp AT TIME ZONE c.time_zone);
 SELECT amount_minor INTO self_amount FROM public.provider_refund_postings WHERE academy_id=c.academy_id AND id=p_exclude AND collection_id=c.id AND posted_on=p_on;
 SELECT id INTO booked FROM public.provider_refund_postings WHERE academy_id=c.academy_id AND account_id=c.account_id AND livemode=c.livemode AND refund_id=p_refund AND(p_exclude IS NULL OR id<>p_exclude);
 SELECT EXISTS(SELECT 1 FROM public.finance_journals j WHERE j.academy_id=c.academy_id AND j.reference=p_refund AND j.reverses_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.finance_journals v WHERE v.academy_id=j.academy_id AND v.reverses_id=j.id AND v.posted_on<=p_on)) INTO manual;
 RETURN jsonb_build_object('collectionId',c.id,'invoiceId',c.invoice_id,'studentId',c.student_id,'classId',c.class_id,'hubId',c.hub_id,'inspectionId',f.id,'refund',r,'accountId',c.account_id,'livemode',c.livemode,'amountMinor',trunc(amount)::text,'currencyId',c.currency_id,'currencyCode',c.currency_code,'unitScale',c.unit_scale,'creditAccountId',c.credit_account,'creditVersion',l.version,'holdingAccountId',c.holding_account,'holdingVersion',h.version,'collectorId',c.collector_id,'availableCreditMinor',((s->>'remainingMinor')::numeric+coalesce(self_amount,0))::text,'postedOn',p_on::text,'bookedId',booked,'manualReferenceExists',manual,'refundExecutionPerformed',false,'bankSettlementVerified',false);
END $$;
CREATE FUNCTION public.guard_provider_refund_posting() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c record;p record;s jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PROVIDER_REFUND_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM public.provider_collections WHERE academy_id=NEW.academy_id AND id=NEW.collection_id;PERFORM public.lock_customer_credit(NEW.collection_id);PERFORM public.lock_collector_funds(c.collector_id,c.holding_account);PERFORM id FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=c.invoice_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':checkout-provider:'||c.account_id,0));IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':provider-refund:'||NEW.refund_id,0)) THEN RAISE EXCEPTION 'PROVIDER_REFUND_REFERENCE_BUSY' USING ERRCODE='40001';END IF;
 s:=public.provider_refund_source(NEW.collection_id,NEW.inspection_id,NEW.refund_id,NEW.posted_on);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s IS NULL OR s->>'bookedId' IS NOT NULL OR s->'manualReferenceExists' IS DISTINCT FROM 'false'::jsonb OR NEW.amount_minor IS DISTINCT FROM(s->>'amountMinor')::numeric OR NEW.amount_minor>(s->>'availableCreditMinor')::numeric
 OR NEW.account_id IS DISTINCT FROM s->>'accountId' OR NEW.livemode IS DISTINCT FROM(s->>'livemode')::boolean OR NEW.credit_version IS DISTINCT FROM(s->>'creditVersion')::integer OR NEW.holding_version IS DISTINCT FROM(s->>'holdingVersion')::integer
 OR p.id IS NULL OR p.action IS DISTINCT FROM 'finance.provider-refund.record' OR p.status IS DISTINCT FROM 'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'receipts.edit' OR p.review_context->'source' IS DISTINCT FROM s
 OR p.payload IS DISTINCT FROM jsonb_build_object('collectionId',NEW.collection_id,'inspectionId',NEW.inspection_id,'refundId',NEW.refund_id,'postedOn',NEW.posted_on::text,'period',p.payload->'period','reason',NEW.reason)
 OR p.scope->'recordContext' IS DISTINCT FROM jsonb_build_object('hubId',c.hub_id,'classId',c.class_id,'studentId',c.student_id) OR NOT public.report_comment_human_verified(NEW.created_by) OR NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND status='active') THEN RAISE EXCEPTION 'PROVIDER_REFUND_SOURCE_OR_REVIEW_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) AND(p.requester_id=NEW.created_by OR c.student_id=NEW.created_by OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=c.student_id AND guardian_id=NEW.created_by) OR EXISTS(SELECT 1 FROM public.finance_collectors WHERE academy_id=NEW.academy_id AND id=c.collector_id AND person_id=NEW.created_by)) THEN RAISE EXCEPTION 'PROVIDER_REFUND_UPPER_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=transaction_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER provider_refund_posting BEFORE INSERT OR UPDATE OR DELETE ON public.provider_refund_postings FOR EACH ROW EXECUTE FUNCTION public.guard_provider_refund_posting();
CREATE FUNCTION public.complete_provider_refund_posting() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE c record;p record;j record;BEGIN
 SELECT * INTO c FROM public.provider_collections WHERE academy_id=NEW.academy_id AND id=NEW.collection_id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF p.status IS DISTINCT FROM 'applied' OR p.reviewer_id IS DISTINCT FROM NEW.created_by OR j.id IS NULL OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.posted_by IS DISTINCT FROM NEW.created_by OR j.posted_on IS DISTINCT FROM NEW.posted_on OR j.purpose<>'activity' OR j.reverses_id IS NOT NULL OR j.line_count<>2 OR j.reference IS DISTINCT FROM 'provider-refund:'||NEW.id::text
 OR j.period_id IS DISTINCT FROM(p.payload#>>'{period,id}')::uuid OR j.period_version IS DISTINCT FROM(p.payload#>>'{period,version}')::integer
 OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=1 AND account_id=c.credit_account AND account_version=NEW.credit_version AND side='debit' AND amount_minor=NEW.amount_minor)
 OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=2 AND account_id=c.holding_account AND account_version=NEW.holding_version AND side='credit' AND amount_minor=NEW.amount_minor)
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.id AND actor_id=NEW.created_by AND created_at=transaction_timestamp() AND action='finance.provider-refund.recorded' AND changes=jsonb_build_object('approvalId',NEW.approval_id,'collectionId',NEW.collection_id,'severity','critical','refundExecuted',false,'bankSettled',false)) THEN RAISE EXCEPTION 'PROVIDER_REFUND_POSTING_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER provider_refund_complete AFTER INSERT ON public.provider_refund_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_provider_refund_posting();
CREATE FUNCTION public.provider_refund_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND NEW.action='finance.provider-refund.record' AND NOT EXISTS(SELECT 1 FROM public.provider_refund_postings WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PROVIDER_REFUND_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER provider_refund_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.provider_refund_effect_required();
CREATE FUNCTION public.provider_refund_journal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.reverses_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.provider_refund_postings WHERE academy_id=NEW.academy_id AND id=NEW.reverses_id) THEN RAISE EXCEPTION 'PROVIDER_REFUND_CORRECTION_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.reference~'^re_[A-Za-z0-9]+$' THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':provider-refund:'||NEW.reference,0)) THEN RAISE EXCEPTION 'PROVIDER_REFUND_REFERENCE_BUSY' USING ERRCODE='40001';END IF;
  IF EXISTS(SELECT 1 FROM public.provider_refund_postings WHERE academy_id=NEW.academy_id AND refund_id=NEW.reference) THEN RAISE EXCEPTION 'PROVIDER_REFUND_ALREADY_RECORDED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER provider_refund_journal BEFORE INSERT ON public.finance_journals FOR EACH ROW EXECUTE FUNCTION public.provider_refund_journal_guard();
CREATE FUNCTION public.provider_refund_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE c record;hubs uuid[];ch uuid;BEGIN
 SELECT * INTO c FROM public.provider_collections WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'collectionId')::uuid;
 IF c.id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','receipts.view','scope',NEW.scope),jsonb_build_object('capability','checkouts.view','scope',NEW.scope),jsonb_build_object('capability','invoices.view','scope',NEW.scope));
 SELECT array_agg(hub_id ORDER BY id) INTO hubs FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id IN(c.credit_account,c.holding_account);
 SELECT hub_id INTO ch FROM public.finance_collectors WHERE academy_id=NEW.academy_id AND id=c.collector_id;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('accounts.view',hubs),public.approval_hub_binding('journals.view',hubs),public.approval_hub_binding('collectors.view',ARRAY[ch]));RETURN NEW;
END $$;
CREATE TRIGGER zz_provider_refund_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='finance.provider-refund.record') EXECUTE FUNCTION public.provider_refund_privacy();
DO $$ DECLARE original text;changed text;definition text;BEGIN
 original:=pg_get_functiondef('public.customer_credit_reservation_usage(uuid,uuid,uuid,date)'::regprocedure);
 changed:=replace(original,'),invoice_events AS MATERIALIZED(',' UNION ALL SELECT r.posted_on,r.amount_minor FROM public.provider_refund_postings r WHERE r.academy_id=p_academy AND r.collection_id=p_collection ),invoice_events AS MATERIALIZED(');
 IF changed=original THEN RAISE EXCEPTION 'REFUND_CREDIT_USAGE_MARKER_MISSING';END IF;EXECUTE changed;
 definition:=pg_get_viewdef('public.collector_fund_events'::regclass,true);EXECUTE 'CREATE OR REPLACE VIEW public.collector_fund_events WITH(security_invoker=true) AS '||rtrim(definition,E';\n ')||' UNION ALL SELECT r.academy_id,c.collector_id,c.holding_account,r.id,r.posted_on,-r.amount_minor FROM public.provider_refund_postings r JOIN public.provider_collections c ON c.academy_id=r.academy_id AND c.id=r.collection_id';
END $$;
REVOKE ALL ON FUNCTION public.provider_refund_source(uuid,uuid,text,date,uuid),public.guard_provider_refund_posting(),public.complete_provider_refund_posting(),public.provider_refund_effect_required(),public.provider_refund_journal_guard(),public.provider_refund_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provider_refund_source(uuid,uuid,text,date,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 303 $$;

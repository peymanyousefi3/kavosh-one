-- Cashless application:debit the existing customer-credit liability,credit AR.
-- The existing receipt/installment/share/payroll subledgers see tuition paid,
-- while processor custody and cash are not collected a second time.
ALTER TABLE public.tuition_receipts ADD COLUMN provider_collection_id uuid,
 ADD FOREIGN KEY(academy_id,provider_collection_id) REFERENCES public.provider_collections(academy_id,id);
CREATE TABLE public.customer_credit_applications(
 academy_id uuid NOT NULL,id uuid NOT NULL,collection_id uuid NOT NULL,invoice_id uuid NOT NULL,amount_minor numeric NOT NULL CHECK(amount_minor>0 AND amount_minor=trunc(amount_minor) AND amount_minor<1e38),
 credit_version integer NOT NULL,applied_at timestamptz NOT NULL,applied_on date NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,collection_id) REFERENCES public.provider_collections(academy_id,id),FOREIGN KEY(academy_id,invoice_id) REFERENCES public.tuition_invoices(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,id) REFERENCES public.tuition_receipts(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX customer_credit_collection ON public.customer_credit_applications(academy_id,collection_id,id);
CREATE INDEX customer_credit_invoice ON public.customer_credit_applications(academy_id,invoice_id,id);
CREATE INDEX provider_inspection_attention ON public.checkout_provider_inspections(academy_id,start_id,(inspection->>'chargeId')) WHERE object_conflict OR inspection->>'state'='requires_review';
ALTER TABLE public.customer_credit_applications ENABLE ROW LEVEL SECURITY;ALTER TABLE public.customer_credit_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.customer_credit_applications USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.customer_credit_applications FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write();
GRANT SELECT,INSERT ON public.customer_credit_applications TO kavosh_runtime;
CREATE FUNCTION public.lock_customer_credit(p_collection uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(current_setting('app.academy_id')||':customer-credit:'||p_collection::text,0));
END $$;
CREATE FUNCTION public.customer_credit_source(p_collection uuid,p_invoice uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('collection',jsonb_build_object('id',c.id,'invoiceId',c.invoice_id,'studentId',c.student_id,'classId',c.class_id,'hubId',c.hub_id,'amountMinor',c.amount_minor::text,'receivedAt',c.received_at,'creditAccountId',c.credit_account,'creditVersion',ca.version,'collectorId',c.collector_id,'collectorVersion',c.collector_version,'methodId',c.method_id,'methodVersion',c.method_version),
 'invoice',jsonb_build_object('id',i.id,'studentId',i.student_id,'classId',i.class_id,'hubId',i.hub_id,'creditId',i.credit_id,'journalId',i.journal_id,'issuedAt',doc.issued_at,'receivableId',i.receivable_account,'receivableVersion',ar.version,'timeZone',cl.time_zone),
 'currencyId',p.currency_id,'currencyCode',r.currency_code,'unitScale',r.unit_scale,
 'remainingMinor',(c.amount_minor-coalesce((SELECT sum(a.amount_minor) FROM public.customer_credit_applications a LEFT JOIN public.tuition_receipts t ON t.academy_id=a.academy_id AND t.id=a.id WHERE a.academy_id=c.academy_id AND a.collection_id=c.id AND t.reversal_id IS NULL),0))::text,
 'outstandingMinor',(CASE WHEN i.credit_id IS NULL THEN terms.gross_minor ELSE 0 END-coalesce((SELECT sum(t.amount_minor) FROM public.tuition_receipts t WHERE t.academy_id=i.academy_id AND t.invoice_id=i.id AND t.reversal_id IS NULL),0)-coalesce((SELECT sum(a.amount_minor) FROM public.customer_credit_applications a WHERE a.academy_id=i.academy_id AND a.invoice_id=i.id AND NOT EXISTS(SELECT 1 FROM public.tuition_receipts t WHERE t.academy_id=a.academy_id AND t.id=a.id)),0))::text,
 'providerInspectionFingerprint',encode(sha256(convert_to(latest.inspection::text,'UTF8')),'hex'),'providerReviewRequired',latest.id IS NULL OR latest.object_conflict OR latest.inspection->>'state'<>'captured' OR latest.inspection->>'chargeId' IS DISTINCT FROM c.charge_id
 OR EXISTS(SELECT 1 FROM public.checkout_provider_inspections bad WHERE bad.academy_id=c.academy_id AND bad.start_id=c.start_id AND(bad.object_conflict OR bad.inspection->>'state'='requires_review') AND(bad.object_conflict OR bad.inspection->>'chargeId'=c.charge_id)))
 FROM public.provider_collections c JOIN public.payment_checkout_dispatch_starts st ON st.academy_id=c.academy_id AND st.id=c.start_id
 JOIN public.payment_checkout_attempts at ON at.academy_id=st.academy_id AND at.id=st.attempt_id JOIN public.payment_checkout_requests r ON r.academy_id=at.academy_id AND r.id=at.request_id
 JOIN public.tuition_invoices i ON i.academy_id=c.academy_id AND i.id=p_invoice AND i.student_id=c.student_id
 JOIN public.billing_documents doc ON doc.academy_id=i.academy_id AND doc.id=i.id
 JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id AND p.currency_id=r.currency_id AND p.unit_scale=r.unit_scale
 JOIN public.tuition_plan_revisions terms ON terms.academy_id=i.academy_id AND terms.plan_id=i.plan_id AND terms.version=i.plan_version
 JOIN public.classes cl ON cl.academy_id=i.academy_id AND cl.id=i.class_id
 JOIN public.finance_account_catalogue ca ON ca.academy_id=c.academy_id AND ca.id=c.credit_account JOIN public.finance_account_catalogue ar ON ar.academy_id=i.academy_id AND ar.id=i.receivable_account
 LEFT JOIN LATERAL(SELECT n.id,n.object_conflict,n.inspection FROM public.checkout_provider_inspections n WHERE n.academy_id=c.academy_id AND n.start_id=c.start_id ORDER BY n.received_at DESC,n.id DESC LIMIT 1) latest ON true
 WHERE c.id=p_collection
$$;
CREATE FUNCTION public.guard_customer_credit_application() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE src jsonb;p record;requested numeric;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM public.lock_customer_credit(NEW.collection_id);
 PERFORM id FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=NEW.invoice_id FOR UPDATE;
 src:=public.customer_credit_source(NEW.collection_id,NEW.invoice_id);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF src IS NULL OR src->'providerReviewRequired' IS DISTINCT FROM 'false'::jsonb OR src#>'{invoice,creditId}' IS DISTINCT FROM 'null'::jsonb OR src#>>'{invoice,journalId}' IS NULL
 OR NEW.amount_minor>(src->>'remainingMinor')::numeric OR NEW.amount_minor>(src->>'outstandingMinor')::numeric OR NEW.credit_version IS DISTINCT FROM(src#>>'{collection,creditVersion}')::integer
 OR NEW.applied_at<(src#>>'{collection,receivedAt}')::timestamptz OR NEW.applied_at<(src#>>'{invoice,issuedAt}')::timestamptz OR NEW.applied_on IS DISTINCT FROM(NEW.applied_at AT TIME ZONE(src#>>'{invoice,timeZone}'))::date
 OR p.id IS NULL OR p.action IS DISTINCT FROM 'finance.customer-credit.apply' OR p.status IS DISTINCT FROM 'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.privacy_capability IS DISTINCT FROM 'receipts.edit'
 OR p.review_context->'source' IS DISTINCT FROM src OR NOT public.report_comment_human_verified(NEW.created_by) OR NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND status='active')
 THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 IF p.scope->'recordContext' IS DISTINCT FROM jsonb_build_object('hubId',(src#>>'{invoice,hubId}')::uuid,'classId',(src#>>'{invoice,classId}')::uuid,'studentId',(src#>>'{invoice,studentId}')::uuid) THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_SCOPE_INVALID' USING ERRCODE='23514';END IF;
 IF p.payload IS DISTINCT FROM jsonb_build_object('collectionId',NEW.collection_id,'invoiceId',NEW.invoice_id,'amount',p.payload->'amount','appliedAt',p.payload->>'appliedAt','period',p.payload->'period','allocation',p.payload->>'allocation','reason',NEW.reason)
 OR(p.payload->>'appliedAt')::timestamptz IS DISTINCT FROM NEW.applied_at OR p.payload->>'allocation' IS NULL OR p.payload->>'allocation' NOT IN('oldest_due','unallocated') THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_PAYLOAD_INVALID' USING ERRCODE='23514';END IF;
 IF p.payload->'amount'='null'::jsonb THEN requested:=least((src->>'remainingMinor')::numeric,(src->>'outstandingMinor')::numeric);
 ELSE IF length(p.payload->>'amount')>80 OR(p.payload->>'amount')!~'^[0-9]+([.][0-9]+)?$' THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_AMOUNT_INVALID' USING ERRCODE='23514';END IF;requested:=(p.payload->>'amount')::numeric*power(10::numeric,(src->>'unitScale')::integer);END IF;
 IF requested IS DISTINCT FROM NEW.amount_minor THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_AMOUNT_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.finance_account_catalogue a WHERE a.academy_id=NEW.academy_id AND a.id=(src#>>'{collection,creditAccountId}')::uuid AND a.version=NEW.credit_version AND a.active AND a.kind='liability' AND a.normal_balance='credit' AND a.currency_id=(src->>'currencyId')::uuid AND a.unit_scale=(src->>'unitScale')::integer) THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_ACCOUNT_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) AND(p.requester_id=NEW.created_by OR(src#>>'{invoice,studentId}')::uuid=NEW.created_by OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=(src#>>'{invoice,studentId}')::uuid AND guardian_id=NEW.created_by)) THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_UPPER_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=transaction_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER customer_credit_application BEFORE INSERT OR UPDATE OR DELETE ON public.customer_credit_applications FOR EACH ROW EXECUTE FUNCTION public.guard_customer_credit_application();
CREATE FUNCTION public.validate_credit_application_receipt(t public.tuition_receipts) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;c record;BEGIN
 SELECT * INTO a FROM public.customer_credit_applications WHERE academy_id=t.academy_id AND id=t.id;
 SELECT * INTO c FROM public.provider_collections WHERE academy_id=t.academy_id AND id=a.collection_id;
 IF a.id IS NULL OR c.id IS NULL OR t.provider_collection_id IS DISTINCT FROM c.id OR t.invoice_id IS DISTINCT FROM a.invoice_id OR t.amount_minor IS DISTINCT FROM a.amount_minor OR t.holding_account IS DISTINCT FROM c.credit_account OR t.holding_version IS DISTINCT FROM a.credit_version
 OR t.collector_id IS DISTINCT FROM c.collector_id OR t.collector_version IS DISTINCT FROM c.collector_version OR t.method_id IS DISTINCT FROM c.method_id OR t.method_version IS DISTINCT FROM c.method_version OR t.received_at IS DISTINCT FROM a.applied_at OR t.received_on IS DISTINCT FROM a.applied_on
 OR t.approval_id IS DISTINCT FROM a.approval_id OR t.created_by IS DISTINCT FROM a.created_by OR t.reason IS DISTINCT FROM a.reason OR t.reference IS DISTINCT FROM 'credit-application:'||a.id::text
 OR t.received_by IS NOT NULL OR t.evidence_file IS NOT NULL OR t.evidence_version IS NOT NULL OR t.missing_evidence_reason IS DISTINCT FROM 'Recorded customer-credit application' OR t.tax_treatment IS DISTINCT FROM 'settle_invoice'
 THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_RECEIPT_INVALID' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION public.lock_credit_application_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.provider_collection_id IS NOT NULL THEN PERFORM public.lock_customer_credit(NEW.provider_collection_id);END IF;RETURN NEW;
END $$;
CREATE TRIGGER a_credit_application_lock BEFORE INSERT OR UPDATE ON public.tuition_receipts FOR EACH ROW EXECUTE FUNCTION public.lock_credit_application_receipt();
CREATE FUNCTION public.complete_customer_credit_application() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;t record;BEGIN
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 SELECT * INTO t FROM public.tuition_receipts WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF p.status IS DISTINCT FROM 'applied' OR p.reviewer_id IS DISTINCT FROM NEW.created_by OR t.id IS NULL OR t.provider_collection_id IS DISTINCT FROM NEW.collection_id
 OR NOT EXISTS(SELECT 1 FROM public.finance_journals j WHERE j.academy_id=NEW.academy_id AND j.id=NEW.id AND j.period_id=(p.payload#>>'{period,id}')::uuid AND j.period_version=(p.payload#>>'{period,version}')::integer)
 OR(p.payload->>'allocation'='oldest_due' AND NOT EXISTS(SELECT 1 FROM public.receipt_allocation_revisions a WHERE a.academy_id=NEW.academy_id AND a.receipt_id=NEW.id AND a.version=1 AND a.approval_id=NEW.approval_id AND a.total_minor=NEW.amount_minor))
 OR(p.payload->>'allocation'='unallocated' AND EXISTS(SELECT 1 FROM public.receipt_allocation_plans WHERE academy_id=NEW.academy_id AND receipt_id=NEW.id))
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.id AND actor_id=NEW.created_by AND created_at=transaction_timestamp() AND action='finance.customer-credit.applied' AND changes=jsonb_build_object('approvalId',NEW.approval_id,'collectionId',NEW.collection_id,'severity','critical','newFundsReceived',false))
 THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_APPLICATION_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER customer_credit_complete AFTER INSERT ON public.customer_credit_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_customer_credit_application();
CREATE FUNCTION public.customer_credit_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND NEW.action='finance.customer-credit.apply' AND NOT EXISTS(SELECT 1 FROM public.customer_credit_applications WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER customer_credit_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.customer_credit_effect_required();
-- Reuse the existing complete receipt/journal/installment validation below;
-- only the explicitly linked cashless receipt gets its narrow mapping branch.
CREATE OR REPLACE FUNCTION public.provider_collection_source(p_inspection uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('inspectionId',i.id,'startId',s.id,'requestId',r.id,'invoiceId',r.invoice_id,'studentId',r.student_id,'classId',r.class_id,'hubId',r.hub_id,
 'accountId',a.draft->>'accountId','livemode',a.draft->'livemode','chargeId',i.inspection->>'chargeId','amountMinor',trunc(r.amount_minor)::text,'currencyId',r.currency_id,'currencyCode',r.currency_code,'unitScale',r.unit_scale,
 'inspection',i.inspection,'recordedAt',i.received_at,'manualReferenceExists',EXISTS(SELECT 1 FROM public.tuition_receipts m WHERE m.academy_id=i.academy_id AND m.reversal_id IS NULL AND m.reference=i.inspection->>'chargeId'),'collectionId',(SELECT c.id FROM public.provider_collections c WHERE c.academy_id=i.academy_id AND c.account_id=a.draft->>'accountId' AND c.livemode=(a.draft->>'livemode')::boolean AND c.charge_id=i.inspection->>'chargeId'))
 FROM public.checkout_provider_inspections i JOIN public.payment_checkout_dispatch_starts s ON s.academy_id=i.academy_id AND s.id=i.start_id
 JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.payment_checkout_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id
 WHERE i.id=p_inspection AND NOT i.object_conflict AND i.inspection->>'state'='captured'
 AND i.inspection=(SELECT CASE WHEN n.object_conflict THEN NULL ELSE n.inspection END FROM public.checkout_provider_inspections n WHERE n.academy_id=i.academy_id AND n.start_id=i.start_id ORDER BY n.received_at DESC,n.id DESC LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM(VALUES('session',i.inspection->>'sessionId'),('payment',i.inspection->>'paymentId'),('charge',i.inspection->>'chargeId')) o(kind,id)
 WHERE NOT EXISTS(SELECT 1 FROM public.checkout_provider_object_bindings b WHERE b.academy_id=i.academy_id AND b.account_id=a.draft->>'accountId' AND b.livemode=(a.draft->>'livemode')::boolean AND b.kind=o.kind AND b.object_id=o.id AND b.start_id=i.start_id))
 AND NOT EXISTS(SELECT 1 FROM public.checkout_provider_inspections bad WHERE bad.academy_id=i.academy_id AND bad.start_id=i.start_id AND(bad.object_conflict OR bad.inspection->>'state'='requires_review') AND(bad.object_conflict OR bad.inspection->>'chargeId'=i.inspection->>'chargeId'))
$$;
CREATE FUNCTION public.customer_credit_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE c record;s jsonb;hubs uuid[];BEGIN
 IF NEW.action='finance.customer-credit.apply' THEN SELECT * INTO c FROM public.provider_collections WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'collectionId')::uuid;
 ELSE SELECT p.* INTO c FROM public.tuition_receipts t JOIN public.provider_collections p ON p.academy_id=t.academy_id AND p.id=t.provider_collection_id WHERE t.academy_id=NEW.academy_id AND t.id=(NEW.payload->>'receiptId')::uuid;IF NOT FOUND THEN RETURN NEW;END IF;END IF;
 IF c.id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 s:=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',c.student_id,'hubId',c.hub_id)),'recordContext',jsonb_build_object('hubId',c.hub_id,'classId',c.class_id,'studentId',c.student_id));
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','receipts.view','scope',s),jsonb_build_object('capability','receipts.edit','scope',s),jsonb_build_object('capability','checkouts.view','scope',s),jsonb_build_object('capability','invoices.view','scope',s),jsonb_build_object('capability','receipts.view','scope',NEW.scope),jsonb_build_object('capability','invoices.view','scope',NEW.scope));
 SELECT array_agg(hub_id) INTO hubs FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=c.credit_account;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('accounts.view',hubs),public.approval_hub_binding('journals.view',hubs));RETURN NEW;
END $$;
CREATE TRIGGER zz_customer_credit_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.customer-credit.apply','finance.receipt.reverse')) EXECUTE FUNCTION public.customer_credit_privacy();
CREATE OR REPLACE VIEW public.collector_fund_events WITH(security_invoker=true) AS
 SELECT r.academy_id,r.collector_id,r.holding_account,j.id AS journal_id,j.posted_on,r.amount_minor AS delta_minor FROM public.tuition_receipts r JOIN public.finance_collectors c ON c.academy_id=r.academy_id AND c.id=r.collector_id AND c.custody='third_party' JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=r.academy_id AND h.id=r.id OFFSET 0) j ON true WHERE r.provider_collection_id IS NULL
 UNION ALL SELECT r.academy_id,r.collector_id,r.holding_account,j.id,j.posted_on,-r.amount_minor FROM public.tuition_receipt_reversals v JOIN public.tuition_receipts r ON r.academy_id=v.academy_id AND r.id=v.receipt_id JOIN public.finance_collectors c ON c.academy_id=r.academy_id AND c.id=r.collector_id AND c.custody='third_party' JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=v.academy_id AND h.id=v.id OFFSET 0) j ON true WHERE r.provider_collection_id IS NULL
 UNION ALL SELECT r.academy_id,r.collector_id,r.holding_account,r.id,r.posted_on,CASE WHEN r.direction='to_academy' THEN -r.amount_minor ELSE r.amount_minor END FROM public.collector_remittances r
 UNION ALL SELECT r.academy_id,r.collector_id,r.holding_account,j.id,j.posted_on,CASE WHEN r.direction='to_academy' THEN r.amount_minor ELSE -r.amount_minor END FROM public.collector_remittance_reversals v JOIN public.collector_remittances r ON r.academy_id=v.academy_id AND r.id=v.remittance_id JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=v.academy_id AND h.id=v.id OFFSET 0) j ON true
 UNION ALL SELECT p.academy_id,p.collector_id,p.funding_account,p.id,p.posted_on,-p.amount_minor FROM public.expense_payments p WHERE p.settlement_kind='collector_offset'
 UNION ALL SELECT p.academy_id,p.collector_id,p.funding_account,j.id,j.posted_on,p.amount_minor FROM public.expense_payment_reversals r JOIN public.expense_payments p ON p.academy_id=r.academy_id AND p.id=r.payment_id JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=r.academy_id AND h.id=r.id OFFSET 0) j ON true WHERE p.settlement_kind='collector_offset'
 UNION ALL SELECT c.academy_id,c.collector_id,c.holding_account,j.id,j.posted_on,c.amount_minor FROM public.provider_collections c JOIN public.finance_journals j ON j.academy_id=c.academy_id AND j.id=c.id;
CREATE OR REPLACE FUNCTION public.guard_tuition_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE i record;c record;m record;a record;gross numeric;received numeric;time_zone text;
BEGIN
 IF TG_OP='UPDATE' THEN IF OLD.reversal_id IS NOT NULL OR NEW.reversal_id IS NULL THEN RAISE EXCEPTION 'RECEIPT_REVERSAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT x.*,d.issued_at INTO i FROM public.tuition_invoices x JOIN public.billing_documents d ON d.academy_id=x.academy_id AND d.id=x.id WHERE x.academy_id=NEW.academy_id AND x.id=NEW.invoice_id FOR UPDATE OF x;
 SELECT r.gross_minor INTO gross FROM public.tuition_plan_revisions r WHERE r.academy_id=NEW.academy_id AND r.plan_id=i.plan_id AND r.version=i.plan_version;
 SELECT coalesce(sum(amount_minor),0) INTO received FROM public.tuition_receipts WHERE academy_id=NEW.academy_id AND invoice_id=NEW.invoice_id AND reversal_id IS NULL;
 SELECT cl.time_zone INTO time_zone FROM public.classes cl WHERE cl.academy_id=NEW.academy_id AND cl.id=i.class_id;
 IF i.id IS NULL OR i.credit_id IS NOT NULL OR NEW.received_at<i.issued_at OR NEW.received_on IS DISTINCT FROM(NEW.received_at AT TIME ZONE time_zone)::date OR received+NEW.amount_minor>gross THEN RAISE EXCEPTION 'RECEIPT_INVOICE_BALANCE_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.provider_collection_id IS NOT NULL THEN PERFORM public.validate_credit_application_receipt(NEW::public.tuition_receipts);RETURN NEW;END IF;
 SELECT h.hub_id,h.custody,h.version,r.active,r.accounts INTO c FROM public.finance_collectors h JOIN public.finance_collector_revisions r ON r.academy_id=h.academy_id AND r.collector_id=h.id AND r.version=h.version WHERE h.academy_id=NEW.academy_id AND h.id=NEW.collector_id;
 SELECT h.hub_id,h.version,r.active INTO m FROM public.finance_payment_methods h JOIN public.finance_payment_method_revisions r ON r.academy_id=h.academy_id AND r.method_id=h.id AND r.version=h.version WHERE h.academy_id=NEW.academy_id AND h.id=NEW.method_id;
 SELECT h.currency_id,h.version,h.hub_id,r.active,r.operational_role INTO a FROM public.finance_accounts h JOIN public.finance_account_revisions r ON r.academy_id=h.academy_id AND r.account_id=h.id AND r.version=h.version WHERE h.academy_id=NEW.academy_id AND h.id=NEW.holding_account;
 IF c.version IS DISTINCT FROM NEW.collector_version OR NOT c.active OR(c.hub_id IS NOT NULL AND c.hub_id<>i.hub_id) OR m.version IS DISTINCT FROM NEW.method_version OR NOT m.active OR(m.hub_id IS NOT NULL AND m.hub_id<>i.hub_id)
  OR a.version IS DISTINCT FROM NEW.holding_version OR NOT a.active OR(a.hub_id IS NOT NULL AND a.hub_id<>i.hub_id) OR NEW.holding_account=i.receivable_account
  OR(c.custody='academy_funds' AND a.operational_role NOT IN ('cash','bank')) OR(c.custody='third_party' AND a.operational_role<>'collector_receivable')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.accounts) entry WHERE entry->>'id'=NEW.holding_account::text AND entry->>'version'=NEW.holding_version::text AND entry->>'currencyId'=a.currency_id::text)
  OR a.currency_id IS DISTINCT FROM(SELECT p.currency_id FROM public.tuition_plans p WHERE p.academy_id=NEW.academy_id AND p.id=i.plan_id)
  OR NOT EXISTS(SELECT 1 FROM public.finance_account_catalogue ar WHERE ar.academy_id=NEW.academy_id AND ar.id=i.receivable_account AND ar.operational_role='receivable') THEN RAISE EXCEPTION 'RECEIPT_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.received_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.people p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.received_by AND p.kind='human' AND p.status='active') THEN RAISE EXCEPTION 'RECEIPT_RECEIVER_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.evidence_file IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.file_records f WHERE f.academy_id=NEW.academy_id AND f.id=NEW.evidence_file AND f.version=NEW.evidence_version AND f.person_id=i.student_id AND f.domain='student_private' AND NOT f.archived) THEN RAISE EXCEPTION 'RECEIPT_EVIDENCE_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.id AND p.target_version=0 AND p.action='finance.receipt.record' AND p.status IN ('pending','applied') AND p.privacy_capability='receipts.edit') THEN RAISE EXCEPTION 'RECEIPT_APPROVAL_MISMATCH' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.guard_allocation_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE i record;r record;BEGIN
 SELECT x.id,x.plan_id,x.plan_version,x.credit_id INTO i FROM public.tuition_invoices x JOIN public.tuition_receipts p ON p.academy_id=x.academy_id AND p.invoice_id=x.id WHERE p.academy_id=NEW.academy_id AND p.id=NEW.receipt_id FOR UPDATE OF x;
 SELECT * INTO r FROM public.tuition_receipts WHERE academy_id=NEW.academy_id AND id=NEW.receipt_id FOR UPDATE;
 IF i.id IS NULL OR i.credit_id IS NOT NULL OR r.reversal_id IS NOT NULL OR NEW.plan_id IS DISTINCT FROM i.plan_id OR NEW.plan_version IS DISTINCT FROM i.plan_version
  OR NOT EXISTS(SELECT 1 FROM public.receipt_allocation_plans h WHERE h.academy_id=NEW.academy_id AND h.receipt_id=NEW.receipt_id AND h.version=NEW.version)
  OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.receipt_id AND p.target_version=NEW.version-1 AND p.status IN ('pending','applied') AND(
   (p.action='finance.receipt.allocate' AND p.privacy_capability='allocations.edit') OR
   (NEW.version=1 AND NEW.mode='oldest_due' AND p.action IN('finance.receipt.record','finance.customer-credit.apply') AND p.privacy_capability='receipts.edit' AND p.payload->>'allocation'='oldest_due')
  )) THEN RAISE EXCEPTION 'ALLOCATION_SOURCE_OR_APPROVAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.validate_allocation_complete(p_academy uuid,p_receipt uuid,p_version integer) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v public.receipt_allocation_revisions%ROWTYPE;r public.tuition_receipts%ROWTYPE;n integer;amount numeric;
BEGIN
 SELECT * INTO v FROM public.receipt_allocation_revisions WHERE academy_id=p_academy AND receipt_id=p_receipt AND version=p_version;
 SELECT * INTO r FROM public.tuition_receipts WHERE academy_id=p_academy AND id=p_receipt;
 SELECT count(*),coalesce(sum(amount_minor),0) INTO n,amount FROM public.receipt_allocation_lines WHERE academy_id=p_academy AND receipt_id=p_receipt AND version=p_version;
 IF v.receipt_id IS NULL OR n<>v.line_count OR amount<>v.total_minor OR amount>r.amount_minor OR NOT EXISTS(SELECT 1 FROM public.receipt_allocation_plans h WHERE h.academy_id=p_academy AND h.receipt_id=p_receipt AND h.version=p_version) THEN RAISE EXCEPTION 'ALLOCATION_TOTAL_INVALID' USING ERRCODE='23514';END IF;
 IF EXISTS(
  WITH other_allocated AS MATERIALIZED(
   SELECT other.installment,sum(other.amount_minor) AS amount FROM public.receipt_allocation_lines other JOIN public.receipt_allocation_plans h ON h.academy_id=other.academy_id AND h.receipt_id=other.receipt_id AND h.version=other.version JOIN public.tuition_receipts p ON p.academy_id=other.academy_id AND p.id=other.receipt_id
   WHERE p.academy_id=p_academy AND p.invoice_id=r.invoice_id AND p.id<>p_receipt AND p.reversal_id IS NULL GROUP BY other.installment)
  SELECT 1 FROM public.receipt_allocation_lines l JOIN public.tuition_installments t ON t.academy_id=l.academy_id AND t.plan_id=l.plan_id AND t.version=l.plan_version AND t.ordinal=l.installment LEFT JOIN other_allocated a ON a.installment=l.installment
  WHERE l.academy_id=p_academy AND l.receipt_id=p_receipt AND l.version=p_version AND l.amount_minor+coalesce(a.amount,0)>t.amount_minor
 ) THEN RAISE EXCEPTION 'INSTALLMENT_OVERALLOCATED' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=p_academy AND p.id=v.approval_id AND p.action IN('finance.receipt.record','finance.customer-credit.apply')) AND EXISTS(
  WITH other_allocated AS MATERIALIZED(
   SELECT l.installment,sum(l.amount_minor) AS amount FROM public.receipt_allocation_lines l JOIN public.receipt_allocation_plans h ON h.academy_id=l.academy_id AND h.receipt_id=l.receipt_id AND h.version=l.version JOIN public.tuition_receipts p ON p.academy_id=h.academy_id AND p.id=h.receipt_id
   WHERE p.academy_id=p_academy AND p.invoice_id=r.invoice_id AND p.id<>p_receipt AND p.reversal_id IS NULL GROUP BY l.installment),
  capacity AS(SELECT t.ordinal,t.due_on,greatest(t.amount_minor-coalesce(a.amount,0),0) AS available FROM public.tuition_installments t LEFT JOIN other_allocated a ON a.installment=t.ordinal WHERE t.academy_id=p_academy AND t.plan_id=v.plan_id AND t.version=v.plan_version),
  ordered AS(SELECT *,coalesce(sum(available) OVER(ORDER BY due_on,ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS preceding FROM capacity),
  wanted AS(SELECT ordinal,greatest(least(available,r.amount_minor-preceding),0) AS amount FROM ordered),
  actual AS(SELECT installment,amount_minor FROM public.receipt_allocation_lines WHERE academy_id=p_academy AND receipt_id=p_receipt AND version=p_version)
  SELECT 1 FROM wanted w FULL JOIN actual a ON a.installment=w.ordinal WHERE coalesce(w.amount,0) IS DISTINCT FROM coalesce(a.amount_minor,0)
 ) THEN RAISE EXCEPTION 'AUTOMATIC_ALLOCATION_MISMATCH' USING ERRCODE='23514';END IF;
END $$;
REVOKE ALL ON FUNCTION public.lock_customer_credit(uuid),public.customer_credit_source(uuid,uuid),public.guard_customer_credit_application(),public.validate_credit_application_receipt(public.tuition_receipts),public.lock_credit_application_receipt(),public.complete_customer_credit_application(),public.customer_credit_effect_required(),public.customer_credit_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_customer_credit(uuid),public.customer_credit_source(uuid,uuid),public.validate_credit_application_receipt(public.tuition_receipts) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 298 $$;

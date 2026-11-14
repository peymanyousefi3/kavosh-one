-- Reuse the real expense/AP/tax/payment subledgers. Provider availability is
-- not a bank deposit, and a fee label is not evidence of recoverable HST.
CREATE INDEX checkout_fee_balance_history ON public.checkout_fee_inspections(academy_id,(fee_inspection->>'balanceTransactionId'),received_at DESC,id DESC);
CREATE TABLE public.provider_fee_bills(
 academy_id uuid NOT NULL,bill_id uuid NOT NULL,inspection_id uuid NOT NULL,account_id text NOT NULL,livemode boolean NOT NULL,transaction_id text NOT NULL,
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,bill_id),FOREIGN KEY(academy_id,bill_id) REFERENCES public.expense_bills(academy_id,id),FOREIGN KEY(academy_id,inspection_id) REFERENCES public.checkout_fee_inspections(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE INDEX provider_fee_transaction_bills ON public.provider_fee_bills(academy_id,account_id,livemode,transaction_id,bill_id);
ALTER TABLE public.provider_fee_bills ENABLE ROW LEVEL SECURITY;ALTER TABLE public.provider_fee_bills FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.provider_fee_bills USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE TRIGGER provider_fee_write BEFORE INSERT OR UPDATE OR DELETE ON public.provider_fee_bills FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write();
CREATE FUNCTION public.provider_fee_source(p_inspection uuid,p_posted date,p_exclude uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r record;latest jsonb;result jsonb;claims jsonb;monetary_facts jsonb;counted integer;blocked boolean;
BEGIN
 IF p_posted IS NULL OR p_posted NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN RETURN NULL;END IF;
 SELECT f.*,a.request_id,a.draft,i.hub_id,i.class_id,i.student_id INTO r FROM public.checkout_fee_inspections f
 JOIN public.payment_checkout_dispatch_starts s ON s.academy_id=f.academy_id AND s.id=f.start_id JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id
 JOIN public.payment_checkout_requests q ON q.academy_id=a.academy_id AND q.id=a.request_id JOIN public.tuition_invoices i ON i.academy_id=q.academy_id AND i.id=q.invoice_id
 WHERE f.academy_id=tenant AND f.id=p_inspection;
 IF r.id IS NULL OR r.object_conflict OR r.fee_inspection->>'state'<>'charge_balance' OR(r.fee_inspection->>'feeAmount')::numeric<=0 THEN RETURN NULL;END IF;
 -- A refresh with different monetary facts must not let an older observation
 -- post stale fees. Equivalent refreshes do not invalidate human reviews.
 SELECT f.fee_inspection INTO latest FROM public.checkout_fee_inspections f JOIN public.payment_checkout_dispatch_starts s ON s.academy_id=f.academy_id AND s.id=f.start_id JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id
 WHERE f.academy_id=tenant AND a.draft->>'accountId'=r.draft->>'accountId' AND a.draft->'livemode'=r.draft->'livemode' AND f.fee_inspection->>'balanceTransactionId'=r.fee_inspection->>'balanceTransactionId' ORDER BY f.received_at DESC,f.id DESC LIMIT 1;
 IF latest-ARRAY['createdAt','availableOn','status','exchangeRate','feeDetails','feeBreakdownComplete','principalRequiresReview'] IS DISTINCT FROM r.fee_inspection-ARRAY['createdAt','availableOn','status','exchangeRate','feeDetails','feeBreakdownComplete','principalRequiresReview']
 OR EXISTS(SELECT 1 FROM public.checkout_fee_inspections f JOIN public.payment_checkout_dispatch_starts s ON s.academy_id=f.academy_id AND s.id=f.start_id JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE f.academy_id=tenant AND a.draft->>'accountId'=r.draft->>'accountId' AND a.draft->'livemode'=r.draft->'livemode' AND f.fee_inspection->>'balanceTransactionId'=r.fee_inspection->>'balanceTransactionId' AND f.object_conflict) THEN RETURN NULL;END IF;
 WITH history AS(SELECT b.id,b.posted_on,b.void_id,j.posted_on voided_on FROM public.provider_fee_bills f JOIN public.expense_bills b ON b.academy_id=f.academy_id AND b.id=f.bill_id LEFT JOIN public.finance_journals j ON j.academy_id=b.academy_id AND j.id=b.void_id WHERE f.academy_id=tenant AND f.account_id=r.draft->>'accountId' AND f.livemode=(r.draft->>'livemode')::boolean AND f.transaction_id=r.fee_inspection->>'balanceTransactionId' AND(p_exclude IS NULL OR b.id<>p_exclude) ORDER BY b.id LIMIT 10001)
 SELECT count(*),coalesce(bool_or(voided_on IS NULL OR voided_on>p_posted),false),coalesce(jsonb_agg(jsonb_build_array(id,posted_on,void_id,voided_on) ORDER BY id),'[]'::jsonb) INTO counted,blocked,claims FROM history;
 -- ponytail: bounded retained corrections per original processor transaction.
 IF counted>10000 OR blocked THEN RETURN NULL;END IF;
 -- Arrival order is not provider chronology. Retain distinct monetary facts
 -- in the review basis so a late old response cannot revive an older pending
 -- approval after a different fee was observed. Equivalent refreshes add none.
 WITH facts AS(SELECT DISTINCT jsonb_build_object('currencyCode',upper(f.fee_inspection->>'currency'),'providerUnitScale',f.fee_inspection->'providerUnitScale','grossMinor',f.fee_inspection->>'grossAmount','feeMinor',f.fee_inspection->>'feeAmount','netMinor',f.fee_inspection->>'netAmount') value
 FROM public.checkout_fee_inspections f JOIN public.payment_checkout_dispatch_starts s ON s.academy_id=f.academy_id AND s.id=f.start_id JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id
 WHERE f.academy_id=tenant AND a.draft->>'accountId'=r.draft->>'accountId' AND a.draft->'livemode'=r.draft->'livemode' AND f.fee_inspection->>'balanceTransactionId'=r.fee_inspection->>'balanceTransactionId' ORDER BY value LIMIT 101)
 SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO monetary_facts FROM facts;
 IF jsonb_array_length(monetary_facts)>100 THEN RETURN NULL;END IF;
 result=jsonb_build_object('inspectionId',r.id,'requestId',r.request_id,'invoiceId',r.draft->>'invoiceId','accountId',r.draft->>'accountId','livemode',r.draft->'livemode','balanceTransactionId',r.fee_inspection->>'balanceTransactionId','chargeId',r.fee_inspection->>'chargeId','currencyCode',upper(r.fee_inspection->>'currency'),'providerUnitScale',r.fee_inspection->'providerUnitScale','feeMinor',r.fee_inspection->>'feeAmount','hubId',r.hub_id,'classId',r.class_id,'studentId',r.student_id,'postedOn',p_posted::text,'providerTaxVerified',false,'bankSettled',false);
 result:=result||jsonb_build_object('monetaryObservations',monetary_facts,'providerLiveStateVerified',false);
 RETURN result||jsonb_build_object('sourceStamp',encode(sha256(convert_to(jsonb_build_array(result,claims)::text,'UTF8')),'hex'));
END $$;
CREATE FUNCTION public.guard_provider_fee_bill() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b record;p record;s jsonb;c record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PROVIDER_FEE_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':checkout-provider:'||NEW.account_id,0));
 SELECT * INTO b FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.bill_id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 SELECT * INTO c FROM public.finance_currencies WHERE academy_id=b.academy_id AND id=b.currency_id;s:=public.provider_fee_source(NEW.inspection_id,b.posted_on,NEW.bill_id);
 IF b.id IS NULL OR p.id IS NULL OR s IS NULL OR p.action IS DISTINCT FROM 'finance.expense.record' OR p.status IS DISTINCT FROM 'pending' OR p.target_id IS DISTINCT FROM NEW.bill_id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'expenses.edit'
 OR p.payload->'providerFee' IS DISTINCT FROM jsonb_build_object('inspectionId',NEW.inspection_id) OR p.payload ? 'sharing' OR p.review_context->'providerFee' IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s
 OR NEW.account_id IS DISTINCT FROM s->>'accountId' OR NEW.livemode IS DISTINCT FROM(s->>'livemode')::boolean OR NEW.transaction_id IS DISTINCT FROM s->>'balanceTransactionId'
 OR c.code IS DISTINCT FROM s->>'currencyCode' OR b.gross_minor*power(10::numeric,(s->>'providerUnitScale')::integer)<>(s->>'feeMinor')::numeric*power(10::numeric,b.unit_scale)
 OR b.approval_id IS DISTINCT FROM p.id OR b.created_by IS DISTINCT FROM NEW.created_by OR NOT public.report_comment_human_verified(NEW.created_by)
 OR EXISTS(SELECT 1 FROM public.expense_bill_lines l WHERE l.academy_id=b.academy_id AND l.bill_id=b.id AND(l.hub_id::text IS DISTINCT FROM s->>'hubId' OR l.class_id::text IS DISTINCT FROM s->>'classId' OR l.student_id::text IS DISTINCT FROM s->>'studentId')) THEN RAISE EXCEPTION 'PROVIDER_FEE_SOURCE_OR_REVIEW_INVALID' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER provider_fee_bill_guard BEFORE INSERT OR UPDATE OR DELETE ON public.provider_fee_bills FOR EACH ROW EXECUTE FUNCTION public.guard_provider_fee_bill();
CREATE FUNCTION public.lock_provider_fee_correction() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE account text;BEGIN
 SELECT account_id INTO account FROM public.provider_fee_bills WHERE academy_id=NEW.academy_id AND bill_id=NEW.id;
 IF account IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':checkout-provider:'||account,0));END IF;RETURN NEW;
END $$;
CREATE TRIGGER provider_fee_correction_lock BEFORE UPDATE OF void_id ON public.expense_bills FOR EACH ROW EXECUTE FUNCTION public.lock_provider_fee_correction();
CREATE CONSTRAINT TRIGGER provider_fee_reviewed AFTER INSERT ON public.provider_fee_bills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.complete_provider_fee_bill() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b record;p record;f record;
BEGIN
 SELECT * INTO b FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=b.academy_id AND id=b.approval_id;SELECT * INTO f FROM public.provider_fee_bills WHERE academy_id=b.academy_id AND bill_id=b.id;
 IF p.payload ? 'providerFee' THEN
  IF f.bill_id IS NULL OR f.source_snapshot IS DISTINCT FROM public.provider_fee_source(f.inspection_id,b.posted_on,b.id) OR b.void_id IS NOT NULL THEN RAISE EXCEPTION 'PROVIDER_FEE_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=b.academy_id AND a.entity_id=b.id AND a.actor_id=b.created_by AND a.action='finance.expense.recorded' AND a.created_at=transaction_timestamp() AND a.changes=jsonb_build_object('approvalId',b.approval_id,'severity','critical','hasReason',true)) THEN RAISE EXCEPTION 'PROVIDER_FEE_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;
 ELSIF f.bill_id IS NOT NULL THEN RAISE EXCEPTION 'PROVIDER_FEE_UNREQUESTED_EFFECT' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER provider_fee_bill_complete AFTER INSERT ON public.expense_bills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_provider_fee_bill();
CREATE FUNCTION public.provider_fee_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.expense.record' AND NEW.status='applied' AND NEW.payload ? 'providerFee' AND NOT EXISTS(SELECT 1 FROM public.provider_fee_bills f WHERE f.academy_id=NEW.academy_id AND f.bill_id=NEW.target_id AND f.approval_id=NEW.id AND f.created_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PROVIDER_FEE_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER provider_fee_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.provider_fee_effect_required();
CREATE FUNCTION public.provider_fee_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE inspection uuid;i record;scope jsonb;cap text;
BEGIN
 IF NEW.action='finance.expense.record' AND NEW.payload ? 'providerFee' THEN inspection:=(NEW.payload#>>'{providerFee,inspectionId}')::uuid;
 ELSIF NEW.action='finance.expense.void' THEN SELECT inspection_id INTO inspection FROM public.provider_fee_bills WHERE academy_id=NEW.academy_id AND bill_id=(NEW.payload->>'billId')::uuid;END IF;
 IF inspection IS NULL THEN IF NEW.payload ? 'providerFee' THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));END IF;RETURN NEW;END IF;
 SELECT t.* INTO i FROM public.checkout_fee_inspections f JOIN public.payment_checkout_dispatch_starts s ON s.academy_id=f.academy_id AND s.id=f.start_id JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.payment_checkout_requests q ON q.academy_id=a.academy_id AND q.id=a.request_id JOIN public.tuition_invoices t ON t.academy_id=q.academy_id AND t.id=q.invoice_id WHERE f.academy_id=NEW.academy_id AND f.id=inspection;
 IF i.id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',i.class_id,'hubId',i.hub_id)),'people',jsonb_build_array(jsonb_build_object('id',i.student_id,'hubId',i.hub_id)),'recordContext',jsonb_build_object('classId',i.class_id,'hubId',i.hub_id,'studentId',i.student_id));
 FOREACH cap IN ARRAY ARRAY['invoices.view','checkouts.view'] LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',scope));END LOOP;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_provider_fee_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.expense.record','finance.expense.void')) EXECUTE FUNCTION public.provider_fee_privacy();
REVOKE ALL ON FUNCTION public.provider_fee_source(uuid,date,uuid),public.guard_provider_fee_bill(),public.lock_provider_fee_correction(),public.complete_provider_fee_bill(),public.provider_fee_effect_required(),public.provider_fee_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provider_fee_source(uuid,date,uuid) TO kavosh_runtime;
GRANT SELECT ON public.provider_fee_bills TO kavosh_runtime;
GRANT INSERT(academy_id,bill_id,inspection_id,account_id,livemode,transaction_id,source_snapshot,approval_id,created_by) ON public.provider_fee_bills TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 300 $$;

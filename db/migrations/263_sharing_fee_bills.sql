-- A fee is a real expense/payable, not a second invoice receipt or a pretend
-- transfer of collector cash. Reuse the reviewed expense bill subledger.
CREATE TABLE public.sharing_fee_bills(
 academy_id uuid NOT NULL,bill_id uuid NOT NULL,invoice_id uuid NOT NULL,sharing_plan_id uuid NOT NULL,policy_version integer NOT NULL,
 payee_id uuid NOT NULL,as_of date NOT NULL CHECK(as_of BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,bill_id),FOREIGN KEY(academy_id,bill_id) REFERENCES public.expense_bills(academy_id,id),
 FOREIGN KEY(academy_id,invoice_id) REFERENCES public.tuition_invoices(academy_id,id),
 FOREIGN KEY(academy_id,sharing_plan_id,policy_version) REFERENCES public.revenue_share_revisions(academy_id,plan_id,version),
 FOREIGN KEY(academy_id,payee_id) REFERENCES public.financial_payees(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE INDEX sharing_fee_invoice_payee ON public.sharing_fee_bills(academy_id,invoice_id,payee_id,bill_id);
ALTER TABLE public.sharing_fee_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sharing_fee_bills FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.sharing_fee_bills USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE TRIGGER sharing_fee_write BEFORE INSERT OR UPDATE OR DELETE ON public.sharing_fee_bills FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write();

CREATE FUNCTION public.sharing_fee_capacity(p_invoice uuid,p_version integer,p_payee uuid,p_on date,p_posted date,p_exclude uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;s jsonb;posting_source jsonb;recipient jsonb;posting_recipient jsonb;activity jsonb;counted integer;billed numeric;released numeric;result jsonb;
BEGIN
 IF p_posted IS NULL OR p_posted NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' OR p_on>p_posted THEN RAISE EXCEPTION 'SHARING_FEE_DATE_INVALID' USING ERRCODE='22023';END IF;
 s=public.sharing_release_snapshot(p_invoice,p_version,p_on);IF s IS NULL THEN RETURN NULL;END IF;
 SELECT value INTO recipient FROM jsonb_array_elements(s->'rows') WHERE value->>'payeeId'=p_payee::text;
 IF recipient IS NULL OR recipient->>'kind'='academy' THEN RETURN NULL;END IF;
 -- An older cutoff must not bypass a receipt reversal/credit already effective
 -- by this bill's posting day. Later collections do not expand the older cutoff.
 posting_source=CASE WHEN p_on=p_posted THEN s ELSE public.sharing_release_snapshot(p_invoice,p_version,p_posted) END;
 SELECT value INTO posting_recipient FROM jsonb_array_elements(posting_source->'rows') WHERE value->>'payeeId'=p_payee::text;
 IF posting_recipient IS NULL THEN RETURN NULL;END IF;
 -- Reserve ALL linked bills across policy editions, including future bills.
 -- A future void cannot free capacity for an earlier replacement bill.
 -- ponytail: fail closed above10000 retained bills for one invoice/payee.
 WITH claims AS(
  SELECT b.id,b.net_minor,b.posted_on,b.void_id,j.posted_on voided_on
  FROM public.sharing_fee_bills f JOIN public.expense_bills b ON b.academy_id=f.academy_id AND b.id=f.bill_id
  LEFT JOIN public.finance_journals j ON j.academy_id=b.academy_id AND j.id=b.void_id
  WHERE f.academy_id=tenant AND f.invoice_id=p_invoice AND f.payee_id=p_payee AND(p_exclude IS NULL OR f.bill_id<>p_exclude)
  ORDER BY b.id LIMIT 10001
 ) SELECT count(*),coalesce(sum(net_minor) FILTER(WHERE voided_on IS NULL OR voided_on>p_posted),0),
  coalesce(jsonb_agg(jsonb_build_array(id,net_minor::text,posted_on,void_id,voided_on) ORDER BY id),'[]'::jsonb)
 INTO counted,billed,activity FROM claims;
 IF counted>10000 THEN RAISE EXCEPTION 'SHARING_FEE_HISTORY_LIMIT' USING ERRCODE='54000';END IF;
 released=least((recipient->>'releasedMinor')::numeric,(posting_recipient->>'releasedMinor')::numeric);
 result=jsonb_build_object('entitlement',s,'payee',recipient,'postedOn',p_posted::text,'alreadyBilledNetMinor',billed::text,
  'postingDateSourceStamp',posting_source->'sourceStamp','postingDateReleasedNetMinor',posting_recipient->'releasedMinor',
  'claimableReleasedNetMinor',released::text,'availableNetMinor',(released-billed)::text,'recordedBillActivityVersion',counted,'taxTreatmentInferred',false,'moneyMovementPerformed',false);
 RETURN result||jsonb_build_object('sourceStamp',encode(sha256(convert_to(jsonb_build_array(result,activity)::text,'UTF8')),'hex'));
END $$;

-- Writers share the existing policy -> book -> topology -> tuition -> invoice
-- ordering. The separate statement AFTER waiting reads committed new sources.
CREATE FUNCTION public.guard_sharing_fee_bill() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b record;p record;s jsonb;spec jsonb;i record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SHARING_FEE_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO i FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=NEW.invoice_id;
 PERFORM 1 FROM public.tuition_plans WHERE academy_id=NEW.academy_id AND id=i.plan_id FOR UPDATE;
 PERFORM 1 FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=NEW.invoice_id FOR UPDATE;
 SELECT * INTO b FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.bill_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=public.sharing_fee_capacity(NEW.invoice_id,NEW.policy_version,NEW.payee_id,NEW.as_of,b.posted_on,NEW.bill_id);
 spec=jsonb_build_object('invoiceId',NEW.invoice_id,'policyVersion',NEW.policy_version,'asOf',NEW.as_of::text);
 IF b.id IS NULL OR p.id IS NULL OR p.action IS DISTINCT FROM 'finance.expense.record' OR p.status IS DISTINCT FROM 'pending'
  OR p.target_id IS DISTINCT FROM NEW.bill_id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'expenses.edit'
  OR p.payload->'sharing' IS DISTINCT FROM spec OR p.review_context->'sharing' IS DISTINCT FROM s
  OR s IS NULL OR NEW.source_snapshot IS DISTINCT FROM s OR NEW.sharing_plan_id::text IS DISTINCT FROM s#>>'{entitlement,sharingPlanId}'
  OR s#>>'{entitlement,currentPolicyVersion}' IS DISTINCT FROM NEW.policy_version::text OR s#>>'{entitlement,policyActive}' IS DISTINCT FROM 'true'
  OR b.payee_id IS DISTINCT FROM NEW.payee_id OR b.payee_version::text IS DISTINCT FROM s#>>'{payee,payeeVersion}'
  OR b.currency_id::text IS DISTINCT FROM s#>>'{entitlement,currencyId}' OR b.unit_scale::text IS DISTINCT FROM s#>>'{entitlement,unitScale}'
  OR b.net_minor<=0 OR b.net_minor>(s->>'availableNetMinor')::numeric OR b.approval_id IS DISTINCT FROM p.id
  OR p.review_context#>>'{computed,totals,net}' IS DISTINCT FROM b.net_minor::text
  OR p.review_context#>>'{computed,totals,tax}' IS DISTINCT FROM b.tax_minor::text
  OR p.review_context#>>'{computed,totals,gross}' IS DISTINCT FROM b.gross_minor::text
  OR p.review_context#>>'{computed,totals,recoverable}' IS DISTINCT FROM b.recoverable_minor::text
  OR p.payload#>>'{payee,id}' IS DISTINCT FROM b.payee_id::text OR p.payload#>>'{payee,version}' IS DISTINCT FROM b.payee_version::text
  OR p.payload#>>'{currency,id}' IS DISTINCT FROM b.currency_id::text OR p.payload->>'postedOn' IS DISTINCT FROM b.posted_on::text
  OR b.created_by IS DISTINCT FROM NEW.created_by OR NOT public.report_comment_human_verified(NEW.created_by)
  OR EXISTS(SELECT 1 FROM public.expense_bill_lines l WHERE l.academy_id=b.academy_id AND l.bill_id=b.id AND(l.hub_id IS DISTINCT FROM i.hub_id OR l.class_id IS DISTINCT FROM i.class_id OR l.student_id IS DISTINCT FROM i.student_id)) THEN
  RAISE EXCEPTION 'SHARING_FEE_SOURCE_OR_REVIEW_INVALID' USING ERRCODE='23514';
 END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER sharing_fee_bill_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sharing_fee_bills FOR EACH ROW EXECUTE FUNCTION public.guard_sharing_fee_bill();
CREATE CONSTRAINT TRIGGER sharing_fee_reviewed AFTER INSERT ON public.sharing_fee_bills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.complete_sharing_fee_bill() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b record;p record;f record;s jsonb;
BEGIN
 SELECT * INTO b FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=b.academy_id AND id=b.approval_id;
 SELECT * INTO f FROM public.sharing_fee_bills WHERE academy_id=b.academy_id AND bill_id=b.id;
 IF p.payload ? 'sharing' THEN
  IF f.bill_id IS NULL THEN RAISE EXCEPTION 'SHARING_FEE_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;
  s=public.sharing_fee_capacity(f.invoice_id,f.policy_version,f.payee_id,f.as_of,b.posted_on,b.id);
  IF s IS DISTINCT FROM f.source_snapshot OR b.void_id IS NOT NULL THEN RAISE EXCEPTION 'SHARING_FEE_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=b.academy_id AND a.entity_id=b.id AND a.actor_id=b.created_by AND a.action='finance.expense.recorded' AND a.created_at=transaction_timestamp() AND a.changes=jsonb_build_object('approvalId',b.approval_id,'severity','critical','hasReason',true)) THEN RAISE EXCEPTION 'SHARING_FEE_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;
 ELSIF f.bill_id IS NOT NULL THEN RAISE EXCEPTION 'SHARING_FEE_UNREQUESTED_EFFECT' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sharing_fee_bill_complete AFTER INSERT ON public.expense_bills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_sharing_fee_bill();
CREATE FUNCTION public.sharing_fee_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.expense.record' AND NEW.status='applied' AND NEW.payload ? 'sharing'
  AND NOT EXISTS(SELECT 1 FROM public.sharing_fee_bills f WHERE f.academy_id=NEW.academy_id AND f.bill_id=NEW.target_id AND f.approval_id=NEW.id AND f.created_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'SHARING_FEE_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sharing_fee_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.sharing_fee_effect_required();

-- Approval history and decisions must keep the original invoice/student tuple
-- privacy, not just broad expense-hub access. No copied grant snapshots.
CREATE FUNCTION public.sharing_fee_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE invoice uuid;i record;scope jsonb;cap text;
BEGIN
 IF NEW.action='finance.expense.record' AND NEW.payload ? 'sharing' THEN invoice=(NEW.payload#>>'{sharing,invoiceId}')::uuid;
 ELSIF NEW.action='finance.expense.void' THEN SELECT invoice_id INTO invoice FROM public.sharing_fee_bills WHERE academy_id=NEW.academy_id AND bill_id=(NEW.payload->>'billId')::uuid;
 END IF;
 IF invoice IS NULL THEN
  IF NEW.payload ? 'sharing' THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO i FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=invoice;
 IF i.id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',i.class_id,'hubId',i.hub_id)),
  'people',jsonb_build_array(jsonb_build_object('id',i.student_id,'hubId',i.hub_id)),'recordContext',jsonb_build_object('classId',i.class_id,'hubId',i.hub_id,'studentId',i.student_id));
 FOREACH cap IN ARRAY ARRAY['invoices.view','share-rules.view','receipts.view'] LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',scope));END LOOP;
 RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_sharing_fee_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.expense.record','finance.expense.void')) EXECUTE FUNCTION public.sharing_fee_privacy();
REVOKE ALL ON FUNCTION public.sharing_fee_capacity(uuid,integer,uuid,date,date,uuid),public.guard_sharing_fee_bill(),public.complete_sharing_fee_bill(),public.sharing_fee_privacy(),public.sharing_fee_effect_required() FROM PUBLIC;
GRANT SELECT ON public.sharing_fee_bills TO kavosh_runtime;
GRANT INSERT(academy_id,bill_id,invoice_id,sharing_plan_id,policy_version,payee_id,as_of,source_snapshot,approval_id,created_by) ON public.sharing_fee_bills TO kavosh_runtime;
GRANT EXECUTE ON FUNCTION public.sharing_fee_capacity(uuid,integer,uuid,date,date,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 263 $$;

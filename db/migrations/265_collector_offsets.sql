-- Expense settlements share one payable subledger. Collector offsets are
-- explicitly noncash: no invented payment method, bank transfer or paid time.
ALTER TABLE public.expense_payments
 ADD COLUMN settlement_kind text NOT NULL DEFAULT 'cash' CHECK(settlement_kind IN('cash','collector_offset')),
 ADD COLUMN collector_id uuid,ADD COLUMN collector_version integer,
 ADD COLUMN offset_authority text CHECK(offset_authority IN('same_hub','same_person','reviewed_agreement')),
 ADD COLUMN offset_review text NOT NULL DEFAULT '' CHECK(length(offset_review)<=2000),
 ALTER COLUMN method_id DROP NOT NULL,ALTER COLUMN method_version DROP NOT NULL,ALTER COLUMN paid_at DROP NOT NULL;
ALTER TABLE public.expense_payments ADD CONSTRAINT expense_settlement_mode CHECK(
 (settlement_kind='cash' AND method_id IS NOT NULL AND method_version IS NOT NULL AND paid_at IS NOT NULL AND collector_id IS NULL AND collector_version IS NULL AND offset_authority IS NULL AND offset_review='')
 OR(settlement_kind='collector_offset' AND method_id IS NULL AND method_version IS NULL AND paid_at IS NULL AND collector_id IS NOT NULL AND collector_version IS NOT NULL AND offset_authority IS NOT NULL AND length(btrim(offset_review))>0));
ALTER TABLE public.expense_payments ADD FOREIGN KEY(academy_id,collector_id,collector_version) REFERENCES public.finance_collector_revisions(academy_id,collector_id,version);
CREATE INDEX expense_offset_bucket ON public.expense_payments(academy_id,collector_id,funding_account,posted_on,id) WHERE settlement_kind='collector_offset';
CREATE UNIQUE INDEX expense_offset_reference ON public.expense_payments(academy_id,collector_id,funding_account,reference) WHERE settlement_kind='collector_offset' AND reference<>'' AND reversal_id IS NULL;
GRANT INSERT(settlement_kind,collector_id,collector_version,offset_authority,offset_review) ON public.expense_payments TO kavosh_runtime;

-- One monetary snapshot for total and noncash parts. Do not combine an outer
-- query's old snapshot with a VOLATILE balance call's newer committed payment.
CREATE FUNCTION public.expense_bill_settlement_snapshot(p_bill uuid,p_through date)
RETURNS TABLE(gross numeric,voided numeric,paid numeric,balance numeric,activity bigint,offset_settled numeric)
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 WITH snapshot AS(
  SELECT CASE WHEN p_through IS NULL OR b.posted_on<=p_through THEN b.gross_minor ELSE 0 END gross,
   CASE WHEN b.void_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.finance_journals j WHERE j.academy_id=b.academy_id AND j.id=b.void_id AND(p_through IS NULL OR j.posted_on<=p_through)) THEN b.gross_minor ELSE 0 END voided,
   e.paid,e.activity,e.offset_settled
  FROM public.expense_bills b CROSS JOIN LATERAL(
   SELECT coalesce(sum(v.delta_minor) FILTER(WHERE p_through IS NULL OR v.posted_on<=p_through),0) paid,count(*) activity,
    coalesce(sum(v.delta_minor) FILTER(WHERE p.settlement_kind='collector_offset' AND(p_through IS NULL OR v.posted_on<=p_through)),0) offset_settled
   FROM public.expense_payment_events v JOIN public.expense_payments p ON p.academy_id=v.academy_id AND p.id=v.payment_id
   WHERE v.academy_id=b.academy_id AND v.bill_id=b.id
  ) e WHERE b.id=p_bill
 ) SELECT gross,voided,paid,gross-voided-paid,activity,offset_settled FROM snapshot
$$;
REVOKE ALL ON FUNCTION public.expense_bill_settlement_snapshot(uuid,date) FROM PUBLIC;
-- Preserve the exact pre-existing invoker execution audience, not a new
-- privileged reader or a broad default grant.
DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT DISTINCT roles.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a JOIN pg_roles roles ON roles.oid=a.grantee WHERE p.oid='public.expense_bill_balance(uuid,date)'::regprocedure AND a.privilege_type='EXECUTE' LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.expense_bill_settlement_snapshot(uuid,date) TO %I',r.rolname);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.expense_bill_balance(p_bill uuid,p_through date) RETURNS TABLE(gross numeric,voided numeric,paid numeric,balance numeric,activity bigint)
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT s.gross,s.voided,s.paid,s.balance,s.activity FROM public.expense_bill_settlement_snapshot(p_bill,p_through) s $$;

CREATE FUNCTION public.collector_offset_identity(p_collector uuid,p_payee uuid,p_authority text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT c.custody='third_party' AND p.kind<>'academy' AND(
  (p_authority='same_hub' AND c.kind='hub' AND p.kind='hub' AND c.hub_id IS NOT NULL AND c.hub_id=p.hub_id)
  OR(p_authority='same_person' AND c.kind='person' AND p.kind='person' AND c.person_id IS NOT NULL AND c.person_id=p.person_id)
  OR p_authority='reviewed_agreement')
 FROM public.finance_collectors c JOIN public.financial_payees p ON p.academy_id=c.academy_id
 WHERE c.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND c.id=p_collector AND p.id=p_payee),false)
$$;
CREATE FUNCTION public.collector_offset_source(p_collector uuid,p_holding uuid,p_on date) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
 SELECT jsonb_build_object('collectorId',c.id,'collectorVersion',c.version,'collectorHubId',c.hub_id,'collectorPersonId',c.person_id,
  'collectorKind',c.kind,'custody',c.custody,'holdingAccountId',p_holding,'on',p_on::text,
  'currentMinor',v.current_minor::text,'throughMinor',v.through_minor::text,'availableMinor',v.available_minor::text,'activity',v.activity::text,'sourceStamp',v.source_stamp)
 FROM public.finance_collectors c CROSS JOIN LATERAL public.collector_fund_capacity(c.id,p_holding,p_on,'to_academy') v
 WHERE c.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND c.id=p_collector
$$;
-- Add the same real settlement to collector custody. Expense payment events
-- already include it, so AP/status/aging/forecast/reminder consumers remain on
-- their original single subledger and funding-scope boundary.
-- Outflow headers reserve funds immediately within the writing transaction.
-- Their deferred journal/posting constraints still forbid any committed
-- incomplete entry. Waiting for the journal header would let a direct multirow
-- insertion spend the same bucket twice before either journal was inserted.
CREATE OR REPLACE VIEW public.collector_fund_events WITH(security_invoker=true) AS
 SELECT r.academy_id,r.collector_id,r.holding_account,j.id AS journal_id,j.posted_on,r.amount_minor AS delta_minor FROM public.tuition_receipts r JOIN public.finance_collectors c ON c.academy_id=r.academy_id AND c.id=r.collector_id AND c.custody='third_party' JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=r.academy_id AND h.id=r.id OFFSET 0) j ON true
 UNION ALL SELECT r.academy_id,r.collector_id,r.holding_account,j.id,j.posted_on,-r.amount_minor FROM public.tuition_receipt_reversals v JOIN public.tuition_receipts r ON r.academy_id=v.academy_id AND r.id=v.receipt_id JOIN public.finance_collectors c ON c.academy_id=r.academy_id AND c.id=r.collector_id AND c.custody='third_party' JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=v.academy_id AND h.id=v.id OFFSET 0) j ON true
 UNION ALL SELECT r.academy_id,r.collector_id,r.holding_account,r.id,r.posted_on,CASE WHEN r.direction='to_academy' THEN -r.amount_minor ELSE r.amount_minor END FROM public.collector_remittances r
 UNION ALL SELECT r.academy_id,r.collector_id,r.holding_account,j.id,j.posted_on,CASE WHEN r.direction='to_academy' THEN r.amount_minor ELSE -r.amount_minor END FROM public.collector_remittance_reversals v JOIN public.collector_remittances r ON r.academy_id=v.academy_id AND r.id=v.remittance_id JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=v.academy_id AND h.id=v.id OFFSET 0) j ON true
 UNION ALL SELECT p.academy_id,p.collector_id,p.funding_account,p.id,p.posted_on,-p.amount_minor FROM public.expense_payments p WHERE p.settlement_kind='collector_offset'
 UNION ALL SELECT p.academy_id,p.collector_id,p.funding_account,j.id,j.posted_on,p.amount_minor FROM public.expense_payment_reversals r JOIN public.expense_payments p ON p.academy_id=r.academy_id AND p.id=r.payment_id JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=r.academy_id AND h.id=r.id OFFSET 0) j ON true WHERE p.settlement_kind='collector_offset';

CREATE FUNCTION public.guard_expense_collector_offset() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b record;p record;s jsonb;
BEGIN
 IF NEW.settlement_kind<>'collector_offset' THEN RETURN NEW;END IF;
 -- Always before the existing bill lock, including reversal-link updates.
 PERFORM public.lock_collector_funds(NEW.collector_id,NEW.funding_account);
 PERFORM 1 FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.bill_id FOR UPDATE;
 IF TG_OP='UPDATE' THEN RETURN NEW;END IF;
 SELECT * INTO b FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.bill_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=public.collector_offset_source(NEW.collector_id,NEW.funding_account,NEW.posted_on);
 IF s IS NULL OR s->>'custody' IS DISTINCT FROM 'third_party' OR s->>'collectorVersion' IS DISTINCT FROM NEW.collector_version::text
  OR public.collector_offset_identity(NEW.collector_id,b.payee_id,NEW.offset_authority) IS NOT TRUE
  OR NEW.amount_minor>(s->>'availableMinor')::numeric
  OR EXISTS(SELECT 1 FROM public.finance_accounts f WHERE f.academy_id=NEW.academy_id AND f.id=NEW.funding_account AND f.hub_id IS NOT NULL AND f.hub_id::text IS DISTINCT FROM s->>'collectorHubId')
  OR p.id IS NULL OR p.action IS DISTINCT FROM 'finance.expense-payment.record' OR p.status IS DISTINCT FROM 'pending'
  OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'expense-payments.edit'
  OR p.payload->>'settlementKind' IS DISTINCT FROM 'collector_offset' OR p.payload#>>'{collector,id}' IS DISTINCT FROM NEW.collector_id::text
  OR p.payload#>>'{collector,version}' IS DISTINCT FROM NEW.collector_version::text OR p.payload->>'offsetAuthority' IS DISTINCT FROM NEW.offset_authority
  OR p.payload->>'offsetReview' IS DISTINCT FROM NEW.offset_review OR p.review_context->'offset' IS DISTINCT FROM s
  OR p.payload->>'billId' IS DISTINCT FROM NEW.bill_id::text OR p.payload#>>'{fundingAccount,id}' IS DISTINCT FROM NEW.funding_account::text
  OR p.review_context->>'amount' IS DISTINCT FROM NEW.amount_minor::text OR p.payload->>'postedOn' IS DISTINCT FROM NEW.posted_on::text
  OR(NOT EXISTS(SELECT 1 FROM public.academies a WHERE a.id=NEW.academy_id AND a.master_person_id=NEW.created_by)
   AND(NEW.created_by::text=s->>'collectorPersonId' OR EXISTS(SELECT 1 FROM public.financial_payees payee WHERE payee.academy_id=NEW.academy_id AND payee.id=b.payee_id AND payee.person_id=NEW.created_by)))
  OR NOT public.report_comment_human_verified(NEW.created_by) THEN RAISE EXCEPTION 'COLLECTOR_OFFSET_SOURCE_OR_REVIEW_INVALID' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aa_expense_collector_offset BEFORE INSERT OR UPDATE ON public.expense_payments FOR EACH ROW EXECUTE FUNCTION public.guard_expense_collector_offset();
-- Keep old cash validation intact; only explicitly typed offsets can fund AP
-- from a collector receivable without a cash method/time.
DO $$ DECLARE body text;role_check text:='f.operational_role NOT IN(''cash'',''bank'',''credit_card'')';
 method_check text:='m.version IS DISTINCT FROM NEW.method_version OR NOT m.active OR(m.hub_id IS NOT NULL AND m.hub_id IS DISTINCT FROM f.hub_id AND EXISTS(SELECT 1 FROM public.expense_bill_lines l WHERE l.academy_id=b.academy_id AND l.bill_id=b.id AND l.hub_id IS DISTINCT FROM m.hub_id))';
BEGIN
 body=pg_get_functiondef('public.guard_expense_payment()'::regprocedure);
 IF(length(body)-length(replace(body,role_check,'')))/length(role_check)<>1 OR(length(body)-length(replace(body,method_check,'')))/length(method_check)<>1 THEN RAISE EXCEPTION 'COLLECTOR_OFFSET_PAYMENT_GUARD_BASE_CHANGED';END IF;
 body=replace(body,role_check,'((NEW.settlement_kind=''cash'' AND f.operational_role NOT IN(''cash'',''bank'',''credit_card'')) OR(NEW.settlement_kind=''collector_offset'' AND f.operational_role<>''collector_receivable''))');
 EXECUTE replace(body,method_check,'(NEW.settlement_kind=''cash'' AND('||method_check||'))');
END $$;
CREATE FUNCTION public.lock_expense_offset_reversal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;BEGIN
 SELECT * INTO p FROM public.expense_payments WHERE academy_id=NEW.academy_id AND id=coalesce((to_jsonb(NEW)->>'reverses_id')::uuid,(to_jsonb(NEW)->>'payment_id')::uuid);
 IF p.settlement_kind='collector_offset' THEN PERFORM public.lock_collector_funds(p.collector_id,p.funding_account);PERFORM 1 FROM public.expense_bills WHERE academy_id=p.academy_id AND id=p.bill_id FOR UPDATE;END IF;RETURN NEW;
END $$;
CREATE TRIGGER aa_offset_reversal_record BEFORE INSERT ON public.expense_payment_reversals FOR EACH ROW EXECUTE FUNCTION public.lock_expense_offset_reversal();
CREATE TRIGGER aa_offset_reversal_journal BEFORE INSERT ON public.finance_journals FOR EACH ROW WHEN(NEW.reverses_id IS NOT NULL) EXECUTE FUNCTION public.lock_expense_offset_reversal();
CREATE CONSTRAINT TRIGGER collector_offset_reviewed AFTER INSERT ON public.expense_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.settlement_kind='collector_offset') EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.complete_expense_collector_offset() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.id AND a.actor_id=NEW.created_by AND a.action='finance.expense-payment.recorded' AND a.created_at=transaction_timestamp() AND a.changes=jsonb_build_object('approvalId',NEW.approval_id,'severity','critical','hasReason',true,'settlementKind','collector_offset')) THEN RAISE EXCEPTION 'COLLECTOR_OFFSET_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER collector_offset_complete AFTER INSERT ON public.expense_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.settlement_kind='collector_offset') EXECUTE FUNCTION public.complete_expense_collector_offset();
CREATE FUNCTION public.collector_offset_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.expense-payment.record' AND NEW.status='applied' AND NEW.payload->>'settlementKind'='collector_offset'
  AND NOT EXISTS(SELECT 1 FROM public.expense_payments p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.target_id AND p.approval_id=NEW.id AND p.settlement_kind='collector_offset' AND p.created_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'COLLECTOR_OFFSET_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER collector_offset_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.collector_offset_effect_required();
CREATE FUNCTION public.collector_offset_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE bound_collector uuid;c record;BEGIN
 IF NEW.action='finance.expense-payment.record' AND NEW.payload->>'settlementKind'='collector_offset' THEN bound_collector=(NEW.payload#>>'{collector,id}')::uuid;
 ELSIF NEW.action='finance.expense-payment.reverse' THEN SELECT p.collector_id INTO bound_collector FROM public.expense_payments p WHERE p.academy_id=NEW.academy_id AND p.id=(NEW.payload->>'paymentId')::uuid AND p.settlement_kind='collector_offset';END IF;
 IF bound_collector IS NULL THEN
  IF NEW.action='finance.expense-payment.record' AND NEW.payload->>'settlementKind'='collector_offset' THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO c FROM public.finance_collectors WHERE academy_id=NEW.academy_id AND finance_collectors.id=bound_collector;
 IF c.id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('remittances.view',ARRAY[c.hub_id]),CASE WHEN c.hub_id IS NULL THEN jsonb_build_object('capability','collectors.view','any',true) ELSE public.approval_hub_binding('collectors.view',ARRAY[c.hub_id]) END);RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_collector_offset_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.expense-payment.record','finance.expense-payment.reverse')) EXECUTE FUNCTION public.collector_offset_privacy();
REVOKE ALL ON FUNCTION public.collector_offset_identity(uuid,uuid,text),public.collector_offset_source(uuid,uuid,date),public.guard_expense_collector_offset(),public.lock_expense_offset_reversal(),public.complete_expense_collector_offset(),public.collector_offset_effect_required(),public.collector_offset_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collector_offset_identity(uuid,uuid,text),public.collector_offset_source(uuid,uuid,date) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 265 $$;

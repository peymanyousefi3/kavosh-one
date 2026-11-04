INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('expense-payments.view','View permitted expense payments and dated bill balances','Finance',true,ARRAY['hub','country','region','city']),
 ('expense-payments.edit','Request reviewed supplier payments and reimbursements','Finance',true,ARRAY['hub','country','region','city']);
ALTER TABLE public.finance_account_revisions DROP CONSTRAINT finance_account_revisions_operational_role_check;
ALTER TABLE public.finance_account_revisions DROP CONSTRAINT finance_account_operational_role;
ALTER TABLE public.finance_account_revisions ADD CONSTRAINT finance_account_revisions_operational_role_check CHECK(operational_role IN('unclassified','cash','bank','credit_card','receivable','collector_receivable','deferred_revenue','tax_payable','tax_receivable','payable','revenue','expense','other'));
ALTER TABLE public.finance_account_revisions ADD CONSTRAINT finance_account_operational_role CHECK(
 operational_role IN('unclassified','other') OR(operational_role IN('cash','bank','receivable','collector_receivable','tax_receivable') AND kind='asset' AND normal_balance='debit')
 OR(operational_role IN('deferred_revenue','tax_payable','payable','credit_card') AND kind='liability' AND normal_balance='credit') OR(operational_role='revenue' AND kind='income' AND normal_balance='credit') OR(operational_role='expense' AND kind='expense'));
CREATE OR REPLACE FUNCTION public.guard_finance_transfer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;b record;m record;BEGIN
 IF TG_OP='UPDATE' THEN IF OLD.reversal_id IS NOT NULL OR NEW.reversal_id IS NULL THEN RAISE EXCEPTION 'TRANSFER_REVERSAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT * INTO a FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.from_account;
 SELECT * INTO b FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.to_account;
 SELECT p.hub_id,r.active,p.version INTO m FROM public.finance_payment_methods p JOIN public.finance_payment_method_revisions r ON r.academy_id=p.academy_id AND r.method_id=p.id AND r.version=p.version WHERE p.academy_id=NEW.academy_id AND p.id=NEW.method_id;
 IF a.version IS DISTINCT FROM NEW.from_version OR b.version IS DISTINCT FROM NEW.to_version OR NOT a.active OR NOT b.active OR a.operational_role NOT IN ('cash','bank','credit_card') OR b.operational_role NOT IN ('cash','bank','credit_card') OR a.currency_id IS DISTINCT FROM NEW.currency_id OR b.currency_id IS DISTINCT FROM NEW.currency_id OR a.unit_scale IS DISTINCT FROM NEW.unit_scale OR b.unit_scale IS DISTINCT FROM NEW.unit_scale OR m.version IS DISTINCT FROM NEW.method_version OR NOT m.active OR(m.hub_id IS NOT NULL AND m.hub_id IS DISTINCT FROM a.hub_id AND m.hub_id IS DISTINCT FROM b.hub_id) THEN RAISE EXCEPTION 'TRANSFER_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.handled_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.handled_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'TRANSFER_HANDLER_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.evidence_file IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.file_records f WHERE f.academy_id=NEW.academy_id AND f.id=NEW.evidence_file AND f.version=NEW.evidence_version AND NOT f.archived AND f.domain='finance_private' AND(f.anchor_kind='academy' OR(f.anchor_kind='hub' AND f.hub_id IN(a.hub_id,b.hub_id)))) THEN RAISE EXCEPTION 'TRANSFER_EVIDENCE_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.id AND p.target_version=0 AND p.action='finance.transfer.record' AND p.privacy_capability='transfers.edit' AND p.status IN('pending','applied')) THEN RAISE EXCEPTION 'TRANSFER_APPROVAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TABLE public.expense_payments(
 academy_id uuid NOT NULL,id uuid NOT NULL,bill_id uuid NOT NULL,funding_account uuid NOT NULL,funding_version integer NOT NULL,payable_account uuid NOT NULL,payable_version integer NOT NULL,
 amount_minor numeric NOT NULL CHECK(amount_minor=trunc(amount_minor) AND amount_minor>0 AND amount_minor<1e38),method_id uuid NOT NULL,method_version integer NOT NULL,
 period_id uuid NOT NULL,period_version integer NOT NULL,posted_on date NOT NULL CHECK(posted_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),paid_at timestamptz NOT NULL,
 handled_by uuid,reference text NOT NULL CHECK(length(reference)<=200),evidence_file uuid,evidence_version integer,missing_evidence_reason text NOT NULL CHECK(length(missing_evidence_reason)<=2000),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),approval_id uuid NOT NULL,reversal_id uuid,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),CHECK(funding_account<>payable_account),CHECK((evidence_file IS NULL)=(evidence_version IS NULL)),CHECK(evidence_file IS NOT NULL OR length(missing_evidence_reason)>0),
 FOREIGN KEY(academy_id,bill_id) REFERENCES public.expense_bills(academy_id,id),FOREIGN KEY(academy_id,funding_account,funding_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,payable_account,payable_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,method_id,method_version) REFERENCES public.finance_payment_method_revisions(academy_id,method_id,version),FOREIGN KEY(academy_id,period_id,period_version) REFERENCES public.finance_period_revisions(academy_id,period_id,version),FOREIGN KEY(academy_id,handled_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,evidence_file,evidence_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX expense_payment_bill ON public.expense_payments(academy_id,bill_id,posted_on,id);
CREATE UNIQUE INDEX expense_payment_reference ON public.expense_payments(academy_id,funding_account,method_id,reference) WHERE reference<>'' AND reversal_id IS NULL;
CREATE TABLE public.expense_payment_reversals(
 academy_id uuid NOT NULL,id uuid NOT NULL,payment_id uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,payment_id),UNIQUE(academy_id,id,payment_id),
 FOREIGN KEY(academy_id,payment_id) REFERENCES public.expense_payments(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.expense_payments ADD CONSTRAINT expense_payment_reversal_identity FOREIGN KEY(academy_id,reversal_id,id) REFERENCES public.expense_payment_reversals(academy_id,id,payment_id) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['expense_payments','expense_payment_reversals'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
END LOOP;END $$;
CREATE VIEW public.expense_payment_events WITH(security_invoker=true) AS
 SELECT p.academy_id,p.bill_id,p.id AS payment_id,p.id AS journal_id,p.posted_on,p.amount_minor AS delta_minor FROM public.expense_payments p
 UNION ALL SELECT p.academy_id,p.bill_id,p.id,v.id,j.posted_on,-p.amount_minor FROM public.expense_payment_reversals v JOIN public.expense_payments p ON p.academy_id=v.academy_id AND p.id=v.payment_id JOIN LATERAL(SELECT h.posted_on FROM public.finance_journals h WHERE h.academy_id=v.academy_id AND h.id=v.id OFFSET 0) j ON true;
-- VOLATILE is intentional: payment guards must see a previous row in the same
-- INSERT and a payment committed while this statement waited on the bill lock.
CREATE FUNCTION public.expense_bill_balance(p_bill uuid,p_through date) RETURNS TABLE(gross numeric,voided numeric,paid numeric,balance numeric,activity bigint) LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 WITH snapshot AS(SELECT b.academy_id,b.id,CASE WHEN p_through IS NULL OR b.posted_on<=p_through THEN b.gross_minor ELSE 0 END AS gross,
 CASE WHEN b.void_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.finance_journals j WHERE j.academy_id=b.academy_id AND j.id=b.void_id AND(p_through IS NULL OR j.posted_on<=p_through)) THEN b.gross_minor ELSE 0 END AS voided,
 coalesce((SELECT sum(e.delta_minor) FROM public.expense_payment_events e WHERE e.academy_id=b.academy_id AND e.bill_id=b.id AND(p_through IS NULL OR e.posted_on<=p_through)),0) AS paid,(SELECT count(*) FROM public.expense_payment_events e WHERE e.academy_id=b.academy_id AND e.bill_id=b.id) AS activity FROM public.expense_bills b WHERE b.id=p_bill)
 SELECT gross,voided,paid,gross-voided-paid,activity FROM snapshot
$$;
CREATE FUNCTION public.expense_payment_capacity(p_bill uuid,p_on date) RETURNS numeric LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 WITH daily AS(SELECT e.posted_on,sum(e.delta_minor) AS delta FROM public.expense_payment_events e WHERE e.bill_id=p_bill GROUP BY e.posted_on),running AS(SELECT posted_on,sum(delta) OVER(ORDER BY posted_on ROWS UNBOUNDED PRECEDING) AS paid FROM daily)
 SELECT b.gross_minor-greatest(0,coalesce((SELECT max(paid) FROM running WHERE posted_on>=p_on),0),coalesce((SELECT sum(delta) FROM daily WHERE posted_on<=p_on),0),coalesce((SELECT sum(delta) FROM daily),0)) FROM public.expense_bills b WHERE b.id=p_bill
$$;
CREATE FUNCTION public.guard_expense_payment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b record;a record;f record;m record;capacity numeric;BEGIN
 SELECT * INTO b FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.bill_id FOR UPDATE;
 IF TG_OP='UPDATE' THEN IF OLD.reversal_id IS NOT NULL OR NEW.reversal_id IS NULL THEN RAISE EXCEPTION 'EXPENSE_PAYMENT_REVERSAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT * INTO a FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.payable_account;
 SELECT * INTO f FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.funding_account;
 SELECT h.version,h.hub_id,r.active INTO m FROM public.finance_payment_methods h JOIN public.finance_payment_method_revisions r ON r.academy_id=h.academy_id AND r.method_id=h.id AND r.version=h.version WHERE h.academy_id=NEW.academy_id AND h.id=NEW.method_id;
 SELECT public.expense_payment_capacity(NEW.bill_id,NEW.posted_on) INTO capacity;
 IF b.id IS NULL OR b.void_id IS NOT NULL OR NEW.posted_on<b.posted_on OR NEW.amount_minor>capacity THEN RAISE EXCEPTION 'EXPENSE_PAYMENT_EXCEEDS_CURRENT_OR_DATED_BALANCE' USING ERRCODE='23514';END IF;
IF NEW.payable_account IS DISTINCT FROM b.payable_account OR a.version IS DISTINCT FROM NEW.payable_version OR f.version IS DISTINCT FROM NEW.funding_version OR NOT a.active OR NOT f.active OR a.operational_role<>'payable' OR f.operational_role NOT IN('cash','bank','credit_card') OR a.currency_id IS DISTINCT FROM b.currency_id OR f.currency_id IS DISTINCT FROM b.currency_id OR a.unit_scale IS DISTINCT FROM b.unit_scale OR f.unit_scale IS DISTINCT FROM b.unit_scale OR m.version IS DISTINCT FROM NEW.method_version OR NOT m.active OR(m.hub_id IS NOT NULL AND m.hub_id IS DISTINCT FROM f.hub_id AND EXISTS(SELECT 1 FROM public.expense_bill_lines l WHERE l.academy_id=b.academy_id AND l.bill_id=b.id AND l.hub_id IS DISTINCT FROM m.hub_id)) THEN RAISE EXCEPTION 'EXPENSE_PAYMENT_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.handled_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.handled_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'EXPENSE_PAYMENT_HANDLER_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.evidence_file IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.file_records r WHERE r.academy_id=NEW.academy_id AND r.id=NEW.evidence_file AND r.version=NEW.evidence_version AND r.domain='finance_private' AND NOT r.archived AND(r.anchor_kind='academy' OR(r.anchor_kind='hub' AND(r.hub_id=f.hub_id OR EXISTS(SELECT 1 FROM public.expense_bill_lines l WHERE l.academy_id=b.academy_id AND l.bill_id=b.id AND l.hub_id=r.hub_id))))) THEN RAISE EXCEPTION 'EXPENSE_PAYMENT_EVIDENCE_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.id AND p.target_version=0 AND p.action='finance.expense-payment.record' AND p.privacy_capability='expense-payments.edit' AND p.status IN('pending','applied')) THEN RAISE EXCEPTION 'EXPENSE_PAYMENT_APPROVAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER expense_payment BEFORE INSERT OR UPDATE ON public.expense_payments FOR EACH ROW EXECUTE FUNCTION public.guard_expense_payment();
CREATE FUNCTION public.guard_expense_payment_reversal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.expense_payments p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=NEW.academy_id AND a.id=NEW.approval_id AND a.target_id=NEW.id AND a.action='finance.expense-payment.reverse' AND a.payload->>'paymentId'=NEW.reverses_id::text) THEN RAISE EXCEPTION 'EXPENSE_PAYMENT_CORRECTION_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER expense_payment_journal_reversal BEFORE INSERT ON public.finance_journals FOR EACH ROW WHEN(NEW.reverses_id IS NOT NULL) EXECUTE FUNCTION public.guard_expense_payment_reversal();
CREATE FUNCTION public.check_expense_payment_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE j record;p record;v record;BEGIN
 IF TG_TABLE_NAME='expense_payments' THEN
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF j.approval_id IS DISTINCT FROM NEW.approval_id OR j.period_id IS DISTINCT FROM NEW.period_id OR j.period_version IS DISTINCT FROM NEW.period_version OR j.posted_on IS DISTINCT FROM NEW.posted_on OR j.purpose IS DISTINCT FROM 'activity' OR j.reverses_id IS NOT NULL OR j.line_count<>2
 OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines l WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.id AND l.line_number=1 AND l.account_id=NEW.payable_account AND l.account_version=NEW.payable_version AND l.side='debit' AND l.amount_minor=NEW.amount_minor)
 OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines l WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.id AND l.line_number=2 AND l.account_id=NEW.funding_account AND l.account_version=NEW.funding_version AND l.side='credit' AND l.amount_minor=NEW.amount_minor) THEN RAISE EXCEPTION 'EXPENSE_PAYMENT_POSTING_INVALID' USING ERRCODE='23514';END IF;RETURN NULL;END IF;
 IF TG_TABLE_NAME='finance_journals' THEN IF NOT EXISTS(SELECT 1 FROM public.expense_payments WHERE academy_id=NEW.academy_id AND id=NEW.reverses_id) THEN RETURN NULL;END IF;SELECT * INTO v FROM public.expense_payment_reversals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 ELSE v=NEW;END IF;
 SELECT * INTO p FROM public.expense_payments WHERE academy_id=NEW.academy_id AND id=v.payment_id;SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF v.id IS NULL OR p.reversal_id IS DISTINCT FROM NEW.id OR j.reverses_id IS DISTINCT FROM p.id OR j.approval_id IS DISTINCT FROM v.approval_id OR j.posted_on<p.posted_on OR NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=NEW.academy_id AND a.id=v.approval_id AND a.target_id=NEW.id AND a.target_version=0 AND a.action='finance.expense-payment.reverse' AND a.privacy_capability='expense-payments.edit' AND a.status IN('pending','applied') AND a.payload->>'paymentId'=p.id::text) THEN RAISE EXCEPTION 'EXPENSE_PAYMENT_CORRECTION_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_payment_complete AFTER INSERT ON public.expense_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_expense_payment_complete();
CREATE CONSTRAINT TRIGGER expense_payment_reversal_complete AFTER INSERT ON public.expense_payment_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_expense_payment_complete();
CREATE CONSTRAINT TRIGGER expense_payment_journal_complete AFTER INSERT ON public.finance_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.reverses_id IS NOT NULL) EXECUTE FUNCTION public.check_expense_payment_complete();
REVOKE ALL ON FUNCTION public.expense_bill_balance(uuid,date),public.expense_payment_capacity(uuid,date),public.guard_expense_payment(),public.guard_expense_payment_reversal(),public.check_expense_payment_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_bill_balance(uuid,date),public.expense_payment_capacity(uuid,date) TO kavosh_runtime;
GRANT SELECT ON public.expense_payments,public.expense_payment_reversals,public.expense_payment_events TO kavosh_runtime;
GRANT INSERT(academy_id,id,bill_id,funding_account,funding_version,payable_account,payable_version,amount_minor,method_id,method_version,period_id,period_version,posted_on,paid_at,handled_by,reference,evidence_file,evidence_version,missing_evidence_reason,reason,approval_id,created_by) ON public.expense_payments TO kavosh_runtime;
GRANT INSERT(academy_id,id,payment_id,approval_id,reason) ON public.expense_payment_reversals TO kavosh_runtime;
GRANT UPDATE(reversal_id) ON public.expense_payments TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 51 $$;

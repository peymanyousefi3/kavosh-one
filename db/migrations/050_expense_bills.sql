INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('expenses.view','View permitted supplier and reimbursement expense bills','Finance',true,ARRAY['hub','country','region','city']),
 ('expenses.edit','Request reviewed expense bills and corrections','Finance',true,ARRAY['hub','country','region','city']);
ALTER TABLE public.finance_account_revisions DROP CONSTRAINT finance_account_revisions_operational_role_check;
ALTER TABLE public.finance_account_revisions DROP CONSTRAINT finance_account_operational_role;
ALTER TABLE public.finance_account_revisions ADD CONSTRAINT finance_account_revisions_operational_role_check CHECK(operational_role IN('unclassified','cash','bank','receivable','collector_receivable','deferred_revenue','tax_payable','tax_receivable','payable','revenue','expense','other'));
ALTER TABLE public.finance_account_revisions ADD CONSTRAINT finance_account_operational_role CHECK(
 operational_role IN('unclassified','other') OR(operational_role IN('cash','bank','receivable','collector_receivable','tax_receivable') AND kind='asset' AND normal_balance='debit')
 OR(operational_role IN('deferred_revenue','tax_payable','payable') AND kind='liability' AND normal_balance='credit') OR(operational_role='revenue' AND kind='income' AND normal_balance='credit') OR(operational_role='expense' AND kind='expense'));
CREATE TABLE public.expense_bills(
 academy_id uuid NOT NULL,id uuid NOT NULL,payee_id uuid NOT NULL,payee_version integer NOT NULL,payable_account uuid NOT NULL,payable_version integer NOT NULL,currency_id uuid NOT NULL,currency_version integer NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),
 document_number text NOT NULL CHECK(length(document_number) BETWEEN 1 AND 200),issued_on date NOT NULL,due_on date NOT NULL,posted_on date NOT NULL,period_id uuid NOT NULL,period_version integer NOT NULL,
 line_count integer NOT NULL CHECK(line_count BETWEEN 1 AND 50),net_minor numeric NOT NULL,tax_minor numeric NOT NULL,gross_minor numeric NOT NULL,recoverable_minor numeric NOT NULL,
 evidence_file uuid,evidence_version integer,missing_evidence_reason text NOT NULL CHECK(length(missing_evidence_reason)<=2000),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 approval_id uuid NOT NULL,void_id uuid,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(academy_id,id),
CHECK(issued_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),CHECK(due_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),CHECK(posted_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 CHECK(net_minor=trunc(net_minor) AND net_minor>=0 AND tax_minor=trunc(tax_minor) AND tax_minor>=0 AND gross_minor=net_minor+tax_minor AND gross_minor>0 AND gross_minor<1e38 AND recoverable_minor=trunc(recoverable_minor) AND recoverable_minor BETWEEN 0 AND tax_minor),
 CHECK((evidence_file IS NULL)=(evidence_version IS NULL)),CHECK(evidence_file IS NOT NULL OR length(missing_evidence_reason)>0),
 FOREIGN KEY(academy_id,payee_id,payee_version) REFERENCES public.financial_payee_revisions(academy_id,payee_id,version),FOREIGN KEY(academy_id,payable_account,payable_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),
 FOREIGN KEY(academy_id,currency_id,currency_version) REFERENCES public.finance_currency_revisions(academy_id,currency_id,version),
 FOREIGN KEY(academy_id,period_id,period_version) REFERENCES public.finance_period_revisions(academy_id,period_id,version),FOREIGN KEY(academy_id,evidence_file,evidence_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX expense_bill_number ON public.expense_bills(academy_id,payee_id,document_number) WHERE void_id IS NULL;
CREATE INDEX expense_bill_due ON public.expense_bills(academy_id,due_on,id);
CREATE TABLE public.expense_bill_lines(
 academy_id uuid NOT NULL,bill_id uuid NOT NULL,line_number integer NOT NULL CHECK(line_number BETWEEN 1 AND 50),description text NOT NULL CHECK(length(description) BETWEEN 1 AND 500),hub_id uuid,class_id uuid,student_id uuid,
expense_account uuid NOT NULL,expense_version integer NOT NULL,tax_account uuid,tax_version integer,tax_code_id uuid NOT NULL,tax_code_version integer NOT NULL,tax_on date NOT NULL CHECK(tax_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 input_minor numeric NOT NULL CHECK(input_minor=trunc(input_minor) AND input_minor>0 AND input_minor<1e38),pricing text NOT NULL CHECK(pricing IN('tax_exclusive','tax_inclusive','not_applicable')),
 recoverable_rate integer NOT NULL CHECK(recoverable_rate BETWEEN 0 AND 1000000),tax_review text NOT NULL CHECK(length(tax_review) BETWEEN 1 AND 2000),
 net_minor numeric NOT NULL,tax_minor numeric NOT NULL,gross_minor numeric NOT NULL,recoverable_minor numeric NOT NULL,
 PRIMARY KEY(academy_id,bill_id,line_number),CHECK(hub_id IS NOT NULL OR(class_id IS NULL AND student_id IS NULL)),CHECK((tax_account IS NULL)=(tax_version IS NULL)),CHECK(recoverable_minor=0 OR tax_account IS NOT NULL),
 FOREIGN KEY(academy_id,bill_id) REFERENCES public.expense_bills(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,class_id,hub_id) REFERENCES public.classes(academy_id,id,hub_id),FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),
 FOREIGN KEY(academy_id,expense_account,expense_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,tax_account,tax_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,tax_code_id,tax_code_version) REFERENCES public.finance_tax_code_revisions(academy_id,tax_code_id,version)
);
CREATE INDEX expense_bill_cost_hub ON public.expense_bill_lines(academy_id,hub_id,bill_id);
CREATE INDEX expense_bill_cost_class ON public.expense_bill_lines(academy_id,class_id,bill_id) WHERE class_id IS NOT NULL;
CREATE INDEX expense_bill_cost_student ON public.expense_bill_lines(academy_id,student_id,bill_id) WHERE student_id IS NOT NULL;
CREATE TABLE public.expense_bill_voids(
 academy_id uuid NOT NULL,id uuid NOT NULL,bill_id uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,bill_id),UNIQUE(academy_id,id,bill_id),
 FOREIGN KEY(academy_id,bill_id) REFERENCES public.expense_bills(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.expense_bills ADD CONSTRAINT expense_void_identity FOREIGN KEY(academy_id,void_id,id) REFERENCES public.expense_bill_voids(academy_id,id,bill_id) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['expense_bills','expense_bill_lines','expense_bill_voids'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
END LOOP;END $$;
CREATE FUNCTION public.guard_expense_bill_line() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b record;t record;a record;rate numeric;tax numeric;net numeric;gross numeric;recoverable numeric;BEGIN
 SELECT * INTO b FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.bill_id;
 SELECT h.version,r.* INTO t FROM public.finance_tax_codes h JOIN public.finance_tax_code_revisions r ON r.academy_id=h.academy_id AND r.tax_code_id=h.id AND r.version=h.version WHERE h.academy_id=NEW.academy_id AND h.id=NEW.tax_code_id;
IF b.id IS NULL OR NEW.line_number>b.line_count OR t.version IS DISTINCT FROM NEW.tax_code_version OR NOT t.active OR NEW.tax_on<t.starts_on OR(t.ends_on IS NOT NULL AND NEW.tax_on>t.ends_on) OR(t.classification IN('exempt','out_of_scope')) IS DISTINCT FROM(NEW.pricing='not_applicable') THEN RAISE EXCEPTION 'EXPENSE_LINE_TAX_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.finance_tax_codes h WHERE h.academy_id=NEW.academy_id AND h.id=NEW.tax_code_id AND h.hub_id IS NOT NULL AND h.hub_id IS DISTINCT FROM NEW.hub_id) THEN RAISE EXCEPTION 'EXPENSE_TAX_OWNER_INVALID' USING ERRCODE='23514';END IF;
 rate=t.rate_millionths;tax=round(NEW.input_minor*rate/(CASE WHEN NEW.pricing='tax_inclusive' THEN 1000000+rate ELSE 1000000 END));net=CASE WHEN NEW.pricing='tax_inclusive' THEN NEW.input_minor-tax ELSE NEW.input_minor END;gross=net+tax;recoverable=round(tax*NEW.recoverable_rate/1000000);
 IF NEW.net_minor IS DISTINCT FROM net OR NEW.tax_minor IS DISTINCT FROM tax OR NEW.gross_minor IS DISTINCT FROM gross OR NEW.recoverable_minor IS DISTINCT FROM recoverable THEN RAISE EXCEPTION 'EXPENSE_LINE_AMOUNTS_INVALID' USING ERRCODE='23514';END IF;
 FOR a IN SELECT * FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id IN(NEW.expense_account,NEW.tax_account) LOOP
 IF NOT a.active OR a.currency_id IS DISTINCT FROM b.currency_id OR a.unit_scale IS DISTINCT FROM b.unit_scale OR(a.hub_id IS NOT NULL AND a.hub_id IS DISTINCT FROM NEW.hub_id) OR(a.id=NEW.expense_account AND(a.version<>NEW.expense_version OR a.operational_role<>'expense')) OR(a.id=NEW.tax_account AND(a.version<>NEW.tax_version OR a.operational_role<>'tax_receivable')) THEN RAISE EXCEPTION 'EXPENSE_LINE_ACCOUNT_INVALID' USING ERRCODE='23514';END IF;END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER expense_bill_line BEFORE INSERT ON public.expense_bill_lines FOR EACH ROW EXECUTE FUNCTION public.guard_expense_bill_line();
CREATE FUNCTION public.guard_expense_bill() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;p record;BEGIN
 IF TG_OP='UPDATE' THEN IF OLD.void_id IS NOT NULL OR NEW.void_id IS NULL THEN RAISE EXCEPTION 'EXPENSE_VOID_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT * INTO a FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.payable_account;
 SELECT h.version,r.active,h.kind INTO p FROM public.financial_payees h JOIN public.financial_payee_revisions r ON r.academy_id=h.academy_id AND r.payee_id=h.id AND r.version=h.version WHERE h.academy_id=NEW.academy_id AND h.id=NEW.payee_id;
IF NOT EXISTS(SELECT 1 FROM public.finance_currency_catalogue c WHERE c.academy_id=NEW.academy_id AND c.id=NEW.currency_id AND c.version=NEW.currency_version AND c.unit_scale=NEW.unit_scale AND c.active) THEN RAISE EXCEPTION 'EXPENSE_CURRENCY_INVALID' USING ERRCODE='23514';END IF;
 IF a.version IS DISTINCT FROM NEW.payable_version OR NOT a.active OR a.operational_role<>'payable' OR a.currency_id IS DISTINCT FROM NEW.currency_id OR a.unit_scale IS DISTINCT FROM NEW.unit_scale OR p.version IS DISTINCT FROM NEW.payee_version OR NOT p.active OR p.kind='academy' THEN RAISE EXCEPTION 'EXPENSE_PAYABLE_OR_PAYEE_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests r WHERE r.academy_id=NEW.academy_id AND r.id=NEW.approval_id AND r.target_id=NEW.id AND r.target_version=0 AND r.action='finance.expense.record' AND r.privacy_capability='expenses.edit' AND r.status IN('pending','applied')) THEN RAISE EXCEPTION 'EXPENSE_APPROVAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER expense_bill BEFORE INSERT OR UPDATE ON public.expense_bills FOR EACH ROW EXECUTE FUNCTION public.guard_expense_bill();
CREATE FUNCTION public.check_expense_bill_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE j record;s record;BEGIN
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 SELECT count(*) AS n,sum(net_minor) AS net,sum(tax_minor) AS tax,sum(gross_minor) AS gross,sum(recoverable_minor) AS recoverable INTO s FROM public.expense_bill_lines WHERE academy_id=NEW.academy_id AND bill_id=NEW.id;
 IF s.n<>NEW.line_count OR s.net IS DISTINCT FROM NEW.net_minor OR s.tax IS DISTINCT FROM NEW.tax_minor OR s.gross IS DISTINCT FROM NEW.gross_minor OR s.recoverable IS DISTINCT FROM NEW.recoverable_minor OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.period_id IS DISTINCT FROM NEW.period_id OR j.period_version IS DISTINCT FROM NEW.period_version OR j.posted_on IS DISTINCT FROM NEW.posted_on OR j.purpose IS DISTINCT FROM 'activity' OR j.reverses_id IS NOT NULL THEN RAISE EXCEPTION 'EXPENSE_BILL_INCOMPLETE' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.expense_bill_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=NEW.payable_account JOIN public.financial_payees p ON p.academy_id=l.academy_id AND p.id=NEW.payee_id WHERE l.academy_id=NEW.academy_id AND l.bill_id=NEW.id AND((a.hub_id IS NOT NULL AND a.hub_id IS DISTINCT FROM l.hub_id) OR(p.hub_id IS NOT NULL AND p.hub_id IS DISTINCT FROM l.hub_id))) THEN RAISE EXCEPTION 'EXPENSE_OWNER_MISMATCH' USING ERRCODE='23514';END IF;
 IF NEW.evidence_file IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.file_records f WHERE f.academy_id=NEW.academy_id AND f.id=NEW.evidence_file AND f.version=NEW.evidence_version AND f.domain='finance_private' AND NOT f.archived AND(f.anchor_kind='academy' OR(f.anchor_kind='hub' AND EXISTS(SELECT 1 FROM public.expense_bill_lines l WHERE l.academy_id=NEW.academy_id AND l.bill_id=NEW.id AND l.hub_id=f.hub_id)))) THEN RAISE EXCEPTION 'EXPENSE_EVIDENCE_INVALID' USING ERRCODE='23514';END IF;
 IF EXISTS(WITH wanted AS(
 SELECT expense_account AS account,expense_version AS version,'debit' AS side,net_minor+tax_minor-recoverable_minor AS amount FROM public.expense_bill_lines WHERE academy_id=NEW.academy_id AND bill_id=NEW.id
 UNION ALL SELECT tax_account,tax_version,'debit',recoverable_minor FROM public.expense_bill_lines WHERE academy_id=NEW.academy_id AND bill_id=NEW.id AND recoverable_minor>0
 UNION ALL SELECT NEW.payable_account,NEW.payable_version,'credit',NEW.gross_minor),expected AS(SELECT account,version,side,sum(amount) AS amount FROM wanted WHERE amount>0 GROUP BY account,version,side),actual AS(SELECT account_id AS account,account_version AS version,side,sum(amount_minor) AS amount FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id GROUP BY account_id,account_version,side)
 SELECT 1 FROM expected e FULL JOIN actual a USING(account,version,side) WHERE e.amount IS DISTINCT FROM a.amount) THEN RAISE EXCEPTION 'EXPENSE_POSTING_MISMATCH' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_bill_complete AFTER INSERT ON public.expense_bills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_expense_bill_complete();
CREATE FUNCTION public.guard_expense_journal_reversal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.expense_bills b WHERE b.academy_id=NEW.academy_id AND b.id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.id AND p.action='finance.expense.void' AND p.payload->>'billId'=NEW.reverses_id::text) THEN RAISE EXCEPTION 'EXPENSE_VOID_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER expense_journal_reversal BEFORE INSERT ON public.finance_journals FOR EACH ROW WHEN(NEW.reverses_id IS NOT NULL) EXECUTE FUNCTION public.guard_expense_journal_reversal();
CREATE FUNCTION public.check_expense_void_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE v record;b record;j record;BEGIN
 IF TG_TABLE_NAME='finance_journals' THEN IF NOT EXISTS(SELECT 1 FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.reverses_id) THEN RETURN NULL;END IF;SELECT * INTO v FROM public.expense_bill_voids WHERE academy_id=NEW.academy_id AND id=NEW.id;
 ELSE v=NEW;END IF;
 SELECT * INTO b FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=v.bill_id;SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF v.id IS NULL OR b.void_id IS DISTINCT FROM NEW.id OR j.reverses_id IS DISTINCT FROM b.id OR j.approval_id IS DISTINCT FROM v.approval_id OR j.posted_on<b.posted_on OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=v.approval_id AND p.target_id=NEW.id AND p.target_version=0 AND p.action='finance.expense.void' AND p.privacy_capability='expenses.edit' AND p.status IN('pending','applied') AND p.payload->>'billId'=b.id::text) THEN RAISE EXCEPTION 'EXPENSE_VOID_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_void_complete AFTER INSERT ON public.expense_bill_voids DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_expense_void_complete();
CREATE CONSTRAINT TRIGGER expense_journal_void_complete AFTER INSERT ON public.finance_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.reverses_id IS NOT NULL) EXECUTE FUNCTION public.check_expense_void_complete();
REVOKE ALL ON FUNCTION public.guard_expense_journal_reversal(),public.check_expense_void_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_expense_bill_line(),public.guard_expense_bill(),public.check_expense_bill_complete() FROM PUBLIC;
GRANT SELECT,INSERT ON public.expense_bills,public.expense_bill_lines,public.expense_bill_voids TO kavosh_runtime;
GRANT UPDATE(void_id) ON public.expense_bills TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 50 $$;

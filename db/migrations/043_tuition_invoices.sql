INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('invoice-issuers.view','View permitted invoice issuer profiles','Finance',true,ARRAY['hub','country','region','city']),
 ('invoice-issuers.edit','Request reviewed invoice issuer changes','Finance',true,ARRAY['hub','country','region','city']),
 ('invoices.view','View permitted family tuition invoices and credit notes','Finance',true,ARRAY['hub','class','person','country','region','city']),
 ('invoices.edit','Request reviewed tuition invoice and credit-note postings','Finance',true,ARRAY['hub','class','person','country','region','city']);
-- Historical accounts stay explicitly unclassified. A control role is never
-- guessed from an account name, code or asset/liability category.
ALTER TABLE public.finance_account_revisions ADD COLUMN operational_role text NOT NULL DEFAULT 'unclassified'
 CHECK(operational_role IN ('unclassified','cash','bank','receivable','deferred_revenue','tax_payable','revenue','expense','other'));
ALTER TABLE public.finance_account_revisions ADD CONSTRAINT finance_account_operational_role CHECK(
 operational_role IN ('unclassified','other') OR (operational_role IN ('cash','bank','receivable') AND kind='asset' AND normal_balance='debit')
 OR(operational_role IN ('deferred_revenue','tax_payable') AND kind='liability' AND normal_balance='credit') OR(operational_role='revenue' AND kind='income' AND normal_balance='credit') OR(operational_role='expense' AND kind='expense'));
CREATE OR REPLACE VIEW public.finance_account_catalogue WITH(security_invoker=true) AS
 SELECT a.academy_id,a.id,a.hub_id,a.currency_id,a.currency_version,a.code,a.version,a.created_by,a.created_at,r.name,r.description,r.kind,r.normal_balance,r.active,r.translations,r.created_at AS revised_at,
 c.code AS currency_code,u.unit_scale,u.symbol AS currency_symbol,r.operational_role
 FROM public.finance_accounts a JOIN public.finance_account_revisions r ON r.academy_id=a.academy_id AND r.account_id=a.id AND r.version=a.version
 JOIN public.finance_currencies c ON c.academy_id=a.academy_id AND c.id=a.currency_id
 JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version;
CREATE TABLE public.invoice_issuers(
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,hub_id uuid,
 prefix text NOT NULL CHECK(prefix ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),padding integer NOT NULL DEFAULT 8 CHECK(padding BETWEEN 1 AND 12),
 next_number bigint NOT NULL DEFAULT 1 CHECK(next_number BETWEEN 1 AND 999999999999),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,prefix),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE TABLE public.invoice_issuer_revisions(
 academy_id uuid NOT NULL,issuer_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),active boolean NOT NULL,
 changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,issuer_id,version),FOREIGN KEY(academy_id,issuer_id) REFERENCES public.invoice_issuers(academy_id,id),
 FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.invoice_issuers ADD CONSTRAINT invoice_issuer_current_revision FOREIGN KEY(academy_id,id,version)
 REFERENCES public.invoice_issuer_revisions(academy_id,issuer_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION public.guard_invoice_issuer_header() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF (TG_OP='INSERT' AND (NEW.version<>1 OR NEW.next_number<>1)) OR (TG_OP='UPDATE' AND NOT((NEW.version=OLD.version+1 AND NEW.next_number=OLD.next_number) OR(NEW.version=OLD.version AND NEW.next_number=OLD.next_number+1))) THEN
  RAISE EXCEPTION 'INVOICE_ISSUER_SEQUENCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER invoice_issuer_header BEFORE INSERT OR UPDATE ON public.invoice_issuers FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_issuer_header();
CREATE FUNCTION public.guard_invoice_issuer_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.invoice_issuers i WHERE i.academy_id=NEW.academy_id AND i.id=NEW.issuer_id AND i.version=NEW.version)
  OR NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=NEW.academy_id AND a.id=NEW.approval_id AND a.target_id=NEW.issuer_id AND a.target_version=NEW.version-1
   AND a.action=CASE WHEN NEW.version=1 THEN 'finance.invoice-issuer.create' ELSE 'finance.invoice-issuer.replace' END AND a.privacy_capability='invoice-issuers.edit' AND a.status IN ('pending','applied')) THEN
  RAISE EXCEPTION 'INVOICE_ISSUER_APPROVAL_MISMATCH' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER invoice_issuer_revision BEFORE INSERT ON public.invoice_issuer_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_issuer_revision();
CREATE TABLE public.billing_documents(
 academy_id uuid NOT NULL,id uuid NOT NULL,issuer_id uuid NOT NULL,issuer_version integer NOT NULL,sequence bigint NOT NULL CHECK(sequence BETWEEN 1 AND 999999999998),
 number text NOT NULL CHECK(length(number) BETWEEN 3 AND 40),kind text NOT NULL CHECK(kind IN ('invoice','credit_note')),issued_at timestamptz NOT NULL,issued_on date NOT NULL CHECK(issued_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,number),UNIQUE(academy_id,issuer_id,sequence),UNIQUE(academy_id,id,kind),
 FOREIGN KEY(academy_id,issuer_id,issuer_version) REFERENCES public.invoice_issuer_revisions(academy_id,issuer_id,version),
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.tuition_plans ADD CONSTRAINT tuition_invoice_identity UNIQUE(academy_id,id,student_id,class_id,hub_id);
CREATE TABLE public.tuition_invoices(
 academy_id uuid NOT NULL,id uuid NOT NULL,kind text NOT NULL DEFAULT 'invoice' CHECK(kind='invoice'),plan_id uuid NOT NULL,plan_version integer NOT NULL,
 student_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,
 bill_to_id uuid NOT NULL,bill_to_name text NOT NULL CHECK(length(bill_to_name) BETWEEN 1 AND 200),bill_to_snapshot jsonb NOT NULL CHECK(jsonb_typeof(bill_to_snapshot)='object'),
 description text NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),recognition text NOT NULL CHECK(recognition IN ('earned','deferred')),tax_timing_review text NOT NULL CHECK(length(tax_timing_review) BETWEEN 1 AND 2000),
 period_id uuid NOT NULL,period_version integer NOT NULL,journal_id uuid,receivable_account uuid NOT NULL,receivable_version integer NOT NULL,
 consideration_account uuid NOT NULL,consideration_version integer NOT NULL,tax_account uuid,tax_version integer,credit_id uuid,
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,id,kind) REFERENCES public.billing_documents(academy_id,id,kind),
 FOREIGN KEY(academy_id,plan_id,student_id,class_id,hub_id) REFERENCES public.tuition_plans(academy_id,id,student_id,class_id,hub_id),
 FOREIGN KEY(academy_id,plan_id,plan_version) REFERENCES public.tuition_plan_revisions(academy_id,plan_id,version),
 FOREIGN KEY(academy_id,bill_to_id) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,period_id,period_version) REFERENCES public.finance_period_revisions(academy_id,period_id,version),
 FOREIGN KEY(academy_id,journal_id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(academy_id,receivable_account,receivable_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,consideration_account,consideration_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,tax_account,tax_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),CHECK((tax_account IS NULL)=(tax_version IS NULL))
);
CREATE UNIQUE INDEX tuition_invoice_active ON public.tuition_invoices(academy_id,plan_id) WHERE credit_id IS NULL;
CREATE INDEX tuition_invoice_student ON public.tuition_invoices(academy_id,student_id,id);
CREATE INDEX tuition_invoice_hub ON public.tuition_invoices(academy_id,hub_id,id);
CREATE TABLE public.tuition_invoice_credits(
 academy_id uuid NOT NULL,id uuid NOT NULL,kind text NOT NULL DEFAULT 'credit_note' CHECK(kind='credit_note'),invoice_id uuid NOT NULL,journal_id uuid,
 description text NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,invoice_id),UNIQUE(academy_id,id,invoice_id),
 FOREIGN KEY(academy_id,id,kind) REFERENCES public.billing_documents(academy_id,id,kind),FOREIGN KEY(academy_id,invoice_id) REFERENCES public.tuition_invoices(academy_id,id),
 FOREIGN KEY(academy_id,journal_id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.tuition_invoices ADD CONSTRAINT invoice_credit_identity FOREIGN KEY(academy_id,credit_id,id) REFERENCES public.tuition_invoice_credits(academy_id,id,invoice_id) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['invoice_issuers','invoice_issuer_revisions','billing_documents','tuition_invoices','tuition_invoice_credits'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE FUNCTION public.guard_billing_document() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE i record;BEGIN
 SELECT * INTO i FROM public.invoice_issuers WHERE academy_id=NEW.academy_id AND id=NEW.issuer_id;
 IF i.next_number IS DISTINCT FROM NEW.sequence+1 OR NEW.number IS DISTINCT FROM (i.prefix||'-'||lpad(NEW.sequence::text,greatest(i.padding,length(NEW.sequence::text)),'0'))
  OR NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=NEW.academy_id AND a.id=NEW.approval_id AND a.target_id=NEW.id AND a.target_version=0 AND a.status IN ('pending','applied') AND a.privacy_capability='invoices.edit'
   AND a.action=CASE WHEN NEW.kind='invoice' THEN 'finance.invoice.issue' ELSE 'finance.invoice.credit' END) THEN RAISE EXCEPTION 'BILLING_DOCUMENT_APPROVAL_MISMATCH' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER billing_document BEFORE INSERT ON public.billing_documents FOR EACH ROW EXECUTE FUNCTION public.guard_billing_document();
CREATE FUNCTION public.guard_tuition_invoice_edit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF OLD.credit_id IS NOT NULL OR NEW.credit_id IS NULL THEN RAISE EXCEPTION 'INVOICE_CREDIT_TRANSITION_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER tuition_invoice_edit BEFORE UPDATE ON public.tuition_invoices FOR EACH ROW EXECUTE FUNCTION public.guard_tuition_invoice_edit();
CREATE FUNCTION public.guard_invoiced_tuition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.tuition_invoices i WHERE i.academy_id=OLD.academy_id AND i.plan_id=OLD.id AND i.credit_id IS NULL) THEN RAISE EXCEPTION 'TUITION_INVOICE_REQUIRES_CREDIT' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER tuition_invoice_terms BEFORE UPDATE ON public.tuition_plans FOR EACH ROW EXECUTE FUNCTION public.guard_invoiced_tuition();
CREATE FUNCTION public.guard_invoice_reversal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.reverses_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.tuition_invoices i WHERE i.academy_id=NEW.academy_id AND i.journal_id=NEW.reverses_id)
  AND NOT EXISTS(SELECT 1 FROM public.approval_requests a JOIN public.tuition_invoices i ON i.academy_id=a.academy_id AND i.id::text=a.payload->>'invoiceId'
   WHERE a.academy_id=NEW.academy_id AND a.id=NEW.approval_id AND a.action='finance.invoice.credit' AND a.target_id=NEW.id AND i.journal_id=NEW.reverses_id AND i.credit_id IS NULL) THEN
  RAISE EXCEPTION 'INVOICE_CREDIT_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER invoice_reversal BEFORE INSERT ON public.finance_journals FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_reversal();
CREATE FUNCTION public.validate_billing_document() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE i record;r record;j record;a record;issuer_hub uuid;expected_count integer;l record;units integer;
BEGIN
 IF NEW.kind='credit_note' THEN
  SELECT c.invoice_id,c.journal_id,x.journal_id AS original_journal,x.credit_id,d.issuer_id,d.issuer_version,d.issued_at INTO i FROM public.tuition_invoice_credits c JOIN public.tuition_invoices x ON x.academy_id=c.academy_id AND x.id=c.invoice_id JOIN public.billing_documents d ON d.academy_id=x.academy_id AND d.id=x.id WHERE c.academy_id=NEW.academy_id AND c.id=NEW.id;
  IF i.invoice_id IS NULL OR i.credit_id IS DISTINCT FROM NEW.id OR NEW.issuer_id IS DISTINCT FROM i.issuer_id OR NEW.issuer_version IS DISTINCT FROM i.issuer_version OR NEW.issued_at<i.issued_at OR (i.original_journal IS NULL AND i.journal_id IS NOT NULL) OR (i.original_journal IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.finance_journals credited_journal WHERE credited_journal.academy_id=NEW.academy_id AND credited_journal.id=NEW.id AND credited_journal.id=i.journal_id AND credited_journal.reverses_id=i.original_journal AND credited_journal.approval_id=NEW.approval_id AND credited_journal.posted_on=NEW.issued_on)) THEN RAISE EXCEPTION 'INVOICE_CREDIT_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;
 END IF;
 SELECT x.*,p.currency_id,p.unit_scale,p.version AS current_plan_version INTO i FROM public.tuition_invoices x JOIN public.tuition_plans p ON p.academy_id=x.academy_id AND p.id=x.plan_id WHERE x.academy_id=NEW.academy_id AND x.id=NEW.id;
 SELECT * INTO r FROM public.tuition_plan_revisions WHERE academy_id=NEW.academy_id AND plan_id=i.plan_id AND version=i.plan_version;
 SELECT hub_id INTO issuer_hub FROM public.invoice_issuers WHERE academy_id=NEW.academy_id AND id=NEW.issuer_id;
 IF i.id IS NULL OR r.state IS DISTINCT FROM 'active' OR i.current_plan_version IS DISTINCT FROM i.plan_version OR (issuer_hub IS NOT NULL AND issuer_hub<>i.hub_id)
  OR NOT EXISTS(SELECT 1 FROM public.invoice_issuers h JOIN public.invoice_issuer_revisions v ON v.academy_id=h.academy_id AND v.issuer_id=h.id AND v.version=h.version WHERE h.academy_id=NEW.academy_id AND h.id=NEW.issuer_id AND h.version=NEW.issuer_version AND v.active) THEN RAISE EXCEPTION 'INVOICE_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
 FOR a IN SELECT f.id,f.hub_id,f.currency_id,u.unit_scale,v.kind,v.active,f.version,v.operational_role FROM public.finance_accounts f JOIN public.finance_account_revisions v ON v.academy_id=f.academy_id AND v.account_id=f.id AND v.version=f.version JOIN public.finance_currency_revisions u ON u.academy_id=f.academy_id AND u.currency_id=f.currency_id AND u.version=f.currency_version WHERE f.academy_id=NEW.academy_id AND f.id IN(i.receivable_account,i.consideration_account,i.tax_account) LOOP
  IF a.currency_id<>i.currency_id OR a.unit_scale<>i.unit_scale OR (a.hub_id IS NOT NULL AND a.hub_id<>i.hub_id) OR NOT a.active
   OR (a.id=i.receivable_account AND (a.operational_role<>'receivable' OR a.version<>i.receivable_version))
   OR (a.id=i.consideration_account AND (a.operational_role<>(CASE WHEN i.recognition='earned' THEN 'revenue' ELSE 'deferred_revenue' END) OR a.version<>i.consideration_version))
   OR (a.id=i.tax_account AND (a.operational_role<>'tax_payable' OR a.version<>i.tax_version)) THEN RAISE EXCEPTION 'INVOICE_ACCOUNT_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 END LOOP;
 IF (r.tax_minor>0 AND i.tax_account IS NULL) OR i.receivable_account=i.consideration_account OR i.tax_account IN(i.receivable_account,i.consideration_account) THEN RAISE EXCEPTION 'INVOICE_ACCOUNT_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 IF r.gross_minor=0 THEN IF i.journal_id IS NOT NULL THEN RAISE EXCEPTION 'ZERO_INVOICE_POSTING_FORBIDDEN' USING ERRCODE='23514';END IF;RETURN NULL;END IF;
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=i.journal_id;
 expected_count=1+CASE WHEN r.net_minor>0 THEN 1 ELSE 0 END+CASE WHEN r.tax_minor>0 THEN 1 ELSE 0 END;
 IF j.id IS DISTINCT FROM NEW.id OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.period_id IS DISTINCT FROM i.period_id OR j.period_version IS DISTINCT FROM i.period_version OR j.posted_on IS DISTINCT FROM NEW.issued_on OR j.line_count IS DISTINCT FROM expected_count OR j.reverses_id IS NOT NULL OR j.purpose IS DISTINCT FROM 'activity' THEN RAISE EXCEPTION 'INVOICE_POSTING_MISMATCH' USING ERRCODE='23514';END IF;
 FOR l IN SELECT * FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=j.id LOOP
  IF NOT((l.account_id=i.receivable_account AND l.account_version=i.receivable_version AND l.side='debit' AND l.amount_minor=r.gross_minor)
   OR(l.account_id=i.consideration_account AND l.account_version=i.consideration_version AND l.side='credit' AND l.amount_minor=r.net_minor)
   OR(l.account_id=i.tax_account AND l.account_version=i.tax_version AND l.side='credit' AND l.amount_minor=r.tax_minor)) THEN RAISE EXCEPTION 'INVOICE_POSTING_MISMATCH' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER billing_document_complete AFTER INSERT ON public.billing_documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_billing_document();
REVOKE ALL ON FUNCTION public.guard_invoice_issuer_header(),public.guard_invoice_issuer_revision(),public.guard_billing_document(),public.guard_tuition_invoice_edit(),public.guard_invoiced_tuition(),public.guard_invoice_reversal(),public.validate_billing_document() FROM PUBLIC;
GRANT SELECT ON public.invoice_issuers,public.invoice_issuer_revisions,public.billing_documents,public.tuition_invoices,public.tuition_invoice_credits TO kavosh_runtime;
GRANT INSERT(academy_id,id,hub_id,prefix,padding,created_by) ON public.invoice_issuers TO kavosh_runtime;
GRANT UPDATE(version,next_number) ON public.invoice_issuers TO kavosh_runtime;
GRANT INSERT ON public.invoice_issuer_revisions,public.billing_documents,public.tuition_invoices,public.tuition_invoice_credits TO kavosh_runtime;
GRANT UPDATE(credit_id) ON public.tuition_invoices TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 43 $$;

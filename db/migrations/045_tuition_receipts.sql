INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('receipts.view','View permitted tuition payment receipts','Finance',true,ARRAY['hub','class','person','country','region','city']),
 ('receipts.edit','Request reviewed tuition receipts and corrections','Finance',true,ARRAY['hub','class','person','country','region','city']);
ALTER TABLE public.tuition_invoices ADD CONSTRAINT invoice_receipt_context UNIQUE(academy_id,id,student_id,class_id,hub_id);
CREATE TABLE public.tuition_receipts(
 academy_id uuid NOT NULL,id uuid NOT NULL,invoice_id uuid NOT NULL,student_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,
 amount_minor numeric NOT NULL CHECK(amount_minor=trunc(amount_minor) AND amount_minor>0 AND amount_minor<1e38),
 collector_id uuid NOT NULL,collector_version integer NOT NULL,method_id uuid NOT NULL,method_version integer NOT NULL,
 holding_account uuid NOT NULL,holding_version integer NOT NULL,received_by uuid,received_at timestamptz NOT NULL,received_on date NOT NULL CHECK(received_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 reference text NOT NULL CHECK(length(reference)<=200),evidence_file uuid,evidence_version integer,missing_evidence_reason text NOT NULL CHECK(length(missing_evidence_reason)<=2000),
 tax_treatment text NOT NULL CHECK(tax_treatment='settle_invoice'),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 approval_id uuid NOT NULL,reversal_id uuid,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),CHECK((evidence_file IS NULL)=(evidence_version IS NULL)),CHECK(evidence_file IS NOT NULL OR length(missing_evidence_reason)>0),
 FOREIGN KEY(academy_id,invoice_id,student_id,class_id,hub_id) REFERENCES public.tuition_invoices(academy_id,id,student_id,class_id,hub_id),
 FOREIGN KEY(academy_id,collector_id,collector_version) REFERENCES public.finance_collector_revisions(academy_id,collector_id,version),
 FOREIGN KEY(academy_id,method_id,method_version) REFERENCES public.finance_payment_method_revisions(academy_id,method_id,version),
 FOREIGN KEY(academy_id,holding_account,holding_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,received_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,evidence_file,evidence_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),
 FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX receipt_invoice ON public.tuition_receipts(academy_id,invoice_id,id);
CREATE INDEX receipt_student ON public.tuition_receipts(academy_id,student_id,id);
CREATE INDEX receipt_collector ON public.tuition_receipts(academy_id,collector_id,received_on,id);
CREATE UNIQUE INDEX receipt_reference ON public.tuition_receipts(academy_id,collector_id,method_id,reference) WHERE reference<>'' AND reversal_id IS NULL;
CREATE TABLE public.tuition_receipt_reversals(
 academy_id uuid NOT NULL,id uuid NOT NULL,receipt_id uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,receipt_id),UNIQUE(academy_id,id,receipt_id),
 FOREIGN KEY(academy_id,receipt_id) REFERENCES public.tuition_receipts(academy_id,id),FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.tuition_receipts ADD CONSTRAINT receipt_reversal_link FOREIGN KEY(academy_id,reversal_id,id) REFERENCES public.tuition_receipt_reversals(academy_id,id,receipt_id) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['tuition_receipts','tuition_receipt_reversals'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
 END LOOP;
END $$;
CREATE FUNCTION public.guard_tuition_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE i record;c record;m record;a record;gross numeric;received numeric;time_zone text;
BEGIN
 IF TG_OP='UPDATE' THEN IF OLD.reversal_id IS NOT NULL OR NEW.reversal_id IS NULL THEN RAISE EXCEPTION 'RECEIPT_REVERSAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT x.*,d.issued_at INTO i FROM public.tuition_invoices x JOIN public.billing_documents d ON d.academy_id=x.academy_id AND d.id=x.id WHERE x.academy_id=NEW.academy_id AND x.id=NEW.invoice_id FOR UPDATE OF x;
 SELECT r.gross_minor INTO gross FROM public.tuition_plan_revisions r WHERE r.academy_id=NEW.academy_id AND r.plan_id=i.plan_id AND r.version=i.plan_version;
 SELECT coalesce(sum(amount_minor),0) INTO received FROM public.tuition_receipts WHERE academy_id=NEW.academy_id AND invoice_id=NEW.invoice_id AND reversal_id IS NULL;
 SELECT cl.time_zone INTO time_zone FROM public.classes cl WHERE cl.academy_id=NEW.academy_id AND cl.id=i.class_id;
 IF i.id IS NULL OR i.credit_id IS NOT NULL OR NEW.received_at<i.issued_at OR NEW.received_on IS DISTINCT FROM(NEW.received_at AT TIME ZONE time_zone)::date OR received+NEW.amount_minor>gross THEN RAISE EXCEPTION 'RECEIPT_INVOICE_BALANCE_INVALID' USING ERRCODE='23514';END IF;
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
CREATE TRIGGER tuition_receipt BEFORE INSERT OR UPDATE ON public.tuition_receipts FOR EACH ROW EXECUTE FUNCTION public.guard_tuition_receipt();
CREATE FUNCTION public.guard_receipt_journal_reversal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.reverses_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.tuition_receipts r WHERE r.academy_id=NEW.academy_id AND r.id=NEW.reverses_id)
  AND NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.id AND p.action='finance.receipt.reverse' AND p.payload->>'receiptId'=NEW.reverses_id::text) THEN RAISE EXCEPTION 'RECEIPT_CORRECTION_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER receipt_journal_reversal BEFORE INSERT ON public.finance_journals FOR EACH ROW EXECUTE FUNCTION public.guard_receipt_journal_reversal();
CREATE FUNCTION public.validate_receipt_posting() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE i record;j record;r record;
BEGIN
 IF TG_TABLE_NAME='tuition_receipt_reversals' THEN
  SELECT * INTO r FROM public.tuition_receipts WHERE academy_id=NEW.academy_id AND id=NEW.receipt_id;
  IF r.reversal_id IS DISTINCT FROM NEW.id OR NOT EXISTS(SELECT 1 FROM public.finance_journals h WHERE h.academy_id=NEW.academy_id AND h.id=NEW.id AND h.reverses_id=NEW.receipt_id AND h.approval_id=NEW.approval_id)
   OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.id AND p.target_version=0 AND p.status IN ('pending','applied') AND p.privacy_capability='receipts.edit' AND p.action='finance.receipt.reverse' AND p.payload->>'receiptId'=NEW.receipt_id::text) THEN RAISE EXCEPTION 'RECEIPT_CORRECTION_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;
 END IF;
 SELECT * INTO i FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=NEW.invoice_id;
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF j.id IS NULL OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.posted_on IS DISTINCT FROM NEW.received_on OR j.line_count<>2 OR j.purpose<>'activity' OR j.reverses_id IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines l WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.id AND l.line_number=1 AND l.account_id=NEW.holding_account AND l.account_version=NEW.holding_version AND l.side='debit' AND l.amount_minor=NEW.amount_minor)
  OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines l WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.id AND l.line_number=2 AND l.account_id=i.receivable_account AND l.side='credit' AND l.amount_minor=NEW.amount_minor) THEN RAISE EXCEPTION 'RECEIPT_POSTING_MISMATCH' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER receipt_posting_complete AFTER INSERT ON public.tuition_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_receipt_posting();
CREATE CONSTRAINT TRIGGER receipt_reversal_complete AFTER INSERT ON public.tuition_receipt_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_receipt_posting();
REVOKE ALL ON FUNCTION public.guard_tuition_receipt(),public.guard_receipt_journal_reversal(),public.validate_receipt_posting() FROM PUBLIC;
GRANT SELECT,INSERT ON public.tuition_receipts,public.tuition_receipt_reversals TO kavosh_runtime;
GRANT UPDATE(reversal_id) ON public.tuition_receipts TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 45 $$;

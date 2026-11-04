INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('transfers.view','View permitted internal account transfers','Finance',true,ARRAY['hub','country','region','city']),
 ('transfers.edit','Request reviewed internal account transfers and corrections','Finance',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.finance_transfers(
 academy_id uuid NOT NULL,id uuid NOT NULL,from_account uuid NOT NULL,from_version integer NOT NULL,to_account uuid NOT NULL,to_version integer NOT NULL,
 currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),amount_minor numeric NOT NULL CHECK(amount_minor=trunc(amount_minor) AND amount_minor>0 AND amount_minor<1e38),
 method_id uuid NOT NULL,method_version integer NOT NULL,period_id uuid NOT NULL,period_version integer NOT NULL,posted_on date NOT NULL CHECK(posted_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),transferred_at timestamptz NOT NULL,
 reference text NOT NULL CHECK(length(reference)<=200),handled_by uuid,evidence_file uuid,evidence_version integer,missing_evidence_reason text NOT NULL CHECK(length(missing_evidence_reason)<=2000),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 approval_id uuid NOT NULL,reversal_id uuid,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(academy_id,id),
 CHECK(from_account<>to_account),CHECK((evidence_file IS NULL)=(evidence_version IS NULL)),CHECK(evidence_file IS NOT NULL OR length(missing_evidence_reason)>0),
 FOREIGN KEY(academy_id,from_account,from_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,to_account,to_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),FOREIGN KEY(academy_id,method_id,method_version) REFERENCES public.finance_payment_method_revisions(academy_id,method_id,version),
 FOREIGN KEY(academy_id,period_id,period_version) REFERENCES public.finance_period_revisions(academy_id,period_id,version),FOREIGN KEY(academy_id,handled_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,evidence_file,evidence_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX transfer_from ON public.finance_transfers(academy_id,from_account,posted_on,id);
CREATE INDEX transfer_to ON public.finance_transfers(academy_id,to_account,posted_on,id);
CREATE UNIQUE INDEX transfer_reference ON public.finance_transfers(academy_id,from_account,method_id,reference) WHERE reference<>'' AND reversal_id IS NULL;
CREATE TABLE public.finance_transfer_reversals(
 academy_id uuid NOT NULL,id uuid NOT NULL,transfer_id uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,transfer_id),UNIQUE(academy_id,id,transfer_id),FOREIGN KEY(academy_id,transfer_id) REFERENCES public.finance_transfers(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.finance_transfers ADD CONSTRAINT transfer_reversal_identity FOREIGN KEY(academy_id,reversal_id,id) REFERENCES public.finance_transfer_reversals(academy_id,id,transfer_id) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['finance_transfers','finance_transfer_reversals'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
END LOOP;END $$;
CREATE FUNCTION public.guard_finance_transfer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;b record;m record;BEGIN
 IF TG_OP='UPDATE' THEN IF OLD.reversal_id IS NOT NULL OR NEW.reversal_id IS NULL THEN RAISE EXCEPTION 'TRANSFER_REVERSAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT * INTO a FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.from_account;
 SELECT * INTO b FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.to_account;
 SELECT p.hub_id,r.active,p.version INTO m FROM public.finance_payment_methods p JOIN public.finance_payment_method_revisions r ON r.academy_id=p.academy_id AND r.method_id=p.id AND r.version=p.version WHERE p.academy_id=NEW.academy_id AND p.id=NEW.method_id;
 IF a.version IS DISTINCT FROM NEW.from_version OR b.version IS DISTINCT FROM NEW.to_version OR NOT a.active OR NOT b.active OR a.operational_role NOT IN ('cash','bank') OR b.operational_role NOT IN ('cash','bank') OR a.currency_id IS DISTINCT FROM NEW.currency_id OR b.currency_id IS DISTINCT FROM NEW.currency_id OR a.unit_scale IS DISTINCT FROM NEW.unit_scale OR b.unit_scale IS DISTINCT FROM NEW.unit_scale OR m.version IS DISTINCT FROM NEW.method_version OR NOT m.active OR(m.hub_id IS NOT NULL AND m.hub_id IS DISTINCT FROM a.hub_id AND m.hub_id IS DISTINCT FROM b.hub_id) THEN RAISE EXCEPTION 'TRANSFER_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.handled_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.handled_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'TRANSFER_HANDLER_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.evidence_file IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.file_records f WHERE f.academy_id=NEW.academy_id AND f.id=NEW.evidence_file AND f.version=NEW.evidence_version AND NOT f.archived AND f.domain='finance_private' AND(f.anchor_kind='academy' OR(f.anchor_kind='hub' AND f.hub_id IN(a.hub_id,b.hub_id)))) THEN RAISE EXCEPTION 'TRANSFER_EVIDENCE_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.id AND p.target_version=0 AND p.action='finance.transfer.record' AND p.privacy_capability='transfers.edit' AND p.status IN('pending','applied')) THEN RAISE EXCEPTION 'TRANSFER_APPROVAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER finance_transfer BEFORE INSERT OR UPDATE ON public.finance_transfers FOR EACH ROW EXECUTE FUNCTION public.guard_finance_transfer();
CREATE FUNCTION public.guard_transfer_journal_reversal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.reverses_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.finance_transfers t WHERE t.academy_id=NEW.academy_id AND t.id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.action='finance.transfer.reverse' AND p.target_id=NEW.id AND p.payload->>'transferId'=NEW.reverses_id::text) THEN RAISE EXCEPTION 'TRANSFER_CORRECTION_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER transfer_journal_reversal BEFORE INSERT ON public.finance_journals FOR EACH ROW EXECUTE FUNCTION public.guard_transfer_journal_reversal();
CREATE FUNCTION public.check_transfer_posting() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE j record;t record;BEGIN
 IF TG_TABLE_NAME='finance_transfer_reversals' THEN
 SELECT * INTO t FROM public.finance_transfers WHERE academy_id=NEW.academy_id AND id=NEW.transfer_id;
 IF t.reversal_id IS DISTINCT FROM NEW.id OR NOT EXISTS(SELECT 1 FROM public.finance_journals h WHERE h.academy_id=NEW.academy_id AND h.id=NEW.id AND h.reverses_id=NEW.transfer_id AND h.approval_id=NEW.approval_id AND h.posted_on>=t.posted_on) OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.id AND p.target_version=0 AND p.action='finance.transfer.reverse' AND p.privacy_capability='transfers.edit' AND p.status IN('pending','applied') AND p.payload->>'transferId'=NEW.transfer_id::text) THEN RAISE EXCEPTION 'TRANSFER_CORRECTION_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;END IF;
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF j.id IS NULL OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.posted_on IS DISTINCT FROM NEW.posted_on OR j.period_id IS DISTINCT FROM NEW.period_id OR j.period_version IS DISTINCT FROM NEW.period_version OR j.purpose<>'activity' OR j.reverses_id IS NOT NULL OR j.line_count<>2
 OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines l WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.id AND l.line_number=1 AND l.account_id=NEW.to_account AND l.account_version=NEW.to_version AND l.side='debit' AND l.amount_minor=NEW.amount_minor)
 OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines l WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.id AND l.line_number=2 AND l.account_id=NEW.from_account AND l.account_version=NEW.from_version AND l.side='credit' AND l.amount_minor=NEW.amount_minor) THEN RAISE EXCEPTION 'TRANSFER_POSTING_INVALID' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER transfer_posting_complete AFTER INSERT ON public.finance_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_transfer_posting();
CREATE CONSTRAINT TRIGGER transfer_reversal_complete AFTER INSERT ON public.finance_transfer_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_transfer_posting();
-- Check the journal side as well as the operational row. A correct inverse
-- and a real pending approval alone must not leave the source marked active.
CREATE FUNCTION public.check_operational_correction_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.finance_transfers x WHERE x.academy_id=NEW.academy_id AND x.id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.finance_transfer_reversals r JOIN public.finance_transfers x ON x.academy_id=r.academy_id AND x.id=r.transfer_id AND x.reversal_id=r.id WHERE r.academy_id=NEW.academy_id AND r.id=NEW.id AND r.transfer_id=NEW.reverses_id AND r.approval_id=NEW.approval_id) THEN RAISE EXCEPTION 'TRANSFER_CORRECTION_INCOMPLETE' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.tuition_receipts x WHERE x.academy_id=NEW.academy_id AND x.id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.tuition_receipt_reversals r JOIN public.tuition_receipts x ON x.academy_id=r.academy_id AND x.id=r.receipt_id AND x.reversal_id=r.id WHERE r.academy_id=NEW.academy_id AND r.id=NEW.id AND r.receipt_id=NEW.reverses_id AND r.approval_id=NEW.approval_id) THEN RAISE EXCEPTION 'RECEIPT_CORRECTION_INCOMPLETE' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.collector_remittances x WHERE x.academy_id=NEW.academy_id AND x.id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.collector_remittance_reversals r JOIN public.collector_remittances x ON x.academy_id=r.academy_id AND x.id=r.remittance_id AND x.reversal_id=r.id WHERE r.academy_id=NEW.academy_id AND r.id=NEW.id AND r.remittance_id=NEW.reverses_id AND r.approval_id=NEW.approval_id) THEN RAISE EXCEPTION 'REMITTANCE_CORRECTION_INCOMPLETE' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.tuition_invoices x WHERE x.academy_id=NEW.academy_id AND x.journal_id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.tuition_invoice_credits r JOIN public.tuition_invoices x ON x.academy_id=r.academy_id AND x.id=r.invoice_id AND x.credit_id=r.id WHERE r.academy_id=NEW.academy_id AND r.journal_id=NEW.id AND x.journal_id=NEW.reverses_id) THEN RAISE EXCEPTION 'INVOICE_CREDIT_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER operational_journal_correction_complete AFTER INSERT ON public.finance_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.reverses_id IS NOT NULL) EXECUTE FUNCTION public.check_operational_correction_complete();
REVOKE ALL ON FUNCTION public.check_operational_correction_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_finance_transfer(),public.guard_transfer_journal_reversal(),public.check_transfer_posting() FROM PUBLIC;
GRANT SELECT,INSERT ON public.finance_transfers,public.finance_transfer_reversals TO kavosh_runtime;
GRANT UPDATE(reversal_id) ON public.finance_transfers TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 49 $$;

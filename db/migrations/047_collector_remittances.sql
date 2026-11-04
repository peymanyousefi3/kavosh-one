INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('remittances.view','View permitted collector remittances and balances','Finance',true,ARRAY['hub','country','region','city']),
 ('remittances.edit','Request reviewed collector remittances and corrections','Finance',true,ARRAY['hub','country','region','city']),
 ('financial-files.view','View permitted private financial files','Finance',true,ARRAY['hub','class','person','country','region','city']),
 ('financial-files.edit','Maintain permitted private financial files','Finance',true,ARRAY['hub','class','person','country','region','city']);
ALTER TABLE public.file_records DROP CONSTRAINT file_records_domain_check;
ALTER TABLE public.file_records DROP CONSTRAINT file_records_check1;
ALTER TABLE public.file_records ADD CONSTRAINT file_records_domain_check CHECK(domain IN ('general','student_private','guardian_private','agreement_definition','finance_private'));
ALTER TABLE public.file_records ADD CONSTRAINT file_records_domain_anchor CHECK(domain IN ('general','finance_private') OR(domain IN ('student_private','guardian_private') AND anchor_kind='person') OR(domain='agreement_definition' AND anchor_kind IN ('academy','hub')));
-- A narrow lock shared by receipt changes and remittances. Academy-controlled
-- cash receipts remain parallel; only third-party balances need this gate.
CREATE FUNCTION public.lock_collector_funds(p_collector uuid,p_holding uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE academy uuid;custody text;BEGIN
 academy=nullif(current_setting('app.academy_id',true),'')::uuid;IF academy IS NULL THEN RAISE EXCEPTION 'FINANCE_CONTEXT_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT c.custody INTO custody FROM public.finance_collectors c WHERE c.academy_id=academy AND c.id=p_collector;
 IF custody IS NULL THEN RAISE EXCEPTION 'COLLECTOR_REQUIRED' USING ERRCODE='23503';END IF;
 IF custody='third_party' THEN PERFORM pg_advisory_xact_lock(hashtextextended(academy::text||':'||p_collector::text||':'||p_holding::text,11));END IF;
END $$;
CREATE FUNCTION public.guard_receipt_collector_funds() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF nullif(current_setting('app.academy_id',true),'') IS NOT NULL THEN PERFORM public.lock_collector_funds(NEW.collector_id,NEW.holding_account);END IF;RETURN NEW;
END $$;
CREATE TRIGGER aa_receipt_collector_funds BEFORE INSERT OR UPDATE ON public.tuition_receipts FOR EACH ROW EXECUTE FUNCTION public.guard_receipt_collector_funds();
CREATE INDEX receipt_collector_fund_bucket ON public.tuition_receipts(academy_id,collector_id,holding_account,id);
CREATE TABLE public.collector_remittances(
 academy_id uuid NOT NULL,id uuid NOT NULL,collector_id uuid NOT NULL,collector_version integer NOT NULL,hub_id uuid,
 holding_account uuid NOT NULL,holding_version integer NOT NULL,academy_account uuid NOT NULL,academy_version integer NOT NULL,
 currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),direction text NOT NULL CHECK(direction IN ('to_academy','to_collector')),
 amount_minor numeric NOT NULL CHECK(amount_minor=trunc(amount_minor) AND amount_minor>0 AND amount_minor<1e38),
 method_id uuid NOT NULL,method_version integer NOT NULL,transferred_at timestamptz NOT NULL,posted_on date NOT NULL CHECK(posted_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 period_id uuid NOT NULL,period_version integer NOT NULL,reference text NOT NULL CHECK(length(reference)<=200),handled_by uuid,
 evidence_file uuid,evidence_version integer,missing_evidence_reason text NOT NULL CHECK(length(missing_evidence_reason)<=2000),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),approval_id uuid NOT NULL,reversal_id uuid,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),CHECK(holding_account<>academy_account),CHECK((evidence_file IS NULL)=(evidence_version IS NULL)),CHECK(evidence_file IS NOT NULL OR length(missing_evidence_reason)>0),
 FOREIGN KEY(academy_id,collector_id,collector_version) REFERENCES public.finance_collector_revisions(academy_id,collector_id,version),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,holding_account,holding_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,academy_account,academy_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),FOREIGN KEY(academy_id,method_id,method_version) REFERENCES public.finance_payment_method_revisions(academy_id,method_id,version),
 FOREIGN KEY(academy_id,period_id,period_version) REFERENCES public.finance_period_revisions(academy_id,period_id,version),FOREIGN KEY(academy_id,handled_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,evidence_file,evidence_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE INDEX remittance_collector ON public.collector_remittances(academy_id,collector_id,holding_account,posted_on,id);
CREATE INDEX remittance_hub ON public.collector_remittances(academy_id,hub_id,id);
CREATE UNIQUE INDEX remittance_reference ON public.collector_remittances(academy_id,collector_id,method_id,reference) WHERE reference<>'' AND reversal_id IS NULL;
CREATE TABLE public.collector_remittance_reversals(
 academy_id uuid NOT NULL,id uuid NOT NULL,remittance_id uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,remittance_id),UNIQUE(academy_id,id,remittance_id),FOREIGN KEY(academy_id,remittance_id) REFERENCES public.collector_remittances(academy_id,id),
 FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.collector_remittances ADD CONSTRAINT remittance_reversal_identity FOREIGN KEY(academy_id,reversal_id,id) REFERENCES public.collector_remittance_reversals(academy_id,id,remittance_id) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['collector_remittances','collector_remittance_reversals'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
 END LOOP;
END $$;
-- Signed immutable journal events, including the actual correction date. A
-- later reversal must not erase what a historical balance genuinely showed.
CREATE VIEW public.collector_fund_events WITH(security_invoker=true) AS
 SELECT r.academy_id,r.collector_id,r.holding_account,j.id AS journal_id,j.posted_on,r.amount_minor AS delta_minor FROM public.tuition_receipts r JOIN public.finance_collectors c ON c.academy_id=r.academy_id AND c.id=r.collector_id AND c.custody='third_party' JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=r.academy_id AND h.id=r.id OFFSET 0) j ON true
 UNION ALL SELECT r.academy_id,r.collector_id,r.holding_account,j.id,j.posted_on,-r.amount_minor FROM public.tuition_receipt_reversals v JOIN public.tuition_receipts r ON r.academy_id=v.academy_id AND r.id=v.receipt_id JOIN public.finance_collectors c ON c.academy_id=r.academy_id AND c.id=r.collector_id AND c.custody='third_party' JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=v.academy_id AND h.id=v.id OFFSET 0) j ON true
 UNION ALL SELECT r.academy_id,r.collector_id,r.holding_account,j.id,j.posted_on,CASE WHEN r.direction='to_academy' THEN -r.amount_minor ELSE r.amount_minor END FROM public.collector_remittances r JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=r.academy_id AND h.id=r.id OFFSET 0) j ON true
 UNION ALL SELECT r.academy_id,r.collector_id,r.holding_account,j.id,j.posted_on,CASE WHEN r.direction='to_academy' THEN r.amount_minor ELSE -r.amount_minor END FROM public.collector_remittance_reversals v JOIN public.collector_remittances r ON r.academy_id=v.academy_id AND r.id=v.remittance_id JOIN LATERAL(SELECT h.id,h.posted_on FROM public.finance_journals h WHERE h.academy_id=v.academy_id AND h.id=v.id OFFSET 0) j ON true;
CREATE FUNCTION public.collector_fund_balance(p_collector uuid,p_holding uuid,p_through date) RETURNS TABLE(current_minor numeric,through_minor numeric) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(sum(delta_minor),0),coalesce(sum(delta_minor) FILTER(WHERE posted_on<=p_through),0) FROM public.collector_fund_events WHERE collector_id=p_collector AND holding_account=p_holding
$$;
CREATE FUNCTION public.guard_collector_remittance() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c record;a record;b record;m record;funds record;
BEGIN
 PERFORM public.lock_collector_funds(NEW.collector_id,NEW.holding_account);
 IF TG_OP='UPDATE' THEN IF OLD.reversal_id IS NOT NULL OR NEW.reversal_id IS NULL THEN RAISE EXCEPTION 'REMITTANCE_REVERSAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT h.*,v.active INTO c FROM public.finance_collectors h JOIN public.finance_collector_revisions v ON v.academy_id=h.academy_id AND v.collector_id=h.id AND v.version=h.version WHERE h.academy_id=NEW.academy_id AND h.id=NEW.collector_id;
 SELECT * INTO a FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.holding_account;
 SELECT * INTO b FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.academy_account;
 SELECT h.hub_id,h.version,v.active INTO m FROM public.finance_payment_methods h JOIN public.finance_payment_method_revisions v ON v.academy_id=h.academy_id AND v.method_id=h.id AND v.version=h.version WHERE h.academy_id=NEW.academy_id AND h.id=NEW.method_id;
 IF c.version IS DISTINCT FROM NEW.collector_version OR c.custody IS DISTINCT FROM 'third_party' OR c.hub_id IS DISTINCT FROM NEW.hub_id
  OR a.version IS DISTINCT FROM NEW.holding_version OR b.version IS DISTINCT FROM NEW.academy_version OR NOT a.active OR NOT b.active
  OR a.operational_role IS DISTINCT FROM 'collector_receivable' OR b.operational_role NOT IN ('cash','bank') OR a.currency_id IS DISTINCT FROM NEW.currency_id OR b.currency_id IS DISTINCT FROM NEW.currency_id OR a.unit_scale IS DISTINCT FROM NEW.unit_scale OR b.unit_scale IS DISTINCT FROM NEW.unit_scale
  OR(a.hub_id IS NOT NULL AND a.hub_id IS DISTINCT FROM c.hub_id) OR(b.hub_id IS NOT NULL AND b.hub_id IS DISTINCT FROM c.hub_id)
  OR m.version IS DISTINCT FROM NEW.method_version OR NOT m.active OR(m.hub_id IS NOT NULL AND m.hub_id IS DISTINCT FROM c.hub_id) THEN RAISE EXCEPTION 'REMITTANCE_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 SELECT * INTO funds FROM public.collector_fund_balance(NEW.collector_id,NEW.holding_account,NEW.posted_on);
 IF(NEW.direction='to_academy' AND(NEW.amount_minor>funds.current_minor OR NEW.amount_minor>funds.through_minor)) OR(NEW.direction='to_collector' AND(NEW.amount_minor> -funds.current_minor OR NEW.amount_minor> -funds.through_minor)) THEN RAISE EXCEPTION 'REMITTANCE_EXCEEDS_COLLECTOR_BALANCE' USING ERRCODE='23514';END IF;
 IF NEW.handled_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.people p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.handled_by AND p.kind='human' AND p.status='active') THEN RAISE EXCEPTION 'REMITTANCE_HANDLER_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.evidence_file IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.file_records f WHERE f.academy_id=NEW.academy_id AND f.id=NEW.evidence_file AND f.version=NEW.evidence_version AND f.domain='finance_private' AND NOT f.archived AND(f.anchor_kind='academy' OR(f.anchor_kind='hub' AND f.hub_id=NEW.hub_id))) THEN RAISE EXCEPTION 'REMITTANCE_EVIDENCE_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.id AND p.target_version=0 AND p.action='finance.remittance.record' AND p.privacy_capability='remittances.edit' AND p.status IN ('pending','applied')) THEN RAISE EXCEPTION 'REMITTANCE_APPROVAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER collector_remittance BEFORE INSERT OR UPDATE ON public.collector_remittances FOR EACH ROW EXECUTE FUNCTION public.guard_collector_remittance();
CREATE FUNCTION public.guard_remittance_journal_reversal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.reverses_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.collector_remittances r WHERE r.academy_id=NEW.academy_id AND r.id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.action='finance.remittance.reverse' AND p.target_id=NEW.id AND p.payload->>'remittanceId'=NEW.reverses_id::text) THEN RAISE EXCEPTION 'REMITTANCE_CORRECTION_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER remittance_journal_reversal BEFORE INSERT ON public.finance_journals FOR EACH ROW EXECUTE FUNCTION public.guard_remittance_journal_reversal();
CREATE FUNCTION public.check_remittance_posting() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE j record;r record;BEGIN
 IF TG_TABLE_NAME='collector_remittance_reversals' THEN
  SELECT * INTO r FROM public.collector_remittances WHERE academy_id=NEW.academy_id AND id=NEW.remittance_id;
  IF r.reversal_id IS DISTINCT FROM NEW.id OR NOT EXISTS(SELECT 1 FROM public.finance_journals h WHERE h.academy_id=NEW.academy_id AND h.id=NEW.id AND h.reverses_id=NEW.remittance_id AND h.approval_id=NEW.approval_id AND h.posted_on>=r.posted_on)
   OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.id AND p.target_version=0 AND p.action='finance.remittance.reverse' AND p.privacy_capability='remittances.edit' AND p.status IN ('pending','applied') AND p.payload->>'remittanceId'=NEW.remittance_id::text) THEN RAISE EXCEPTION 'REMITTANCE_CORRECTION_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;
 END IF;
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF j.id IS NULL OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.posted_on IS DISTINCT FROM NEW.posted_on OR j.period_id IS DISTINCT FROM NEW.period_id OR j.period_version IS DISTINCT FROM NEW.period_version OR j.purpose<>'activity' OR j.reverses_id IS NOT NULL OR j.line_count<>2
  OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines l WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.id AND l.line_number=1 AND l.account_id=NEW.academy_account AND l.account_version=NEW.academy_version AND l.side=CASE WHEN NEW.direction='to_academy' THEN 'debit' ELSE 'credit' END AND l.amount_minor=NEW.amount_minor)
  OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines l WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.id AND l.line_number=2 AND l.account_id=NEW.holding_account AND l.account_version=NEW.holding_version AND l.side=CASE WHEN NEW.direction='to_academy' THEN 'credit' ELSE 'debit' END AND l.amount_minor=NEW.amount_minor) THEN RAISE EXCEPTION 'REMITTANCE_POSTING_INVALID' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER remittance_posting_complete AFTER INSERT ON public.collector_remittances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_remittance_posting();
CREATE CONSTRAINT TRIGGER remittance_reversal_complete AFTER INSERT ON public.collector_remittance_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_remittance_posting();
REVOKE ALL ON FUNCTION public.lock_collector_funds(uuid,uuid),public.guard_receipt_collector_funds(),public.collector_fund_balance(uuid,uuid,date),public.guard_collector_remittance(),public.guard_remittance_journal_reversal(),public.check_remittance_posting() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_collector_funds(uuid,uuid),public.collector_fund_balance(uuid,uuid,date) TO kavosh_runtime;
GRANT SELECT ON public.collector_remittances,public.collector_remittance_reversals,public.collector_fund_events TO kavosh_runtime;
GRANT INSERT ON public.collector_remittances,public.collector_remittance_reversals TO kavosh_runtime;
GRANT UPDATE(reversal_id) ON public.collector_remittances TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 47 $$;

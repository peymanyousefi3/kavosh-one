INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('bank-reconciliations.view','View retained reviewed bank reconciliation records','Finance',true,ARRAY['hub','country','region','city']),
 ('bank-reconciliations.edit','Request reviewed reconciliation, replacement or void','Finance',true,ARRAY['hub','country','region','city']);
-- Shared bounded monotonic stamp: source rows are immutable/complete after
-- commit, all corrections append, and account revisions strictly increase.
CREATE FUNCTION public.reconciliation_source_stamp(account uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('accountVersion',(SELECT version FROM public.finance_accounts WHERE id=account),
 'imports',(SELECT count(*)::text FROM public.finance_statement_imports WHERE account_id=account),
 'voids',(SELECT count(*)::text FROM public.finance_statement_voids v JOIN public.finance_statement_imports i ON i.academy_id=v.academy_id AND i.id=v.import_id WHERE i.account_id=account),
 'lines',(SELECT count(*)::text FROM public.finance_journal_lines WHERE account_id=account),
 'groups',(SELECT count(*)::text FROM public.finance_statement_matches WHERE account_id=account),
 'releases',(SELECT count(*)::text FROM public.finance_statement_match_releases r JOIN public.finance_statement_matches m ON m.academy_id=r.academy_id AND m.id=r.match_id WHERE m.account_id=account))
$$;
CREATE FUNCTION public.reconciliation_observation_stamp(account uuid,opening uuid,closing uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]'::jsonb) FROM(
 SELECT o.id,o.as_of::text,o.state,o.balance_minor::text,o.normal_balance,o.currency_id,o.unit_scale,(SELECT c.id FROM public.finance_balance_observations c WHERE c.supersedes_id=o.id) AS superseded_by
 FROM public.finance_balance_observations o WHERE o.account_id=account AND o.id IN(opening,closing)) o
$$;
REVOKE ALL ON FUNCTION public.reconciliation_source_stamp(uuid),public.reconciliation_observation_stamp(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconciliation_source_stamp(uuid),public.reconciliation_observation_stamp(uuid,uuid,uuid) TO kavosh_runtime;
CREATE TABLE public.finance_reconciliations(
 academy_id uuid NOT NULL,id uuid NOT NULL,account_id uuid NOT NULL,account_version integer NOT NULL,currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),
 starts_on date NOT NULL,through date NOT NULL,state text NOT NULL CHECK(state IN('finalized','void')),supersedes_id uuid,
 source_snapshot text,report jsonb,coverage_attestation text,outstanding jsonb NOT NULL DEFAULT '[]',reference text NOT NULL CHECK(length(reference)<=200),
 approval_id uuid NOT NULL,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,id,account_id,through),UNIQUE(academy_id,supersedes_id),
 CHECK(starts_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND through BETWEEN starts_on AND DATE '9999-12-31'),
 CHECK(jsonb_typeof(outstanding)='array' AND jsonb_array_length(outstanding)<=1000),
 CHECK((state='finalized' AND source_snapshot IS NOT NULL AND source_snapshot~'^[a-f0-9]{64}$' AND report IS NOT NULL AND jsonb_typeof(report)='object' AND octet_length(report::text)<=8388608 AND coverage_attestation IS NOT NULL AND length(coverage_attestation) BETWEEN 1 AND 2000)
  OR(state='void' AND supersedes_id IS NOT NULL AND source_snapshot IS NULL AND report IS NULL AND coverage_attestation IS NULL AND outstanding='[]'::jsonb)),
 FOREIGN KEY(academy_id,account_id,account_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),
 FOREIGN KEY(academy_id,supersedes_id,account_id,through) REFERENCES public.finance_reconciliations(academy_id,id,account_id,through),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE UNIQUE INDEX reconciliation_root ON public.finance_reconciliations(academy_id,account_id,through) WHERE supersedes_id IS NULL;
CREATE INDEX reconciliation_account_date ON public.finance_reconciliations(academy_id,account_id,through,id);
ALTER TABLE public.finance_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.finance_reconciliations USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT,INSERT ON public.finance_reconciliations TO kavosh_runtime;
CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.finance_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write();
CREATE FUNCTION public.reconciliation_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE hub uuid;BEGIN
 SELECT a.hub_id INTO hub FROM public.finance_accounts a WHERE a.academy_id=NEW.academy_id AND a.id=(NEW.payload->>'accountId')::uuid;
 IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('accounts.view',ARRAY[hub]),public.approval_hub_binding('bank-reconciliations.view',ARRAY[hub]),public.approval_hub_binding('financial-reports.view',ARRAY[hub]),public.approval_hub_binding('ledger.view',ARRAY[hub]),public.approval_hub_binding('bank-statements.view',ARRAY[hub]),public.approval_hub_binding('bank-matches.view',ARRAY[hub]),public.approval_hub_binding('bank-balances.view',ARRAY[hub]));END IF;RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='finance.reconciliation.record') EXECUTE FUNCTION public.reconciliation_privacy();
CREATE FUNCTION public.guard_reconciliation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a record;p record;prior record;opening record;closing record;facts record;r jsonb;bank_open numeric;bank_close numeric;x jsonb;BEGIN
 IF NOT public.finance_book_is_exclusive() THEN RAISE EXCEPTION 'FINANCE_EXCLUSIVE_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.account_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF a.id IS NULL OR a.version IS DISTINCT FROM NEW.account_version OR a.currency_id IS DISTINCT FROM NEW.currency_id OR a.unit_scale IS DISTINCT FROM NEW.unit_scale THEN RAISE EXCEPTION 'RECONCILIATION_ACCOUNT_CHANGED' USING ERRCODE='23514';END IF;
 IF p.id IS NULL OR p.status<>'pending' OR p.action<>'finance.reconciliation.record' OR p.privacy_capability IS DISTINCT FROM 'bank-reconciliations.edit' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0
 OR(p.payload->>'accountId')::uuid IS DISTINCT FROM NEW.account_id OR(p.payload->>'accountVersion')::integer IS DISTINCT FROM NEW.account_version
 OR(p.payload->>'from')::date IS DISTINCT FROM NEW.starts_on OR(p.payload->>'through')::date IS DISTINCT FROM NEW.through OR p.payload->>'state' IS DISTINCT FROM NEW.state
 OR(p.payload->>'supersedesId')::uuid IS DISTINCT FROM NEW.supersedes_id OR p.payload->>'reference' IS DISTINCT FROM NEW.reference
 THEN RAISE EXCEPTION 'RECONCILIATION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.supersedes_id IS NOT NULL THEN
  SELECT * INTO prior FROM public.finance_reconciliations WHERE academy_id=NEW.academy_id AND id=NEW.supersedes_id;
  IF prior.id IS NULL OR prior.account_id<>NEW.account_id OR prior.through<>NEW.through OR EXISTS(SELECT 1 FROM public.finance_reconciliations c WHERE c.academy_id=NEW.academy_id AND c.supersedes_id=prior.id)
   OR(NEW.state='void' AND(prior.state='void' OR NEW.starts_on<>prior.starts_on)) THEN RAISE EXCEPTION 'RECONCILIATION_PRIOR_CHANGED' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.state='void' THEN RETURN NEW;END IF;
 r=NEW.report;
 IF NOT a.active OR a.operational_role NOT IN('cash','bank','credit_card') OR NEW.through>(clock_timestamp() AT TIME ZONE 'UTC'+interval '14 hours')::date
 OR r IS DISTINCT FROM p.review_context->'report' OR NEW.outstanding IS DISTINCT FROM p.payload->'outstanding' OR NEW.coverage_attestation IS DISTINCT FROM p.payload->>'coverageAttestation'
 OR NEW.source_snapshot IS DISTINCT FROM p.payload->>'snapshot' OR r->>'snapshot' IS DISTINCT FROM NEW.source_snapshot OR r->>'accountId' IS DISTINCT FROM NEW.account_id::text
 OR r->>'from' IS DISTINCT FROM NEW.starts_on::text OR r->>'through' IS DISTINCT FROM NEW.through::text OR r->>'currencyId' IS DISTINCT FROM NEW.currency_id::text OR(r->>'unitScale')::integer IS DISTINCT FROM NEW.unit_scale
 OR r->'sourceStamp' IS DISTINCT FROM public.reconciliation_source_stamp(NEW.account_id)
 OR r->'observationSourceStamp' IS DISTINCT FROM public.reconciliation_observation_stamp(NEW.account_id,(p.payload->>'openingObservationId')::uuid,(p.payload->>'closingObservationId')::uuid)
 THEN RAISE EXCEPTION 'RECONCILIATION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 SELECT * INTO opening FROM public.finance_balance_observations WHERE academy_id=NEW.academy_id AND id=(p.payload->>'openingObservationId')::uuid;
 SELECT * INTO closing FROM public.finance_balance_observations WHERE academy_id=NEW.academy_id AND id=(p.payload->>'closingObservationId')::uuid;
 IF opening.id IS NULL OR closing.id IS NULL OR opening.account_id<>NEW.account_id OR closing.account_id<>NEW.account_id OR opening.state<>'recorded' OR closing.state<>'recorded'
 OR opening.as_of<>NEW.starts_on-1 OR closing.as_of<>NEW.through OR opening.currency_id<>NEW.currency_id OR closing.currency_id<>NEW.currency_id OR opening.unit_scale<>NEW.unit_scale OR closing.unit_scale<>NEW.unit_scale
 OR EXISTS(SELECT 1 FROM public.finance_balance_observations o WHERE o.academy_id=NEW.academy_id AND o.supersedes_id IN(opening.id,closing.id))
 THEN RAISE EXCEPTION 'RECONCILIATION_OBSERVATIONS_INVALID' USING ERRCODE='23514';END IF;
 bank_open=opening.balance_minor*CASE WHEN opening.normal_balance='credit' THEN -1 ELSE 1 END;bank_close=closing.balance_minor*CASE WHEN closing.normal_balance='credit' THEN -1 ELSE 1 END;
 -- Native cutoff membership and exact sums do not trust JSON review flags.
 WITH complete_groups AS MATERIALIZED(
  SELECT m.id FROM public.finance_statement_matches m WHERE m.academy_id=NEW.academy_id AND m.account_id=NEW.account_id
  AND NOT EXISTS(SELECT 1 FROM public.finance_statement_match_releases v WHERE v.academy_id=m.academy_id AND v.match_id=m.id)
  AND NOT EXISTS(SELECT 1 FROM public.finance_statement_match_rows x JOIN public.finance_statement_rows s ON s.academy_id=x.academy_id AND s.import_id=x.import_id AND s.line=x.line WHERE x.academy_id=m.academy_id AND x.match_id=m.id AND s.posted_on>NEW.through)
  AND NOT EXISTS(SELECT 1 FROM public.finance_statement_match_lines x JOIN public.finance_journals j ON j.academy_id=x.academy_id AND j.id=x.journal_id WHERE x.academy_id=m.academy_id AND x.match_id=m.id AND j.posted_on>NEW.through)
 ),bank AS MATERIALIZED(
  SELECT s.*,EXISTS(SELECT 1 FROM public.finance_statement_match_rows x JOIN complete_groups g ON g.id=x.match_id WHERE x.academy_id=s.academy_id AND x.import_id=s.import_id AND x.line=s.line) AS matched
  FROM public.finance_statement_rows s WHERE s.academy_id=NEW.academy_id AND s.account_id=NEW.account_id AND s.posted_on<=NEW.through
  AND NOT EXISTS(SELECT 1 FROM public.finance_statement_voids v WHERE v.academy_id=s.academy_id AND v.import_id=s.import_id)
 ),book AS MATERIALIZED(
  SELECT l.*,j.posted_on,j.purpose,CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END AS debit_net,
  EXISTS(SELECT 1 FROM public.finance_statement_match_lines x JOIN complete_groups g ON g.id=x.match_id WHERE x.academy_id=l.academy_id AND x.journal_id=l.journal_id AND x.line_number=l.line_number) AS matched
  FROM public.finance_journal_lines l JOIN LATERAL(SELECT h.id,h.posted_on,h.purpose FROM public.finance_journals h WHERE h.academy_id=l.academy_id AND h.id=l.journal_id OFFSET 0) j ON true WHERE l.academy_id=NEW.academy_id AND l.account_id=NEW.account_id AND j.posted_on<=NEW.through
 ),expected_outstanding AS(
  SELECT journal_id,line_number,CASE WHEN a.operational_role='credit_card' THEN CASE WHEN debit_net>0 THEN 'card_payment_in_transit' ELSE 'card_charge_pending' END ELSE CASE WHEN debit_net>0 THEN 'deposit_in_transit' ELSE 'outstanding_payment' END END AS kind FROM book WHERE purpose='activity' AND NOT matched
 ) SELECT
 (SELECT count(*) FROM bank) AS bank_count,(SELECT count(*) FROM book) AS book_count,
 (SELECT count(*) FROM bank WHERE NOT matched) AS bank_unmatched,
 (SELECT count(*) FROM book b WHERE purpose='legacy_unclassified' OR(purpose<>'activity' AND EXISTS(SELECT 1 FROM public.finance_statement_match_lines x WHERE x.academy_id=b.academy_id AND x.journal_id=b.journal_id AND x.line_number=b.line_number AND NOT EXISTS(SELECT 1 FROM public.finance_statement_match_releases v WHERE v.academy_id=x.academy_id AND v.match_id=x.match_id)))) AS blockers,
 (SELECT coalesce(sum(debit_net_minor) FILTER(WHERE posted_on>=NEW.starts_on),0) FROM bank) AS bank_period,
 (SELECT coalesce(sum(debit_net),0) FROM book) AS book_close,
 (SELECT coalesce(sum(debit_net) FILTER(WHERE posted_on<NEW.starts_on),0) FROM book) AS book_open,
 (SELECT coalesce(sum(amount_minor) FILTER(WHERE posted_on>=NEW.starts_on AND side='debit'),0) FROM book) AS book_debits,
 (SELECT coalesce(sum(amount_minor) FILTER(WHERE posted_on>=NEW.starts_on AND side='credit'),0) FROM book) AS book_credits,
 (SELECT coalesce(sum(debit_net) FILTER(WHERE purpose='activity' AND NOT matched),0) FROM book) AS book_outstanding,
 (SELECT count(*) FROM expected_outstanding) AS outstanding_count,
 EXISTS(SELECT journal_id,line_number,kind FROM expected_outstanding EXCEPT SELECT (o->>'journalId')::uuid,(o->>'lineNumber')::integer,o->>'kind' FROM jsonb_array_elements(NEW.outstanding) o) AS outstanding_missing,
 EXISTS(SELECT import_id,line,posted_on::text,debit_net_minor,description,reference FROM bank EXCEPT SELECT (b->>'importId')::uuid,(b->>'line')::integer,b->>'postedOn',(b->'debitNet'->>'minor')::numeric,b->>'description',b->>'reference' FROM jsonb_array_elements(r->'statementItems') b) AS bank_missing,
 EXISTS(SELECT journal_id,line_number,posted_on::text,debit_net,purpose,account_version FROM book EXCEPT SELECT (b->>'journalId')::uuid,(b->>'lineNumber')::integer,b->>'postedOn',(b->'debitNet'->>'minor')::numeric,b->>'purpose',(b->>'accountVersion')::integer FROM jsonb_array_elements(r->'ledgerItems') b) AS book_missing
 INTO facts;
 IF facts.bank_count>1000 OR facts.book_count>1000 OR facts.bank_unmatched<>0 OR facts.blockers<>0 OR bank_close-bank_open<>facts.bank_period OR bank_close+facts.book_outstanding<>facts.book_close
 OR facts.bank_missing OR facts.book_missing OR facts.outstanding_missing OR jsonb_array_length(r->'statementItems') IS DISTINCT FROM facts.bank_count OR jsonb_array_length(r->'ledgerItems') IS DISTINCT FROM facts.book_count
 OR jsonb_array_length(NEW.outstanding) IS DISTINCT FROM facts.outstanding_count
 OR(SELECT count(DISTINCT jsonb_build_array(o->'journalId',o->'lineNumber')) FROM jsonb_array_elements(NEW.outstanding) o)<>facts.outstanding_count
 OR(r->'ledger'->'closing'->>'minor')::numeric IS DISTINCT FROM facts.book_close OR(r->'statement'->'periodNet'->>'minor')::numeric IS DISTINCT FROM facts.bank_period
 OR(r->'ledger'->'opening'->>'minor')::numeric IS DISTINCT FROM facts.book_open OR(r->'ledger'->'movement'->>'minor')::numeric IS DISTINCT FROM facts.book_close-facts.book_open
 OR(r->'ledger'->'debits'->>'minor')::numeric IS DISTINCT FROM facts.book_debits OR(r->'ledger'->'credits'->>'minor')::numeric IS DISTINCT FROM facts.book_credits
 OR(r->'statement'->>'totalCount')::integer IS DISTINCT FROM facts.bank_count OR(r->'statement'->>'matchedCount')::integer IS DISTINCT FROM facts.bank_count
 OR(r->'statement'->>'unmatchedCount')::integer IS DISTINCT FROM 0 OR(r->'statement'->>'cutoffPendingCount')::integer IS DISTINCT FROM 0 OR(r->'statement'->'unresolvedNet'->>'minor')::numeric IS DISTINCT FROM 0
 OR(r->'bookTransactions'->>'totalCount')::integer IS DISTINCT FROM facts.book_count
 OR(r->'bookTransactions'->'unresolvedNet'->>'minor')::numeric IS DISTINCT FROM facts.book_outstanding
 OR(r->'openingObservation'->>'id') IS DISTINCT FROM opening.id::text OR(r->'closingObservation'->>'id') IS DISTINCT FROM closing.id::text
 OR(r->'openingObservation'->'debitNet'->>'minor')::numeric IS DISTINCT FROM bank_open OR(r->'closingObservation'->'debitNet'->>'minor')::numeric IS DISTINCT FROM bank_close
 OR(r->'comparison'->'closingDifference'->>'minor')::numeric IS DISTINCT FROM bank_close-facts.book_close
 OR(r->'comparison'->'provisionalAdjustedBank'->>'minor')::numeric IS DISTINCT FROM facts.book_close OR(r->'comparison'->'provisionalAdjustedBook'->>'minor')::numeric IS DISTINCT FROM facts.book_close
 OR(r->'comparison'->'provisionalResidual'->>'minor')::numeric IS DISTINCT FROM 0 OR(r->'comparison'->'statementPeriodMovementDifference'->>'minor')::numeric IS DISTINCT FROM 0
 OR r->'review'->'finalized' IS DISTINCT FROM 'true'::jsonb OR r->'review'->'reconciled' IS DISTINCT FROM 'true'::jsonb OR r->'review'->'externallyVerified' IS DISTINCT FROM 'false'::jsonb
 OR r->'review'->'statementCoverageVerified' IS DISTINCT FROM 'false'::jsonb OR r->'review'->'statementCoverageAttested' IS DISTINCT FROM 'true'::jsonb
 THEN RAISE EXCEPTION 'RECONCILIATION_INCOMPLETE_OR_UNBALANCED' USING ERRCODE='23514';END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(NEW.outstanding) LOOP
  IF jsonb_typeof(x->'reason') IS DISTINCT FROM 'string' OR length(btrim(x->>'reason')) NOT BETWEEN 1 AND 1000 OR x-ARRAY['journalId','lineNumber','kind','reason']<>'{}'::jsonb THEN RAISE EXCEPTION 'RECONCILIATION_OUTSTANDING_INVALID' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_guard BEFORE INSERT ON public.finance_reconciliations FOR EACH ROW EXECUTE FUNCTION public.guard_reconciliation();
CREATE CONSTRAINT TRIGGER reconciliation_reviewed AFTER INSERT ON public.finance_reconciliations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
REVOKE ALL ON FUNCTION public.reconciliation_privacy(),public.guard_reconciliation() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 68 $$;

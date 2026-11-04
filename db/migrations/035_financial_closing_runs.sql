INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('closing.edit','Request complete school financial closing runs and formal reopen','Finance',true,'{}');
CREATE FUNCTION public.finance_book_is_exclusive() RETURNS boolean LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_locks l WHERE l.locktype='advisory' AND l.pid=pg_backend_pid() AND l.granted AND l.mode='ExclusiveLock'
  AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.objsubid=1
  AND l.classid=((hashtextextended(nullif(current_setting('app.academy_id',true),''),10)>>32)&4294967295)::oid
  AND l.objid=(hashtextextended(nullif(current_setting('app.academy_id',true),''),10)&4294967295)::oid)
$$;
REVOKE ALL ON FUNCTION public.finance_book_is_exclusive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_book_is_exclusive() TO kavosh_runtime;
CREATE TABLE public.finance_closing_runs(
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,period_id uuid NOT NULL,open_period_version integer NOT NULL CHECK(open_period_version>0),
 period_state text NOT NULL DEFAULT 'open' CHECK(period_state='open'),through date NOT NULL,
 source_snapshot text NOT NULL CHECK(source_snapshot~'^[a-f0-9]{64}$'),source_stamp jsonb NOT NULL,
 equity_mappings jsonb NOT NULL CHECK(jsonb_typeof(equity_mappings)='array' AND jsonb_array_length(equity_mappings)<=1000),
 journal_count integer NOT NULL CHECK(journal_count BETWEEN 0 AND 1000),pair_count integer NOT NULL CHECK(pair_count BETWEEN 0 AND 100000),
 created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),approval_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,period_id,open_period_version),
 FOREIGN KEY(academy_id,period_id,open_period_version,period_state) REFERENCES public.finance_period_revisions(academy_id,period_id,version,state),
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.finance_closing_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_closing_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.finance_closing_runs
 USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.finance_closing_runs TO kavosh_runtime;
GRANT INSERT(academy_id,id,period_id,open_period_version,through,source_snapshot,source_stamp,equity_mappings,journal_count,pair_count,created_by,approval_id,reason) ON public.finance_closing_runs TO kavosh_runtime;
CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.finance_closing_runs FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write();
ALTER TABLE public.finance_periods ADD COLUMN active_closing_run_id uuid,
 ADD FOREIGN KEY(academy_id,active_closing_run_id) REFERENCES public.finance_closing_runs(academy_id,id) DEFERRABLE INITIALLY DEFERRED;
GRANT UPDATE(active_closing_run_id) ON public.finance_periods TO kavosh_runtime;
CREATE INDEX finance_periods_active_closing ON public.finance_periods(academy_id,ends_on DESC) WHERE active_closing_run_id IS NOT NULL AND state='closed';
CREATE OR REPLACE VIEW public.finance_period_catalogue WITH(security_invoker=true) AS
 SELECT p.academy_id,p.id,p.starts_on,p.ends_on,p.state,p.version,p.created_by,p.created_at,r.name,r.translations,r.created_at AS revised_at,p.active_closing_run_id
 FROM public.finance_periods p JOIN public.finance_period_revisions r ON r.academy_id=p.academy_id AND r.period_id=p.id AND r.version=p.version AND r.state=p.state;
ALTER TABLE public.finance_journals ADD COLUMN closing_run_id uuid,
 ADD FOREIGN KEY(academy_id,closing_run_id) REFERENCES public.finance_closing_runs(academy_id,id);
GRANT INSERT(closing_run_id) ON public.finance_journals TO kavosh_runtime;
CREATE INDEX finance_journals_closing_run ON public.finance_journals(academy_id,closing_run_id,id) WHERE closing_run_id IS NOT NULL;
CREATE FUNCTION public.guard_financial_close_header() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;stamp jsonb;encoded text;m jsonb; BEGIN
 IF NOT public.finance_book_is_exclusive() THEN RAISE EXCEPTION 'FINANCE_EXCLUSIVE_REQUIRED' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM public.finance_periods WHERE academy_id=NEW.academy_id AND id=NEW.period_id;
 IF p.id IS NULL OR p.state<>'open' OR p.version<>NEW.open_period_version OR p.ends_on<>NEW.through THEN RAISE EXCEPTION 'FINANCE_CLOSE_PERIOD_CHANGED' USING ERRCODE='23514'; END IF;
 SELECT jsonb_build_object('journals',(SELECT count(*)::text FROM public.finance_journals WHERE academy_id=NEW.academy_id AND posted_on<=NEW.through),
  'chartVersions',(SELECT coalesce(sum(version),0)::text FROM public.finance_accounts WHERE academy_id=NEW.academy_id),
  'periodVersions',(SELECT coalesce(sum(version),0)::text FROM public.finance_periods WHERE academy_id=NEW.academy_id)) INTO stamp;
 IF NEW.source_stamp IS DISTINCT FROM stamp THEN RAISE EXCEPTION 'FINANCE_CLOSE_SOURCE_CHANGED' USING ERRCODE='23514'; END IF;
 encoded:=format('[1,%s,%s,%s,"open",%s,%s,{"journals":%s,"chartVersions":%s,"periodVersions":%s}]',to_json(NEW.academy_id::text),to_json(NEW.period_id::text),p.version,to_json(p.starts_on::text),to_json(p.ends_on::text),to_json(stamp->>'journals'),to_json(stamp->>'chartVersions'),to_json(stamp->>'periodVersions'));
 IF encode(sha256(convert_to(encoded,'UTF8')),'hex')<>NEW.source_snapshot THEN RAISE EXCEPTION 'FINANCE_CLOSE_SNAPSHOT_INVALID' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.finance_journals WHERE academy_id=NEW.academy_id AND posted_on<=NEW.through AND purpose='legacy_unclassified')
 OR EXISTS(SELECT 1 FROM public.finance_periods WHERE academy_id=NEW.academy_id AND id<>NEW.period_id AND state='open' AND starts_on<=NEW.through)
 OR EXISTS(SELECT 1 FROM public.finance_periods WHERE academy_id=NEW.academy_id AND state='closed' AND active_closing_run_id IS NOT NULL AND ends_on>=NEW.through)
 THEN RAISE EXCEPTION 'FINANCE_CLOSE_SOURCE_BLOCKED' USING ERRCODE='23514'; END IF;
 FOR m IN SELECT value FROM jsonb_array_elements(NEW.equity_mappings) LOOP
  IF jsonb_typeof(m)<>'object' OR m-ARRAY['currencyId','sourceHubId','accountId','accountVersion']<>'{}'::jsonb OR NOT(m ?& ARRAY['currencyId','sourceHubId','accountId','accountVersion'])
   OR NOT EXISTS(SELECT 1 FROM public.finance_account_catalogue a WHERE a.academy_id=NEW.academy_id AND a.id=(m->>'accountId')::uuid AND a.version=(m->>'accountVersion')::integer AND a.currency_id=(m->>'currencyId')::uuid AND a.kind='equity' AND a.active)
  THEN RAISE EXCEPTION 'FINANCE_CLOSE_MAPPING_INVALID' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(m->'sourceHubId') NOT IN ('null','string') OR(m->>'sourceHubId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.hubs WHERE academy_id=NEW.academy_id AND id=(m->>'sourceHubId')::uuid)) THEN RAISE EXCEPTION 'FINANCE_CLOSE_MAPPING_INVALID' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF(SELECT count(*) FROM jsonb_array_elements(NEW.equity_mappings))<>(SELECT count(DISTINCT jsonb_build_array(value->'currencyId',value->'sourceHubId')) FROM jsonb_array_elements(NEW.equity_mappings)) THEN RAISE EXCEPTION 'FINANCE_CLOSE_MAPPING_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_financial_close_header() FROM PUBLIC;
CREATE TRIGGER finance_closing_header BEFORE INSERT ON public.finance_closing_runs FOR EACH ROW EXECUTE FUNCTION public.guard_financial_close_header();
CREATE FUNCTION public.guard_period_financial_close() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF OLD.active_closing_run_id IS NOT NULL THEN
  IF OLD.state='closed' AND NEW.state='open' THEN NEW.active_closing_run_id:=NULL;
  ELSIF NEW.active_closing_run_id IS DISTINCT FROM OLD.active_closing_run_id OR NEW.state<>'closed' THEN RAISE EXCEPTION 'FINANCE_CLOSE_REOPEN_REQUIRED' USING ERRCODE='23514'; END IF;
 ELSIF NEW.active_closing_run_id IS NOT NULL THEN
  IF NOT public.finance_book_is_exclusive() OR NEW.state<>'closed' OR NEW.version<>OLD.version+1 OR NOT EXISTS(SELECT 1 FROM public.finance_closing_runs r WHERE r.academy_id=NEW.academy_id AND r.id=NEW.active_closing_run_id AND r.period_id=NEW.id AND r.open_period_version=OLD.version)
  THEN RAISE EXCEPTION 'FINANCE_CLOSE_ACTIVATION_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_period_financial_close() FROM PUBLIC;
CREATE TRIGGER finance_period_closing BEFORE UPDATE ON public.finance_periods FOR EACH ROW EXECUTE FUNCTION public.guard_period_financial_close();
CREATE FUNCTION public.guard_closed_financial_frontier() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record; BEGIN
 IF EXISTS(SELECT 1 FROM public.finance_periods WHERE academy_id=NEW.academy_id AND active_closing_run_id IS NOT NULL AND state='closed' AND ends_on>=NEW.posted_on) THEN RAISE EXCEPTION 'FINANCE_CLOSED_THROUGH' USING ERRCODE='23514'; END IF;
 IF NEW.closing_run_id IS NOT NULL THEN
  SELECT * INTO r FROM public.finance_closing_runs WHERE academy_id=NEW.academy_id AND id=NEW.closing_run_id;
  IF r.id IS NULL OR NOT public.finance_book_is_exclusive() OR NEW.period_id<>r.period_id OR NEW.period_version<>r.open_period_version OR NEW.posted_on<>r.through OR NEW.approval_id<>r.approval_id OR NEW.posted_by<>r.created_by OR NEW.purpose<>'closing' OR NEW.reverses_id IS NOT NULL OR NEW.line_count%2<>0 THEN RAISE EXCEPTION 'FINANCE_CLOSE_JOURNAL_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_closed_financial_frontier() FROM PUBLIC;
CREATE TRIGGER finance_closed_frontier BEFORE INSERT ON public.finance_journals FOR EACH ROW EXECUTE FUNCTION public.guard_closed_financial_frontier();
CREATE FUNCTION public.validate_financial_close() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.finance_periods p JOIN public.finance_period_revisions v ON v.academy_id=p.academy_id AND v.period_id=p.id AND v.version=p.version WHERE p.academy_id=NEW.academy_id AND p.id=NEW.period_id AND p.state='closed' AND p.version=NEW.open_period_version+1 AND p.active_closing_run_id=NEW.id AND v.approval_id=NEW.approval_id)
 OR(SELECT count(*) FROM public.finance_journals WHERE academy_id=NEW.academy_id AND closing_run_id=NEW.id)<>NEW.journal_count
 OR(SELECT count(*) FROM public.finance_journal_lines l JOIN public.finance_journals j ON j.academy_id=l.academy_id AND j.id=l.journal_id WHERE j.academy_id=NEW.academy_id AND j.closing_run_id=NEW.id)<>NEW.pair_count*2
 THEN RAISE EXCEPTION 'FINANCE_CLOSE_INCOMPLETE' USING ERRCODE='23514'; END IF;
 IF(SELECT count(*)-NEW.journal_count FROM public.finance_journals WHERE academy_id=NEW.academy_id AND posted_on<=NEW.through)<>(NEW.source_stamp->>'journals')::numeric
 OR(SELECT coalesce(sum(version),0) FROM public.finance_accounts WHERE academy_id=NEW.academy_id)<>(NEW.source_stamp->>'chartVersions')::numeric
 OR(SELECT coalesce(sum(version),0)-1 FROM public.finance_periods WHERE academy_id=NEW.academy_id)<>(NEW.source_stamp->>'periodVersions')::numeric
 THEN RAISE EXCEPTION 'FINANCE_CLOSE_SOURCE_CHANGED' USING ERRCODE='23514'; END IF;
 IF EXISTS(
  WITH mappings AS MATERIALIZED(SELECT value AS m,jsonb_build_array(value->'currencyId',value->'sourceHubId') AS key FROM jsonb_array_elements(NEW.equity_mappings))
  SELECT 1 FROM public.finance_journals j
  JOIN public.finance_journal_lines t ON t.academy_id=j.academy_id AND t.journal_id=j.id AND t.line_number%2=1
  JOIN public.finance_journal_lines e ON e.academy_id=t.academy_id AND e.journal_id=t.journal_id AND e.line_number=t.line_number+1
  JOIN public.finance_account_catalogue ta ON ta.academy_id=t.academy_id AND ta.id=t.account_id
  JOIN public.finance_account_catalogue ea ON ea.academy_id=e.academy_id AND ea.id=e.account_id
  LEFT JOIN mappings m ON m.key=jsonb_build_array(ta.currency_id,ta.hub_id)
  WHERE j.academy_id=NEW.academy_id AND j.closing_run_id=NEW.id AND
   (ta.kind NOT IN ('income','expense') OR ea.kind<>'equity' OR ta.currency_id<>ea.currency_id OR t.side=e.side OR m.m IS NULL OR e.account_id<>(m.m->>'accountId')::uuid OR e.account_version<>(m.m->>'accountVersion')::integer
    OR t.amount_minor*('1'||repeat('0',18-ta.unit_scale))::numeric<>e.amount_minor*('1'||repeat('0',18-ea.unit_scale))::numeric)
 ) THEN RAISE EXCEPTION 'FINANCE_CLOSE_PAIR_INVALID' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.finance_journal_lines l JOIN public.finance_journals j ON j.academy_id=l.academy_id AND j.id=l.journal_id JOIN public.finance_account_revisions r ON r.academy_id=l.academy_id AND r.account_id=l.account_id AND r.version=l.account_version
  WHERE j.academy_id=NEW.academy_id AND j.posted_on<=NEW.through AND r.kind IN ('income','expense') GROUP BY l.account_id,r.kind HAVING sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END)<>0)
 THEN RAISE EXCEPTION 'FINANCE_CLOSE_TEMPORARY_BALANCE' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.validate_financial_close() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER finance_closing_complete AFTER INSERT ON public.finance_closing_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_financial_close();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 35 $$;

INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('bank-balances.view','View manual treasury balance observations','Finance',true,ARRAY['hub','country','region','city']),
 ('bank-balances.edit','Request reviewed manual treasury balances and retained corrections','Finance',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.finance_balance_observations(
 academy_id uuid NOT NULL,id uuid NOT NULL,account_id uuid NOT NULL,account_version integer NOT NULL,
 currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),normal_balance text NOT NULL CHECK(normal_balance IN('debit','credit')),as_of date NOT NULL CHECK(as_of BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 state text NOT NULL CHECK(state IN('recorded','void')),balance_minor numeric CHECK(balance_minor=trunc(balance_minor) AND abs(balance_minor)<1e38),
 supersedes_id uuid,reference text NOT NULL CHECK(length(reference)<=200),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 approval_id uuid NOT NULL,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,id,account_id,as_of),UNIQUE(academy_id,supersedes_id),
 CHECK((state='recorded' AND balance_minor IS NOT NULL) OR(state='void' AND balance_minor IS NULL AND supersedes_id IS NOT NULL)),
 FOREIGN KEY(academy_id,account_id,account_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),
 FOREIGN KEY(academy_id,supersedes_id,account_id,as_of) REFERENCES public.finance_balance_observations(academy_id,id,account_id,as_of),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE UNIQUE INDEX balance_observation_root ON public.finance_balance_observations(academy_id,account_id,as_of) WHERE supersedes_id IS NULL;
CREATE INDEX balance_observation_account_date ON public.finance_balance_observations(academy_id,account_id,as_of,id);
ALTER TABLE public.finance_balance_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_balance_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.finance_balance_observations USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.finance_balance_observations FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write();
CREATE FUNCTION public.guard_balance_observation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;p record;prior record;amount numeric;BEGIN
 SELECT * INTO a FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.account_id;
 IF a.id IS NULL OR a.version IS DISTINCT FROM NEW.account_version OR a.currency_id IS DISTINCT FROM NEW.currency_id OR a.unit_scale IS DISTINCT FROM NEW.unit_scale OR a.normal_balance IS DISTINCT FROM NEW.normal_balance
 OR(NEW.state='recorded' AND(NOT a.active OR a.operational_role NOT IN('cash','bank','credit_card')))
 OR NEW.as_of>(clock_timestamp() AT TIME ZONE 'UTC'+interval '14 hours')::date THEN RAISE EXCEPTION 'BALANCE_OBSERVATION_ACCOUNT_OR_DATE_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.supersedes_id IS NOT NULL THEN
  SELECT * INTO prior FROM public.finance_balance_observations WHERE academy_id=NEW.academy_id AND id=NEW.supersedes_id;
  IF prior.id IS NULL OR prior.account_id<>NEW.account_id OR prior.as_of<>NEW.as_of OR EXISTS(SELECT 1 FROM public.finance_balance_observations x WHERE x.academy_id=NEW.academy_id AND x.supersedes_id=prior.id)
   OR(NEW.state='void' AND prior.state='void') THEN RAISE EXCEPTION 'BALANCE_OBSERVATION_PRIOR_CHANGED' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status<>'pending' OR p.action<>'finance.balance-observation.record' OR p.privacy_capability IS DISTINCT FROM 'bank-balances.edit' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0
 OR(p.payload->>'accountId')::uuid IS DISTINCT FROM NEW.account_id OR(p.payload->>'accountVersion')::integer IS DISTINCT FROM NEW.account_version
 OR(p.payload->>'asOf')::date IS DISTINCT FROM NEW.as_of OR p.payload->>'state' IS DISTINCT FROM NEW.state OR(p.payload->>'supersedesId')::uuid IS DISTINCT FROM NEW.supersedes_id
 OR p.payload->>'reference' IS DISTINCT FROM NEW.reference OR p.payload->>'reason' IS DISTINCT FROM NEW.reason THEN RAISE EXCEPTION 'BALANCE_OBSERVATION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.state='recorded' THEN
  IF jsonb_typeof(p.payload->'balance') IS DISTINCT FROM 'string' OR length(p.payload->>'balance')>80 OR(p.payload->>'balance')!~'^-?(0|[1-9][0-9]*)([.][0-9]+)?$' THEN RAISE EXCEPTION 'BALANCE_OBSERVATION_AMOUNT_INVALID' USING ERRCODE='23514';END IF;
  amount=(p.payload->>'balance')::numeric*power(10::numeric,NEW.unit_scale);
  IF amount<>trunc(amount) OR abs(amount)>=1e38 OR amount IS DISTINCT FROM NEW.balance_minor THEN RAISE EXCEPTION 'BALANCE_OBSERVATION_AMOUNT_INVALID' USING ERRCODE='23514';END IF;
 ELSIF p.payload->'balance' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'BALANCE_OBSERVATION_VOID_AMOUNT_INVALID' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER balance_observation_guard BEFORE INSERT ON public.finance_balance_observations FOR EACH ROW EXECUTE FUNCTION public.guard_balance_observation();
CREATE CONSTRAINT TRIGGER balance_observation_approval_complete AFTER INSERT ON public.finance_balance_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
REVOKE ALL ON FUNCTION public.guard_balance_observation() FROM PUBLIC;
GRANT SELECT,INSERT ON public.finance_balance_observations TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 65 $$;

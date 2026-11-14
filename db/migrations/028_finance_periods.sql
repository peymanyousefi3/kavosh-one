INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('periods.view','View accounting periods','Finance',true,'{}'),
 ('periods.edit','Request accounting period controls','Finance',true,'{}');
CREATE TABLE public.finance_periods (
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,
 starts_on date NOT NULL CHECK(starts_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 ends_on date NOT NULL CHECK(ends_on BETWEEN starts_on AND DATE '9999-12-31'),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed','void')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL,
 created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind),
 -- Both displayed end dates are inclusive. Adjacent periods may touch only
 -- at the next calendar day; native exclusion also covers concurrent inserts.
 EXCLUDE USING gist(academy_id WITH =,daterange(starts_on,ends_on,'[]') WITH &&) WHERE(state<>'void')
);
CREATE TABLE public.finance_period_revisions (
 academy_id uuid NOT NULL,period_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),state text NOT NULL CHECK(state IN ('open','closed','void')),
 translations jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(translations)='object' AND translations-ARRAY['en','fr','zh-CN']='{}'::jsonb),
 changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,period_id,version),UNIQUE(academy_id,period_id,version,state),
 FOREIGN KEY(academy_id,period_id) REFERENCES public.finance_periods(academy_id,id),
 FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.finance_periods ADD CONSTRAINT finance_period_current_revision FOREIGN KEY(academy_id,id,version,state)
 REFERENCES public.finance_period_revisions(academy_id,period_id,version,state) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_periods','finance_period_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE FUNCTION public.guard_finance_period() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.state<>'open' THEN RAISE EXCEPTION 'FINANCE_PERIOD_INITIAL_STATE' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.state='void' OR (NEW.state='void' AND OLD.state<>'closed') THEN RAISE EXCEPTION 'FINANCE_PERIOD_TRANSITION' USING ERRCODE='23514'; END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'FINANCE_VERSION_SEQUENCE' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_finance_period() FROM PUBLIC;
CREATE TRIGGER finance_period_version BEFORE INSERT OR UPDATE ON public.finance_periods FOR EACH ROW EXECUTE FUNCTION public.guard_finance_period();
CREATE FUNCTION public.guard_finance_period_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(NEW.translations) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(NEW.translations) label WHERE jsonb_typeof(label.value)<>'string' OR length(label.value#>>'{}') NOT BETWEEN 1 AND 200) THEN RAISE EXCEPTION 'FINANCE_TRANSLATIONS_INVALID' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.finance_periods p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.period_id AND p.version=NEW.version AND p.state=NEW.state) THEN RAISE EXCEPTION 'FINANCE_REVISION_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_finance_period_revision() FROM PUBLIC;
CREATE TRIGGER finance_period_revision BEFORE INSERT ON public.finance_period_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_finance_period_revision();
CREATE VIEW public.finance_period_catalogue WITH(security_invoker=true) AS
 SELECT p.academy_id,p.id,p.starts_on,p.ends_on,p.state,p.version,p.created_by,p.created_at,r.name,r.translations,r.created_at AS revised_at
 FROM public.finance_periods p JOIN public.finance_period_revisions r ON r.academy_id=p.academy_id AND r.period_id=p.id AND r.version=p.version AND r.state=p.state;
GRANT SELECT ON public.finance_periods,public.finance_period_revisions,public.finance_period_catalogue TO kavosh_runtime;
GRANT INSERT(academy_id,id,starts_on,ends_on,created_by) ON public.finance_periods TO kavosh_runtime;
GRANT UPDATE(version,state) ON public.finance_periods TO kavosh_runtime;
GRANT INSERT ON public.finance_period_revisions TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 28 $$;

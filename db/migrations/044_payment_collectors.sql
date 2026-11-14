INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('collectors.view','View permitted payment collectors','Finance',true,ARRAY['hub','country','region','city']),
 ('collectors.edit','Request reviewed payment collector changes','Finance',true,ARRAY['hub','country','region','city']);
ALTER TABLE public.finance_account_revisions DROP CONSTRAINT finance_account_revisions_operational_role_check;
ALTER TABLE public.finance_account_revisions DROP CONSTRAINT finance_account_operational_role;
ALTER TABLE public.finance_account_revisions ADD CONSTRAINT finance_account_revisions_operational_role_check CHECK(operational_role IN ('unclassified','cash','bank','receivable','collector_receivable','deferred_revenue','tax_payable','revenue','expense','other'));
ALTER TABLE public.finance_account_revisions ADD CONSTRAINT finance_account_operational_role CHECK(
 operational_role IN ('unclassified','other') OR (operational_role IN ('cash','bank','receivable','collector_receivable') AND kind='asset' AND normal_balance='debit')
 OR(operational_role IN ('deferred_revenue','tax_payable') AND kind='liability' AND normal_balance='credit') OR(operational_role='revenue' AND kind='income' AND normal_balance='credit') OR(operational_role='expense' AND kind='expense'));
CREATE TABLE public.finance_collectors(
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,hub_id uuid,person_id uuid,
 code text NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),kind text NOT NULL CHECK(kind IN ('academy','hub','person','other')),
 custody text NOT NULL CHECK(custody IN ('academy_funds','third_party')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE NULLS NOT DISTINCT(academy_id,hub_id,code),
 CHECK((kind='person')=(person_id IS NOT NULL)),CHECK(kind<>'hub' OR hub_id IS NOT NULL),CHECK(kind<>'academy' OR(hub_id IS NULL AND custody='academy_funds')),
 FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE TABLE public.finance_collector_revisions(
 academy_id uuid NOT NULL,collector_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),active boolean NOT NULL,
 accounts jsonb NOT NULL CHECK(jsonb_typeof(accounts)='array' AND jsonb_array_length(accounts) BETWEEN 1 AND 50),
 changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,collector_id,version),FOREIGN KEY(academy_id,collector_id) REFERENCES public.finance_collectors(academy_id,id),
 FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.finance_collectors ADD CONSTRAINT collector_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.finance_collector_revisions(academy_id,collector_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX finance_collector_hub ON public.finance_collectors(academy_id,hub_id,id);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['finance_collectors','finance_collector_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE TRIGGER collector_version BEFORE INSERT OR UPDATE ON public.finance_collectors FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.guard_collector_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE h record;a record;m jsonb;seen uuid[]='{}';
BEGIN
 SELECT * INTO h FROM public.finance_collectors WHERE academy_id=NEW.academy_id AND id=NEW.collector_id;
 IF h.version IS DISTINCT FROM NEW.version OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.collector_id AND p.target_version=NEW.version-1 AND p.status IN ('pending','applied') AND p.privacy_capability='collectors.edit' AND p.action=CASE WHEN NEW.version=1 THEN 'finance.collector.create' ELSE 'finance.collector.replace' END) THEN RAISE EXCEPTION 'COLLECTOR_APPROVAL_MISMATCH' USING ERRCODE='23514';END IF;
 FOR m IN SELECT value FROM jsonb_array_elements(NEW.accounts) LOOP
  IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR m-ARRAY['id','version','currencyId']<>'{}'::jsonb OR NOT(m ?& ARRAY['id','version','currencyId']) OR jsonb_typeof(m->'version') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'COLLECTOR_MAPPING_INVALID' USING ERRCODE='23514';END IF;
  SELECT f.currency_id,f.hub_id,r.operational_role,r.active INTO a FROM public.finance_accounts f JOIN public.finance_account_revisions r ON r.academy_id=f.academy_id AND r.account_id=f.id AND r.version=(m->>'version')::integer WHERE f.academy_id=NEW.academy_id AND f.id=(m->>'id')::uuid AND f.version=(m->>'version')::integer;
  IF a.currency_id IS NULL OR a.currency_id IS DISTINCT FROM (m->>'currencyId')::uuid OR a.currency_id=ANY(seen) OR NOT a.active OR(a.hub_id IS NOT NULL AND a.hub_id IS DISTINCT FROM h.hub_id)
   OR(h.custody='academy_funds' AND a.operational_role NOT IN ('cash','bank')) OR(h.custody='third_party' AND a.operational_role<>'collector_receivable') THEN RAISE EXCEPTION 'COLLECTOR_MAPPING_INVALID' USING ERRCODE='23514';END IF;
  seen=array_append(seen,a.currency_id);
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER collector_revision BEFORE INSERT ON public.finance_collector_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_collector_revision();
REVOKE ALL ON FUNCTION public.guard_collector_revision() FROM PUBLIC;
GRANT SELECT ON public.finance_collectors,public.finance_collector_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,id,hub_id,person_id,code,kind,custody,created_by) ON public.finance_collectors TO kavosh_runtime;
GRANT UPDATE(version) ON public.finance_collectors TO kavosh_runtime;
GRANT INSERT ON public.finance_collector_revisions TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 44 $$;

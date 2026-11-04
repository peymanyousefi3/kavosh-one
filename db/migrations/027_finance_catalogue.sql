INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('currencies.view','View configured currency units','Finance',false,'{}'),
 ('currencies.edit','Request currency definition changes','Finance',true,'{}'),
 ('accounts.view','View permitted chart-of-accounts records','Finance',true,ARRAY['hub','country','region','city']),
 ('accounts.edit','Request permitted chart-of-accounts changes','Finance',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.finance_currencies (
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,code text NOT NULL CHECK(code ~ '^[A-Z]{3}$'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,code),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE TABLE public.finance_currency_revisions (
 academy_id uuid NOT NULL,currency_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),symbol text NOT NULL CHECK(length(symbol)<=16),unit_scale smallint NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),active boolean NOT NULL,
 translations jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(translations)='object' AND translations-ARRAY['en','fr','zh-CN']='{}'::jsonb),
 changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,currency_id,version),FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),
 FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.finance_currencies ADD CONSTRAINT finance_currency_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.finance_currency_revisions(academy_id,currency_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.finance_accounts (
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,hub_id uuid,currency_id uuid NOT NULL,currency_version integer NOT NULL,
 code text NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE NULLS NOT DISTINCT(academy_id,hub_id,code),
 FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,currency_id,currency_version) REFERENCES public.finance_currency_revisions(academy_id,currency_id,version),
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE INDEX finance_accounts_hub ON public.finance_accounts(academy_id,hub_id,id);
CREATE TABLE public.finance_account_revisions (
 academy_id uuid NOT NULL,account_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),code text NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),description text NOT NULL CHECK(length(description)<=2000),
 kind text NOT NULL CHECK(kind IN ('asset','liability','equity','income','expense')),normal_balance text NOT NULL CHECK(normal_balance IN ('debit','credit')),active boolean NOT NULL,
 translations jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(translations)='object' AND translations-ARRAY['en','fr','zh-CN']='{}'::jsonb),
 changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,account_id,version),UNIQUE(academy_id,account_id,version,code),FOREIGN KEY(academy_id,account_id) REFERENCES public.finance_accounts(academy_id,id),
 FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.finance_accounts ADD CONSTRAINT finance_account_current_revision FOREIGN KEY(academy_id,id,version,code) REFERENCES public.finance_account_revisions(academy_id,account_id,version,code) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_currencies','finance_currency_revisions','finance_accounts','finance_account_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE FUNCTION public.guard_finance_header_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF(TG_OP='INSERT' AND NEW.version<>1) OR(TG_OP='UPDATE' AND NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'FINANCE_VERSION_SEQUENCE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_finance_header_version() FROM PUBLIC;
CREATE TRIGGER finance_currency_version BEFORE INSERT OR UPDATE ON public.finance_currencies FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE TRIGGER finance_account_version BEFORE INSERT OR UPDATE ON public.finance_accounts FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.guard_finance_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE current_version integer; BEGIN
 IF jsonb_typeof(NEW.translations) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(NEW.translations) label WHERE jsonb_typeof(label.value)<>'string' OR length(label.value#>>'{}') NOT BETWEEN 1 AND 200) THEN RAISE EXCEPTION 'FINANCE_TRANSLATIONS_INVALID' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='finance_currency_revisions' THEN
  SELECT c.version INTO current_version FROM public.finance_currencies c WHERE c.academy_id=NEW.academy_id AND c.id=NEW.currency_id;
 ELSE
  SELECT a.version INTO current_version FROM public.finance_accounts a WHERE a.academy_id=NEW.academy_id AND a.id=NEW.account_id;
 END IF;
 IF current_version IS DISTINCT FROM NEW.version THEN RAISE EXCEPTION 'FINANCE_REVISION_MISMATCH' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_finance_revision() FROM PUBLIC;
CREATE TRIGGER finance_currency_revision BEFORE INSERT ON public.finance_currency_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_finance_revision();
CREATE TRIGGER finance_account_revision BEFORE INSERT ON public.finance_account_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_finance_revision();
CREATE VIEW public.finance_currency_catalogue WITH(security_invoker=true) AS
 SELECT c.academy_id,c.id,c.code,c.version,c.created_by,c.created_at,r.name,r.symbol,r.unit_scale,r.active,r.translations,r.created_at AS revised_at
 FROM public.finance_currencies c JOIN public.finance_currency_revisions r ON r.academy_id=c.academy_id AND r.currency_id=c.id AND r.version=c.version;
CREATE VIEW public.finance_account_catalogue WITH(security_invoker=true) AS
 SELECT a.academy_id,a.id,a.hub_id,a.currency_id,a.currency_version,a.code,a.version,a.created_by,a.created_at,r.name,r.description,r.kind,r.normal_balance,r.active,r.translations,r.created_at AS revised_at,
  c.code AS currency_code,u.unit_scale,u.symbol AS currency_symbol
 FROM public.finance_accounts a JOIN public.finance_account_revisions r ON r.academy_id=a.academy_id AND r.account_id=a.id AND r.version=a.version
 JOIN public.finance_currencies c ON c.academy_id=a.academy_id AND c.id=a.currency_id
 JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version;
GRANT SELECT ON public.finance_currencies,public.finance_currency_revisions,public.finance_accounts,public.finance_account_revisions,public.finance_currency_catalogue,public.finance_account_catalogue TO kavosh_runtime;
GRANT INSERT(academy_id,id,code,created_by) ON public.finance_currencies TO kavosh_runtime;
GRANT UPDATE(version) ON public.finance_currencies TO kavosh_runtime;
GRANT INSERT(academy_id,id,hub_id,currency_id,currency_version,code,created_by) ON public.finance_accounts TO kavosh_runtime;
GRANT UPDATE(code,version) ON public.finance_accounts TO kavosh_runtime;
GRANT INSERT ON public.finance_currency_revisions,public.finance_account_revisions TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 27 $$;

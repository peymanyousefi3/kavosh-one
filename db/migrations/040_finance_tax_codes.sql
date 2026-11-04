INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('tax-codes.view','View configured tax codes and exact amount previews','Finance',true,ARRAY['hub','country','region','city']),
 ('tax-codes.edit','Request reviewed tax classification and rate changes','Finance',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.finance_tax_codes(
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,hub_id uuid,
 code text NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE NULLS NOT DISTINCT(academy_id,hub_id,code),
 FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE INDEX finance_tax_codes_hub ON public.finance_tax_codes(academy_id,hub_id,id);
CREATE TABLE public.finance_tax_code_revisions(
 academy_id uuid NOT NULL,tax_code_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),country_code text NOT NULL CHECK(country_code ~ '^[A-Z]{2}$'),
 region_code text CHECK(region_code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),classification text NOT NULL CHECK(classification IN ('taxable','zero_rated','exempt','out_of_scope')),
 rate_millionths integer NOT NULL CHECK(rate_millionths BETWEEN 0 AND 1000000),
 starts_on date NOT NULL CHECK(starts_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 ends_on date CHECK(ends_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 legal_basis text NOT NULL CHECK(length(legal_basis) BETWEEN 1 AND 2000),active boolean NOT NULL,
 translations jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(translations)='object' AND translations-ARRAY['en','fr','zh-CN']='{}'::jsonb),
 changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,tax_code_id,version),FOREIGN KEY(academy_id,tax_code_id) REFERENCES public.finance_tax_codes(academy_id,id),
 FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK(ends_on IS NULL OR ends_on>=starts_on),
 CHECK((classification='taxable' AND rate_millionths>0) OR(classification<>'taxable' AND rate_millionths=0))
);
ALTER TABLE public.finance_tax_codes ADD CONSTRAINT finance_tax_current_revision FOREIGN KEY(academy_id,id,version)
 REFERENCES public.finance_tax_code_revisions(academy_id,tax_code_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['finance_tax_codes','finance_tax_code_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE TRIGGER finance_tax_header_version BEFORE INSERT OR UPDATE ON public.finance_tax_codes FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.guard_finance_tax_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE current_version integer;
BEGIN
 SELECT c.version INTO current_version FROM public.finance_tax_codes c WHERE c.academy_id=NEW.academy_id AND c.id=NEW.tax_code_id;
 IF current_version IS DISTINCT FROM NEW.version THEN RAISE EXCEPTION 'FINANCE_TAX_REVISION_MISMATCH' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(NEW.translations) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(NEW.translations) label WHERE jsonb_typeof(label.value)<>'string' OR length(label.value#>>'{}') NOT BETWEEN 1 AND 200) THEN
  RAISE EXCEPTION 'FINANCE_TAX_TRANSLATIONS_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=NEW.academy_id AND a.id=NEW.approval_id AND a.target_id=NEW.tax_code_id
  AND a.target_version=NEW.version-1 AND a.action=CASE WHEN NEW.version=1 THEN 'finance.tax-code.create' ELSE 'finance.tax-code.update' END
  AND a.status IN ('pending','applied') AND a.privacy_capability='tax-codes.edit') THEN
  RAISE EXCEPTION 'FINANCE_TAX_APPROVAL_MISMATCH' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_finance_tax_revision() FROM PUBLIC;
CREATE TRIGGER finance_tax_revision BEFORE INSERT ON public.finance_tax_code_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_finance_tax_revision();
CREATE VIEW public.finance_tax_catalogue WITH(security_invoker=true) AS
 SELECT c.academy_id,c.id,c.hub_id,c.code,c.version,c.created_by,c.created_at,r.name,r.country_code,r.region_code,r.classification,r.rate_millionths,
 r.starts_on,r.ends_on,r.legal_basis,r.active,r.translations,r.created_at AS revised_at
 FROM public.finance_tax_codes c JOIN public.finance_tax_code_revisions r ON r.academy_id=c.academy_id AND r.tax_code_id=c.id AND r.version=c.version;
GRANT SELECT ON public.finance_tax_codes,public.finance_tax_code_revisions,public.finance_tax_catalogue TO kavosh_runtime;
GRANT INSERT(academy_id,id,hub_id,code,created_by) ON public.finance_tax_codes TO kavosh_runtime;
GRANT UPDATE(version) ON public.finance_tax_codes TO kavosh_runtime;
GRANT INSERT ON public.finance_tax_code_revisions TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 40 $$;

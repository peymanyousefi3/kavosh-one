INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payment-methods.view','View configured payment methods','Finance',true,ARRAY['hub','country','region','city']),
 ('payment-methods.edit','Request reviewed payment-method changes','Finance',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.finance_payment_methods(
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,hub_id uuid,
 code text NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
 category text NOT NULL CHECK(category IN ('cash','e_transfer','credit_card','debit_card','cheque','bank_transfer','other')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL,
 created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE NULLS NOT DISTINCT(academy_id,hub_id,code),
 FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE INDEX finance_payment_methods_hub ON public.finance_payment_methods(academy_id,hub_id,id);
CREATE TABLE public.finance_payment_method_revisions(
 academy_id uuid NOT NULL,method_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),active boolean NOT NULL,
 translations jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(translations)='object' AND translations-ARRAY['en','fr','zh-CN']='{}'::jsonb),
 changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,method_id,version),FOREIGN KEY(academy_id,method_id) REFERENCES public.finance_payment_methods(academy_id,id),
 FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.finance_payment_methods ADD CONSTRAINT finance_payment_method_current_revision FOREIGN KEY(academy_id,id,version)
 REFERENCES public.finance_payment_method_revisions(academy_id,method_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['finance_payment_methods','finance_payment_method_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE TRIGGER finance_payment_method_header BEFORE INSERT OR UPDATE ON public.finance_payment_methods FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.guard_payment_method_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE current_version integer;
BEGIN
 SELECT m.version INTO current_version FROM public.finance_payment_methods m WHERE m.academy_id=NEW.academy_id AND m.id=NEW.method_id;
 IF current_version IS DISTINCT FROM NEW.version THEN RAISE EXCEPTION 'PAYMENT_METHOD_REVISION_MISMATCH' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(NEW.translations) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(NEW.translations) label WHERE jsonb_typeof(label.value)<>'string' OR length(label.value#>>'{}') NOT BETWEEN 1 AND 200) THEN
  RAISE EXCEPTION 'PAYMENT_METHOD_TRANSLATIONS_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=NEW.academy_id AND a.id=NEW.approval_id AND a.target_id=NEW.method_id
  AND a.target_version=NEW.version-1 AND a.action=CASE WHEN NEW.version=1 THEN 'finance.payment-method.create' ELSE 'finance.payment-method.update' END
  AND a.status IN ('pending','applied') AND a.privacy_capability='payment-methods.edit') THEN
  RAISE EXCEPTION 'PAYMENT_METHOD_APPROVAL_MISMATCH' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_payment_method_revision() FROM PUBLIC;
CREATE TRIGGER finance_payment_method_revision BEFORE INSERT ON public.finance_payment_method_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_payment_method_revision();
CREATE VIEW public.finance_payment_method_catalogue WITH(security_invoker=true) AS
 SELECT m.academy_id,m.id,m.hub_id,m.code,m.category,m.version,m.created_by,m.created_at,r.name,r.active,r.translations,r.created_at AS revised_at
 FROM public.finance_payment_methods m JOIN public.finance_payment_method_revisions r ON r.academy_id=m.academy_id AND r.method_id=m.id AND r.version=m.version;
GRANT SELECT ON public.finance_payment_methods,public.finance_payment_method_revisions,public.finance_payment_method_catalogue TO kavosh_runtime;
GRANT INSERT(academy_id,id,hub_id,code,category,created_by) ON public.finance_payment_methods TO kavosh_runtime;
GRANT UPDATE(version) ON public.finance_payment_methods TO kavosh_runtime;
GRANT INSERT ON public.finance_payment_method_revisions TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 41 $$;

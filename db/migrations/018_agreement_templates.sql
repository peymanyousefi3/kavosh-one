INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('agreements.view','View versioned enrollment agreement definitions','People',true,ARRAY['hub','country','region','city']),
 ('agreements.edit','Request enrollment agreement definition changes','People',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.agreement_templates (
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,hub_id uuid,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),available boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),last_approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,last_approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX agreement_templates_hub ON public.agreement_templates(academy_id,hub_id,id);
CREATE TABLE public.agreement_template_revisions (
 academy_id uuid NOT NULL,template_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),definition_hash text NOT NULL CHECK(definition_hash ~ '^[a-f0-9]{64}$'),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,template_id,version),FOREIGN KEY(academy_id,template_id) REFERENCES public.agreement_templates(academy_id,id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.agreement_templates ADD CONSTRAINT current_agreement_revision
 FOREIGN KEY(academy_id,id,version) REFERENCES public.agreement_template_revisions(academy_id,template_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['agreement_templates','agreement_template_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON public.agreement_templates,public.agreement_template_revisions TO kavosh_runtime;
GRANT UPDATE(name,available,version,last_approval_id) ON public.agreement_templates TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 18 $$;

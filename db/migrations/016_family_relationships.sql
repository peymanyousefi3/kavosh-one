INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('families.view','View private student-guardian relationships','People',true,ARRAY['hub','person','country','region','city']),
 ('families.edit','Request family relationship changes and apply urgent suspensions','People',true,ARRAY['hub','person','country','region','city']);
ALTER TABLE public.approval_requests ADD COLUMN privacy_capability text REFERENCES public.capability_catalog(name);
CREATE TABLE public.family_relationships (
 academy_id uuid NOT NULL,id uuid NOT NULL,student_id uuid NOT NULL,guardian_id uuid NOT NULL,
 relationship text NOT NULL CHECK(relationship IN ('parent','legal_guardian','authorized_contact')),
 valid_from timestamptz(3) NOT NULL,valid_until timestamptz(3),state text NOT NULL CHECK(state IN ('approved','suspended')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),last_approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),
 FOREIGN KEY(academy_id,guardian_id) REFERENCES public.guardian_profiles(academy_id,person_id),
 FOREIGN KEY(academy_id,last_approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK(student_id<>guardian_id),CHECK(valid_until IS NULL OR valid_until>valid_from),
 CONSTRAINT family_period_overlap EXCLUDE USING gist(academy_id WITH =,student_id WITH =,guardian_id WITH =,
   tstzrange(valid_from,valid_until,'[)') WITH &&) WHERE(state='approved')
);
CREATE INDEX family_guardian ON public.family_relationships(academy_id,guardian_id,id);
CREATE INDEX family_student ON public.family_relationships(academy_id,student_id,id);
CREATE TABLE public.family_relationship_revisions (
 academy_id uuid NOT NULL,relationship_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),changed_by uuid NOT NULL,approval_id uuid,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,relationship_id,version),FOREIGN KEY(academy_id,relationship_id) REFERENCES public.family_relationships(academy_id,id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['family_relationships','family_relationship_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON public.family_relationships,public.family_relationship_revisions TO kavosh_runtime;
GRANT UPDATE(relationship,valid_from,valid_until,state,version,last_approval_id) ON public.family_relationships TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 16 $$;

INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('students.view','View private student profiles','People',true,ARRAY['hub','person','country','region','city']),
 ('students.edit','Manage private student profiles','People',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.student_profiles (
 academy_id uuid NOT NULL,person_id uuid NOT NULL,person_kind text NOT NULL DEFAULT 'human' CHECK(person_kind='human'),
 legal_name text NOT NULL CHECK(length(legal_name) BETWEEN 1 AND 200),preferred_name text CHECK(length(preferred_name) BETWEEN 1 AND 200),
 date_of_birth date NOT NULL CHECK(date_of_birth BETWEEN date '1900-01-01' AND date '9999-12-31'),shirt_size text CHECK(length(shirt_size) BETWEEN 1 AND 40),
 recruiter_kind text NOT NULL CHECK(recruiter_kind IN ('academy','hub','person')),recruiter_hub_id uuid,recruiter_person_id uuid,
 recruiter_person_kind text NOT NULL DEFAULT 'human' CHECK(recruiter_person_kind='human'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,person_id),
 FOREIGN KEY(academy_id,person_id,person_kind) REFERENCES public.people(academy_id,id,kind),
 FOREIGN KEY(academy_id,recruiter_hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,recruiter_person_id,recruiter_person_kind) REFERENCES public.people(academy_id,id,kind),
 CHECK((recruiter_kind='academy' AND recruiter_hub_id IS NULL AND recruiter_person_id IS NULL)
  OR (recruiter_kind='hub' AND recruiter_hub_id IS NOT NULL AND recruiter_person_id IS NULL)
  OR (recruiter_kind='person' AND recruiter_hub_id IS NULL AND recruiter_person_id IS NOT NULL))
);
CREATE TABLE public.student_profile_revisions (
 academy_id uuid NOT NULL,person_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),changed_by uuid NOT NULL,reason text NOT NULL CHECK(length(reason)<=2000),changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,person_id,version),
 FOREIGN KEY(academy_id,person_id) REFERENCES public.student_profiles(academy_id,person_id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['student_profiles','student_profile_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON public.student_profiles,public.student_profile_revisions TO kavosh_runtime;
GRANT UPDATE(legal_name,preferred_name,date_of_birth,shirt_size,recruiter_kind,recruiter_hub_id,recruiter_person_id,version) ON public.student_profiles TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 13 $$;

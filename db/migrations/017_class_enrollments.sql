INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('enrollments.view','View administrative class enrollment records','People',true,ARRAY['hub','class','country','region','city']),
 ('enrollments.edit','Request class enrollment changes','People',true,ARRAY['hub','class','country','region','city']),
 ('rosters.view','View date-filtered class roster candidates without private profiles','Learning',true,ARRAY['hub','class','country','region','city']),
 ('registrations.view','View selected students own registration summaries without peer rosters','People',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.class_enrollments (
 academy_id uuid NOT NULL,id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,student_id uuid NOT NULL,student_profile_version integer NOT NULL,
 joins_on date NOT NULL CHECK(joins_on BETWEEN date '1900-01-01' AND date '9999-12-31'),
 leaves_on date CHECK(leaves_on BETWEEN joins_on AND date '9999-12-31'),enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),last_approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,class_id,hub_id) REFERENCES public.classes(academy_id,id,hub_id),
 FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),
 FOREIGN KEY(academy_id,student_id,student_profile_version) REFERENCES public.student_profile_revisions(academy_id,person_id,version),
 FOREIGN KEY(academy_id,last_approval_id) REFERENCES public.approval_requests(academy_id,id),
 CONSTRAINT enrollment_period_overlap EXCLUDE USING gist(academy_id WITH =,class_id WITH =,student_id WITH =,daterange(joins_on,leaves_on,'[]') WITH &&) WHERE(enabled)
);
CREATE INDEX enrollments_class ON public.class_enrollments(academy_id,class_id,id);
CREATE INDEX enrollments_student ON public.class_enrollments(academy_id,student_id,class_id,id);
CREATE TABLE public.class_enrollment_revisions (
 academy_id uuid NOT NULL,enrollment_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,enrollment_id,version),FOREIGN KEY(academy_id,enrollment_id) REFERENCES public.class_enrollments(academy_id,id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['class_enrollments','class_enrollment_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON public.class_enrollments,public.class_enrollment_revisions TO kavosh_runtime;
GRANT UPDATE(student_profile_version,joins_on,leaves_on,enabled,version,last_approval_id) ON public.class_enrollments TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 17 $$;

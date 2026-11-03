INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('staff.view','View class staff assignments','Academy',false,ARRAY['hub','class','country','region','city']),
 ('staff.edit','Manage class staff assignments','Academy',false,ARRAY['hub','class','country','region','city']);
CREATE TABLE public.class_staff (
 academy_id uuid NOT NULL,id uuid NOT NULL,class_id uuid NOT NULL,person_id uuid NOT NULL,person_kind text NOT NULL DEFAULT 'human' CHECK(person_kind='human'),
 role text NOT NULL CHECK(role IN ('teacher','ta','volunteer')),
 starts_on date NOT NULL CHECK(starts_on BETWEEN date '1900-01-01' AND date '9999-12-31'),
 ends_on date CHECK(ends_on BETWEEN starts_on AND date '9999-12-31'),
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),
 FOREIGN KEY(academy_id,class_id) REFERENCES public.classes(academy_id,id),
 FOREIGN KEY(academy_id,person_id,person_kind) REFERENCES public.people(academy_id,id,kind),
 CONSTRAINT staff_membership_overlap EXCLUDE USING gist(academy_id WITH =,class_id WITH =,person_id WITH =,daterange(starts_on,ends_on,'[]') WITH &&) WHERE(active)
);
CREATE INDEX class_staff_person ON public.class_staff(academy_id,person_id,class_id);
CREATE TABLE public.class_staff_revisions (
 academy_id uuid NOT NULL,assignment_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),changed_by uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,assignment_id,version),
 FOREIGN KEY(academy_id,assignment_id) REFERENCES public.class_staff(academy_id,id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['class_staff','class_staff_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON public.class_staff,public.class_staff_revisions TO kavosh_runtime;
GRANT UPDATE(role,starts_on,ends_on,active,version) ON public.class_staff TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 12 $$;

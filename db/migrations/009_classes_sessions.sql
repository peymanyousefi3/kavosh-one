CREATE EXTENSION IF NOT EXISTS btree_gist;
INSERT INTO public.capability_catalog VALUES
 ('classes.view','View permitted classes and sessions','Academy',false),
 ('classes.edit','Manage permitted classes and schedules','Academy',false),
 ('sessions.request','Request a session cancellation, reschedule or delivery change','Academy',false);

CREATE TABLE public.classes (
 academy_id uuid NOT NULL,id uuid NOT NULL,hub_id uuid NOT NULL,course_id uuid NOT NULL,course_version integer NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),code text NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9_-]{0,99}$'),
 time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 80),
 mode text NOT NULL CHECK(mode IN ('in_person','online')),online_url text,
 active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,code),UNIQUE(academy_id,id,hub_id),
 FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,course_id,course_version) REFERENCES public.course_revisions(academy_id,course_id,version),
 CHECK((mode='online' AND online_url IS NOT NULL) OR (mode='in_person' AND online_url IS NULL))
);
CREATE INDEX classes_hub ON public.classes(academy_id,hub_id,id);
CREATE TABLE public.class_schedules (
 academy_id uuid NOT NULL,id uuid NOT NULL,class_id uuid NOT NULL,class_version integer NOT NULL CHECK(class_version>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),compiled jsonb NOT NULL CHECK(jsonb_typeof(compiled)='object'),
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,class_id,class_version),UNIQUE(academy_id,id,class_id),
 FOREIGN KEY(academy_id,class_id) REFERENCES public.classes(academy_id,id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE TABLE public.class_sessions (
 academy_id uuid NOT NULL,id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,schedule_id uuid NOT NULL,
 course_id uuid NOT NULL,course_version integer NOT NULL,
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,time_info jsonb NOT NULL CHECK(jsonb_typeof(time_info)='object'),
 mode text NOT NULL CHECK(mode IN ('in_person','online')),online_url text,
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),
 FOREIGN KEY(academy_id,class_id,hub_id) REFERENCES public.classes(academy_id,id,hub_id),
 FOREIGN KEY(academy_id,schedule_id,class_id) REFERENCES public.class_schedules(academy_id,id,class_id),
 FOREIGN KEY(academy_id,course_id,course_version) REFERENCES public.course_revisions(academy_id,course_id,version),
 CHECK(ends_at>starts_at AND ends_at-starts_at<=interval '24 hours'),
 CHECK((mode='online' AND online_url IS NOT NULL) OR (mode='in_person' AND online_url IS NULL)),
 -- Native exclusion protects against overlap even under concurrent writers.
 EXCLUDE USING gist(academy_id WITH =,class_id WITH =,tstzrange(starts_at,ends_at,'[)') WITH &&) WHERE(status='scheduled')
);
CREATE INDEX sessions_hub_time ON public.class_sessions(academy_id,hub_id,starts_at,id);
CREATE INDEX sessions_class_time ON public.class_sessions(academy_id,class_id,starts_at,id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['classes','class_schedules','class_sessions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON public.classes,public.class_schedules,public.class_sessions TO kavosh_runtime;
GRANT UPDATE(name,code,mode,online_url,active,version) ON public.classes TO kavosh_runtime;
GRANT UPDATE(starts_at,ends_at,time_info,mode,online_url,status,version) ON public.class_sessions TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 9 $$;

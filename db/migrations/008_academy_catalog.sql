INSERT INTO public.capability_catalog VALUES
 ('locations.view','View permitted locations','Academy',false),('locations.edit','Manage geographic catalogue','Academy',false),
 ('courses.view','View permitted courses','Learning',false),('courses.edit','Manage permitted courses','Learning',false);

CREATE TABLE public.countries (
  academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,
  code text NOT NULL CHECK(code ~ '^[A-Z]{2}$'),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 150),
  translations jsonb NOT NULL DEFAULT '{}',active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY(academy_id,id),UNIQUE(academy_id,code),CHECK(jsonb_typeof(translations)='object')
);
CREATE TABLE public.regions (
  academy_id uuid NOT NULL,id uuid NOT NULL,country_id uuid NOT NULL,
  code text NOT NULL CHECK(length(code) BETWEEN 1 AND 20),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 150),
  translations jsonb NOT NULL DEFAULT '{}',active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY(academy_id,id),UNIQUE(academy_id,country_id,code),
  FOREIGN KEY(academy_id,country_id) REFERENCES public.countries(academy_id,id),CHECK(jsonb_typeof(translations)='object')
);
CREATE TABLE public.cities (
  academy_id uuid NOT NULL,id uuid NOT NULL,region_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 150),translations jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,region_id) REFERENCES public.regions(academy_id,id),CHECK(jsonb_typeof(translations)='object')
);
CREATE UNIQUE INDEX city_name ON public.cities(academy_id,region_id,lower(name));
CREATE INDEX regions_country ON public.regions(academy_id,country_id,id);
CREATE INDEX cities_region ON public.cities(academy_id,region_id,id);

ALTER TABLE public.hubs ADD COLUMN city_id uuid;
ALTER TABLE public.hubs ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE public.hubs ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE public.hubs ADD COLUMN time_zone text;
ALTER TABLE public.hubs ADD COLUMN currency text CHECK(currency ~ '^[A-Z]{3}$');
ALTER TABLE public.hubs ADD COLUMN contact_email text;
ALTER TABLE public.hubs ADD COLUMN contact_phone text;
ALTER TABLE public.hubs ADD COLUMN website text;
ALTER TABLE public.hubs ADD COLUMN address jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(address)='object');
ALTER TABLE public.hubs ADD COLUMN latitude numeric(9,6) CHECK(latitude BETWEEN -90 AND 90);
ALTER TABLE public.hubs ADD COLUMN longitude numeric(10,6) CHECK(longitude BETWEEN -180 AND 180);
ALTER TABLE public.hubs ADD COLUMN translations jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(translations)='object');
ALTER TABLE public.hubs ADD CHECK((latitude IS NULL)=(longitude IS NULL));
ALTER TABLE public.hubs ADD FOREIGN KEY(academy_id,city_id) REFERENCES public.cities(academy_id,id);
CREATE INDEX hubs_city ON public.hubs(academy_id,city_id,id);

CREATE TABLE public.courses (
  academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,hub_id uuid,
  code text NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK(length(description)<=4000),translations jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY(academy_id,id),UNIQUE(academy_id,code),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),CHECK(jsonb_typeof(translations)='object')
);
CREATE INDEX courses_hub ON public.courses(academy_id,hub_id,id);
CREATE TABLE public.course_revisions (
  academy_id uuid NOT NULL,course_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
  definition jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(academy_id,course_id,version),FOREIGN KEY(academy_id,course_id) REFERENCES public.courses(academy_id,id),
  CHECK(jsonb_typeof(definition)='object')
);
ALTER TABLE public.courses ADD CONSTRAINT current_course_revision
  FOREIGN KEY(academy_id,id,version) REFERENCES public.course_revisions(academy_id,course_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX audit_entity_history ON public.audit_events(academy_id,entity_id,created_at,id);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['countries','regions','cities','courses','course_revisions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON public.countries,public.regions,public.cities,public.courses TO kavosh_runtime;
GRANT SELECT,INSERT ON public.course_revisions TO kavosh_runtime;
GRANT UPDATE(name,city,country_code,city_id,version,active,time_zone,currency,contact_email,contact_phone,website,address,latitude,longitude,translations) ON public.hubs TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 8 $$;

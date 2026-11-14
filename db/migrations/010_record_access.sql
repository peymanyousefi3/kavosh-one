CREATE TABLE public.assignment_classes (
 academy_id uuid NOT NULL,assignment_id uuid NOT NULL,class_id uuid NOT NULL,
 PRIMARY KEY(academy_id,assignment_id,class_id),
 FOREIGN KEY(academy_id,assignment_id) REFERENCES public.role_assignments(academy_id,id) ON DELETE CASCADE,
 FOREIGN KEY(academy_id,class_id) REFERENCES public.classes(academy_id,id)
);
CREATE TABLE public.assignment_people (
 academy_id uuid NOT NULL,assignment_id uuid NOT NULL,person_id uuid NOT NULL,
 PRIMARY KEY(academy_id,assignment_id,person_id),
 FOREIGN KEY(academy_id,assignment_id) REFERENCES public.role_assignments(academy_id,id) ON DELETE CASCADE,
 FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['assignment_classes','assignment_people'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,DELETE ON public.assignment_classes,public.assignment_people TO kavosh_runtime;
ALTER TABLE public.capability_catalog ADD COLUMN scope_kinds text[] NOT NULL DEFAULT ARRAY['hub']::text[];
UPDATE public.capability_catalog SET scope_kinds=ARRAY['hub','class'] WHERE name IN ('classes.view','classes.edit','sessions.request');
UPDATE public.capability_catalog SET scope_kinds=ARRAY['hub','person'] WHERE name IN ('people.view','people.edit');
UPDATE public.capability_catalog SET scope_kinds=ARRAY['hub','class','person'] WHERE name IN ('approvals.view','approvals.review');

CREATE FUNCTION public.scope_covers_ref(s jsonb,r jsonb,k text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT k IN ('classes','people') AND NOT coalesce(s->'excludedHubs','[]'::jsonb) ? coalesce(r->>'hubId','')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->CASE WHEN k='classes' THEN 'excludedClasses' ELSE 'excludedPeople' END,'[]'::jsonb)) d WHERE d->>'id'=r->>'id')
 AND (EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->k,'[]'::jsonb)) a WHERE a->>'id'=r->>'id')
   OR coalesce(s->'hubs','[]'::jsonb) ? coalesce(r->>'hubId','')
   OR (s->>'all'='true' AND (r->>'hubId' IS NOT NULL OR jsonb_array_length(coalesce(s->'excludedHubs','[]'::jsonb))=0)))
$$;
CREATE OR REPLACE FUNCTION public.scope_contains(p_source jsonb,p_target jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE s jsonb:=p_source; t jsonb:=p_target; h text; k text; e text; r jsonb; BEGIN
 IF t->>'all'='true' THEN
  IF s->>'all' IS DISTINCT FROM 'true' THEN RETURN false; END IF;
  FOR h IN SELECT jsonb_array_elements_text(coalesce(s->'excludedHubs','[]'::jsonb)) LOOP
   IF NOT coalesce(t->'excludedHubs','[]'::jsonb) ? h THEN RETURN false; END IF;
  END LOOP;
 END IF;
 FOR h IN SELECT jsonb_array_elements_text(coalesce(t->'hubs','[]'::jsonb)) LOOP
  IF coalesce(t->'excludedHubs','[]'::jsonb) ? h THEN CONTINUE; END IF;
  IF coalesce(s->'excludedHubs','[]'::jsonb) ? h OR NOT (coalesce(s->>'all'='true',false) OR coalesce(s->'hubs','[]'::jsonb) ? h) THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['classes','people'] LOOP
  e:=CASE WHEN k='classes' THEN 'excludedClasses' ELSE 'excludedPeople' END;
  FOR r IN SELECT jsonb_array_elements(coalesce(s->e,'[]'::jsonb)) LOOP
   IF NOT coalesce(t->'excludedHubs','[]'::jsonb) ? coalesce(r->>'hubId','')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(t->e,'[]'::jsonb)) d WHERE d->>'id'=r->>'id')
    AND (t->>'all'='true' OR coalesce(t->'hubs','[]'::jsonb) ? coalesce(r->>'hubId','')) THEN RETURN false; END IF;
  END LOOP;
  FOR r IN SELECT jsonb_array_elements(coalesce(t->k,'[]'::jsonb)) LOOP
   IF coalesce(t->'excludedHubs','[]'::jsonb) ? coalesce(r->>'hubId','') OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(t->e,'[]'::jsonb)) d WHERE d->>'id'=r->>'id') THEN CONTINUE; END IF;
   IF NOT public.scope_covers_ref(s,r,k) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.scope_covers_ref(jsonb,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scope_covers_ref(jsonb,jsonb,text) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 10 $$;

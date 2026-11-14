-- Invoker views retain the caller's table privileges and tenant row policies.
CREATE VIEW public.geographic_areas WITH(security_invoker=true) AS
 SELECT c.academy_id,c.id,'country'::text AS kind,c.name,c.version,c.active,
 jsonb_build_object('kind','country','id',c.id,'countryId',c.id,'regionId',NULL,'cityId',NULL) AS ref FROM public.countries c
 UNION ALL SELECT r.academy_id,r.id,'region',r.name,r.version,r.active,
 jsonb_build_object('kind','region','id',r.id,'countryId',r.country_id,'regionId',r.id,'cityId',NULL) FROM public.regions r
 UNION ALL SELECT c.academy_id,c.id,'city',c.name,c.version,c.active,
 jsonb_build_object('kind','city','id',c.id,'countryId',r.country_id,'regionId',c.region_id,'cityId',c.id)
 FROM public.cities c JOIN public.regions r ON r.academy_id=c.academy_id AND r.id=c.region_id;
CREATE VIEW public.hub_geography WITH(security_invoker=true) AS
 SELECT h.academy_id,h.id,jsonb_build_object('countryId',k.id,'regionId',r.id,'cityId',c.id) AS ref
 FROM public.hubs h LEFT JOIN public.cities c ON c.academy_id=h.academy_id AND c.id=h.city_id
 LEFT JOIN public.regions r ON r.academy_id=c.academy_id AND r.id=c.region_id
 LEFT JOIN public.countries k ON k.academy_id=h.academy_id AND
 ((h.city_id IS NOT NULL AND k.id=r.country_id) OR (h.city_id IS NULL AND k.code=h.country_code));
CREATE FUNCTION public.area_contains(a jsonb,b jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(CASE a->>'kind' WHEN 'country' THEN a->>'id'=b->>'countryId'
 WHEN 'region' THEN a->>'id'=b->>'regionId' WHEN 'city' THEN a->>'id'=b->>'cityId' ELSE false END,false)
$$;
CREATE FUNCTION public.area_matches_hub(a jsonb,h jsonb,uncertain boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(a->>'countryId'=h->>'countryId' AND
 (public.area_contains(a,h) OR (uncertain AND
 ((a->>'kind'='region' AND h->>'regionId' IS NULL) OR
 (a->>'kind'='city' AND h->>'cityId' IS NULL AND (h->>'regionId' IS NULL OR h->>'regionId'=a->>'regionId'))))),false)
$$;
DO $$ DECLARE t text; entity text; BEGIN
 FOREACH entity IN ARRAY ARRAY['country','region','city'] LOOP
  t:='assignment_'||CASE entity WHEN 'country' THEN 'countries' WHEN 'region' THEN 'regions' ELSE 'cities' END;
  EXECUTE format('CREATE TABLE public.%I(academy_id uuid NOT NULL,assignment_id uuid NOT NULL,%I uuid NOT NULL,
   PRIMARY KEY(academy_id,assignment_id,%I),FOREIGN KEY(academy_id,assignment_id) REFERENCES public.role_assignments(academy_id,id) ON DELETE CASCADE,
   FOREIGN KEY(academy_id,%I) REFERENCES public.%I(academy_id,id))',t,entity||'_id',entity||'_id',entity||'_id',CASE entity WHEN 'country' THEN 'countries' WHEN 'region' THEN 'regions' ELSE 'cities' END);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,DELETE ON public.%I TO kavosh_runtime',t);
 END LOOP;
END $$;
CREATE VIEW public.assignment_geography WITH(security_invoker=true) AS
 SELECT x.academy_id,x.assignment_id,g.kind,g.id,g.ref FROM public.assignment_countries x JOIN public.geographic_areas g ON g.academy_id=x.academy_id AND g.kind='country' AND g.id=x.country_id
 UNION ALL SELECT x.academy_id,x.assignment_id,g.kind,g.id,g.ref FROM public.assignment_regions x JOIN public.geographic_areas g ON g.academy_id=x.academy_id AND g.kind='region' AND g.id=x.region_id
 UNION ALL SELECT x.academy_id,x.assignment_id,g.kind,g.id,g.ref FROM public.assignment_cities x JOIN public.geographic_areas g ON g.academy_id=x.academy_id AND g.kind='city' AND g.id=x.city_id;
CREATE VIEW public.assignment_geographic_hubs WITH(security_invoker=true) AS
 SELECT g.academy_id,g.assignment_id,h.id,bool_or(public.area_matches_hub(g.ref,h.ref,false)) AS strict_match
 FROM public.assignment_geography g JOIN public.hub_geography h ON h.academy_id=g.academy_id AND public.area_matches_hub(g.ref,h.ref,true)
 GROUP BY g.academy_id,g.assignment_id,h.id;
GRANT SELECT ON public.geographic_areas,public.hub_geography,public.assignment_geography,public.assignment_geographic_hubs TO kavosh_runtime;

-- Reuse the already-tested finite hub/class/person containment implementation.
ALTER FUNCTION public.scope_contains(jsonb,jsonb) RENAME TO scope_contains_records;
CREATE FUNCTION public.scope_contains(p_source jsonb,p_target jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE a jsonb; e jsonb; h text; k text; BEGIN
 IF NOT public.scope_contains_records(p_source,p_target) THEN RETURN false; END IF;
 FOR a IN SELECT jsonb_array_elements(coalesce(p_target->'areas','[]'::jsonb)) LOOP
  IF p_source->>'all' IS DISTINCT FROM 'true' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_source->'areas','[]'::jsonb)) s WHERE public.area_contains(s,a)) THEN RETURN false; END IF;
 END LOOP;
 IF p_target->>'all'='true' OR jsonb_array_length(coalesce(p_target->'areas','[]'::jsonb))>0 THEN
  -- Preserve explicit guards even for future hubs and hierarchy changes.
  FOR e IN SELECT jsonb_array_elements(coalesce(p_source->'excludedAreas','[]'::jsonb)) LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_target->'excludedAreas','[]'::jsonb)) t WHERE public.area_contains(t,e)) THEN RETURN false; END IF;
  END LOOP;
 END IF;
 IF jsonb_array_length(coalesce(p_target->'areas','[]'::jsonb))>0 THEN
  FOR h IN SELECT jsonb_array_elements_text(coalesce(p_source->'excludedHubs','[]'::jsonb)) LOOP
   IF NOT coalesce(p_target->'excludedHubs','[]'::jsonb) ? h THEN RETURN false; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['excludedClasses','excludedPeople'] LOOP
   FOR e IN SELECT jsonb_array_elements(coalesce(p_source->k,'[]'::jsonb)) LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_target->k,'[]'::jsonb)) t WHERE t->>'id'=e->>'id') THEN RETURN false; END IF;
   END LOOP;
  END LOOP;
 END IF;
 RETURN true;
END $$;
CREATE FUNCTION public.scope_area_visible(s jsonb,a jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->'excludedAreas','[]'::jsonb)) e WHERE public.area_contains(e,a))
 AND (s->>'all'='true' OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->'areas','[]'::jsonb)) p WHERE public.area_contains(p,a) OR public.area_contains(a,p)))
$$;
REVOKE ALL ON FUNCTION public.area_contains(jsonb,jsonb),public.area_matches_hub(jsonb,jsonb,boolean),public.scope_contains(jsonb,jsonb),public.scope_area_visible(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.area_contains(jsonb,jsonb),public.area_matches_hub(jsonb,jsonb,boolean),public.scope_contains(jsonb,jsonb),public.scope_area_visible(jsonb,jsonb) TO kavosh_runtime;
ALTER TABLE public.capability_catalog ALTER COLUMN scope_kinds SET DEFAULT ARRAY['hub','country','region','city']::text[];
UPDATE public.capability_catalog SET scope_kinds=scope_kinds||ARRAY['country','region','city']::text[];
UPDATE public.capability_catalog SET scope_kinds=ARRAY['academy']::text[] WHERE name IN ('roles.view','roles.edit','credentials.revoke','locations.edit');
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 11 $$;

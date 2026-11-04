ALTER FUNCTION public.scope_contains(jsonb,jsonb) RENAME TO scope_contains_before_exact_records;
CREATE FUNCTION public.scope_contains(p_source jsonb,p_target jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE c jsonb:=p_target->'recordContext';BEGIN
 IF p_source ? 'recordContext' AND p_source->'recordContext' IS DISTINCT FROM c THEN RETURN false;END IF;
 IF c IS NOT NULL THEN
  IF coalesce(p_source->'excludedHubs','[]'::jsonb) ? (c->>'hubId') OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_source->'excludedClasses','[]'::jsonb)) x WHERE x->>'id'=c->>'classId') OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_source->'excludedPeople','[]'::jsonb)) x WHERE x->>'id'=c->>'studentId') THEN RETURN false;END IF;
  IF p_target->'all'='false'::jsonb AND jsonb_typeof(p_target->'hubs')='array'
   AND jsonb_array_length(coalesce(p_target->'areas','[]'::jsonb))=0 AND jsonb_array_length(coalesce(p_target->'excludedAreas','[]'::jsonb))=0 AND jsonb_array_length(coalesce(p_target->'excludedHubs','[]'::jsonb))=0 AND jsonb_array_length(coalesce(p_target->'excludedClasses','[]'::jsonb))=0 AND jsonb_array_length(coalesce(p_target->'excludedPeople','[]'::jsonb))=0
   AND jsonb_array_length(p_target->'hubs')<=1 AND jsonb_array_length(coalesce(p_target->'classes','[]'::jsonb))<=1 AND jsonb_array_length(coalesce(p_target->'people','[]'::jsonb))<=1
   AND jsonb_array_length(p_target->'hubs')+jsonb_array_length(coalesce(p_target->'classes','[]'::jsonb))+jsonb_array_length(coalesce(p_target->'people','[]'::jsonb))>0
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_target->'hubs') x WHERE x IS DISTINCT FROM c->>'hubId')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_target->'classes','[]'::jsonb)) x WHERE x->>'id' IS DISTINCT FROM c->>'classId' OR x->>'hubId' IS DISTINCT FROM c->>'hubId')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_target->'people','[]'::jsonb)) x WHERE x->>'id' IS DISTINCT FROM c->>'studentId' OR x->>'hubId' IS DISTINCT FROM c->>'hubId') THEN
    RETURN coalesce((p_source->>'all')::boolean,false) OR coalesce(p_source->'hubs','[]'::jsonb) ? (c->>'hubId') OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_source->'classes','[]'::jsonb)) x WHERE x->>'id'=c->>'classId') OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_source->'people','[]'::jsonb)) x WHERE x->>'id'=c->>'studentId');
  END IF;
 END IF;
 IF p_source ? 'recordContext' THEN RETURN false;END IF;
 RETURN public.scope_contains_before_exact_records(p_source,p_target);
END $$;
REVOKE ALL ON FUNCTION public.scope_contains(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scope_contains(jsonb,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 52 $$;

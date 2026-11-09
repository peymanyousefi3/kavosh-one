-- SQL NULL must never become positive person/class authority through
-- IF NOT(NULL). Preserve every valid scope and the original function ACLs.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.scope_contains_records(jsonb,jsonb)'::regprocedure);
 needle='IF NOT public.scope_covers_ref(s,r,k) THEN RETURN false; END IF;';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'SCOPE_RECORD_CONTAINMENT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'IF public.scope_covers_ref(s,r,k) IS NOT TRUE THEN RETURN false; END IF;');
 body=pg_get_functiondef('public.scope_contains(jsonb,jsonb)'::regprocedure);
 needle='IF p_source ? ''workContexts''';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'SCOPE_CONTAINMENT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF jsonb_typeof(p_source) IS DISTINCT FROM 'object' OR jsonb_typeof(p_source->'all') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_source->'hubs') IS DISTINCT FROM 'array' OR jsonb_typeof(p_target) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF p_source ? 'workContexts'$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 279 $$;

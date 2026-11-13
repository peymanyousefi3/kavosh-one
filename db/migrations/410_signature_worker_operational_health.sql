-- Accept only the fixed copy-only worker's existing generic health codes.
-- Preserve broker identity,grants,clock fencing and immutable event history.
DO $$ DECLARE body text;needle text:='''worker:scanner'')';replacement text:='''worker:scanner'',''worker:signature-completion'')';BEGIN
 body=pg_get_functiondef('platform_private.record_operational_health(jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'SIGNATURE_WORKER_HEALTH_BROKER_CHANGED';END IF;
 EXECUTE replace(body,needle,replacement);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 410 $$;

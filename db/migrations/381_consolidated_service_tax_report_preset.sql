-- Same reviewed preset library,not a new background/result protocol.
DO $$ DECLARE body text;needle text:='''finance.supplier-t4a-working-paper'')';BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CONSOLIDATED_T4A_PRESET_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''finance.supplier-t4a-working-paper'',''payroll.t4a-consolidated-working-paper'')');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 381 $$;

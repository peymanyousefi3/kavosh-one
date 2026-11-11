-- Add the supplier report to the existing configuration library only.
-- Background/result protocols are not implicitly broadened by this change.
DO $$ DECLARE body text;needle text:='''payroll.t4a-working-paper'')';BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'SUPPLIER_REPORT_PRESET_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''payroll.t4a-working-paper'',''finance.supplier-t4a-working-paper'')');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 377 $$;

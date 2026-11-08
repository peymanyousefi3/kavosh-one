-- Add the ledger-date register to existing reviewed report definitions.
-- Preserve saved configurations and helper identity/ownership/ACLs.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);needle='''payroll.remittances'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_REGISTER_CATALOGUE_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'''payroll.remittances'',''payroll.register'')');
 body=pg_get_functiondef('public.report_preset_definition_valid(jsonb)'::regprocedure);needle='WHEN ''payroll.remittances'' THEN ARRAY[''on'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_REGISTER_WINDOW_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,needle||' WHEN ''payroll.register'' THEN ARRAY[''from'',''through'']');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 163 $$;

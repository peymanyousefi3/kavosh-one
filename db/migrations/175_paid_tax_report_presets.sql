-- Reuse the existing report library and original private payment-tax reader.
-- Do not rewrite saved definitions,financial rows or capability assignments.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);needle='''payroll.register'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAID_TAX_REPORT_CATALOGUE_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'''payroll.register'',''payroll.paid-tax-year-to-date'')');
 body=pg_get_functiondef('public.report_preset_definition_valid(jsonb)'::regprocedure);needle='WHEN ''payroll.register'' THEN ARRAY[''from'',''through'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAID_TAX_REPORT_WINDOW_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,needle||' WHEN ''payroll.paid-tax-year-to-date'' THEN ARRAY[''through'',''timeZone'']');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 175 $$;

-- Extend the existing preset catalogue without altering prior sources or ACLs.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);needle='''finance.tuition-income'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_COST_CATALOGUE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''finance.tuition-income'',''payroll.costs'')');
 body=pg_get_functiondef('public.report_preset_definition_valid(jsonb)'::regprocedure);needle='WHEN ''finance.tuition-income'' THEN ARRAY[''from'',''through'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_COST_WINDOW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||' WHEN ''payroll.costs'' THEN ARRAY[''from'',''through'']');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 246 $$;

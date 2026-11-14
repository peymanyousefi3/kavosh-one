-- Extend guarded reusable JSON reports;leave existing rows and helper identity intact.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);needle='''community.achievements'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'REPORT_CATALOGUE_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'''community.achievements'',''payroll.settlements'')');
 body=pg_get_functiondef('public.report_preset_definition_valid(jsonb)'::regprocedure);needle='WHEN ''payroll.gross-accruals'' THEN ARRAY[''on'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'REPORT_DATE_WINDOW_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,needle||' WHEN ''payroll.settlements'' THEN ARRAY[''on'']');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 152 $$;

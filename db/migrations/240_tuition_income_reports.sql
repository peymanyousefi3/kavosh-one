-- Register original tuition invoice/credit attribution in the existing report
-- library without reclassifying income,tax,old documents or ledger entries.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);needle='''finance.expense-costs'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'TUITION_INCOME_CATALOGUE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''finance.expense-costs'',''finance.tuition-income'')');
 body=pg_get_functiondef('public.report_preset_definition_valid(jsonb)'::regprocedure);needle='WHEN ''finance.expense-costs'' THEN ARRAY[''from'',''through'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'TUITION_INCOME_WINDOW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||' WHEN ''finance.tuition-income'' THEN ARRAY[''from'',''through'']');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 240 $$;

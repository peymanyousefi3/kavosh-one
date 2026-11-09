-- Add source-assigned supplier/reimbursement costs to the existing report
-- library. No historic rows,accounting entries,capabilities or ACLs change.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);needle='''learning.student-performance'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'EXPENSE_COST_CATALOGUE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''learning.student-performance'',''finance.expense-costs'')');
 body=pg_get_functiondef('public.report_preset_definition_valid(jsonb)'::regprocedure);needle='WHEN ''learning.student-performance'' THEN ARRAY[''from'',''through'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'EXPENSE_COST_WINDOW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||' WHEN ''finance.expense-costs'' THEN ARRAY[''from'',''through'']');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 239 $$;

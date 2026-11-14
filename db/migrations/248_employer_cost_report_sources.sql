-- Existing payroll-cost manifests retain their meaning. Add only the distinct
-- original employer-posting source kind;do not alter old artifacts or postings.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);
 needle='''tuition_session'',''tuition_collection'') OR jsonb_typeof(v->''sourceId'')';
 IF (length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'EMPLOYER_COST_CONTEXT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''tuition_session'',''tuition_collection'',''employer_contribution'') OR jsonb_typeof(v->''sourceId'')');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 248 $$;

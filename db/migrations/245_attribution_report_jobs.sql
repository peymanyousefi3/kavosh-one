-- Reuse current report/preset/scheduler brokers and retained-result storage.
-- Existing rows,helper identities,owners and ACLs are not rewritten.
DO $$ DECLARE body text;needle text;branch text;BEGIN
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);needle='''learning.student-performance'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'ATTRIBUTION_JOB_CATALOGUE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''learning.student-performance'',''finance.tuition-income'',''finance.expense-costs'')');
 body=pg_get_functiondef('public.report_job_preset_guard()'::regprocedure);
 needle='WHEN NEW.configuration->>''reportId'' IN(''finance.profit-loss'',''community.achievements'',''learning.student-performance'') THEN ARRAY[''from'',''through'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'ATTRIBUTION_JOB_WINDOW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'WHEN NEW.configuration->>''reportId'' IN(''finance.profit-loss'',''community.achievements'',''learning.student-performance'',''finance.tuition-income'',''finance.expense-costs'') THEN ARRAY[''from'',''through'']');
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);
 needle=' IF report IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'') THEN';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'ATTRIBUTION_RESULT_CONTEXT_BASE_CHANGED';END IF;
 branch=$branch$ IF report='finance.tuition-income' THEN
  IF NOT(p ?& ARRAY['kind','invoices','recognitions']) OR p-ARRAY['kind','invoices','recognitions']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'tuition_attribution'
   OR jsonb_typeof(p->'invoices') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'recognitions') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'invoices')>10000 OR jsonb_array_length(p->'recognitions')>10000
   OR(jsonb_array_length(p->'recognitions')>0 AND jsonb_array_length(p->'invoices')=0) THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements((p->'invoices')||(p->'recognitions')) LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false;END IF;PERFORM(v#>>'{}')::uuid;
  END LOOP;
  RETURN(SELECT count(*)=count(DISTINCT(x#>>'{}')::uuid) FROM jsonb_array_elements(p->'invoices') x)
   AND(SELECT count(*)=count(DISTINCT(x#>>'{}')::uuid) FROM jsonb_array_elements(p->'recognitions') x);
 ELSIF report='finance.expense-costs' THEN
  IF NOT(p ?& ARRAY['kind','bills']) OR p-ARRAY['kind','bills']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'expense_attribution' OR jsonb_typeof(p->'bills') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'bills')>10000 THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'bills') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false;END IF;PERFORM(v#>>'{}')::uuid;
  END LOOP;RETURN(SELECT count(*)=count(DISTINCT(x#>>'{}')::uuid) FROM jsonb_array_elements(p->'bills') x);
 END IF;
$branch$;
 EXECUTE replace(body,needle,branch||needle);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 245 $$;

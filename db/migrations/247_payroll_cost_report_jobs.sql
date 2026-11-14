-- Reuse existing queue,preset,schedule,lease and retained-result protocols.
DO $$ DECLARE body text;needle text;branch text;BEGIN
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);needle='''finance.expense-costs'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_COST_JOB_CATALOGUE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''finance.expense-costs'',''payroll.costs'')');
 body=pg_get_functiondef('public.report_job_preset_guard()'::regprocedure);needle='''finance.tuition-income'',''finance.expense-costs'') THEN ARRAY[''from'',''through'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_COST_JOB_WINDOW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''finance.tuition-income'',''finance.expense-costs'',''payroll.costs'') THEN ARRAY[''from'',''through'']');
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);needle=' IF report IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'') THEN';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_COST_RESULT_CONTEXT_BASE_CHANGED';END IF;
 branch=$branch$ IF report='payroll.costs' THEN
  IF NOT(p ?& ARRAY['kind','sources']) OR p-ARRAY['kind','sources']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'payroll_cost' OR jsonb_typeof(p->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'sources')>10000 THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'sources') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['kind','sourceId']) OR v-ARRAY['kind','sourceId']<>'{}'::jsonb OR v->>'kind' IS NULL OR v->>'kind' NOT IN('hourly','manual_bonus','salary','project','tuition_course','tuition_session','tuition_collection') OR jsonb_typeof(v->'sourceId') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
   PERFORM(v->>'sourceId')::uuid;
  END LOOP;RETURN(SELECT count(*)=count(DISTINCT(x->>'kind',(x->>'sourceId')::uuid)) FROM jsonb_array_elements(p->'sources') x);
 END IF;
$branch$;
 EXECUTE replace(body,needle,branch||needle);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 247 $$;

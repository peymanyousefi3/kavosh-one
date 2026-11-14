-- Reuse reviewed presets,relative civil-date windows and the existing leased
-- report/scheduler brokers. Preserve prior rows,helper identities and ACLs.
DO $$ DECLARE body text;needle text;branch text;BEGIN
 body=pg_get_functiondef('public.report_preset_definition_valid(jsonb)'::regprocedure);needle='WHEN ''payroll.register'' THEN ARRAY[''from'',''through'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PERFORMANCE_PRESET_WINDOW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||' WHEN ''learning.student-performance'' THEN ARRAY[''from'',''through'']');
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);needle='''payroll.t4-working-paper'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PERFORMANCE_JOB_CATALOGUE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''payroll.t4-working-paper'',''learning.student-performance'')');
 body=pg_get_functiondef('public.report_job_preset_guard()'::regprocedure);needle='WHEN NEW.configuration->>''reportId'' IN(''finance.profit-loss'',''community.achievements'') THEN ARRAY[''from'',''through'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PERFORMANCE_JOB_WINDOW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'WHEN NEW.configuration->>''reportId'' IN(''finance.profit-loss'',''community.achievements'',''learning.student-performance'') THEN ARRAY[''from'',''through'']');
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);needle=' IF report IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'') THEN';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PERFORMANCE_RESULT_CONTEXT_BASE_CHANGED';END IF;
 branch=$branch$ IF report='learning.student-performance' THEN
  IF NOT(p ?& ARRAY['kind','sources']) OR p-ARRAY['kind','sources']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'student_performance' OR jsonb_typeof(p->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'sources')>200 THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'sources') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['feedbackId','studentId','classId','hubId']) OR v-ARRAY['feedbackId','studentId','classId','hubId']<>'{}'::jsonb OR EXISTS(SELECT 1 FROM jsonb_each(v) WHERE jsonb_typeof(value) IS DISTINCT FROM 'string') THEN RETURN false;END IF;
   PERFORM(v->>'feedbackId')::uuid,(v->>'studentId')::uuid,(v->>'classId')::uuid,(v->>'hubId')::uuid;
  END LOOP;
  RETURN(SELECT count(*)=count(DISTINCT(x->>'feedbackId')::uuid) FROM jsonb_array_elements(p->'sources') x);
 END IF;
$branch$;
 EXECUTE replace(body,needle,branch||needle);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 238 $$;

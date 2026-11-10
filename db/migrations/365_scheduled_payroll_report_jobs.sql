-- Extend the existing immutable requester-bound report archive. No money,
-- previous report bytes,credentials or policy ownership are rewritten.
DO $$ DECLARE body text;needle text;branch text;BEGIN
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);needle='''finance.cash-movements'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'FORECAST_JOB_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''finance.cash-movements'',''payroll.scheduled-costs'')');
 body=pg_get_functiondef('public.report_job_preset_guard()'::regprocedure);needle='fields=CASE';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'FORECAST_JOB_WINDOW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||' WHEN NEW.configuration->>''reportId''=''payroll.scheduled-costs'' THEN ARRAY[''from'',''through'',''timeZone'']');
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);
 needle='IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM ''object'' THEN RETURN false;END IF;';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'FORECAST_RESULT_CONTEXT_BASE_CHANGED';END IF;
 branch=$branch$
 IF report='payroll.scheduled-costs' THEN
  IF NOT(p ?& ARRAY['kind','engagements','classes']) OR p-ARRAY['kind','engagements','classes']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'scheduled_payroll' OR jsonb_typeof(p->'engagements') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'classes') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(p->'engagements')>1000 OR jsonb_array_length(p->'classes')>2000 THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'engagements') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['engagementId','personId','hubId']) OR v-ARRAY['engagementId','personId','hubId']<>'{}'::jsonb OR jsonb_typeof(v->'engagementId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'personId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'hubId') NOT IN('string','null') THEN RETURN false;END IF;
   PERFORM(v->>'engagementId')::uuid,(v->>'personId')::uuid,(v->>'hubId')::uuid;
  END LOOP;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'classes') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['classId','hubId','rosterUsed']) OR v-ARRAY['classId','hubId','rosterUsed']<>'{}'::jsonb OR jsonb_typeof(v->'classId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'hubId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'rosterUsed') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
   PERFORM(v->>'classId')::uuid,(v->>'hubId')::uuid;
  END LOOP;
  RETURN(SELECT count(*)=count(DISTINCT(x->>'engagementId')::uuid) FROM jsonb_array_elements(p->'engagements') x) AND(SELECT count(*)=count(DISTINCT(x->>'classId')::uuid) FROM jsonb_array_elements(p->'classes') x);
 END IF;
 $branch$;
 EXECUTE replace(body,needle,needle||branch);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 365 $$;

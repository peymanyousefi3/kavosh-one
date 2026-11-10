-- Extend the existing requester-bound archive,without rewriting recorded
-- service,compensation,money or old result/context formats.
DO $$ DECLARE body text;needle text;branch text;BEGIN
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);needle='''payroll.scheduled-costs'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'RECORDED_JOB_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''payroll.scheduled-costs'',''payroll.recorded-time'')');
 body=pg_get_functiondef('public.report_job_preset_guard()'::regprocedure);needle='WHEN NEW.configuration->>''reportId''=''payroll.scheduled-costs'' THEN';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'RECORDED_JOB_WINDOW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'WHEN NEW.configuration->>''reportId'' IN(''payroll.scheduled-costs'',''payroll.recorded-time'') THEN');
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);
 needle='IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM ''object'' THEN RETURN false;END IF;';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'RECORDED_RESULT_CONTEXT_BASE_CHANGED';END IF;
 branch=$branch$
 IF report='payroll.recorded-time' THEN
  IF NOT(p ?& ARRAY['kind','engagements','entries']) OR p-ARRAY['kind','engagements','entries']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'recorded_hourly' OR jsonb_typeof(p->'engagements') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'entries') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(p->'engagements')>10000 OR jsonb_array_length(p->'entries')>2000 THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'engagements') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['engagementId','personId','hubId']) OR v-ARRAY['engagementId','personId','hubId']<>'{}'::jsonb OR jsonb_typeof(v->'engagementId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'personId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'hubId') NOT IN('string','null') THEN RETURN false;END IF;
   PERFORM(v->>'engagementId')::uuid,(v->>'personId')::uuid,(v->>'hubId')::uuid;
  END LOOP;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'entries') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['entryId','personId','hubId','classId','rosterUsed','attendanceUsed']) OR v-ARRAY['entryId','personId','hubId','classId','rosterUsed','attendanceUsed']<>'{}'::jsonb OR jsonb_typeof(v->'entryId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'personId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'hubId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'classId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'rosterUsed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v->'attendanceUsed') IS DISTINCT FROM 'boolean' OR(v->'attendanceUsed'='true'::jsonb AND v->'rosterUsed'<>'true'::jsonb) THEN RETURN false;END IF;
   PERFORM(v->>'entryId')::uuid,(v->>'personId')::uuid,(v->>'hubId')::uuid,(v->>'classId')::uuid;
  END LOOP;
  RETURN(SELECT count(*)=count(DISTINCT(x->>'engagementId')::uuid) FROM jsonb_array_elements(p->'engagements') x) AND(SELECT count(*)=count(DISTINCT(x->>'entryId')::uuid) FROM jsonb_array_elements(p->'entries') x);
 END IF;
 $branch$;
 EXECUTE replace(body,needle,needle||branch);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 366 $$;

-- Add exact achievement record authority while preserving old manifest types.
-- Keep old financial manifests and immutable history byte-for-byte unchanged.
CREATE OR REPLACE FUNCTION public.report_result_context_valid(report text,p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE v jsonb;BEGIN
 IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF report IN('finance.trial-balance','finance.profit-loss','finance.balance-sheet') THEN
  IF p-ARRAY['hubIds','includesGlobal']<>'{}'::jsonb OR jsonb_typeof(p->'hubIds') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'includesGlobal') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  RETURN jsonb_array_length(p->'hubIds')<=10000;
 END IF;
 IF report='community.achievements' THEN
  IF p-ARRAY['kind','sources']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'achievement_summary' OR jsonb_typeof(p->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'sources')>10000 THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'sources') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['awardId','studentId','hubId','classId']) OR v-ARRAY['awardId','studentId','hubId','classId']<>'{}'::jsonb OR jsonb_typeof(v->'awardId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'studentId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'hubId') NOT IN('string','null') OR jsonb_typeof(v->'classId') NOT IN('string','null') OR(v->'classId'<>'null'::jsonb AND v->'hubId'='null'::jsonb) THEN RETURN false;END IF;
   PERFORM(v->>'awardId')::uuid,(v->>'studentId')::uuid,(v->>'hubId')::uuid,(v->>'classId')::uuid;
  END LOOP;
  RETURN(SELECT count(*)=count(DISTINCT(x->>'awardId')::uuid) FROM jsonb_array_elements(p->'sources') x);
 END IF;
 IF report IS DISTINCT FROM 'payroll.gross-accruals' OR p-ARRAY['kind','sources']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'payroll_gross' OR jsonb_typeof(p->'sources') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(p->'sources')>10000 OR(SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(p->'sources') x) THEN RETURN false;END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(p->'sources') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['kind','sourceId','personId','hubId']) OR v-ARRAY['kind','sourceId','personId','hubId']<>'{}'::jsonb
   OR jsonb_typeof(v->'kind') IS DISTINCT FROM 'string' OR v->>'kind' NOT IN('hourly','manual_bonus','salary','project','tuition_course','tuition_session','tuition_collection')
   OR jsonb_typeof(v->'sourceId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'personId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'hubId') NOT IN('string','null') THEN RETURN false;END IF;
  PERFORM(v->>'sourceId')::uuid,(v->>'personId')::uuid,(v->>'hubId')::uuid;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;END $$;

-- Preserve guard/validator OIDs, owners, ACLs and every existing retained file.
DO $$ DECLARE body text;old text;BEGIN
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);old='NOT IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'',''payroll.gross-accruals'')';
 IF position(old IN body)=0 THEN RAISE EXCEPTION 'ACHIEVEMENT_JOB_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,old,'NOT IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'',''payroll.gross-accruals'',''community.achievements'')');
 body=pg_get_functiondef('public.report_job_preset_guard()'::regprocedure);old='WHEN NEW.configuration->>''reportId''=''finance.profit-loss'' THEN ARRAY[''from'',''through'']';
 IF position(old IN body)=0 THEN RAISE EXCEPTION 'ACHIEVEMENT_WINDOW_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,old,'WHEN NEW.configuration->>''reportId'' IN(''finance.profit-loss'',''community.achievements'') THEN ARRAY[''from'',''through'']');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 147 $$;

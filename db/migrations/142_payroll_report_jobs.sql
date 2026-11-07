-- Payroll result authority is person/source-bound,not an account manifest.
-- Keep old financial manifests and immutable history byte-for-byte unchanged.
CREATE FUNCTION public.report_result_context_valid(report text,p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE v jsonb;BEGIN
 IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF report IN('finance.trial-balance','finance.profit-loss','finance.balance-sheet') THEN
  IF p-ARRAY['hubIds','includesGlobal']<>'{}'::jsonb OR jsonb_typeof(p->'hubIds') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'includesGlobal') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  RETURN jsonb_array_length(p->'hubIds')<=10000;
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
REVOKE ALL ON FUNCTION public.report_result_context_valid(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_result_context_valid(text,jsonb) TO kavosh_automation_policy;
DO $$ DECLARE body text;old text;BEGIN
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);old='NOT IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'')';
 IF position(old IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_JOB_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,old,'NOT IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'',''payroll.gross-accruals'')');
 body=pg_get_functiondef('public.report_job_preset_guard()'::regprocedure);old='CASE WHEN NEW.configuration->>''reportId''=''finance.profit-loss'' THEN ARRAY[''from'',''through''] ELSE ARRAY[''through''] END';
 IF position(old IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_WINDOW_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,old,'CASE WHEN NEW.configuration->>''reportId''=''payroll.gross-accruals'' THEN ARRAY[''on''] WHEN NEW.configuration->>''reportId''=''finance.profit-loss'' THEN ARRAY[''from'',''through''] ELSE ARRAY[''through''] END');
 body=pg_get_functiondef('public.finish_report_job(uuid,uuid,text,text,text,text,jsonb)'::regprocedure);
 old='p_context IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM ''object'' OR p_context-ARRAY[''hubIds'',''includesGlobal'']<>''{}''::jsonb OR jsonb_typeof(p_context->''hubIds'') IS DISTINCT FROM ''array'' OR jsonb_array_length(p_context->''hubIds'')>10000 OR jsonb_typeof(p_context->''includesGlobal'') IS DISTINCT FROM ''boolean''';
 IF position(old IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_RESULT_BROKER_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,old,'NOT public.report_result_context_valid(j.configuration->>''reportId'',p_context)');
 body=pg_get_functiondef('public.report_result_guard()'::regprocedure);old='id=NEW.job_id AND status=''running''';
 IF position(old IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_RESULT_GUARD_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,old,'id=NEW.job_id AND public.report_result_context_valid(configuration->>''reportId'',NEW.authorization_context) AND status=''running''');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 142 $$;

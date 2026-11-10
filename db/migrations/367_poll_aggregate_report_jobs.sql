-- Poll jobs pin one real form and private student/class/hub permission
-- contexts. No response text,identity transport or previous archive rewrite.
DO $$ DECLARE body text;needle text;branch text;BEGIN
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);needle='''payroll.recorded-time'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'POLL_JOB_BASE_CHANGED';END IF;
 body=replace(body,needle,'''payroll.recorded-time'',''learning.polls.by-id'')');
 needle='OR NEW.configuration->''pathParameters'' IS DISTINCT FROM ''{}''::jsonb';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'POLL_JOB_PATH_BASE_CHANGED';END IF;
 branch=$branch$OR (CASE WHEN NEW.configuration->>'reportId'='learning.polls.by-id' THEN
  jsonb_typeof(NEW.configuration->'pathParameters') IS DISTINCT FROM 'object' OR NOT(NEW.configuration->'pathParameters' ?& ARRAY['id']) OR(NEW.configuration->'pathParameters')-ARRAY['id']<>'{}'::jsonb OR jsonb_typeof(NEW.configuration#>'{pathParameters,id}') IS DISTINCT FROM 'string'
  OR jsonb_typeof(NEW.configuration#>'{parameters,formVersion}') IS DISTINCT FROM 'string' OR(NEW.configuration#>>'{parameters,formVersion}')!~'^[1-9][0-9]{0,9}$'
  OR NOT EXISTS(SELECT 1 FROM public.poll_form_revisions f WHERE f.academy_id=NEW.academy_id AND f.poll_id=(NEW.configuration#>>'{pathParameters,id}')::uuid AND f.form_version=(NEW.configuration#>>'{parameters,formVersion}')::integer)
 ELSE NEW.configuration->'pathParameters' IS DISTINCT FROM '{}'::jsonb END)$branch$;
 EXECUTE replace(body,needle,branch);
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);
 needle='IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM ''object'' THEN RETURN false;END IF;';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'POLL_RESULT_CONTEXT_BASE_CHANGED';END IF;
 branch=$branch$
 IF report='learning.polls.by-id' THEN
  IF NOT(p ?& ARRAY['kind','pollId','formVersion','audiencePollVersion','contexts']) OR p-ARRAY['kind','pollId','formVersion','audiencePollVersion','contexts']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'poll_aggregate' OR jsonb_typeof(p->'pollId') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'formVersion') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'audiencePollVersion') IS DISTINCT FROM 'number' OR(p->>'formVersion')!~'^[1-9][0-9]{0,9}$' OR(p->>'audiencePollVersion')!~'^[1-9][0-9]{0,9}$' OR(p->>'formVersion')::numeric>2147483647 OR(p->>'audiencePollVersion')::numeric>2147483647 OR jsonb_typeof(p->'contexts') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  PERFORM(p->>'pollId')::uuid;IF jsonb_array_length(p->'contexts')>10000 THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'contexts') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['studentId','classId','hubId']) OR v-ARRAY['studentId','classId','hubId']<>'{}'::jsonb OR jsonb_typeof(v->'studentId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'classId') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'hubId') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
   PERFORM(v->>'studentId')::uuid,(v->>'classId')::uuid,(v->>'hubId')::uuid;
  END LOOP;
  RETURN(SELECT count(*)=count(DISTINCT jsonb_build_array((x->>'studentId')::uuid,(x->>'classId')::uuid,(x->>'hubId')::uuid)) FROM jsonb_array_elements(p->'contexts') x);
 END IF;
 $branch$;
 EXECUTE replace(body,needle,needle||branch);
 body=pg_get_functiondef('public.report_result_guard()'::regprocedure);needle='public.report_result_context_valid(configuration->>''reportId'',NEW.authorization_context)';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'POLL_RESULT_BINDING_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'('||needle||' AND(CASE WHEN configuration->>''reportId''=''learning.polls.by-id'' THEN(NEW.authorization_context->>''pollId'')::uuid=(configuration#>>''{pathParameters,id}'')::uuid AND(NEW.authorization_context->>''formVersion'')::integer=(configuration#>>''{parameters,formVersion}'')::integer ELSE true END))');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 367 $$;

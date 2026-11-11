-- Add the report to existing native preset/job protocols;do not rewrite
-- old money,classifications,presets,archives or worker identities/privileges.
DO $$ DECLARE body text;r record;needle text;BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('public.report_preset_static_definition_valid(jsonb)','''finance.cash-movements'')','''finance.cash-movements'',''finance.cash-flow'')'),
 ('public.report_preset_definition_valid(jsonb)','WHEN ''finance.cash-movements'' THEN ARRAY[''from'',''through'']','WHEN ''finance.cash-movements'' THEN ARRAY[''from'',''through''] WHEN ''finance.cash-flow'' THEN ARRAY[''from'',''through'']'),
 ('public.report_job_guard()','''learning.polls.by-id'')','''learning.polls.by-id'',''finance.cash-flow'')'),
 ('public.report_job_preset_guard()','''finance.cash-movements'') THEN ARRAY[''from'',''through'']','''finance.cash-movements'',''finance.cash-flow'') THEN ARRAY[''from'',''through'']')
 ) changes(signature,old_text,new_text) LOOP
  body=pg_get_functiondef(r.signature::regprocedure);IF(length(body)-length(replace(body,r.old_text,'')))/length(r.old_text)<>1 THEN RAISE EXCEPTION 'CLASSIFIED_CASH_REPORT_BASE_CHANGED:%',r.signature;END IF;EXECUTE replace(body,r.old_text,r.new_text);
 END LOOP;
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);needle='IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM ''object'' THEN RETURN false;END IF;';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CLASSIFIED_CASH_CONTEXT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF report='finance.cash-flow' THEN
  IF NOT(p ?& ARRAY['kind','hubIds','includesGlobal']) OR p-ARRAY['kind','hubIds','includesGlobal']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'classified_cash' OR jsonb_typeof(p->'hubIds') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'includesGlobal') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  IF jsonb_array_length(p->'hubIds')>10000 OR(SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(p->'hubIds') x) THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'hubIds') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR(v#>>'{}')::uuid::text IS DISTINCT FROM v#>>'{}' THEN RETURN false;END IF;
  END LOOP;RETURN true;
 END IF;
 $branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 369 $$;

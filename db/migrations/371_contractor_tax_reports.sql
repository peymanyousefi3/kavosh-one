-- Extend existing report protocols without rewriting archived results or
-- changing native helper identities/owners/ACLs. Old workers skip this kind.
GRANT SELECT ON public.t4a_payment_records,public.t4a_payment_revisions TO kavosh_automation_worker;
DO $$ DECLARE body text;r record;needle text;BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('public.report_preset_static_definition_valid(jsonb)','''finance.cash-flow'')','''finance.cash-flow'',''payroll.t4a-working-paper'')'),
 ('public.report_job_guard()','''finance.cash-flow'')','''finance.cash-flow'',''payroll.t4a-working-paper'')')
 ) changes(signature,old_text,new_text) LOOP
  body=pg_get_functiondef(r.signature::regprocedure);IF(length(body)-length(replace(body,r.old_text,'')))/length(r.old_text)<>1 THEN RAISE EXCEPTION 'T4A_REPORT_BASE_CHANGED:%',r.signature;END IF;EXECUTE replace(body,r.old_text,r.new_text);
 END LOOP;
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);needle='IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM ''object'' THEN RETURN false;END IF;';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'T4A_REPORT_CONTEXT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF report='payroll.t4a-working-paper' THEN
  IF NOT(p?&ARRAY['kind','personId','employerId','taxYear','timeZone','postingIds']) OR p-ARRAY['kind','personId','employerId','taxYear','timeZone','postingIds']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 't4a_tax_year' OR jsonb_typeof(p->'personId') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'employerId') IS DISTINCT FROM 'string' OR(p->>'personId')::uuid::text IS DISTINCT FROM p->>'personId' OR(p->>'employerId')::uuid::text IS DISTINCT FROM p->>'employerId' OR jsonb_typeof(p->'taxYear') IS DISTINCT FROM 'number' OR p->>'taxYear'!~'^[1-9][0-9]{3}$' OR(p->>'taxYear')::integer NOT BETWEEN 1900 AND 9999 OR jsonb_typeof(p->'timeZone') IS DISTINCT FROM 'string' OR length(p->>'timeZone') NOT BETWEEN 1 AND 100 OR p->>'timeZone'!~'^[A-Za-z0-9_+./-]+$' OR jsonb_typeof(p->'postingIds') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(p->'postingIds')>500 OR(SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(p->'postingIds') x) THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'postingIds') LOOP IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR(v#>>'{}')::uuid::text IS DISTINCT FROM v#>>'{}' THEN RETURN false;END IF;END LOOP;RETURN true;
 END IF;
 $branch$);
 body=pg_get_functiondef('public.finish_report_job(uuid,uuid,text,text,text,text,jsonb)'::regprocedure);needle='NOT public.report_result_context_valid(j.configuration->>''reportId'',p_context)';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'T4A_REPORT_BROKER_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'('||needle||' OR(j.configuration->>''reportId''=''payroll.t4a-working-paper'' AND(p_context->>''personId'' IS DISTINCT FROM j.configuration#>>''{parameters,personId}'' OR p_context->>''employerId'' IS DISTINCT FROM j.configuration#>>''{parameters,employerId}'' OR p_context->>''taxYear'' IS DISTINCT FROM j.configuration#>>''{parameters,taxYear}'' OR p_context->>''timeZone'' IS DISTINCT FROM j.configuration#>>''{parameters,timeZone}'')))');
 body=pg_get_functiondef('public.report_result_guard()'::regprocedure);needle='public.report_result_context_valid(configuration->>''reportId'',NEW.authorization_context)';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'T4A_REPORT_RESULT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'('||needle||' AND(configuration->>''reportId''<>''payroll.t4a-working-paper'' OR(NEW.authorization_context->>''personId''=configuration#>>''{parameters,personId}'' AND NEW.authorization_context->>''employerId''=configuration#>>''{parameters,employerId}'' AND NEW.authorization_context->>''taxYear''=configuration#>>''{parameters,taxYear}'' AND NEW.authorization_context->>''timeZone''=configuration#>>''{parameters,timeZone}'')))');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 371 $$;

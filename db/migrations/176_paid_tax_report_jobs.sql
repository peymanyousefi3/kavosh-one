-- Retained bytes require both the private worker tax profile and every
-- original posting/source/funding binding,including unresolved/corrected rows.
DO $$ DECLARE body text;needle text;branch text;BEGIN
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);
 needle=' IF report IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'') THEN';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAID_TAX_CONTEXT_BASE_UNEXPECTED';END IF;
 branch=$branch$ IF report='payroll.paid-tax-year-to-date' THEN
  IF p-ARRAY['kind','profileId','postingIds']<>'{}'::jsonb OR NOT(p ?& ARRAY['kind','profileId','postingIds']) OR p->>'kind' IS DISTINCT FROM 'paid_tax_year' OR jsonb_typeof(p->'profileId') IS DISTINCT FROM 'string' OR p->>'profileId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR jsonb_typeof(p->'postingIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'postingIds')>500 THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'postingIds') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR(v#>>'{}')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false;END IF;
  END LOOP;
  RETURN(SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(p->'postingIds'));
 END IF;
$branch$;
 EXECUTE replace(body,needle,branch||needle);
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);needle='NOT IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'',''payroll.gross-accruals'',''community.achievements'',''payroll.settlements'',''payroll.remittances'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAID_TAX_JOB_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'NOT IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'',''payroll.gross-accruals'',''community.achievements'',''payroll.settlements'',''payroll.remittances'',''payroll.paid-tax-year-to-date'')');
 body=pg_get_functiondef('public.report_job_preset_guard()'::regprocedure);needle='WHEN NEW.configuration->>''reportId'' IN(''payroll.gross-accruals'',''payroll.settlements'',''payroll.remittances'') THEN ARRAY[''on'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAID_TAX_JOB_WINDOW_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,needle||' WHEN NEW.configuration->>''reportId''=''payroll.paid-tax-year-to-date'' THEN ARRAY[''through'',''timeZone'']');
 -- A well-shaped manifest for another profile must not be accepted for this
 -- job,even through the result broker independently of application checks.
 body=pg_get_functiondef('public.finish_report_job(uuid,uuid,text,text,text,text,jsonb)'::regprocedure);needle='NOT public.report_result_context_valid(j.configuration->>''reportId'',p_context)';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAID_TAX_BROKER_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'('||needle||' OR(j.configuration->>''reportId''=''payroll.paid-tax-year-to-date'' AND p_context->>''profileId'' IS DISTINCT FROM j.configuration#>>''{parameters,profileId}''))');
 body=pg_get_functiondef('public.report_result_guard()'::regprocedure);needle='public.report_result_context_valid(configuration->>''reportId'',NEW.authorization_context)';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAID_TAX_RESULT_GUARD_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'('||needle||' AND(configuration->>''reportId''<>''payroll.paid-tax-year-to-date'' OR NEW.authorization_context->>''profileId''=configuration#>>''{parameters,profileId}''))');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 176 $$;

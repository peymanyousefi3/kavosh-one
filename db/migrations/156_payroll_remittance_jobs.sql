-- Exact retained parent IDs reconstruct original work/account bindings and all
-- immutable remittance funding/method/payee history;not a hub-only substitute.
DO $$ DECLARE body text;needle text;branch text;BEGIN
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);
 needle=' IF report IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'') THEN';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'REMITTANCE_CONTEXT_BASE_UNEXPECTED';END IF;
 branch=$branch$ IF report='payroll.remittances' THEN
  IF p-ARRAY['kind','postingIds']<>'{}'::jsonb OR NOT(p ?& ARRAY['kind','postingIds']) OR p->>'kind' IS DISTINCT FROM 'payroll_remittance' OR jsonb_typeof(p->'postingIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'postingIds')>10000 THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'postingIds') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR(v#>>'{}')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false;END IF;
  END LOOP;
  RETURN(SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(p->'postingIds'));
 END IF;
$branch$;
 EXECUTE replace(body,needle,branch||needle);
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);needle='NOT IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'',''payroll.gross-accruals'',''community.achievements'',''payroll.settlements'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'REMITTANCE_JOB_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'NOT IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'',''payroll.gross-accruals'',''community.achievements'',''payroll.settlements'',''payroll.remittances'')');
 body=pg_get_functiondef('public.report_job_preset_guard()'::regprocedure);needle='WHEN NEW.configuration->>''reportId'' IN(''payroll.gross-accruals'',''payroll.settlements'') THEN ARRAY[''on'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'REMITTANCE_WINDOW_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'WHEN NEW.configuration->>''reportId'' IN(''payroll.gross-accruals'',''payroll.settlements'',''payroll.remittances'') THEN ARRAY[''on'']');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 156 $$;

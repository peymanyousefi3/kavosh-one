-- Reuse the existing requester-bound lease,source-context,archive,preset and
-- scheduling protocol. No ledger/result rewrite or new runtime privileges.
DO $$ DECLARE body text;r record;BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('public.report_job_guard()','''finance.counterparty-statement'')','''finance.counterparty-statement'',''finance.cash-movements'')'),
 ('public.report_job_preset_guard()','''finance.counterparty-statement'') THEN ARRAY[''from'',''through'']','''finance.counterparty-statement'',''finance.cash-movements'') THEN ARRAY[''from'',''through'']'),
 ('public.report_result_context_valid(text,jsonb)','IF report IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'') THEN','IF report IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'',''finance.cash-movements'') THEN')
 ) changes(signature,old_text,new_text) LOOP
  body=pg_get_functiondef(r.signature::regprocedure);
  IF(length(body)-length(replace(body,r.old_text,'')))/length(r.old_text)<>1 THEN RAISE EXCEPTION 'CASH_MOVEMENT_JOB_BASE_CHANGED:%',r.signature;END IF;
  EXECUTE replace(body,r.old_text,r.new_text);
 END LOOP;
END $$;
-- Older deployed workers must not claim a new report and cancel it merely
-- because their application does not implement that report. Freeze the legacy
-- one-argument entry to its known types; new workers explicitly advertise the
-- types they implement. Preserve all existing lease/reaper/issue behavior.
DO $$ DECLARE body text;current_body text;needle text;owner_name text;r record;legacy text;BEGIN
 body=pg_get_functiondef('public.claim_report_job(uuid[])'::regprocedure);
 needle='j.academy_id=ANY(academies)';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>2
 OR position('public.claim_report_job(academies uuid[])' IN body)=0
 OR position('IF academies IS NULL' IN body)=0 THEN RAISE EXCEPTION 'CASH_JOB_CLAIM_BASE_CHANGED';END IF;
 current_body=replace(body,'public.claim_report_job(academies uuid[])','public.claim_report_job(academies uuid[], supported_reports text[])');
 current_body=replace(current_body,needle,needle||' AND j.configuration->>''reportId''=ANY(supported_reports)');
 current_body=replace(current_body,'IF academies IS NULL','IF supported_reports IS NULL OR cardinality(supported_reports) NOT BETWEEN 1 AND 100 OR array_position(supported_reports,NULL) IS NOT NULL OR cardinality(supported_reports)<>(SELECT count(DISTINCT v) FROM unnest(supported_reports) v) THEN RAISE EXCEPTION ''INVALID_SUPPORTED_REPORT_LIST'';END IF; IF academies IS NULL');
 EXECUTE current_body;
 SELECT role.rolname INTO owner_name FROM pg_proc f JOIN pg_roles role ON role.oid=f.proowner WHERE f.oid='public.claim_report_job(uuid[])'::regprocedure;
 EXECUTE format('ALTER FUNCTION public.claim_report_job(uuid[],text[]) OWNER TO %I',owner_name);
 REVOKE ALL ON FUNCTION public.claim_report_job(uuid[],text[]) FROM PUBLIC;
 FOR r IN SELECT DISTINCT role.rolname FROM pg_proc f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl JOIN pg_roles role ON role.oid=acl.grantee WHERE f.oid='public.claim_report_job(uuid[])'::regprocedure AND acl.privilege_type='EXECUTE' LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.claim_report_job(uuid[],text[]) TO %I',r.rolname);
 END LOOP;
 legacy=$legacy$ARRAY['finance.counterparty-statement','finance.profitability','finance.manual-income-costs','payroll.costs','finance.tuition-income','finance.expense-costs','learning.student-performance','finance.trial-balance','finance.profit-loss','finance.balance-sheet','payroll.gross-accruals','community.achievements','payroll.settlements','payroll.remittances','payroll.paid-tax-year-to-date','payroll.t4-working-paper']::text[]$legacy$;
 EXECUTE replace(body,needle,needle||' AND j.configuration->>''reportId''=ANY('||legacy||')');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 363 $$;

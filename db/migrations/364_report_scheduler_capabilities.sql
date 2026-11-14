-- A previous application must not claim a new report schedule and pause it
-- because that binary does not implement its report. Filter BOTH new leases
-- and exhausted-work cleanup by the exact pinned preset edition.
DO $$ DECLARE body text;next_body text;needle text;filter text;legacy text;owner_name text;r record;BEGIN
 body=pg_get_functiondef('public.claim_report_schedule(uuid[])'::regprocedure);
 needle='source.academy_id=ANY(academies)';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>2
 OR position('public.claim_report_schedule(academies uuid[])' IN body)=0
 OR position('IF academies IS NULL' IN body)=0 THEN RAISE EXCEPTION 'REPORT_SCHEDULER_CLAIM_BASE_CHANGED';END IF;
 -- The reviewed immutable snapshot already pins the exact preset definition.
 -- Do not widen preset RLS to allow cross-school reads before actor binding.
 filter=$filter$ AND EXISTS(SELECT 1 FROM public.report_schedule_revisions sr WHERE sr.academy_id=source.academy_id AND sr.schedule_id=source.id AND sr.version=source.version AND sr.source_snapshot#>>'{presetDefinition,reportId}'=ANY(supported_reports))$filter$;
 next_body=replace(body,'public.claim_report_schedule(academies uuid[])','public.claim_report_schedule(academies uuid[], supported_reports text[])');
 next_body=replace(next_body,needle,needle||filter);
 next_body=replace(next_body,'IF academies IS NULL','IF supported_reports IS NULL OR cardinality(supported_reports) NOT BETWEEN 1 AND 100 OR array_position(supported_reports,NULL) IS NOT NULL OR cardinality(supported_reports)<>(SELECT count(DISTINCT v) FROM unnest(supported_reports) v) THEN RAISE EXCEPTION ''INVALID_SUPPORTED_REPORT_LIST'';END IF; IF academies IS NULL');
 EXECUTE next_body;
 SELECT role.rolname INTO owner_name FROM pg_proc f JOIN pg_roles role ON role.oid=f.proowner WHERE f.oid='public.claim_report_schedule(uuid[])'::regprocedure;
 EXECUTE format('ALTER FUNCTION public.claim_report_schedule(uuid[],text[]) OWNER TO %I',owner_name);
 REVOKE ALL ON FUNCTION public.claim_report_schedule(uuid[],text[]) FROM PUBLIC;
 FOR r IN SELECT DISTINCT role.rolname FROM pg_proc f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl JOIN pg_roles role ON role.oid=acl.grantee WHERE f.oid='public.claim_report_schedule(uuid[])'::regprocedure AND acl.privilege_type='EXECUTE' LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.claim_report_schedule(uuid[],text[]) TO %I',r.rolname);
 END LOOP;
 legacy=$legacy$ARRAY['finance.counterparty-statement','finance.profitability','finance.manual-income-costs','payroll.costs','finance.tuition-income','finance.expense-costs','learning.student-performance','finance.trial-balance','finance.profit-loss','finance.balance-sheet','payroll.gross-accruals','community.achievements','payroll.settlements','payroll.remittances','payroll.paid-tax-year-to-date','payroll.t4-working-paper']::text[]$legacy$;
 EXECUTE replace(body,needle,needle||replace(filter,'ANY(supported_reports)','ANY('||legacy||')'));
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 364 $$;

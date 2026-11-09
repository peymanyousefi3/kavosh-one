-- Fresh statistics allowed a flattened corrective join to probe journal lines
-- by tenant/line-number WITHOUT its journal key. Preserve the exact existing
-- signed events while keeping each original/reversal journal and line lookup
-- bounded to its real composite key. OFFSET0 is a deliberate planner fence,
-- not a row limit,permission bypass or longer timeout.
CREATE OR REPLACE VIEW public.counterparty_balance_events WITH(security_invoker=true) AS
 SELECT t.academy_id,t.payee_id,t.payee_version,t.journal_id,t.line_number,t.category,j.posted_on,l.account_id,a.currency_id,u.unit_scale,CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END AS delta_minor
 FROM public.finance_journal_counterparties t
 JOIN LATERAL(SELECT j.id,j.posted_on FROM public.finance_journals j WHERE j.academy_id=t.academy_id AND j.id=t.journal_id OFFSET 0) j ON true
 JOIN LATERAL(SELECT l.account_id,l.side,l.amount_minor,l.academy_id FROM public.finance_journal_lines l WHERE l.academy_id=t.academy_id AND l.journal_id=t.journal_id AND l.line_number=t.line_number OFFSET 0) l ON true
 JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id
 JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version
 UNION ALL
 SELECT t.academy_id,t.payee_id,t.payee_version,j.id,t.line_number,t.category,j.posted_on,l.account_id,a.currency_id,u.unit_scale,CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END
 FROM public.finance_journal_counterparties t
 JOIN LATERAL(SELECT j.id,j.posted_on FROM public.finance_journals j WHERE j.academy_id=t.academy_id AND j.reverses_id=t.journal_id OFFSET 0) j ON true
 JOIN LATERAL(SELECT l.account_id,l.side,l.amount_minor,l.academy_id FROM public.finance_journal_lines l WHERE l.academy_id=t.academy_id AND l.journal_id=j.id AND l.line_number=t.line_number OFFSET 0) l ON true
 JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id
 JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version;
-- Compute the unchanged whole-journal permission test once per DISTINCT
-- original journal,not once per tagged line or a flattened outer join pair.
-- Keep the raw output columns and every downstream monetary/fingerprint CTE.
DO $optimize$
DECLARE signature text;definition text;source text;permission text;old_from text;ctes text;marker text:=' raw AS MATERIALIZED(';
BEGIN
 permission=$permission$NOT EXISTS(SELECT 1 FROM(SELECT DISTINCT a.hub_id FROM public.finance_journal_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id WHERE l.academy_id=e.academy_id AND l.journal_id=e.journal_id) contexts CROSS JOIN(VALUES ('counterparty-balances.view'),('financial-reports.view'),('journals.view'),('accounts.view'),('ledger.view')) cap(name) WHERE public.scope_contains($4::jsonb->cap.name,jsonb_build_object('all',contexts.hub_id IS NULL,'hubs',CASE WHEN contexts.hub_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(contexts.hub_id) END)) IS NOT TRUE) allowed$permission$;
 old_from=$from$FROM public.counterparty_balance_events e JOIN public.finance_journals j ON j.academy_id=e.academy_id AND j.id=e.journal_id WHERE e.academy_id=(SELECT academy_id FROM party) AND e.payee_id=$1 AND e.posted_on<=$3::date AND $3::date-$2::date<=3660 AND($10::uuid[] IS NULL OR e.currency_id=ANY($10))$from$;
 ctes=$ctes$ manual_sources AS MATERIALIZED(SELECT e.* FROM public.counterparty_balance_events e WHERE e.academy_id=(SELECT academy_id FROM party) AND e.payee_id=$1 AND e.posted_on<=$3::date AND $3::date-$2::date<=3660 AND($10::uuid[] IS NULL OR e.currency_id=ANY($10)) LIMIT 200001),
 manual_permissions AS MATERIALIZED(SELECT m.academy_id,m.journal_id,$ctes$||replace(permission,'e.','m.')||$ctes$ FROM(SELECT DISTINCT academy_id,journal_id FROM manual_sources) m),
 raw AS MATERIALIZED($ctes$;
 FOREACH signature IN ARRAY ARRAY[
  'public.counterparty_statement_snapshot(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)',
  'public.counterparty_statement_snapshot_read(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)',
  'public.counterparty_statement_export_snapshot_read(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)',
  'public.counterparty_report_capture_rows(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)'
 ] LOOP
  definition=pg_get_functiondef(signature::regprocedure);SELECT prosrc INTO source FROM pg_proc WHERE oid=signature::regprocedure;
  IF(length(source)-length(replace(source,permission,'')))/length(permission)<>1 OR(length(source)-length(replace(source,old_from,'')))/length(old_from)<>1 OR(length(source)-length(replace(source,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'COUNTERPARTY_POINT_SOURCE_BASE_CHANGED:%',signature;END IF;
  source=replace(source,permission,'permissions.allowed');source=replace(source,old_from,'FROM manual_sources e JOIN public.finance_journals j ON j.academy_id=e.academy_id AND j.id=e.journal_id JOIN manual_permissions permissions ON permissions.academy_id=e.academy_id AND permissions.journal_id=e.journal_id');source=replace(source,marker,ctes);
  SELECT replace(definition,prosrc,source) INTO definition FROM pg_proc WHERE oid=signature::regprocedure;EXECUTE definition;
 END LOOP;
END $optimize$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 287 $$;

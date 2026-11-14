-- Owner inspection remains a fixed, read-only, privately audited projection.
-- Reuse the column-limited financial grants from399; no new table authority.
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
CREATE FUNCTION platform_private.read_account_ledger(p_user uuid,p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE school uuid;account uuid;start_on date;end_on date;cursor_on date;cursor_journal uuid;cursor_line integer;lim integer:=50;access_reason text;k text;data jsonb;page jsonb;next_cursor jsonb;BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>4096
  OR(p_input-'academyId'-'accountId'-'purpose'-'from'-'through'-'limit'-'afterPostedOn'-'afterJournalId'-'afterLineNumber')<>'{}'::jsonb
  OR jsonb_typeof(p_input->'purpose') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'purpose')) NOT BETWEEN 1 AND 500 OR(p_input->>'purpose')~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 FOREACH k IN ARRAY ARRAY['academyId','accountId'] LOOP
  IF jsonb_typeof(p_input->k) IS DISTINCT FROM 'string' OR p_input->>k!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['from','through'] LOOP
  IF jsonb_typeof(p_input->k) IS DISTINCT FROM 'string' OR p_input->>k!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR p_input->>k<'0001-01-01' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 END LOOP;
 IF p_input?'limit' THEN
  IF jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^[0-9]{1,3}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  lim=(p_input->>'limit')::integer;IF lim NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 END IF;
 IF num_nonnulls(p_input->'afterPostedOn',p_input->'afterJournalId',p_input->'afterLineNumber') NOT IN(0,3) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 IF p_input?'afterPostedOn' THEN
  IF jsonb_typeof(p_input->'afterPostedOn') IS DISTINCT FROM 'string' OR p_input->>'afterPostedOn'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   OR jsonb_typeof(p_input->'afterJournalId') IS DISTINCT FROM 'string' OR p_input->>'afterJournalId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(p_input->'afterLineNumber') IS DISTINCT FROM 'number' OR p_input->>'afterLineNumber'!~'^[0-9]{1,3}$'
  THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  cursor_journal=(p_input->>'afterJournalId')::uuid;cursor_line=(p_input->>'afterLineNumber')::integer;
  IF cursor_line NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 END IF;
 BEGIN
  start_on=(p_input->>'from')::date;end_on=(p_input->>'through')::date;cursor_on=(p_input->>'afterPostedOn')::date;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END;
 IF start_on>end_on OR(cursor_on IS NOT NULL AND cursor_on NOT BETWEEN start_on AND end_on) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 school=(p_input->>'academyId')::uuid;account=(p_input->>'accountId')::uuid;access_reason=btrim(p_input->>'purpose');
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=school) THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 PERFORM set_config('app.academy_id',school::text,true);
 -- Totals and the visible page use ONE statement snapshot. Pagination never
 -- limits totals or invents bank verification. Each account retains its own
 -- original currency edition; no cross-currency/precision netting occurs.
 WITH selected AS MATERIALIZED(
  SELECT a.id,a.hub_id AS "hubId",a.version,a.code,r.name,r.kind,r.normal_balance AS "normalBalance",r.active,
   a.currency_id AS "currencyId",a.currency_version AS "currencyVersion",c.code AS "currencyCode",u.unit_scale AS "unitScale"
  FROM public.finance_accounts a JOIN public.finance_account_revisions r ON r.academy_id=a.academy_id AND r.account_id=a.id AND r.version=a.version
  JOIN public.finance_currencies c ON c.academy_id=a.academy_id AND c.id=a.currency_id
  JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version
  WHERE a.academy_id=school AND a.id=account
 ),source AS MATERIALIZED(
  SELECT l.journal_id AS "journalId",l.line_number AS "lineNumber",l.account_version AS "accountVersion",l.side,l.amount_minor,l.note,
   j.posted_on,j.description,j.reference,j.purpose,j.reverses_id AS "reversesId",r.code AS "accountCode",r.name AS "accountName",
   j.id IS NULL OR r.account_id IS NULL OR l.side NOT IN('debit','credit') OR l.amount_minor<>trunc(l.amount_minor) OR l.amount_minor<=0 OR l.amount_minor>=1e38 OR l.line_number NOT BETWEEN 1 AND j.line_count invalid
  FROM public.finance_journal_lines l
  LEFT JOIN public.finance_journals j ON j.academy_id=l.academy_id AND j.id=l.journal_id
  LEFT JOIN public.finance_account_revisions r ON r.academy_id=l.academy_id AND r.account_id=l.account_id AND r.version=l.account_version
  WHERE l.academy_id=school AND l.account_id=account AND(j.posted_on<=end_on OR j.id IS NULL)
 ),totals AS(
  SELECT count(*)::text AS "sourceEntryCount",count(*) FILTER(WHERE posted_on>=start_on)::text AS "windowEntryCount",coalesce(bool_or(invalid),false) invalid,
   trunc(coalesce(sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END) FILTER(WHERE posted_on<start_on),0))::text AS "openingDebitNetMinor",
   trunc(coalesce(sum(amount_minor) FILTER(WHERE posted_on>=start_on AND side='debit'),0))::text AS "periodDebitMinor",
   trunc(coalesce(sum(amount_minor) FILTER(WHERE posted_on>=start_on AND side='credit'),0))::text AS "periodCreditMinor",
   trunc(coalesce(sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END),0))::text AS "closingDebitNetMinor"
  FROM source
 ),shown AS(
  SELECT "journalId","lineNumber","accountVersion",side,trunc(amount_minor)::text AS "amountMinor",note,posted_on::text AS "postedOn",description,reference,purpose,"reversesId","accountCode","accountName"
  FROM source WHERE posted_on>=start_on AND(cursor_on IS NULL OR(posted_on,"journalId","lineNumber")>(cursor_on,cursor_journal,cursor_line))
  ORDER BY posted_on,"journalId","lineNumber" LIMIT lim+1
 )
 SELECT jsonb_build_object('account',(SELECT to_jsonb(s) FROM selected s),'totals',(SELECT to_jsonb(t) FROM totals t),
  'entries',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY "postedOn","journalId","lineNumber") FROM shown s),'[]'::jsonb),'snapshotAt',statement_timestamp()) INTO data;
 IF data->'account'='null'::jsonb THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF(data#>>'{totals,invalid}')::boolean OR octet_length(data::text)>1048576 THEN RAISE EXCEPTION 'PLATFORM_FINANCIAL_SOURCE_UNAVAILABLE' USING ERRCODE='55000';END IF;
 page=data->'entries';
 IF jsonb_array_length(page)>lim THEN
  next_cursor=jsonb_build_object('afterPostedOn',page->(lim-1)->>'postedOn','afterJournalId',page->(lim-1)->>'journalId','afterLineNumber',(page->(lim-1)->>'lineNumber')::integer);
  page=page-lim;
 END IF;
 data=jsonb_set(jsonb_set(data,'{entries}',page),'{totals}',(data->'totals')-'invalid');
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data,reason)
  VALUES(p_user,p_session,'platform.academy.account-ledger.read',school,jsonb_build_object('accountId',account,'from',start_on,'through',end_on,'entryCount',jsonb_array_length(page),'scope','platform_owner_read_only'),access_reason);
 RETURN jsonb_build_object('status',200,'body',jsonb_build_object('academyId',school,'data',data,'from',start_on,'through',end_on,'nextCursor',next_cursor,
  'scope','platform_owner_read_only','source','immutable_posted_account_lines','totalsBasis','complete_account_window_at_statement_snapshot','paginationBasis','live_keyset_each_request',
  'bankVerified',false,'currencyConversion','none','wholeJournalIntegrityVerified',false,'paymentExecuted',false,'additionalLedgerPosting',false));
END $$;
ALTER FUNCTION platform_private.read_account_ledger(uuid,uuid,jsonb) OWNER TO kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.read_account_ledger(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
DO $$ DECLARE body text;needle text:='PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ACCOUNT_LEDGER_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF p_operation='academies.account-ledger' THEN
  IF p_key IS NOT NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  RETURN platform_private.read_account_ledger(p_user,p_session,p_input);
 END IF;
$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 401 $$;

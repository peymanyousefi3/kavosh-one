-- Read-only operator inspection extends the existing owner boundary. No school
-- membership,posting authority,bank credential or permissive RLS policy.
GRANT SELECT(academy_id,id,hub_id,currency_id,currency_version,code,version) ON public.finance_accounts TO kavosh_platform_policy;
GRANT SELECT(academy_id,account_id,version,code,name,description,kind,normal_balance,operational_role,active) ON public.finance_account_revisions TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,code) ON public.finance_currencies TO kavosh_platform_policy;
GRANT SELECT(academy_id,currency_id,version,unit_scale,symbol) ON public.finance_currency_revisions TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,period_id,period_version,posted_on,description,reference,line_count,reverses_id,posted_by,approval_id,created_at,purpose,closing_run_id) ON public.finance_journals TO kavosh_platform_policy;
GRANT SELECT(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor,note) ON public.finance_journal_lines TO kavosh_platform_policy;

DO $$ DECLARE body text;needle text;replacement text;BEGIN
 body=pg_get_functiondef('platform_private.read_academy_directory(uuid,uuid,jsonb)'::regprocedure);
 needle='NOT IN(''hubs'',''people'',''courses'',''classes'',''students'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'FINANCIAL_DIRECTORY_VALIDATION_CHANGED';END IF;
 body=replace(body,needle,'NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'')');
 needle=' ELSIF collection=''classes'' THEN';replacement=$branch$
 ELSIF collection='finance-accounts' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(
   SELECT a.id,a.hub_id AS "hubId",a.code,a.version,r.name,r.description,r.kind,r.normal_balance AS "normalBalance",r.operational_role AS "operationalRole",r.active,a.currency_id AS "currencyId",a.currency_version AS "currencyVersion",c.code AS "currencyCode",u.unit_scale AS "unitScale",u.symbol AS "currencySymbol"
   FROM public.finance_accounts a JOIN public.finance_account_revisions r ON r.academy_id=a.academy_id AND r.account_id=a.id AND r.version=a.version
   JOIN public.finance_currencies c ON c.academy_id=a.academy_id AND c.id=a.currency_id
   JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version
   WHERE a.academy_id=school AND(after_id IS NULL OR a.id>after_id) ORDER BY a.id LIMIT page_limit+1)r;
 ELSIF collection='finance-journals' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(
   SELECT j.id,j.period_id AS "periodId",j.period_version AS "periodVersion",j.posted_on::text AS "postedOn",j.purpose,j.description,j.reference,j.line_count AS "lineCount",j.reverses_id AS "reversesId",j.posted_by AS "postedBy",j.approval_id AS "approvalId",j.created_at AS "createdAt",
    (SELECT x.id FROM public.finance_journals x WHERE x.academy_id=school AND x.reverses_id=j.id) AS "reversedById"
   FROM public.finance_journals j WHERE j.academy_id=school AND(after_id IS NULL OR j.id>after_id) ORDER BY j.id LIMIT page_limit+1)r;
$branch$||needle;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'FINANCIAL_DIRECTORY_PROJECTION_CHANGED';END IF;
 EXECUTE replace(body,needle,replacement);
END $$;

GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
CREATE FUNCTION platform_private.read_academy_journal(p_user uuid,p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE school uuid;journal uuid;purpose text;header jsonb;lines jsonb;BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>4096 OR(p_input-'academyId'-'journalId'-'purpose')<>'{}'::jsonb
  OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(p_input->'journalId') IS DISTINCT FROM 'string' OR p_input->>'journalId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(p_input->'purpose') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'purpose')) NOT BETWEEN 1 AND 500 OR(p_input->>'purpose')~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 school=(p_input->>'academyId')::uuid;journal=(p_input->>'journalId')::uuid;purpose=btrim(p_input->>'purpose');
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=school) THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 PERFORM set_config('app.academy_id',school::text,true);
 SELECT to_jsonb(r) INTO header FROM(
  SELECT j.id,j.period_id AS "periodId",j.period_version AS "periodVersion",j.posted_on::text AS "postedOn",j.purpose,j.closing_run_id AS "closingRunId",j.description,j.reference,j.line_count AS "lineCount",j.reverses_id AS "reversesId",j.posted_by AS "postedBy",j.approval_id AS "approvalId",j.created_at AS "createdAt",
   (SELECT x.id FROM public.finance_journals x WHERE x.academy_id=school AND x.reverses_id=j.id) AS "reversedById"
  FROM public.finance_journals j WHERE j.academy_id=school AND j.id=journal)r;
 IF header IS NULL THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r."lineNumber"),'[]') INTO lines FROM(
  SELECT l.line_number AS "lineNumber",l.account_id AS "accountId",l.account_version AS "accountVersion",l.side,trunc(l.amount_minor)::text AS "amountMinor",l.note,a.hub_id AS "hubId",a.currency_id AS "currencyId",a.currency_version AS "currencyVersion",c.code AS "currencyCode",u.unit_scale AS "unitScale",r.code AS "accountCode",r.name AS "accountName"
  FROM public.finance_journal_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id
  JOIN public.finance_account_revisions r ON r.academy_id=l.academy_id AND r.account_id=l.account_id AND r.version=l.account_version
  JOIN public.finance_currencies c ON c.academy_id=a.academy_id AND c.id=a.currency_id
  JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version
  WHERE l.academy_id=school AND l.journal_id=journal AND l.amount_minor=trunc(l.amount_minor) AND l.amount_minor>0 AND l.amount_minor<1e38 ORDER BY l.line_number LIMIT 201)r;
 IF jsonb_array_length(lines)<>(header->>'lineCount')::integer OR jsonb_array_length(lines) NOT BETWEEN 2 AND 200
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(lines) WITH ORDINALITY AS e(line,n) WHERE(line->>'lineNumber')::integer<>n)
  OR octet_length((header||jsonb_build_object('lines',lines))::text)>1048576 THEN RAISE EXCEPTION 'PLATFORM_FINANCIAL_SOURCE_UNAVAILABLE' USING ERRCODE='55000';END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data,reason)
  VALUES(p_user,p_session,'platform.academy.journal.read',school,jsonb_build_object('journalId',journal,'lineCount',jsonb_array_length(lines),'scope','platform_owner_read_only'),purpose);
 RETURN jsonb_build_object('status',200,'body',jsonb_build_object('academyId',school,'data',header||jsonb_build_object('lines',lines),'scope','platform_owner_read_only','source','immutable_posted_journal','counterpartyDetailsIncluded',false,'paymentExecuted',false,'additionalLedgerPosting',false));
END $$;
ALTER FUNCTION platform_private.read_academy_journal(uuid,uuid,jsonb) OWNER TO kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.read_academy_journal(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
DO $$ DECLARE body text;needle text:='PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'JOURNAL_INSPECTION_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF p_operation='academies.journal' THEN
  IF p_key IS NOT NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  RETURN platform_private.read_academy_journal(p_user,p_session,p_input);
 END IF;
$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 399 $$;

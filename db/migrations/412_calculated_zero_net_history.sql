-- Extend the existing immutable payroll proof,not a second calculation or
-- ledger. Read kernels stay STABLE and acquire no per-row worker/row locks.
CREATE OR REPLACE FUNCTION public.calculated_net_request_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE keys text[]:=ARRAY['periodId','expectedPeriodVersion','pensionableEarnings','insurableEarnings','noQuebecTransfer','noOtherSameEmployerPayments','eligibilityReview','fullyTaxableCashRemuneration','noBonusesOrOtherTaxAdjustments'];k text;BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF i->'noNonCashOrZeroNetPayments'='true'::jsonb AND NOT(i?'noOtherNonCashPayments') THEN keys=keys||ARRAY['noNonCashOrZeroNetPayments'];
 ELSIF i->'noOtherNonCashPayments'='true'::jsonb AND NOT(i?'noNonCashOrZeroNetPayments') THEN keys=keys||ARRAY['noOtherNonCashPayments'];ELSE RETURN false;END IF;
 IF NOT(i?&keys) OR i-keys<>'{}'::jsonb OR octet_length(i::text)>16384 OR jsonb_typeof(i->'periodId') IS DISTINCT FROM 'string' OR i->>'periodId'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(i->'expectedPeriodVersion') IS DISTINCT FROM 'number' OR i->>'expectedPeriodVersion'!~'^[1-9][0-9]{0,9}$' OR(i->>'expectedPeriodVersion')::bigint>2147483646 OR public.work_money_valid(i->'pensionableEarnings',2) IS NOT TRUE OR public.work_money_valid(i->'insurableEarnings',2) IS NOT TRUE OR jsonb_typeof(i->'eligibilityReview') IS DISTINCT FROM 'string' OR length(btrim(i->>'eligibilityReview')) NOT BETWEEN 1 AND 2000 OR i->>'eligibilityReview'~'[[:cntrl:]]' THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['noQuebecTransfer','noOtherSameEmployerPayments','fullyTaxableCashRemuneration','noBonusesOrOtherTaxAdjustments'] LOOP IF i->k IS DISTINCT FROM 'true'::jsonb THEN RETURN false;END IF;END LOOP;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.calculated_zero_net_history_ids(p_run uuid,i jsonb) RETURNS uuid[] LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE g record;calendar record;ids uuid[];BEGIN
 IF public.calculated_net_request_valid(i) IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT * INTO g FROM public.payrun_groups WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_run;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT r.definition,t.employer_id,t.person_id,t.tax_year INTO calendar FROM public.payroll_tax_period_revisions r JOIN public.payroll_tax_periods h ON h.academy_id=r.academy_id AND h.id=r.period_id JOIN public.payroll_tax_profiles t ON t.academy_id=h.academy_id AND t.id=h.profile_id WHERE r.academy_id=g.academy_id AND r.period_id=(i->>'periodId')::uuid AND r.version=(i->>'expectedPeriodVersion')::integer;
 IF NOT FOUND OR calendar.person_id<>g.person_id THEN RETURN NULL;END IF;
 SELECT coalesce(array_agg(candidate.id ORDER BY candidate.id),'{}'::uuid[]) INTO ids FROM(
  SELECT p.id FROM public.payrun_net_postings p JOIN public.payrun_groups old ON old.academy_id=p.academy_id AND old.id=p.run_id
  LEFT JOIN public.zero_net_settlements z ON z.academy_id=p.academy_id AND z.posting_id=p.id LEFT JOIN public.zero_net_settlement_revisions s ON s.academy_id=z.academy_id AND s.posting_id=z.posting_id AND s.version=z.version
  WHERE p.academy_id=g.academy_id AND old.id<>g.id AND old.person_id=g.person_id AND p.plan#>>'{net,amounts,netMinor}'='0'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(old.source_snapshot->'contexts') context WHERE context->>'employerId'=calendar.employer_id::text)
   AND(jsonb_array_length(old.source_snapshot->'contexts')=1 AND old.source_snapshot#>>'{contexts,0,classification}'='contractor' AND old.source_snapshot#>>'{contexts,0,reportingForm}' IN('T4A','T4A_NR')) IS NOT TRUE
   AND((p.reversal_id IS NULL AND old.planned_pay_on BETWEEN make_date(calendar.tax_year,1,1) AND g.planned_pay_on)
    OR(s.state='recorded' AND((s.definition->>'settledAt')::timestamptz AT TIME ZONE(calendar.definition->>'timeZone'))::date BETWEEN make_date(calendar.tax_year,1,1) AND g.planned_pay_on)
    OR EXISTS(SELECT 1 FROM public.zero_net_tax_revisions history WHERE history.academy_id=p.academy_id AND history.posting_id=p.id AND(history.source_snapshot#>>'{source,recognizedOn}')::date BETWEEN make_date(calendar.tax_year,1,1) AND g.planned_pay_on))
  ORDER BY p.id LIMIT 501
 ) candidate;RETURN ids;
END $$;
CREATE FUNCTION public.calculated_zero_net_history_read(p_run uuid,i jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE ids uuid[];g record;calendar record;history jsonb;history_bytes bigint;BEGIN
 ids=public.calculated_zero_net_history_ids(p_run,i);IF ids IS NULL THEN RETURN NULL;END IF;
 IF cardinality(ids)>500 THEN RETURN(SELECT jsonb_agg(jsonb_build_object('postingId',id,'budgetExceeded',true) ORDER BY id) FROM unnest(ids) id);END IF;
 SELECT * INTO g FROM public.payrun_groups WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_run;
 SELECT r.definition,h.profile_id,t.employer_id,t.tax_year INTO calendar FROM public.payroll_tax_period_revisions r JOIN public.payroll_tax_periods h ON h.academy_id=r.academy_id AND h.id=r.period_id JOIN public.payroll_tax_profiles t ON t.academy_id=h.academy_id AND t.id=h.profile_id WHERE r.academy_id=g.academy_id AND r.period_id=(i->>'periodId')::uuid AND r.version=(i->>'expectedPeriodVersion')::integer;
 -- Refuse large retained sources before computing live gross proofs/hashes.
 SELECT coalesce(sum(octet_length(p.plan::text)+coalesce(octet_length(s.definition::text),0)+coalesce(octet_length(s.source_snapshot::text),0)+coalesce(octet_length(r.definition::text),0)+coalesce(octet_length(r.source_snapshot::text),0)),0) INTO history_bytes
 FROM public.payrun_net_postings p LEFT JOIN public.zero_net_settlements z ON z.academy_id=p.academy_id AND z.posting_id=p.id LEFT JOIN public.zero_net_settlement_revisions s ON s.academy_id=z.academy_id AND s.posting_id=z.posting_id AND s.version=z.version LEFT JOIN public.zero_net_tax_records h ON h.academy_id=p.academy_id AND h.posting_id=p.id LEFT JOIN public.zero_net_tax_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version WHERE p.id=ANY(ids);
 IF history_bytes>2097152 THEN RETURN(SELECT jsonb_agg(jsonb_build_object('postingId',id,'budgetExceeded',true) ORDER BY id) FROM unnest(ids) id);END IF;
 WITH facts AS MATERIALIZED(
  SELECT p.id,p.reversal_id,p.plan,old.id run_id,old.cancellation_id,old.service_from,old.service_through,z.version financial_version,s.state financial_state,s.definition financial_definition,s.source_snapshot financial_snapshot,
   h.profile_id,r.version,r.settlement_version,r.state,r.definition,r.source_snapshot,
   ((s.definition->>'settledAt')::timestamptz AT TIME ZONE(calendar.definition->>'timeZone'))::date settled_on,(r.source_snapshot#>>'{source,recognizedOn}')::date recognized_on,
   public.payrun_net_source_read(old.id) live_source,past.version past_version,past.definition->>'provinceOfEmployment' past_province,
   CASE WHEN r.definition?'reportingAccount' THEN public.payroll_employer_default_binding((r.definition#>>'{reportingAccount,id}')::uuid,(r.definition#>>'{reportingAccount,version}')::integer,calendar.employer_id,(r.source_snapshot#>>'{source,recognizedOn}')::date)
    ||jsonb_build_object('businessNumberFingerprint',(SELECT encode(sha256(convert_to(jsonb_build_array(g.academy_id,left(a.account_number,9))::text,'UTF8')),'hex') FROM public.payroll_employer_accounts a WHERE a.academy_id=g.academy_id AND a.id=(r.definition#>>'{reportingAccount,id}')::uuid)) END reporting_binding
  FROM public.payrun_net_postings p JOIN public.payrun_groups old ON old.academy_id=p.academy_id AND old.id=p.run_id
  LEFT JOIN public.zero_net_settlements z ON z.academy_id=p.academy_id AND z.posting_id=p.id LEFT JOIN public.zero_net_settlement_revisions s ON s.academy_id=z.academy_id AND s.posting_id=z.posting_id AND s.version=z.version
  LEFT JOIN public.zero_net_tax_records h ON h.academy_id=p.academy_id AND h.posting_id=p.id LEFT JOIN public.zero_net_tax_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version
  LEFT JOIN LATERAL(SELECT version,definition FROM public.payroll_tax_profile_revisions t WHERE t.academy_id=g.academy_id AND t.profile_id=calendar.profile_id AND t.effective_on<=((s.definition->>'settledAt')::timestamptz AT TIME ZONE(calendar.definition->>'timeZone'))::date ORDER BY t.effective_on DESC,t.version DESC LIMIT 1) past ON true WHERE p.id=ANY(ids)
 ),classified AS(
  SELECT f.*,CASE
   WHEN((settled_on IS NOT NULL OR recognized_on IS NOT NULL) AND NOT coalesce(settled_on BETWEEN make_date(calendar.tax_year,1,1) AND g.planned_pay_on,false) AND NOT coalesce(recognized_on BETWEEN make_date(calendar.tax_year,1,1) AND g.planned_pay_on,false))
    OR(state='withdrawn' AND NOT coalesce(settled_on BETWEEN make_date(calendar.tax_year,1,1) AND g.planned_pay_on,false)) OR(reversal_id IS NOT NULL AND state IS DISTINCT FROM 'recorded') THEN 'corrected'
   WHEN state='recorded' AND definition IS NOT NULL AND profile_id=calendar.profile_id AND reversal_id IS NULL AND cancellation_id IS NULL AND financial_state='recorded' AND financial_version=settlement_version
    AND settled_on=recognized_on AND settled_on BETWEEN make_date(calendar.tax_year,1,1) AND g.planned_pay_on AND past_version IS NOT NULL AND past_province<>'QC'
    AND live_source IS NOT NULL AND live_source->'recordedSourcesCurrent'='true'::jsonb AND live_source->'cancellationId'='null'::jsonb AND live_source->>'runSourceSha256'=plan#>>'{source,runSourceSha256}'
    AND source_snapshot#>>'{source,settlementSha256}'=encode(sha256(convert_to(jsonb_build_array(financial_definition,financial_snapshot)::text,'UTF8')),'hex')
    AND(NOT(definition?'reportingAccount') OR(reporting_binding IS NOT NULL AND reporting_binding IS NOT DISTINCT FROM source_snapshot#>'{source,reportingAccount}')) THEN 'recognized'
   ELSE 'unresolved' END disposition FROM facts f
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('sourceKind','zero_net_settlement','postingId',id,'runId',run_id,'version',version,'settlementVersion',settlement_version,'currentSettlementVersion',financial_version,'state',state,'financialState',financial_state,'recognizedOn',recognized_on::text,'settledOn',settled_on::text,'postingReversalId',reversal_id,'pastTaxVersion',past_version,'disposition',disposition,
   'overlappingService',disposition='recognized' AND service_from<=g.service_through AND service_through>=g.service_from,
   'sourceStamp',encode(sha256(convert_to(jsonb_build_array(id,reversal_id,cancellation_id,financial_version,financial_definition,financial_snapshot,profile_id,version,settlement_version,state,definition,source_snapshot,live_source->>'runSourceSha256',live_source->'recordedSourcesCurrent',past_version,reporting_binding)::text,'UTF8')),'hex')) ORDER BY id),'[]'::jsonb) INTO history FROM classified;RETURN history;
END $$;
REVOKE ALL ON FUNCTION public.calculated_zero_net_history_ids(uuid,jsonb),public.calculated_zero_net_history_read(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calculated_zero_net_history_ids(uuid,jsonb),public.calculated_zero_net_history_read(uuid,jsonb) TO kavosh_runtime;
-- Surgical extension preserves original function identities and ACLs. The
-- unchanged legacy JSON is returned when there is no zero-net source at all.
DO $migration$ DECLARE body text;needle text;replacement text;zero_query text;BEGIN
 body=pg_get_functiondef('public.calculated_net_source_read(uuid,jsonb)'::regprocedure);
 needle='history jsonb;n integer;';IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ZERO_HISTORY_DECLARE_BASE_CHANGED';END IF;body=replace(body,needle,needle||'zero_history jsonb;reviewed_zero boolean;');
 needle=' s=public.payrun_net_source_read(p_run);';IF strpos(body,needle)=0 THEN RAISE EXCEPTION 'ZERO_HISTORY_SOURCE_BASE_CHANGED';END IF;body=replace(body,needle,' reviewed_zero=coalesce(i->''noOtherNonCashPayments''=''true''::jsonb,false);'||needle);
 SELECT line INTO STRICT needle FROM regexp_split_to_table(body,E'\n') line WHERE starts_with(line,' IF EXISTS(SELECT 1 FROM public.payrun_net_postings p JOIN public.payrun_groups old') AND strpos(line,'CALCULATED_NET_ZERO_NET_HISTORY_REVIEW_REQUIRED')>0;
 body=replace(body,needle,replace(needle,' IF EXISTS(',' IF NOT reviewed_zero AND EXISTS('));
 SELECT line INTO STRICT needle FROM regexp_split_to_table(body,E'\n') line WHERE starts_with(line,' RETURN jsonb_build_object(''request'',i,');
 replacement=$new$ IF reviewed_zero AND EXISTS(SELECT 1 FROM public.payrun_net_postings p JOIN public.zero_net_settlements z ON z.academy_id=p.academy_id AND z.posting_id=p.id WHERE p.academy_id=g.academy_id AND p.run_id=g.id) THEN RETURN jsonb_build_object('unavailable','CALCULATED_NET_CURRENT_ZERO_HISTORY_REVIEW_REQUIRED');END IF;
 zero_history=public.calculated_zero_net_history_read(p_run,i);IF zero_history IS NULL THEN RETURN jsonb_build_object('unavailable','CALCULATED_NET_ZERO_HISTORY_SOURCE_UNAVAILABLE');END IF;
 IF n+jsonb_array_length(zero_history)>500 OR EXISTS(SELECT 1 FROM jsonb_array_elements(zero_history) v WHERE v->'budgetExceeded'='true'::jsonb) THEN RETURN jsonb_build_object('unavailable','CALCULATED_NET_HISTORY_REQUIRES_BACKGROUND_JOB');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(zero_history) v WHERE v->>'disposition'='unresolved' OR(NOT reviewed_zero AND v->>'disposition'='recognized')) THEN RETURN jsonb_build_object('unavailable','CALCULATED_NET_ZERO_NET_HISTORY_REVIEW_REQUIRED');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(zero_history) v WHERE v->'overlappingService'='true'::jsonb) THEN RETURN jsonb_build_object('unavailable','CALCULATED_NET_ZERO_NET_OVERLAPPING_SERVICE_REVIEW_REQUIRED');END IF;
$new$||left(needle,length(needle)-1)||$new$||CASE WHEN reviewed_zero OR jsonb_array_length(zero_history)>0 THEN jsonb_build_object('zeroNetHistory',zero_history,'zeroNetHistoryCount',jsonb_array_length(zero_history),'zeroNetHistorySha256',encode(sha256(convert_to(zero_history::text,'UTF8')),'hex')) ELSE '{}'::jsonb END;$new$;
 EXECUTE replace(body,needle,replacement);
 body=pg_get_functiondef('public.calculated_net_history_allows(uuid,jsonb,jsonb)'::regprocedure);
 needle='ids uuid[];n integer;';IF strpos(body,needle)=0 THEN RAISE EXCEPTION 'ZERO_HISTORY_AUTHORITY_DECLARE_CHANGED';END IF;body=replace(body,needle,'ids uuid[];n integer;zero_ids uuid[];');
 zero_query=$zero$SELECT p.id FROM public.payrun_net_postings p JOIN public.payrun_groups old ON old.academy_id=p.academy_id AND old.id=p.run_id WHERE p.academy_id=current_run.academy_id AND old.id<>current_run.id AND old.person_id=current_run.person_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(old.source_snapshot->'contexts') context WHERE context->>'employerId'=current_run.source_snapshot#>>'{contexts,0,employerId}') AND NOT(jsonb_array_length(old.source_snapshot->'contexts')=1 AND old.source_snapshot#>>'{contexts,0,classification}'='contractor' AND old.source_snapshot#>>'{contexts,0,reportingForm}' IN('T4A','T4A_NR')) AND old.planned_pay_on BETWEEN DATE '2026-01-01' AND current_run.planned_pay_on AND p.reversal_id IS NULL AND p.plan#>>'{net,amounts,netMinor}'='0' ORDER BY p.id LIMIT 501$zero$;
 IF(length(body)-length(replace(body,zero_query,'')))/length(zero_query)<>1 THEN RAISE EXCEPTION 'ZERO_HISTORY_AUTHORITY_SELECTOR_CHANGED';END IF;
 body=replace(body,zero_query,'SELECT v.id FROM unnest(zero_ids) v(id)');
 needle=' SELECT array_agg(id),count(*) INTO ids,n FROM(';IF strpos(body,needle)=0 THEN RAISE EXCEPTION 'ZERO_HISTORY_AUTHORITY_PREFIX_CHANGED';END IF;
 EXECUTE replace(body,needle,' zero_ids=public.calculated_zero_net_history_ids(p_run,p_request);IF zero_ids IS NULL THEN RETURN false;END IF;'||E'\n'||needle);
END $migration$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 412 $$;

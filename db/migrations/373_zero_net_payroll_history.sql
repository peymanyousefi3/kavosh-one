-- A positive gross with fully offset net pay is still payroll history even
-- without a payment row. Unknown legal contexts require review;explicitly
-- separate contractor reporting contexts do not become employee earnings.
-- Extend the existing full-source authority predicate,not a weaker reader.
DO $migration$
DECLARE body text;needle text;replacement text;query text;prefix text:=' SELECT array_agg(id),count(*) INTO ids,n FROM(';zero_query text;
BEGIN
 body=pg_get_functiondef('public.calculated_net_source_read(uuid,jsonb)'::regprocedure);
 needle=$old$AND jsonb_array_length(old.source_snapshot->'contexts')=1 AND old.source_snapshot#>>'{contexts,0,employerId}'=period.employer_id::text AND old.source_snapshot#>>'{contexts,0,classification}'='employee' AND old.source_snapshot#>>'{contexts,0,countryCode}'='CA' AND old.planned_pay_on$old$;
 replacement=$new$AND EXISTS(SELECT 1 FROM jsonb_array_elements(old.source_snapshot->'contexts') context WHERE context->>'employerId'=period.employer_id::text) AND NOT(jsonb_array_length(old.source_snapshot->'contexts')=1 AND old.source_snapshot#>>'{contexts,0,classification}'='contractor' AND old.source_snapshot#>>'{contexts,0,reportingForm}' IN('T4A','T4A_NR')) AND old.planned_pay_on$new$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ZERO_NET_CALCULATION_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,replacement);
 body=pg_get_functiondef('public.calculated_net_history_allows(uuid,jsonb,jsonb)'::regprocedure);
 SELECT line INTO STRICT needle FROM regexp_split_to_table(body,E'\n') line WHERE starts_with(line,prefix);
 IF right(needle,3)<>')x;' THEN RAISE EXCEPTION 'ZERO_NET_HISTORY_SELECTOR_BASE_CHANGED';END IF;
 query=substring(needle FROM length(prefix)+1 FOR length(needle)-length(prefix)-3);
 IF NOT starts_with(query,'SELECT pay.id FROM ') THEN RAISE EXCEPTION 'ZERO_NET_HISTORY_PAYMENT_BASE_CHANGED';END IF;
 query=overlay(query placing 'SELECT pay.posting_id id FROM ' FROM 1 FOR length('SELECT pay.id FROM '));
 zero_query=$zero$SELECT p.id FROM public.payrun_net_postings p JOIN public.payrun_groups old ON old.academy_id=p.academy_id AND old.id=p.run_id WHERE p.academy_id=current_run.academy_id AND old.id<>current_run.id AND old.person_id=current_run.person_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(old.source_snapshot->'contexts') context WHERE context->>'employerId'=current_run.source_snapshot#>>'{contexts,0,employerId}') AND NOT(jsonb_array_length(old.source_snapshot->'contexts')=1 AND old.source_snapshot#>>'{contexts,0,classification}'='contractor' AND old.source_snapshot#>>'{contexts,0,reportingForm}' IN('T4A','T4A_NR')) AND old.planned_pay_on BETWEEN DATE '2026-01-01' AND current_run.planned_pay_on AND p.reversal_id IS NULL AND p.plan#>>'{net,amounts,netMinor}'='0' ORDER BY p.id LIMIT 501$zero$;
 replacement=prefix||'SELECT id FROM(('||query||') UNION ALL ('||zero_query||')) selected ORDER BY id LIMIT 501)x;';
 body=replace(body,needle,replacement);
 needle=$old$FROM public.payrun_payments pay JOIN public.payrun_net_postings p ON p.academy_id=pay.academy_id AND p.id=pay.posting_id JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id WHERE pay.id=ANY(ids)$old$;
 replacement=$new$FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id WHERE p.id=ANY(ids)$new$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ZERO_NET_HISTORY_AUTHORITY_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,replacement);
END $migration$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 373 $$;

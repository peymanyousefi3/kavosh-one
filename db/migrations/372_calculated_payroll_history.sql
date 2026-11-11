-- Match the paid-tax calculator's candidate set in both immutable source
-- fingerprints and dynamic approval/read authority. Uncertain legal contexts
-- and retained paid-date mismatches cannot disappear from a prepared run.
-- Preserve helper identities, ACLs and the source JSON for unchanged history.
DO $migration$
DECLARE body text;needle text;replacement text;
BEGIN
 body=pg_get_functiondef('public.calculated_net_source_read(uuid,jsonb)'::regprocedure);
 needle=$old$AND jsonb_array_length(old.source_snapshot->'contexts')=1 AND old.source_snapshot#>>'{contexts,0,employerId}'=period.employer_id::text AND old.source_snapshot#>>'{contexts,0,countryCode}'='CA' AND old.source_snapshot#>>'{contexts,0,classification}'='employee' AND((pay.input->>'paidAt')::timestamptz AT TIME ZONE(period.definition->>'timeZone'))::date BETWEEN DATE '2026-01-01' AND g.planned_pay_on$old$;
 replacement=$new$AND EXISTS(SELECT 1 FROM jsonb_array_elements(old.source_snapshot->'contexts') context WHERE context->>'employerId'=period.employer_id::text) AND(((pay.input->>'paidAt')::timestamptz AT TIME ZONE(period.definition->>'timeZone'))::date BETWEEN DATE '2026-01-01' AND g.planned_pay_on OR(r.state='recorded' AND(r.source_snapshot#>>'{source,paidOn}')::date BETWEEN DATE '2026-01-01' AND g.planned_pay_on))$new$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CALCULATED_HISTORY_SOURCE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,replacement);
 body=pg_get_functiondef('public.calculated_net_history_allows(uuid,jsonb,jsonb)'::regprocedure);
 needle=$old$JOIN public.payrun_groups old ON old.academy_id=p.academy_id AND old.id=p.run_id WHERE old.academy_id=current_run.academy_id$old$;
 replacement=$new$JOIN public.payrun_groups old ON old.academy_id=p.academy_id AND old.id=p.run_id LEFT JOIN public.paid_tax_records h ON h.academy_id=pay.academy_id AND h.payment_id=pay.id LEFT JOIN public.paid_tax_record_revisions r ON r.academy_id=h.academy_id AND r.payment_id=h.payment_id AND r.version=h.version WHERE old.academy_id=current_run.academy_id$new$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CALCULATED_HISTORY_AUTHORITY_JOIN_BASE_CHANGED';END IF;
 body=replace(body,needle,replacement);
 needle=$old$AND jsonb_array_length(old.source_snapshot->'contexts')=1 AND old.source_snapshot#>>'{contexts,0,employerId}'=current_run.source_snapshot#>>'{contexts,0,employerId}' AND old.source_snapshot#>>'{contexts,0,countryCode}'='CA' AND old.source_snapshot#>>'{contexts,0,classification}'='employee' AND((pay.input->>'paidAt')::timestamptz AT TIME ZONE(d->>'timeZone'))::date BETWEEN DATE '2026-01-01' AND current_run.planned_pay_on$old$;
 replacement=$new$AND EXISTS(SELECT 1 FROM jsonb_array_elements(old.source_snapshot->'contexts') context WHERE context->>'employerId'=current_run.source_snapshot#>>'{contexts,0,employerId}') AND(((pay.input->>'paidAt')::timestamptz AT TIME ZONE(d->>'timeZone'))::date BETWEEN DATE '2026-01-01' AND current_run.planned_pay_on OR(r.state='recorded' AND(r.source_snapshot#>>'{source,paidOn}')::date BETWEEN DATE '2026-01-01' AND current_run.planned_pay_on))$new$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CALCULATED_HISTORY_AUTHORITY_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,replacement);
END $migration$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 372 $$;

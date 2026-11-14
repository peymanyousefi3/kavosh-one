-- Extend composed report proofs without changing historical artifact bytes,
-- service identities,or giving a report worker direct database privileges.
CREATE INDEX provider_dispute_cost_window ON public.provider_dispute_postings(academy_id,posted_on,id) WHERE fee_minor<>0;
DO $$ DECLARE body text;needle text;replacement text;BEGIN
 body=pg_get_functiondef('public.profitability_result_valid(jsonb)'::regprocedure);
 needle='BEGIN';
 replacement=$patch$BEGIN
 IF p ? 'provider' THEN
  IF jsonb_typeof(p->'provider') IS DISTINCT FROM 'object' OR NOT(p->'provider' ? 'postings') OR (p->'provider')-'postings'<>'{}'::jsonb
  OR public.report_result_context_valid('finance.manual-income-costs',jsonb_build_object('kind','manual_journal_attribution','basis','recorded','journals',p#>'{provider,postings}','allocations','[]'::jsonb)) IS NOT TRUE THEN RETURN false;END IF;
 END IF;
 $patch$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PROVIDER_COST_PROOF_BASE_CHANGED';END IF;
 body=replace(body,needle,replacement);
 -- SQL text literal below includes an optional provider key only in the
 -- extra-key exclusion;the seven original required keys remain required.
 needle='p-ARRAY[''kind'',''basis'',''ledger'',''tuition'',''supplier'',''payroll'',''manual'']';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PROVIDER_COST_PROOF_KEYS_CHANGED';END IF;
 EXECUTE replace(body,needle,'p-ARRAY[''kind'',''basis'',''ledger'',''tuition'',''supplier'',''payroll'',''manual'',''provider'']');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 331 $$;

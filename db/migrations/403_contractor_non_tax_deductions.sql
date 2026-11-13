-- Explicit reviewed settlement deductions do not become income tax or reduce
-- the reviewed gross service allocation. Existing records remain unchanged.
DO $$ DECLARE body text;needle text;replacement text;BEGIN
 body=pg_get_functiondef('public.t4a_record_definition_valid(jsonb)'::regprocedure);
 needle='d-keys<>''{}''::jsonb';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'T4A_NON_TAX_KEYS_CHANGED';END IF;
 body=replace(body,needle,'d-keys-''nonTaxDeductionSources''<>''{}''::jsonb');
 needle='ARRAY[''incomeTaxSources'',''otherExcluded'']';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'T4A_NON_TAX_ARRAYS_CHANGED';END IF;
 body=replace(body,needle,'ARRAY[''incomeTaxSources'',''nonTaxDeductionSources'',''otherExcluded'']');
 needle='CASE WHEN k=''incomeTaxSources'' THEN d->k ELSE a->k END';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'T4A_NON_TAX_SELECTION_CHANGED';END IF;
 body=replace(body,needle,'CASE WHEN k=''otherExcluded'' THEN a->k WHEN k=''nonTaxDeductionSources'' THEN coalesce(d->k,''[]''::jsonb) ELSE d->k END');
 needle='IF k=''otherExcluded'' AND';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'T4A_NON_TAX_REFERENCE_CHANGED';END IF;
 EXECUTE replace(body,needle,'IF k<>''incomeTaxSources'' AND');

 body=pg_get_functiondef('public.t4a_payment_plan(uuid,integer,jsonb)'::regprocedure);
 needle='deducted numeric;';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'T4A_NON_TAX_PLAN_DECLARATION_CHANGED';END IF;
 body=replace(body,needle,'deducted numeric;non_tax numeric;');
 needle='gross=pay.amount_minor+deducted;';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'T4A_NON_TAX_GROSS_CHANGED';END IF;
 body=replace(body,needle,'SELECT coalesce(sum((x->>''amount'')::numeric*100),0) INTO non_tax FROM jsonb_array_elements(coalesce(d->''nonTaxDeductionSources'',''[]''::jsonb)) x;gross=pay.amount_minor+deducted+non_tax;');
 -- Reuse the exact existing per-code cumulative capacities and complete-final-
 -- payment guard across both kinds,including every other retained edition.
 needle='jsonb_array_elements(d->''incomeTaxSources'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>2 THEN RAISE EXCEPTION 'T4A_NON_TAX_DIRECT_CAPACITY_CHANGED';END IF;
 body=replace(body,needle,'jsonb_array_elements((d->''incomeTaxSources'')||coalesce(d->''nonTaxDeductionSources'',''[]''::jsonb))');
 needle='jsonb_array_elements(o#>''{definition,incomeTaxSources}'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'T4A_NON_TAX_RETAINED_CAPACITY_CHANGED';END IF;
 body=replace(body,needle,'jsonb_array_elements((o#>''{definition,incomeTaxSources}'')||coalesce(o#>''{definition,nonTaxDeductionSources}'',''[]''::jsonb))');
 needle='''netMinor'',trunc(pay.amount_minor)::text';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'T4A_NON_TAX_RESULT_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||',''nonTaxDeductedMinor'',trunc(non_tax)::text');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 403 $$;

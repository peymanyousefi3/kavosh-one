-- Optional,explicit Ontario TD1 tax-reduction claim count. Missing is NOT zero.
-- Keep historical definitions byte-for-byte and preserve validator identity.
DO $$ DECLARE body text;needle text:='d-keys<>''{}''::jsonb';review text:=' v=d->''incomeTaxExemptionReference'';';BEGIN
 SELECT pg_get_functiondef('public.payroll_tax_definition_valid(jsonb)'::regprocedure) INTO body;
 IF strpos(body,needle)=0 OR strpos(body,review)=0 THEN RAISE EXCEPTION 'PAYROLL_TAX_VALIDATOR_PATCH_SOURCE_CHANGED';END IF;
 body=replace(body,needle,'d-(keys||ARRAY[''ontarioTaxReductionClaimCount''])<>''{}''::jsonb');
 body=replace(body,review,' IF d?''ontarioTaxReductionClaimCount'' AND(d->>''provinceOfEmployment'' IS DISTINCT FROM ''ON'' OR jsonb_typeof(d->''ontarioTaxReductionClaimCount'') IS DISTINCT FROM ''number'' OR d->>''ontarioTaxReductionClaimCount''!~''^(0|[1-9][0-9]{0,4})$'' OR(d->>''ontarioTaxReductionClaimCount'')::integer>10000) THEN RETURN false;END IF;'||review);
 EXECUTE body;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 173 $$;

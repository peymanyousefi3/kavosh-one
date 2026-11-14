-- Optional annual declaration,not guessed insurance use or verified eligibility.
-- Existing private tax-profile approval/history/audit and worker locking apply.
DO $$ DECLARE b text;n text;anchor text:=' v=d->''incomeTaxExemptionReference'';';BEGIN
 b=pg_get_functiondef('public.payroll_tax_definition_valid(jsonb)'::regprocedure);n='d-(keys||ARRAY[''ontarioTaxReductionClaimCount''])';
 IF position(n IN b)=0 OR position(anchor IN b)=0 THEN RAISE EXCEPTION 'YEAR_END_TAX_VALIDATOR_SOURCE_CHANGED';END IF;
 b=replace(b,n,'d-(keys||ARRAY[''ontarioTaxReductionClaimCount'',''yearEndT4''])');
 b=replace(b,anchor,$check$ IF d?'yearEndT4' THEN
  v=d->'yearEndT4';
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v?&ARRAY['dentalAccessCode','dentalSourceReference']) OR v-ARRAY['dentalAccessCode','dentalSourceReference']<>'{}'::jsonb OR jsonb_typeof(v->'dentalAccessCode') IS DISTINCT FROM 'string' OR v->>'dentalAccessCode' NOT IN('1','2','3','4','5') OR jsonb_typeof(v->'dentalSourceReference') IS DISTINCT FROM 'string' OR length(btrim(v->>'dentalSourceReference')) NOT BETWEEN 1 AND 2000 OR v->>'dentalSourceReference'~'[[:cntrl:]]' THEN RETURN false;END IF;
 END IF;$check$||anchor);EXECUTE b;
 b=pg_get_functiondef('public.payroll_tax_revision_guard()'::regprocedure);n='IF h.id IS NULL OR h.version<>NEW.version';IF position(n IN b)=0 THEN RAISE EXCEPTION 'YEAR_END_TAX_REVISION_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,'IF h.id IS NULL OR(NEW.definition?''yearEndT4'' AND h.tax_year<2023) OR h.version<>NEW.version');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 183 $$;

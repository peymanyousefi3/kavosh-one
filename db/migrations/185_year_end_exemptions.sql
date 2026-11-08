-- Preserve the original reviewed annual settings and private source history.
-- A missing declaration is unreviewed,not false or inferred from zero wages.
DO $$ DECLARE b text;n text;BEGIN
 b=pg_get_functiondef('public.payroll_tax_definition_valid(jsonb)'::regprocedure);n='v-ARRAY[''dentalAccessCode'',''dentalSourceReference'']';
 IF position(n IN b)=0 THEN RAISE EXCEPTION 'T4_EXEMPTION_VALIDATOR_SOURCE_CHANGED';END IF;
 b=replace(b,n,'v-ARRAY[''dentalAccessCode'',''dentalSourceReference'',''provincialExemptions'']');
 n=' END IF; v=d->''incomeTaxExemptionReference'';';
 IF position(n IN b)=0 THEN RAISE EXCEPTION 'T4_EXEMPTION_BRANCH_SOURCE_CHANGED';END IF;
 b=replace(b,n,$check$  IF v?'provincialExemptions' THEN
   IF jsonb_typeof(v->'provincialExemptions') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
   IF jsonb_array_length(v->'provincialExemptions') NOT BETWEEN 1 AND 15 THEN RETURN false;END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(v->'provincialExemptions') a WHERE jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a?&ARRAY['provinceOfEmployment','cppQpp','ei','ppip','sourceReference']) OR a-ARRAY['provinceOfEmployment','cppQpp','ei','ppip','sourceReference']<>'{}'::jsonb OR jsonb_typeof(a->'provinceOfEmployment') IS DISTINCT FROM 'string' OR a->>'provinceOfEmployment' NOT IN('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT','US','ZZ') OR jsonb_typeof(a->'cppQpp') IS DISTINCT FROM 'boolean' OR jsonb_typeof(a->'ei') IS DISTINCT FROM 'boolean' OR jsonb_typeof(a->'ppip') IS DISTINCT FROM 'boolean' OR jsonb_typeof(a->'sourceReference') IS DISTINCT FROM 'string' OR length(btrim(a->>'sourceReference')) NOT BETWEEN 1 AND 2000 OR a->>'sourceReference'~'[[:cntrl:]]') THEN RETURN false;END IF;
   IF(SELECT count(DISTINCT a->>'provinceOfEmployment') FROM jsonb_array_elements(v->'provincialExemptions') a)<>jsonb_array_length(v->'provincialExemptions') THEN RETURN false;END IF;
  END IF;
 END IF; v=d->'incomeTaxExemptionReference';$check$);EXECUTE b;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 185 $$;

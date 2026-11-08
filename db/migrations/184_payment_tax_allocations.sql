-- Optional reviewed T4 reporting partitions retain the existing exact payment
-- approval/history/amount-capacity system. Missing means legacy/unreviewed.
DO $$ DECLARE b text;n text;anchor text:=' END LOOP;RETURN true;';BEGIN
 b=pg_get_functiondef('public.paid_tax_definition_valid(jsonb)'::regprocedure);n='d-keys<>''{}''::jsonb';IF position(n IN b)=0 OR position(anchor IN b)=0 THEN RAISE EXCEPTION 'T4_PAYMENT_VALIDATOR_SOURCE_CHANGED';END IF;
 b=replace(b,n,'d-(keys||ARRAY[''t4Allocations'',''t4Order''])<>''{}''::jsonb');
 b=replace(b,anchor,' END LOOP;'||$branch$ IF d?'t4Order' AND(NOT(d?'t4Allocations') OR jsonb_typeof(d->'t4Order') IS DISTINCT FROM 'number' OR d->>'t4Order'!~'^[1-9][0-9]{0,6}$' OR(d->>'t4Order')::numeric>1000000) THEN RETURN false;END IF;
 IF d?'t4Allocations' THEN
  IF jsonb_typeof(d->'t4Allocations') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'t4Allocations') NOT BETWEEN 1 AND 15 THEN RETURN false;END IF;
  FOR line_item IN SELECT value FROM jsonb_array_elements(d->'t4Allocations') LOOP
   IF jsonb_typeof(line_item) IS DISTINCT FROM 'object' OR NOT(line_item?&ARRAY['provinceOfEmployment','taxableEarnings','pensionableEarnings','insurableEarnings','employeeDeductions']) OR line_item-ARRAY['provinceOfEmployment','taxableEarnings','pensionableEarnings','insurableEarnings','employeeDeductions']<>'{}'::jsonb OR jsonb_typeof(line_item->'provinceOfEmployment') IS DISTINCT FROM 'string' OR line_item->>'provinceOfEmployment' NOT IN('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT','US','ZZ') THEN RETURN false;END IF;
   IF public.paid_tax_definition_valid((line_item-'provinceOfEmployment')||jsonb_build_object('timeZone',d->'timeZone','employerContributions','[]'::jsonb,'review','Validated T4 payment allocation')) IS NOT TRUE THEN RETURN false;END IF;
  END LOOP;
  IF(SELECT count(DISTINCT a->>'provinceOfEmployment') FROM jsonb_array_elements(d->'t4Allocations') a)<>jsonb_array_length(d->'t4Allocations') THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['taxableEarnings','pensionableEarnings','insurableEarnings'] LOOP IF(SELECT sum((a->>k)::numeric) FROM jsonb_array_elements(d->'t4Allocations') a) IS DISTINCT FROM(d->>k)::numeric THEN RETURN false;END IF;END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'t4Allocations') a CROSS JOIN LATERAL jsonb_array_elements(a->'employeeDeductions') l WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'employeeDeductions') p WHERE p->>'code'=l->>'code' AND p->>'kind'=l->>'kind')) THEN RETURN false;END IF;
  FOR line_item IN SELECT value FROM jsonb_array_elements(d->'employeeDeductions') LOOP IF(SELECT coalesce(sum((l->>'amount')::numeric),0) FROM jsonb_array_elements(d->'t4Allocations') a CROSS JOIN LATERAL jsonb_array_elements(a->'employeeDeductions') l WHERE l->>'code'=line_item->>'code') IS DISTINCT FROM(line_item->>'amount')::numeric THEN RETURN false;END IF;END LOOP;
 END IF;$branch$||'RETURN true;');EXECUTE b;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 184 $$;

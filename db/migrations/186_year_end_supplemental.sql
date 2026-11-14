-- Add reviewed supplemental classifications without rewriting earnings or cash.
DO $$ DECLARE b text;n text;BEGIN
 b=pg_get_functiondef('public.payroll_tax_definition_valid(jsonb)'::regprocedure);
 n='v-ARRAY[''dentalAccessCode'',''dentalSourceReference'',''provincialExemptions'']';
 IF position(n IN b)=0 THEN RAISE EXCEPTION 'T4_SUPPLEMENTAL_VALIDATOR_SOURCE_CHANGED';END IF;
 b=replace(b,n,'v-ARRAY[''dentalAccessCode'',''dentalSourceReference'',''provincialExemptions'',''provincialSupplemental'']');
 n=' END IF; v=d->''incomeTaxExemptionReference'';';
 IF position(n IN b)=0 THEN RAISE EXCEPTION 'T4_SUPPLEMENTAL_BRANCH_SOURCE_CHANGED';END IF;
 b=replace(b,n,$check$  IF v?'provincialSupplemental' THEN
   IF jsonb_typeof(v->'provincialSupplemental') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
   IF jsonb_array_length(v->'provincialSupplemental') NOT BETWEEN 1 AND 15 THEN RETURN false;END IF;
   DECLARE t jsonb;a jsonb;BEGIN
    FOR t IN SELECT value FROM jsonb_array_elements(v->'provincialSupplemental') LOOP
     IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR NOT(t?&ARRAY['provinceOfEmployment','deductionAllocations','unionReceiptAgreementConfirmed','pensionAdjustmentDollars','planRegistrationNumber','pensionAdjustmentEligibilityReviewed','sourceReference']) OR t-ARRAY['provinceOfEmployment','deductionAllocations','unionReceiptAgreementConfirmed','pensionAdjustmentDollars','planRegistrationNumber','pensionAdjustmentEligibilityReviewed','sourceReference']<>'{}'::jsonb OR jsonb_typeof(t->'provinceOfEmployment') IS DISTINCT FROM 'string' OR t->>'provinceOfEmployment' NOT IN('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT','US','ZZ') OR jsonb_typeof(t->'unionReceiptAgreementConfirmed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(t->'pensionAdjustmentEligibilityReviewed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(t->'sourceReference') IS DISTINCT FROM 'string' OR length(btrim(t->>'sourceReference')) NOT BETWEEN 1 AND 2000 OR t->>'sourceReference'~'[[:cntrl:]]' THEN RETURN false;END IF;
     IF jsonb_typeof(t->'pensionAdjustmentDollars') IS DISTINCT FROM 'string' OR length(t->>'pensionAdjustmentDollars')>38 OR t->>'pensionAdjustmentDollars'!~'^(0|[1-9][0-9]*)$' THEN RETURN false;END IF;
     IF t->'planRegistrationNumber'<>'null'::jsonb AND(jsonb_typeof(t->'planRegistrationNumber') IS DISTINCT FROM 'string' OR t->>'planRegistrationNumber'!~'^[0-9]{7}$') THEN RETURN false;END IF;
     IF(t->>'pensionAdjustmentDollars')::numeric>0 AND(t->'planRegistrationNumber'='null'::jsonb OR t->'pensionAdjustmentEligibilityReviewed'<>'true'::jsonb) THEN RETURN false;END IF;
     IF jsonb_typeof(t->'deductionAllocations') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
     IF jsonb_array_length(t->'deductionAllocations')>100 THEN RETURN false;END IF;
     FOR a IN SELECT value FROM jsonb_array_elements(t->'deductionAllocations') LOOP
      IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a?&ARRAY['sourceCode','reportingBox','amount']) OR a-ARRAY['sourceCode','reportingBox','amount']<>'{}'::jsonb OR jsonb_typeof(a->'sourceCode') IS DISTINCT FROM 'string' OR a->>'sourceCode'!~'^[A-Z0-9][A-Z0-9._-]{0,31}$' OR jsonb_typeof(a->'reportingBox') IS DISTINCT FROM 'string' OR a->>'reportingBox' NOT IN('20','44','46') OR public.work_money_valid(a->'amount',2) IS NOT TRUE THEN RETURN false;END IF;
      IF a->>'reportingBox'='44' AND(a->>'amount')::numeric>0 AND t->'unionReceiptAgreementConfirmed'<>'true'::jsonb THEN RETURN false;END IF;
     END LOOP;
     IF(SELECT count(DISTINCT(item.value->>'sourceCode',item.value->>'reportingBox')) FROM jsonb_array_elements(t->'deductionAllocations') item(value))<>jsonb_array_length(t->'deductionAllocations') THEN RETURN false;END IF;
    END LOOP;
   END;
   IF(SELECT count(DISTINCT a->>'provinceOfEmployment') FROM jsonb_array_elements(v->'provincialSupplemental') a)<>jsonb_array_length(v->'provincialSupplemental') THEN RETURN false;END IF;
  END IF;
 END IF; v=d->'incomeTaxExemptionReference';$check$);EXECUTE b;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 186 $$;

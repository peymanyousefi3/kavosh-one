-- Explicit reviewed CAD recognition does not rewrite the original foreign
-- payment or post an FX gain. CRA T4A payer guidance requires CAD reporting;
-- a stored approved reference quote is not independently verified market data.
-- https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/completing-filing-information-returns/t4a-information-payers/t4a-slip.html
CREATE FUNCTION public.supplier_tax_reference_minor(m numeric,s integer,n numeric,d numeric) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
DECLARE a numeric;b numeric;q numeric;r numeric;BEGIN
 IF m IS NULL OR s IS NULL OR n IS NULL OR d IS NULL OR m<0 OR m<>trunc(m) OR m>=1e80 OR s NOT BETWEEN 0 AND 18 OR n<=0 OR n>=1e36 OR n<>trunc(n) OR d<1 OR d>1e18 OR d<>trunc(d) OR d::text!~'^10*$' THEN RAISE EXCEPTION 'SUPPLIER_TAX_FX_RATIO_INVALID' USING ERRCODE='23514';END IF;
 a=m*n*100;b=d*power(10::numeric,s);q=div(a,b);r=mod(a,b);
 RETURN q+CASE WHEN 2*r>b OR(2*r=b AND mod(q,2)=1) THEN 1 ELSE 0 END;
END $fn$;
REVOKE ALL ON FUNCTION public.supplier_tax_reference_minor(numeric,integer,numeric,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.supplier_tax_reference_minor(numeric,integer,numeric,numeric) TO kavosh_runtime;

CREATE OR REPLACE FUNCTION public.supplier_tax_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $fn$
DECLARE f jsonb;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR octet_length(d::text)>65536 OR NOT(d?&ARRAY['timeZone','reportingAccount','allocation','payerReview']) OR d-ARRAY['timeZone','reportingAccount','allocation','payerReview','fx']<>'{}'::jsonb OR jsonb_typeof(d->'payerReview') IS DISTINCT FROM 'string' OR length(btrim(d->>'payerReview')) NOT BETWEEN 1 AND 2000 OR d->>'payerReview'~'[[:cntrl:]]' THEN RETURN false;END IF;
 IF d?'fx' THEN
  f=d->'fx';
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR NOT(f?&ARRAY['rateId','maximumAgeDays','gstHstMinor','pstMinor','review']) OR f-ARRAY['rateId','maximumAgeDays','gstHstMinor','pstMinor','review']<>'{}'::jsonb OR jsonb_typeof(f->'rateId') IS DISTINCT FROM 'string' OR f->>'rateId'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(f->'maximumAgeDays') IS DISTINCT FROM 'number' OR(f->>'maximumAgeDays')::numeric<>trunc((f->>'maximumAgeDays')::numeric) OR(f->>'maximumAgeDays')::numeric NOT BETWEEN 0 AND 3660 OR jsonb_typeof(f->'gstHstMinor') IS DISTINCT FROM 'string' OR f->>'gstHstMinor'!~'^(0|[1-9][0-9]{0,37})$' OR jsonb_typeof(f->'pstMinor') IS DISTINCT FROM 'string' OR f->>'pstMinor'!~'^(0|[1-9][0-9]{0,37})$' OR jsonb_typeof(f->'review') IS DISTINCT FROM 'string' OR length(btrim(f->>'review')) NOT BETWEEN 1 AND 2000 OR f->>'review'~'[[:cntrl:]]' THEN RETURN false;END IF;
 END IF;
 RETURN public.t4a_record_definition_valid((d-ARRAY['payerReview','fx'])||'{"incomeTaxSources":[]}'::jsonb) AND(d#>>'{allocation,incomeTaxDeducted}')::numeric=0;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $fn$;

-- Retain the existing plan OID/owner/ACL/config and every CAD source field.
-- Exact replacement guards prevent silently patching a changed kernel.
DO $migration$
DECLARE body text;old_parts text[];new_parts text[];k integer;BEGIN
 body=pg_get_functiondef('public.supplier_tax_plan(uuid,integer,jsonb)'::regprocedure);
 old_parts=ARRAY[
 $old$gross numeric;allocated numeric;BEGIN$old$,
 $old$  binding=b#>'{source,reportingAccount}';employer=(b#>>'{source,employerId}')::uuid;paid=(b#>>'{source,paidOn}')::date;$old$,
 $old$  IF bill.unit_scale<>2 OR(SELECT code FROM public.finance_currencies WHERE academy_id=bill.academy_id AND id=bill.currency_id) IS DISTINCT FROM 'CAD' THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_CAD_RECOGNITION_REQUIRED');END IF;$old$,
 $old$  gross=pay.amount_minor;SELECT coalesce(sum((x->>'amount')::numeric),0)*100 INTO allocated$old$,
 $old$100*((r.definition#>>'{allocation,gstHst}')::numeric+(r.definition#>>'{allocation,pst}')::numeric) tax$old$,
 $old$ IF d<>'null'::jsonb AND other_tax+100*((d#>>'{allocation,gstHst}')::numeric+(d#>>'{allocation,pst}')::numeric)>bill.tax_minor THEN$old$,
 $old$ RETURN jsonb_build_object('source',jsonb_build_object('kind','expense_payment'$old$,
 $old$'otherRecords',other_records,'requiredBindings',bindings,'unavailable',NULL);$old$
 ];
 new_parts=ARRAY[
 $new$gross numeric;allocated numeric;fx jsonb;rate_row record;prior_snapshot jsonb;original_tax numeric:=0;result jsonb;foreign_payment boolean;BEGIN$new$,
 $new$  binding=b#>'{source,reportingAccount}';employer=(b#>>'{source,employerId}')::uuid;paid=(b#>>'{source,paidOn}')::date;
  SELECT source_snapshot INTO prior_snapshot FROM public.supplier_tax_revisions WHERE academy_id=pay.academy_id AND payment_id=p_payment AND version=p_before;
  fx=prior_snapshot#>'{source,fx}';IF fx IS NOT NULL THEN original_tax=(prior_snapshot->>'originalExcludedTaxMinor')::numeric;END IF;$new$,
 $new$  foreign_payment=bill.unit_scale<>2 OR(SELECT code FROM public.finance_currencies WHERE academy_id=bill.academy_id AND id=bill.currency_id) IS DISTINCT FROM 'CAD';
  IF foreign_payment AND NOT(d?'fx') THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_CAD_RECOGNITION_REQUIRED');END IF;
  IF NOT foreign_payment AND d?'fx' THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_FX_NOT_APPLICABLE');END IF;$new$,
 $new$  gross=pay.amount_minor;
  IF foreign_payment THEN
   SELECT r.*,qc.code quote_code,q.unit_scale quote_scale INTO rate_row FROM public.finance_exchange_rates r JOIN public.finance_currency_revisions q ON q.academy_id=r.academy_id AND q.currency_id=r.quote_currency_id AND q.version=r.quote_currency_version JOIN public.finance_currencies qc ON qc.academy_id=q.academy_id AND qc.id=q.currency_id JOIN public.finance_currency_revisions base_rate ON base_rate.academy_id=r.academy_id AND base_rate.currency_id=r.base_currency_id AND base_rate.version=r.base_currency_version
   WHERE r.academy_id=pay.academy_id AND r.id=(d#>>'{fx,rateId}')::uuid AND r.state='recorded' AND r.base_currency_id=bill.currency_id AND base_rate.unit_scale=bill.unit_scale AND r.rate_on<=paid AND paid-r.rate_on<=(d#>>'{fx,maximumAgeDays}')::integer AND NOT EXISTS(SELECT 1 FROM public.finance_exchange_rates child WHERE child.academy_id=r.academy_id AND child.supersedes_id=r.id);
   IF NOT FOUND OR rate_row.quote_code IS DISTINCT FROM 'CAD' OR rate_row.quote_scale IS DISTINCT FROM 2 THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_FX_SOURCE_CHANGED');END IF;
   original_tax=(d#>>'{fx,gstHstMinor}')::numeric+(d#>>'{fx,pstMinor}')::numeric;
   IF original_tax>pay.amount_minor THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_FX_EXCLUSION_MISMATCH');END IF;
   gross=public.supplier_tax_reference_minor(pay.amount_minor,bill.unit_scale,rate_row.rate_numerator,rate_row.rate_denominator);
   IF gross<=0 THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_FX_ROUNDS_TO_ZERO_REVIEW_REQUIRED');END IF;
   IF 100*(d#>>'{allocation,gstHst}')::numeric<>public.supplier_tax_reference_minor((d#>>'{fx,gstHstMinor}')::numeric,bill.unit_scale,rate_row.rate_numerator,rate_row.rate_denominator) OR 100*(d#>>'{allocation,pst}')::numeric<>public.supplier_tax_reference_minor((d#>>'{fx,pstMinor}')::numeric,bill.unit_scale,rate_row.rate_numerator,rate_row.rate_denominator) THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_FX_EXCLUSION_MISMATCH');END IF;
   fx=jsonb_build_object('rateId',rate_row.id,'rateOn',rate_row.rate_on::text,'baseCurrencyId',rate_row.base_currency_id,'baseCurrencyVersion',rate_row.base_currency_version,'quoteCurrencyId',rate_row.quote_currency_id,'quoteCurrencyVersion',rate_row.quote_currency_version,'rateNumerator',rate_row.rate_numerator::text,'rateDenominator',rate_row.rate_denominator::text,'maximumAgeDays',(d#>>'{fx,maximumAgeDays}')::integer,'gstHstMinor',d#>>'{fx,gstHstMinor}','pstMinor',d#>>'{fx,pstMinor}','rounding','half_even','sourceIndependentlyVerified',false,'taxConversionLegallyVerified',false);
  ELSE original_tax=100*((d#>>'{allocation,gstHst}')::numeric+(d#>>'{allocation,pst}')::numeric);END IF;
  SELECT coalesce(sum((x->>'amount')::numeric),0)*100 INTO allocated$new$,
 $new$coalesce((r.source_snapshot->>'originalExcludedTaxMinor')::numeric,100*((r.definition#>>'{allocation,gstHst}')::numeric+(r.definition#>>'{allocation,pst}')::numeric)) tax$new$,
 $new$ IF d<>'null'::jsonb AND other_tax+original_tax>bill.tax_minor THEN$new$,
 $new$ IF fx IS NOT NULL THEN bindings=bindings||jsonb_build_array(jsonb_build_object('capability','currencies.view','scope','{"all":true,"hubs":[]}'::jsonb),jsonb_build_object('capability','exchange-rates.view','scope','{"all":true,"hubs":[]}'::jsonb));END IF;
 result=jsonb_build_object('source',jsonb_build_object('kind','expense_payment'$new$,
 $new$'otherRecords',other_records,'requiredBindings',bindings,'unavailable',NULL);
 IF fx IS NOT NULL THEN
  result=jsonb_set(result,'{source}',result->'source'||jsonb_build_object('fx',fx,'originalCurrencyId',bill.currency_id,'originalCurrencyVersion',bill.currency_version,'originalUnitScale',bill.unit_scale,'originalSettlementMinor',pay.amount_minor::text));
  result=jsonb_set(result,'{settlementMinor}',to_jsonb(CASE WHEN d='null'::jsonb THEN prior_snapshot->>'settlementMinor' ELSE gross::text END));
  result=result||jsonb_build_object('originalExcludedTaxMinor',original_tax::text);
 END IF;RETURN result;$new$
 ];
 FOR k IN 1..cardinality(old_parts) LOOP
  IF(length(body)-length(replace(body,old_parts[k],'')))/length(old_parts[k])<>1 THEN RAISE EXCEPTION 'SUPPLIER_TAX_FX_KERNEL_CHANGED:%',k;END IF;
  body=replace(body,old_parts[k],new_parts[k]);
 END LOOP;EXECUTE body;
END $migration$;

CREATE OR REPLACE FUNCTION public.supplier_tax_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF jsonb_typeof(NEW.review_context->'requiredBindings') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.review_context->'requiredBindings')<>(CASE WHEN NEW.review_context#>'{source,fx}' IS NULL THEN 8 ELSE 10 END) THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||(NEW.review_context->'requiredBindings');END IF;RETURN NEW;
END $fn$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 388 $$;

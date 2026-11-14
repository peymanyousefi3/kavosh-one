-- A province alone is ambiguous across RP accounts. Keep legacy declarations
-- unchanged;explicit scoped declarations must refer to the same employer.
CREATE FUNCTION public.payroll_year_end_account_ids(d jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(array_agg(DISTINCT(x->>'reportingAccountId')::uuid ORDER BY(x->>'reportingAccountId')::uuid),ARRAY[]::uuid[]) FROM(
 SELECT value x FROM jsonb_array_elements(coalesce(d#>'{yearEndT4,provincialExemptions}','[]'::jsonb))
 UNION ALL SELECT value x FROM jsonb_array_elements(coalesce(d#>'{yearEndT4,provincialSupplemental}','[]'::jsonb))) s WHERE x?'reportingAccountId'
$$;
CREATE FUNCTION public.payroll_year_end_account_bindings(d jsonb,p_employer uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN count(*)=cardinality(public.payroll_year_end_account_ids(d)) THEN coalesce(jsonb_agg(jsonb_build_object('id',h.id,'employerId',h.employer_id) ORDER BY h.id),'[]'::jsonb) ELSE NULL END
 FROM public.payroll_employer_accounts h WHERE h.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND h.employer_id=p_employer AND h.id=ANY(public.payroll_year_end_account_ids(d))
$$;
REVOKE ALL ON FUNCTION public.payroll_year_end_account_ids(jsonb),public.payroll_year_end_account_bindings(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_year_end_account_ids(jsonb),public.payroll_year_end_account_bindings(jsonb,uuid) TO kavosh_runtime;
DO $$ DECLARE b text;n text;BEGIN
 b=pg_get_functiondef('public.payroll_tax_definition_valid(jsonb)'::regprocedure);
 n='a-ARRAY[''provinceOfEmployment'',''cppQpp'',''ei'',''ppip'',''sourceReference'']';IF position(n IN b)=0 THEN RAISE EXCEPTION 'YEAR_END_ACCOUNT_EXEMPTION_SOURCE_CHANGED';END IF;
 b=replace(b,n,'a-ARRAY[''provinceOfEmployment'',''cppQpp'',''ei'',''ppip'',''sourceReference'',''reportingAccountId'']');
 n='t-ARRAY[''provinceOfEmployment'',''deductionAllocations'',''unionReceiptAgreementConfirmed'',''pensionAdjustmentDollars'',''planRegistrationNumber'',''pensionAdjustmentEligibilityReviewed'',''sourceReference'']';IF position(n IN b)=0 THEN RAISE EXCEPTION 'YEAR_END_ACCOUNT_SUPPLEMENTAL_SOURCE_CHANGED';END IF;
 b=replace(b,n,'t-ARRAY[''provinceOfEmployment'',''deductionAllocations'',''unionReceiptAgreementConfirmed'',''pensionAdjustmentDollars'',''planRegistrationNumber'',''pensionAdjustmentEligibilityReviewed'',''sourceReference'',''reportingAccountId'']');
 b=replace(b,'jsonb_array_length(v->''provincialExemptions'') NOT BETWEEN 1 AND 15','jsonb_array_length(v->''provincialExemptions'') NOT BETWEEN 1 AND 100');
 b=replace(b,'jsonb_array_length(v->''provincialSupplemental'') NOT BETWEEN 1 AND 15','jsonb_array_length(v->''provincialSupplemental'') NOT BETWEEN 1 AND 100');
 b=replace(b,'count(DISTINCT a->>''provinceOfEmployment'')','count(DISTINCT(a->>''provinceOfEmployment'',coalesce(a->>''reportingAccountId'','''')))');
 b=replace(b,'jsonb_typeof(a->''provinceOfEmployment'') IS DISTINCT FROM ''string''',$check$(a?'reportingAccountId' AND(jsonb_typeof(a->'reportingAccountId') IS DISTINCT FROM 'string' OR a->>'reportingAccountId'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) OR jsonb_typeof(a->'provinceOfEmployment') IS DISTINCT FROM 'string'$check$);
 b=replace(b,'jsonb_typeof(t->''provinceOfEmployment'') IS DISTINCT FROM ''string''',$check$(t?'reportingAccountId' AND(jsonb_typeof(t->'reportingAccountId') IS DISTINCT FROM 'string' OR t->>'reportingAccountId'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) OR jsonb_typeof(t->'provinceOfEmployment') IS DISTINCT FROM 'string'$check$);EXECUTE b;
 b=pg_get_functiondef('public.payroll_tax_profile_basis(uuid,jsonb)'::regprocedure);n=' ELSE ''{}''::jsonb END;';IF position(n IN b)=0 THEN RAISE EXCEPTION 'YEAR_END_ACCOUNT_BASIS_SOURCE_CHANGED';END IF;
 b=replace(b,n,$check$ ELSE '{}'::jsonb END||CASE WHEN cardinality(public.payroll_year_end_account_ids(i->'definition'))>0 THEN jsonb_build_object('yearEndReportingAccounts',public.payroll_year_end_account_bindings(i->'definition',employer)) ELSE '{}'::jsonb END;$check$);EXECUTE b;
 b=pg_get_functiondef('public.payroll_tax_revision_guard()'::regprocedure);n=' OR b#>>''{person,kind}'' IS DISTINCT FROM ''human''';IF position(n IN b)=0 THEN RAISE EXCEPTION 'YEAR_END_ACCOUNT_GUARD_SOURCE_CHANGED';END IF;
 b=replace(b,n,' OR(cardinality(public.payroll_year_end_account_ids(NEW.definition))>0 AND jsonb_typeof(b->''yearEndReportingAccounts'') IS DISTINCT FROM ''array'')'||n);EXECUTE b;
END $$;
CREATE FUNCTION public.payroll_reporting_approval_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF(NEW.payload#>'{definition,reportingAccount}' IS NOT NULL AND NEW.payload#>'{definition,reportingAccount}'<>'null'::jsonb) OR(NEW.action IN('work.tax-profile.create','work.tax-profile.change') AND cardinality(public.payroll_year_end_account_ids(NEW.payload->'definition'))>0) THEN
  NEW.privacy_bindings=coalesce(NEW.privacy_bindings,'[]'::jsonb)||jsonb_build_array(jsonb_build_object('capability','payroll-employers.view','scope','{"all":true,"hubs":[]}'::jsonb));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER zzzz_payroll_reporting_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('work.tax-profile.create','work.tax-profile.change','work.paid-tax-record.change')) EXECUTE FUNCTION public.payroll_reporting_approval_privacy();
REVOKE ALL ON FUNCTION public.payroll_reporting_approval_privacy() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 190 $$;

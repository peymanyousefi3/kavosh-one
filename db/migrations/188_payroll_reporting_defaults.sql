-- Explicit future reporting default. No historical payment reassignment.
CREATE FUNCTION public.payroll_employer_default_binding(p_account uuid,p_version integer,p_employer uuid,p_on date) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',h.id,'version',r.version,'employerId',h.employer_id,'employerVersion',r.employer_version,'effectiveOn',r.effective_on::text,'revisionSha256',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex'))
 FROM public.payroll_employer_accounts h JOIN public.payroll_employer_revisions r ON r.academy_id=h.academy_id AND r.account_id=h.id AND r.version=p_version
 WHERE h.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND h.id=p_account AND h.employer_id=p_employer AND r.version=(SELECT v.version FROM public.payroll_employer_revisions v WHERE v.academy_id=h.academy_id AND v.account_id=h.id AND v.effective_on<=p_on ORDER BY v.effective_on DESC,v.version DESC LIMIT 1) AND r.definition->'active'='true'::jsonb
$$;
REVOKE ALL ON FUNCTION public.payroll_employer_default_binding(uuid,integer,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_employer_default_binding(uuid,integer,uuid,date) TO kavosh_runtime;
DO $$ DECLARE b text;n text;anchor text;BEGIN
 b=pg_get_functiondef('public.payroll_tax_definition_valid(jsonb)'::regprocedure);n='d-(keys||ARRAY[''ontarioTaxReductionClaimCount'',''yearEndT4''])';
 IF position(n IN b)=0 THEN RAISE EXCEPTION 'PAYROLL_DEFAULT_VALIDATOR_SOURCE_CHANGED';END IF;
 b=replace(b,n,'d-(keys||ARRAY[''ontarioTaxReductionClaimCount'',''yearEndT4'',''reportingAccount''])');anchor=' v=d->''incomeTaxExemptionReference'';';
 IF position(anchor IN b)=0 THEN RAISE EXCEPTION 'PAYROLL_DEFAULT_VALIDATOR_BRANCH_CHANGED';END IF;
 b=replace(b,anchor,$branch$ IF d?'reportingAccount' THEN
  v=d->'reportingAccount';IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v?&ARRAY['id','version']) OR v-ARRAY['id','version']<>'{}'::jsonb OR jsonb_typeof(v->'id') IS DISTINCT FROM 'string' OR v->>'id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(v->'version') IS DISTINCT FROM 'number' OR v->>'version'!~'^[1-9][0-9]{0,9}$' THEN RETURN false;END IF;
  IF(v->>'version')::numeric>2147483646 THEN RETURN false;END IF;
 END IF;$branch$||anchor);EXECUTE b;
 b=pg_get_functiondef('public.payroll_tax_profile_basis(uuid,jsonb)'::regprocedure);n='RETURN jsonb_build_object(''person'',p,''employer'',e,''taxYear'',y,''before'',b);';
 IF position(n IN b)=0 THEN RAISE EXCEPTION 'PAYROLL_DEFAULT_BASIS_SOURCE_CHANGED';END IF;
 b=replace(b,n,$branch$RETURN jsonb_build_object('person',p,'employer',e,'taxYear',y,'before',b)||CASE WHEN i->'definition'?'reportingAccount' THEN jsonb_build_object('reportingAccount',public.payroll_employer_default_binding((i#>>'{definition,reportingAccount,id}')::uuid,(i#>>'{definition,reportingAccount,version}')::integer,employer,(i->>'effectiveOn')::date)) ELSE '{}'::jsonb END;$branch$);EXECUTE b;
 b=pg_get_functiondef('public.payroll_tax_revision_guard()'::regprocedure);n=' SELECT * INTO h FROM public.payroll_tax_profiles WHERE academy_id=NEW.academy_id';
 IF position(n IN b)=0 THEN RAISE EXCEPTION 'PAYROLL_DEFAULT_GUARD_SOURCE_CHANGED';END IF;
 b=replace(b,n,$branch$ IF NEW.definition?'reportingAccount' THEN
  IF public.payroll_tax_definition_valid(NEW.definition) IS NOT TRUE THEN RAISE EXCEPTION 'PAYROLL_REPORTING_ACCOUNT_INVALID' USING ERRCODE='23514';END IF;
  PERFORM id FROM public.payroll_employer_accounts WHERE academy_id=NEW.academy_id AND id=(NEW.definition#>>'{reportingAccount,id}')::uuid FOR SHARE;
 END IF;$branch$||n);
 n=' OR b#>>''{person,kind}'' IS DISTINCT FROM ''human''';
 IF position(n IN b)=0 THEN RAISE EXCEPTION 'PAYROLL_DEFAULT_EFFECT_SOURCE_CHANGED';END IF;
 b=replace(b,n,' OR(NEW.definition?''reportingAccount'' AND jsonb_typeof(b->''reportingAccount'') IS DISTINCT FROM ''object'')'||n);EXECUTE b;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 188 $$;

-- Bind reviewed payment recognition to an explicit account edition at paid date.
-- Reuses existing recognition approval/history/amount/source controls.
DO $$ DECLARE b text;n text;anchor text;BEGIN
 b=pg_get_functiondef('public.paid_tax_definition_valid(jsonb)'::regprocedure);n='d-(keys||ARRAY[''t4Allocations'',''t4Order''])';
 IF position(n IN b)=0 THEN RAISE EXCEPTION 'PAID_ACCOUNT_VALIDATOR_SOURCE_CHANGED';END IF;
 b=replace(b,n,'d-(keys||ARRAY[''t4Allocations'',''t4Order'',''reportingAccount''])');anchor=' FOREACH k IN ARRAY ARRAY[''taxableEarnings'',''pensionableEarnings'',''insurableEarnings''] LOOP';
 IF position(anchor IN b)=0 THEN RAISE EXCEPTION 'PAID_ACCOUNT_VALIDATOR_BRANCH_CHANGED';END IF;
 b=replace(b,anchor,$branch$ IF d?'reportingAccount' THEN
  line_item=d->'reportingAccount';IF jsonb_typeof(line_item) IS DISTINCT FROM 'object' OR NOT(line_item?&ARRAY['id','version']) OR line_item-ARRAY['id','version']<>'{}'::jsonb OR jsonb_typeof(line_item->'id') IS DISTINCT FROM 'string' OR line_item->>'id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(line_item->'version') IS DISTINCT FROM 'number' OR line_item->>'version'!~'^[1-9][0-9]{0,9}$' THEN RETURN false;END IF;
  IF(line_item->>'version')::numeric>2147483646 THEN RETURN false;END IF;
 END IF;$branch$||anchor);EXECUTE b;
 b=pg_get_functiondef('public.paid_tax_record_plan(uuid,uuid,integer,jsonb)'::regprocedure);anchor=' IF d<>''null''::jsonb THEN';
 IF position(anchor IN b)=0 THEN RAISE EXCEPTION 'PAID_ACCOUNT_PLAN_SOURCE_CHANGED';END IF;
 b=replace(b,anchor,$branch$ IF d<>'null'::jsonb AND d?'reportingAccount' THEN
  PERFORM id FROM public.payroll_employer_accounts WHERE academy_id=h.academy_id AND id=(d#>>'{reportingAccount,id}')::uuid FOR SHARE;
  line_item=public.payroll_employer_default_binding((d#>>'{reportingAccount,id}')::uuid,(d#>>'{reportingAccount,version}')::integer,h.employer_id,paid);
  IF line_item IS NULL THEN RETURN jsonb_build_object('unavailable','PAID_TAX_REPORTING_ACCOUNT_CHANGED');END IF;
  line_item=line_item||jsonb_build_object('businessNumberFingerprint',(SELECT encode(sha256(convert_to(jsonb_build_array(h.academy_id,left(a.account_number,9))::text,'UTF8')),'hex') FROM public.payroll_employer_accounts a WHERE a.academy_id=h.academy_id AND a.id=(d#>>'{reportingAccount,id}')::uuid));
  source=source||jsonb_build_object('reportingAccount',line_item);
 END IF;$branch$||anchor);EXECUTE b;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 189 $$;

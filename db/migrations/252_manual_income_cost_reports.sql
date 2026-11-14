-- Extend the existing report library/queue without rewriting previous rows or
-- changing helper identities,owners,ACLs or the original report contracts.
CREATE FUNCTION public.manual_journal_result_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE mapped jsonb;BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& ARRAY['kind','basis','journals','allocations']) OR p-ARRAY['kind','basis','journals','allocations']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'manual_journal_attribution' OR p->>'basis' IS NULL OR p->>'basis' NOT IN('recorded','reviewed') OR jsonb_typeof(p->'journals') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'allocations') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(p->'journals')>10000 OR jsonb_array_length(p->'allocations')>10000 OR(p->>'basis'='recorded' AND jsonb_array_length(p->'allocations')<>0) THEN RETURN false;END IF;
 -- Reuse the existing strict canonical UUID,version,unique-parent and
 -- captured-parent-membership validator;reject aliases/extras before mapping.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'allocations') a WHERE jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['journalId','version']) OR a-ARRAY['journalId','version']<>'{}'::jsonb) THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('billId',a->'journalId','version',a->'version')),'[]'::jsonb) INTO mapped FROM jsonb_array_elements(p->'allocations') a;
 RETURN public.allocated_expense_result_valid(jsonb_build_object('kind','allocated_expense_attribution','bills',p->'journals','allocations',mapped));
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
DO $$ DECLARE body text;needle text;r record;BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('public.report_preset_static_definition_valid(jsonb)','''payroll.costs'')','''payroll.costs'',''finance.manual-income-costs'')'),
 ('public.report_preset_definition_valid(jsonb)','WHEN ''payroll.costs'' THEN ARRAY[''from'',''through'']','WHEN ''payroll.costs'' THEN ARRAY[''from'',''through''] WHEN ''finance.manual-income-costs'' THEN ARRAY[''from'',''through'']'),
 ('public.report_job_guard()','''payroll.costs'')','''payroll.costs'',''finance.manual-income-costs'')'),
 ('public.report_job_preset_guard()','''payroll.costs'') THEN ARRAY[''from'',''through'']','''payroll.costs'',''finance.manual-income-costs'') THEN ARRAY[''from'',''through'']'),
 ('public.report_result_context_valid(text,jsonb)',' IF report IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'') THEN',' IF report=''finance.manual-income-costs'' THEN RETURN public.manual_journal_result_valid(p); END IF; IF report IN(''finance.trial-balance'',''finance.profit-loss'',''finance.balance-sheet'') THEN')
 ) changes(signature,old_text,new_text) LOOP
  body=pg_get_functiondef(r.signature::regprocedure);needle=r.old_text;
  IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'MANUAL_REPORT_BASE_CHANGED:%',r.signature;END IF;
  EXECUTE replace(body,needle,r.new_text);
 END LOOP;
 FOR r IN SELECT DISTINCT role.rolname FROM pg_proc f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl JOIN pg_roles role ON role.oid=acl.grantee WHERE f.oid='public.report_result_context_valid(text,jsonb)'::regprocedure AND acl.privilege_type='EXECUTE' LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.manual_journal_result_valid(jsonb) TO %I',r.rolname);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.manual_journal_result_valid(jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 252 $$;

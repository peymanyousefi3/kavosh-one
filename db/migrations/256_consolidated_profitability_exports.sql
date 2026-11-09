-- Fixed-family proof composition,not arbitrary recursive manifests. Old
-- validators and retained artifacts keep their original contracts and bytes.
CREATE FUNCTION public.profitability_result_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE expected_payroll text;expected_supplier text;BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>4194304 OR NOT(p ?& ARRAY['kind','basis','ledger','tuition','supplier','payroll','manual']) OR p-ARRAY['kind','basis','ledger','tuition','supplier','payroll','manual']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'academy_profitability' OR p->>'basis' IS NULL OR p->>'basis' NOT IN('recorded','reviewed') THEN RETURN false;END IF;
 expected_payroll=CASE WHEN p->>'basis'='reviewed' THEN 'allocated_payroll_cost' ELSE 'payroll_cost' END;expected_supplier=CASE WHEN p->>'basis'='reviewed' THEN 'allocated_expense_attribution' ELSE 'expense_attribution' END;
 IF p#>>'{manual,basis}' IS DISTINCT FROM p->>'basis' OR p#>>'{payroll,kind}' IS DISTINCT FROM expected_payroll OR p#>>'{supplier,kind}' IS DISTINCT FROM expected_supplier THEN RETURN false;END IF;
 IF public.report_result_context_valid('finance.profit-loss',p->'ledger') IS NOT TRUE THEN RETURN false;END IF;
 -- Legacy financial manifests accepted duplicate hub entries. Keep their
 -- historical contract unchanged,but the new composed proof is canonical.
 IF(SELECT count(*)<>count(DISTINCT value::uuid) FROM jsonb_array_elements_text(p#>'{ledger,hubIds}')) THEN RETURN false;END IF;
 RETURN coalesce(public.report_result_context_valid('finance.profit-loss',p->'ledger') AND public.report_result_context_valid('finance.tuition-income',p->'tuition') AND public.report_result_context_valid('finance.expense-costs',p->'supplier') AND public.report_result_context_valid('payroll.costs',p->'payroll') AND public.report_result_context_valid('finance.manual-income-costs',p->'manual'),false);
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
DO $$ DECLARE body text;needle text;r record;BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('public.report_job_guard()','''finance.manual-income-costs'')','''finance.manual-income-costs'',''finance.profitability'')'),
 ('public.report_job_preset_guard()','''finance.manual-income-costs'') THEN ARRAY[''from'',''through'']','''finance.manual-income-costs'',''finance.profitability'') THEN ARRAY[''from'',''through'']'),
 ('public.report_result_context_valid(text,jsonb)',' IF report=''finance.manual-income-costs'' THEN',' IF report=''finance.profitability'' THEN RETURN public.profitability_result_valid(p); END IF; IF report=''finance.manual-income-costs'' THEN')
 ) changes(signature,old_text,new_text) LOOP
  body=pg_get_functiondef(r.signature::regprocedure);needle=r.old_text;
  IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PROFITABILITY_EXPORT_BASE_CHANGED:%',r.signature;END IF;
  EXECUTE replace(body,needle,r.new_text);
 END LOOP;
 FOR r IN SELECT DISTINCT role.rolname FROM pg_proc f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl JOIN pg_roles role ON role.oid=acl.grantee WHERE f.oid='public.report_result_context_valid(text,jsonb)'::regprocedure AND acl.privilege_type='EXECUTE' LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.profitability_result_valid(jsonb) TO %I',r.rolname);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.profitability_result_valid(jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 256 $$;

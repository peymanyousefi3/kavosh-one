-- New pinned analytical proof;old original-context proofs/artifacts stay valid.
CREATE FUNCTION public.allocated_expense_result_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE v jsonb;BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& ARRAY['kind','bills','allocations']) OR p-ARRAY['kind','bills','allocations']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'allocated_expense_attribution' OR jsonb_typeof(p->'bills') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'allocations') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(p->'bills')>10000 OR jsonb_array_length(p->'allocations')>10000 THEN RETURN false;END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(p->'bills') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR(v#>>'{}')::uuid::text IS DISTINCT FROM v#>>'{}' THEN RETURN false;END IF;
 END LOOP;
 IF(SELECT count(DISTINCT value) FROM jsonb_array_elements(p->'bills'))<>jsonb_array_length(p->'bills') THEN RETURN false;END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(p->'allocations') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['billId','version']) OR v-ARRAY['billId','version']<>'{}'::jsonb OR jsonb_typeof(v->'billId') IS DISTINCT FROM 'string' OR(v->>'billId')::uuid::text IS DISTINCT FROM v->>'billId'
  OR jsonb_typeof(v->'version') IS DISTINCT FROM 'number' OR(v->>'version')::numeric NOT BETWEEN 1 AND 2147483647 OR(v->>'version')::numeric<>trunc((v->>'version')::numeric) THEN RETURN false;END IF;
 END LOOP;
 RETURN(SELECT count(DISTINCT value->>'billId') FROM jsonb_array_elements(p->'allocations'))=jsonb_array_length(p->'allocations')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'allocations') a LEFT JOIN jsonb_array_elements_text(p->'bills') b(id) ON b.id=a->>'billId' WHERE b.id IS NULL);
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
DO $$ DECLARE body text;needle text:='ELSIF report=''finance.expense-costs'' THEN';r record;BEGIN
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ALLOCATED_EXPENSE_CONTEXT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'ELSIF report=''finance.expense-costs'' AND p->>''kind''=''allocated_expense_attribution'' THEN RETURN public.allocated_expense_result_valid(p);
 '||needle);
 -- Grant only the same existing invokers as the parent validator;no broader
 -- table,role or public execution rights and no security-definer function.
 FOR r IN SELECT DISTINCT role.rolname FROM pg_proc f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl JOIN pg_roles role ON role.oid=acl.grantee WHERE f.oid='public.report_result_context_valid(text,jsonb)'::regprocedure AND acl.privilege_type='EXECUTE' LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.allocated_expense_result_valid(jsonb) TO %I',r.rolname);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.allocated_expense_result_valid(jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 250 $$;

-- New pinned payroll attribution proof;original files keep their original
-- source-only proof and bytes. No ledger,source or allocation rows change.
-- Coordinate with the actual source row's void/reversal update. The tag's
-- separate version lock alone cannot serialize an unrelated payroll writer.
-- These are share locks under the existing policy/book/topology gates;no
-- financial source is updated and report aggregation remains non-locking.
DO $$ DECLARE body text;needle text:=$needle$ PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':'||j.id::text,35));$needle$;locks text:=$locks$
 CASE o.kind
 WHEN 'manual_bonus' THEN PERFORM 1 FROM public.payroll_adjustments WHERE academy_id=tenant AND id=j.id FOR SHARE;
 WHEN 'salary' THEN PERFORM 1 FROM public.payroll_salary_accruals WHERE academy_id=tenant AND id=j.id FOR SHARE;
 WHEN 'project' THEN PERFORM 1 FROM public.payroll_project_accruals WHERE academy_id=tenant AND id=j.id FOR SHARE;
 WHEN 'hourly' THEN PERFORM 1 FROM public.payroll_hourly_accruals WHERE academy_id=tenant AND id=j.id FOR SHARE;
 WHEN 'tuition_course' THEN PERFORM 1 FROM public.payroll_tuition_course_accruals WHERE academy_id=tenant AND id=j.id FOR SHARE;
 WHEN 'tuition_session' THEN PERFORM 1 FROM public.payroll_tuition_session_accruals WHERE academy_id=tenant AND id=j.id FOR SHARE;
 WHEN 'tuition_collection' THEN PERFORM 1 FROM public.payroll_tuition_collection_accruals WHERE academy_id=tenant AND id=j.id FOR SHARE;
 WHEN 'employer_contribution' THEN PERFORM 1 FROM public.payrun_net_postings WHERE academy_id=tenant AND id=j.id FOR SHARE;
 ELSE RETURN jsonb_build_object('unavailable','POSTED_PAYROLL_COST_SOURCE_REQUIRED');
 END CASE;
$locks$;BEGIN
 body=pg_get_functiondef('public.payroll_cost_attribution_source(jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PAYROLL_ATTRIBUTION_SOURCE_LOCK_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,locks||needle);
END $$;
CREATE FUNCTION public.allocated_payroll_cost_result_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE mapped jsonb;parents jsonb;BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& ARRAY['kind','sources','allocations']) OR p-ARRAY['kind','sources','allocations']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'allocated_payroll_cost' OR jsonb_typeof(p->'sources') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'allocations') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF NOT public.report_result_context_valid('payroll.costs',jsonb_build_object('kind','payroll_cost','sources',p->'sources')) OR jsonb_array_length(p->'allocations')>10000 THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'allocations') a WHERE jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['journalId','version']) OR a-ARRAY['journalId','version']<>'{}'::jsonb) THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(DISTINCT s->'sourceId'),'[]'::jsonb) INTO parents FROM jsonb_array_elements(p->'sources') s;
 SELECT coalesce(jsonb_agg(jsonb_build_object('billId',a->'journalId','version',a->'version')),'[]'::jsonb) INTO mapped FROM jsonb_array_elements(p->'allocations') a;
 RETURN public.allocated_expense_result_valid(jsonb_build_object('kind','allocated_expense_attribution','bills',parents,'allocations',mapped));
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
DO $$ DECLARE body text;needle text:=' IF report=''payroll.costs'' THEN';r record;BEGIN
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ALLOCATED_PAYROLL_CONTEXT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,' IF report=''payroll.costs'' AND p->>''kind''=''allocated_payroll_cost'' THEN RETURN public.allocated_payroll_cost_result_valid(p); END IF;'||needle);
 FOR r IN SELECT DISTINCT role.rolname FROM pg_proc f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl JOIN pg_roles role ON role.oid=acl.grantee WHERE f.oid='public.report_result_context_valid(text,jsonb)'::regprocedure AND acl.privilege_type='EXECUTE' LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.allocated_payroll_cost_result_valid(jsonb) TO %I',r.rolname);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.allocated_payroll_cost_result_valid(jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 254 $$;

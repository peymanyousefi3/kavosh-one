-- Approval privacy bindings also use this exact boolean payroll predicate.
-- The sender must evaluate those bindings without raw payrun snapshots.
DO $$ DECLARE body text;needle text:='IF cap NOT IN(''work-pay.view'',''payroll-accruals.view'',''payroll-adjustments.view'') OR NOT public.approval_scope_nonempty(s) THEN RETURN false;END IF;';BEGIN
 body=pg_get_functiondef('public.payrun_net_source_allows(uuid,text,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'SENDER_PAYROLL_PREDICATE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'IF cap IS NULL OR cap NOT IN(''work-pay.view'',''payroll-accruals.view'',''payroll-adjustments.view'') OR public.approval_scope_nonempty(s) IS NOT TRUE THEN RETURN false;END IF;');
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_runtime;
ALTER FUNCTION public.payrun_net_source_allows(uuid,text,jsonb) OWNER TO kavosh_runtime;
REVOKE CREATE ON SCHEMA public FROM kavosh_runtime;
ALTER FUNCTION public.payrun_net_source_allows(uuid,text,jsonb) SECURITY DEFINER;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 383 $$;

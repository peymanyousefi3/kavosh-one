-- Requester-bound supplier report jobs reuse the existing isolated broker.
-- Retain exact original payment/review references,not current future editions.
GRANT SELECT ON public.supplier_tax_records,public.supplier_tax_revisions TO kavosh_automation_worker;
-- Shared notice SQL needs only recipient identifiers/scope,not payee labels,
-- private allocations or the runtime role's broader financial permissions.
GRANT SELECT(academy_id,id,hub_id) ON public.financial_payees TO kavosh_message_worker;
GRANT SELECT(academy_id,id,bill_id,paid_at) ON public.expense_payments TO kavosh_automation_policy;
GRANT SELECT(academy_id,id,payee_id) ON public.expense_bills TO kavosh_automation_policy;
GRANT SELECT(academy_id,payment_id,version,state,source_snapshot) ON public.supplier_tax_revisions TO kavosh_automation_policy;
-- The broker independently binds each supplied original reference to this
-- tenant,payee,year and an existing exact immutable review edition. This is
-- reference validation,not a certification of legal/annual completeness.
CREATE FUNCTION public.supplier_tax_report_sources_valid(p jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'sources') s
 LEFT JOIN public.expense_payments pay ON pay.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND pay.id=(s->>'paymentId')::uuid
 LEFT JOIN public.expense_bills b ON b.academy_id=pay.academy_id AND b.id=pay.bill_id
 LEFT JOIN public.supplier_tax_revisions r ON r.academy_id=pay.academy_id AND r.payment_id=pay.id AND r.version=(s->>'recognitionVersion')::integer
 WHERE pay.id IS NULL OR b.id IS NULL OR b.payee_id IS DISTINCT FROM(p->>'payeeId')::uuid OR(s->'recognitionVersion'<>'null'::jsonb AND r.version IS NULL)
 OR NOT(pay.paid_at IS NULL OR extract(year FROM pay.paid_at AT TIME ZONE(p->>'timeZone'))::integer=(p->>'taxYear')::integer OR(r.state='recorded' AND r.source_snapshot#>>'{source,employerId}'=p->>'employerId' AND r.source_snapshot#>>'{source,taxYear}'=p->>'taxYear')))
$$;
REVOKE ALL ON FUNCTION public.supplier_tax_report_sources_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.supplier_tax_report_sources_valid(jsonb) TO kavosh_automation_policy;
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);needle='''payroll.t4a-working-paper'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'SUPPLIER_REPORT_JOB_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''payroll.t4a-working-paper'',''finance.supplier-t4a-working-paper'')');
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);needle='IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM ''object'' THEN RETURN false;END IF;';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'SUPPLIER_REPORT_CONTEXT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF report='finance.supplier-t4a-working-paper' THEN
  IF NOT(p?&ARRAY['kind','payeeId','employerId','taxYear','timeZone','sources']) OR p-ARRAY['kind','payeeId','employerId','taxYear','timeZone','sources']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'supplier_tax_year' OR jsonb_typeof(p->'payeeId') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'employerId') IS DISTINCT FROM 'string' OR(p->>'payeeId')::uuid::text IS DISTINCT FROM p->>'payeeId' OR(p->>'employerId')::uuid::text IS DISTINCT FROM p->>'employerId' OR p->>'payeeId'=p->>'employerId' OR jsonb_typeof(p->'taxYear') IS DISTINCT FROM 'number' OR p->>'taxYear'!~'^[1-9][0-9]{3}$' OR(p->>'taxYear')::integer NOT BETWEEN 1900 AND 9999 OR jsonb_typeof(p->'timeZone') IS DISTINCT FROM 'string' OR length(p->>'timeZone') NOT BETWEEN 1 AND 100 OR p->>'timeZone'!~'^[A-Za-z0-9_+./-]+$' OR jsonb_typeof(p->'sources') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(p->'sources')>500 OR(SELECT count(*)<>count(DISTINCT x->>'paymentId') FROM jsonb_array_elements(p->'sources') x) THEN RETURN false;END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p->'sources') LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v?&ARRAY['paymentId','recognitionVersion']) OR v-ARRAY['paymentId','recognitionVersion']<>'{}'::jsonb OR jsonb_typeof(v->'paymentId') IS DISTINCT FROM 'string' OR(v->>'paymentId')::uuid::text IS DISTINCT FROM v->>'paymentId' THEN RETURN false;END IF;
   IF v->'recognitionVersion'<>'null'::jsonb THEN IF jsonb_typeof(v->'recognitionVersion') IS DISTINCT FROM 'number' OR v->>'recognitionVersion'!~'^[1-9][0-9]{0,9}$' OR(v->>'recognitionVersion')::bigint>2147483647 THEN RETURN false;END IF;END IF;
  END LOOP;RETURN true;
 END IF;
 $branch$);
 body=pg_get_functiondef('public.finish_report_job(uuid,uuid,text,text,text,text,jsonb)'::regprocedure);needle='NOT public.report_result_context_valid(j.configuration->>''reportId'',p_context)';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'SUPPLIER_REPORT_BROKER_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'('||needle||' OR(j.configuration->>''reportId''=''finance.supplier-t4a-working-paper'' AND(NOT public.supplier_tax_report_sources_valid(p_context) OR p_context->>''payeeId'' IS DISTINCT FROM j.configuration#>>''{parameters,payeeId}'' OR p_context->>''employerId'' IS DISTINCT FROM j.configuration#>>''{parameters,employerId}'' OR p_context->>''taxYear'' IS DISTINCT FROM j.configuration#>>''{parameters,taxYear}'' OR p_context->>''timeZone'' IS DISTINCT FROM j.configuration#>>''{parameters,timeZone}'')))');
 body=pg_get_functiondef('public.report_result_guard()'::regprocedure);needle='public.report_result_context_valid(configuration->>''reportId'',NEW.authorization_context)';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'SUPPLIER_REPORT_RESULT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'('||needle||' AND(configuration->>''reportId''<>''finance.supplier-t4a-working-paper'' OR(public.supplier_tax_report_sources_valid(NEW.authorization_context) AND NEW.authorization_context->>''payeeId''=configuration#>>''{parameters,payeeId}'' AND NEW.authorization_context->>''employerId''=configuration#>>''{parameters,employerId}'' AND NEW.authorization_context->>''taxYear''=configuration#>>''{parameters,taxYear}'' AND NEW.authorization_context->>''timeZone''=configuration#>>''{parameters,timeZone}'')))');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 378 $$;

-- Compose the existing payroll/supplier proofs;do not widen legacy formats.
GRANT SELECT(academy_id,id,person_id,kind) ON public.financial_payees TO kavosh_automation_policy;
GRANT SELECT(academy_id,id,person_id) ON public.financial_payees TO kavosh_message_worker;
-- Older sender grants included full payroll snapshots so an invoker-only
-- pay-statement predicate could inspect them. Expose that boolean through the
-- existing tenant-bound runtime role instead;the sender needs no raw snapshot.
GRANT CREATE ON SCHEMA public TO kavosh_runtime;
ALTER FUNCTION public.pay_statement_notice_allows(uuid,uuid,jsonb) OWNER TO kavosh_runtime;
REVOKE CREATE ON SCHEMA public FROM kavosh_runtime;
ALTER FUNCTION public.pay_statement_notice_allows(uuid,uuid,jsonb) SECURITY DEFINER;
REVOKE SELECT ON public.payrun_groups FROM kavosh_message_worker;
GRANT SELECT(academy_id,id,person_id,scope) ON public.payrun_groups TO kavosh_message_worker;
GRANT SELECT(academy_id,id,run_id) ON public.payrun_net_postings TO kavosh_automation_policy;
GRANT SELECT(academy_id,id,person_id,source_snapshot) ON public.payrun_groups TO kavosh_automation_policy;
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.report_job_guard()'::regprocedure);needle='''finance.supplier-t4a-working-paper'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CONSOLIDATED_JOB_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''finance.supplier-t4a-working-paper'',''payroll.t4a-consolidated-working-paper'')');
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);needle='IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM ''object'' THEN RETURN false;END IF;';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CONSOLIDATED_CONTEXT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF report='payroll.t4a-consolidated-working-paper' THEN
  IF NOT(p?&ARRAY['kind','payroll','supplier']) OR p-ARRAY['kind','payroll','supplier']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'consolidated_t4a_tax_year' OR NOT public.report_result_context_valid('payroll.t4a-working-paper',p->'payroll') THEN RETURN false;END IF;
  IF p->'supplier'<>'null'::jsonb THEN
   IF NOT public.report_result_context_valid('finance.supplier-t4a-working-paper',p->'supplier') OR p#>>'{supplier,employerId}' IS DISTINCT FROM p#>>'{payroll,employerId}' OR p#>>'{supplier,taxYear}' IS DISTINCT FROM p#>>'{payroll,taxYear}' OR p#>>'{supplier,timeZone}' IS DISTINCT FROM p#>>'{payroll,timeZone}' THEN RETURN false;END IF;
  END IF;RETURN true;
 END IF;
 $branch$);
END $$;
CREATE FUNCTION public.consolidated_t4a_report_sources_valid(configuration jsonb,p jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ BEGIN
 IF NOT public.report_result_context_valid('payroll.t4a-consolidated-working-paper',p) THEN RETURN false;END IF;
 IF p#>>'{payroll,personId}' IS DISTINCT FROM configuration#>>'{parameters,personId}' OR p#>>'{payroll,employerId}' IS DISTINCT FROM configuration#>>'{parameters,employerId}' OR p#>>'{payroll,taxYear}' IS DISTINCT FROM configuration#>>'{parameters,taxYear}' OR p#>>'{payroll,timeZone}' IS DISTINCT FROM configuration#>>'{parameters,timeZone}' THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.financial_payees WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=(p#>>'{payroll,employerId}')::uuid AND kind='academy') THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(p#>'{payroll,postingIds}') ref
  LEFT JOIN public.payrun_net_postings n ON n.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND n.id=ref::uuid
  LEFT JOIN public.payrun_groups g ON g.academy_id=n.academy_id AND g.id=n.run_id
  WHERE n.id IS NULL OR g.person_id IS DISTINCT FROM(p#>>'{payroll,personId}')::uuid OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g.source_snapshot->'contexts') context WHERE context->>'employerId'=p#>>'{payroll,employerId}')) THEN RETURN false;END IF;
 IF p->'supplier'='null'::jsonb THEN RETURN NOT EXISTS(SELECT 1 FROM public.financial_payees WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND kind='person' AND person_id=(p#>>'{payroll,personId}')::uuid);END IF;
 RETURN EXISTS(SELECT 1 FROM public.financial_payees WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=(p#>>'{supplier,payeeId}')::uuid AND kind='person' AND person_id=(p#>>'{payroll,personId}')::uuid) AND public.supplier_tax_report_sources_valid(p->'supplier');
 EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.consolidated_t4a_report_sources_valid(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consolidated_t4a_report_sources_valid(jsonb,jsonb) TO kavosh_automation_policy;
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.finish_report_job(uuid,uuid,text,text,text,text,jsonb)'::regprocedure);needle='NOT public.report_result_context_valid(j.configuration->>''reportId'',p_context)';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CONSOLIDATED_BROKER_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'('||needle||' OR(j.configuration->>''reportId''=''payroll.t4a-consolidated-working-paper'' AND NOT public.consolidated_t4a_report_sources_valid(j.configuration,p_context)))');
 body=pg_get_functiondef('public.report_result_guard()'::regprocedure);needle='public.report_result_context_valid(configuration->>''reportId'',NEW.authorization_context)';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CONSOLIDATED_RESULT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'('||needle||' AND(configuration->>''reportId''<>''payroll.t4a-consolidated-working-paper'' OR public.consolidated_t4a_report_sources_valid(configuration,NEW.authorization_context)))');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 382 $$;

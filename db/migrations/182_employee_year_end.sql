-- Add a saved fixed-year working-paper configuration,not an issued tax form.
-- No fiscal/date-window inference,private identities or historical rewrites.
DO $$ DECLARE b text;n text:='''payroll.paid-tax-year-to-date'')';BEGIN
 b=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);IF position(n IN b)=0 THEN RAISE EXCEPTION 'T4_WORKING_PAPER_CATALOGUE_BASE_CHANGED';END IF;EXECUTE replace(b,n,'''payroll.paid-tax-year-to-date'',''payroll.t4-working-paper'')');
END $$;
-- Reuse the private paid-tax manifest and the same broker profile binding for
-- queued/scheduled working papers. No second authorization/result mechanism.
DO $$ DECLARE b text;n text;BEGIN
 b=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);n='report=''payroll.paid-tax-year-to-date''';IF position(n IN b)=0 THEN RAISE EXCEPTION 'T4_REPORT_CONTEXT_BASE_CHANGED';END IF;EXECUTE replace(b,n,'report IN(''payroll.paid-tax-year-to-date'',''payroll.t4-working-paper'')');
 b=pg_get_functiondef('public.report_job_guard()'::regprocedure);n='''payroll.remittances'',''payroll.paid-tax-year-to-date'')';IF position(n IN b)=0 THEN RAISE EXCEPTION 'T4_REPORT_JOB_BASE_CHANGED';END IF;EXECUTE replace(b,n,'''payroll.remittances'',''payroll.paid-tax-year-to-date'',''payroll.t4-working-paper'')');
 b=pg_get_functiondef('public.finish_report_job(uuid,uuid,text,text,text,text,jsonb)'::regprocedure);n='j.configuration->>''reportId''=''payroll.paid-tax-year-to-date''';IF position(n IN b)=0 THEN RAISE EXCEPTION 'T4_REPORT_BROKER_BASE_CHANGED';END IF;EXECUTE replace(b,n,'j.configuration->>''reportId'' IN(''payroll.paid-tax-year-to-date'',''payroll.t4-working-paper'')');
 b=pg_get_functiondef('public.report_result_guard()'::regprocedure);n='configuration->>''reportId''<>''payroll.paid-tax-year-to-date''';IF position(n IN b)=0 THEN RAISE EXCEPTION 'T4_REPORT_RESULT_BASE_CHANGED';END IF;EXECUTE replace(b,n,'configuration->>''reportId'' NOT IN(''payroll.paid-tax-year-to-date'',''payroll.t4-working-paper'')');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 182 $$;

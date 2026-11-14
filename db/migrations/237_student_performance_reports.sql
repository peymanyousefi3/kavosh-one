-- Register only this additional static report in the reviewed preset library.
-- Keep existing definitions,helper identity,ownership and ACLs unchanged.
DO $$ DECLARE body text;needle text:='''payroll.t4-working-paper'')';BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PERFORMANCE_REPORT_CATALOGUE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''payroll.t4-working-paper'',''learning.student-performance'')');
END $$;
-- Native feedback sources retain ISO civil dates. Index the immutable text
-- projection,not the DateStyle-sensitive text-to-date cast,for bounded reports.
CREATE INDEX student_feedback_report_date ON public.student_feedback(academy_id,(context#>>'{source,session,on}'),id);
CREATE INDEX student_feedback_student_report_date ON public.student_feedback(academy_id,student_id,(context#>>'{source,session,on}'),id);
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 237 $$;

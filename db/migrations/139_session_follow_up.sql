-- Whole-academy date paging must not require a per-hub scan or unbounded
-- evidence projection. Existing class/hub-specific indexes remain useful.
CREATE INDEX sessions_academy_time ON public.class_sessions(academy_id,starts_at,id);
DO $$ DECLARE body text;BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);
 IF position('''payroll.gross-accruals'',''learning.polls.by-id'',''learning.sessions.by-id.evidence'')' IN body)=0 THEN RAISE EXCEPTION 'REPORT_CATALOGUE_BASE_UNEXPECTED';END IF;
 body=replace(body,'''payroll.gross-accruals'',''learning.polls.by-id'',''learning.sessions.by-id.evidence'')','''payroll.gross-accruals'',''learning.polls.by-id'',''learning.sessions.by-id.evidence'',''learning.session-follow-up'')');
 EXECUTE body;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 139 $$;

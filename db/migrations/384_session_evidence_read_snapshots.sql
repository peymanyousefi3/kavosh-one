-- Reporting reads must share the outer statement snapshot, including nested
-- roster/file reads. Keep the original VOLATILE mutation/source entrypoints:
-- triggers and approval application still need to see their own latest writes.
-- Copy the CURRENT canonical definitions, not another eligibility algorithm.
DO $$ DECLARE signature text;body text;BEGIN
 FOREACH signature IN ARRAY ARRAY['public.session_attendance_source(uuid)','public.session_report_source(uuid,jsonb)','public.session_evidence_snapshot(uuid)'] LOOP
  body=pg_get_functiondef(signature::regprocedure);
  IF position(' VOLATILE' IN body)>0 OR position(' STABLE' IN body)>0 OR position(' IMMUTABLE' IN body)>0 THEN
   RAISE EXCEPTION 'SESSION_READ_BASE_VOLATILITY_UNEXPECTED';
  END IF;
  IF signature='public.session_attendance_source(uuid)' THEN
   body=replace(body,'FUNCTION public.session_attendance_source(','FUNCTION public.session_attendance_source_read(');
  ELSIF signature='public.session_report_source(uuid,jsonb)' THEN
   body=replace(body,'FUNCTION public.session_report_source(','FUNCTION public.session_report_source_read(');
  ELSE
   IF position('public.session_attendance_source(s.id)' IN body)=0 OR position('public.session_report_source(s.id,' IN body)=0 THEN RAISE EXCEPTION 'SESSION_READ_DEPENDENCIES_UNEXPECTED';END IF;
   body=replace(body,'FUNCTION public.session_evidence_snapshot(','FUNCTION public.session_evidence_snapshot_read(');
   body=replace(body,'public.session_attendance_source(','public.session_attendance_source_read(');
   body=replace(body,'public.session_report_source(','public.session_report_source_read(');
  END IF;
  body=replace(replace(body,'LANGUAGE plpgsql','LANGUAGE plpgsql STABLE'),'LANGUAGE sql','LANGUAGE sql STABLE');
  EXECUTE body;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.session_attendance_source_read(uuid),public.session_report_source_read(uuid,jsonb),public.session_evidence_snapshot_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_attendance_source_read(uuid),public.session_report_source_read(uuid,jsonb),public.session_evidence_snapshot_read(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 384 $$;

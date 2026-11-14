-- Calendar metadata/reminders stay visible while paperwork is pending.
-- A private meeting link needs current completed paperwork in addition to
-- the SAME effective session membership,verified family and record scope.
CREATE FUNCTION public.session_calendar_meeting_allowed(p_session uuid,p_actor uuid,p_scope jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE source jsonb:=public.session_notification_source(p_session);BEGIN
 IF source IS NULL THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.class_enrollments e
  WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.class_id=(source->>'classId')::uuid AND e.enabled
   AND e.joins_on<=(source->>'on')::date AND(e.leaves_on IS NULL OR e.leaves_on>=(source->>'on')::date)
   AND public.report_recipient(e.student_id,p_actor)
   AND public.scope_contains(p_scope,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',e.student_id,'hubId',e.hub_id)),
    'recordContext',jsonb_build_object('hubId',e.hub_id,'classId',e.class_id,'studentId',e.student_id)))
   -- Future-session membership can be prepared in advance. In-progress or
   -- earlier sessions require actual signing by NOW,not permission at start
   -- inferred from retrospective activity recognition. Accepted native review
   -- independently forbids future signatures. Expired enrollment fails closed.
   AND public.enrollment_agreement_clearance(e.id,greatest(statement_timestamp(),(source->>'startsAt')::timestamptz))->'admissionCleared'='true'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.session_calendar_meeting_allowed(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_calendar_meeting_allowed(uuid,uuid,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 212 $$;

CREATE INDEX calendar_event_overlap ON public.calendar_events USING gist(academy_id,tstzrange(starts_at,ends_at,'[)'));
-- Invoker security and forced tenant RLS. Exact child/family plus effective
-- own enrollment and its actual record scope are required,not a sibling's
-- membership or administrative event visibility. Projection has no reason,
-- approval/source snapshot,other students or private teaching meeting link.
CREATE FUNCTION public.family_calendar_event_source(p_event uuid,p_student uuid,p_actor uuid,p_scope jsonb,p_locale text DEFAULT 'en',p_detail boolean DEFAULT false,p_class uuid DEFAULT NULL,p_hub uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE e record;d jsonb;locale text;BEGIN
 IF p_locale IS NULL OR p_locale NOT IN('en','fr','zh-CN') THEN RETURN NULL;END IF;
 SELECT * INTO e FROM public.calendar_events WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_event;
 IF e.id IS NULL OR e.definition->>'status'='archived' OR NOT public.report_comment_human_verified(p_actor) OR NOT public.report_recipient(p_student,p_actor)
 OR(p_actor<>p_student AND NOT EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=e.academy_id AND student_id=p_student AND guardian_id=p_actor AND relationship IN('parent','legal_guardian') AND state='approved' AND valid_from<=statement_timestamp() AND(valid_until IS NULL OR valid_until>statement_timestamp()))) THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.class_enrollments enrollment JOIN public.classes klass ON klass.academy_id=enrollment.academy_id AND klass.id=enrollment.class_id
  WHERE enrollment.academy_id=e.academy_id AND enrollment.student_id=p_student AND enrollment.enabled
   AND(e.owner_kind='academy' OR(e.owner_kind='hub' AND enrollment.hub_id=e.hub_id) OR(e.owner_kind='class' AND enrollment.class_id=e.class_id))
   AND(p_class IS NULL OR enrollment.class_id=p_class) AND(p_hub IS NULL OR enrollment.hub_id=p_hub)
   AND enrollment.joins_on<=((e.ends_at-interval '1 microsecond') AT TIME ZONE klass.time_zone)::date AND(enrollment.leaves_on IS NULL OR enrollment.leaves_on>=(e.starts_at AT TIME ZONE klass.time_zone)::date)
   AND public.scope_contains(p_scope,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',enrollment.student_id,'hubId',enrollment.hub_id)),'recordContext',jsonb_build_object('hubId',enrollment.hub_id,'classId',enrollment.class_id,'studentId',enrollment.student_id))))
 THEN RETURN NULL;END IF;
 d=e.definition;locale=CASE WHEN d->'content' ? p_locale THEN p_locale ELSE 'en' END;
 RETURN jsonb_build_object('entryType','calendar_event','eventId',e.id,'version',e.version,'ownerKind',e.owner_kind,'hubId',e.hub_id,'classId',e.class_id,'kind',d->'kind','status',d->'status','title',d#>ARRAY['content',locale,'title'],'locale',locale,'startsAt',d->'startsAt','endsAt',d->'endsAt','timeZone',d->'timeZone','allDay',d->'allDay',
  'on',to_char(e.starts_at AT TIME ZONE(d->>'timeZone'),'YYYY-MM-DD'),'localStart',to_char(e.starts_at AT TIME ZONE(d->>'timeZone'),'YYYY-MM-DD"T"HH24:MI'),'localEnd',to_char(e.ends_at AT TIME ZONE(d->>'timeZone'),'YYYY-MM-DD"T"HH24:MI'),
  'country',CASE WHEN e.source_snapshot->'country'='null'::jsonb THEN NULL ELSE jsonb_build_object('code',e.source_snapshot#>'{country,code}','name',e.source_snapshot#>'{country,name}') END,'website',d->'website','websiteVerified',false,'scheduleChangesApplied',false,'recordPath','/api/v1/students/'||p_student::text||'/calendar/events/'||e.id::text)
  ||CASE WHEN p_detail THEN jsonb_build_object('description',d#>ARRAY['content',locale,'description']) ELSE '{}'::jsonb END;
END $$;
REVOKE ALL ON FUNCTION public.family_calendar_event_source(uuid,uuid,uuid,jsonb,text,boolean,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.family_calendar_event_source(uuid,uuid,uuid,jsonb,text,boolean,uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 217 $$;

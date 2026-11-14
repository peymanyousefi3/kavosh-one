-- One shared exact-child permission check for calendar content and change
-- notices. Archived content stays hidden, but a safe withdrawal notice can
-- remain visible to a currently entitled family. No old events are backfilled.
CREATE FUNCTION public.calendar_event_family_allowed(p_event uuid,p_student uuid,p_actor uuid,p_scope jsonb,p_class uuid DEFAULT NULL,p_hub uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET TimeZone='UTC' AS $$ DECLARE e record;BEGIN
 SELECT * INTO e FROM public.calendar_events WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_event;
 IF e.id IS NULL OR NOT public.report_comment_human_verified(p_actor) OR NOT public.report_recipient(p_student,p_actor)
 OR(p_actor<>p_student AND NOT EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=e.academy_id AND student_id=p_student AND guardian_id=p_actor AND relationship IN('parent','legal_guardian') AND state='approved' AND valid_from<=statement_timestamp() AND(valid_until IS NULL OR valid_until>statement_timestamp()))) THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.class_enrollments enrollment JOIN public.classes klass ON klass.academy_id=enrollment.academy_id AND klass.id=enrollment.class_id
  WHERE enrollment.academy_id=e.academy_id AND enrollment.student_id=p_student AND enrollment.enabled
   AND(e.owner_kind='academy' OR(e.owner_kind='hub' AND enrollment.hub_id=e.hub_id) OR(e.owner_kind='class' AND enrollment.class_id=e.class_id))
   AND(p_class IS NULL OR enrollment.class_id=p_class) AND(p_hub IS NULL OR enrollment.hub_id=p_hub)
   AND enrollment.joins_on<=((e.ends_at-interval '1 microsecond') AT TIME ZONE klass.time_zone)::date AND(enrollment.leaves_on IS NULL OR enrollment.leaves_on>=(e.starts_at AT TIME ZONE klass.time_zone)::date)
   AND public.scope_contains(p_scope,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',enrollment.student_id,'hubId',enrollment.hub_id)),'recordContext',jsonb_build_object('hubId',enrollment.hub_id,'classId',enrollment.class_id,'studentId',enrollment.student_id))));
END $$;
DO $$ DECLARE body text;first integer;last integer;BEGIN
 body=pg_get_functiondef('public.family_calendar_event_source(uuid,uuid,uuid,jsonb,text,boolean,uuid,uuid)'::regprocedure);
 first=position(' IF e.id IS NULL OR e.definition' IN body);last=position(' d=e.definition;' IN body);
 IF first=0 OR last<=first OR position('enrollment.joins_on' IN substring(body FROM first FOR last-first))=0 THEN RAISE EXCEPTION 'CALENDAR_FAMILY_SOURCE_CHANGED';END IF;
 EXECUTE substring(body FROM 1 FOR first-1)||' IF e.id IS NULL OR e.definition->>''status''=''archived'' OR NOT public.calendar_event_family_allowed(p_event,p_student,p_actor,p_scope,p_class,p_hub) THEN RETURN NULL;END IF;'||chr(10)||substring(body FROM last);
END $$;
CREATE FUNCTION public.calendar_event_notice_person(p_event uuid,p_actor uuid,p_scope jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM(SELECT p_actor student_id UNION SELECT student_id FROM public.family_relationships WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND guardian_id=p_actor AND relationship IN('parent','legal_guardian') AND state='approved' AND valid_from<=statement_timestamp() AND(valid_until IS NULL OR valid_until>statement_timestamp())) child WHERE public.calendar_event_family_allowed(p_event,child.student_id,p_actor,p_scope))
$$;
CREATE FUNCTION public.calendar_event_notice_source(p_event uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('calendarEventId',id,'eventVersion',version,'ownerKind',owner_kind,'hubId',hub_id,'classId',class_id,'kind',definition->'kind','status',definition->'status','startsAt',definition->'startsAt','endsAt',definition->'endsAt','timeZone',definition->'timeZone','allDay',definition->'allDay','scheduleChangesApplied',false)
 FROM public.calendar_events WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_event
$$;
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule','report_job','pay_statement','account_security','calendar_event'));
ALTER TABLE public.automation_event_sources ADD calendar_event_id uuid,
 ADD FOREIGN KEY(academy_id,calendar_event_id) REFERENCES public.calendar_events(academy_id,id),
 ADD CHECK((source_kind='calendar_event')=(calendar_event_id IS NOT NULL)),
 ADD UNIQUE(academy_id,calendar_event_id,source_version);
GRANT SELECT(academy_id,id,owner_kind,hub_id,class_id,version,definition,approval_id,changed_by,changed_at) ON public.calendar_events TO kavosh_event_policy;
GRANT SELECT(academy_id,event_id,version,definition) ON public.calendar_event_revisions TO kavosh_event_policy;
GRANT SELECT(request_id) ON public.outbox_events TO kavosh_event_policy;
CREATE FUNCTION public.calendar_event_notice_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE source jsonb:=public.calendar_event_notice_source(NEW.calendar_event_id);BEGIN
 IF current_user<>'kavosh_event_policy' OR source IS NULL OR NEW.source_version::text IS DISTINCT FROM source->>'eventVersion' OR NEW.projection->'attributes' IS DISTINCT FROM source OR NEW.projection->>'entityId' IS DISTINCT FROM NEW.calendar_event_id::text OR NEW.hub_id::text IS DISTINCT FROM source->>'hubId' OR NEW.projection->>'eventType' IS DISTINCT FROM NEW.event_type OR NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id()
 OR NOT EXISTS(SELECT 1 FROM public.calendar_events e JOIN public.approval_requests p ON p.academy_id=e.academy_id AND p.id=e.approval_id AND p.status='pending' AND p.action=NEW.event_type AND p.target_id=e.id AND p.target_version=e.version-1 JOIN public.audit_events a ON a.academy_id=e.academy_id AND a.id=NEW.audit_id AND a.entity_id=e.id AND a.action=NEW.event_type AND a.actor_id=e.changed_by AND a.created_at=transaction_timestamp() JOIN public.outbox_events o ON o.academy_id=a.academy_id AND o.request_id=a.request_id AND o.id=NEW.event_id AND o.entity_id=e.id AND o.event_type=a.action AND o.created_at=transaction_timestamp() WHERE e.academy_id=NEW.academy_id AND e.id=NEW.calendar_event_id AND e.version=NEW.source_version AND e.changed_at>=transaction_timestamp() AND a.changes->>'version'=e.version::text AND a.changes->'scheduleChangesApplied'='false'::jsonb)
 THEN RAISE EXCEPTION 'CALENDAR_EVENT_NOTICE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER calendar_event_notice_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='calendar_event') EXECUTE FUNCTION public.calendar_event_notice_guard();
-- Extend the original audited capture, preserving all existing dispatch and
-- follow-up protections and the function identity, owner and privileges.
DO $$ DECLARE body text;needle text:='IF NEW.event_type=''session.follow_up_due'' THEN';BEGIN
 body=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);IF position(needle IN body)=0 THEN RAISE EXCEPTION 'CALENDAR_EVENT_CAPTURE_SOURCE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF NEW.event_type IN('calendar-event.create','calendar-event.change') THEN
  source=public.calendar_event_notice_source(NEW.entity_id);
  IF source IS NULL OR a.changes->>'version' IS DISTINCT FROM source->>'eventVersion' OR NOT EXISTS(SELECT 1 FROM public.calendar_events e JOIN public.calendar_event_revisions r ON r.academy_id=e.academy_id AND r.event_id=e.id AND r.version=e.version WHERE e.academy_id=NEW.academy_id AND e.id=NEW.entity_id AND e.changed_by=a.actor_id AND e.changed_at>=transaction_timestamp() AND r.definition->'definition'=e.definition) THEN RETURN NULL;END IF;
  INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,calendar_event_id)
  VALUES(NEW.academy_id,NEW.id,a.id,NULL,'calendar_event',(source->>'eventVersion')::integer,NEW.event_type,(source->>'hubId')::uuid,at,
   jsonb_build_object('eventType',NEW.event_type,'entityId',NEW.entity_id,'hubId',source->'hubId','actorId',a.actor_id,'actorKind',a.actor_kind,'severity',severity,'occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',source),NEW.entity_id);
 ELSIF NEW.event_type='session.follow_up_due' THEN$branch$);
 body=pg_get_functiondef('public.automation_rule_guard()'::regprocedure);needle='''school_master'',''actor_supervisors'',''people'',''session_guardians'',''session_staff'',''statement_worker''';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'CALENDAR_EVENT_AUDIENCE_SOURCE_CHANGED';END IF;EXECUTE replace(body,needle,needle||',''calendar_guardians''');
END $$;
CREATE FUNCTION public.calendar_event_notice_current(p_notice uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT e.source_version=c.version AND e.projection->'attributes'=public.calendar_event_notice_source(c.id) FROM public.automation_event_sources e JOIN public.calendar_events c ON c.academy_id=e.academy_id AND c.id=e.calendar_event_id WHERE e.event_id=p_notice AND e.source_kind='calendar_event'),false)
$$;
-- A silently suppressed capture is a failure too,not a successful event
-- change without its durable notification source. Web gains no outbox read.
CREATE FUNCTION public.calendar_event_notice_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.automation_event_sources e JOIN public.audit_events a ON a.academy_id=e.academy_id AND a.id=e.audit_id JOIN public.outbox_events o ON o.academy_id=e.academy_id AND o.id=e.event_id WHERE e.academy_id=NEW.academy_id AND e.calendar_event_id=NEW.id AND e.source_kind='calendar_event' AND e.source_version=NEW.version AND e.event_type=CASE WHEN NEW.version=1 THEN 'calendar-event.create' ELSE 'calendar-event.change' END AND e.origin_transaction=pg_current_xact_id() AND a.actor_id=NEW.changed_by AND a.created_at=transaction_timestamp() AND o.request_id=a.request_id AND o.created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'CALENDAR_EVENT_NOTICE_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
ALTER FUNCTION public.calendar_event_notice_complete() OWNER TO kavosh_event_policy;
CREATE CONSTRAINT TRIGGER calendar_event_notice_complete AFTER INSERT OR UPDATE ON public.calendar_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.calendar_event_notice_complete();
REVOKE ALL ON FUNCTION public.calendar_event_notice_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calendar_event_family_allowed(uuid,uuid,uuid,jsonb,uuid,uuid),public.calendar_event_notice_person(uuid,uuid,jsonb),public.calendar_event_notice_source(uuid),public.calendar_event_notice_guard(),public.calendar_event_notice_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calendar_event_family_allowed(uuid,uuid,uuid,jsonb,uuid,uuid),public.calendar_event_notice_person(uuid,uuid,jsonb),public.calendar_event_notice_source(uuid),public.calendar_event_notice_current(uuid) TO kavosh_runtime;
GRANT EXECUTE ON FUNCTION public.calendar_event_notice_source(uuid) TO kavosh_event_policy;
-- Calendar instants retain microseconds. Comparison operands must match that
-- precision; existing rule-window and envelope timestamp limits stay intact.
DO $$ DECLARE body text;BEGIN
 body=pg_get_functiondef('public.automation_instant_valid(jsonb)'::regprocedure);
 IF position('[0-9]{1,3}' IN body)=0 THEN RAISE EXCEPTION 'AUTOMATION_COMPARISON_CLOCK_SOURCE_CHANGED';END IF;
 EXECUTE replace(replace(body,'public.automation_instant_valid','public.automation_comparison_instant_valid'),'[0-9]{1,3}','[0-9]{1,6}');
 body=pg_get_functiondef('public.automation_condition_valid(jsonb)'::regprocedure);
 IF position('public.automation_instant_valid(val)' IN body)=0 THEN RAISE EXCEPTION 'AUTOMATION_COMPARISON_CONDITION_SOURCE_CHANGED';END IF;
 EXECUTE replace(body,'public.automation_instant_valid(val)','public.automation_comparison_instant_valid(val)');
END $$;
REVOKE ALL ON FUNCTION public.automation_comparison_instant_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.automation_comparison_instant_valid(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 218 $$;

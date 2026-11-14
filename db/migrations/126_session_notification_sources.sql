INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('received-calendar.view','View own or linked student session calendar','Learning',true,ARRAY['hub','person','country','region','city']);
CREATE FUNCTION public.session_notification_source(p_session uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE s record;BEGIN
 SELECT cs.*,c.version class_version,c.code class_code,c.name class_name,c.active class_active,c.time_zone INTO s FROM public.class_sessions cs JOIN public.classes c ON c.academy_id=cs.academy_id AND c.id=cs.class_id WHERE cs.id=p_session;
 IF s.id IS NULL OR s.time_info->>'timeZone' IS DISTINCT FROM s.time_zone OR coalesce(s.time_info->>'localStart','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$' OR s.time_info->>'startOffset' IS NULL
  OR((s.time_info->>'localStart')||(s.time_info->>'startOffset'))::timestamptz IS DISTINCT FROM s.starts_at OR(s.time_info->>'start')::timestamptz IS DISTINCT FROM s.starts_at THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('sessionId',s.id,'classId',s.class_id,'hubId',s.hub_id,'sessionVersion',s.version,'classVersion',s.class_version,'classCode',s.class_code,'className',s.class_name,'classActive',s.class_active,'status',s.status,
  'startsAt',to_char(s.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'endsAt',to_char(s.ends_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'localStart',s.time_info->>'localStart','on',left(s.time_info->>'localStart',10),'timeZone',s.time_zone,'mode',s.mode);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
CREATE FUNCTION public.session_calendar_person(p_session uuid,p_actor uuid,p_scope jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE source jsonb:=public.session_notification_source(p_session);BEGIN
 IF source IS NULL THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.class_enrollments e
  WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.class_id=(source->>'classId')::uuid AND e.enabled
   AND e.joins_on<=(source->>'on')::date AND(e.leaves_on IS NULL OR e.leaves_on>=(source->>'on')::date)
   AND public.report_recipient(e.student_id,p_actor)
   AND public.scope_contains(p_scope,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',e.student_id,'hubId',e.hub_id)),
    'recordContext',jsonb_build_object('hubId',e.hub_id,'classId',e.class_id,'studentId',e.student_id))));
END
$$;
REVOKE ALL ON FUNCTION public.session_notification_source(uuid),public.session_calendar_person(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_notification_source(uuid),public.session_calendar_person(uuid,uuid,jsonb) TO kavosh_runtime;
GRANT EXECUTE ON FUNCTION public.session_notification_source(uuid) TO kavosh_event_policy;
GRANT SELECT ON public.class_sessions,public.classes TO kavosh_event_policy;
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session'));
ALTER TABLE public.automation_event_sources ADD COLUMN session_id uuid;
ALTER TABLE public.automation_event_sources ADD FOREIGN KEY(academy_id,session_id) REFERENCES public.class_sessions(academy_id,id);
ALTER TABLE public.automation_event_sources ADD CHECK((source_kind='session')=(session_id IS NOT NULL));
CREATE OR REPLACE FUNCTION public.capture_audited_automation_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a record;at timestamptz:=clock_timestamp();severity text;source jsonb;BEGIN
 IF NEW.event_type LIKE 'approval.%' OR NEW.event_type LIKE 'automation.%' OR NEW.event_type LIKE 'notification.%'
  OR NEW.event_type!~'^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)+$' OR length(NEW.event_type)>160 THEN RETURN NULL;END IF;
 IF(SELECT count(*) FROM public.audit_events WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND action=NEW.event_type AND entity_id=NEW.entity_id AND created_at=transaction_timestamp())<>1 THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND action=NEW.event_type AND entity_id=NEW.entity_id AND created_at=transaction_timestamp();
 IF a.actor_kind NOT IN('human','bot') OR EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND audit_id=a.id) THEN RETURN NULL;END IF;
 severity=CASE WHEN a.changes->>'severity'='critical' THEN 'critical' ELSE 'normal' END;
 IF NEW.event_type='session.changed' THEN
  source=public.session_notification_source(NEW.entity_id);IF source IS NULL OR a.changes#>>'{after,version}' IS DISTINCT FROM source->>'sessionVersion' THEN RETURN NULL;END IF;
  INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,session_id)
  VALUES(NEW.academy_id,NEW.id,a.id,NULL,'session',(source->>'sessionVersion')::integer,NEW.event_type,(source->>'hubId')::uuid,at,
   jsonb_build_object('eventType',NEW.event_type,'entityId',NEW.entity_id,'hubId',source->'hubId','actorId',a.actor_id,'actorKind',a.actor_kind,'severity',severity,
   'occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',source),NEW.entity_id);
 ELSE
  INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection)
  VALUES(NEW.academy_id,NEW.id,a.id,NULL,'audit',1,NEW.event_type,a.hub_id,at,
   jsonb_build_object('eventType',NEW.event_type,'entityId',NEW.entity_id,'hubId',a.hub_id,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity',severity,
   'occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',jsonb_build_object('auditId',a.id,'action',a.action)));
 END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 126 $$;

-- Reuse the existing isolated platform notice publisher. It can record only
-- fixed credential-free findings,never inspect business tables or act as owner.
CREATE TABLE platform_private.operational_health_state(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 source_at timestamptz,source_issues jsonb NOT NULL DEFAULT '[]',current_issues jsonb NOT NULL DEFAULT '[]',
 CHECK(jsonb_typeof(source_issues)='array' AND jsonb_array_length(source_issues)<=20),
 CHECK(jsonb_typeof(current_issues)='array' AND jsonb_array_length(current_issues)<=20)
);
INSERT INTO platform_private.operational_health_state(singleton) VALUES(true);
CREATE TABLE platform_private.operational_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 component text NOT NULL,code text NOT NULL,severity text NOT NULL CHECK(severity IN('warning','critical')),
 transition text NOT NULL CHECK(transition IN('opened','recovered')),source_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),recorded_by text NOT NULL DEFAULT session_user
);
CREATE INDEX operational_event_latest ON platform_private.operational_events(component,code,event_seq DESC);
CREATE INDEX operational_event_inbox ON platform_private.operational_events(created_at DESC,id DESC);
CREATE TABLE platform_private.operational_event_reads(
 owner_user_id uuid NOT NULL REFERENCES identity."user"(id),event_id uuid NOT NULL REFERENCES platform_private.operational_events(id),
 read_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_user_id,event_id)
);
-- One UUID namespace for the shared inbox/read endpoint. Never assume UUIDs
-- in two independent source tables cannot collide.
CREATE TABLE platform_private.notification_ids(id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN('cancellation','operational')));
INSERT INTO platform_private.notification_ids SELECT id,'cancellation' FROM platform_private.owner_notifications;
CREATE TRIGGER notification_id_immutable BEFORE UPDATE OR DELETE ON platform_private.notification_ids FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER notification_id_no_truncate BEFORE TRUNCATE ON platform_private.notification_ids FOR EACH STATEMENT EXECUTE FUNCTION platform_private.immutable_record();
ALTER TABLE platform_private.owner_notifications ADD FOREIGN KEY(id) REFERENCES platform_private.notification_ids(id);
ALTER TABLE platform_private.operational_events ADD FOREIGN KEY(id) REFERENCES platform_private.notification_ids(id);
CREATE TRIGGER operational_event_immutable BEFORE UPDATE OR DELETE ON platform_private.operational_events FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER operational_event_read_immutable BEFORE UPDATE OR DELETE ON platform_private.operational_event_reads FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER operational_event_no_truncate BEFORE TRUNCATE ON platform_private.operational_events FOR EACH STATEMENT EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER operational_event_read_no_truncate BEFORE TRUNCATE ON platform_private.operational_event_reads FOR EACH STATEMENT EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER operational_state_no_delete BEFORE DELETE ON platform_private.operational_health_state FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER operational_state_no_truncate BEFORE TRUNCATE ON platform_private.operational_health_state FOR EACH STATEMENT EXECUTE FUNCTION platform_private.immutable_record();
GRANT SELECT,UPDATE ON platform_private.operational_health_state TO kavosh_platform_policy;
GRANT SELECT,INSERT ON platform_private.operational_events,platform_private.operational_event_reads,platform_private.notification_ids TO kavosh_platform_policy;
GRANT USAGE ON SEQUENCE platform_private.operational_events_event_seq_seq TO kavosh_platform_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
CREATE FUNCTION platform_private.register_notification_id() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO platform_private.notification_ids(id,kind) VALUES(NEW.id,CASE WHEN TG_TABLE_NAME='owner_notifications' THEN 'cancellation' ELSE 'operational' END);RETURN NEW;
END $$;
ALTER FUNCTION platform_private.register_notification_id() OWNER TO kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.register_notification_id() FROM PUBLIC;
CREATE TRIGGER register_notification_id BEFORE INSERT ON platform_private.owner_notifications FOR EACH ROW EXECUTE FUNCTION platform_private.register_notification_id();
CREATE TRIGGER register_notification_id BEFORE INSERT ON platform_private.operational_events FOR EACH ROW EXECUTE FUNCTION platform_private.register_notification_id();
CREATE FUNCTION platform_private.record_operational_health(p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE at_time timestamptz:=clock_timestamp();sample_at timestamptz;incoming jsonb;effective jsonb;prior record;issue jsonb;monitor_issue jsonb;changed integer:=0;recovered integer;opened integer;ack integer;BEGIN
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384 OR(p_input-'observedAt'-'issues')<>'{}'::jsonb
  OR NOT(p_input?'observedAt') OR jsonb_typeof(p_input->'issues') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_OPERATIONAL_OBSERVATION' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(p_input->'issues')>20 THEN RAISE EXCEPTION 'INVALID_OPERATIONAL_OBSERVATION' USING ERRCODE='22023';END IF;
 IF p_input->'observedAt'<>'null'::jsonb THEN
  IF jsonb_typeof(p_input->'observedAt') IS DISTINCT FROM 'string' OR(p_input->>'observedAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$' THEN RAISE EXCEPTION 'INVALID_OPERATIONAL_OBSERVATION' USING ERRCODE='22023';END IF;
  BEGIN sample_at=(p_input->>'observedAt')::timestamptz;EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'INVALID_OPERATIONAL_OBSERVATION' USING ERRCODE='22023';END;
 END IF;
 FOR issue IN SELECT value FROM jsonb_array_elements(p_input->'issues') LOOP
  IF jsonb_typeof(issue) IS DISTINCT FROM 'object' OR(issue-'component'-'code'-'severity')<>'{}'::jsonb
   OR jsonb_typeof(issue->'component') IS DISTINCT FROM 'string' OR jsonb_typeof(issue->'code') IS DISTINCT FROM 'string' OR jsonb_typeof(issue->'severity') IS DISTINCT FROM 'string'
   OR NOT(
    (issue->>'component'='web' AND issue->>'code' IN('WEB_STATUS_UNAVAILABLE','WEB_NOT_RUNNING','READINESS_UNAVAILABLE') AND issue->>'severity'='critical')
    OR(issue->>'component' IN('database-backup','settings-backup') AND issue->>'code' IN('BACKUP_STATUS_UNAVAILABLE','BACKUP_TIMER_STATUS_UNAVAILABLE','BACKUP_TIMER_INACTIVE','BACKUP_LAST_RUN_FAILED','BACKUP_SUCCESS_NOT_VERIFIED','BACKUP_CLOCK_INCONSISTENT','BACKUP_OVERDUE') AND issue->>'severity'='critical')
    OR(issue->>'component'='storage' AND((issue->>'code'='BACKUP_DISK_SPACE_CRITICAL' AND issue->>'severity'='critical') OR(issue->>'code'='BACKUP_DISK_SPACE_LOW' AND issue->>'severity'='warning')))
    OR(issue->>'component'='workers' AND issue->>'code'='WORKER_STATUS_NOT_OBSERVED' AND issue->>'severity'='warning')
    OR(issue->>'component' IN('worker:auth-delivery','worker:messages','worker:notifications','worker:platform-notices','worker:reports','worker:file-promotion','worker:file-verification','worker:file-inspection','worker:image-parser','worker:pdf-parser','worker:video-parser','worker:scanner') AND issue->>'code' IN('WORKER_STATUS_UNAVAILABLE','WORKER_NOT_RUNNING','WORKER_PROCESS_FAILURE') AND issue->>'severity'='critical')
   ) THEN RAISE EXCEPTION 'INVALID_OPERATIONAL_OBSERVATION' USING ERRCODE='22023';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'issues') i GROUP BY i->>'component' HAVING count(*)>1)
  OR(sample_at IS NULL AND p_input->'issues'<>'[]'::jsonb) THEN RAISE EXCEPTION 'INVALID_OPERATIONAL_OBSERVATION' USING ERRCODE='22023';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('platform-operational-health',400)) THEN RETURN jsonb_build_object('claimed',false,'changed',0,'sourceAccepted',false);END IF;
 SELECT * INTO STRICT prior FROM platform_private.operational_health_state WHERE singleton FOR UPDATE;
 -- Old concurrent reads cannot undo a newer observation. Future-clock samples
 -- never advance the watermark and prevent later legitimate clock recovery.
 IF sample_at<=at_time+interval '30 seconds' AND sample_at<prior.source_at THEN RETURN jsonb_build_object('claimed',true,'changed',0,'sourceAccepted',false);END IF;
 SELECT coalesce(jsonb_agg(i ORDER BY i->>'component',i->>'code'),'[]') INTO incoming FROM jsonb_array_elements(p_input->'issues') i;
 IF sample_at BETWEEN at_time-interval '180 seconds' AND at_time+interval '30 seconds' THEN
  IF sample_at=prior.source_at AND incoming IS DISTINCT FROM prior.source_issues THEN RAISE EXCEPTION 'OPERATIONAL_OBSERVATION_CHANGED' USING ERRCODE='23514';END IF;
  effective=incoming;
 ELSE
  -- No recovery is inferred from a missing/stale/invalid-clock source. Retain
  -- existing component findings until a fresh actual observation clears them.
  effective=prior.current_issues;
  monitor_issue=jsonb_build_array(jsonb_build_object('component','monitor','code',CASE WHEN sample_at IS NULL THEN 'MONITOR_OBSERVATION_UNAVAILABLE' WHEN sample_at>at_time THEN 'MONITOR_CLOCK_INCONSISTENT' ELSE 'MONITOR_OBSERVATION_STALE' END,'severity','critical'));
  IF NOT effective@>monitor_issue THEN effective=effective||monitor_issue;END IF;
 END IF;
 INSERT INTO platform_private.operational_events(component,code,severity,transition,source_at)
  SELECT i->>'component',i->>'code',i->>'severity','recovered',sample_at FROM jsonb_array_elements(prior.current_issues) i WHERE NOT effective@>jsonb_build_array(i);
 GET DIAGNOSTICS recovered=ROW_COUNT;
 INSERT INTO platform_private.operational_events(component,code,severity,transition,source_at)
  SELECT i->>'component',i->>'code',i->>'severity','opened',sample_at FROM jsonb_array_elements(effective) i WHERE NOT prior.current_issues@>jsonb_build_array(i);
 GET DIAGNOSTICS opened=ROW_COUNT;
 SELECT count(*)::integer INTO changed FROM(
  SELECT i FROM jsonb_array_elements(prior.current_issues)i WHERE NOT effective@>jsonb_build_array(i)
  UNION ALL SELECT i FROM jsonb_array_elements(effective)i WHERE NOT prior.current_issues@>jsonb_build_array(i)
 ) transitions;
 IF changed<>opened+recovered THEN RAISE EXCEPTION 'OPERATIONAL_EVENT_INCOMPLETE' USING ERRCODE='XX000';END IF;
 UPDATE platform_private.operational_health_state SET current_issues=effective,
  source_at=CASE WHEN sample_at BETWEEN at_time-interval '180 seconds' AND at_time+interval '30 seconds' THEN sample_at ELSE source_at END,
  source_issues=CASE WHEN sample_at BETWEEN at_time-interval '180 seconds' AND at_time+interval '30 seconds' THEN incoming ELSE source_issues END WHERE singleton;
 GET DIAGNOSTICS ack=ROW_COUNT;IF ack<>1 THEN RAISE EXCEPTION 'OPERATIONAL_STATE_INCOMPLETE' USING ERRCODE='XX000';END IF;
 RETURN jsonb_build_object('claimed',true,'changed',changed,'sourceAccepted',sample_at IS NOT NULL AND sample_at BETWEEN at_time-interval '180 seconds' AND at_time+interval '30 seconds');
END $$;
ALTER FUNCTION platform_private.record_operational_health(jsonb) OWNER TO kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.record_operational_health(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_private.record_operational_health(jsonb) TO kavosh_platform_notice_worker;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;

-- Preserve the existing purpose/MFA/idempotency/audit boundary and combine
-- operational transitions with cancellation notices in the SAME owner inbox.
DO $$ DECLARE body text;needle text;replacement text;BEGIN
 body=pg_get_functiondef('platform_private.owner_inbox(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 needle=$old$  IF NOT EXISTS(SELECT 1 FROM platform_private.owner_notifications WHERE owner_user_id=p_user AND id=target) THEN RAISE EXCEPTION 'PLATFORM_NOTIFICATION_NOT_FOUND' USING ERRCODE='P0002';END IF;
  INSERT INTO platform_private.owner_notification_reads(owner_user_id,notification_id) VALUES(p_user,target) ON CONFLICT DO NOTHING;
  SELECT jsonb_build_object('id',notification_id,'readAt',read_at) INTO data FROM platform_private.owner_notification_reads WHERE owner_user_id=p_user AND notification_id=target;$old$;
 replacement=$new$  IF EXISTS(SELECT 1 FROM platform_private.operational_events WHERE id=target) THEN
   INSERT INTO platform_private.operational_event_reads(owner_user_id,event_id) VALUES(p_user,target) ON CONFLICT DO NOTHING;
   SELECT jsonb_build_object('id',event_id,'readAt',read_at) INTO data FROM platform_private.operational_event_reads WHERE owner_user_id=p_user AND event_id=target;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM platform_private.owner_notifications WHERE owner_user_id=p_user AND id=target) THEN RAISE EXCEPTION 'PLATFORM_NOTIFICATION_NOT_FOUND' USING ERRCODE='P0002';END IF;
   INSERT INTO platform_private.owner_notification_reads(owner_user_id,notification_id) VALUES(p_user,target) ON CONFLICT DO NOTHING;
   SELECT jsonb_build_object('id',notification_id,'readAt',read_at) INTO data FROM platform_private.owner_notification_reads WHERE owner_user_id=p_user AND notification_id=target;
  END IF;$new$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'OPERATIONAL_NOTICE_READ_SHAPE_CHANGED';END IF;body=replace(body,needle,replacement);
 needle='  SELECT n.id,n.created_at,jsonb_build_object';replacement='  SELECT * FROM((SELECT n.id,n.created_at,jsonb_build_object';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'OPERATIONAL_INBOX_START_CHANGED';END IF;body=replace(body,needle,replacement);
 needle=$old$ORDER BY n.created_at DESC,n.id DESC LIMIT lim+1
 )page;$old$;
 replacement=$new$ORDER BY n.created_at DESC,n.id DESC LIMIT lim+1)
  UNION ALL
  (SELECT e.id,e.created_at,jsonb_build_object('id',e.id,'kind','operational_'||e.transition,'origin','mandatory','messageKey','platform.operations.'||e.code||'.'||e.transition,'createdAt',e.created_at,'eventAt',e.created_at,'readAt',rd.read_at,
   'operational',jsonb_build_object('component',e.component,'code',e.code,'severity',e.severity,'transition',e.transition,'sourceAt',e.source_at),
   'sourceCurrent',e.event_seq=(SELECT max(x.event_seq) FROM platform_private.operational_events x WHERE x.component=e.component AND x.code=e.code),
   'actionable',e.transition='opened' AND e.event_seq=(SELECT max(x.event_seq) FROM platform_private.operational_events x WHERE x.component=e.component AND x.code=e.code)) entry
   FROM platform_private.operational_events e LEFT JOIN platform_private.operational_event_reads rd ON rd.event_id=e.id AND rd.owner_user_id=p_user
   WHERE(unread IS NULL OR unread=(rd.event_id IS NULL)) AND(cursor_time IS NULL OR(e.created_at,e.id)<(cursor_time,cursor_id)) ORDER BY e.created_at DESC,e.id DESC LIMIT lim+1)
  )combined ORDER BY created_at DESC,id DESC LIMIT lim+1
 )page;$new$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'OPERATIONAL_INBOX_END_CHANGED';END IF;
 EXECUTE replace(body,needle,replacement);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 400 $$;

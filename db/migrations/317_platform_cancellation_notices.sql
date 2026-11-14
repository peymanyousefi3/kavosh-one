DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kavosh_platform_notice_worker') THEN CREATE ROLE kavosh_platform_notice_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='kavosh_platform_notice_worker' AND(r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid))) THEN RAISE EXCEPTION 'UNSAFE_PLATFORM_NOTICE_WORKER';END IF;
END $$;
GRANT USAGE ON SCHEMA platform_private TO kavosh_platform_notice_worker;
CREATE TABLE platform_private.notice_batches(
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES identity."user"(id),published integer NOT NULL CHECK(published BETWEEN 0 AND 100),processed integer NOT NULL CHECK(processed BETWEEN 1 AND 100 AND processed>=published),
 invoked_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE platform_private.owner_notifications(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL REFERENCES identity."user"(id),case_id uuid NOT NULL REFERENCES platform_private.school_cancellation_requests(id),
 kind text NOT NULL CHECK(kind IN('requested','review_ready','withdrawn','confirmed')),event_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 batch_id uuid NOT NULL REFERENCES platform_private.notice_batches(id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(owner_user_id,case_id,kind),UNIQUE(owner_user_id,id)
);
CREATE INDEX platform_owner_inbox ON platform_private.owner_notifications(owner_user_id,created_at DESC,id DESC);
CREATE INDEX platform_notice_batch_rows ON platform_private.owner_notifications(batch_id,owner_user_id);
CREATE TABLE platform_private.notice_tasks(
 case_id uuid NOT NULL REFERENCES platform_private.school_cancellation_requests(id),kind text NOT NULL CHECK(kind IN('requested','review_ready','withdrawn','confirmed')),available_at timestamptz NOT NULL,
 completed_at timestamptz,batch_id uuid REFERENCES platform_private.notice_batches(id) DEFERRABLE INITIALLY DEFERRED,outcome text CHECK(outcome IN('published','skipped')),
 PRIMARY KEY(case_id,kind),CHECK(completed_at IS NULL OR completed_at>=available_at),CHECK((completed_at IS NULL AND batch_id IS NULL AND outcome IS NULL) OR(completed_at IS NOT NULL AND batch_id IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX platform_pending_notice_tasks ON platform_private.notice_tasks(available_at,case_id,kind) WHERE completed_at IS NULL;
CREATE INDEX platform_completed_notice_tasks ON platform_private.notice_tasks(batch_id) WHERE batch_id IS NOT NULL;
ALTER TABLE platform_private.owner_notifications ADD FOREIGN KEY(case_id,kind) REFERENCES platform_private.notice_tasks(case_id,kind);
GRANT SELECT,INSERT ON platform_private.notice_tasks TO kavosh_platform_policy;
GRANT UPDATE(completed_at,batch_id,outcome) ON platform_private.notice_tasks TO kavosh_platform_policy;
CREATE FUNCTION platform_private.queue_cancellation_notices() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE actual integer;expected integer;BEGIN
 IF TG_TABLE_NAME='school_cancellation_requests' THEN
  INSERT INTO platform_private.notice_tasks(case_id,kind,available_at) VALUES(NEW.id,'requested',NEW.requested_at),(NEW.id,'review_ready',NEW.review_after);expected=2;
 ELSE INSERT INTO platform_private.notice_tasks(case_id,kind,available_at) VALUES(NEW.request_id,NEW.decision,NEW.decided_at);expected=1;END IF;
 GET DIAGNOSTICS actual=ROW_COUNT;IF actual<>expected THEN RAISE EXCEPTION 'PLATFORM_NOTICE_SOURCE_QUEUE_INCOMPLETE' USING ERRCODE='XX000';END IF;RETURN NULL;
END $$;
CREATE TRIGGER cancellation_requested_notice_tasks AFTER INSERT ON platform_private.school_cancellation_requests FOR EACH ROW EXECUTE FUNCTION platform_private.queue_cancellation_notices();
CREATE TRIGGER cancellation_decision_notice_tasks AFTER INSERT ON platform_private.school_cancellation_decisions FOR EACH ROW EXECUTE FUNCTION platform_private.queue_cancellation_notices();
INSERT INTO platform_private.notice_tasks(case_id,kind,available_at) SELECT id,'requested',requested_at FROM platform_private.school_cancellation_requests UNION ALL SELECT id,'review_ready',review_after FROM platform_private.school_cancellation_requests;
INSERT INTO platform_private.notice_tasks(case_id,kind,available_at) SELECT request_id,decision,decided_at FROM platform_private.school_cancellation_decisions;
CREATE TABLE platform_private.owner_notification_reads(
 owner_user_id uuid NOT NULL,notification_id uuid NOT NULL,read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_user_id,notification_id),FOREIGN KEY(owner_user_id,notification_id) REFERENCES platform_private.owner_notifications(owner_user_id,id)
);
CREATE TRIGGER notice_batch_immutable BEFORE UPDATE OR DELETE ON platform_private.notice_batches FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER owner_notice_immutable BEFORE UPDATE OR DELETE ON platform_private.owner_notifications FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER owner_notice_read_immutable BEFORE UPDATE OR DELETE ON platform_private.owner_notification_reads FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
GRANT SELECT,INSERT ON platform_private.notice_batches,platform_private.owner_notifications,platform_private.owner_notification_reads TO kavosh_platform_policy;
CREATE FUNCTION platform_private.verify_notice_batch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.published<>(SELECT count(*) FROM platform_private.owner_notifications WHERE batch_id=NEW.id AND owner_user_id=NEW.owner_user_id) OR NEW.processed<>(SELECT count(*) FROM platform_private.notice_tasks WHERE batch_id=NEW.id) THEN RAISE EXCEPTION 'PLATFORM_NOTICE_BATCH_INCOMPLETE' USING ERRCODE='XX000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER notice_batch_complete AFTER INSERT ON platform_private.notice_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.verify_notice_batch();
CREATE FUNCTION platform_private.guard_notice_task_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF ROW(NEW.case_id,NEW.kind,NEW.available_at) IS DISTINCT FROM ROW(OLD.case_id,OLD.kind,OLD.available_at) OR(OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'PLATFORM_NOTICE_TASK_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER notice_task_source BEFORE UPDATE ON platform_private.notice_tasks FOR EACH ROW EXECUTE FUNCTION platform_private.guard_notice_task_source();
CREATE TRIGGER notice_task_no_delete BEFORE DELETE ON platform_private.notice_tasks FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE FUNCTION platform_private.verify_notice_task() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE owner_id uuid;notice_id uuid;source_time timestamptz;BEGIN
 SELECT CASE WHEN NEW.kind='requested' THEN r.requested_at WHEN NEW.kind='review_ready' THEN r.review_after WHEN NEW.kind=d.decision THEN d.decided_at END INTO source_time FROM platform_private.school_cancellation_requests r LEFT JOIN platform_private.school_cancellation_decisions d ON d.request_id=r.id WHERE r.id=NEW.case_id;
 IF source_time IS NULL OR NEW.available_at IS DISTINCT FROM source_time THEN RAISE EXCEPTION 'PLATFORM_NOTICE_TASK_SOURCE_MISSING' USING ERRCODE='XX000';END IF;
 IF NEW.completed_at IS NULL THEN RETURN NULL;END IF;
 SELECT owner_user_id INTO owner_id FROM platform_private.notice_batches WHERE id=NEW.batch_id;
 SELECT id INTO notice_id FROM platform_private.owner_notifications WHERE owner_user_id=owner_id AND case_id=NEW.case_id AND kind=NEW.kind AND batch_id=NEW.batch_id AND event_at=NEW.available_at;
 IF owner_id IS NULL OR(NEW.outcome='published' AND notice_id IS NULL) OR(NEW.outcome='skipped' AND(NEW.kind<>'review_ready' OR notice_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM platform_private.school_cancellation_decisions WHERE request_id=NEW.case_id))) THEN RAISE EXCEPTION 'PLATFORM_NOTICE_TASK_EFFECTS_MISSING' USING ERRCODE='XX000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER notice_task_complete AFTER INSERT OR UPDATE ON platform_private.notice_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.verify_notice_task();
CREATE FUNCTION platform_private.verify_owner_notice_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE source record;owner_id uuid;BEGIN
 SELECT user_id INTO owner_id FROM platform_private.owner_registration WHERE singleton;
 SELECT r.requested_at,r.review_after,d.decision,d.decided_at INTO source FROM platform_private.school_cancellation_requests r LEFT JOIN platform_private.school_cancellation_decisions d ON d.request_id=r.id WHERE r.id=NEW.case_id;
 IF NOT FOUND OR NEW.owner_user_id IS DISTINCT FROM owner_id OR NEW.created_at<NEW.event_at
 OR(NEW.kind='requested' AND NEW.event_at IS DISTINCT FROM source.requested_at)
 OR(NEW.kind='review_ready' AND(NEW.event_at IS DISTINCT FROM source.review_after OR(source.decided_at IS NOT NULL AND source.decided_at<=source.review_after)))
 OR(NEW.kind IN('withdrawn','confirmed') AND(NEW.kind IS DISTINCT FROM source.decision OR NEW.event_at IS DISTINCT FROM source.decided_at))
 THEN RAISE EXCEPTION 'PLATFORM_NOTICE_SOURCE_CHANGED' USING ERRCODE='XX000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER owner_notice_source_complete AFTER INSERT ON platform_private.owner_notifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.verify_owner_notice_source();
CREATE FUNCTION platform_private.publish_cancellation_notices(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id uuid;batch uuid:=gen_random_uuid();candidates jsonb;expected integer;actual integer;ack integer;at_time timestamptz;processed integer;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_PLATFORM_NOTICE_LIMIT' USING ERRCODE='22023';END IF;
 -- ponytail: one bounded platform inbox publisher;partition/claim rows if
 -- measured multi-worker throughput ever requires parallel publication.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('platform-cancellation-notices',317)) THEN RETURN jsonb_build_object('claimed',false,'published',0,'processed',0,'batchId',NULL);END IF;
 SELECT user_id INTO owner_id FROM platform_private.owner_registration WHERE singleton;
 IF owner_id IS NULL THEN RETURN jsonb_build_object('claimed',true,'published',0,'processed',0,'batchId',NULL);END IF;at_time=clock_timestamp();
 SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.event_at,c.id,c.kind),'[]'::jsonb) INTO candidates FROM(
  SELECT t.case_id id,t.kind,t.available_at event_at,t.kind<>'review_ready' OR NOT EXISTS(SELECT 1 FROM platform_private.school_cancellation_decisions d WHERE d.request_id=t.case_id) AS publish
  FROM platform_private.notice_tasks t WHERE t.completed_at IS NULL AND t.available_at<=at_time ORDER BY t.available_at,t.case_id,t.kind LIMIT p_limit
 )c;
 processed=jsonb_array_length(candidates);IF processed=0 THEN RETURN jsonb_build_object('claimed',true,'published',0,'processed',0,'batchId',NULL);END IF;
 SELECT count(*) INTO expected FROM jsonb_to_recordset(candidates)c(publish boolean) WHERE c.publish;
 INSERT INTO platform_private.owner_notifications(owner_user_id,case_id,kind,event_at,batch_id) SELECT owner_id,c.id,c.kind,c.event_at,batch FROM jsonb_to_recordset(candidates)c(id uuid,kind text,event_at timestamptz,publish boolean) WHERE c.publish;
 GET DIAGNOSTICS actual=ROW_COUNT;
 IF actual<>expected THEN RAISE EXCEPTION 'PLATFORM_NOTICE_PUBLICATION_INCOMPLETE' USING ERRCODE='XX000';END IF;
 UPDATE platform_private.notice_tasks t SET completed_at=clock_timestamp(),batch_id=batch,outcome=CASE WHEN c.publish THEN 'published' ELSE 'skipped' END FROM jsonb_to_recordset(candidates)c(id uuid,kind text,publish boolean) WHERE t.case_id=c.id AND t.kind=c.kind AND t.completed_at IS NULL;
 GET DIAGNOSTICS ack=ROW_COUNT;IF ack<>processed THEN RAISE EXCEPTION 'PLATFORM_NOTICE_TASKS_INCOMPLETE' USING ERRCODE='XX000';END IF;
 -- This is explicitly a machine batch,not a fabricated human audit action.
 INSERT INTO platform_private.notice_batches(id,owner_user_id,published,processed,invoked_by) VALUES(batch,owner_id,actual,processed,session_user) RETURNING 1 INTO ack;
 IF ack IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'PLATFORM_NOTICE_BATCH_INCOMPLETE' USING ERRCODE='XX000';END IF;
 RETURN jsonb_build_object('claimed',true,'published',actual,'processed',processed,'batchId',batch);
END $$;
REVOKE ALL ON FUNCTION platform_private.verify_notice_batch(),platform_private.verify_notice_task(),platform_private.guard_notice_task_source(),platform_private.verify_owner_notice_source(),platform_private.queue_cancellation_notices(),platform_private.publish_cancellation_notices(integer) FROM PUBLIC;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
ALTER FUNCTION platform_private.verify_notice_batch() OWNER TO kavosh_platform_policy;
ALTER FUNCTION platform_private.verify_notice_task() OWNER TO kavosh_platform_policy;
ALTER FUNCTION platform_private.queue_cancellation_notices() OWNER TO kavosh_platform_policy;
ALTER FUNCTION platform_private.verify_owner_notice_source() OWNER TO kavosh_platform_policy;
ALTER FUNCTION platform_private.publish_cancellation_notices(integer) OWNER TO kavosh_platform_policy;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
GRANT EXECUTE ON FUNCTION platform_private.publish_cancellation_notices(integer) TO kavosh_platform_notice_worker;
GRANT EXECUTE ON FUNCTION public.schema_revision() TO kavosh_platform_notice_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 317 $$;

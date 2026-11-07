-- The same current exact-review predicate drives the central list and timers.
CREATE FUNCTION public.session_follow_up_attention(s jsonb,review_source jsonb,decision text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(s->>'status'='scheduled' AND s->>'sessionEnded'='true' AND NOT(coalesce(decision='accepted',false) AND review_source IS NOT DISTINCT FROM(s-ARRAY['snapshotAt','sessionStarted','sessionEnded'])),false)
$$;
CREATE FUNCTION public.session_follow_up_source(p_session uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE s jsonb;r record;stamp text;BEGIN
 s=public.session_evidence_snapshot(p_session);IF s IS NULL THEN RETURN NULL;END IF;
 SELECT version,decision,source INTO r FROM public.session_evidence_reviews WHERE session_id=p_session;
 IF NOT public.session_follow_up_attention(s,r.source,r.decision) THEN RETURN NULL;END IF;
 stamp=encode(sha256(convert_to(jsonb_build_array(s-ARRAY['snapshotAt','sessionStarted','sessionEnded'],r.version,r.decision,r.source)::text,'UTF8')),'hex');
 RETURN jsonb_build_object('sessionId',s->'sessionId','classId',s->'classId','hubId',s->'hubId','sessionVersion',s->'sessionVersion','status',s->'status','startsAt',s->'startsAt','endsAt',s->'endsAt','timeZone',s->'timeZone',
 'followUp',jsonb_build_object('stamp',stamp,'sourceValid',s->'sourceValid','requiresBackground',(s->>'staffCount')::integer>200 OR s->>'rosterTooLarge'='true',
 'missingAttendance',s->>'attendanceVersion' IS NULL,'staleAttendance',coalesce(s->>'attendanceCurrent'='false',false),'missingReport',s->>'hasReportText'='false','staleReport',coalesce(s->>'reportTextCurrent'='false',false),'missingMedia',(s->>'mediaReferenceCount')::integer=0,'staleMedia',coalesce(s->>'reportCurrent'='false',false),
 'missingTime',CASE WHEN(s->>'staffCount')::integer>200 OR s->>'rosterTooLarge'='true' THEN NULL ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(s->'staff') t WHERE t->>'expected'='true' AND t->>'entryId' IS NULL) END,'staleTime',CASE WHEN(s->>'staffCount')::integer>200 OR s->>'rosterTooLarge'='true' THEN NULL ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(s->'staff') t WHERE t->>'entryId' IS NOT NULL AND(t->'sessionVersion' IS DISTINCT FROM s->'sessionVersion' OR t->>'assignmentCurrent'='false')) END,
 'reviewVersion',r.version,'reviewDecision',r.decision,'reviewCurrent',r.source IS NOT DISTINCT FROM(s-ARRAY['snapshotAt','sessionStarted','sessionEnded'])));
END $$;
REVOKE ALL ON FUNCTION public.session_follow_up_attention(jsonb,jsonb,text),public.session_follow_up_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_follow_up_attention(jsonb,jsonb,text),public.session_follow_up_source(uuid) TO kavosh_runtime;
CREATE INDEX sessions_follow_up_end ON public.class_sessions(academy_id,ends_at,id) WHERE status='scheduled';
-- Bound each timer step to100authorized sessions. A private rotating cursor
-- wraps after the last page,so completed sessions cannot hide later ones.
CREATE TABLE public.session_follow_up_scans(academy_id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,last_ends_at timestamptz,last_session_id uuid,PRIMARY KEY(academy_id,subscription_id),FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id),CHECK((last_ends_at IS NULL)=(last_session_id IS NULL)));
ALTER TABLE public.session_follow_up_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_follow_up_scans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.session_follow_up_scans USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON public.session_follow_up_scans TO kavosh_automation_worker;
CREATE FUNCTION public.session_follow_up_scan_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT pg_has_role(current_user,'kavosh_automation_worker','member') OR(TG_OP='UPDATE' AND ROW(NEW.academy_id,NEW.subscription_id) IS DISTINCT FROM ROW(OLD.academy_id,OLD.subscription_id)) OR NOT EXISTS(SELECT 1 FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'SESSION_FOLLOW_UP_SCAN_LEASE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER session_follow_up_scan_guard BEFORE INSERT OR UPDATE ON public.session_follow_up_scans FOR EACH ROW EXECUTE FUNCTION public.session_follow_up_scan_guard();
REVOKE ALL ON FUNCTION public.session_follow_up_scan_guard() FROM PUBLIC;
DO $$ DECLARE body text;BEGIN
 body=pg_get_functiondef('public.automation_rule_guard()'::regprocedure);
 IF position('keys||ARRAY[''sessionReminder'']' IN body)=0 THEN RAISE EXCEPTION 'RULE_TIMER_BASE_UNEXPECTED';END IF;
 body=replace(body,'keys||ARRAY[''sessionReminder'']','keys||ARRAY[''sessionReminder'',''sessionFollowUp'']');
 body=replace(body,'a=d->''trigger'';',$branch$IF d ? 'sessionFollowUp' THEN
  a=d->'sessionFollowUp';IF d ? 'sessionReminder' OR jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['minutesAfter','maxDelayMinutes']) OR a-ARRAY['minutesAfter','maxDelayMinutes']<>'{}'::jsonb THEN RAISE EXCEPTION 'AUTOMATION_FOLLOW_UP_INVALID' USING ERRCODE='23514';END IF;
  FOREACH k IN ARRAY ARRAY['minutesAfter','maxDelayMinutes'] LOOP IF jsonb_typeof(a->k) IS DISTINCT FROM 'number' OR(a->>k)::numeric<>trunc((a->>k)::numeric) OR(a->>k)::numeric NOT BETWEEN(CASE WHEN k='minutesAfter' THEN 0 ELSE 1 END) AND 43200 THEN RAISE EXCEPTION 'AUTOMATION_FOLLOW_UP_INVALID' USING ERRCODE='23514';END IF;END LOOP;
 END IF;
 a=d->'trigger';$branch$);EXECUTE body;
END $$;
CREATE TABLE public.session_follow_up_occurrences(
 academy_id uuid NOT NULL,id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,rule_id uuid NOT NULL,rule_version integer NOT NULL,session_id uuid NOT NULL,request_id uuid NOT NULL,
 minutes_after integer NOT NULL CHECK(minutes_after BETWEEN 0 AND 43200),max_delay_minutes integer NOT NULL CHECK(max_delay_minutes BETWEEN 1 AND 43200),source jsonb NOT NULL,source_stamp text NOT NULL CHECK(source_stamp~'^[a-f0-9]{64}$'),due_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),UNIQUE(academy_id,rule_id,session_id,minutes_after,max_delay_minutes,source_stamp),
 FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id),FOREIGN KEY(academy_id,rule_id,rule_version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version),FOREIGN KEY(academy_id,session_id) REFERENCES public.class_sessions(academy_id,id));
ALTER TABLE public.session_follow_up_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_follow_up_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.session_follow_up_occurrences USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.session_follow_up_occurrences TO kavosh_runtime,kavosh_event_policy;
GRANT INSERT(academy_id,id,subscription_id,lease_token,rule_id,rule_version,session_id,request_id,minutes_after,max_delay_minutes) ON public.session_follow_up_occurrences TO kavosh_automation_worker;
CREATE FUNCTION public.session_follow_up_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE sub record;d jsonb;s record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SESSION_FOLLOW_UP_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT pg_has_role(current_user,'kavosh_automation_worker','member') THEN RAISE EXCEPTION 'SESSION_FOLLOW_UP_WORKER_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO sub FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND rule_id=NEW.rule_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp();
 SELECT v.definition INTO d FROM public.automation_rules r JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version WHERE r.academy_id=NEW.academy_id AND r.id=NEW.rule_id AND r.version=NEW.rule_version AND(r.hub_id IS NULL OR r.hub_id=(SELECT hub_id FROM public.class_sessions WHERE id=NEW.session_id));
 PERFORM c.id FROM public.classes c JOIN public.class_sessions child ON child.academy_id=c.academy_id AND child.class_id=c.id WHERE child.id=NEW.session_id FOR SHARE OF c;
 SELECT * INTO s FROM public.class_sessions WHERE academy_id=NEW.academy_id AND id=NEW.session_id FOR SHARE;
 NEW.source=public.session_follow_up_source(NEW.session_id);NEW.source_stamp=NEW.source#>>'{followUp,stamp}';NEW.due_at=s.ends_at+NEW.minutes_after*interval '1 minute';NEW.created_at=clock_timestamp();
 IF sub.id IS NULL OR d IS NULL OR d->'enabled' IS DISTINCT FROM 'true'::jsonb OR d#>>'{execution,mode}' IS DISTINCT FROM 'automatic'
 OR(d->>'startsAt' IS NOT NULL AND clock_timestamp()<(d->>'startsAt')::timestamptz) OR(d->>'endsAt' IS NOT NULL AND clock_timestamp()>(d->>'endsAt')::timestamptz)
 OR d#>>'{sessionFollowUp,minutesAfter}' IS DISTINCT FROM NEW.minutes_after::text OR d#>>'{sessionFollowUp,maxDelayMinutes}' IS DISTINCT FROM NEW.max_delay_minutes::text
 OR NEW.source IS NULL OR NEW.due_at>clock_timestamp() OR NEW.due_at+NEW.max_delay_minutes*interval '1 minute'<=clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND status='active') THEN RAISE EXCEPTION 'SESSION_FOLLOW_UP_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER session_follow_up_guard BEFORE INSERT OR UPDATE OR DELETE ON public.session_follow_up_occurrences FOR EACH ROW EXECUTE FUNCTION public.session_follow_up_guard();
-- Keep the established audit-bound capture;bind the exact leased occurrence,
-- not arbitrary caller attributes or a fictional action by the teacher.
DO $$ DECLARE body text;BEGIN
 body=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);
 IF position('IF NEW.event_type IN(''session.changed'',''session.reminder_due'') THEN' IN body)=0 THEN RAISE EXCEPTION 'SESSION_CAPTURE_BASE_UNEXPECTED';END IF;
 body=replace(body,'IF NEW.event_type IN(''session.changed'',''session.reminder_due'') THEN',$branch$IF NEW.event_type='session.follow_up_due' THEN
  SELECT * INTO timer FROM public.session_follow_up_occurrences WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND session_id=NEW.entity_id;
  SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
  IF timer.id IS NULL OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id OR a.changes->>'followUpReceiptId' IS DISTINCT FROM timer.id::text THEN RETURN NULL;END IF;
  source=timer.source||jsonb_build_object('followUp',timer.source->'followUp'||jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id,'minutesAfter',timer.minutes_after,'maxDelayMinutes',timer.max_delay_minutes,'dueAt',to_char(timer.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,session_id) VALUES(NEW.academy_id,NEW.id,a.id,NULL,'session',(source->>'sessionVersion')::integer,NEW.event_type,(source->>'hubId')::uuid,at,jsonb_build_object('eventType',NEW.event_type,'entityId',NEW.entity_id,'hubId',source->'hubId','actorId',a.actor_id,'actorKind',a.actor_kind,'severity','critical','occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',source),NEW.entity_id);
 ELSIF NEW.event_type IN('session.changed','session.reminder_due') THEN$branch$);EXECUTE body;
END $$;
CREATE FUNCTION public.session_follow_up_current(p_event uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE o record;d jsonb;source jsonb;BEGIN
 SELECT t.* INTO o FROM public.session_follow_up_occurrences t JOIN public.automation_event_sources e ON e.academy_id=t.academy_id AND e.projection#>>'{attributes,followUp,receiptId}'=t.id::text WHERE e.event_id=p_event AND e.event_type='session.follow_up_due';IF o.id IS NULL THEN RETURN false;END IF;
 SELECT v.definition INTO d FROM public.automation_rules r JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version WHERE r.id=o.rule_id;
 source=public.session_follow_up_source(o.session_id);
 RETURN coalesce(source#>>'{followUp,stamp}'=o.source_stamp AND d->'enabled'='true'::jsonb AND d#>>'{execution,mode}'='automatic' AND d#>>'{sessionFollowUp,minutesAfter}'=o.minutes_after::text AND d#>>'{sessionFollowUp,maxDelayMinutes}'=o.max_delay_minutes::text
 AND(d->>'startsAt' IS NULL OR clock_timestamp()>=(d->>'startsAt')::timestamptz) AND(d->>'endsAt' IS NULL OR clock_timestamp()<=(d->>'endsAt')::timestamptz) AND clock_timestamp()>=o.due_at AND clock_timestamp()<o.due_at+o.max_delay_minutes*interval '1 minute',false);
END $$;
CREATE FUNCTION public.session_follow_up_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.automation_event_sources e WHERE e.academy_id=NEW.academy_id AND e.event_type='session.follow_up_due' AND e.session_id=NEW.session_id AND e.projection#>>'{attributes,followUp,receiptId}'=NEW.id::text) THEN RAISE EXCEPTION 'SESSION_FOLLOW_UP_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER session_follow_up_complete AFTER INSERT ON public.session_follow_up_occurrences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.session_follow_up_complete();
CREATE FUNCTION public.follow_up_delivery_current() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.outcome='processed' AND(NEW.summary->>'portalNotifications')::integer>0 AND EXISTS(SELECT 1 FROM public.automation_event_sources WHERE event_id=NEW.event_id AND event_type='session.follow_up_due') AND NOT public.session_follow_up_current(NEW.event_id) THEN RAISE EXCEPTION 'SESSION_FOLLOW_UP_DELIVERY_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER follow_up_delivery_current AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.follow_up_delivery_current();
REVOKE ALL ON FUNCTION public.session_follow_up_guard(),public.session_follow_up_current(uuid),public.session_follow_up_complete(),public.follow_up_delivery_current() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_follow_up_current(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 140 $$;

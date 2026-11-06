CREATE OR REPLACE FUNCTION public.automation_rule_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record;p record;d jsonb:=NEW.definition;a jsonb;e jsonb;aud jsonb;labels jsonb;k text;keys text[];disable_only boolean;
BEGIN
 SELECT * INTO r FROM public.automation_rules WHERE academy_id=NEW.academy_id AND id=NEW.rule_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 disable_only=NEW.version>1 AND d->'enabled'='false'::jsonb AND(d-'enabled')=(SELECT definition-'enabled' FROM public.automation_rule_revisions WHERE academy_id=NEW.academy_id AND rule_id=NEW.rule_id AND version=NEW.version-1);
 IF r.id IS NULL OR r.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.automation_rule_revisions WHERE academy_id=NEW.academy_id AND rule_id=NEW.rule_id) OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'automation.rule.create' ELSE 'automation.rule.change' END) OR p.target_id IS DISTINCT FROM NEW.rule_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'automations.view' OR p.payload->'definition' IS DISTINCT FROM d OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR(NEW.version=1 AND((p.payload->>'hubId')::uuid IS DISTINCT FROM r.hub_id OR p.payload->>'code' IS DISTINCT FROM r.code)) THEN RAISE EXCEPTION 'AUTOMATION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 keys=ARRAY['name','enabled','startsAt','endsAt','trigger','condition','actions','execution'];
 IF NOT(d ?& keys) OR d-(keys||ARRAY['sessionReminder'])<>'{}'::jsonb OR jsonb_typeof(d->'name') IS DISTINCT FROM 'string' OR length(btrim(d->>'name')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(d->'enabled') IS DISTINCT FROM 'boolean' OR NOT public.automation_condition_valid(d->'condition') THEN RAISE EXCEPTION 'AUTOMATION_DEFINITION_INVALID' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['startsAt','endsAt'] LOOP IF d->k<>'null'::jsonb AND NOT public.automation_instant_valid(d->k) THEN RAISE EXCEPTION 'AUTOMATION_WINDOW_INVALID' USING ERRCODE='23514';END IF;END LOOP;
 IF(d->>'endsAt')::timestamptz<(d->>'startsAt')::timestamptz THEN RAISE EXCEPTION 'AUTOMATION_WINDOW_INVALID' USING ERRCODE='23514';END IF;
 IF d ? 'sessionReminder' THEN
  a=d->'sessionReminder';IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['minutesBefore','maxDelayMinutes']) OR a-ARRAY['minutesBefore','maxDelayMinutes']<>'{}'::jsonb THEN RAISE EXCEPTION 'AUTOMATION_REMINDER_INVALID' USING ERRCODE='23514';END IF;
  FOREACH k IN ARRAY ARRAY['minutesBefore','maxDelayMinutes'] LOOP IF jsonb_typeof(a->k) IS DISTINCT FROM 'number' OR(a->>k)::numeric<>trunc((a->>k)::numeric) OR(a->>k)::numeric NOT BETWEEN 1 AND(CASE WHEN k='minutesBefore' THEN 43200 ELSE 1440 END) THEN RAISE EXCEPTION 'AUTOMATION_REMINDER_INVALID' USING ERRCODE='23514';END IF;END LOOP;
 END IF;
 a=d->'trigger';IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['kind','eventTypes']) OR a-ARRAY['kind','eventTypes']<>'{}'::jsonb OR a->>'kind' IS DISTINCT FROM 'domain_event' OR jsonb_typeof(a->'eventTypes') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'eventTypes') NOT BETWEEN 1 AND 50 OR(SELECT count(DISTINCT x) FROM jsonb_array_elements(a->'eventTypes') x)<>jsonb_array_length(a->'eventTypes') OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'eventTypes') x WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}')>160 OR((x#>>'{}')<>'*' AND(x#>>'{}')!~'^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)+$' AND(x#>>'{}')!~'^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)*[.][*]$')) THEN RAISE EXCEPTION 'AUTOMATION_TRIGGER_INVALID' USING ERRCODE='23514';END IF;
 e=d->'execution';keys=ARRAY['mode','maxRecipientsPerEvent','maxDailyDeliveries','maxDailySms','cooldownSeconds','maxChainDepth'];
 IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR NOT(e ?& keys) OR e-keys<>'{}'::jsonb OR e->>'mode' IS NULL OR e->>'mode' NOT IN('dry_run','approval_required','automatic') THEN RAISE EXCEPTION 'AUTOMATION_LIMITS_INVALID' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['maxRecipientsPerEvent','maxDailyDeliveries','maxDailySms','cooldownSeconds','maxChainDepth'] LOOP IF jsonb_typeof(e->k) IS DISTINCT FROM 'number' OR(e->>k)::numeric<>trunc((e->>k)::numeric) OR(e->>k)::numeric<(CASE WHEN k IN('maxDailySms','cooldownSeconds') THEN 0 ELSE 1 END) OR(e->>k)::numeric>(CASE k WHEN 'maxDailyDeliveries' THEN 10000 WHEN 'cooldownSeconds' THEN 604800 WHEN 'maxChainDepth' THEN 3 ELSE 1000 END) THEN RAISE EXCEPTION 'AUTOMATION_LIMITS_INVALID' USING ERRCODE='23514';END IF;END LOOP;
 IF jsonb_typeof(d->'actions') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'actions') NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'AUTOMATION_ACTION_INVALID' USING ERRCODE='23514';END IF;
 FOR a IN SELECT * FROM jsonb_array_elements(d->'actions') LOOP
  keys=ARRAY['kind','channels','audience','severity','title','body'];IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& keys) OR a-keys<>'{}'::jsonb OR a->>'kind' IS DISTINCT FROM 'notify' OR a->>'severity' IS NULL OR a->>'severity' NOT IN('inherit','normal','critical') OR jsonb_typeof(a->'channels') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'channels') NOT BETWEEN 1 AND 3 OR(SELECT count(DISTINCT x) FROM jsonb_array_elements(a->'channels') x)<>jsonb_array_length(a->'channels') OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'channels') x WHERE jsonb_typeof(x)<>'string' OR(x#>>'{}') NOT IN('portal','email','sms')) THEN RAISE EXCEPTION 'AUTOMATION_ACTION_INVALID' USING ERRCODE='23514';END IF;
  aud=a->'audience';IF jsonb_typeof(aud) IS DISTINCT FROM 'object' OR aud->>'kind' IS NULL OR aud->>'kind' NOT IN('school_master','actor_supervisors','people','session_guardians','session_staff') THEN RAISE EXCEPTION 'AUTOMATION_AUDIENCE_INVALID' USING ERRCODE='23514';END IF;
  keys=CASE WHEN aud->>'kind'='people' THEN ARRAY['kind','personIds'] ELSE ARRAY['kind'] END;
  IF NOT(aud ?& keys) OR aud-keys<>'{}'::jsonb THEN RAISE EXCEPTION 'AUTOMATION_AUDIENCE_INVALID' USING ERRCODE='23514';END IF;
  IF aud->>'kind'='people' THEN
   IF jsonb_typeof(aud->'personIds') IS DISTINCT FROM 'array' OR jsonb_array_length(aud->'personIds') NOT BETWEEN 1 AND 100 OR(SELECT count(DISTINCT x) FROM jsonb_array_elements(aud->'personIds') x)<>jsonb_array_length(aud->'personIds') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(aud->'personIds') x WHERE NOT EXISTS(SELECT 1 FROM public.people person WHERE person.academy_id=NEW.academy_id AND person.id=x::uuid AND person.kind='human' AND(coalesce(disable_only,false) OR((r.hub_id IS NULL OR person.hub_id=r.hub_id) AND(d->'enabled'='false'::jsonb OR person.status='active'))))) THEN RAISE EXCEPTION 'AUTOMATION_AUDIENCE_INVALID' USING ERRCODE='23514';END IF;
  END IF;
  FOREACH k IN ARRAY ARRAY['title','body'] LOOP
   labels=a->k;IF jsonb_typeof(labels) IS DISTINCT FROM 'object' OR NOT(labels ? 'en') OR labels-ARRAY['en','fr','zh-CN']<>'{}'::jsonb OR EXISTS(SELECT 1 FROM jsonb_each(labels) l WHERE jsonb_typeof(l.value)<>'string' OR length(l.value#>>'{}') NOT BETWEEN 1 AND CASE WHEN k='title' THEN 200 ELSE 2000 END OR regexp_replace(l.value#>>'{}','[[:space:]]','','g')='' OR(k='title' AND(position(chr(10) IN (l.value#>>'{}'))>0 OR position(chr(13) IN (l.value#>>'{}'))>0)) OR regexp_replace(l.value#>>'{}','[{][{][[:space:]]*(eventType|entityId|hubId|actorId|actorKind|severity|occurredAt)[[:space:]]*[}][}]','','g')~'([{][{]|[}][}])') THEN RAISE EXCEPTION 'AUTOMATION_TEMPLATE_INVALID' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;RETURN NEW;
END $$;
CREATE INDEX sessions_reminder_time ON public.class_sessions(academy_id,starts_at,id) WHERE status='scheduled';
CREATE UNIQUE INDEX session_reminder_event_receipt ON public.automation_event_sources(academy_id,(projection#>>'{attributes,reminder,receiptId}')) WHERE event_type='session.reminder_due';
CREATE TABLE public.session_reminder_occurrences(
 academy_id uuid NOT NULL,id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,rule_id uuid NOT NULL,rule_version integer NOT NULL,session_id uuid NOT NULL,request_id uuid NOT NULL,
 minutes_before integer NOT NULL CHECK(minutes_before BETWEEN 1 AND 43200),max_delay_minutes integer NOT NULL CHECK(max_delay_minutes BETWEEN 1 AND 1440),
 source jsonb NOT NULL CHECK(jsonb_typeof(source)='object'),source_stamp bytea NOT NULL CHECK(octet_length(source_stamp)=32),due_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),UNIQUE(academy_id,rule_id,session_id,minutes_before,source_stamp),
 FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id),FOREIGN KEY(academy_id,rule_id,rule_version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version),
 FOREIGN KEY(academy_id,session_id) REFERENCES public.class_sessions(academy_id,id)
);
ALTER TABLE public.session_reminder_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_reminder_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.session_reminder_occurrences USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE FUNCTION public.session_reminder_stamp(p_source jsonb) RETURNS bytea LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT sha256(convert_to((p_source-'classVersion')::text,'UTF8')) $$;
CREATE FUNCTION public.session_reminder_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE sub record;d jsonb;c record;s record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SESSION_REMINDER_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT pg_has_role(current_user,'kavosh_automation_worker','member') THEN RAISE EXCEPTION 'SESSION_REMINDER_WORKER_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO sub FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND rule_id=NEW.rule_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp();
 SELECT v.definition INTO d FROM public.automation_rules r JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version WHERE r.academy_id=NEW.academy_id AND r.id=NEW.rule_id AND r.version=NEW.rule_version;
 SELECT parent.* INTO c FROM public.classes parent JOIN public.class_sessions child ON child.academy_id=parent.academy_id AND child.class_id=parent.id WHERE child.academy_id=NEW.academy_id AND child.id=NEW.session_id FOR SHARE OF parent;
 SELECT * INTO s FROM public.class_sessions WHERE academy_id=NEW.academy_id AND id=NEW.session_id FOR SHARE;
 NEW.source=public.session_notification_source(NEW.session_id);NEW.source_stamp=public.session_reminder_stamp(NEW.source);NEW.due_at=s.starts_at-NEW.minutes_before*interval '1 minute';NEW.created_at=clock_timestamp();
 IF sub.id IS NULL OR d IS NULL OR d->'enabled' IS DISTINCT FROM 'true'::jsonb OR d#>>'{execution,mode}' IS DISTINCT FROM 'automatic'
  OR(d->>'startsAt' IS NOT NULL AND clock_timestamp()<(d->>'startsAt')::timestamptz) OR(d->>'endsAt' IS NOT NULL AND clock_timestamp()>(d->>'endsAt')::timestamptz)
  OR d#>>'{sessionReminder,minutesBefore}' IS DISTINCT FROM NEW.minutes_before::text OR d#>>'{sessionReminder,maxDelayMinutes}' IS DISTINCT FROM NEW.max_delay_minutes::text
  OR s.id IS NULL OR s.status<>'scheduled' OR c.active IS DISTINCT FROM true OR NEW.source IS NULL OR NEW.due_at>clock_timestamp() OR NEW.due_at+NEW.max_delay_minutes*interval '1 minute'<=clock_timestamp() OR s.starts_at<=clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND status='active')
  OR NOT EXISTS(SELECT 1 FROM public.hubs WHERE academy_id=NEW.academy_id AND id=s.hub_id AND active)
  OR EXISTS(SELECT 1 FROM public.automation_rules WHERE academy_id=NEW.academy_id AND id=NEW.rule_id AND hub_id IS NOT NULL AND hub_id<>s.hub_id)
 THEN RAISE EXCEPTION 'SESSION_REMINDER_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER session_reminder_guard BEFORE INSERT OR UPDATE OR DELETE ON public.session_reminder_occurrences FOR EACH ROW EXECUTE FUNCTION public.session_reminder_guard();
GRANT SELECT ON public.session_reminder_occurrences TO kavosh_runtime,kavosh_event_policy;
GRANT SELECT ON public.automation_subscriptions TO kavosh_event_policy;
GRANT INSERT(academy_id,id,subscription_id,lease_token,rule_id,rule_version,session_id,request_id,minutes_before,max_delay_minutes) ON public.session_reminder_occurrences TO kavosh_automation_worker;
CREATE FUNCTION public.session_reminder_current(p_event uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.session_reminder_occurrences o JOIN public.automation_event_sources e ON e.academy_id=o.academy_id AND e.projection#>>'{attributes,reminder,receiptId}'=o.id::text AND e.event_type='session.reminder_due' AND e.session_id=o.session_id
 JOIN public.automation_rules r ON r.academy_id=o.academy_id AND r.id=o.rule_id JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version
 WHERE e.event_id=p_event AND o.source_stamp=public.session_reminder_stamp(public.session_notification_source(o.session_id))
 AND EXISTS(SELECT 1 FROM public.hubs WHERE id=(o.source->>'hubId')::uuid AND active)
 AND v.definition->'enabled'='true'::jsonb AND v.definition#>>'{execution,mode}'='automatic'
 AND(v.definition->>'startsAt' IS NULL OR clock_timestamp()>=(v.definition->>'startsAt')::timestamptz) AND(v.definition->>'endsAt' IS NULL OR clock_timestamp()<=(v.definition->>'endsAt')::timestamptz)
 AND v.definition#>>'{sessionReminder,minutesBefore}'=o.minutes_before::text AND v.definition#>>'{sessionReminder,maxDelayMinutes}'=o.max_delay_minutes::text
 AND clock_timestamp()>=o.due_at AND clock_timestamp()<o.due_at+o.max_delay_minutes*interval '1 minute' AND clock_timestamp()<(o.source->>'startsAt')::timestamptz)
$$;
REVOKE ALL ON FUNCTION public.session_reminder_stamp(jsonb),public.session_reminder_guard(),public.session_reminder_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_reminder_stamp(jsonb),public.session_reminder_current(uuid) TO kavosh_runtime,kavosh_event_policy;
CREATE FUNCTION public.session_reminder_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.automation_event_sources e
  WHERE e.academy_id=NEW.academy_id AND e.event_type='session.reminder_due' AND e.session_id=NEW.session_id AND e.source_kind='session' AND e.projection#>>'{attributes,reminder,receiptId}'=NEW.id::text)
 THEN RAISE EXCEPTION 'SESSION_REMINDER_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER session_reminder_complete AFTER INSERT ON public.session_reminder_occurrences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.session_reminder_complete();
REVOKE ALL ON FUNCTION public.session_reminder_complete() FROM PUBLIC;
CREATE FUNCTION public.reminder_delivery_deadline() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.outcome='processed' AND(NEW.summary->>'portalNotifications')::integer>0
 AND EXISTS(SELECT 1 FROM public.automation_event_sources WHERE event_id=NEW.event_id AND event_type='session.reminder_due') AND NOT public.session_reminder_current(NEW.event_id)
 THEN RAISE EXCEPTION 'SESSION_REMINDER_DELIVERY_EXPIRED' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER reminder_delivery_deadline AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reminder_delivery_deadline();
REVOKE ALL ON FUNCTION public.reminder_delivery_deadline() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.capture_audited_automation_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a record;at timestamptz:=clock_timestamp();severity text;source jsonb;timer record;watch record;BEGIN
 IF NEW.event_type LIKE 'approval.%' OR NEW.event_type LIKE 'automation.%' OR NEW.event_type LIKE 'notification.%'
  OR NEW.event_type!~'^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)+$' OR length(NEW.event_type)>160 THEN RETURN NULL;END IF;
 IF(SELECT count(*) FROM public.audit_events WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND action=NEW.event_type AND entity_id=NEW.entity_id AND created_at=transaction_timestamp())<>1 THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND action=NEW.event_type AND entity_id=NEW.entity_id AND created_at=transaction_timestamp();
 IF a.actor_kind NOT IN('human','bot') OR EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND audit_id=a.id) THEN RETURN NULL;END IF;
 severity=CASE WHEN a.changes->>'severity'='critical' THEN 'critical' ELSE 'normal' END;
 IF NEW.event_type IN('session.changed','session.reminder_due') THEN
  source=public.session_notification_source(NEW.entity_id);IF source IS NULL THEN RETURN NULL;END IF;
  IF NEW.event_type='session.changed' THEN IF a.changes#>>'{after,version}' IS DISTINCT FROM source->>'sessionVersion' THEN RETURN NULL;END IF;
  ELSE
   SELECT * INTO timer FROM public.session_reminder_occurrences WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND session_id=NEW.entity_id;
   SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
   IF timer.id IS NULL OR timer.source IS DISTINCT FROM source OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind
    OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id OR a.changes->>'reminderReceiptId' IS DISTINCT FROM timer.id::text THEN RETURN NULL;END IF;
   source=source||jsonb_build_object('reminder',jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id,'minutesBefore',timer.minutes_before,'dueAt',to_char(timer.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'maxDelayMinutes',timer.max_delay_minutes));
  END IF;
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
-- Drain other ready watchers without a per-watch sleep;idle watches back off
-- ten seconds to bound idle database work rather than spin on every loop.
CREATE OR REPLACE FUNCTION public.finish_automation_subscription(subscription uuid,lease uuid,result text,event uuid,job uuid,revision integer,problem text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE s record;BEGIN
 IF result IS NULL OR result NOT IN('idle','ignored','queued','authorization_lost','retry') OR(problem IS NOT NULL AND problem!~'^[A-Z0-9_]{1,64}$') THEN RAISE EXCEPTION 'INVALID_SUBSCRIPTION_RESULT';END IF;
 SELECT * INTO s FROM public.automation_subscriptions WHERE id=subscription AND academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND status='active' AND lease_token=lease AND lease_until>clock_timestamp() FOR UPDATE;IF s.id IS NULL THEN RETURN false;END IF;
 IF(result IN('ignored','queued'))<>(event IS NOT NULL) OR(result='queued')<>(job IS NOT NULL) THEN RAISE EXCEPTION 'SUBSCRIPTION_EVENT_MISMATCH';END IF;
 IF event IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.automation_event_sources e WHERE e.academy_id=s.academy_id AND e.event_id=event AND e.origin_transaction IS NOT NULL AND e.origin_transaction<>s.activation_transaction AND NOT pg_visible_in_snapshot(e.origin_transaction,s.initial_snapshot)) OR NOT EXISTS(SELECT 1 FROM public.automation_rules WHERE academy_id=s.academy_id AND id=s.rule_id AND version=revision)
   OR(job IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.notification_jobs WHERE academy_id=s.academy_id AND id=job AND rule_id=s.rule_id AND rule_version=revision AND event_id=event AND requester_id=s.owner_id AND credential_id=s.credential_id)) THEN RAISE EXCEPTION 'SUBSCRIPTION_EVENT_MISMATCH';END IF;
  INSERT INTO public.automation_subscription_events(academy_id,subscription_id,event_id,rule_version,outcome,job_id) VALUES(s.academy_id,s.id,event,revision,result,job) ON CONFLICT DO NOTHING;
 END IF;
 UPDATE public.automation_subscriptions SET status=CASE WHEN result='authorization_lost' THEN 'authorization_lost' WHEN result='retry' AND failure_count>=4 THEN 'failed' ELSE 'active' END,
  failure_count=CASE WHEN result='retry' THEN least(5,failure_count+1) ELSE 0 END,available_at=clock_timestamp()+CASE WHEN result='retry' THEN least(300,power(2,s.failure_count+1)::integer) WHEN result='idle' THEN 10 ELSE 0 END*interval '1 second',
  lease_token=NULL,lease_until=NULL,last_error=problem,stopped_at=CASE WHEN result='authorization_lost' OR(result='retry' AND failure_count>=4) THEN clock_timestamp() ELSE NULL END WHERE academy_id=s.academy_id AND id=s.id;RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 128 $$;

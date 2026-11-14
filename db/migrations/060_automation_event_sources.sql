-- Permit root-domain prefixes as well as exact and nested-domain selectors.
CREATE OR REPLACE FUNCTION public.automation_rule_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record;p record;d jsonb:=NEW.definition;a jsonb;e jsonb;aud jsonb;labels jsonb;k text;keys text[];disable_only boolean;
BEGIN
 SELECT * INTO r FROM public.automation_rules WHERE academy_id=NEW.academy_id AND id=NEW.rule_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 disable_only=NEW.version>1 AND d->'enabled'='false'::jsonb AND(d-'enabled')=(SELECT definition-'enabled' FROM public.automation_rule_revisions WHERE academy_id=NEW.academy_id AND rule_id=NEW.rule_id AND version=NEW.version-1);
 IF r.id IS NULL OR r.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.automation_rule_revisions WHERE academy_id=NEW.academy_id AND rule_id=NEW.rule_id) OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'automation.rule.create' ELSE 'automation.rule.change' END) OR p.target_id IS DISTINCT FROM NEW.rule_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'automations.view' OR p.payload->'definition' IS DISTINCT FROM d OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR(NEW.version=1 AND((p.payload->>'hubId')::uuid IS DISTINCT FROM r.hub_id OR p.payload->>'code' IS DISTINCT FROM r.code)) THEN RAISE EXCEPTION 'AUTOMATION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 keys=ARRAY['name','enabled','startsAt','endsAt','trigger','condition','actions','execution'];
 IF NOT(d ?& keys) OR d-keys<>'{}'::jsonb OR jsonb_typeof(d->'name') IS DISTINCT FROM 'string' OR length(btrim(d->>'name')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(d->'enabled') IS DISTINCT FROM 'boolean' OR NOT public.automation_condition_valid(d->'condition') THEN RAISE EXCEPTION 'AUTOMATION_DEFINITION_INVALID' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['startsAt','endsAt'] LOOP IF d->k<>'null'::jsonb AND NOT public.automation_instant_valid(d->k) THEN RAISE EXCEPTION 'AUTOMATION_WINDOW_INVALID' USING ERRCODE='23514';END IF;END LOOP;
 IF(d->>'endsAt')::timestamptz<(d->>'startsAt')::timestamptz THEN RAISE EXCEPTION 'AUTOMATION_WINDOW_INVALID' USING ERRCODE='23514';END IF;
 a=d->'trigger';IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['kind','eventTypes']) OR a-ARRAY['kind','eventTypes']<>'{}'::jsonb OR a->>'kind' IS DISTINCT FROM 'domain_event' OR jsonb_typeof(a->'eventTypes') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'eventTypes') NOT BETWEEN 1 AND 50 OR(SELECT count(DISTINCT x) FROM jsonb_array_elements(a->'eventTypes') x)<>jsonb_array_length(a->'eventTypes') OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'eventTypes') x WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}')>160 OR((x#>>'{}')<>'*' AND(x#>>'{}')!~'^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)+$' AND(x#>>'{}')!~'^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)*[.][*]$')) THEN RAISE EXCEPTION 'AUTOMATION_TRIGGER_INVALID' USING ERRCODE='23514';END IF;
 e=d->'execution';keys=ARRAY['mode','maxRecipientsPerEvent','maxDailyDeliveries','maxDailySms','cooldownSeconds','maxChainDepth'];
 IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR NOT(e ?& keys) OR e-keys<>'{}'::jsonb OR e->>'mode' IS NULL OR e->>'mode' NOT IN('dry_run','approval_required','automatic') THEN RAISE EXCEPTION 'AUTOMATION_LIMITS_INVALID' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['maxRecipientsPerEvent','maxDailyDeliveries','maxDailySms','cooldownSeconds','maxChainDepth'] LOOP IF jsonb_typeof(e->k) IS DISTINCT FROM 'number' OR(e->>k)::numeric<>trunc((e->>k)::numeric) OR(e->>k)::numeric<(CASE WHEN k IN('maxDailySms','cooldownSeconds') THEN 0 ELSE 1 END) OR(e->>k)::numeric>(CASE k WHEN 'maxDailyDeliveries' THEN 10000 WHEN 'cooldownSeconds' THEN 604800 WHEN 'maxChainDepth' THEN 3 ELSE 1000 END) THEN RAISE EXCEPTION 'AUTOMATION_LIMITS_INVALID' USING ERRCODE='23514';END IF;END LOOP;
 IF jsonb_typeof(d->'actions') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'actions') NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'AUTOMATION_ACTION_INVALID' USING ERRCODE='23514';END IF;
 FOR a IN SELECT * FROM jsonb_array_elements(d->'actions') LOOP
  keys=ARRAY['kind','channels','audience','severity','title','body'];IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& keys) OR a-keys<>'{}'::jsonb OR a->>'kind' IS DISTINCT FROM 'notify' OR a->>'severity' IS NULL OR a->>'severity' NOT IN('inherit','normal','critical') OR jsonb_typeof(a->'channels') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'channels') NOT BETWEEN 1 AND 3 OR(SELECT count(DISTINCT x) FROM jsonb_array_elements(a->'channels') x)<>jsonb_array_length(a->'channels') OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'channels') x WHERE jsonb_typeof(x)<>'string' OR(x#>>'{}') NOT IN('portal','email','sms')) THEN RAISE EXCEPTION 'AUTOMATION_ACTION_INVALID' USING ERRCODE='23514';END IF;
  aud=a->'audience';IF jsonb_typeof(aud) IS DISTINCT FROM 'object' OR aud->>'kind' IS NULL OR aud->>'kind' NOT IN('school_master','actor_supervisors','people') THEN RAISE EXCEPTION 'AUTOMATION_AUDIENCE_INVALID' USING ERRCODE='23514';END IF;
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
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kavosh_event_policy') THEN CREATE ROLE kavosh_event_policy NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kavosh_event_policy' AND(rolcanlogin OR rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'UNSAFE_EVENT_POLICY_ROLE';END IF;
END $$;
GRANT kavosh_event_policy TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO kavosh_event_policy;
CREATE TABLE public.automation_event_sources(
 academy_id uuid NOT NULL,event_id uuid NOT NULL,audit_id uuid NOT NULL,approval_id uuid NOT NULL,source_kind text NOT NULL CHECK(source_kind='approval'),source_version integer NOT NULL CHECK(source_version>0),
 event_type text NOT NULL,hub_id uuid,occurred_at timestamptz NOT NULL,projection jsonb NOT NULL CHECK(jsonb_typeof(projection)='object' AND octet_length(projection::text)<=16000),derived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,event_id),UNIQUE(academy_id,audit_id),FOREIGN KEY(academy_id,event_id) REFERENCES public.outbox_events(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id) ON UPDATE CASCADE,FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id)
);
ALTER TABLE public.automation_event_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_event_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.automation_event_sources USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE INDEX automation_events_time ON public.automation_event_sources(academy_id,occurred_at,event_id);
CREATE INDEX automation_events_case ON public.automation_event_sources(academy_id,approval_id,event_id);
CREATE INDEX audit_event_binding ON public.audit_events(academy_id,request_id,action,entity_id,created_at);
-- Deliberately no backfill: an old matching event is not proof of the exact
-- approval version/state that existed when it was originally published.
CREATE FUNCTION public.capture_automation_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a record;p record;hub uuid;bound_hubs uuid[];severity text;at timestamptz:=clock_timestamp();
BEGIN
 IF NEW.event_type NOT IN('approval.requested','approval.applied','approval.rejected','approval.withdrawn','approval.stale') THEN RETURN NULL;END IF;
 IF(SELECT count(*) FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.request_id=NEW.request_id AND e.action=NEW.event_type AND e.entity_id=NEW.entity_id AND e.created_at=transaction_timestamp())<>1 THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.request_id=NEW.request_id AND e.action=NEW.event_type AND e.entity_id=NEW.entity_id AND e.created_at=transaction_timestamp();
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.entity_id;
 IF p.id IS NULL OR a.actor_kind NOT IN('human','bot') OR EXISTS(SELECT 1 FROM public.automation_event_sources s WHERE s.academy_id=NEW.academy_id AND s.audit_id=a.id) THEN RETURN NULL;END IF;
 IF(NEW.event_type='approval.requested' AND p.status<>'pending') OR(NEW.event_type<>'approval.requested' AND p.status IS DISTINCT FROM substring(NEW.event_type FROM 10)) THEN RETURN NULL;END IF;
 -- A branch is asserted only when EVERY explicit facet agrees on one hub.
 -- Global/mixed or unresolved cases remain school-wide, never guessed.
 IF p.scope->'all'='false'::jsonb AND NOT(p.scope ? 'areas') THEN
  BEGIN
   SELECT array_agg(DISTINCT value) INTO bound_hubs FROM(
    SELECT x::uuid AS value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.scope->'hubs')='array' THEN p.scope->'hubs' ELSE '[]'::jsonb END) x
    UNION ALL SELECT(x->>'hubId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.scope->'classes')='array' THEN p.scope->'classes' ELSE '[]'::jsonb END) x
    UNION ALL SELECT(x->>'hubId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.scope->'people')='array' THEN p.scope->'people' ELSE '[]'::jsonb END) x
   ) all_hubs;
   IF cardinality(bound_hubs)=1 AND bound_hubs[1] IS NOT NULL AND EXISTS(SELECT 1 FROM public.hubs WHERE academy_id=NEW.academy_id AND id=bound_hubs[1]) THEN hub=bound_hubs[1];END IF;
  EXCEPTION WHEN invalid_text_representation THEN hub=NULL;END;
 END IF;
 severity=CASE WHEN a.changes->>'severity'='critical' OR p.action LIKE 'finance.%' OR p.action LIKE 'work.%' OR p.action LIKE 'automation.%' OR p.action LIKE 'storage.%' OR p.action LIKE 'role.%' OR p.action IN('access.replace','supervisor.set') THEN 'critical' ELSE 'normal' END;
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection)
 VALUES(NEW.academy_id,NEW.id,a.id,p.id,'approval',p.version,NEW.event_type,hub,at,
 jsonb_build_object('eventType',NEW.event_type,'entityId',p.id,'hubId',hub,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity',severity,'occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'attributes',jsonb_build_object('approvalId',p.id,'approvalVersion',p.version,'approvalStatus',p.status,'action',p.action)));
 RETURN NULL;
END $$;
GRANT SELECT ON public.audit_events,public.approval_requests,public.hubs,public.automation_event_sources TO kavosh_event_policy;
GRANT INSERT ON public.automation_event_sources TO kavosh_event_policy;
ALTER FUNCTION public.capture_automation_event() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.capture_automation_event() FROM PUBLIC;
CREATE TRIGGER capture_automation_event AFTER INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.capture_automation_event();
GRANT SELECT ON public.automation_event_sources TO kavosh_runtime;
-- Web requests must not be able to inherit the private projection role.
REVOKE kavosh_event_policy FROM kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 60 $$;

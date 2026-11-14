ALTER TABLE public.portal_notifications ADD COLUMN origin text NOT NULL DEFAULT 'automation' CHECK(origin IN('automation','mandatory'));
ALTER TABLE public.portal_notifications ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE public.portal_notifications ALTER COLUMN rule_id DROP NOT NULL;
ALTER TABLE public.portal_notifications ADD CONSTRAINT notification_origin_reference CHECK(
 (origin='automation' AND run_id IS NOT NULL AND rule_id IS NOT NULL) OR
 (origin='mandatory' AND run_id IS NULL AND rule_id IS NULL AND action_index=0 AND severity='critical')
);
CREATE UNIQUE INDEX mandatory_notification_once ON public.portal_notifications(academy_id,event_id,person_id) WHERE origin='mandatory';

-- One current bounded traversal shared by approval policy, rule recipients and
-- mandatory-alert publication. No whole-school people scan per source event.
CREATE FUNCTION public.supervisor_chain(p_person uuid) RETURNS TABLE(person_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH RECURSIVE managers(id,next_id,seen,depth) AS(
  SELECT p.id,coalesce(p.supervisor_person_id,a.master_person_id),ARRAY[p.id],0
  FROM public.people p JOIN public.academies a ON a.id=p.academy_id WHERE p.id=p_person
  UNION ALL
  SELECT p.id,coalesce(p.supervisor_person_id,a.master_person_id),m.seen||p.id,m.depth+1
  FROM managers m JOIN public.people p ON p.id=m.next_id JOIN public.academies a ON a.id=p.academy_id
  WHERE NOT p.id=ANY(m.seen) AND m.depth<64
 ) SELECT id FROM managers WHERE depth>0
$$;
CREATE OR REPLACE FUNCTION public.is_supervisor(p_supervisor uuid,p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.supervisor_chain(p_person) chain WHERE chain.person_id=p_supervisor)
$$;
REVOKE ALL ON FUNCTION public.supervisor_chain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.supervisor_chain(uuid),public.is_supervisor(uuid,uuid) TO kavosh_runtime,kavosh_event_policy;

-- Preserve every existing automatic-run/message/read guard, its identity and
-- its grants; the second trigger below exclusively validates mandatory rows.
CREATE OR REPLACE FUNCTION public.portal_notification_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'NOTIFICATION_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='portal_notifications' THEN IF NEW.origin='mandatory' THEN RETURN NEW;END IF;END IF;
 IF TG_TABLE_NAME='automation_runs' THEN
  SELECT h.version,h.hub_id,v.definition INTO r FROM public.automation_rules h JOIN public.automation_rule_revisions v ON v.academy_id=h.academy_id AND v.rule_id=h.id AND v.version=h.version WHERE h.academy_id=NEW.academy_id AND h.id=NEW.rule_id;
  IF r.version IS DISTINCT FROM NEW.rule_version OR jsonb_typeof(NEW.summary->'portalNotifications') IS DISTINCT FROM 'number' OR (NEW.summary->>'portalNotifications')::numeric NOT BETWEEN 0 AND 10000 OR (NEW.summary->>'portalNotifications')::numeric<>trunc((NEW.summary->>'portalNotifications')::numeric) OR
   (NEW.outcome='processed' AND(r.definition->'enabled' IS DISTINCT FROM 'true'::jsonb OR r.definition#>>'{execution,mode}' IS DISTINCT FROM 'automatic')) OR
   (NEW.outcome<>'processed' AND NEW.summary->>'portalNotifications'<>'0') OR NOT EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND(NEW.outcome<>'processed' OR r.hub_id IS NULL OR hub_id=r.hub_id))
   THEN RAISE EXCEPTION 'AUTOMATION_RUN_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='portal_notifications' THEN
  SELECT * INTO r FROM public.automation_runs WHERE academy_id=NEW.academy_id AND id=NEW.run_id;
  IF r.id IS NULL OR r.created_in IS DISTINCT FROM pg_current_xact_id() OR r.outcome<>'processed' OR r.rule_id<>NEW.rule_id OR r.event_id<>NEW.event_id OR
   NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.person_id AND kind='human' AND status='active' AND auth_user_id IS NOT NULL)
   THEN RAISE EXCEPTION 'NOTIFICATION_SOURCE_INVALID' USING ERRCODE='23514';END IF;
  IF NEW.severity='normal' AND EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND projection->>'severity'='critical') THEN RAISE EXCEPTION 'CRITICAL_NOTIFICATION_REQUIRED' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='portal_notification_reads' THEN
  IF NOT EXISTS(SELECT 1 FROM public.portal_notifications WHERE academy_id=NEW.academy_id AND id=NEW.notification_id AND person_id=NEW.person_id) THEN RAISE EXCEPTION 'NOTIFICATION_OWNER_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;

-- New source captures preserve manual time/inventory severity and an exact
-- same-transaction critical domain audit; older captured facts are not rewritten.
CREATE OR REPLACE FUNCTION public.capture_automation_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
 severity=CASE WHEN a.changes->>'severity'='critical' OR p.action LIKE 'finance.%' OR p.action LIKE 'work.%' OR p.action LIKE 'automation.%' OR p.action LIKE 'storage.%' OR p.action LIKE 'role.%' OR p.action IN('access.replace','supervisor.set') OR p.action LIKE 'inventory.%' OR p.action='session-time.correct' OR EXISTS(SELECT 1 FROM public.audit_events domain_event WHERE domain_event.academy_id=NEW.academy_id AND domain_event.request_id=NEW.request_id AND domain_event.entity_id=p.target_id AND domain_event.action=p.action AND domain_event.created_at=transaction_timestamp() AND domain_event.changes->>'severity'='critical') THEN 'critical' ELSE 'normal' END;
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection)
 VALUES(NEW.academy_id,NEW.id,a.id,p.id,'approval',p.version,NEW.event_type,hub,at,
 jsonb_build_object('eventType',NEW.event_type,'entityId',p.id,'hubId',hub,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity',severity,'occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'attributes',jsonb_build_object('approvalId',p.id,'approvalVersion',p.version,'approvalStatus',p.status,'action',p.action)));
 RETURN NULL;
END $$;

CREATE FUNCTION public.mandatory_alert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE source record;permitted boolean;
BEGIN
 IF NEW.origin<>'mandatory' THEN RETURN NEW;END IF;
 IF current_user<>'kavosh_event_policy' THEN RAISE EXCEPTION 'MANDATORY_ALERT_PRIVATE_PUBLISHER_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO source FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id;
 IF source.event_id IS NULL OR source.source_kind<>'approval' OR source.projection->>'severity' IS DISTINCT FROM 'critical' OR NEW.locale<>'en' OR
  NEW.title IS DISTINCT FROM 'Critical activity recorded' OR NEW.body IS DISTINCT FROM 'Open the linked approval record to review this activity. Reading this notification does not approve or resolve it.'
  THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 -- ponytail: row guards may repeat a <=64 ancestor walk per recipient (<=66).
 -- Preserve native validation; batch a transaction-bound proof only if measured.
 SELECT EXISTS(
  SELECT 1 FROM public.people p JOIN public.approval_requests case_row ON case_row.academy_id=p.academy_id AND case_row.id=source.approval_id
  WHERE p.academy_id=NEW.academy_id AND p.id=NEW.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL AND(
   p.id=(SELECT master_person_id FROM public.academies WHERE id=NEW.academy_id) OR public.is_supervisor(p.id,case_row.requester_id) OR
   (p.id=case_row.requester_id AND source.event_type IN('approval.applied','approval.rejected','approval.withdrawn','approval.stale')))
 ) INTO permitted;
 IF NOT permitted THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mandatory_alert_guard BEFORE INSERT ON public.portal_notifications FOR EACH ROW EXECUTE FUNCTION public.mandatory_alert_guard();
REVOKE ALL ON FUNCTION public.mandatory_alert_guard() FROM PUBLIC;

CREATE FUNCTION public.publish_mandatory_approval_alert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.projection->>'severity' IS DISTINCT FROM 'critical' THEN RETURN NULL;END IF;
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin)
 SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,p.id,0,'critical','Critical activity recorded',
  'Open the linked approval record to review this activity. Reading this notification does not approve or resolve it.','en','mandatory'
 FROM(SELECT chain.person_id FROM public.approval_requests request CROSS JOIN LATERAL public.supervisor_chain(request.requester_id) chain WHERE request.academy_id=NEW.academy_id AND request.id=NEW.approval_id
      UNION SELECT requester_id FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id AND NEW.event_type IN('approval.applied','approval.rejected','approval.withdrawn','approval.stale')
      UNION SELECT master_person_id FROM public.academies WHERE id=NEW.academy_id) audience
 JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;
 RETURN NULL;
END $$;
GRANT SELECT ON public.people,public.academies TO kavosh_event_policy;
GRANT INSERT(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin) ON public.portal_notifications TO kavosh_event_policy;
ALTER FUNCTION public.publish_mandatory_approval_alert() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.publish_mandatory_approval_alert() FROM PUBLIC;
CREATE TRIGGER publish_mandatory_approval_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW EXECUTE FUNCTION public.publish_mandatory_approval_alert();
-- No historical backfill or optional-rule dependency: disabling a custom rule
-- cannot turn off this generic critical floor, and no private payload is copied.
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 63 $$;

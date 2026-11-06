-- New audit-backed envelopes only: no reconstruction of old activity or
-- copying private changes,descriptions,identity contacts or money values.
ALTER TABLE public.automation_event_sources ALTER COLUMN approval_id DROP NOT NULL;
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit'));
ALTER TABLE public.automation_event_sources ADD CHECK((source_kind='approval')=(approval_id IS NOT NULL));
CREATE FUNCTION public.capture_audited_automation_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a record;at timestamptz:=clock_timestamp();severity text;
BEGIN
 -- Approval sources retain their stricter native case-version binding.
 -- Never feed rule dispatch,queueing or notification actions back into rules.
 IF NEW.event_type LIKE 'approval.%' OR NEW.event_type LIKE 'automation.%' OR NEW.event_type LIKE 'notification.%'
  OR NEW.event_type!~'^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)+$' OR length(NEW.event_type)>160 THEN RETURN NULL;END IF;
 IF(SELECT count(*) FROM public.audit_events WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND action=NEW.event_type AND entity_id=NEW.entity_id AND created_at=transaction_timestamp())<>1 THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND action=NEW.event_type AND entity_id=NEW.entity_id AND created_at=transaction_timestamp();
 IF a.actor_kind NOT IN('human','bot') OR EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND audit_id=a.id) THEN RETURN NULL;END IF;
 severity=CASE WHEN a.changes->>'severity'='critical' THEN 'critical' ELSE 'normal' END;
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection)
 VALUES(NEW.academy_id,NEW.id,a.id,NULL,'audit',1,NEW.event_type,a.hub_id,at,
 jsonb_build_object('eventType',NEW.event_type,'entityId',NEW.entity_id,'hubId',a.hub_id,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity',severity,
 'occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',jsonb_build_object('auditId',a.id,'action',a.action)));
 RETURN NULL;
END $$;
ALTER FUNCTION public.capture_audited_automation_event() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.capture_audited_automation_event() FROM PUBLIC;
CREATE TRIGGER capture_audited_automation_event AFTER INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.capture_audited_automation_event();
-- Keep the existing mandatory approval floor unchanged. Audit-backed custom
-- rules use their own current audit-scope checks;these are not approval cases.
CREATE OR REPLACE FUNCTION public.publish_mandatory_approval_alert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.source_kind<>'approval' OR NEW.projection->>'severity' IS DISTINCT FROM 'critical' THEN RETURN NULL;END IF;
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin)
 SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,p.id,0,'critical','Critical activity recorded',
  'Open the linked approval record to review this activity. Reading this notification does not approve or resolve it.','en','mandatory'
 FROM(SELECT chain.person_id FROM public.approval_requests request CROSS JOIN LATERAL public.supervisor_chain(request.requester_id) chain WHERE request.academy_id=NEW.academy_id AND request.id=NEW.approval_id
      UNION SELECT requester_id FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id AND NEW.event_type IN('approval.applied','approval.rejected','approval.withdrawn','approval.stale')
      UNION SELECT master_person_id FROM public.academies WHERE id=NEW.academy_id) audience
 JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 124 $$;

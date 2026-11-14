-- A service failure is not an action by an expired owner. Bind a new immutable
-- operational source to the actual scheduler state;never fabricate an audit.
CREATE TABLE public.report_schedule_issues(
 academy_id uuid NOT NULL,id uuid NOT NULL,schedule_id uuid NOT NULL,version integer NOT NULL,control_version integer NOT NULL,due_at timestamptz NOT NULL,
 kind text NOT NULL CHECK(kind IN('paused','attempts_exhausted')),reason_code text NOT NULL CHECK(reason_code~'^[A-Z0-9_]{1,64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,schedule_id,control_version,due_at),FOREIGN KEY(academy_id,schedule_id,version) REFERENCES public.report_schedule_revisions(academy_id,schedule_id,version)
);
ALTER TABLE public.report_schedule_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_schedule_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.report_schedule_issues USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.report_schedule_issues TO kavosh_runtime,kavosh_event_policy;
CREATE POLICY scheduler_broker ON public.report_schedule_issues FOR SELECT TO kavosh_automation_policy USING(true);
GRANT SELECT(academy_id,schedule_id,control_version,due_at) ON public.report_schedule_issues TO kavosh_automation_policy;
GRANT INSERT ON public.report_schedule_issues TO kavosh_event_policy;
GRANT SELECT ON public.report_schedules,public.report_schedule_work TO kavosh_event_policy;
GRANT INSERT(academy_id,id,event_type,entity_id,request_id) ON public.outbox_events TO kavosh_event_policy;
CREATE TRIGGER report_schedule_issue_immutable BEFORE UPDATE OR DELETE ON public.report_schedule_issues FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable();
CREATE FUNCTION public.report_schedule_issue_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF current_user<>'kavosh_event_policy' OR NOT EXISTS(SELECT 1 FROM public.report_schedules s JOIN public.report_schedule_work w ON w.academy_id=s.academy_id AND w.schedule_id=s.id WHERE s.academy_id=NEW.academy_id AND s.id=NEW.schedule_id AND s.status='active' AND s.version=NEW.version AND s.control_version=NEW.control_version AND s.next_due_at=NEW.due_at AND w.version=NEW.version AND w.control_version=NEW.control_version AND w.due_at=NEW.due_at AND w.blocked AND NEW.kind=CASE WHEN w.attempts>=5 THEN 'attempts_exhausted' ELSE 'paused' END AND NEW.reason_code=coalesce(w.last_error,'PROCESSING_UNAVAILABLE')) THEN RAISE EXCEPTION 'REPORT_ISSUE_STATE_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER report_schedule_issue_guard BEFORE INSERT ON public.report_schedule_issues FOR EACH ROW EXECUTE FUNCTION public.report_schedule_issue_guard();
CREATE FUNCTION public.report_schedule_issue_current(p_issue uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.report_schedule_issues i JOIN public.report_schedules s ON s.academy_id=i.academy_id AND s.id=i.schedule_id JOIN public.report_schedule_work w ON w.academy_id=s.academy_id AND w.schedule_id=s.id
 WHERE i.id=p_issue AND s.status='active' AND s.version=i.version AND s.control_version=i.control_version AND s.next_due_at=i.due_at AND w.version=i.version AND w.control_version=i.control_version AND w.due_at=i.due_at AND w.blocked)
$$;
REVOKE ALL ON FUNCTION public.report_schedule_issue_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_schedule_issue_current(uuid) TO kavosh_runtime;
ALTER TABLE public.automation_event_sources ALTER COLUMN audit_id DROP NOT NULL;
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule'));
ALTER TABLE public.automation_event_sources ADD report_issue_id uuid,ADD FOREIGN KEY(academy_id,report_issue_id) REFERENCES public.report_schedule_issues(academy_id,id),ADD UNIQUE(academy_id,report_issue_id),ADD CHECK((source_kind='report_schedule')=(report_issue_id IS NOT NULL)),ADD CHECK((source_kind='report_schedule')=(audit_id IS NULL));
CREATE FUNCTION public.report_schedule_issue_projection(p_issue uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE s record;hub uuid;hubs uuid[];BEGIN
 SELECT i.*,h.owner_scope INTO s FROM public.report_schedule_issues i JOIN public.report_schedules h ON h.academy_id=i.academy_id AND h.id=i.schedule_id WHERE i.id=p_issue;IF s.id IS NULL THEN RETURN NULL;END IF;
 SELECT array_agg(DISTINCT h) INTO hubs FROM(SELECT x::uuid h FROM jsonb_array_elements_text(coalesce(s.owner_scope->'hubs','[]'::jsonb)) x UNION ALL SELECT(x->>'hubId')::uuid FROM jsonb_array_elements(coalesce(s.owner_scope->'classes','[]'::jsonb)) x UNION ALL SELECT(x->>'hubId')::uuid FROM jsonb_array_elements(coalesce(s.owner_scope->'people','[]'::jsonb)) x) facets;
 IF s.owner_scope->'all'='false'::jsonb AND NOT(s.owner_scope ? 'areas') AND cardinality(hubs)=1 AND hubs[1] IS NOT NULL THEN hub=hubs[1];END IF;
 RETURN jsonb_build_object('eventType','report-schedule.'||s.kind,'entityId',s.schedule_id,'hubId',hub,'actorId',NULL,'actorKind','system','severity','critical','occurredAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',jsonb_build_object('issueId',s.id,'scheduleId',s.schedule_id,'scheduleVersion',s.version,'controlVersion',s.control_version,'dueAt',to_char(s.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reasonCode',s.reason_code));
END $$;
CREATE FUNCTION public.report_schedule_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p jsonb:=public.report_schedule_issue_projection(NEW.report_issue_id);BEGIN
 IF current_user<>'kavosh_event_policy' OR p IS NULL OR NEW.event_id IS DISTINCT FROM NEW.report_issue_id OR NEW.source_version::text IS DISTINCT FROM p#>>'{attributes,controlVersion}' OR NEW.event_type IS DISTINCT FROM p->>'eventType' OR NEW.hub_id::text IS DISTINCT FROM p->>'hubId' OR NEW.projection IS DISTINCT FROM p OR NEW.occurred_at IS DISTINCT FROM(SELECT created_at FROM public.report_schedule_issues WHERE id=NEW.report_issue_id) THEN RAISE EXCEPTION 'REPORT_ISSUE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER report_schedule_source_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='report_schedule') EXECUTE FUNCTION public.report_schedule_source_guard();
REVOKE ALL ON FUNCTION public.report_schedule_issue_guard(),public.report_schedule_issue_projection(uuid),public.report_schedule_source_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_schedule_issue_projection(uuid) TO kavosh_event_policy;
CREATE FUNCTION public.capture_report_schedule_issue() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s record;i uuid:=gen_random_uuid();event_type text;at timestamptz;projection jsonb;
BEGIN
 PERFORM set_config('app.academy_id',NEW.academy_id::text,true);
 SELECT * INTO s FROM public.report_schedules WHERE academy_id=NEW.academy_id AND id=NEW.schedule_id AND status='active' AND version=NEW.version AND control_version=NEW.control_version AND next_due_at=NEW.due_at;
 IF s.id IS NULL OR NOT NEW.blocked OR EXISTS(SELECT 1 FROM public.report_schedule_issues WHERE academy_id=NEW.academy_id AND schedule_id=NEW.schedule_id AND control_version=NEW.control_version AND due_at=NEW.due_at) THEN RETURN NULL;END IF;
 event_type=CASE WHEN NEW.attempts>=5 THEN 'report-schedule.attempts_exhausted' ELSE 'report-schedule.paused' END;
 INSERT INTO public.report_schedule_issues(academy_id,id,schedule_id,version,control_version,due_at,kind,reason_code) VALUES(NEW.academy_id,i,s.id,NEW.version,NEW.control_version,NEW.due_at,CASE WHEN NEW.attempts>=5 THEN 'attempts_exhausted' ELSE 'paused' END,coalesce(NEW.last_error,'PROCESSING_UNAVAILABLE')) RETURNING created_at INTO at;projection=public.report_schedule_issue_projection(i);
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(NEW.academy_id,i,event_type,s.id,gen_random_uuid());
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,report_issue_id)
 VALUES(NEW.academy_id,i,NULL,NULL,'report_schedule',NEW.control_version,event_type,(projection->>'hubId')::uuid,at,projection,i);
 RETURN NULL;
END $$;
ALTER FUNCTION public.capture_report_schedule_issue() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.capture_report_schedule_issue() FROM PUBLIC;
CREATE TRIGGER capture_report_schedule_issue AFTER UPDATE ON public.report_schedule_work FOR EACH ROW WHEN(NEW.blocked) EXECUTE FUNCTION public.capture_report_schedule_issue();
-- The mandatory floor is independent of optional rules,budgets and a live
-- owner session. Source permissions and hierarchy are rechecked when read.
CREATE FUNCTION public.publish_report_schedule_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin)
 SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,p.id,0,'critical','Report schedule needs attention','Open the linked schedule to review this issue. Reading this notification does not restart or repair it.','en','mandatory'
 FROM(SELECT s.owner_id person_id FROM public.report_schedules s WHERE s.academy_id=NEW.academy_id AND s.id=(NEW.projection->>'entityId')::uuid
 UNION SELECT chain.person_id FROM public.report_schedules s CROSS JOIN LATERAL public.supervisor_chain(s.owner_id) chain WHERE s.academy_id=NEW.academy_id AND s.id=(NEW.projection->>'entityId')::uuid
 UNION SELECT master_person_id FROM public.academies WHERE id=NEW.academy_id) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;RETURN NULL;
END $$;
ALTER FUNCTION public.publish_report_schedule_alert() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.publish_report_schedule_alert() FROM PUBLIC;
CREATE TRIGGER publish_report_schedule_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='report_schedule') EXECUTE FUNCTION public.publish_report_schedule_alert();
DO $$ DECLARE body text;BEGIN
 body=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);
 IF position('IF source.event_id IS NULL' IN body)=0 THEN RAISE EXCEPTION 'MANDATORY_GUARD_BASE_UNEXPECTED';END IF;
 body=replace(body,'IF source.event_id IS NULL',$branch$IF source.source_kind='report_schedule' THEN
  IF NEW.locale<>'en' OR NEW.title IS DISTINCT FROM 'Report schedule needs attention' OR NEW.body IS DISTINCT FROM 'Open the linked schedule to review this issue. Reading this notification does not restart or repair it.' OR source.projection->>'severity' IS DISTINCT FROM 'critical'
   OR NOT EXISTS(SELECT 1 FROM public.report_schedule_issues i JOIN public.report_schedules s ON s.academy_id=i.academy_id AND s.id=i.schedule_id JOIN public.people p ON p.academy_id=s.academy_id AND p.id=NEW.person_id WHERE i.id=source.report_issue_id AND i.id=source.event_id AND s.id=(source.projection->>'entityId')::uuid AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL AND(p.id=s.owner_id OR public.is_supervisor(p.id,s.owner_id) OR p.id=(SELECT master_person_id FROM public.academies WHERE id=s.academy_id)))
   THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);EXECUTE body;
END $$;
-- A crashed final attempt also needs an observable outcome. Bounded cleanup
-- follows the same parent-then-work lock order as claim/finish/owner stop.
CREATE INDEX report_schedule_work_expired ON public.report_schedule_work(academy_id,lease_until,schedule_id) WHERE attempts>=5 AND NOT blocked;
DO $$ DECLARE body text;BEGIN
 body=pg_get_functiondef('public.claim_report_schedule(uuid[])'::regprocedure);
 IF position('SELECT source.* INTO s FROM public.report_schedules source' IN body)=0 THEN RAISE EXCEPTION 'REPORT_SCHEDULE_CLAIM_BASE_UNEXPECTED';END IF;
 body=replace(body,'SELECT source.* INTO s FROM public.report_schedules source',$branch$WITH expired AS(SELECT source.academy_id,source.id FROM public.report_schedules source JOIN public.report_schedule_work w ON w.academy_id=source.academy_id AND w.schedule_id=source.id WHERE source.academy_id=ANY(academies) AND source.status='active' AND w.version=source.version AND w.control_version=source.control_version AND w.due_at=source.next_due_at AND((w.attempts>=5 AND NOT w.blocked AND w.lease_until<=clock_timestamp()) OR(w.blocked AND NOT EXISTS(SELECT 1 FROM public.report_schedule_issues i WHERE i.academy_id=w.academy_id AND i.schedule_id=w.schedule_id AND i.control_version=w.control_version AND i.due_at=w.due_at))) ORDER BY w.lease_until,source.id FOR NO KEY UPDATE OF source SKIP LOCKED LIMIT 10)
 UPDATE public.report_schedule_work w SET blocked=true,last_error=CASE WHEN w.blocked THEN w.last_error ELSE 'ATTEMPTS_EXHAUSTED' END,lease_token=NULL,lease_until=NULL FROM expired x WHERE w.academy_id=x.academy_id AND w.schedule_id=x.id;
 SELECT source.* INTO s FROM public.report_schedules source$branch$);EXECUTE body;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 136 $$;

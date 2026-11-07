-- Queue acceptance is not successful file generation. Preserve native terminal
-- failure observations separately from human audits and intentional cancellation.
CREATE TABLE public.report_job_issues(
 academy_id uuid NOT NULL,id uuid NOT NULL,job_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('failed','cancelled')),reason_code text NOT NULL CHECK(reason_code~'^[A-Z0-9_]{1,64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,job_id),FOREIGN KEY(academy_id,job_id) REFERENCES public.report_jobs(academy_id,id)
);
ALTER TABLE public.report_job_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_job_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.report_job_issues USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY job_broker ON public.report_job_issues FOR SELECT TO kavosh_automation_policy USING(true);
GRANT SELECT ON public.report_job_issues TO kavosh_runtime,kavosh_event_policy;
GRANT SELECT(academy_id,job_id) ON public.report_job_issues TO kavosh_automation_policy;
GRANT INSERT ON public.report_job_issues TO kavosh_event_policy;
GRANT SELECT(academy_id,id,requester_id,status,last_error) ON public.report_jobs TO kavosh_event_policy;
GRANT SELECT(academy_id,job_id) ON public.report_job_results TO kavosh_event_policy;
CREATE TRIGGER report_job_issue_immutable BEFORE UPDATE OR DELETE ON public.report_job_issues FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable();
CREATE FUNCTION public.report_job_issue_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF current_user<>'kavosh_event_policy' OR NOT EXISTS(SELECT 1 FROM public.report_jobs j WHERE j.academy_id=NEW.academy_id AND j.id=NEW.job_id AND j.status=NEW.kind AND j.status IN('failed','cancelled') AND j.last_error IS DISTINCT FROM 'CANCELLED_BY_REQUEST' AND NEW.reason_code=coalesce(j.last_error,'PROCESSING_UNAVAILABLE') AND NOT EXISTS(SELECT 1 FROM public.report_job_results r WHERE r.academy_id=j.academy_id AND r.job_id=j.id)) THEN RAISE EXCEPTION 'REPORT_JOB_ISSUE_STATE_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER report_job_issue_guard BEFORE INSERT ON public.report_job_issues FOR EACH ROW EXECUTE FUNCTION public.report_job_issue_guard();
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule','report_job'));
DO $$ DECLARE c record;n integer:=0;BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.automation_event_sources'::regclass AND contype='c' AND position('audit_id' IN pg_get_expr(conbin,conrelid))>0 AND position('report_schedule' IN pg_get_expr(conbin,conrelid))>0 LOOP EXECUTE format('ALTER TABLE public.automation_event_sources DROP CONSTRAINT %I',c.conname);n=n+1;END LOOP;
 IF n<>1 THEN RAISE EXCEPTION 'OPERATIONAL_AUDIT_CONSTRAINT_BASE_UNEXPECTED';END IF;
END $$;
ALTER TABLE public.automation_event_sources ADD report_job_issue_id uuid,ADD FOREIGN KEY(academy_id,report_job_issue_id) REFERENCES public.report_job_issues(academy_id,id),ADD UNIQUE(academy_id,report_job_issue_id),ADD CHECK((source_kind='report_job')=(report_job_issue_id IS NOT NULL)),ADD CONSTRAINT automation_event_operational_audit CHECK((source_kind IN('report_schedule','report_job'))=(audit_id IS NULL));
CREATE FUNCTION public.report_job_issue_projection(p_issue uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('eventType','report-job.'||i.kind,'entityId',i.job_id,'hubId',NULL,'actorId',NULL,'actorKind','system','severity','critical','occurredAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',jsonb_build_object('issueId',i.id,'jobId',i.job_id,'status',i.kind,'reasonCode',i.reason_code)) FROM public.report_job_issues i WHERE i.id=p_issue
$$;
CREATE FUNCTION public.report_job_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p jsonb:=public.report_job_issue_projection(NEW.report_job_issue_id);BEGIN
 IF current_user<>'kavosh_event_policy' OR p IS NULL OR NEW.event_id IS DISTINCT FROM NEW.report_job_issue_id OR NEW.source_version<>1 OR NEW.event_type IS DISTINCT FROM p->>'eventType' OR NEW.hub_id IS NOT NULL OR NEW.projection IS DISTINCT FROM p OR NEW.occurred_at IS DISTINCT FROM(SELECT created_at FROM public.report_job_issues WHERE id=NEW.report_job_issue_id) THEN RAISE EXCEPTION 'REPORT_JOB_ISSUE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER report_job_source_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='report_job') EXECUTE FUNCTION public.report_job_source_guard();
CREATE FUNCTION public.observe_report_job_issue(p_school uuid,p_job uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE j record;i uuid;at timestamptz;p jsonb;BEGIN
 PERFORM set_config('app.academy_id',p_school::text,true);
 SELECT id,status,last_error INTO j FROM public.report_jobs WHERE academy_id=p_school AND id=p_job AND status IN('failed','cancelled') AND last_error IS DISTINCT FROM 'CANCELLED_BY_REQUEST';IF j.id IS NULL THEN RETURN false;END IF;
 INSERT INTO public.report_job_issues(academy_id,id,job_id,kind,reason_code) VALUES(p_school,gen_random_uuid(),j.id,j.status,coalesce(j.last_error,'PROCESSING_UNAVAILABLE')) ON CONFLICT(academy_id,job_id) DO NOTHING RETURNING id,created_at INTO i,at;IF i IS NULL THEN RETURN false;END IF;
 p=public.report_job_issue_projection(i);INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_school,i,p->>'eventType',j.id,gen_random_uuid());
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,report_job_issue_id) VALUES(p_school,i,NULL,NULL,'report_job',1,p->>'eventType',NULL,at,p,i);RETURN true;
END $$;
CREATE FUNCTION public.capture_report_job_issue() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN PERFORM public.observe_report_job_issue(NEW.academy_id,NEW.id);RETURN NULL;END $$;
ALTER FUNCTION public.report_job_issue_projection(uuid) OWNER TO kavosh_event_policy;
ALTER FUNCTION public.observe_report_job_issue(uuid,uuid) OWNER TO kavosh_event_policy;
ALTER FUNCTION public.capture_report_job_issue() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.report_job_issue_guard(),public.report_job_issue_projection(uuid),public.report_job_source_guard(),public.observe_report_job_issue(uuid,uuid),public.capture_report_job_issue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.observe_report_job_issue(uuid,uuid) TO kavosh_automation_policy;
CREATE TRIGGER capture_report_job_issue AFTER UPDATE ON public.report_jobs FOR EACH ROW WHEN(NEW.status IN('failed','cancelled') AND NEW.status IS DISTINCT FROM OLD.status) EXECUTE FUNCTION public.capture_report_job_issue();
CREATE FUNCTION public.publish_report_job_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin)
 SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,p.id,0,'critical','Report generation needs attention','Open the linked report job to review this failure. Reading this notification does not retry or repair it.','en','mandatory'
 FROM(SELECT requester_id person_id FROM public.report_jobs WHERE academy_id=NEW.academy_id AND id=(NEW.projection->>'entityId')::uuid UNION SELECT master_person_id FROM public.academies WHERE id=NEW.academy_id) audience
 JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;RETURN NULL;
END $$;
ALTER FUNCTION public.publish_report_job_alert() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.publish_report_job_alert() FROM PUBLIC;
CREATE TRIGGER publish_report_job_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='report_job') EXECUTE FUNCTION public.publish_report_job_alert();
DO $$ DECLARE body text;BEGIN
 body=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);
 IF position('IF source.event_id IS NULL' IN body)=0 THEN RAISE EXCEPTION 'MANDATORY_GUARD_BASE_UNEXPECTED';END IF;
 body=replace(body,'IF source.event_id IS NULL',$branch$IF source.source_kind='report_job' THEN
  IF NEW.locale<>'en' OR NEW.title IS DISTINCT FROM 'Report generation needs attention' OR NEW.body IS DISTINCT FROM 'Open the linked report job to review this failure. Reading this notification does not retry or repair it.' OR source.projection->>'severity' IS DISTINCT FROM 'critical'
   OR NOT EXISTS(SELECT 1 FROM public.report_job_issues i JOIN public.report_jobs j ON j.academy_id=i.academy_id AND j.id=i.job_id JOIN public.people p ON p.academy_id=j.academy_id AND p.id=NEW.person_id WHERE i.id=source.report_job_issue_id AND i.id=source.event_id AND j.id=(source.projection->>'entityId')::uuid AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL AND(p.id=j.requester_id OR p.id=(SELECT master_person_id FROM public.academies WHERE id=j.academy_id))) THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);EXECUTE body;
END $$;
-- Existing terminal rows are first observed now. They are not rewritten and
-- their original failure time is not fabricated. Bootstrap a private ID-only
-- backlog once,then drain it instead of rescanning terminal history each tick.
CREATE TABLE public.report_job_issue_backlog(academy_id uuid NOT NULL,job_id uuid NOT NULL,PRIMARY KEY(academy_id,job_id),FOREIGN KEY(academy_id,job_id) REFERENCES public.report_jobs(academy_id,id));
INSERT INTO public.report_job_issue_backlog SELECT academy_id,id FROM public.report_jobs WHERE status IN('failed','cancelled') AND last_error IS DISTINCT FROM 'CANCELLED_BY_REQUEST';
ALTER TABLE public.report_job_issue_backlog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_job_issue_backlog FORCE ROW LEVEL SECURITY;
CREATE POLICY job_broker ON public.report_job_issue_backlog TO kavosh_automation_policy USING(true) WITH CHECK(true);
GRANT SELECT,DELETE ON public.report_job_issue_backlog TO kavosh_automation_policy;
-- PostgreSQL row locks need UPDATE on one column. Real key edits remain
-- forbidden;the broker may only lock then delete a successfully observed ID.
GRANT UPDATE(job_id) ON public.report_job_issue_backlog TO kavosh_automation_policy;
CREATE TRIGGER report_job_issue_backlog_immutable BEFORE UPDATE ON public.report_job_issue_backlog FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable();
DO $$ DECLARE body text;BEGIN
 body=pg_get_functiondef('public.claim_report_job(uuid[])'::regprocedure);
 IF position('DECLARE' IN body)>0 OR position('AS $function$ BEGIN' IN body)=0 THEN RAISE EXCEPTION 'REPORT_JOB_CLAIM_BASE_UNEXPECTED';END IF;
 body=replace(body,'AS $function$ BEGIN','AS $function$ DECLARE unresolved record;BEGIN');
 IF position('RETURN QUERY WITH selected AS' IN body)=0 THEN RAISE EXCEPTION 'REPORT_JOB_CLAIM_QUERY_BASE_UNEXPECTED';END IF;
 body=replace(body,'RETURN QUERY WITH selected AS',$branch$FOR unresolved IN SELECT b.academy_id,b.job_id FROM public.report_job_issue_backlog b WHERE b.academy_id=ANY(academies) ORDER BY b.academy_id,b.job_id FOR UPDATE SKIP LOCKED LIMIT 10 LOOP PERFORM public.observe_report_job_issue(unresolved.academy_id,unresolved.job_id);DELETE FROM public.report_job_issue_backlog b WHERE b.academy_id=unresolved.academy_id AND b.job_id=unresolved.job_id;END LOOP;
 RETURN QUERY WITH selected AS$branch$);EXECUTE body;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 137 $$;

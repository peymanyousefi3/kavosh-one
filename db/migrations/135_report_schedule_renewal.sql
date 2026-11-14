-- Preserve the creation credential and owner. Only an exact owner-requested,
-- human-reviewed renewal may replace future execution authority.
ALTER TABLE public.report_schedules ADD execution_credential_id uuid;
GRANT UPDATE(execution_credential_id,control_version) ON public.report_schedules TO kavosh_runtime;
CREATE INDEX report_schedule_renewal_pending ON public.approval_requests(academy_id,target_id,target_version) WHERE status='pending' AND action='report.schedule.renew';
CREATE TABLE public.report_schedule_renewals(
 academy_id uuid NOT NULL,schedule_id uuid NOT NULL,control_version integer NOT NULL CHECK(control_version>1),credential_id uuid NOT NULL,
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,source_snapshot jsonb NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(academy_id,schedule_id,control_version),FOREIGN KEY(academy_id,schedule_id) REFERENCES public.report_schedules(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.report_schedule_renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_schedule_renewals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.report_schedule_renewals USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.report_schedule_renewals TO kavosh_runtime;
GRANT INSERT(academy_id,schedule_id,control_version,credential_id,changed_by,approval_id,source_snapshot,reason) ON public.report_schedule_renewals TO kavosh_runtime;
CREATE FUNCTION public.report_schedule_renewal_basis(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',s.version,'controlVersion',s.control_version,'status',s.status,'presetId',s.preset_id,'definition',r.definition,'presetSourceCurrent',public.report_job_preset_current(s.preset_id,(r.definition->>'presetVersion')::integer))
 FROM public.report_schedules s JOIN public.report_schedule_revisions r ON r.academy_id=s.academy_id AND r.schedule_id=s.id AND r.version=s.version WHERE s.id=p_id
$$;
REVOKE ALL ON FUNCTION public.report_schedule_renewal_basis(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_schedule_renewal_basis(uuid) TO kavosh_runtime;
DO $$ DECLARE body text;BEGIN
 body=pg_get_functiondef('public.report_schedule_header_guard()'::regprocedure);
 IF position('DECLARE p record;BEGIN' IN body)=0 THEN RAISE EXCEPTION 'REPORT_SCHEDULE_GUARD_BASE_UNEXPECTED';END IF;
 body=replace(body,'DECLARE p record;BEGIN',$branch$DECLARE p record;BEGIN
 IF TG_OP='UPDATE' AND NEW.control_version<>OLD.control_version THEN
  SELECT * INTO p FROM public.approval_requests WHERE target_id=OLD.id AND target_version=OLD.control_version AND action='report.schedule.renew' AND status='pending'
   AND requester_id=OLD.owner_id AND requester_kind=OLD.owner_kind AND credential_snapshot->>'token_id'=NEW.execution_credential_id::text
   AND payload->>'expectedVersion'=OLD.version::text AND payload->>'expectedControlVersion'=OLD.control_version::text AND review_context=public.report_schedule_renewal_basis(OLD.id);
  IF p.id IS NULL OR NEW.control_version<>OLD.control_version+1 OR(to_jsonb(NEW)-ARRAY['control_version','execution_credential_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['control_version','execution_credential_id'])
   OR p.scope IS DISTINCT FROM OLD.owner_scope OR p.privacy_capability IS DISTINCT FROM 'report-schedules.view' OR p.payload-ARRAY['expectedVersion','expectedControlVersion','reason']<>'{}'::jsonb
   OR NOT(p.payload ?& ARRAY['expectedVersion','expectedControlVersion','reason']) OR p.review_context->'presetSourceCurrent' IS DISTINCT FROM 'true'::jsonb
   OR(CASE WHEN OLD.owner_kind='human' THEN NOT public.lock_human(NEW.execution_credential_id,OLD.user_id) ELSE NOT public.lock_bot(NEW.execution_credential_id) OR NOT EXISTS(SELECT 1 FROM public.current_bot_scope(NEW.execution_credential_id) WHERE person_id=OLD.owner_id AND academy_id=OLD.academy_id) END)
   THEN RAISE EXCEPTION 'REPORT_SCHEDULE_RENEWAL_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 $branch$);EXECUTE body;
END $$;
CREATE FUNCTION public.report_schedule_renewal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;b jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'REPORT_SCHEDULE_RENEWAL_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.report_schedules WHERE id=NEW.schedule_id FOR SHARE;SELECT * INTO p FROM public.approval_requests WHERE id=NEW.approval_id;
 b=jsonb_set(public.report_schedule_renewal_basis(h.id),'{controlVersion}',to_jsonb(h.control_version-1));
 IF h.id IS NULL OR h.control_version<>NEW.control_version OR h.execution_credential_id IS DISTINCT FROM NEW.credential_id OR p.id IS NULL OR p.status<>'pending' OR p.action<>'report.schedule.renew' OR p.target_id<>h.id OR p.target_version<>NEW.control_version-1
  OR p.requester_id<>h.owner_id OR p.requester_kind<>h.owner_kind OR p.credential_snapshot->>'token_id' IS DISTINCT FROM NEW.credential_id::text OR p.scope IS DISTINCT FROM h.owner_scope OR p.privacy_capability IS DISTINCT FROM 'report-schedules.view'
  OR p.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',h.version,'expectedControlVersion',h.control_version-1,'reason',NEW.reason) OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by)
  THEN RAISE EXCEPTION 'REPORT_SCHEDULE_RENEWAL_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;NEW.created_at=transaction_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER report_schedule_renewal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.report_schedule_renewals FOR EACH ROW EXECUTE FUNCTION public.report_schedule_renewal_guard();
CREATE CONSTRAINT TRIGGER report_schedule_renewal_reviewed AFTER INSERT ON public.report_schedule_renewals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.report_schedule_renewal_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='report_schedules' THEN
  IF NOT EXISTS(SELECT 1 FROM public.report_schedule_renewals r JOIN public.approval_requests p ON p.academy_id=r.academy_id AND p.id=r.approval_id WHERE r.schedule_id=NEW.id AND r.control_version=NEW.control_version AND r.credential_id=NEW.execution_credential_id AND p.status='applied') THEN RAISE EXCEPTION 'REPORT_SCHEDULE_RENEWAL_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;
 ELSIF NEW.status='applied' AND NEW.action='report.schedule.renew' AND NOT EXISTS(SELECT 1 FROM public.report_schedule_renewals WHERE schedule_id=NEW.target_id AND control_version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'REPORT_SCHEDULE_RENEWAL_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_schedule_renewal_effect AFTER UPDATE ON public.report_schedules DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.control_version<>OLD.control_version AND NEW.version=OLD.version AND NEW.status=OLD.status) EXECUTE FUNCTION public.report_schedule_renewal_effect();
CREATE CONSTRAINT TRIGGER report_schedule_renewal_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.report_schedule_renewal_effect();
CREATE TRIGGER zz_report_schedule_renewal_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='report.schedule.renew') EXECUTE FUNCTION public.report_schedule_privacy();
-- Retain both native function OIDs/ACLs. Old leases use the control snapshot;
-- new leases authenticate and bind jobs/audit to the reviewed current token.
DO $$ DECLARE body text;BEGIN
 body=pg_get_functiondef('public.report_schedule_actor(uuid,uuid,uuid)'::regprocedure);
 IF position('IF s.owner_kind=''human'' THEN' IN body)=0 THEN RAISE EXCEPTION 'REPORT_SCHEDULE_ACTOR_BASE_UNEXPECTED';END IF;
 body=replace(body,'IF s.owner_kind=''human'' THEN','s.credential_id=coalesce(s.execution_credential_id,s.credential_id);IF s.owner_kind=''human'' THEN');EXECUTE body;
 body=pg_get_functiondef('public.finish_report_schedule(uuid,uuid,text,text,timestamptz,uuid)'::regprocedure);
 IF position('IF s.id IS NULL THEN RETURN false;END IF;' IN body)=0 THEN RAISE EXCEPTION 'REPORT_SCHEDULE_FINISH_BASE_UNEXPECTED';END IF;
 body=replace(body,'IF s.id IS NULL THEN RETURN false;END IF;','IF s.id IS NULL THEN RETURN false;END IF;s.credential_id=coalesce(s.execution_credential_id,s.credential_id);');EXECUTE body;
END $$;
REVOKE ALL ON FUNCTION public.report_schedule_renewal_guard(),public.report_schedule_renewal_effect() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 135 $$;

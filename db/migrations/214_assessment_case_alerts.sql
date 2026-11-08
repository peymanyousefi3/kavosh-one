-- Reuse the original approval event/privacy/inbox path. Never send private
-- assessment text or fabricate a financial/domain action from an explanation.
GRANT SELECT(academy_id,approval_id,version,approval_version,source_hash,content_hash,author_id,request_id,created_at) ON public.approval_assessments TO kavosh_event_policy;
DO $$ DECLARE body text;old_types text:='IF NEW.event_type NOT IN(''approval.requested'',''approval.applied'',''approval.rejected'',''approval.withdrawn'',''approval.stale'') THEN RETURN NULL;END IF;';old_status text:='IF(NEW.event_type=''approval.requested'' AND p.status<>''pending'') OR(NEW.event_type<>''approval.requested'' AND p.status IS DISTINCT FROM substring(NEW.event_type FROM 10)) THEN RETURN NULL;END IF;';old_attributes text:='''attributes'',jsonb_build_object(''approvalId'',p.id,''approvalVersion'',p.version,''approvalStatus'',p.status,''action'',p.action)';BEGIN
 body=pg_get_functiondef('public.capture_automation_event()'::regprocedure);
 IF position(old_types IN body)=0 OR position(old_status IN body)=0 OR position(old_attributes IN body)=0 THEN RAISE EXCEPTION 'ASSESSMENT_ALERT_CAPTURE_SOURCE_CHANGED';END IF;
 body=replace(body,old_types,'IF NEW.event_type NOT IN(''approval.requested'',''approval.applied'',''approval.rejected'',''approval.withdrawn'',''approval.stale'',''approval.assessment.recorded'') THEN RETURN NULL;END IF;');
 body=replace(body,old_status,$branch$IF NEW.event_type='approval.assessment.recorded' THEN
  IF p.status<>'pending' OR a.changes->'severity' IS DISTINCT FROM '"critical"'::jsonb OR a.changes->'changesApplied' IS DISTINCT FROM 'false'::jsonb
   OR NOT EXISTS(SELECT 1 FROM public.approval_assessments assessment WHERE assessment.academy_id=NEW.academy_id AND assessment.approval_id=p.id AND assessment.request_id=NEW.request_id AND assessment.author_id=a.actor_id AND assessment.version::text=a.changes->>'assessmentVersion' AND assessment.content_hash=a.changes->>'contentHash' AND assessment.approval_version=p.version AND assessment.source_hash=p.dependency_hash AND assessment.created_at>=transaction_timestamp())
  THEN RETURN NULL;END IF;
 ELSIF(NEW.event_type='approval.requested' AND p.status<>'pending') OR(NEW.event_type<>'approval.requested' AND p.status IS DISTINCT FROM substring(NEW.event_type FROM 10)) THEN RETURN NULL;END IF;$branch$);
 body=replace(body,old_attributes,old_attributes||$attributes$||CASE WHEN NEW.event_type='approval.assessment.recorded' THEN jsonb_build_object('assessmentVersion',a.changes->'assessmentVersion','changesApplied',false) ELSE '{}'::jsonb END$attributes$);
 EXECUTE body;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 214 $$;

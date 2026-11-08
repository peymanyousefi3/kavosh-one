-- Family intake never grants administrative care access or stores a second
-- medical record. It reviews into the same encrypted canonical care ledger.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('care-intake.view','Read current own or approved family care intake','People',true,ARRAY['hub','person','country','region','city']),
 ('care-intake.submit','Submit adult own or approved guardian care corrections','People',true,ARRAY['hub','person','country','region','city']);
CREATE INDEX family_care_own_submissions ON public.approval_requests(academy_id,target_id,requester_id,id) WHERE action='student.care.submit';
CREATE FUNCTION public.student_care_intake_basis(p_student uuid,p_actor uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN c IS NOT NULL AND a IS NOT NULL THEN jsonb_build_object('care',c,'authority',a-ARRAY['before','recruiterSha256']) ELSE NULL END
 FROM(SELECT public.student_care_basis(p_student) c,public.registration_data_basis(p_student,p_actor) a) sources
$$;
CREATE OR REPLACE FUNCTION public.student_care_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;c jsonb;b jsonb;i jsonb;is_master boolean;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'STUDENT_CARE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));c=public.student_care_basis(NEW.student_id);SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 i=jsonb_build_object('expectedVersion',NEW.version-1,'state',NEW.state,'envelope',NEW.envelope,'commitment',NEW.commitment);b=c;
 IF a.action='student.care.submit' THEN b=public.student_care_intake_basis(NEW.student_id,a.requester_id);i=i||jsonb_build_object('actorId',a.requester_id);
  IF b IS NULL OR b#>'{authority,canSubmit}' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'STUDENT_CARE_CURRENT_GUARDIAN_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 IF c IS NULL OR NEW.version<>(c->>'version')::integer+1 OR NEW.source_basis IS DISTINCT FROM b OR public.student_care_envelope_valid(NEW.envelope) IS NOT TRUE OR(NEW.state='withdrawn' AND c->>'state' IS DISTINCT FROM 'recorded')
 OR a.id IS NULL OR a.action NOT IN('student.care.change','student.care.submit') OR a.status<>'pending' OR a.requester_kind IS DISTINCT FROM 'human' OR a.target_id IS DISTINCT FROM NEW.student_id OR a.target_version<>NEW.version-1 OR a.privacy_capability IS DISTINCT FROM 'care-records.view' OR a.scope IS DISTINCT FROM c->'scope' OR a.review_context IS DISTINCT FROM b OR a.payload IS DISTINCT FROM i OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'STUDENT_CARE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) INTO is_master;
 IF NOT is_master AND(NEW.changed_by=NEW.student_id OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=NEW.student_id AND guardian_id=NEW.changed_by AND relationship IN('parent','legal_guardian') AND state='approved' AND valid_from<=clock_timestamp() AND(valid_until IS NULL OR valid_until>clock_timestamp()))) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 IF NOT(is_master AND a.requester_id=NEW.changed_by) AND NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND actor_id=NEW.changed_by AND entity_id=NEW.student_id AND action='student.care.proposal-revealed' AND changes->>'approvalId'=NEW.approval_id::text AND changes->'version'=to_jsonb(NEW.version) AND changes->'privateContentRedacted'='true'::jsonb) THEN RAISE EXCEPTION 'STUDENT_CARE_INSPECTION_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.student_care_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;prior jsonb;p record;BEGIN
 b=public.student_care_basis(NEW.student_id);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;prior=NEW.source_basis;
 IF p.action='student.care.submit' THEN
  prior=NEW.source_basis->'care';IF(public.student_care_intake_basis(NEW.student_id,p.requester_id)->'authority') IS DISTINCT FROM NEW.source_basis->'authority' THEN RAISE EXCEPTION 'STUDENT_CARE_CURRENT_GUARDIAN_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 IF b IS NULL OR prior IS NULL OR b->>'version' IS DISTINCT FROM NEW.version::text OR b->>'state' IS DISTINCT FROM NEW.state OR b->>'commitment' IS DISTINCT FROM NEW.commitment OR b-ARRAY['version','state','commitment','envelopeSha256'] IS DISTINCT FROM prior-ARRAY['version','state','commitment','envelopeSha256']
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.student_id AND actor_id=NEW.changed_by AND created_at=transaction_timestamp() AND action=p.action AND hub_id IS NOT DISTINCT FROM(prior->>'hubId')::uuid AND changes->'version'=to_jsonb(NEW.version) AND changes->>'state'=NEW.state AND changes->>'approvalId'=NEW.approval_id::text AND changes->'severity'='"critical"'::jsonb AND changes->'privateContentRedacted'='true'::jsonb)
 THEN RAISE EXCEPTION 'STUDENT_CARE_EFFECT_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.student_care_approval_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action IN('student.care.change','student.care.submit') AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.student_care_revisions WHERE academy_id=NEW.academy_id AND student_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'STUDENT_CARE_APPROVAL_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.student_care_private_reason_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE prefix text:='student-care-private-review-v1:';BEGIN
 IF NEW.action NOT IN('student.care.change','student.care.submit') OR NEW.status='pending' THEN RETURN NEW;END IF;
 IF NEW.status='applied' AND NEW.reason='Master self-approved' AND NEW.requester_kind='human' AND NEW.requester_id=NEW.reviewer_id AND EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.reviewer_id) THEN RETURN NEW;END IF;
 IF left(NEW.reason,length(prefix)) IS DISTINCT FROM prefix OR public.student_care_envelope_valid(substring(NEW.reason from length(prefix)+1)::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'STUDENT_CARE_PRIVATE_REASON_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'STUDENT_CARE_PRIVATE_REASON_REQUIRED' USING ERRCODE='23514';
END $$;
DO $$ DECLARE b text;n text:='''student.care.change'')';BEGIN
 b=pg_get_functiondef('public.capture_automation_event()'::regprocedure);IF position(n IN b)=0 THEN RAISE EXCEPTION 'FAMILY_CARE_ALERT_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,'''student.care.change'',''student.care.submit'')');
END $$;
REVOKE ALL ON FUNCTION public.student_care_intake_basis(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_care_intake_basis(uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 195 $$;

-- Family self-service never grants administrative profile or recruiter access.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('registration-data.view','View own or current approved family student registration basics','People',true,ARRAY['hub','person','country','region','city']),
 ('registration-data.submit','Submit own adult or current approved guardian registration corrections','People',true,ARRAY['hub','person','country','region','city']);
CREATE FUNCTION public.registration_data_basis(p_student uuid,p_actor uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('studentId',s.person_id,'actorId',actor.id,'profileVersion',s.version,'hubId',student.hub_id,'studentStatus',student.status,'timeZone',hub.time_zone,
 'canSubmit',actor.id<>student.id OR(hub.time_zone IS NOT NULL AND extract(year FROM age((clock_timestamp() AT TIME ZONE coalesce(hub.time_zone,'UTC'))::date,s.date_of_birth))>=18),
 'authority',CASE WHEN actor.id=student.id THEN jsonb_build_object('kind','self') ELSE jsonb_build_object('kind','guardian','relationshipId',family.id,'version',family.version) END,
 'before',jsonb_build_object('legalName',s.legal_name,'preferredName',s.preferred_name,'dateOfBirth',s.date_of_birth::text,'shirtSize',s.shirt_size),
 'recruiterSha256',encode(sha256(convert_to(jsonb_build_array(s.recruiter_kind,s.recruiter_hub_id,s.recruiter_person_id)::text,'UTF8')),'hex'),
 'scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',student.id,'hubId',student.hub_id))))
 FROM public.student_profiles s JOIN public.people student ON student.academy_id=s.academy_id AND student.id=s.person_id JOIN public.people actor ON actor.academy_id=s.academy_id AND actor.id=p_actor
 LEFT JOIN public.hubs hub ON hub.academy_id=student.academy_id AND hub.id=student.hub_id LEFT JOIN LATERAL(SELECT f.id,f.version FROM public.family_relationships f WHERE f.academy_id=s.academy_id AND f.student_id=s.person_id AND f.guardian_id=actor.id AND f.relationship IN('parent','legal_guardian') AND f.state='approved' AND f.valid_from<=clock_timestamp() AND(f.valid_until IS NULL OR f.valid_until>clock_timestamp()) ORDER BY f.id LIMIT 1) family ON true
 WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.person_id=p_student AND student.status IN('active','pending') AND student.kind='human' AND public.report_comment_human_verified(actor.id) AND(actor.id=student.id OR family.id IS NOT NULL)
$$;
CREATE FUNCTION public.registration_changes_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE k text;v jsonb;dob date;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR d='{}'::jsonb OR d-ARRAY['legalName','preferredName','dateOfBirth','shirtSize']<>'{}'::jsonb OR octet_length(d::text)>16384 THEN RETURN false;END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(d) LOOP
  IF k IN('preferredName','shirtSize') AND v='null'::jsonb THEN CONTINUE;END IF;
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(btrim(v#>>'{}'))<1 OR v#>>'{}'~'[[:cntrl:]]' THEN RETURN false;END IF;
  IF k='dateOfBirth' THEN IF v#>>'{}'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;dob=(v#>>'{}')::date;IF dob<date '1900-01-01' OR dob>((clock_timestamp() AT TIME ZONE 'UTC')+interval '14 hours')::date THEN RETURN false;END IF;
  ELSIF(k='shirtSize' AND length(v#>>'{}')>40) OR(k<>'shirtSize' AND length(v#>>'{}')>200) THEN RETURN false;END IF;
 END LOOP;RETURN true;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE TABLE public.student_registration_corrections(
 academy_id uuid NOT NULL,student_id uuid NOT NULL,profile_version integer NOT NULL CHECK(profile_version>1),requested_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,changes jsonb NOT NULL,source_basis jsonb NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,student_id,profile_version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),FOREIGN KEY(academy_id,requested_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.student_registration_corrections ENABLE ROW LEVEL SECURITY;ALTER TABLE public.student_registration_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.student_registration_corrections USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.student_registration_corrections TO kavosh_runtime;
GRANT INSERT(academy_id,student_id,profile_version,requested_by,changed_by,approval_id,changes,source_basis,reason) ON public.student_registration_corrections TO kavosh_runtime;
CREATE FUNCTION public.registration_correction_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;b jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'REGISTRATION_CORRECTION_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));PERFORM person_id FROM public.student_profiles WHERE academy_id=NEW.academy_id AND person_id=NEW.student_id FOR UPDATE;
 b=public.registration_data_basis(NEW.student_id,NEW.requested_by);SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR b->'canSubmit' IS DISTINCT FROM 'true'::jsonb OR NOT public.registration_changes_valid(NEW.changes) OR NEW.profile_version<>(b->>'profileVersion')::integer+1 OR NEW.source_basis IS DISTINCT FROM b OR NEW.changes <@ (b->'before') OR a.id IS NULL OR a.action IS DISTINCT FROM 'student.registration.correct' OR a.status<>'pending' OR a.requester_id IS DISTINCT FROM NEW.requested_by OR a.requester_kind IS DISTINCT FROM 'human' OR a.target_id IS DISTINCT FROM NEW.student_id OR a.target_version<>NEW.profile_version-1 OR a.privacy_capability IS DISTINCT FROM 'students.view' OR a.scope IS DISTINCT FROM b->'scope' OR a.review_context IS DISTINCT FROM b OR a.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.profile_version-1,'actorId',NEW.requested_by,'changes',NEW.changes,'reason',NEW.reason) OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'REGISTRATION_CORRECTION_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF b#>>'{authority,kind}'='self' AND NEW.changes?'dateOfBirth' AND extract(year FROM age((clock_timestamp() AT TIME ZONE(b->>'timeZone'))::date,(NEW.changes->>'dateOfBirth')::date))<18 THEN RAISE EXCEPTION 'REGISTRATION_CORRECTION_GUARDIAN_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER registration_correction_guard BEFORE INSERT OR UPDATE OR DELETE ON public.student_registration_corrections FOR EACH ROW EXECUTE FUNCTION public.registration_correction_guard();
CREATE CONSTRAINT TRIGGER registration_correction_reviewed AFTER INSERT ON public.student_registration_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.registration_correction_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;BEGIN
 b=public.registration_data_basis(NEW.student_id,NEW.requested_by);
 IF b IS NULL OR b-ARRAY['before','profileVersion'] IS DISTINCT FROM NEW.source_basis-ARRAY['before','profileVersion'] OR b->'before' IS DISTINCT FROM(NEW.source_basis->'before')||NEW.changes OR b->>'profileVersion' IS DISTINCT FROM NEW.profile_version::text
 OR NOT EXISTS(SELECT 1 FROM public.student_profile_revisions r WHERE r.academy_id=NEW.academy_id AND r.person_id=NEW.student_id AND r.version=NEW.profile_version AND r.definition->>'person_id'=NEW.student_id::text AND r.definition->'version'=to_jsonb(NEW.profile_version) AND encode(sha256(convert_to(jsonb_build_array(r.definition->'recruiter_kind',r.definition->'recruiter_hub_id',r.definition->'recruiter_person_id')::text,'UTF8')),'hex')=NEW.source_basis->>'recruiterSha256' AND r.changed_by=NEW.changed_by AND r.reason=NEW.reason AND jsonb_build_object('legalName',r.definition->'legal_name','preferredName',r.definition->'preferred_name','dateOfBirth',r.definition->'date_of_birth','shirtSize',r.definition->'shirt_size')=b->'before')
 OR NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.student_id AND a.actor_id=NEW.changed_by AND a.created_at=transaction_timestamp() AND a.hub_id IS NOT DISTINCT FROM(NEW.source_basis->>'hubId')::uuid AND a.action='student.registration.correct' AND a.changes->>'approvalId'=NEW.approval_id::text AND a.changes->>'version'=NEW.profile_version::text AND a.changes->'severity'='"critical"'::jsonb AND a.changes->'privateContentRedacted'='true'::jsonb)
 THEN RAISE EXCEPTION 'REGISTRATION_CORRECTION_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER registration_correction_complete AFTER INSERT ON public.student_registration_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.registration_correction_complete();
CREATE FUNCTION public.registration_approval_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='student.registration.correct' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.student_registration_corrections c WHERE c.academy_id=NEW.academy_id AND c.approval_id=NEW.id AND c.student_id=NEW.target_id AND c.changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'REGISTRATION_CORRECTION_APPROVAL_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER registration_approval_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.registration_approval_effect_required();
DO $$ DECLARE b text;n text:='''community-profile.moderate'')';BEGIN
 b=pg_get_functiondef('public.capture_automation_event()'::regprocedure);IF position(n IN b)=0 THEN RAISE EXCEPTION 'REGISTRATION_ALERT_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,'''community-profile.moderate'',''student.registration.correct'')');
END $$;
REVOKE ALL ON FUNCTION public.registration_data_basis(uuid,uuid),public.registration_changes_valid(jsonb),public.registration_correction_guard(),public.registration_correction_complete(),public.registration_approval_effect_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.registration_data_basis(uuid,uuid),public.registration_changes_valid(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 193 $$;

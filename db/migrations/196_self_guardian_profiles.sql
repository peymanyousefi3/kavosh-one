-- Self guardian onboarding/correction uses the existing canonical private
-- profile and revision history. It grants no family or identity authority.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('self-guardians.view','Read own guardian registration details and submitted corrections','People',true,ARRAY['hub','person','country','region','city']),
 ('self-guardians.submit','Submit own reviewed guardian registration corrections','People',true,ARRAY['hub','person','country','region','city']);
CREATE INDEX self_guardian_own_corrections ON public.approval_requests(academy_id,target_id,requester_id,id) WHERE action='guardian.profile.correct';
CREATE FUNCTION public.self_guardian_basis(p_person uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('guardianId',p.id,'profileVersion',coalesce(g.version,0),'hubId',p.hub_id,'personStatus',p.status,'identityBindingSha256',encode(sha256(convert_to(p.auth_user_id::text,'UTF8')),'hex'),
 'before',CASE WHEN g.person_id IS NULL THEN NULL ELSE jsonb_build_object('legalName',g.legal_name,'wechatId',g.wechat_id) END,
 'scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p.id,'hubId',p.hub_id))))
 FROM public.people p LEFT JOIN public.guardian_profiles g ON g.academy_id=p.academy_id AND g.person_id=p.id
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_person AND p.kind='human' AND public.report_comment_human_verified(p.id)
$$;
CREATE FUNCTION public.self_guardian_changes_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE k text;v jsonb;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR d='{}'::jsonb OR d-ARRAY['legalName','wechatId']<>'{}'::jsonb OR octet_length(d::text)>16384 THEN RETURN false;END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(d) LOOP
  IF k='wechatId' AND v='null'::jsonb THEN CONTINUE;END IF;
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(btrim(v#>>'{}'))<1 OR v#>>'{}'~'[[:cntrl:]]' OR(k='legalName' AND length(v#>>'{}')>200) OR(k='wechatId' AND length(v#>>'{}')>100) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
CREATE TABLE public.guardian_self_corrections(
 academy_id uuid NOT NULL,guardian_id uuid NOT NULL,profile_version integer NOT NULL CHECK(profile_version>0),requested_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,changes jsonb NOT NULL,source_basis jsonb NOT NULL CHECK(octet_length(source_basis::text)<=16384),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,guardian_id,profile_version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,guardian_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,requested_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.guardian_self_corrections ENABLE ROW LEVEL SECURITY;ALTER TABLE public.guardian_self_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.guardian_self_corrections USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.guardian_self_corrections TO kavosh_runtime;
GRANT INSERT(academy_id,guardian_id,profile_version,requested_by,changed_by,approval_id,changes,source_basis,reason) ON public.guardian_self_corrections TO kavosh_runtime;
CREATE FUNCTION public.self_guardian_correction_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;a record;is_master boolean;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'GUARDIAN_SELF_CORRECTION_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));PERFORM person_id FROM public.guardian_profiles WHERE academy_id=NEW.academy_id AND person_id=NEW.guardian_id FOR UPDATE;
 b=public.self_guardian_basis(NEW.guardian_id);SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR NEW.requested_by IS DISTINCT FROM NEW.guardian_id OR NEW.profile_version<>(b->>'profileVersion')::integer+1 OR NEW.source_basis IS DISTINCT FROM b OR NOT public.self_guardian_changes_valid(NEW.changes) OR((b->>'profileVersion')::integer=0 AND NOT(NEW.changes?'legalName')) OR((b->>'profileVersion')::integer>0 AND NEW.changes<@(b->'before'))
 OR a.id IS NULL OR a.action IS DISTINCT FROM 'guardian.profile.correct' OR a.status<>'pending' OR a.target_id IS DISTINCT FROM NEW.guardian_id OR a.target_version<>NEW.profile_version-1 OR a.requester_id IS DISTINCT FROM NEW.requested_by OR a.requester_kind IS DISTINCT FROM 'human' OR a.privacy_capability IS DISTINCT FROM 'guardians.view' OR a.scope IS DISTINCT FROM b->'scope' OR a.review_context IS DISTINCT FROM b OR a.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.profile_version-1,'changes',NEW.changes,'reason',NEW.reason,'actorId',NEW.requested_by) OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'GUARDIAN_SELF_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) INTO is_master;
 IF NOT is_master AND(NEW.changed_by=NEW.requested_by OR public.is_supervisor(NEW.changed_by,NEW.requested_by) IS NOT TRUE) THEN RAISE EXCEPTION 'GUARDIAN_SELF_UPPER_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER self_guardian_correction_guard BEFORE INSERT OR UPDATE OR DELETE ON public.guardian_self_corrections FOR EACH ROW EXECUTE FUNCTION public.self_guardian_correction_guard();
CREATE CONSTRAINT TRIGGER self_guardian_reviewed AFTER INSERT ON public.guardian_self_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.self_guardian_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;expected jsonb;BEGIN
 b=public.self_guardian_basis(NEW.guardian_id);expected=coalesce(nullif(NEW.source_basis->'before','null'::jsonb),jsonb_build_object('legalName',NULL,'wechatId',NULL))||NEW.changes;
 IF b IS NULL OR b->>'profileVersion' IS DISTINCT FROM NEW.profile_version::text OR b->'before' IS DISTINCT FROM expected OR b-ARRAY['profileVersion','before'] IS DISTINCT FROM NEW.source_basis-ARRAY['profileVersion','before']
 OR NOT EXISTS(SELECT 1 FROM public.guardian_profile_revisions r WHERE r.academy_id=NEW.academy_id AND r.person_id=NEW.guardian_id AND r.version=NEW.profile_version AND r.changed_by=NEW.changed_by AND r.reason=NEW.reason AND r.definition->>'person_id'=NEW.guardian_id::text AND r.definition->'version'=to_jsonb(NEW.profile_version) AND jsonb_build_object('legalName',r.definition->'legal_name','wechatId',r.definition->'wechat_id')=expected)
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.guardian_id AND actor_id=NEW.changed_by AND action='guardian.profile.correct' AND created_at=transaction_timestamp() AND hub_id IS NOT DISTINCT FROM(NEW.source_basis->>'hubId')::uuid AND changes->>'approvalId'=NEW.approval_id::text AND changes->'version'=to_jsonb(NEW.profile_version) AND changes->'severity'='"critical"'::jsonb AND changes->'privateContentRedacted'='true'::jsonb AND changes->'identityChanged'='false'::jsonb AND changes->'familyAuthorityGranted'='false'::jsonb)
 THEN RAISE EXCEPTION 'GUARDIAN_SELF_EFFECT_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER self_guardian_complete AFTER INSERT ON public.guardian_self_corrections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.self_guardian_complete();
CREATE FUNCTION public.self_guardian_approval_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='guardian.profile.correct' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.guardian_self_corrections WHERE academy_id=NEW.academy_id AND guardian_id=NEW.target_id AND profile_version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'GUARDIAN_SELF_APPROVAL_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER self_guardian_approval_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.self_guardian_approval_effect();
DO $$ DECLARE b text;n text:='''student.care.submit'')';BEGIN
 b=pg_get_functiondef('public.capture_automation_event()'::regprocedure);IF position(n IN b)=0 THEN RAISE EXCEPTION 'GUARDIAN_SELF_ALERT_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,'''student.care.submit'',''guardian.profile.correct'')');
END $$;
REVOKE ALL ON FUNCTION public.self_guardian_basis(uuid),public.self_guardian_changes_valid(jsonb),public.self_guardian_correction_guard(),public.self_guardian_complete(),public.self_guardian_approval_effect() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.self_guardian_basis(uuid),public.self_guardian_changes_valid(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 196 $$;

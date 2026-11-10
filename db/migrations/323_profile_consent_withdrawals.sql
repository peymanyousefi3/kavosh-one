-- Privacy withdrawal is a current verified self/family action,not an admin
-- approval. It cannot grant consent,change enrollment or backdate a signature.
CREATE FUNCTION public.profile_consent_actor_basis(p_student uuid,p_actor uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('studentId',s.person_id,'actorId',a.id,'hubId',p.hub_id,'studentProfileVersion',s.version,'authority',CASE WHEN a.id=p.id THEN 'self' ELSE 'current_guardian' END,
  'relationshipId',r.id,'relationshipVersion',r.version,'timeZone',h.time_zone)
 FROM public.student_profiles s JOIN public.people p ON p.academy_id=s.academy_id AND p.id=s.person_id
 JOIN public.people a ON a.academy_id=p.academy_id AND a.id=p_actor AND a.kind='human' AND public.report_comment_human_verified(a.id)
 LEFT JOIN public.hubs h ON h.academy_id=p.academy_id AND h.id=p.hub_id
 LEFT JOIN LATERAL(SELECT x.id,x.version FROM public.family_relationships x WHERE x.academy_id=s.academy_id AND x.student_id=s.person_id AND x.guardian_id=a.id AND x.relationship IN('parent','legal_guardian') AND x.state='approved' AND x.valid_from<=clock_timestamp() AND(x.valid_until IS NULL OR x.valid_until>clock_timestamp()) ORDER BY x.id LIMIT 1) r ON true
 WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.person_id=p_student
 AND(a.id=p.id OR(r.id IS NOT NULL AND h.time_zone IS NOT NULL AND public.signature_signing_requires_guardian(s.date_of_birth,clock_timestamp(),h.time_zone)))
$$;
GRANT EXECUTE ON FUNCTION public.signature_signing_requires_guardian(date,timestamptz,text) TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.profile_consent_actor_basis(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_consent_actor_basis(uuid,uuid) TO kavosh_runtime;
CREATE TABLE public.profile_consent_withdrawals(
 academy_id uuid NOT NULL,student_id uuid NOT NULL,purpose text NOT NULL CHECK(purpose IN('public_profile','verified_member_profile')),version integer NOT NULL CHECK(version>0),
 actor_id uuid NOT NULL,session_id uuid NOT NULL,request_id uuid NOT NULL,source_basis jsonb NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,student_id,purpose,version),UNIQUE(academy_id,session_id,request_id),FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id)
);
ALTER TABLE public.profile_consent_withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_consent_withdrawals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.profile_consent_withdrawals USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE INDEX profile_consent_withdrawal_cutoff ON public.profile_consent_withdrawals(academy_id,student_id,purpose,withdrawn_at DESC);
GRANT SELECT ON public.profile_consent_withdrawals TO kavosh_runtime;
GRANT INSERT(academy_id,student_id,purpose,version,actor_id,session_id,request_id,source_basis,reason) ON public.profile_consent_withdrawals TO kavosh_runtime;
CREATE FUNCTION public.guard_profile_consent_withdrawal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;u uuid;v integer;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PROFILE_CONSENT_WITHDRAWAL_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));
 SELECT auth_user_id INTO u FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.actor_id AND kind='human';
 IF u IS NULL OR public.lock_human(NEW.session_id,u) IS NOT TRUE THEN RAISE EXCEPTION 'PROFILE_CONSENT_CURRENT_HUMAN_REQUIRED' USING ERRCODE='23514';END IF;
 b=public.profile_consent_actor_basis(NEW.student_id,NEW.actor_id);
 SELECT coalesce(max(version),0) INTO v FROM public.profile_consent_withdrawals WHERE academy_id=NEW.academy_id AND student_id=NEW.student_id AND purpose=NEW.purpose;
 IF b IS NULL OR NEW.source_basis IS DISTINCT FROM b OR NEW.version<>v+1 THEN RAISE EXCEPTION 'PROFILE_CONSENT_CURRENT_FAMILY_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.withdrawn_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER profile_consent_withdrawal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.profile_consent_withdrawals FOR EACH ROW EXECUTE FUNCTION public.guard_profile_consent_withdrawal();
CREATE FUNCTION public.require_profile_consent_withdrawal_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND actor_id=NEW.actor_id AND session_id=NEW.session_id AND actor_kind='human' AND entity_id=NEW.student_id AND action='profile-consent.withdraw' AND request_id=NEW.request_id AND created_at=transaction_timestamp() AND hub_id IS NOT DISTINCT FROM(NEW.source_basis->>'hubId')::uuid
 AND changes=jsonb_build_object('purpose',NEW.purpose,'version',NEW.version,'severity','critical','privateContentRedacted',true))
 OR NOT EXISTS(SELECT 1 FROM public.outbox_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.student_id AND event_type='profile-consent.withdraw' AND request_id=NEW.request_id)
 THEN RAISE EXCEPTION 'PROFILE_CONSENT_WITHDRAWAL_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER profile_consent_withdrawal_complete AFTER INSERT ON public.profile_consent_withdrawals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_profile_consent_withdrawal_audit();
-- Reuse the existing audit/outbox verifier privileges,not a runtime SELECT grant.
GRANT CREATE ON SCHEMA public TO kavosh_identity_policy;
ALTER FUNCTION public.require_profile_consent_withdrawal_audit() OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_identity_policy;
-- Re-reading an old signed document must not reactivate sharing after withdrawal.
-- A later dispatch is necessary,NOT sufficient:verified optional selection,
-- accepted evidence,current guardian/age and publication review remain required.
CREATE FUNCTION public.profile_consent_dispatch_current(p_student uuid,p_purpose text,p_started_at timestamptz) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT p_started_at IS NOT NULL AND isfinite(p_started_at) AND p_started_at<=statement_timestamp() AND p_purpose IS NOT NULL AND p_purpose IN('public_profile','verified_member_profile')
 AND EXISTS(SELECT 1 FROM public.student_profiles WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND person_id=p_student)
 AND NOT EXISTS(SELECT 1 FROM public.profile_consent_withdrawals w WHERE w.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND w.student_id=p_student AND w.purpose=p_purpose AND w.withdrawn_at>=p_started_at)
$$;
REVOKE ALL ON FUNCTION public.guard_profile_consent_withdrawal(),public.require_profile_consent_withdrawal_audit(),public.profile_consent_dispatch_current(uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_consent_dispatch_current(uuid,text,timestamptz) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 323 $$;

-- Reuse current signed guardian authority,not an association alone or a
-- worker/academy checkbox. Never disclose guardian identity in sharing status.
CREATE FUNCTION public.work_profile_contacts_unchanged(p_person uuid,p_since timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_since IS NOT NULL AND isfinite(p_since) AND p_since<=statement_timestamp()
 AND EXISTS(SELECT 1 FROM public.people p WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_person AND p.kind='human' AND p.status='active'
 AND NOT EXISTS(SELECT 1 FROM identity.contact_change_events e WHERE e.user_id=p.auth_user_id AND e.field IN('email','phone') AND e.occurred_at>=p_since))
$$;
GRANT CREATE ON SCHEMA public TO kavosh_identity_policy;
ALTER FUNCTION public.work_profile_contacts_unchanged(uuid,timestamptz) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_identity_policy;
REVOKE ALL ON FUNCTION public.work_profile_contacts_unchanged(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_profile_contacts_unchanged(uuid,timestamptz),public.work_signer_verification(uuid) TO kavosh_signature_evidence_policy;
DO $$ DECLARE d text;u text;BEGIN
 d=pg_get_functiondef('public.worker_profile_consent(uuid,text)'::regprocedure);
 u=replace(d,'current_source jsonb;BEGIN','current_source jsonb;guardian jsonb;guardian_proof jsonb;BEGIN');
 u=replace(u,$q$ELSIF minor THEN reason='profile_consent_current_guardian_required';
  ELSE$q$,$r$ELSE
   IF minor THEN reason='profile_consent_current_guardian_required';END IF;$r$);
 u=replace(u,'IF candidate.evidence_id IS NOT NULL THEN',$r$IF candidate.evidence_id IS NOT NULL THEN
    IF minor THEN guardian=candidate.framework->'guardianSigner';guardian_proof=public.work_guardian_signer_source(p_person,(guardian->>'personId')::uuid,(guardian#>>'{authority,version}')::integer,candidate.framework#>>'{engagement,legalWorkerName}',candidate.framework#>>'{engagement,timeZone}');END IF;$r$);
 u=replace(u,$q$ELSIF public.signature_signing_requires_guardian(identity.date_of_birth,(candidate.input->>'workerSignedAt')::timestamptz,candidate.framework#>>'{engagement,timeZone}') IS DISTINCT FROM false THEN reason='profile_consent_adult_self_required';$q$,$r$ELSIF minor AND(guardian IS NULL OR guardian_proof IS DISTINCT FROM guardian
      OR public.signature_signing_requires_guardian(identity.date_of_birth,(candidate.input->>'workerSignedAt')::timestamptz,candidate.framework#>>'{engagement,timeZone}') IS DISTINCT FROM true
      OR public.signature_signing_requires_guardian(identity.date_of_birth,(candidate.input->>'guardianSignedAt')::timestamptz,candidate.framework#>>'{engagement,timeZone}') IS DISTINCT FROM true
      OR public.work_profile_contacts_unchanged((guardian->>'personId')::uuid,candidate.dispatch_started_at) IS NOT TRUE
      OR public.work_profile_contacts_unchanged(p_person,candidate.dispatch_started_at) IS NOT TRUE
      OR public.work_signer_verification(p_person) IS DISTINCT FROM candidate.framework->'workerSigner') THEN reason='profile_consent_current_guardian_required';
     ELSIF NOT minor AND(candidate.framework ? 'guardianSigner' OR public.signature_signing_requires_guardian(identity.date_of_birth,(candidate.input->>'workerSignedAt')::timestamptz,candidate.framework#>>'{engagement,timeZone}') IS DISTINCT FROM false) THEN reason='profile_consent_adult_self_required';$r$);
 u=replace(u,$q$'requiresGuardian',false,'evidenceId',candidate.evidence_id$q$,$r$'requiresGuardian',minor,'evidenceId',candidate.evidence_id$r$);
 u=replace(u,$q$'identityApprovalId',identity.approval_id);END IF;$q$,$r$'identityApprovalId',identity.approval_id)||CASE WHEN minor THEN jsonb_build_object('guardianSourceFingerprint',encode(sha256(convert_to(guardian_proof::text,'UTF8')),'hex')) ELSE '{}'::jsonb END;END IF;$r$);
 IF u=d OR strpos(u,'guardianSourceFingerprint')=0 OR strpos(u,'ELSIF minor AND')=0 THEN RAISE EXCEPTION 'WORK_GUARDIAN_PROFILE_CONSENT_UPGRADE_CHANGED';END IF;EXECUTE u;
END $$;
-- Current verified guardians can restrict sharing or withdraw consent without
-- acquiring worker administration,student enrollment or a positive grant.
CREATE FUNCTION public.work_profile_guardian_actor_basis(p_worker uuid,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;w record;i record;r record;proof jsonb;BEGIN
 IF tenant IS NULL OR p_worker IS NULL OR p_actor IS NULL OR p_worker=p_actor OR EXISTS(SELECT 1 FROM public.student_profiles WHERE academy_id=tenant AND person_id=p_worker) OR public.report_comment_human_verified(p_actor) IS NOT TRUE THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 SELECT p.id,p.hub_id,h.time_zone INTO w FROM public.people p LEFT JOIN public.hubs h ON h.academy_id=p.academy_id AND h.id=p.hub_id WHERE p.academy_id=tenant AND p.id=p_worker AND p.kind='human' AND p.status='active';
 SELECT * INTO i FROM public.work_identity_revisions WHERE academy_id=tenant AND person_id=p_worker ORDER BY version DESC LIMIT 1;
 SELECT * INTO r FROM public.work_guardian_revisions WHERE academy_id=tenant AND worker_id=p_worker AND guardian_id=p_actor ORDER BY version DESC LIMIT 1;
 IF w.id IS NULL OR w.time_zone IS NULL OR r.version IS NULL OR i.state IS DISTINCT FROM 'recorded' THEN RETURN NULL;END IF;
 proof=public.work_guardian_signer_source(p_worker,p_actor,r.version,i.legal_name,w.time_zone);IF proof IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('studentId',p_worker,'actorId',p_actor,'hubId',w.hub_id,'studentProfileVersion',NULL,'authority','current_guardian','relationshipId',NULL,'relationshipVersion',NULL,'timeZone',w.time_zone,'subjectKind','person','workGuardianApprovalId',r.approval_id,'workGuardianVersion',r.version);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.work_profile_guardian_actor_basis(uuid,uuid) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.work_profile_guardian_actor_basis(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_profile_guardian_actor_basis(uuid,uuid) TO kavosh_runtime;
DO $$ DECLARE d text;u text;needle text;BEGIN
 d=pg_get_functiondef('public.profile_consent_actor_basis(uuid,uuid)'::regprocedure);
 needle='AND NOT EXISTS(SELECT 1 FROM public.student_profiles s WHERE s.academy_id=p.academy_id AND s.person_id=p.id)';
 u=replace(d,needle,needle||$r$
 UNION ALL( WITH selected AS MATERIALIZED(SELECT public.work_profile_guardian_actor_basis(p_student,p_actor) value) SELECT value FROM selected WHERE value IS NOT NULL)$r$);
 IF u=d THEN RAISE EXCEPTION 'WORK_GUARDIAN_PRIVACY_ACTOR_UPGRADE_CHANGED';END IF;EXECUTE u;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 352 $$;

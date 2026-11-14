-- This evaluates retained operational evidence,not publication,legal validity
-- or a fresh provider check. Raw worker identity stays inside the existing
-- isolated signature policy,never with public/message/signing worker logins.
GRANT SELECT ON public.work_identity_revisions TO kavosh_signature_evidence_policy;
GRANT SELECT(profile_consent_observations) ON public.work_signature_completion_evidence TO kavosh_signature_evidence_policy;
CREATE INDEX work_profile_consent_preparation ON public.work_signature_completion_evidence(academy_id,(source->>'preparationId'),recorded_at DESC,id);
-- History JSON retains its writer's timestamp offsets. Compare the exact
-- instants,not offset spelling;every other reviewed header field stays exact.
CREATE FUNCTION public.work_profile_review_approved(p_evidence uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.work_signature_completion_reviews r JOIN public.approval_requests a ON a.academy_id=r.academy_id AND a.id=r.approval_id
 JOIN public.work_signature_completion_review_revisions h ON h.academy_id=r.academy_id AND h.evidence_id=r.evidence_id AND h.version=r.version
 AND h.definition-ARRAY['created_at','changed_at']=to_jsonb(r)-ARRAY['created_at','changed_at'] AND(h.definition->>'created_at')::timestamptz=r.created_at AND(h.definition->>'changed_at')::timestamptz=r.changed_at
 WHERE r.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND r.evidence_id=p_evidence AND a.status='applied' AND a.action='work.signature.completion.review' AND a.target_id=r.evidence_id AND a.target_version=r.version-1 AND a.reviewer_id=r.changed_by AND a.requester_id=r.requested_by AND a.requester_kind='human' AND a.payload=r.input AND a.review_context->'source'=r.source)
$$;
REVOKE ALL ON FUNCTION public.work_profile_review_approved(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_profile_review_approved(uuid) TO kavosh_signature_evidence_policy;
CREATE FUNCTION public.worker_profile_consent(p_person uuid,p_purpose text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;person record;identity record;candidate record;connection record;minor boolean;cutoff timestamptz;reason text:='profile_consent_missing';target text;current_source jsonb;BEGIN
 IF tenant IS NULL OR p_person IS NULL OR p_purpose IS NULL OR p_purpose NOT IN('public_profile','verified_member_profile') THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 SELECT p.id,p.kind,p.status,h.time_zone INTO person FROM public.people p LEFT JOIN public.hubs h ON h.academy_id=p.academy_id AND h.id=p.hub_id WHERE p.academy_id=tenant AND p.id=p_person;
 -- A dual-role teacher must use the existing current student/guardian path,
 -- never an older worker identity or a second consent shortcut.
 IF person.id IS NULL OR EXISTS(SELECT 1 FROM public.student_profiles WHERE academy_id=tenant AND person_id=p_person) THEN RETURN NULL;END IF;
 SELECT * INTO identity FROM public.work_identity_revisions WHERE academy_id=tenant AND person_id=p_person ORDER BY version DESC LIMIT 1;
 IF person.kind<>'human' OR person.status<>'active' THEN reason='profile_owner_inactive';
 ELSIF identity.version IS NULL OR identity.state<>'recorded' OR NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=tenant AND a.id=identity.approval_id AND a.status='applied' AND a.action='work.identity.change' AND a.target_id=p_person AND a.target_version=identity.version-1 AND a.reviewer_id=identity.changed_by AND a.privacy_capability='work-identity.view' AND a.review_context=identity.source_basis AND a.scope=identity.source_basis->'scope'
 AND a.payload=jsonb_build_object('expectedVersion',identity.version-1,'state',identity.state,'legalName',identity.legal_name,'dateOfBirth',to_char(identity.date_of_birth,'YYYY-MM-DD'),'reason',identity.reason)) THEN reason='profile_consent_identity_unverified';
 ELSIF person.time_zone IS NULL THEN reason='profile_consent_time_zone_required';
 ELSIF public.report_comment_human_verified(p_person) IS NOT TRUE THEN reason='profile_consent_signer_unverified';
 ELSE
  minor=public.signature_signing_requires_guardian(identity.date_of_birth,clock_timestamp(),person.time_zone);
  IF minor IS NULL THEN reason='profile_consent_identity_unverified';
  ELSIF minor THEN reason='profile_consent_current_guardian_required';
  ELSE
   -- Select the newest purpose review even if it is negative or its approval
   -- proof is broken. Never silently fall back to an older positive review.
   SELECT r.*,e.state evidence_state,e.recorded_at,e.source evidence_source,w.source_snapshot framework,s.created_at dispatch_started_at,
    (SELECT x->>'choice' FROM jsonb_array_elements(e.profile_consent_observations) x WHERE x->>'purpose'=p_purpose) choice
   INTO candidate FROM public.work_agreement_preparations w JOIN public.work_signature_completion_evidence e ON e.academy_id=w.academy_id AND e.source->>'preparationId'=w.id::text
   JOIN public.work_signature_dispatch_starts s ON s.academy_id=e.academy_id AND s.id=e.start_id JOIN public.work_signature_completion_reviews r ON r.academy_id=e.academy_id AND r.evidence_id=e.id
   WHERE w.academy_id=tenant AND w.worker_id=p_person AND w.source_snapshot#>>'{connection,environment}'='Live' AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.profile_consent_observations) x WHERE x->>'purpose'=p_purpose)
   ORDER BY r.changed_at DESC,r.evidence_id DESC LIMIT 1;
   IF candidate.evidence_id IS NOT NULL THEN
    reason='profile_consent_needs_review';
    IF public.work_profile_review_approved(candidate.evidence_id) IS NOT TRUE THEN NULL;
    ELSIF candidate.input->>'decision'='accepted' AND candidate.evidence_state='evidence_recorded' AND candidate.choice='selected' THEN
     SELECT max(e.recorded_at) INTO cutoff FROM public.work_agreement_preparations w JOIN public.work_signature_completion_evidence e ON e.academy_id=w.academy_id AND e.source->>'preparationId'=w.id::text LEFT JOIN public.work_signature_completion_reviews r ON r.academy_id=e.academy_id AND r.evidence_id=e.id
     WHERE w.academy_id=tenant AND w.worker_id=p_person AND w.source_snapshot#>>'{connection,environment}'='Live' AND NOT(coalesce(r.input->>'decision','pending')='rejected' AND public.work_profile_review_approved(e.id))
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.profile_consent_observations) x WHERE x->>'purpose'=p_purpose AND x->>'choice'='declined');
     IF public.profile_consent_dispatch_current(p_person,p_purpose,candidate.dispatch_started_at) IS NOT TRUE OR(cutoff IS NOT NULL AND candidate.dispatch_started_at<=cutoff) THEN reason='profile_consent_withdrawn';
     ELSIF EXISTS(SELECT 1 FROM public.work_agreement_preparations w JOIN public.work_signature_completion_evidence e ON e.academy_id=w.academy_id AND e.source->>'preparationId'=w.id::text LEFT JOIN public.work_signature_completion_reviews r ON r.academy_id=e.academy_id AND r.evidence_id=e.id WHERE w.academy_id=tenant AND w.worker_id=p_person AND w.source_snapshot#>>'{connection,environment}'='Live' AND e.recorded_at>=candidate.changed_at AND(r.evidence_id IS NULL OR public.work_profile_review_approved(e.id) IS NOT TRUE) AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.profile_consent_observations) x WHERE x->>'purpose'=p_purpose AND x->>'choice'='unverified')) THEN reason='profile_consent_needs_review';
     ELSIF candidate.framework#>>'{engagement,legalWorkerName}' IS DISTINCT FROM identity.legal_name THEN reason='profile_consent_identity_changed';
     -- Moving hubs must not reinterpret age at the original signing instant.
     ELSIF public.signature_signing_requires_guardian(identity.date_of_birth,(candidate.input->>'workerSignedAt')::timestamptz,candidate.framework#>>'{engagement,timeZone}') IS DISTINCT FROM false THEN reason='profile_consent_adult_self_required';
     ELSE
      SELECT * INTO connection FROM public.signature_connection_status((candidate.evidence_source->>'connectionId')::uuid);
      target=encode(sha256(convert_to(format('[1,%s,%s,%s,%s,%s]',to_json(connection.id::text),to_json(connection.academy_id::text),to_json(connection.region),to_json(connection.environment),coalesce(to_json(connection.client_id::text)::text,'null')),'UTF8')),'hex');
      IF connection.id IS NULL OR connection.environment<>'Live' OR target IS DISTINCT FROM candidate.evidence_source->>'connectionTargetId' THEN reason='profile_consent_live_source_required';
      ELSE
       current_source=public.work_signature_completion_review_source(candidate.evidence_id,candidate.requested_by,candidate.input);
       IF current_source IS NULL OR current_source-'scope' IS DISTINCT FROM candidate.source-'scope' THEN reason='profile_consent_needs_review';
       ELSE RETURN jsonb_build_object('eligible',true,'reason',NULL,'purpose',p_purpose,'requiresGuardian',false,'evidenceId',candidate.evidence_id,'reviewVersion',candidate.version,'providerFreshlyChecked',false,'legalValidityCertified',false,'sourceKind','work','identityVersion',identity.version,'identityApprovalId',identity.approval_id);END IF;
      END IF;
     END IF;
    ELSIF candidate.choice='declined' AND candidate.input->>'decision'<>'rejected' THEN reason='profile_consent_declined';END IF;
   END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('eligible',false,'reason',reason,'purpose',p_purpose,'requiresGuardian',minor,'evidenceId',NULL,'reviewVersion',NULL,'providerFreshlyChecked',false,'legalValidityCertified',false,'sourceKind','work','identityVersion',NULL,'identityApprovalId',NULL);
END $$;
CREATE FUNCTION public.person_profile_consent(p_person uuid,p_purpose text) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM public.student_profiles WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND person_id=p_person) THEN public.student_profile_consent(p_person,p_purpose) ELSE public.worker_profile_consent(p_person,p_purpose) END
$$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.worker_profile_consent(uuid,text) OWNER TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.person_profile_consent(uuid,text) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.worker_profile_consent(uuid,text),public.person_profile_consent(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.person_profile_consent(uuid,text) TO kavosh_runtime;
-- Negative controls already work for everyone. A nonstudent minor cannot
-- use their own worker checkbox as a guardian signature;publication stays off.
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 345 $$;

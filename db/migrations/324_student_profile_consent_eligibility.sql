-- Operational evidence eligibility only. This does not publish a profile,
-- prove current provider status or certify legal/cryptographic validity.
CREATE INDEX agreement_packages_student_consent ON public.agreement_packages(academy_id,student_id,id);
GRANT SELECT(profile_consent_observations) ON public.signature_completion_evidence TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,id,time_zone) ON public.hubs TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,id,student_id,guardian_id,state,relationship,valid_from,valid_until) ON public.family_relationships TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,student_id,purpose,withdrawn_at) ON public.profile_consent_withdrawals TO kavosh_signature_evidence_policy;
GRANT EXECUTE ON FUNCTION public.profile_consent_dispatch_current(uuid,text,timestamptz),public.report_comment_human_verified(uuid) TO kavosh_signature_evidence_policy;
CREATE FUNCTION public.student_profile_consent(p_student uuid,p_purpose text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;student record;candidate record;connection record;current_source jsonb;target text;minor boolean;cutoff timestamptz;reason text;BEGIN
 IF tenant IS NULL OR p_student IS NULL OR p_purpose IS NULL OR p_purpose NOT IN('public_profile','verified_member_profile') THEN RETURN NULL;END IF;
 -- The same read barrier applies to API,approval and direct native callers.
 -- Withdrawals and current legal-family changes cannot race a positive result.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 SELECT s.*,p.status,p.kind,p.hub_id,h.time_zone INTO student FROM public.student_profiles s JOIN public.people p ON p.academy_id=s.academy_id AND p.id=s.person_id LEFT JOIN public.hubs h ON h.academy_id=p.academy_id AND h.id=p.hub_id WHERE s.academy_id=tenant AND s.person_id=p_student;
 IF student.person_id IS NULL THEN RETURN NULL;END IF;
 reason='profile_consent_missing';
 IF student.kind<>'human' OR student.status NOT IN('active','pending') THEN reason='profile_owner_inactive';
 ELSIF student.time_zone IS NULL THEN reason='profile_consent_time_zone_required';
 ELSE
  minor=public.signature_signing_requires_guardian(student.date_of_birth,clock_timestamp(),student.time_zone);
  IF minor IS NULL THEN reason='profile_consent_identity_unverified';
  ELSE
   -- Test registries affect neither live grants nor negative-choice cutoffs.
   -- Latest reviewed purpose,including rejection/needs_changes. Do not fall
   -- back to an older positive decision after a newer human decision.
   SELECT r.*,e.start_id,e.state AS evidence_state,e.recorded_at,e.profile_consent_observations,p.connection_id,p.connection_target,p.signer_id,p.student_profile_version,p.guardian_profile_version,p.relationship_id,s.created_at AS dispatch_started_at,
    (SELECT x->>'choice' FROM jsonb_array_elements(e.profile_consent_observations) x WHERE x->>'purpose'=p_purpose) AS choice
   INTO candidate FROM public.agreement_packages p JOIN LATERAL public.signature_connection_status(p.connection_id) live ON live.environment='Live' JOIN public.signature_completion_evidence e ON e.academy_id=p.academy_id AND e.source->>'packageId'=p.id::text
   JOIN public.signature_dispatch_starts s ON s.academy_id=e.academy_id AND s.id=e.start_id
   JOIN public.signature_completion_reviews r ON r.academy_id=e.academy_id AND r.evidence_id=e.id
   JOIN public.approval_requests a ON a.academy_id=r.academy_id AND a.id=r.approval_id AND a.status='applied' AND a.action='signature.completion.review' AND a.target_id=r.evidence_id AND a.reviewer_id=r.changed_by
   WHERE p.academy_id=tenant AND p.student_id=p_student AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.profile_consent_observations) x WHERE x->>'purpose'=p_purpose)
   ORDER BY r.changed_at DESC,r.evidence_id DESC LIMIT 1;
   IF candidate.evidence_id IS NOT NULL THEN
    reason='profile_consent_needs_review';
    IF candidate.input->>'decision'='accepted' AND candidate.evidence_state='evidence_recorded' AND candidate.choice='selected' THEN
     -- A retained declined choice stops sharing even while its review waits.
     -- Explicitly rejecting that observation as invalid can resolve the stop;
     -- an older positive document cannot silently override an unrejected no.
     SELECT max(e.recorded_at) INTO cutoff FROM public.agreement_packages p JOIN LATERAL public.signature_connection_status(p.connection_id) live ON live.environment='Live' JOIN public.signature_completion_evidence e ON e.academy_id=p.academy_id AND e.source->>'packageId'=p.id::text
     LEFT JOIN public.signature_completion_reviews r ON r.academy_id=e.academy_id AND r.evidence_id=e.id
     WHERE p.academy_id=tenant AND p.student_id=p_student AND coalesce(r.input->>'decision','pending')<>'rejected'
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.profile_consent_observations) x WHERE x->>'purpose'=p_purpose AND x->>'choice'='declined');
     IF public.profile_consent_dispatch_current(p_student,p_purpose,candidate.dispatch_started_at) IS NOT TRUE OR(cutoff IS NOT NULL AND candidate.dispatch_started_at<=cutoff) THEN reason='profile_consent_withdrawn';
     ELSIF EXISTS(SELECT 1 FROM public.agreement_packages p JOIN LATERAL public.signature_connection_status(p.connection_id) live ON live.environment='Live' JOIN public.signature_completion_evidence e ON e.academy_id=p.academy_id AND e.source->>'packageId'=p.id::text LEFT JOIN public.signature_completion_reviews r ON r.academy_id=e.academy_id AND r.evidence_id=e.id WHERE p.academy_id=tenant AND p.student_id=p_student AND e.recorded_at>=candidate.changed_at AND r.evidence_id IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.profile_consent_observations) x WHERE x->>'purpose'=p_purpose AND x->>'choice'='unverified')) THEN reason='profile_consent_needs_review';
     ELSIF NOT EXISTS(SELECT 1 FROM public.student_profile_revisions o WHERE o.academy_id=tenant AND o.person_id=p_student AND o.version=candidate.student_profile_version AND o.definition->>'legal_name'=student.legal_name AND(o.definition->>'date_of_birth')::date=student.date_of_birth) THEN reason='profile_consent_identity_changed';
     ELSIF minor AND(candidate.signer_id=p_student OR NOT EXISTS(SELECT 1 FROM public.family_relationships f WHERE f.academy_id=tenant AND f.id=candidate.relationship_id AND f.student_id=p_student AND f.guardian_id=candidate.signer_id AND f.state='approved' AND f.relationship IN('parent','legal_guardian') AND f.valid_from<=clock_timestamp() AND(f.valid_until IS NULL OR f.valid_until>clock_timestamp()))) THEN reason='profile_consent_current_guardian_required';
     ELSIF NOT minor AND(candidate.signer_id<>p_student OR candidate.relationship_id IS NOT NULL) THEN reason='profile_consent_adult_self_required';
     ELSIF public.report_comment_human_verified(candidate.signer_id) IS NOT TRUE THEN reason='profile_consent_signer_unverified';
     ELSIF candidate.signer_id<>p_student AND NOT EXISTS(SELECT 1 FROM public.guardian_profiles g JOIN public.guardian_profile_revisions o ON o.academy_id=g.academy_id AND o.person_id=g.person_id AND o.version=candidate.guardian_profile_version WHERE g.academy_id=tenant AND g.person_id=candidate.signer_id AND g.legal_name=o.definition->>'legal_name') THEN reason='profile_consent_identity_changed';
     ELSE
      SELECT * INTO connection FROM public.signature_connection_status(candidate.connection_id);
      target=encode(sha256(convert_to(format('[1,%s,%s,%s,%s,%s]',to_json(connection.id::text),to_json(connection.academy_id::text),to_json(connection.region),to_json(connection.environment),coalesce(to_json(connection.client_id::text)::text,'null')),'UTF8')),'hex');
      IF connection.id IS NULL OR connection.environment<>'Live' OR target IS DISTINCT FROM candidate.connection_target THEN reason='profile_consent_live_source_required';
      ELSE
       current_source=public.signature_completion_review_source(candidate.evidence_id,candidate.requested_by,candidate.input);
       IF current_source IS NULL OR current_source-'scope' IS DISTINCT FROM candidate.source-'scope' THEN reason='profile_consent_needs_review';
       ELSE RETURN jsonb_build_object('eligible',true,'reason',NULL,'purpose',p_purpose,'requiresGuardian',minor,'evidenceId',candidate.evidence_id,'reviewVersion',candidate.version,'providerFreshlyChecked',false,'legalValidityCertified',false);END IF;
      END IF;
     END IF;
    ELSIF candidate.choice='declined' AND candidate.input->>'decision'<>'rejected' THEN reason='profile_consent_declined';END IF;
   END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('eligible',false,'reason',reason,'purpose',p_purpose,'requiresGuardian',minor,'evidenceId',NULL,'reviewVersion',NULL,'providerFreshlyChecked',false,'legalValidityCertified',false);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.student_profile_consent(uuid,text) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.student_profile_consent(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_profile_consent(uuid,text) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 324 $$;

-- Operational agreement coverage,not authentication,legal/crypto certification
-- or a fresh provider query. No manual attendance input can set this result.
GRANT EXECUTE ON FUNCTION public.signature_connection_status(uuid) TO kavosh_signature_evidence_policy;
GRANT SELECT ON public.class_enrollments,public.student_profiles,public.guardian_profiles,public.guardian_profile_revisions TO kavosh_signature_evidence_policy;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['class_enrollments','student_profiles','guardian_profiles','guardian_profile_revisions'] LOOP
 EXECUTE format('CREATE POLICY signature_clearance_source_read ON public.%I FOR SELECT TO kavosh_signature_evidence_policy USING(true)',t);
END LOOP;END $$;
CREATE INDEX signature_completion_enrollment_package ON public.signature_completion_evidence(academy_id,(source->>'packageId'),recorded_at DESC,id DESC);
CREATE FUNCTION public.enrollment_agreement_clearance(p_enrollment uuid,p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;e record;candidate record;connection record;s jsonb;target text;on_day date;reason text:='agreement_clearance_unverified';checked integer:=0;BEGIN
 IF p_at IS NULL OR NOT isfinite(p_at) THEN RETURN NULL;END IF;
 SELECT r.*,c.time_zone INTO e FROM public.class_enrollments r JOIN public.classes c ON c.academy_id=r.academy_id AND c.id=r.class_id WHERE r.academy_id=tenant AND r.id=p_enrollment;
 IF e.id IS NULL THEN RETURN NULL;END IF;on_day=(p_at AT TIME ZONE e.time_zone)::date;
 IF NOT e.enabled OR e.joins_on>on_day OR(e.leaves_on IS NOT NULL AND e.leaves_on<on_day) THEN RETURN jsonb_build_object('admissionCleared',false,'agreementClearanceVerified',false,'activityRecognized',false,'signedAfterActivity',false,'reason','enrollment_not_active_on_session_date');END IF;
 FOR candidate IN
  SELECT h.*,p.connection_id,p.connection_target,p.student_id,p.student_profile_version,p.signer_id,p.guardian_profile_version
  FROM public.agreement_packages p JOIN public.signature_completion_evidence observation ON observation.academy_id=p.academy_id AND observation.source->>'packageId'=p.id::text
  JOIN public.signature_completion_reviews h ON h.academy_id=observation.academy_id AND h.evidence_id=observation.id
  JOIN public.approval_requests a ON a.academy_id=h.academy_id AND a.id=h.approval_id AND a.status='applied' AND a.reviewer_id=h.changed_by
  WHERE p.academy_id=tenant AND p.enrollment_id=e.id AND p.class_id=e.class_id AND p.hub_id=e.hub_id AND p.student_id=e.student_id AND h.input->>'decision'='accepted'
  ORDER BY((h.input->>'signedAt')::timestamptz>p_at),(h.input->>'signedAt')::timestamptz DESC,h.changed_at DESC,h.evidence_id DESC LIMIT 101
 LOOP
  checked=checked+1;IF checked>100 THEN reason='agreement_coverage_requires_review';EXIT;END IF;
  SELECT * INTO connection FROM public.signature_connection_status(candidate.connection_id);
  -- Registry identity is native-immutable. Turning ingestion off does not
  -- expire previously completed documents;Test identity never becomes Live.
  IF connection.id IS NULL OR connection.environment<>'Live' THEN reason='test_provider_agreement';CONTINUE;END IF;
  target=encode(sha256(convert_to(format('[1,%s,%s,%s,%s,%s]',to_json(connection.id::text),to_json(connection.academy_id::text),to_json(connection.region),to_json(connection.environment),coalesce(to_json(connection.client_id::text)::text,'null')),'UTF8')),'hex');
  IF target IS DISTINCT FROM candidate.connection_target THEN reason='agreement_source_changed';CONTINUE;END IF;
  IF NOT EXISTS(SELECT 1 FROM public.student_profiles current JOIN public.student_profile_revisions original ON original.academy_id=current.academy_id AND original.person_id=current.person_id AND original.version=candidate.student_profile_version
   WHERE current.academy_id=tenant AND current.person_id=e.student_id AND current.legal_name=original.definition->>'legal_name' AND current.date_of_birth=(original.definition->>'date_of_birth')::date)
  OR(candidate.signer_id<>candidate.student_id AND NOT EXISTS(SELECT 1 FROM public.guardian_profiles current JOIN public.guardian_profile_revisions original ON original.academy_id=current.academy_id AND original.person_id=current.person_id AND original.version=candidate.guardian_profile_version
   WHERE current.academy_id=tenant AND current.person_id=candidate.signer_id AND current.legal_name=original.definition->>'legal_name')) THEN reason='agreement_legal_identity_changed';CONTINUE;END IF;
  s=public.signature_completion_review_source(candidate.evidence_id,candidate.requested_by,candidate.input);
  -- Current permission/owner locations are not legal contract contents.
  -- All actual request authorization stays at the enclosing domain boundary.
  IF s IS NULL OR s-'scope' IS DISTINCT FROM candidate.source-'scope' THEN reason='agreement_evidence_needs_review';CONTINUE;END IF;
  -- Operational recognition starts at the approved recorded joining date,
  -- not the signature date. It neither backdates signatures nor establishes
  -- retrospective legal protection or permission to participate before signing.
  RETURN jsonb_build_object('admissionCleared',(candidate.input->>'signedAt')::timestamptz<=p_at,'agreementClearanceVerified',true,'activityRecognized',true,'signedAfterActivity',(candidate.input->>'signedAt')::timestamptz>p_at,'reason',CASE WHEN(candidate.input->>'signedAt')::timestamptz>p_at THEN 'agreement_signed_after_activity' ELSE NULL END);
 END LOOP;
 RETURN jsonb_build_object('admissionCleared',false,'agreementClearanceVerified',false,'activityRecognized',false,'signedAfterActivity',false,'reason',reason);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.enrollment_agreement_clearance(uuid,timestamptz) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.enrollment_agreement_clearance(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enrollment_agreement_clearance(uuid,timestamptz) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 211 $$;

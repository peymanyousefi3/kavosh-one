-- Read-only context for ACTUAL saved activity,not an arbitrary caller date,
-- retroactive legal coverage,payroll clearance or a new signature gate.
GRANT SELECT(academy_id,id,version,person_id,hub_id,starts_at,ends_at) ON public.session_time_entries TO kavosh_signature_evidence_policy;
CREATE FUNCTION public.work_activity_agreement_context(p_evidence uuid,p_entry uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;e record;w record;t record;r record;original boolean;review_current boolean;worker_signed timestamptz;academy_signed timestamptz;last_signed timestamptz;BEGIN
 SELECT id,start_id,state,recorded_at,source INTO e FROM public.work_signature_completion_evidence WHERE academy_id=tenant AND id=p_evidence;IF e.id IS NULL THEN RETURN NULL;END IF;
 SELECT id,engagement_id,engagement_version,worker_id,hub_id INTO w FROM public.work_agreement_preparations WHERE academy_id=tenant AND id=(e.source->>'preparationId')::uuid;
 SELECT id,version,person_id,hub_id,starts_at,ends_at INTO t FROM public.session_time_entries WHERE academy_id=tenant AND id=p_entry;
 IF w.id IS NULL OR t.id IS NULL OR t.version IS DISTINCT FROM p_version OR t.person_id IS DISTINCT FROM w.worker_id OR t.hub_id IS DISTINCT FROM w.hub_id THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text||':work-signature-transport:'||e.start_id::text,0));
 original=coalesce(public.work_signature_completion_source_current(e.id),false);
 SELECT version,input,source,requested_by,changed_at INTO r FROM public.work_signature_completion_reviews WHERE academy_id=tenant AND evidence_id=e.id;
 IF r.version IS NOT NULL THEN
  review_current=r.source-'scope' IS NOT DISTINCT FROM public.work_signature_completion_review_source(e.id,r.requested_by,r.input)-'scope';
  IF r.input->>'decision'='accepted' THEN
   worker_signed=(r.source->>'attestedWorkerSignedAt')::timestamptz;academy_signed=(r.source->>'attestedAcademySignedAt')::timestamptz;
   last_signed=greatest(worker_signed,academy_signed);
  END IF;
 END IF;
 RETURN jsonb_build_object('evidenceId',e.id,'engagementId',w.engagement_id,'termsVersion',w.engagement_version,'entryId',t.id,'entryVersion',t.version,
  'evidenceState',e.state,'evidenceObservedAt',e.recorded_at,'sourceCorrespondenceCurrent',original,'humanReviewVersion',r.version,'humanReviewDecision',r.input->>'decision','humanDecisionRecordedAt',r.changed_at,'reviewedSourceCurrent',review_current,
  'humanAttestedWorkerSignedAt',worker_signed,'humanAttestedAcademySignedAt',academy_signed,
  'attestedTiming',CASE WHEN worker_signed IS NULL OR academy_signed IS NULL THEN 'not_currently_accepted' WHEN last_signed<=t.starts_at THEN 'both_attested_by_work_start' WHEN last_signed<t.ends_at THEN 'last_attested_during_work' ELSE 'last_attested_at_or_after_work_end' END,
  'workStartedBeforeEvidenceObservation',t.starts_at<e.recorded_at,'workerAttestedSigningAfterWorkStarted',worker_signed>t.starts_at,'academyAttestedSigningAfterWorkStarted',academy_signed>t.starts_at,
  'activityRecorded',true,'signingTimesIndependentlyVerified',false,'signedByBothPartiesVerified',false,'retroactiveLegalCoverageCertified',false,'legallyEffective',false,'paymentCleared',false);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.work_activity_agreement_context(uuid,uuid,integer) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.work_activity_agreement_context(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_activity_agreement_context(uuid,uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 231 $$;

-- Canonical student identity/family authority for a student who also works.
-- No duplicate worker DOB,family relationship,enrollment or consent record.
GRANT SELECT(version,last_approval_id) ON public.family_relationships TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,relationship_id,version,definition,changed_by,approval_id) ON public.family_relationship_revisions TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,person_id,version,definition) ON public.student_profile_revisions TO kavosh_signature_evidence_policy;
CREATE POLICY student_work_family_revision_read ON public.family_relationship_revisions FOR SELECT TO kavosh_signature_evidence_policy USING(true);
CREATE FUNCTION public.student_work_guardian_signer_source(p_worker uuid,p_guardian uuid,p_relationship uuid,p_version integer,p_name text,p_zone text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;checked_at timestamptz;s record;f record;h record;a record;g record;signer jsonb;BEGIN
 IF tenant IS NULL OR p_worker IS NULL OR p_guardian IS NULL OR p_worker=p_guardian OR p_relationship IS NULL OR p_version IS NULL OR p_name IS NULL OR p_zone IS NULL THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));checked_at=clock_timestamp();
 SELECT student.person_id,student.version,student.legal_name,student.date_of_birth INTO s FROM public.student_profiles student JOIN public.people p ON p.academy_id=student.academy_id AND p.id=student.person_id AND p.kind='human' AND p.status='active' WHERE student.academy_id=tenant AND student.person_id=p_worker;
 SELECT id,version,state,relationship,valid_from,valid_until,last_approval_id INTO f FROM public.family_relationships WHERE academy_id=tenant AND id=p_relationship AND student_id=p_worker AND guardian_id=p_guardian;
 SELECT definition,changed_by,approval_id INTO h FROM public.family_relationship_revisions WHERE academy_id=tenant AND relationship_id=f.id AND version=f.version;
 SELECT * INTO a FROM public.approval_requests WHERE academy_id=tenant AND id=f.last_approval_id;
 SELECT person_id,version,legal_name INTO g FROM public.guardian_profiles WHERE academy_id=tenant AND person_id=p_guardian;signer=public.work_signer_verification(p_guardian);
 IF s.person_id IS NULL OR s.legal_name IS DISTINCT FROM p_name OR public.signature_signing_requires_guardian(s.date_of_birth,checked_at,p_zone) IS DISTINCT FROM true
 OR NOT EXISTS(SELECT 1 FROM public.student_profile_revisions r WHERE r.academy_id=tenant AND r.person_id=p_worker AND r.version=s.version AND r.definition->>'person_id'=p_worker::text AND r.definition->>'legal_name'=s.legal_name AND(r.definition->>'date_of_birth')::date=s.date_of_birth)
 OR f.id IS NULL OR f.version IS DISTINCT FROM p_version OR f.state<>'approved' OR f.relationship NOT IN('parent','legal_guardian') OR f.valid_from>checked_at OR(f.valid_until IS NOT NULL AND f.valid_until<=checked_at)
 OR h.approval_id IS DISTINCT FROM f.last_approval_id OR h.definition->>'id' IS DISTINCT FROM f.id::text OR h.definition->>'student_id' IS DISTINCT FROM p_worker::text OR h.definition->>'guardian_id' IS DISTINCT FROM p_guardian::text
 OR h.definition->>'version' IS DISTINCT FROM f.version::text OR h.definition->>'relationship' IS DISTINCT FROM f.relationship OR h.definition->>'state' IS DISTINCT FROM f.state OR h.definition->>'last_approval_id' IS DISTINCT FROM f.last_approval_id::text
 OR(h.definition->>'valid_from')::timestamptz IS DISTINCT FROM f.valid_from OR(h.definition->>'valid_until')::timestamptz IS DISTINCT FROM f.valid_until
 OR a.id IS NULL OR a.status<>'applied' OR a.action NOT IN('family.create','family.update') OR a.target_id IS DISTINCT FROM f.id OR a.target_version IS DISTINCT FROM f.version-1 OR a.reviewer_id IS DISTINCT FROM h.changed_by OR a.privacy_capability IS DISTINCT FROM 'families.view'
 OR g.person_id IS NULL OR signer IS NULL THEN RETURN NULL;END IF;
 RETURN signer||jsonb_build_object('legalName',g.legal_name,'profileVersion',g.version,'authority',jsonb_build_object('identitySource','student','relationshipId',f.id,'version',f.version,'approvalId',f.last_approval_id,'relationship',f.relationship,'validFrom',to_char(f.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'validUntil',to_char(f.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'studentProfileVersion',s.version));
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.student_work_guardian_signer_source(uuid,uuid,uuid,integer,text,text) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.student_work_guardian_signer_source(uuid,uuid,uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_work_guardian_signer_source(uuid,uuid,uuid,integer,text,text) TO kavosh_runtime,kavosh_identity_policy;
DO $$ DECLARE d text;u text;fn text;BEGIN
 d=pg_get_functiondef('public.work_agreement_input_valid(jsonb)'::regprocedure);
 u=replace(d,$q$keys=keys||ARRAY['guardianId','guardianAuthorityVersion','guardianAuthorityReview'];$q$,$r$keys=keys||ARRAY['guardianId','guardianAuthorityVersion','guardianAuthorityReview'];IF i ? 'guardianRelationshipId' THEN keys=keys||ARRAY['guardianRelationshipId'];IF jsonb_typeof(i->'guardianRelationshipId') IS DISTINCT FROM 'string' OR(i->>'guardianRelationshipId')::uuid::text IS DISTINCT FROM i->>'guardianRelationshipId' THEN RETURN false;END IF;END IF;$r$);
 IF u=d THEN RAISE EXCEPTION 'STUDENT_WORK_INPUT_CHANGED';END IF;EXECUTE u;
 d=pg_get_functiondef('public.work_agreement_source(jsonb)'::regprocedure);
 u=replace(d,$q$guardian=public.work_guardian_signer_source(e.person_id,(i->>'guardianId')::uuid,(i->>'guardianAuthorityVersion')::integer,e.definition->>'legalWorkerName',e.definition->>'timeZone');$q$,$r$IF i ? 'guardianRelationshipId' THEN guardian=public.student_work_guardian_signer_source(e.person_id,(i->>'guardianId')::uuid,(i->>'guardianRelationshipId')::uuid,(i->>'guardianAuthorityVersion')::integer,e.definition->>'legalWorkerName',e.definition->>'timeZone');ELSE guardian=public.work_guardian_signer_source(e.person_id,(i->>'guardianId')::uuid,(i->>'guardianAuthorityVersion')::integer,e.definition->>'legalWorkerName',e.definition->>'timeZone');END IF;$r$);
 IF u=d THEN RAISE EXCEPTION 'STUDENT_WORK_SOURCE_CHANGED';END IF;EXECUTE u;
 d=pg_get_functiondef('public.work_agreement_privacy()'::regprocedure);
 u=replace(d,$q$'capability','worker-guardians.view'$q$,$r$'capability',CASE WHEN NEW.payload ? 'guardianRelationshipId' THEN 'families.view' ELSE 'worker-guardians.view' END$r$);
 IF u=d THEN RAISE EXCEPTION 'STUDENT_WORK_PREPARATION_PRIVACY_CHANGED';END IF;EXECUTE u;
 FOREACH fn IN ARRAY ARRAY['public.work_agreement_content_privacy()','public.work_signature_send_privacy()'] LOOP
  d=pg_get_functiondef(fn::regprocedure);u=replace(d,$q$'capability','worker-guardians.view'$q$,$r$'capability',CASE WHEN w.source_snapshot#>>'{guardianSigner,authority,identitySource}'='student' THEN 'families.view' ELSE 'worker-guardians.view' END$r$);
  IF u=d THEN RAISE EXCEPTION 'STUDENT_WORK_DOWNSTREAM_PRIVACY_CHANGED';END IF;EXECUTE u;
 END LOOP;
 -- Student privacy consent remains in the canonical enrollment agreement.
 -- Do not create a second set of work-checkbox decisions for the same pupil.
 d=pg_get_functiondef('public.work_agreement_content_source(jsonb)'::regprocedure);
 u=replace(d,'file_source=public.inspected_pdf_source',$r$IF w.input ? 'guardianRelationshipId' AND EXISTS(SELECT 1 FROM jsonb_array_elements(i#>'{routing,parties}') party CROSS JOIN LATERAL jsonb_array_elements(party->'fields') field WHERE field->'isRequired' IS DISTINCT FROM 'true'::jsonb) THEN RETURN NULL;END IF;
 file_source=public.inspected_pdf_source$r$);
 IF u=d THEN RAISE EXCEPTION 'STUDENT_WORK_CANONICAL_CONSENT_CHANGED';END IF;EXECUTE u;
 d=pg_get_functiondef('public.work_signature_dispatch_contacts(uuid)'::regprocedure);
 u=replace(d,$q$public.work_guardian_signer_source(w.worker_id,(w.source_snapshot#>>'{guardianSigner,personId}')::uuid,(w.source_snapshot#>>'{guardianSigner,authority,version}')::integer,w.source_snapshot#>>'{engagement,legalWorkerName}',w.source_snapshot#>>'{engagement,timeZone}')$q$,$r$(CASE WHEN w.source_snapshot#>>'{guardianSigner,authority,identitySource}'='student' THEN public.student_work_guardian_signer_source(w.worker_id,(w.source_snapshot#>>'{guardianSigner,personId}')::uuid,(w.source_snapshot#>>'{guardianSigner,authority,relationshipId}')::uuid,(w.source_snapshot#>>'{guardianSigner,authority,version}')::integer,w.source_snapshot#>>'{engagement,legalWorkerName}',w.source_snapshot#>>'{engagement,timeZone}') ELSE public.work_guardian_signer_source(w.worker_id,(w.source_snapshot#>>'{guardianSigner,personId}')::uuid,(w.source_snapshot#>>'{guardianSigner,authority,version}')::integer,w.source_snapshot#>>'{engagement,legalWorkerName}',w.source_snapshot#>>'{engagement,timeZone}') END)$r$);
 IF u=d THEN RAISE EXCEPTION 'STUDENT_WORK_CONTACT_SOURCE_CHANGED';END IF;EXECUTE u;
 d=pg_get_functiondef('public.work_signature_completion_source(uuid,uuid)'::regprocedure);
 u=replace(d,$q$'profileVersion',w.source_snapshot#>'{guardianSigner,profileVersion}','workerIdentityVersion',w.source_snapshot#>'{guardianSigner,authority,workerIdentityVersion}','workerIdentityApprovalId',w.source_snapshot#>>'{guardianSigner,authority,workerIdentityApprovalId}'))$q$,$r$'profileVersion',w.source_snapshot#>'{guardianSigner,profileVersion}')||CASE WHEN w.source_snapshot#>>'{guardianSigner,authority,identitySource}'='student' THEN jsonb_build_object('identitySource','student','relationshipId',w.source_snapshot#>>'{guardianSigner,authority,relationshipId}','studentProfileVersion',w.source_snapshot#>'{guardianSigner,authority,studentProfileVersion}') ELSE jsonb_build_object('workerIdentityVersion',w.source_snapshot#>'{guardianSigner,authority,workerIdentityVersion}','workerIdentityApprovalId',w.source_snapshot#>>'{guardianSigner,authority,workerIdentityApprovalId}') END)$r$);
 IF u=d THEN RAISE EXCEPTION 'STUDENT_WORK_COMPLETION_SOURCE_CHANGED';END IF;EXECUTE u;
 d=pg_get_functiondef('public.record_work_signature_completion_evidence(uuid,uuid,text,text,jsonb)'::regprocedure);
 u=replace(d,$q$p#>>'{metaData,kavoshWorkerIdentityVersion}' IS DISTINCT FROM s#>>'{guardianAuthority,workerIdentityVersion}' OR p#>>'{metaData,kavoshWorkerIdentityApprovalId}' IS DISTINCT FROM s#>>'{guardianAuthority,workerIdentityApprovalId}'$q$,$r$(CASE WHEN s#>>'{guardianAuthority,identitySource}'='student' THEN p#>>'{metaData,kavoshWorkIdentitySource}' IS DISTINCT FROM 'student' OR p#>>'{metaData,kavoshWorkStudentRelationshipId}' IS DISTINCT FROM s#>>'{guardianAuthority,relationshipId}' OR p#>>'{metaData,kavoshWorkStudentProfileVersion}' IS DISTINCT FROM s#>>'{guardianAuthority,studentProfileVersion}' OR(p->'metaData') ?| ARRAY['kavoshWorkerIdentityVersion','kavoshWorkerIdentityApprovalId'] ELSE p#>>'{metaData,kavoshWorkerIdentityVersion}' IS DISTINCT FROM s#>>'{guardianAuthority,workerIdentityVersion}' OR p#>>'{metaData,kavoshWorkerIdentityApprovalId}' IS DISTINCT FROM s#>>'{guardianAuthority,workerIdentityApprovalId}' OR(p->'metaData') ?| ARRAY['kavoshWorkIdentitySource','kavoshWorkStudentRelationshipId','kavoshWorkStudentProfileVersion'] END)$r$);
 IF u=d THEN RAISE EXCEPTION 'STUDENT_WORK_RECORDER_CHANGED';END IF;EXECUTE u;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 353 $$;

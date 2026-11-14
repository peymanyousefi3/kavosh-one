-- Original three-party work evidence. This does not enable the external
-- sender,certify a signature,grant publication consent or clear earned pay.
DO $$ DECLARE c text;BEGIN
 SELECT conname INTO c FROM pg_constraint WHERE conrelid='identity.work_signature_signer_history'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%party_role%';
 IF c IS NULL THEN RAISE EXCEPTION 'WORK_SIGNER_ROLE_CONSTRAINT_CHANGED';END IF;
 EXECUTE format('ALTER TABLE identity.work_signature_signer_history DROP CONSTRAINT %I',c);
END $$;
ALTER TABLE identity.work_signature_signer_history ADD CONSTRAINT work_signer_original_role CHECK(party_role IN('worker','academy_representative','legal_guardian'));
DO $$ DECLARE d text;u text;BEGIN
 d=pg_get_functiondef('identity.capture_work_signature_signers()'::regprocedure);
 u=replace(d,'contacts jsonb;c jsonb;BEGIN','contacts jsonb;c jsonb;required integer;BEGIN');
 u=replace(u,'SELECT jsonb_agg(to_jsonb(x)) INTO contacts', 'SELECT CASE WHEN w.source_snapshot ? ''guardianSigner'' THEN 3 ELSE 2 END INTO required FROM public.work_signature_send_requests r JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id WHERE r.academy_id=NEW.academy_id AND r.id=request; SELECT jsonb_agg(to_jsonb(x)) INTO contacts');
 u=replace(u,'<>2','<>required');
 IF u=d OR strpos(u,'INTO required FROM')=0 THEN RAISE EXCEPTION 'WORK_GUARDIAN_CAPTURE_CHANGED';END IF;EXECUTE u;
END $$;
-- Keep the old five-argument helper and its ACL unchanged for old callers.
CREATE FUNCTION identity.work_signature_signers_recorded(p_academy uuid,p_start uuid,p_request uuid,p_worker uuid,p_representative uuid,p_guardian uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_worker<>p_representative AND(p_guardian IS NULL OR(p_guardian<>p_worker AND p_guardian<>p_representative))
 AND count(*)=(CASE WHEN p_guardian IS NULL THEN 2 ELSE 3 END)
 AND count(*) FILTER(WHERE party_role='worker' AND signer_id=p_worker)=1
 AND count(*) FILTER(WHERE party_role='academy_representative' AND signer_id=p_representative)=1
 AND count(*) FILTER(WHERE party_role='legal_guardian' AND signer_id=p_guardian)=(CASE WHEN p_guardian IS NULL THEN 0 ELSE 1 END)
 FROM identity.work_signature_signer_history WHERE academy_id=p_academy AND start_id=p_start AND request_id=p_request
$$;
GRANT CREATE ON SCHEMA identity TO kavosh_identity_policy;
ALTER FUNCTION identity.work_signature_signers_recorded(uuid,uuid,uuid,uuid,uuid,uuid) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA identity FROM kavosh_identity_policy;
REVOKE ALL ON FUNCTION identity.work_signature_signers_recorded(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.work_signature_signers_recorded(uuid,uuid,uuid,uuid,uuid,uuid) TO kavosh_signature_completion_policy;
DO $$ DECLARE d text;u text;BEGIN
 d=pg_get_functiondef('public.work_signature_completion_source(uuid,uuid)'::regprocedure);
 u=replace(d,$q$CASE WHEN party->>'role'='worker' THEN w.worker_id ELSE w.academy_signer_id END$q$,$r$CASE party->>'role' WHEN 'worker' THEN w.worker_id WHEN 'academy_representative' THEN w.academy_signer_id WHEN 'legal_guardian' THEN(w.source_snapshot#>>'{guardianSigner,personId}')::uuid END$r$);
 u=replace(u,$q$WHERE lower(f->>'fieldType')='signature')) ORDER BY$q$,$r$WHERE lower(f->>'fieldType')='signature'))||CASE WHEN party->>'role'='legal_guardian' AND EXISTS(SELECT 1 FROM jsonb_array_elements(party->'fields') f WHERE f->'isRequired'='false'::jsonb) THEN jsonb_build_object('consentFields',(SELECT jsonb_agg(jsonb_build_object('id',f->>'id','pageNumber',f->'pageNumber','bounds',f->'bounds','purpose',f->>'consentPurpose') ORDER BY f->>'id') FROM jsonb_array_elements(party->'fields') f WHERE f->'isRequired'='false'::jsonb)) ELSE '{}'::jsonb END ORDER BY$r$);
 u=replace(u,$q$parties}') party)) source$q$,$r$parties}') party))||CASE WHEN w.source_snapshot ? 'guardianSigner' THEN jsonb_build_object('guardianAuthority',jsonb_build_object('personId',w.source_snapshot#>>'{guardianSigner,personId}','version',w.source_snapshot#>'{guardianSigner,authority,version}','approvalId',w.source_snapshot#>>'{guardianSigner,authority,approvalId}','profileVersion',w.source_snapshot#>'{guardianSigner,profileVersion}','workerIdentityVersion',w.source_snapshot#>'{guardianSigner,authority,workerIdentityVersion}','workerIdentityApprovalId',w.source_snapshot#>>'{guardianSigner,authority,workerIdentityApprovalId}')) ELSE '{}'::jsonb END source$r$);
 u=replace(u,'r.id,w.worker_id,w.academy_signer_id)','r.id,w.worker_id,w.academy_signer_id,(w.source_snapshot#>>''{guardianSigner,personId}'')::uuid)');
 u=replace(u,'AND identity.work_signature_signers_recorded', $r$AND((b.source_snapshot#>>'{routing,version}'='3')=(w.source_snapshot ? 'guardianSigner')) AND identity.work_signature_signers_recorded$r$);
 IF u=d OR strpos(u,'guardianAuthority')=0 OR strpos(u,'consentFields')=0 THEN RAISE EXCEPTION 'WORK_GUARDIAN_COMPLETION_SOURCE_CHANGED';END IF;EXECUTE u;
 d=pg_get_functiondef('public.work_signature_completion_signer_matches(uuid,uuid,text,text,text,text,text)'::regprocedure);
 u=replace(d,$q$ARRAY['worker','academy_representative']$q$,$r$ARRAY['worker','academy_representative','legal_guardian']$r$);
 IF u=d THEN RAISE EXCEPTION 'WORK_GUARDIAN_MATCHER_CHANGED';END IF;EXECUTE u;
END $$;
DO $$ DECLARE c text;BEGIN
 SELECT conname INTO c FROM pg_constraint WHERE conrelid='public.work_signature_completion_evidence'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%jsonb_array_length(provider_signers)%';
 IF c IS NULL THEN RAISE EXCEPTION 'WORK_COMPLETION_PARTIES_CONSTRAINT_CHANGED';END IF;EXECUTE format('ALTER TABLE public.work_signature_completion_evidence DROP CONSTRAINT %I',c);
 SELECT conname INTO c FROM pg_constraint WHERE conrelid='public.work_signature_completion_evidence'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%review_reasons <@%';
 IF c IS NULL THEN RAISE EXCEPTION 'WORK_COMPLETION_REASONS_CONSTRAINT_CHANGED';END IF;EXECUTE format('ALTER TABLE public.work_signature_completion_evidence DROP CONSTRAINT %I',c);
END $$;
ALTER TABLE public.work_signature_completion_evidence ADD CONSTRAINT work_completion_required_parties CHECK(jsonb_typeof(provider_signers)='array' AND jsonb_array_length(provider_signers)=jsonb_array_length(source->'parties') AND jsonb_array_length(provider_signers) BETWEEN 2 AND 3);
ALTER TABLE public.work_signature_completion_evidence ADD CONSTRAINT work_completion_required_review_reasons CHECK(review_reasons<@ARRAY['provider_flags_incomplete','worker:provider_flags_incomplete','worker:dual_otp_not_reported','worker:authentication_result_not_explicit','worker:signature_fields_not_reported','worker:phone_target_not_reported','academy_representative:provider_flags_incomplete','academy_representative:dual_otp_not_reported','academy_representative:authentication_result_not_explicit','academy_representative:signature_fields_not_reported','academy_representative:phone_target_not_reported','legal_guardian:provider_flags_incomplete','legal_guardian:dual_otp_not_reported','legal_guardian:authentication_result_not_explicit','legal_guardian:signature_fields_not_reported','legal_guardian:phone_target_not_reported']::text[]);
DO $$ DECLARE d text;u text;BEGIN
 d=pg_get_functiondef('public.record_work_signature_completion_evidence(uuid,uuid,text,text,jsonb)'::regprocedure);
 u=replace(d,'<>2','<>jsonb_array_length(s->''parties'')');
 u=replace(u,$q$IF jsonb_array_length(p->'signerDetails')$q$,$r$IF s ? 'guardianAuthority' AND(p#>>'{metaData,kavoshWorkGuardianId}' IS DISTINCT FROM s#>>'{guardianAuthority,personId}' OR p#>>'{metaData,kavoshWorkGuardianAuthorityVersion}' IS DISTINCT FROM s#>>'{guardianAuthority,version}' OR p#>>'{metaData,kavoshWorkGuardianAuthorityApprovalId}' IS DISTINCT FROM s#>>'{guardianAuthority,approvalId}' OR p#>>'{metaData,kavoshWorkGuardianProfileVersion}' IS DISTINCT FROM s#>>'{guardianAuthority,profileVersion}' OR p#>>'{metaData,kavoshWorkerIdentityVersion}' IS DISTINCT FROM s#>>'{guardianAuthority,workerIdentityVersion}' OR p#>>'{metaData,kavoshWorkerIdentityApprovalId}' IS DISTINCT FROM s#>>'{guardianAuthority,workerIdentityApprovalId}') THEN RAISE EXCEPTION 'WORK_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(p->'signerDetails')$r$);
 IF u=d THEN RAISE EXCEPTION 'WORK_GUARDIAN_RECORDER_CHANGED';END IF;EXECUTE u;
 d=pg_get_functiondef('public.observe_work_profile_consent_choices(jsonb,jsonb,jsonb)'::regprocedure);
 u=replace(d,'worker uuid;properties jsonb;BEGIN','worker uuid;properties jsonb;role_name text;BEGIN');
 u=replace(u,$q$IF routing IS NULL OR routing->'version' IS DISTINCT FROM '2'::jsonb THEN RETURN '[]'::jsonb;END IF;$q$,$r$IF routing IS NULL OR routing->>'version' NOT IN('2','3') THEN RETURN '[]'::jsonb;END IF;role_name=CASE WHEN routing->>'version'='3' THEN 'legal_guardian' ELSE 'worker' END;$r$);
 u=replace(u,$q$party->>'role'='worker'$q$,$r$party->>'role'=role_name$r$);
 u=replace(u,$q$x->>'role'='worker'$q$,$r$x->>'role'=role_name$r$);
 u=replace(u,'IF fields IS NULL OR jsonb_array_length(fields)', $r$IF fields IS NULL AND routing->>'version'='3' THEN RETURN '[]'::jsonb;END IF;IF fields IS NULL OR jsonb_array_length(fields)$r$);
 IF u=d OR strpos(u,'role_name=CASE')=0 THEN RAISE EXCEPTION 'WORK_GUARDIAN_CHOICES_CHANGED';END IF;EXECUTE u;
END $$;
-- Human acceptance explicitly attests the THIRD real signing time. Legacy
-- two-party payload/source bytes stay unchanged when the field is absent.
CREATE OR REPLACE FUNCTION public.work_signature_completion_review_input_valid(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR j ? 'signedAt' OR NOT(j ?& ARRAY['workerSignedAt','academySignedAt'])
 OR NOT coalesce(public.signature_completion_review_input_valid((j-ARRAY['workerSignedAt','academySignedAt','guardianSignedAt'])||jsonb_build_object('signedAt',j->'workerSignedAt')),false) THEN RETURN false;END IF;
 IF j->>'decision'='accepted' THEN
  IF j ? 'guardianSignedAt' AND(jsonb_typeof(j->'guardianSignedAt') IS DISTINCT FROM 'string' OR length(j->>'guardianSignedAt')>30 OR j->>'guardianSignedAt'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$') THEN RETURN false;END IF;
  RETURN jsonb_typeof(j->'academySignedAt')='string' AND length(j->>'academySignedAt')<=30 AND j->>'academySignedAt'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$';
 END IF;RETURN j->'academySignedAt'='null'::jsonb AND(NOT(j ? 'guardianSignedAt') OR j->'guardianSignedAt'='null'::jsonb);
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
DO $$ DECLARE d text;u text;BEGIN
 d=pg_get_functiondef('public.work_signature_completion_review_source(uuid,uuid,jsonb)'::regprocedure);
 u=replace(d,'academy_signed timestamptz;BEGIN','academy_signed timestamptz;guardian_signed timestamptz;guardian jsonb;BEGIN');
 u=replace(u,$q$IF j->>'decision'<>'accepted' THEN RETURN s;END IF;$q$,$r$guardian=p.source_snapshot->'guardianSigner';
 IF guardian IS NOT NULL THEN s=s||jsonb_build_object('guardianId',guardian->'personId');ELSIF j ? 'guardianSignedAt' THEN RETURN NULL;END IF;
 IF j->>'decision'<>'accepted' THEN RETURN s;END IF;
 IF guardian IS NOT NULL THEN
  IF jsonb_typeof(j->'guardianSignedAt') IS DISTINCT FROM 'string' THEN RETURN NULL;END IF;guardian_signed=(j->>'guardianSignedAt')::timestamptz;
  IF guardian_signed<start.created_at OR guardian_signed>e.recorded_at OR guardian_signed>clock_timestamp() OR guardian_signed<(guardian#>>'{authority,validFrom}')::timestamptz OR(guardian#>>'{authority,validUntil}' IS NOT NULL AND guardian_signed>=(guardian#>>'{authority,validUntil}')::timestamptz) THEN RETURN NULL;END IF;
  s=s||jsonb_build_object('attestedGuardianSignedAt',j->'guardianSignedAt');
 END IF;$r$);
 IF u=d OR strpos(u,'attestedGuardianSignedAt')=0 THEN RAISE EXCEPTION 'WORK_GUARDIAN_REVIEW_SOURCE_CHANGED';END IF;EXECUTE u;
 d=pg_get_functiondef('public.guard_work_signature_completion_review()'::regprocedure);
 u=replace(d,$q$NEW.changed_by=(s->>'academySignerId')::uuid$q$,$r$NEW.changed_by=(s->>'academySignerId')::uuid OR NEW.changed_by=(s->>'guardianId')::uuid$r$);
 IF u=d THEN RAISE EXCEPTION 'WORK_GUARDIAN_REVIEW_BENEFICIARY_CHANGED';END IF;EXECUTE u;
END $$;
-- Native one-use starts may now capture all required parties. The external
-- orchestrator remains opt-in and requires separately configured credentials.
DO $$ DECLARE d text;u text;BEGIN
 d=pg_get_functiondef('public.work_signature_dispatch_guard()'::regprocedure);
 u=replace(d,$q$IF TG_TABLE_NAME='work_signature_dispatch_starts' AND r.context#>>'{source,content,content,routing,version}'='3' THEN RAISE EXCEPTION 'WORK_GUARDIAN_DISPATCH_NOT_ENABLED' USING ERRCODE='23514';END IF;$q$,'');
 IF u=d THEN RAISE EXCEPTION 'WORK_GUARDIAN_NATIVE_START_GATE_CHANGED';END IF;EXECUTE u;
END $$;
-- Late-paperwork context must include the guardian,not silently decide the
-- agreement was signed before work from only the other two signing times.
DO $$ DECLARE d text;u text;BEGIN
 d=pg_get_functiondef('public.work_activity_agreement_context(uuid,uuid,integer)'::regprocedure);
 u=replace(d,'last_signed timestamptz;BEGIN','last_signed timestamptz;guardian_signed timestamptz;requires_guardian boolean;BEGIN');
 u=replace(u,'original=coalesce(', $r$requires_guardian=e.source ? 'guardianAuthority';original=coalesce($r$);
 u=replace(u,'last_signed=greatest(worker_signed,academy_signed);', $r$guardian_signed=(r.source->>'attestedGuardianSignedAt')::timestamptz;last_signed=greatest(worker_signed,academy_signed,guardian_signed);$r$);
 u=replace(u,'worker_signed IS NULL OR academy_signed IS NULL THEN', 'worker_signed IS NULL OR academy_signed IS NULL OR(requires_guardian AND guardian_signed IS NULL) THEN');
 u=replace(u,$q$THEN 'both_attested_by_work_start'$q$,$r$THEN CASE WHEN requires_guardian THEN 'all_required_attested_by_work_start' ELSE 'both_attested_by_work_start' END$r$);
 u=replace(u,$q$'legallyEffective',false,'paymentCleared',false);$q$,$r$'legallyEffective',false,'paymentCleared',false)||CASE WHEN requires_guardian THEN jsonb_build_object('humanAttestedGuardianSignedAt',guardian_signed,'guardianAttestedSigningAfterWorkStarted',guardian_signed>t.starts_at,'requiredSignerCount',3,'allRequiredSignaturesIndependentlyVerified',false) ELSE '{}'::jsonb END;$r$);
 IF u=d OR strpos(u,'humanAttestedGuardianSignedAt')=0 THEN RAISE EXCEPTION 'WORK_GUARDIAN_ACTIVITY_CONTEXT_CHANGED';END IF;EXECUTE u;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 351 $$;

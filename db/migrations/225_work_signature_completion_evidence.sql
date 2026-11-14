-- Independent two-party evidence,not enrollment admission or earned-pay
-- clearance. Only the isolated recorder can create observations;never backfill.
CREATE TABLE public.work_signature_completion_evidence(
 academy_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),start_id uuid NOT NULL,
 source jsonb NOT NULL,source_fingerprint text NOT NULL CHECK(source_fingerprint~'^[a-f0-9]{64}$'),
 manifest jsonb NOT NULL,provider_signers jsonb NOT NULL,review_reasons text[] NOT NULL,
 state text NOT NULL CHECK(state IN('evidence_recorded','review_required')),
 evidence_fingerprint text NOT NULL CHECK(evidence_fingerprint~'^[a-f0-9]{64}$'),
 recorded_by name NOT NULL DEFAULT session_user,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,start_id,evidence_fingerprint),
 FOREIGN KEY(academy_id,start_id) REFERENCES public.work_signature_dispatch_starts(academy_id,id),
 CHECK(jsonb_typeof(source)='object' AND source->>'purpose' IS NOT DISTINCT FROM 'worker_services' AND source->>'sourceFingerprint' IS NOT DISTINCT FROM source_fingerprint AND source->>'academyId' IS NOT DISTINCT FROM academy_id::text AND source->>'startId' IS NOT DISTINCT FROM start_id::text),
 CHECK(manifest#>>'{receipt,sourceFingerprint}' IS NOT DISTINCT FROM source_fingerprint),
 CHECK(jsonb_typeof(provider_signers)='array' AND jsonb_array_length(provider_signers)=2),
 CHECK(evidence_fingerprint=encode(sha256(convert_to(jsonb_build_array(source,manifest,provider_signers,to_jsonb(review_reasons))::text,'UTF8')),'hex')),
 CHECK(review_reasons<@ARRAY['provider_flags_incomplete','worker:provider_flags_incomplete','worker:dual_otp_not_reported','worker:authentication_result_not_explicit','worker:signature_fields_not_reported','worker:phone_target_not_reported','academy_representative:provider_flags_incomplete','academy_representative:dual_otp_not_reported','academy_representative:authentication_result_not_explicit','academy_representative:signature_fields_not_reported','academy_representative:phone_target_not_reported']::text[]),
 CHECK((state='evidence_recorded')=(cardinality(review_reasons)=0))
);
ALTER TABLE public.work_signature_completion_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_signature_completion_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.work_signature_completion_evidence USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY work_completion_executor ON public.work_signature_completion_evidence TO kavosh_signature_completion_policy USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.work_signature_completion_evidence TO kavosh_signature_completion_policy;
CREATE TRIGGER work_completion_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.work_signature_completion_evidence FOR EACH ROW EXECUTE FUNCTION public.guard_signature_completion_evidence();
CREATE FUNCTION public.work_signature_evidence_artifact_id(p_academy uuid,p_start uuid,p_source text,p_kind text,p_sha text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 WITH d AS(SELECT sha256(convert_to(array_to_json(ARRAY['kavosh-work-signature-evidence-v1',p_academy::text,p_start::text,p_source,p_kind,p_sha])::text,'UTF8')) bytes),
 h AS(SELECT overlay(overlay(substr(encode(bytes,'hex'),1,32) placing '8' from 13 for 1) placing to_hex(((get_byte(bytes,8)>>4)&3)|8) from 17 for 1) v FROM d)
 SELECT(substr(v,1,8)||'-'||substr(v,9,4)||'-'||substr(v,13,4)||'-'||substr(v,17,4)||'-'||substr(v,21,12))::uuid FROM h
$$;
REVOKE ALL ON FUNCTION public.work_signature_evidence_artifact_id(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_evidence_artifact_id(uuid,uuid,text,text,text) TO kavosh_signature_completion_policy;
GRANT EXECUTE ON FUNCTION public.work_signature_completion_signer_matches(uuid,uuid,text,text,text,text,text) TO kavosh_signature_completion_policy;
CREATE FUNCTION public.emit_work_signature_completion_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE written integer;BEGIN
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(NEW.academy_id,gen_random_uuid(),'work.signature.completion.evidence.critical',NEW.id,NEW.start_id);
 GET DIAGNOSTICS written=ROW_COUNT;IF written<>1 THEN RAISE EXCEPTION 'WORK_COMPLETION_EVENT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_completion_policy;
ALTER FUNCTION public.emit_work_signature_completion_evidence() OWNER TO kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.emit_work_signature_completion_evidence() FROM PUBLIC;
CREATE TRIGGER work_completion_event AFTER INSERT ON public.work_signature_completion_evidence FOR EACH ROW EXECUTE FUNCTION public.emit_work_signature_completion_evidence();
CREATE FUNCTION public.record_work_signature_completion_evidence(p_academy uuid,p_start uuid,p_source text,p_properties text,p_manifest jsonb)
RETURNS TABLE(evidence_id uuid,evidence_state text,inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s jsonb;p jsonb;party jsonb;candidate jsonb;signer jsonb;fields jsonb;f jsonb;original jsonb;kind text;a jsonb;phone text;matches record;
 reasons text[]:=ARRAY[]::text[];party_reasons text[];used_ids uuid[]:=ARRAY[]::uuid[];provider_signers jsonb:='[]'::jsonb;
 fp text;signer_id uuid;new_id uuid;new_state text;receipt jsonb;matched integer;role_name text;BEGIN
 IF p_academy IS NULL OR p_start IS NULL OR p_source IS NULL OR p_source!~'^[a-f0-9]{64}$' OR p_properties IS NULL OR octet_length(p_properties) NOT BETWEEN 1 AND 1048576 THEN RAISE EXCEPTION 'INVALID_WORK_COMPLETION_EVIDENCE' USING ERRCODE='23514';END IF;
 -- Same exact boundary as service and actor conflicts;no provider IO or pool
 -- connection is held while reading cloud files before this transaction.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||':work-signature-transport:'||p_start::text,0));
 s=public.work_signature_completion_source(p_academy,p_start);
 IF s IS NULL OR s->>'sourceFingerprint' IS DISTINCT FROM p_source THEN RAISE EXCEPTION 'WORK_COMPLETION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NOT(p_properties IS JSON OBJECT WITH UNIQUE KEYS) THEN RAISE EXCEPTION 'WORK_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;p=p_properties::jsonb;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->>'status' IS DISTINCT FROM 'Completed' OR lower(p->>'documentId') IS DISTINCT FROM s->>'documentId'
 OR jsonb_typeof(p->'signerDetails') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'WORK_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(p->'signerDetails')<>2 OR p#>>'{metaData,kavoshWorkPreparationId}' IS DISTINCT FROM s->>'preparationId'
 OR p#>>'{metaData,kavoshWorkContentBindingId}' IS DISTINCT FROM s->>'bindingId' OR p#>>'{metaData,kavoshDocumentSha256}' IS DISTINCT FROM s->>'documentSha256'
 OR(SELECT count(DISTINCT lower(x->>'signerEmail')) FROM jsonb_array_elements(p->'signerDetails') x)<>2
 OR(SELECT count(DISTINCT(x->>'id')::uuid) FROM jsonb_array_elements(p->'signerDetails') x)<>2 THEN RAISE EXCEPTION 'WORK_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
 FOREACH kind IN ARRAY ARRAY['isDeleted','enableReassign','enablePrintAndSign'] LOOP
  IF p->kind='true'::jsonb OR(p->kind IS NOT NULL AND jsonb_typeof(p->kind) NOT IN('boolean','null')) THEN RAISE EXCEPTION 'WORK_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
 END LOOP;
 IF p->'isDeleted' IS DISTINCT FROM 'false'::jsonb OR p->'enableReassign' IS DISTINCT FROM 'false'::jsonb OR p->'enablePrintAndSign' IS DISTINCT FROM 'false'::jsonb THEN reasons=array_append(reasons,'provider_flags_incomplete');END IF;
 FOR party IN SELECT x FROM jsonb_array_elements(s->'parties') x ORDER BY x->>'role' LOOP
  role_name=party->>'role';matched=0;signer=NULL;phone=NULL;party_reasons=ARRAY[]::text[];
  FOR candidate IN SELECT x FROM jsonb_array_elements(p->'signerDetails') x LOOP
   IF jsonb_typeof(candidate->'signerName') IS DISTINCT FROM 'string' OR length(candidate->>'signerName') NOT BETWEEN 1 AND 200 OR jsonb_typeof(candidate->'signerEmail') IS DISTINCT FROM 'string' OR length(candidate->>'signerEmail') NOT BETWEEN 1 AND 254 THEN RAISE EXCEPTION 'WORK_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
   phone=NULL;
   IF candidate->'phoneNumber' IS NOT NULL AND candidate->'phoneNumber'<>'null'::jsonb THEN
    IF jsonb_typeof(candidate->'phoneNumber')='string' THEN phone=candidate->>'phoneNumber';
    ELSIF jsonb_typeof(candidate->'phoneNumber')='object' AND jsonb_typeof(candidate#>'{phoneNumber,countryCode}')='string' AND jsonb_typeof(candidate#>'{phoneNumber,number}')='string' THEN phone=CASE WHEN left(candidate#>>'{phoneNumber,countryCode}',1)='+' THEN '' ELSE '+' END||(candidate#>>'{phoneNumber,countryCode}')||(candidate#>>'{phoneNumber,number}');
    ELSE RAISE EXCEPTION 'WORK_COMPLETION_SIGNER_MISMATCH' USING ERRCODE='23514';END IF;
    phone=regexp_replace(phone,'[ .()-]','','g');IF phone IS NULL OR phone!~'^[+][1-9][0-9]{7,14}$' THEN RAISE EXCEPTION 'WORK_COMPLETION_SIGNER_MISMATCH' USING ERRCODE='23514';END IF;
   END IF;
   SELECT * INTO matches FROM public.work_signature_completion_signer_matches(p_academy,p_start,p_source,role_name,candidate->>'signerName',candidate->>'signerEmail',phone);
   IF coalesce(matches.name_matches AND matches.email_matches,false) AND(phone IS NULL OR coalesce(matches.phone_matches,false)) THEN matched=matched+1;signer=candidate;END IF;
  END LOOP;
  IF matched<>1 THEN RAISE EXCEPTION 'WORK_COMPLETION_SIGNER_MISMATCH' USING ERRCODE='23514';END IF;signer_id=(signer->>'id')::uuid;
  IF signer_id IS NULL OR signer_id=ANY(used_ids) THEN RAISE EXCEPTION 'WORK_COMPLETION_SIGNER_MISMATCH' USING ERRCODE='23514';END IF;used_ids=array_append(used_ids,signer_id);
  IF signer->>'status' IS DISTINCT FROM 'Completed' OR(signer->>'signerType' IS NOT NULL AND signer->>'signerType'<>'Signer') OR(signer->>'signType' IS NOT NULL AND signer->>'signType'<>'Single') OR(signer->>'authenticationType' IS NOT NULL AND signer->>'authenticationType'<>'SMSOTP') THEN RAISE EXCEPTION 'WORK_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
  FOREACH kind IN ARRAY ARRAY['enableEmailOTP','isReassigned','isAuthenticationFailed'] LOOP
   IF(signer->kind IS NOT NULL AND jsonb_typeof(signer->kind) NOT IN('boolean','null')) OR(kind='enableEmailOTP' AND signer->kind='false'::jsonb) OR(kind<>'enableEmailOTP' AND signer->kind='true'::jsonb) THEN RAISE EXCEPTION 'WORK_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
  END LOOP;
  IF signer->>'signerType' IS DISTINCT FROM 'Signer' OR signer->>'signType' IS DISTINCT FROM 'Single' OR signer->'isReassigned' IS DISTINCT FROM 'false'::jsonb THEN party_reasons=array_append(party_reasons,'provider_flags_incomplete');END IF;
  IF signer->>'authenticationType' IS DISTINCT FROM 'SMSOTP' OR signer->'enableEmailOTP' IS DISTINCT FROM 'true'::jsonb THEN party_reasons=array_append(party_reasons,'dual_otp_not_reported');END IF;
  IF signer->'isAuthenticationFailed' IS DISTINCT FROM 'false'::jsonb THEN party_reasons=array_append(party_reasons,'authentication_result_not_explicit');END IF;
  IF signer->'phoneNumber' IS NULL OR signer->'phoneNumber'='null'::jsonb THEN party_reasons=array_append(party_reasons,'phone_target_not_reported');END IF;
  IF signer->'formFields' IS NULL OR signer->'formFields'='null'::jsonb THEN party_reasons=array_append(party_reasons,'signature_fields_not_reported');
  ELSE
   IF jsonb_typeof(signer->'formFields')<>'array' OR jsonb_array_length(signer->'formFields')>1000 THEN RAISE EXCEPTION 'WORK_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
   SELECT coalesce(jsonb_agg(x ORDER BY x->>'id'),'[]'::jsonb) INTO fields FROM jsonb_array_elements(signer->'formFields') x WHERE lower(x->>'type')='signature';
   IF jsonb_array_length(fields)<>jsonb_array_length(party->'signatureFields') OR(SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(fields) x)<>jsonb_array_length(fields) THEN RAISE EXCEPTION 'WORK_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
   FOR f IN SELECT * FROM jsonb_array_elements(fields) LOOP
    SELECT x INTO original FROM jsonb_array_elements(party->'signatureFields') x WHERE x->>'id'=f->>'id';
    IF original IS NULL OR f->'pageNumber' IS DISTINCT FROM original->'pageNumber' OR(f->'bounds' IS NOT NULL AND f->'bounds'<>'null'::jsonb AND f->'bounds' IS DISTINCT FROM original->'bounds') THEN RAISE EXCEPTION 'WORK_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
    IF(f->'bounds' IS NULL OR f->'bounds'='null'::jsonb) AND NOT('signature_fields_not_reported'=ANY(party_reasons)) THEN party_reasons=array_append(party_reasons,'signature_fields_not_reported');END IF;
   END LOOP;
  END IF;
  FOR kind IN SELECT unnest(party_reasons) LOOP reasons=array_append(reasons,role_name||':'||kind);END LOOP;
  provider_signers=provider_signers||jsonb_build_array(jsonb_build_object('role',role_name,'providerSignerId',signer_id));
 END LOOP;
 IF cardinality(used_ids)<>2 THEN RAISE EXCEPTION 'WORK_COMPLETION_SIGNER_MISMATCH' USING ERRCODE='23514';END IF;
 IF p_manifest IS NULL OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR NOT(p_manifest ?& ARRAY['storageTargetId','receipt','etags']) OR p_manifest-ARRAY['storageTargetId','receipt','etags']<>'{}'::jsonb OR p_manifest->>'storageTargetId' IS NULL OR p_manifest->>'storageTargetId'!~'^[a-f0-9]{64}$' OR jsonb_typeof(p_manifest->'receipt') IS DISTINCT FROM 'object' OR jsonb_typeof(p_manifest->'etags') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'WORK_COMPLETION_RETENTION_MISMATCH' USING ERRCODE='23514';END IF;
 receipt=p_manifest->'receipt';
 IF NOT(receipt ?& ARRAY['sourceFingerprint','document','audit','properties']) OR receipt-ARRAY['sourceFingerprint','document','audit','properties']<>'{}'::jsonb OR receipt->>'sourceFingerprint' IS DISTINCT FROM p_source OR NOT((p_manifest->'etags') ?& ARRAY['document','audit','properties']) OR(p_manifest->'etags')-ARRAY['document','audit','properties']<>'{}'::jsonb THEN RAISE EXCEPTION 'WORK_COMPLETION_RETENTION_MISMATCH' USING ERRCODE='23514';END IF;
 FOREACH kind IN ARRAY ARRAY['document','audit','properties'] LOOP
  a=receipt->kind;
  IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['id','sha256','sizeBytes']) OR a-ARRAY['id','sha256','sizeBytes']<>'{}'::jsonb OR a->>'sha256' IS NULL OR a->>'sha256'!~'^[a-f0-9]{64}$' OR jsonb_typeof(a->'sizeBytes') IS DISTINCT FROM 'number' OR(a->>'sizeBytes')::numeric NOT BETWEEN 1 AND(CASE WHEN kind='properties' THEN 1048576 ELSE 10485760 END) OR trunc((a->>'sizeBytes')::numeric)<>(a->>'sizeBytes')::numeric OR(a->>'id')::uuid IS DISTINCT FROM public.work_signature_evidence_artifact_id(p_academy,p_start,p_source,kind,a->>'sha256') OR p_manifest#>>ARRAY['etags',kind] IS NULL OR length(p_manifest#>>ARRAY['etags',kind]) NOT BETWEEN 3 AND 202 OR p_manifest#>>ARRAY['etags',kind]!~'^"[!#-~]+"$' THEN RAISE EXCEPTION 'WORK_COMPLETION_RETENTION_MISMATCH' USING ERRCODE='23514';END IF;
 END LOOP;
 IF receipt#>>'{document,sha256}'=receipt#>>'{audit,sha256}' OR(receipt#>>'{properties,sizeBytes}')::integer<>octet_length(p_properties) OR receipt#>>'{properties,sha256}' IS DISTINCT FROM encode(sha256(convert_to(p_properties,'UTF8')),'hex') THEN RAISE EXCEPTION 'WORK_COMPLETION_RETENTION_MISMATCH' USING ERRCODE='23514';END IF;
 fp=encode(sha256(convert_to(jsonb_build_array(s,p_manifest,provider_signers,to_jsonb(reasons))::text,'UTF8')),'hex');new_state=CASE WHEN cardinality(reasons)=0 THEN 'evidence_recorded' ELSE 'review_required' END;
 INSERT INTO public.work_signature_completion_evidence(academy_id,start_id,source,source_fingerprint,manifest,provider_signers,review_reasons,state,evidence_fingerprint)
 VALUES(p_academy,p_start,s,p_source,p_manifest,provider_signers,reasons,new_state,fp) ON CONFLICT(academy_id,start_id,evidence_fingerprint) DO NOTHING RETURNING id INTO new_id;
 IF new_id IS NOT NULL THEN RETURN QUERY SELECT new_id,new_state,true;
 ELSE RETURN QUERY SELECT e.id,e.state,false FROM public.work_signature_completion_evidence e WHERE e.academy_id=p_academy AND e.start_id=p_start AND e.evidence_fingerprint=fp;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORK_COMPLETION_RECORD_REQUIRED' USING ERRCODE='55000';END IF;
 END IF;
END $$;
ALTER FUNCTION public.record_work_signature_completion_evidence(uuid,uuid,text,text,jsonb) OWNER TO kavosh_signature_completion_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.record_work_signature_completion_evidence(uuid,uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_work_signature_completion_evidence(uuid,uuid,text,text,jsonb) TO kavosh_signature_completion_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 225 $$;

-- Retained provider observations are evidence awaiting human approval,NEVER
-- admission,identity/legal certification or permission to resend a document.
-- Choose the same operator-held provider account binding as the sender,not
-- merely any credential in the same geographic region. Preserve function ACL.
GRANT SELECT(connection_id,connection_target) ON public.agreement_packages TO kavosh_signature_completion_policy;
DO $$ DECLARE d text;updated text;BEGIN
 d=pg_get_functiondef('public.signature_completion_source(uuid,uuid)'::regprocedure);
 updated=replace(d,'''packageId'',p.id,','''connectionId'',p.connection_id,''connectionTargetId'',p.connection_target,''packageId'',p.id,');
 IF updated=d THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_SOURCE_DEFINITION_CHANGED';END IF;
 EXECUTE updated;
END $$;
CREATE TABLE public.signature_completion_evidence(
 academy_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),start_id uuid NOT NULL,
 source jsonb NOT NULL,source_fingerprint text NOT NULL CHECK(source_fingerprint~'^[a-f0-9]{64}$'),
 manifest jsonb NOT NULL,provider_signer_id uuid NOT NULL,review_reasons text[] NOT NULL,
 state text NOT NULL CHECK(state IN('evidence_recorded','review_required')),
 evidence_fingerprint text NOT NULL CHECK(evidence_fingerprint~'^[a-f0-9]{64}$'),
 recorded_by name NOT NULL DEFAULT session_user,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,start_id,evidence_fingerprint),
 FOREIGN KEY(academy_id,start_id) REFERENCES public.signature_dispatch_starts(academy_id,id),
 CHECK(jsonb_typeof(source)='object' AND(source->>'sourceFingerprint') IS NOT DISTINCT FROM source_fingerprint
 AND(source->>'academyId') IS NOT DISTINCT FROM academy_id::text AND(source->>'startId') IS NOT DISTINCT FROM start_id::text),
 CHECK((manifest#>>'{receipt,sourceFingerprint}') IS NOT DISTINCT FROM source_fingerprint),
 CHECK(evidence_fingerprint=encode(sha256(convert_to(jsonb_build_array(source,manifest,provider_signer_id,to_jsonb(review_reasons))::text,'UTF8')),'hex')),
 CHECK(review_reasons<@ARRAY['provider_flags_incomplete','dual_otp_not_reported','authentication_result_not_explicit','signature_fields_not_reported','phone_target_not_reported']::text[]),
 CHECK((state='evidence_recorded')=(cardinality(review_reasons)=0))
);
ALTER TABLE public.signature_completion_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_completion_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.signature_completion_evidence USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY signature_completion_executor ON public.signature_completion_evidence TO kavosh_signature_completion_policy USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.signature_completion_evidence TO kavosh_signature_completion_policy;
CREATE POLICY signature_completion_event_write ON public.outbox_events FOR INSERT TO kavosh_signature_completion_policy WITH CHECK(true);
GRANT INSERT ON public.outbox_events TO kavosh_signature_completion_policy;
GRANT EXECUTE ON FUNCTION public.signature_completion_signer_matches(uuid,uuid,text,text,text,text) TO kavosh_signature_completion_policy;

CREATE FUNCTION public.signature_evidence_artifact_id(p_academy uuid,p_start uuid,p_source text,p_kind text,p_sha text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 WITH d AS(SELECT sha256(convert_to(array_to_json(ARRAY['kavosh-signature-evidence-v1',p_academy::text,p_start::text,p_source,p_kind,p_sha])::text,'UTF8')) bytes),
 h AS(SELECT overlay(overlay(substr(encode(bytes,'hex'),1,32) placing '8' from 13 for 1) placing to_hex(((get_byte(bytes,8)>>4)&3)|8) from 17 for 1) v FROM d)
 SELECT(substr(v,1,8)||'-'||substr(v,9,4)||'-'||substr(v,13,4)||'-'||substr(v,17,4)||'-'||substr(v,21,12))::uuid FROM h
$$;
REVOKE ALL ON FUNCTION public.signature_evidence_artifact_id(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_evidence_artifact_id(uuid,uuid,text,text,text) TO kavosh_signature_completion_policy;
CREATE FUNCTION public.guard_signature_completion_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_EVIDENCE_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF current_user<>'kavosh_signature_completion_policy' THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_WORKER_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.recorded_by=session_user;NEW.recorded_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER signature_completion_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.signature_completion_evidence FOR EACH ROW EXECUTE FUNCTION public.guard_signature_completion_evidence();
CREATE FUNCTION public.emit_signature_completion_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(NEW.academy_id,gen_random_uuid(),'signature.completion.evidence.critical',NEW.id,NEW.start_id);RETURN NULL;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_completion_policy;
ALTER FUNCTION public.emit_signature_completion_evidence() OWNER TO kavosh_signature_completion_policy;
CREATE TRIGGER signature_completion_event AFTER INSERT ON public.signature_completion_evidence FOR EACH ROW EXECUTE FUNCTION public.emit_signature_completion_evidence();
REVOKE ALL ON FUNCTION public.guard_signature_completion_evidence(),public.emit_signature_completion_evidence() FROM PUBLIC;

-- The PRIVATE original provider JSON is used transiently to derive checks;it
-- is never duplicated into the public schema,audit or notification payload.
-- Its exact UTF8 bytes must match the retained properties artifact identity.
CREATE FUNCTION public.record_signature_completion_evidence(p_academy uuid,p_start uuid,p_source text,p_properties text,p_manifest jsonb)
RETURNS TABLE(evidence_id uuid,evidence_state text,inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s jsonb;p jsonb;signer jsonb;fields jsonb;f jsonb;original jsonb;kind text;a jsonb;phone text;matches record;
 reasons text[]:=ARRAY[]::text[];fp text;signer_id uuid;new_id uuid;new_state text;receipt jsonb;BEGIN
 IF p_academy IS NULL OR p_start IS NULL OR p_source IS NULL OR p_source!~'^[a-f0-9]{64}$' OR p_properties IS NULL OR octet_length(p_properties) NOT BETWEEN 1 AND 1048576 THEN RAISE EXCEPTION 'INVALID_SIGNATURE_COMPLETION_EVIDENCE' USING ERRCODE='23514';END IF;
 -- Same serialization boundary as transport receipts and actor conflicts.
 -- Late conflict invalidates a new observation instead of racing approval.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||':signature-transport:'||p_start::text,0));
 s=public.signature_completion_source(p_academy,p_start);
 IF s IS NULL OR s->>'sourceFingerprint' IS DISTINCT FROM p_source THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NOT(p_properties IS JSON OBJECT WITH UNIQUE KEYS) THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
 p=p_properties::jsonb;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->>'status' IS DISTINCT FROM 'Completed' OR lower(p->>'documentId') IS DISTINCT FROM s->>'documentId'
 OR jsonb_typeof(p->'signerDetails') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(p->'signerDetails')<>1 OR p#>>'{metaData,kavoshPackageId}' IS DISTINCT FROM s->>'packageId'
 OR p#>>'{metaData,kavoshContentAttachmentId}' IS DISTINCT FROM s->>'attachmentId' OR p#>>'{metaData,kavoshContentBindingId}' IS DISTINCT FROM s->>'bindingId'
 OR p#>>'{metaData,kavoshDocumentSha256}' IS DISTINCT FROM s->>'documentSha256' THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
 signer=p#>'{signerDetails,0}';signer_id=(signer->>'id')::uuid;
 IF signer_id IS NULL OR jsonb_typeof(signer->'signerName') IS DISTINCT FROM 'string' OR jsonb_typeof(signer->'signerEmail') IS DISTINCT FROM 'string' OR signer->>'status' IS DISTINCT FROM 'Completed' OR(signer->>'signerType' IS NOT NULL AND signer->>'signerType'<>'Signer')
 OR(signer->>'signType' IS NOT NULL AND signer->>'signType'<>'Single') OR(signer->>'authenticationType' IS NOT NULL AND signer->>'authenticationType'<>'SMSOTP')
 OR signer->'enableEmailOTP'='false'::jsonb OR p->'isDeleted'='true'::jsonb OR p->'enableReassign'='true'::jsonb OR p->'enablePrintAndSign'='true'::jsonb
 OR signer->'isReassigned'='true'::jsonb OR signer->'isAuthenticationFailed'='true'::jsonb
 THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
 FOREACH kind IN ARRAY ARRAY['isDeleted','enableReassign','enablePrintAndSign'] LOOP IF p->kind IS NOT NULL AND jsonb_typeof(p->kind) NOT IN('boolean','null') THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;END LOOP;
 FOREACH kind IN ARRAY ARRAY['enableEmailOTP','isReassigned','isAuthenticationFailed'] LOOP IF signer->kind IS NOT NULL AND jsonb_typeof(signer->kind) NOT IN('boolean','null') THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;END LOOP;
 IF p->'isDeleted' IS DISTINCT FROM 'false'::jsonb OR p->'enableReassign' IS DISTINCT FROM 'false'::jsonb OR p->'enablePrintAndSign' IS DISTINCT FROM 'false'::jsonb
 OR signer->>'signerType' IS DISTINCT FROM 'Signer' OR signer->>'signType' IS DISTINCT FROM 'Single' OR signer->'isReassigned' IS DISTINCT FROM 'false'::jsonb THEN reasons=array_append(reasons,'provider_flags_incomplete');END IF;
 IF signer->>'authenticationType' IS DISTINCT FROM 'SMSOTP' OR signer->'enableEmailOTP' IS DISTINCT FROM 'true'::jsonb THEN reasons=array_append(reasons,'dual_otp_not_reported');END IF;
 IF signer->'isAuthenticationFailed' IS DISTINCT FROM 'false'::jsonb THEN reasons=array_append(reasons,'authentication_result_not_explicit');END IF;
 IF signer->'formFields' IS NULL OR signer->'formFields'='null'::jsonb THEN reasons=array_append(reasons,'signature_fields_not_reported');
 ELSE
  IF jsonb_typeof(signer->'formFields')<>'array' OR jsonb_array_length(signer->'formFields')>1000 THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'id'),'[]'::jsonb) INTO fields FROM jsonb_array_elements(signer->'formFields') x WHERE lower(x->>'type')='signature';
  IF jsonb_array_length(fields)<>jsonb_array_length(s->'signatureFields') OR(SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(fields) x)<>jsonb_array_length(fields) THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
  FOR f IN SELECT * FROM jsonb_array_elements(fields) LOOP
   SELECT x INTO original FROM jsonb_array_elements(s->'signatureFields') x WHERE x->>'id'=f->>'id';
   IF original IS NULL OR f->'pageNumber' IS DISTINCT FROM original->'pageNumber' OR(f->'bounds' IS NOT NULL AND f->'bounds'<>'null'::jsonb AND f->'bounds' IS DISTINCT FROM original->'bounds') THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_PROVIDER_MISMATCH' USING ERRCODE='23514';END IF;
   IF f->'bounds' IS NULL OR f->'bounds'='null'::jsonb THEN IF NOT('signature_fields_not_reported'=ANY(reasons)) THEN reasons=array_append(reasons,'signature_fields_not_reported');END IF;END IF;
  END LOOP;
 END IF;
 IF signer->'phoneNumber' IS NULL OR signer->'phoneNumber'='null'::jsonb THEN phone=NULL;reasons=array_append(reasons,'phone_target_not_reported');
 ELSE
  IF jsonb_typeof(signer->'phoneNumber')='string' THEN phone=signer->>'phoneNumber';
  ELSIF jsonb_typeof(signer->'phoneNumber')='object' THEN
   IF jsonb_typeof(signer#>'{phoneNumber,countryCode}') IS DISTINCT FROM 'string' OR jsonb_typeof(signer#>'{phoneNumber,number}') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_SIGNER_MISMATCH' USING ERRCODE='23514';END IF;
   phone=CASE WHEN left(signer#>>'{phoneNumber,countryCode}',1)='+' THEN '' ELSE '+' END||(signer#>>'{phoneNumber,countryCode}')||(signer#>>'{phoneNumber,number}');
  ELSE RAISE EXCEPTION 'SIGNATURE_COMPLETION_SIGNER_MISMATCH' USING ERRCODE='23514';END IF;
  phone=regexp_replace(phone,'[ .()-]','','g');IF phone IS NULL OR phone!~'^[+][1-9][0-9]{7,14}$' THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_SIGNER_MISMATCH' USING ERRCODE='23514';END IF;
 END IF;
 SELECT * INTO matches FROM public.signature_completion_signer_matches(p_academy,p_start,p_source,signer->>'signerName',signer->>'signerEmail',phone);
 IF NOT coalesce(matches.name_matches AND matches.email_matches,false) OR(phone IS NOT NULL AND NOT coalesce(matches.phone_matches,false)) THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_SIGNER_MISMATCH' USING ERRCODE='23514';END IF;
 IF p_manifest IS NULL OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(p_manifest))<>3
 OR p_manifest->>'storageTargetId' IS NULL OR p_manifest->>'storageTargetId'!~'^[a-f0-9]{64}$' OR jsonb_typeof(p_manifest->'receipt') IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_manifest->'etags') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_RETENTION_MISMATCH' USING ERRCODE='23514';END IF;
 receipt=p_manifest->'receipt';
 IF(SELECT count(*) FROM jsonb_object_keys(receipt))<>4 OR receipt->>'sourceFingerprint' IS DISTINCT FROM p_source OR(SELECT count(*) FROM jsonb_object_keys(p_manifest->'etags'))<>3 THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_RETENTION_MISMATCH' USING ERRCODE='23514';END IF;
 FOREACH kind IN ARRAY ARRAY['document','audit','properties'] LOOP
  a=receipt->kind;
  IF a IS NULL OR jsonb_typeof(a) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(a))<>3 OR a->>'sha256' IS NULL OR a->>'sha256'!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(a->'sizeBytes') IS DISTINCT FROM 'number' OR(a->>'sizeBytes')::numeric NOT BETWEEN 1 AND(CASE WHEN kind='properties' THEN 1048576 ELSE 10485760 END)
  OR trunc((a->>'sizeBytes')::numeric)<>(a->>'sizeBytes')::numeric OR(a->>'id')::uuid IS DISTINCT FROM public.signature_evidence_artifact_id(p_academy,p_start,p_source,kind,a->>'sha256')
  OR p_manifest#>>ARRAY['etags',kind] IS NULL OR length(p_manifest#>>ARRAY['etags',kind]) NOT BETWEEN 3 AND 202 OR p_manifest#>>ARRAY['etags',kind]!~'^"[!#-~]+"$'
  THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_RETENTION_MISMATCH' USING ERRCODE='23514';END IF;
 END LOOP;
 IF receipt#>>'{document,sha256}'=receipt#>>'{audit,sha256}' OR(receipt#>>'{properties,sizeBytes}')::integer<>octet_length(p_properties)
 OR receipt#>>'{properties,sha256}' IS DISTINCT FROM encode(sha256(convert_to(p_properties,'UTF8')),'hex') THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_RETENTION_MISMATCH' USING ERRCODE='23514';END IF;
 fp=encode(sha256(convert_to(jsonb_build_array(s,p_manifest,signer_id,to_jsonb(reasons))::text,'UTF8')),'hex');
 new_state=CASE WHEN cardinality(reasons)=0 THEN 'evidence_recorded' ELSE 'review_required' END;
 INSERT INTO public.signature_completion_evidence(academy_id,start_id,source,source_fingerprint,manifest,provider_signer_id,review_reasons,state,evidence_fingerprint)
 VALUES(p_academy,p_start,s,p_source,p_manifest,signer_id,reasons,new_state,fp) ON CONFLICT(academy_id,start_id,evidence_fingerprint) DO NOTHING RETURNING id INTO new_id;
 IF new_id IS NOT NULL THEN RETURN QUERY SELECT new_id,new_state,true;
 ELSE RETURN QUERY SELECT e.id,e.state,false FROM public.signature_completion_evidence e WHERE e.academy_id=p_academy AND e.start_id=p_start AND e.evidence_fingerprint=fp;END IF;
END $$;
ALTER FUNCTION public.record_signature_completion_evidence(uuid,uuid,text,text,jsonb) OWNER TO kavosh_signature_completion_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.record_signature_completion_evidence(uuid,uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_signature_completion_evidence(uuid,uuid,text,text,jsonb) TO kavosh_signature_completion_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 206 $$;

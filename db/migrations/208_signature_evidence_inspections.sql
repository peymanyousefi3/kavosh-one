DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_signature_evidence_worker') THEN CREATE ROLE kavosh_signature_evidence_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_signature_evidence_policy') THEN CREATE ROLE kavosh_signature_evidence_policy NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
END $$;
GRANT kavosh_signature_evidence_policy TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO kavosh_signature_evidence_worker,kavosh_signature_evidence_policy;
CREATE POLICY signature_evidence_source_read ON public.signature_completion_evidence FOR SELECT TO kavosh_signature_evidence_policy USING(true);
GRANT SELECT(academy_id,id,manifest,recorded_at) ON public.signature_completion_evidence TO kavosh_signature_evidence_policy;
GRANT EXECUTE ON FUNCTION public.valid_file_pdf_evidence(jsonb),public.valid_file_scanner_observation(jsonb) TO kavosh_signature_evidence_policy;

-- Reuse the ORIGINAL native geometry/resource validator,without changing or
-- permitting signed receipts in the unsigned-upload/source domain.
CREATE FUNCTION public.valid_signature_evidence_pdf(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE base jsonb;signature jsonb;r jsonb;a bigint;b bigint;c bigint;n bigint;total bigint:=0;k text;BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR j->'policyVersion' IS DISTINCT FROM '2'::jsonb OR j->>'profile' IS DISTINCT FROM 'signed-evidence'
 OR j->'cryptographicValidityVerified' IS DISTINCT FROM 'false'::jsonb THEN RETURN false;END IF;
 base=jsonb_set(j-ARRAY['profile','cryptographicValidityVerified','signatureCount','signatures'],'{policyVersion}','1'::jsonb);
 IF j->>'outcome'='rejected' THEN
  IF j ?| ARRAY['signatureCount','signatures'] THEN RETURN false;END IF;
  IF j->>'reason'=ANY(ARRAY['SIGNATURE_LAYOUT_INVALID','SIGNATURE_LIMIT']) THEN base=jsonb_set(base,'{reason}','"MALFORMED_PDF"'::jsonb);END IF;
  RETURN public.valid_file_pdf_evidence(base);
 END IF;
 IF NOT public.valid_file_pdf_evidence(base) OR base->>'outcome' IS DISTINCT FROM 'screened' OR jsonb_typeof(j->'signatureCount') IS DISTINCT FROM 'number'
 OR j->>'signatureCount'!~'^[0-9]{1,3}$' OR(j->>'signatureCount')::integer>100 OR jsonb_typeof(j->'signatures') IS DISTINCT FROM 'array'
 OR jsonb_array_length(j->'signatures')<>(j->>'signatureCount')::integer THEN RETURN false;END IF;
 FOR signature IN SELECT value FROM jsonb_array_elements(j->'signatures') LOOP
  IF jsonb_typeof(signature) IS DISTINCT FROM 'object' OR NOT(signature ?& ARRAY['byteRange','contentsBytes','coversWholeFile']) OR signature-ARRAY['byteRange','contentsBytes','coversWholeFile']<>'{}'::jsonb
  OR jsonb_typeof(signature->'contentsBytes') IS DISTINCT FROM 'number' OR signature->>'contentsBytes'!~'^[1-9][0-9]{0,7}$' OR(signature->>'contentsBytes')::bigint>10485760
  OR jsonb_typeof(signature->'coversWholeFile') IS DISTINCT FROM 'boolean' OR jsonb_typeof(signature->'byteRange') IS DISTINCT FROM 'array' OR jsonb_array_length(signature->'byteRange')<>4 THEN RETURN false;END IF;
  r=signature->'byteRange';FOR n IN 0..3 LOOP IF jsonb_typeof(r->n::integer) IS DISTINCT FROM 'number' OR r->>n::integer!~'^[0-9]{1,8}$' OR(r->>n::integer)::bigint>10485760 THEN RETURN false;END IF;END LOOP;
  a=(r->>1)::bigint;b=(r->>2)::bigint;c=(r->>3)::bigint;n=(signature->>'contentsBytes')::bigint;
  IF r->0 IS DISTINCT FROM '0'::jsonb OR a<1 OR b-a<3 OR n>ceil((b-a-2)::numeric/2) OR b+c>(j->>'inputBytes')::bigint
  OR(signature->>'coversWholeFile')::boolean IS DISTINCT FROM(b+c=(j->>'inputBytes')::bigint) THEN RETURN false;END IF;
  total=total+n;IF total>(j->>'inputBytes')::bigint THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.valid_signature_evidence_pdf(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_signature_evidence_pdf(jsonb) TO kavosh_signature_evidence_policy;
CREATE FUNCTION public.signature_evidence_inspection_source(p_academy uuid,p_evidence uuid,p_kind text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH selected AS(SELECT jsonb_build_object('academyId',e.academy_id,'evidenceId',e.id,'kind',p_kind,'artifactId',e.manifest#>>ARRAY['receipt',p_kind,'id'],
 'storageTargetId',e.manifest->>'storageTargetId','bytes',(e.manifest#>>ARRAY['receipt',p_kind,'sizeBytes'])::integer,'sha256',e.manifest#>>ARRAY['receipt',p_kind,'sha256'],'etag',e.manifest#>>ARRAY['etags',p_kind]) source
 FROM public.signature_completion_evidence e WHERE e.academy_id=p_academy AND e.id=p_evidence AND p_kind IN('document','audit'))
 SELECT source||jsonb_build_object('sourceFingerprint',encode(sha256(convert_to(source::text,'UTF8')),'hex')) FROM selected
$$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.signature_evidence_inspection_source(uuid,uuid,text) OWNER TO kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.signature_evidence_inspection_source(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_evidence_inspection_source(uuid,uuid,text),public.schema_revision() TO kavosh_signature_evidence_worker;
CREATE TABLE public.signature_evidence_inspections(
 academy_id uuid NOT NULL,id uuid NOT NULL,evidence_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('document','audit')),
 source jsonb NOT NULL,result jsonb NOT NULL,fingerprint text NOT NULL CHECK(fingerprint=encode(sha256(convert_to(jsonb_build_array(source,result)::text,'UTF8')),'hex')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),recorded_by name NOT NULL DEFAULT session_user,
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,evidence_id) REFERENCES public.signature_completion_evidence(academy_id,id),
 CHECK(source->>'academyId' IS NOT DISTINCT FROM academy_id::text AND source->>'evidenceId' IS NOT DISTINCT FROM evidence_id::text AND source->>'kind' IS NOT DISTINCT FROM kind)
);
CREATE INDEX signature_evidence_inspection_history ON public.signature_evidence_inspections(academy_id,evidence_id,kind,recorded_at DESC,id DESC);
ALTER TABLE public.signature_evidence_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_evidence_inspections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.signature_evidence_inspections USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY signature_evidence_executor ON public.signature_evidence_inspections TO kavosh_signature_evidence_policy USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.signature_evidence_inspections TO kavosh_signature_evidence_policy;
CREATE POLICY signature_evidence_event_write ON public.outbox_events FOR INSERT TO kavosh_signature_evidence_policy WITH CHECK(true);
GRANT INSERT ON public.outbox_events TO kavosh_signature_evidence_policy;
CREATE FUNCTION public.guard_signature_evidence_inspection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SIGNATURE_EVIDENCE_INSPECTION_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF current_user<>'kavosh_signature_evidence_policy' THEN RAISE EXCEPTION 'SIGNATURE_EVIDENCE_WORKER_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.recorded_at=clock_timestamp();NEW.recorded_by=session_user;RETURN NEW;
END $$;
CREATE TRIGGER signature_evidence_inspection_guard BEFORE INSERT OR UPDATE OR DELETE ON public.signature_evidence_inspections FOR EACH ROW EXECUTE FUNCTION public.guard_signature_evidence_inspection();
REVOKE ALL ON FUNCTION public.guard_signature_evidence_inspection() FROM PUBLIC;
CREATE FUNCTION public.signature_evidence_inspection_recorded(p_academy uuid,p_id uuid,p_evidence uuid,p_kind text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE item record;BEGIN
 SELECT evidence_id,kind INTO item FROM public.signature_evidence_inspections WHERE academy_id=p_academy AND id=p_id;
 IF NOT FOUND THEN RETURN false;END IF;
 IF item.evidence_id IS DISTINCT FROM p_evidence OR item.kind IS DISTINCT FROM p_kind THEN RAISE EXCEPTION 'SIGNATURE_EVIDENCE_INSPECTION_REPLAY_CHANGED' USING ERRCODE='23514';END IF;RETURN true;
END $$;
ALTER FUNCTION public.signature_evidence_inspection_recorded(uuid,uuid,uuid,text) OWNER TO kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.signature_evidence_inspection_recorded(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_evidence_inspection_recorded(uuid,uuid,uuid,text) TO kavosh_signature_evidence_worker;
CREATE FUNCTION public.record_signature_evidence_inspection(p_academy uuid,p_id uuid,p_evidence uuid,p_kind text,p_source text,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE source jsonb;fp text;old_fp text;outcome text;keys text[];observed timestamptz;first_observed timestamptz;created timestamptz;BEGIN
 IF p_id IS NULL THEN RAISE EXCEPTION 'INVALID_SIGNATURE_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
 source=public.signature_evidence_inspection_source(p_academy,p_evidence,p_kind);
 IF source IS NULL OR p_source IS NULL OR source->>'sourceFingerprint' IS DISTINCT FROM p_source THEN RAISE EXCEPTION 'SIGNATURE_EVIDENCE_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR octet_length(p_result::text)>1055000 OR NOT(p_result ?& ARRAY['outcome','safeToServe','admissionCleared','cryptographicValidityVerified'])
 OR p_result->'safeToServe' IS DISTINCT FROM 'false'::jsonb OR p_result->'admissionCleared' IS DISTINCT FROM 'false'::jsonb OR p_result->'cryptographicValidityVerified' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'INVALID_SIGNATURE_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
 fp=encode(sha256(convert_to(jsonb_build_array(source,p_result)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||':signature-evidence-inspection:'||p_id::text,0));
 SELECT fingerprint INTO old_fp FROM public.signature_evidence_inspections WHERE academy_id=p_academy AND id=p_id;
 IF FOUND THEN IF old_fp IS DISTINCT FROM fp THEN RAISE EXCEPTION 'SIGNATURE_EVIDENCE_INSPECTION_REPLAY_CHANGED' USING ERRCODE='23514';END IF;RETURN false;END IF;
 outcome=p_result->>'outcome';keys=ARRAY['outcome','safeToServe','admissionCleared','cryptographicValidityVerified'];
 IF outcome IN('screened','rejected','detected') THEN
  keys=keys||ARRAY['bytes','sha256','etag'];
  IF p_result->'bytes' IS DISTINCT FROM source->'bytes' OR p_result->'sha256' IS DISTINCT FROM source->'sha256' OR p_result->'etag' IS DISTINCT FROM source->'etag' THEN RAISE EXCEPTION 'INVALID_SIGNATURE_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
  IF outcome<>'detected' THEN
   keys=keys||ARRAY['databaseObservation','pdfValidation'];
   IF NOT coalesce(public.valid_file_scanner_observation(p_result->'databaseObservation'),false) OR NOT coalesce(public.valid_signature_evidence_pdf(p_result->'pdfValidation'),false)
   OR p_result#>>'{pdfValidation,outcome}' IS DISTINCT FROM outcome OR p_result#>'{pdfValidation,inputBytes}' IS DISTINCT FROM source->'bytes' OR p_result#>>'{pdfValidation,inputSha256}' IS DISTINCT FROM source->>'sha256' THEN RAISE EXCEPTION 'INVALID_SIGNATURE_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
   first_observed=(p_result#>>'{databaseObservation,observedBeforeAt}')::timestamptz;observed=(p_result#>>'{databaseObservation,observedAt}')::timestamptz;
   SELECT recorded_at INTO created FROM public.signature_completion_evidence WHERE academy_id=p_academy AND id=p_evidence;
   IF first_observed<created-interval '5 seconds' OR observed<clock_timestamp()-interval '5 minutes' OR observed>clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'INVALID_SIGNATURE_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF outcome='unavailable' THEN
  keys=array_append(keys,'reason');IF p_result->>'reason' IS NULL OR p_result->>'reason'<>ALL(ARRAY['INTERRUPTED','TIMEOUT','SCANNER_UNAVAILABLE','PDF_SERVICE_UNAVAILABLE','STORAGE_UNAVAILABLE']) THEN RAISE EXCEPTION 'INVALID_SIGNATURE_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
 ELSIF outcome IS DISTINCT FROM 'content_mismatch' THEN RAISE EXCEPTION 'INVALID_SIGNATURE_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
 IF NOT(p_result ?& keys) OR p_result-keys<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_SIGNATURE_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
 INSERT INTO public.signature_evidence_inspections(academy_id,id,evidence_id,kind,source,result,fingerprint) VALUES(p_academy,p_id,p_evidence,p_kind,source,p_result,fp);
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),CASE WHEN outcome='screened' THEN 'signature.evidence.inspection.recorded' ELSE 'signature.evidence.inspection.critical' END,p_evidence,p_id);
 RETURN true;
END $$;
ALTER FUNCTION public.record_signature_evidence_inspection(uuid,uuid,uuid,text,text,jsonb) OWNER TO kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.record_signature_evidence_inspection(uuid,uuid,uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_signature_evidence_inspection(uuid,uuid,uuid,text,text,jsonb) TO kavosh_signature_evidence_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 208 $$;

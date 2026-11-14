-- Reuse the isolated scanner/parser role and original signed-PDF validator.
-- Work evidence remains separate from enrollment and unsigned upload clearance.
CREATE POLICY work_evidence_source_read ON public.work_signature_completion_evidence FOR SELECT TO kavosh_signature_evidence_policy USING(true);
GRANT SELECT(academy_id,id,manifest,recorded_at) ON public.work_signature_completion_evidence TO kavosh_signature_evidence_policy;
CREATE FUNCTION public.work_signature_evidence_inspection_source(p_academy uuid,p_evidence uuid,p_kind text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH selected AS(SELECT jsonb_build_object('purpose','worker_services','academyId',e.academy_id,'evidenceId',e.id,'kind',p_kind,'artifactId',e.manifest#>>ARRAY['receipt',p_kind,'id'],
 'storageTargetId',e.manifest->>'storageTargetId','bytes',(e.manifest#>>ARRAY['receipt',p_kind,'sizeBytes'])::integer,'sha256',e.manifest#>>ARRAY['receipt',p_kind,'sha256'],'etag',e.manifest#>>ARRAY['etags',p_kind]) source
 FROM public.work_signature_completion_evidence e WHERE e.academy_id=p_academy AND e.id=p_evidence AND p_kind IN('document','audit'))
 SELECT source||jsonb_build_object('sourceFingerprint',encode(sha256(convert_to(source::text,'UTF8')),'hex')) FROM selected
$$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.work_signature_evidence_inspection_source(uuid,uuid,text) OWNER TO kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.work_signature_evidence_inspection_source(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_evidence_inspection_source(uuid,uuid,text) TO kavosh_signature_evidence_worker;
CREATE TABLE public.work_signature_evidence_inspections(
 academy_id uuid NOT NULL,id uuid NOT NULL,evidence_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('document','audit')),
 source jsonb NOT NULL,result jsonb NOT NULL,fingerprint text NOT NULL CHECK(fingerprint=encode(sha256(convert_to(jsonb_build_array(source,result)::text,'UTF8')),'hex')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),recorded_by name NOT NULL DEFAULT session_user,
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,evidence_id) REFERENCES public.work_signature_completion_evidence(academy_id,id),
 CHECK(source->>'purpose' IS NOT DISTINCT FROM 'worker_services' AND source->>'academyId' IS NOT DISTINCT FROM academy_id::text AND source->>'evidenceId' IS NOT DISTINCT FROM evidence_id::text AND source->>'kind' IS NOT DISTINCT FROM kind)
);
CREATE INDEX work_evidence_inspection_history ON public.work_signature_evidence_inspections(academy_id,evidence_id,kind,recorded_at DESC,id DESC);
CREATE INDEX work_evidence_detected_artifact ON public.work_signature_evidence_inspections(academy_id,(source->>'storageTargetId'),(source->>'artifactId')) WHERE result->>'outcome'='detected';
ALTER TABLE public.work_signature_evidence_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_signature_evidence_inspections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.work_signature_evidence_inspections USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY work_evidence_executor ON public.work_signature_evidence_inspections TO kavosh_signature_evidence_policy USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.work_signature_evidence_inspections TO kavosh_signature_evidence_policy;
CREATE TRIGGER work_evidence_inspection_guard BEFORE INSERT OR UPDATE OR DELETE ON public.work_signature_evidence_inspections FOR EACH ROW EXECUTE FUNCTION public.guard_signature_evidence_inspection();
CREATE FUNCTION public.work_signature_evidence_inspection_recorded(p_academy uuid,p_id uuid,p_evidence uuid,p_kind text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE item record;BEGIN
 SELECT evidence_id,kind INTO item FROM public.work_signature_evidence_inspections WHERE academy_id=p_academy AND id=p_id;
 IF NOT FOUND THEN RETURN false;END IF;
 IF item.evidence_id IS DISTINCT FROM p_evidence OR item.kind IS DISTINCT FROM p_kind THEN RAISE EXCEPTION 'WORK_EVIDENCE_INSPECTION_REPLAY_CHANGED' USING ERRCODE='23514';END IF;RETURN true;
END $$;
ALTER FUNCTION public.work_signature_evidence_inspection_recorded(uuid,uuid,uuid,text) OWNER TO kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.work_signature_evidence_inspection_recorded(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_evidence_inspection_recorded(uuid,uuid,uuid,text) TO kavosh_signature_evidence_worker;
CREATE FUNCTION public.record_work_signature_evidence_inspection(p_academy uuid,p_id uuid,p_evidence uuid,p_kind text,p_source text,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE source jsonb;fp text;old_fp text;outcome text;keys text[];observed timestamptz;first_observed timestamptz;created timestamptz;written integer;BEGIN
 IF p_id IS NULL THEN RAISE EXCEPTION 'INVALID_WORK_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
 source=public.work_signature_evidence_inspection_source(p_academy,p_evidence,p_kind);
 IF source IS NULL OR p_source IS NULL OR source->>'sourceFingerprint' IS DISTINCT FROM p_source THEN RAISE EXCEPTION 'WORK_EVIDENCE_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 -- Actual private object identity is shared with guarded serving;purpose is
 -- bound by native task/table/FK,not by caller-supplied classification.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||':signature-evidence-artifact:'||(source->>'storageTargetId')||':'||(source->>'artifactId'),48));
 IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR octet_length(p_result::text)>1055000 OR NOT(p_result ?& ARRAY['outcome','safeToServe','admissionCleared','cryptographicValidityVerified']) OR p_result->'safeToServe' IS DISTINCT FROM 'false'::jsonb OR p_result->'admissionCleared' IS DISTINCT FROM 'false'::jsonb OR p_result->'cryptographicValidityVerified' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'INVALID_WORK_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
 fp=encode(sha256(convert_to(jsonb_build_array(source,p_result)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||':work-signature-evidence-inspection:'||p_id::text,0));
 SELECT fingerprint INTO old_fp FROM public.work_signature_evidence_inspections WHERE academy_id=p_academy AND id=p_id;
 IF FOUND THEN IF old_fp IS DISTINCT FROM fp THEN RAISE EXCEPTION 'WORK_EVIDENCE_INSPECTION_REPLAY_CHANGED' USING ERRCODE='23514';END IF;RETURN false;END IF;
 outcome=p_result->>'outcome';keys=ARRAY['outcome','safeToServe','admissionCleared','cryptographicValidityVerified'];
 IF outcome IN('screened','rejected','detected') THEN
  keys=keys||ARRAY['bytes','sha256','etag'];
  IF p_result->'bytes' IS DISTINCT FROM source->'bytes' OR p_result->'sha256' IS DISTINCT FROM source->'sha256' OR p_result->'etag' IS DISTINCT FROM source->'etag' THEN RAISE EXCEPTION 'INVALID_WORK_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
  IF outcome<>'detected' THEN
   keys=keys||ARRAY['databaseObservation','pdfValidation'];
   IF NOT coalesce(public.valid_file_scanner_observation(p_result->'databaseObservation'),false) OR NOT coalesce(public.valid_signature_evidence_pdf(p_result->'pdfValidation'),false) OR p_result#>>'{pdfValidation,outcome}' IS DISTINCT FROM outcome OR p_result#>'{pdfValidation,inputBytes}' IS DISTINCT FROM source->'bytes' OR p_result#>>'{pdfValidation,inputSha256}' IS DISTINCT FROM source->>'sha256' THEN RAISE EXCEPTION 'INVALID_WORK_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
   first_observed=(p_result#>>'{databaseObservation,observedBeforeAt}')::timestamptz;observed=(p_result#>>'{databaseObservation,observedAt}')::timestamptz;
   SELECT recorded_at INTO created FROM public.work_signature_completion_evidence WHERE academy_id=p_academy AND id=p_evidence;
   IF first_observed<created-interval '5 seconds' OR observed<clock_timestamp()-interval '5 minutes' OR observed>clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'INVALID_WORK_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF outcome='unavailable' THEN
  keys=array_append(keys,'reason');IF p_result->>'reason' IS NULL OR p_result->>'reason'<>ALL(ARRAY['INTERRUPTED','TIMEOUT','SCANNER_UNAVAILABLE','PDF_SERVICE_UNAVAILABLE','STORAGE_UNAVAILABLE']) THEN RAISE EXCEPTION 'INVALID_WORK_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
 ELSIF outcome IS DISTINCT FROM 'content_mismatch' THEN RAISE EXCEPTION 'INVALID_WORK_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
 IF NOT(p_result ?& keys) OR p_result-keys<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_WORK_EVIDENCE_INSPECTION' USING ERRCODE='23514';END IF;
 INSERT INTO public.work_signature_evidence_inspections(academy_id,id,evidence_id,kind,source,result,fingerprint) VALUES(p_academy,p_id,p_evidence,p_kind,source,p_result,fp);
 GET DIAGNOSTICS written=ROW_COUNT;IF written<>1 THEN RAISE EXCEPTION 'WORK_EVIDENCE_RECORD_REQUIRED' USING ERRCODE='55000';END IF;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),CASE WHEN outcome='screened' THEN 'work.signature.evidence.inspection.recorded' ELSE 'work.signature.evidence.inspection.critical' END,p_evidence,p_id);
 GET DIAGNOSTICS written=ROW_COUNT;IF written<>1 THEN RAISE EXCEPTION 'WORK_EVIDENCE_EVENT_REQUIRED' USING ERRCODE='55000';END IF;RETURN true;
END $$;
ALTER FUNCTION public.record_work_signature_evidence_inspection(uuid,uuid,uuid,text,text,jsonb) OWNER TO kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.record_work_signature_evidence_inspection(uuid,uuid,uuid,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_work_signature_evidence_inspection(uuid,uuid,uuid,text,text,jsonb) TO kavosh_signature_evidence_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
-- Same missing-row/event failure must not look successful for existing
-- enrollment inspections either. Preserve its OID,owner,ACL and all checks.
DO $$ DECLARE d text;updated text;row_sql text:='INSERT INTO public.signature_evidence_inspections(academy_id,id,evidence_id,kind,source,result,fingerprint) VALUES(p_academy,p_id,p_evidence,p_kind,source,p_result,fp);';BEGIN
 d=pg_get_functiondef('public.record_signature_evidence_inspection(uuid,uuid,uuid,text,text,jsonb)'::regprocedure);
 IF position('created timestamptz;BEGIN' IN d)=0 OR position(row_sql IN d)=0 OR position(E' RETURN true;\nEND' IN d)=0 THEN RAISE EXCEPTION 'SIGNATURE_INSPECTION_DEFINITION_CHANGED';END IF;
 updated=replace(d,'created timestamptz;BEGIN','created timestamptz;written integer;BEGIN');
 updated=replace(updated,row_sql,row_sql||E'\n GET DIAGNOSTICS written=ROW_COUNT;IF written<>1 THEN RAISE EXCEPTION ''SIGNATURE_EVIDENCE_RECORD_REQUIRED'' USING ERRCODE=''55000'';END IF;');
 updated=replace(updated,E' RETURN true;\nEND',E' GET DIAGNOSTICS written=ROW_COUNT;IF written<>1 THEN RAISE EXCEPTION ''SIGNATURE_EVIDENCE_EVENT_REQUIRED'' USING ERRCODE=''55000'';END IF;RETURN true;\nEND');
 EXECUTE updated;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 227 $$;

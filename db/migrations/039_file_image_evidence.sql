-- Full-pixel decoder receipts remain distinct from signature screening,
-- approved/fresh malware scans, disarmed derivatives and download permission.
CREATE FUNCTION public.valid_file_image_evidence(j jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE k text; n numeric; extra text[]; resources jsonb;
BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR j->>'validator' IS DISTINCT FROM 'sharp@0.35.5'
  OR j->>'libvips' IS DISTINCT FROM '8.18.7' THEN RETURN false; END IF;
 IF j->>'outcome'='decoded' THEN extra:=ARRAY['mime','width','height','frames','channels','decodedBytes','decodedSha256'];
 ELSIF j->>'outcome'='rejected' THEN extra:=ARRAY['reason'];ELSE RETURN false;END IF;
 extra:=extra||ARRAY['validator','libvips','outcome','inputBytes','inputSha256','maximumPixels','maximumFrames','resources'];
 IF NOT(j ?& extra) OR (j-extra)<>'{}'::jsonb THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['inputSha256','decodedSha256'] LOOP
  IF k='decodedSha256' AND j->>'outcome'='rejected' THEN CONTINUE;END IF;
  IF jsonb_typeof(j->k) IS DISTINCT FROM 'string' OR j->>k !~ '^[a-f0-9]{64}$' THEN RETURN false;END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['inputBytes','maximumPixels','maximumFrames','width','height','frames','channels','decodedBytes'] LOOP
  IF k=ANY(ARRAY['width','height','frames','channels','decodedBytes']) AND j->>'outcome'='rejected' THEN CONTINUE;END IF;
  IF jsonb_typeof(j->k) IS DISTINCT FROM 'number' OR j->>k !~ '^[0-9]{1,9}$' THEN RETURN false;END IF;
  n:=(j->>k)::numeric;
  IF n<1 OR n>(CASE WHEN k='inputBytes' THEN 33554432 WHEN k IN ('maximumFrames','frames') THEN 256
   WHEN k='channels' THEN 4 WHEN k='decodedBytes' THEN 256000000 ELSE 64000000 END) THEN RETURN false;END IF;
 END LOOP;
 resources:=j->'resources';
 IF jsonb_typeof(resources) IS DISTINCT FROM 'object' OR NOT(resources ?& ARRAY['peakRssKiB','userCpuMicros','systemCpuMicros'])
  OR(resources-ARRAY['peakRssKiB','userCpuMicros','systemCpuMicros'])<>'{}'::jsonb THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['peakRssKiB','userCpuMicros','systemCpuMicros'] LOOP
  IF jsonb_typeof(resources->k) IS DISTINCT FROM 'number' OR resources->>k !~ '^[0-9]{1,16}$' THEN RETURN false;END IF;
  n:=(resources->>k)::numeric;
  IF n<(CASE WHEN k='peakRssKiB' THEN 1 ELSE 0 END) OR n>9007199254740991 THEN RETURN false;END IF;
 END LOOP;
 IF j->>'outcome'='rejected' THEN
  RETURN coalesce(j->>'reason'=ANY(ARRAY['UNSUPPORTED_FORMAT','MIME_MISMATCH','PIXEL_LIMIT','FRAME_LIMIT','CONTAINER_REJECTED','DECODER_REJECTED']),false);
 END IF;
 RETURN coalesce(j->>'mime'=ANY(ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif'])
  AND(j->>'frames')::numeric<=(j->>'maximumFrames')::numeric
  AND(j->>'width')::numeric*(j->>'height')::numeric*(j->>'frames')::numeric<=(j->>'maximumPixels')::numeric
  AND(j->>'decodedBytes')::numeric=(j->>'width')::numeric*(j->>'height')::numeric*(j->>'frames')::numeric*(j->>'channels')::numeric
  AND(j->>'mime'<>'image/avif' OR(j->>'frames')::numeric=1),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.valid_file_image_evidence(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_file_image_evidence(jsonb) TO kavosh_file_policy;

ALTER TABLE public.file_inspection_attempts ADD CONSTRAINT file_attempt_content_identity
 UNIQUE(academy_id,inspection_id,attempt_no,measured_bytes,sha256);
CREATE TABLE public.file_image_evidence(
 academy_id uuid NOT NULL,inspection_id uuid NOT NULL,attempt_no integer NOT NULL,
 input_bytes bigint NOT NULL,input_sha256 text NOT NULL,result jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,inspection_id,attempt_no),
 FOREIGN KEY(academy_id,inspection_id,attempt_no,input_bytes,input_sha256)
  REFERENCES public.file_inspection_attempts(academy_id,inspection_id,attempt_no,measured_bytes,sha256),
 CHECK(public.valid_file_image_evidence(result)),
 CHECK(input_bytes=(result->>'inputBytes')::bigint AND input_sha256=result->>'inputSha256')
);
ALTER TABLE public.file_image_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_image_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.file_image_evidence
 USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid)
 WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY file_policy_executor ON public.file_image_evidence TO kavosh_file_policy USING(true) WITH CHECK(true);
GRANT SELECT ON public.file_image_evidence TO kavosh_runtime;
GRANT SELECT,INSERT ON public.file_image_evidence TO kavosh_file_policy;

ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) RENAME TO finish_file_inspection_format_evidence;
REVOKE EXECUTE ON FUNCTION public.finish_file_inspection_format_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) FROM kavosh_file_worker;
GRANT CREATE ON SCHEMA public TO kavosh_file_policy;
CREATE FUNCTION public.finish_file_inspection(p_academy uuid,p_inspection uuid,p_lease uuid,p_outcome text,p_reason text,p_bytes bigint,p_sha256 text,p_etag text,p_content_type text,p_signature jsonb,p_image jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE recorded boolean; attempt integer; claimed text; file_id uuid;
BEGIN
 recorded:=public.finish_file_inspection_format_evidence(p_academy,p_inspection,p_lease,p_outcome,p_reason,p_bytes,p_sha256,p_etag,p_content_type,p_signature);
 IF recorded IS FALSE THEN RETURN false;END IF;
 IF recorded IS DISTINCT FROM true THEN RAISE EXCEPTION 'MISSING_FILE_INSPECTION_RECEIPT';END IF;
 IF p_image IS NULL THEN RETURN true;END IF;
 IF p_outcome IS DISTINCT FROM 'no_detection' OR NOT public.valid_file_image_evidence(p_image)
  OR(p_image->>'inputBytes')::bigint IS DISTINCT FROM p_bytes OR p_image->>'inputSha256' IS DISTINCT FROM p_sha256 THEN
  RAISE EXCEPTION 'INVALID_FILE_IMAGE_EVIDENCE';END IF;
 SELECT q.attempt_no INTO STRICT attempt FROM public.file_inspection_jobs q WHERE q.academy_id=p_academy AND q.inspection_id=p_inspection;
 SELECT revision.definition->>'claimed_mime_type',r.file_id INTO STRICT claimed,file_id
  FROM public.file_inspection_requests r JOIN public.file_record_revisions revision
   ON revision.academy_id=r.academy_id AND revision.file_id=r.file_id AND revision.version=r.metadata_version
  WHERE r.academy_id=p_academy AND r.id=p_inspection;
 IF claimed IS NULL OR NOT(claimed=ANY(ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']))
  OR(p_image->>'outcome'='decoded' AND(p_image->>'mime' IS DISTINCT FROM claimed OR p_signature->>'mime' IS DISTINCT FROM claimed)) THEN
  RAISE EXCEPTION 'INVALID_FILE_IMAGE_EVIDENCE';END IF;
 INSERT INTO public.file_image_evidence(academy_id,inspection_id,attempt_no,input_bytes,input_sha256,result)
 VALUES(p_academy,p_inspection,attempt,p_bytes,p_sha256,p_image);
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id)
 VALUES(p_academy,gen_random_uuid(),CASE p_image->>'outcome' WHEN 'decoded' THEN 'file.image.decoded' ELSE 'file.image.rejected.critical' END,file_id,p_inspection);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb) FROM PUBLIC;
ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb) TO kavosh_file_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_file_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 39 $$;

-- Whole-clip decoder observations bind the same measured scanner attempt.
-- They grant no copy,download,playback,public publication or malware clearance.
CREATE FUNCTION public.valid_file_video_evidence(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE keys text[];k text;limit_value numeric;r jsonb;a jsonb;w numeric;h numeric;frames numeric;
BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR octet_length(j::text)>16384 OR j->'validator' IS DISTINCT FROM '"ffmpeg@9.0.2"'::jsonb OR j->'policyVersion' IS DISTINCT FROM '1'::jsonb
 OR j->'maximumInputBytes' IS DISTINCT FROM '134217728'::jsonb OR j->'maximumDurationSeconds' IS DISTINCT FROM '300'::jsonb OR j->'maximumVideoFrames' IS DISTINCT FROM '18000'::jsonb OR j->'maximumVideoPixels' IS DISTINCT FROM '12000000000'::jsonb THEN RETURN false;END IF;
 keys=ARRAY['validator','policyVersion','inputBytes','inputSha256','maximumInputBytes','maximumDurationSeconds','maximumVideoFrames','maximumVideoPixels','resources','outcome'];
 IF j->>'outcome'='decoded' THEN keys=keys||ARRAY['mime','container','codec','width','height','durationMs','videoFrames','audioFrames','audio','decodedBytes','frameHashSha256'];
 ELSIF j->>'outcome'='rejected' THEN keys=keys||ARRAY['reason','stage'];IF j ? 'nativeExitCode' THEN keys=keys||ARRAY['nativeExitCode'];END IF;ELSE RETURN false;END IF;
 IF NOT(j ?& keys) OR j-keys<>'{}'::jsonb OR jsonb_typeof(j->'inputSha256') IS DISTINCT FROM 'string' OR j->>'inputSha256'!~'^[a-f0-9]{64}$' OR jsonb_typeof(j->'inputBytes') IS DISTINCT FROM 'number' OR j->>'inputBytes'!~'^[1-9][0-9]{0,8}$' OR(j->>'inputBytes')::numeric>134217728 THEN RETURN false;END IF;
 r=j->'resources';IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT(r ?& ARRAY['peakRssKiB','userCpuMicros','systemCpuMicros']) OR r-ARRAY['peakRssKiB','userCpuMicros','systemCpuMicros']<>'{}'::jsonb THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['peakRssKiB','userCpuMicros','systemCpuMicros'] LOOP IF jsonb_typeof(r->k) IS DISTINCT FROM 'number' OR r->>k!~'^[0-9]{1,16}$' OR(r->>k)::numeric>9007199254740991 OR(r->>k)::numeric<(CASE WHEN k='peakRssKiB' THEN 1 ELSE 0 END) THEN RETURN false;END IF;END LOOP;
 IF j->>'outcome'='rejected' THEN
  IF jsonb_typeof(j->'reason') IS DISTINCT FROM 'string' OR NOT(j->>'reason'=ANY(ARRAY['RESOURCE_LIMIT','STREAM_POLICY','METADATA_REJECTED','DECODER_REJECTED'])) OR jsonb_typeof(j->'stage') IS DISTINCT FROM 'string' OR NOT(j->>'stage'=ANY(ARRAY['runtime','probe','stream_policy','decode','frame_evidence'])) THEN RETURN false;END IF;
  IF j ? 'nativeExitCode' THEN IF j->>'reason'<>'DECODER_REJECTED' OR jsonb_typeof(j->'nativeExitCode') IS DISTINCT FROM 'number' OR j->>'nativeExitCode'!~'^-?[1-9][0-9]{0,2}$' OR abs((j->>'nativeExitCode')::numeric)>255 THEN RETURN false;END IF;END IF;RETURN true;
 END IF;
 IF jsonb_typeof(j->'mime') IS DISTINCT FROM 'string' OR NOT(j->>'mime'=ANY(ARRAY['video/mp4','video/quicktime','video/webm'])) OR jsonb_typeof(j->'container') IS DISTINCT FROM 'string' OR j->>'container' IS DISTINCT FROM(CASE WHEN j->>'mime'='video/webm' THEN 'matroska' ELSE 'mov' END)
 OR jsonb_typeof(j->'codec') IS DISTINCT FROM 'string' OR NOT(j->>'codec'=ANY(ARRAY['h264','hevc','mpeg4','vp8','vp9','av1'])) OR jsonb_typeof(j->'frameHashSha256') IS DISTINCT FROM 'string' OR j->>'frameHashSha256'!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['width','height','durationMs','videoFrames','audioFrames','decodedBytes'] LOOP
  limit_value=CASE k WHEN 'width' THEN 3840 WHEN 'height' THEN 3840 WHEN 'durationMs' THEN 300000 WHEN 'videoFrames' THEN 18000 WHEN 'audioFrames' THEN 100000 ELSE 24000000000 END;
  IF jsonb_typeof(j->k) IS DISTINCT FROM 'number' OR j->>k!~'^[0-9]{1,11}$' OR(j->>k)::numeric>limit_value OR(j->>k)::numeric<(CASE WHEN k='audioFrames' THEN 0 ELSE 1 END) THEN RETURN false;END IF;
 END LOOP;
 w=(j->>'width')::numeric;h=(j->>'height')::numeric;frames=(j->>'videoFrames')::numeric;
 IF w*h>8294400 OR w*h*frames>12000000000 OR(j->>'decodedBytes')::numeric<frames*(w*h+2*ceil(w/2)*ceil(h/2)) THEN RETURN false;END IF;
 a=j->'audio';IF a='null'::jsonb THEN RETURN j->'audioFrames'='0'::jsonb;END IF;
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['codec','channels','sampleRate']) OR a-ARRAY['codec','channels','sampleRate']<>'{}'::jsonb OR jsonb_typeof(a->'codec') IS DISTINCT FROM 'string' OR NOT(a->>'codec'=ANY(ARRAY['aac','opus','vorbis','pcm_s16le'])) OR NOT(a->'channels'=ANY(ARRAY['1'::jsonb,'2'::jsonb])) OR jsonb_typeof(a->'sampleRate') IS DISTINCT FROM 'number' OR a->>'sampleRate'!~'^[0-9]{4,6}$' OR(a->>'sampleRate')::integer NOT BETWEEN 8000 AND 192000 OR(j->>'audioFrames')::integer<1 THEN RETURN false;END IF;RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.valid_file_video_evidence(jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.valid_file_video_evidence(jsonb) TO kavosh_file_policy;
CREATE TABLE public.file_video_evidence(
 academy_id uuid NOT NULL,inspection_id uuid NOT NULL,attempt_no integer NOT NULL,input_bytes bigint NOT NULL,input_sha256 text NOT NULL,result jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,inspection_id,attempt_no),FOREIGN KEY(academy_id,inspection_id,attempt_no,input_bytes,input_sha256) REFERENCES public.file_inspection_attempts(academy_id,inspection_id,attempt_no,measured_bytes,sha256),
 CHECK(public.valid_file_video_evidence(result)),CHECK(input_bytes=(result->>'inputBytes')::bigint AND input_sha256=result->>'inputSha256')
);
ALTER TABLE public.file_video_evidence ENABLE ROW LEVEL SECURITY;ALTER TABLE public.file_video_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.file_video_evidence USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY file_policy_executor ON public.file_video_evidence TO kavosh_file_policy USING(true) WITH CHECK(true);
GRANT SELECT ON public.file_video_evidence TO kavosh_runtime;GRANT SELECT,INSERT ON public.file_video_evidence TO kavosh_file_policy;
ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb) RENAME TO finish_file_inspection_text_evidence;
REVOKE EXECUTE ON FUNCTION public.finish_file_inspection_text_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb) FROM kavosh_file_worker;
GRANT CREATE ON SCHEMA public TO kavosh_file_policy;
CREATE FUNCTION public.finish_file_inspection(p_academy uuid,p_inspection uuid,p_lease uuid,p_outcome text,p_reason text,p_bytes bigint,p_sha256 text,p_etag text,p_content_type text,p_signature jsonb,p_image jsonb DEFAULT NULL,p_database jsonb DEFAULT NULL,p_pdf jsonb DEFAULT NULL,p_text jsonb DEFAULT NULL,p_video jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE recorded boolean;attempt integer;claimed text;file_id uuid;
BEGIN
 recorded=public.finish_file_inspection_text_evidence(p_academy,p_inspection,p_lease,p_outcome,p_reason,p_bytes,p_sha256,p_etag,p_content_type,p_signature,p_image,p_database,p_pdf,p_text);
 IF recorded IS FALSE THEN RETURN false;END IF;IF recorded IS DISTINCT FROM true THEN RAISE EXCEPTION 'MISSING_FILE_INSPECTION_RECEIPT';END IF;IF p_video IS NULL THEN RETURN true;END IF;
 IF p_outcome IS DISTINCT FROM 'no_detection' OR NOT public.valid_file_video_evidence(p_video) OR(p_video->>'inputBytes')::bigint IS DISTINCT FROM p_bytes OR p_video->>'inputSha256' IS DISTINCT FROM p_sha256 OR p_video->>'stage'='runtime' THEN RAISE EXCEPTION 'INVALID_FILE_VIDEO_EVIDENCE';END IF;
 SELECT q.attempt_no INTO STRICT attempt FROM public.file_inspection_jobs q WHERE q.academy_id=p_academy AND q.inspection_id=p_inspection;
 SELECT r.definition->>'claimed_mime_type',i.file_id INTO STRICT claimed,file_id FROM public.file_inspection_requests i JOIN public.file_record_revisions r ON r.academy_id=i.academy_id AND r.file_id=i.file_id AND r.version=i.metadata_version WHERE i.academy_id=p_academy AND i.id=p_inspection;
 IF claimed IS NULL OR NOT(claimed=ANY(ARRAY['video/mp4','video/quicktime','video/webm'])) OR(p_video->>'outcome'='decoded' AND(p_video->>'mime' IS DISTINCT FROM claimed OR p_signature->>'mime' IS DISTINCT FROM claimed)) THEN RAISE EXCEPTION 'INVALID_FILE_VIDEO_EVIDENCE';END IF;
 INSERT INTO public.file_video_evidence(academy_id,inspection_id,attempt_no,input_bytes,input_sha256,result) VALUES(p_academy,p_inspection,attempt,p_bytes,p_sha256,p_video);
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),CASE p_video->>'outcome' WHEN 'decoded' THEN 'file.video.decoded' ELSE 'file.video.policy_rejected.critical' END,file_id,p_inspection);RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC;
ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) TO kavosh_file_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_file_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 358 $$;

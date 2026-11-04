CREATE TABLE public.file_content_signatures (
 academy_id uuid NOT NULL,inspection_id uuid NOT NULL,attempt_no integer NOT NULL,
 detector text NOT NULL CHECK(detector='file-type@22.3.0'),sample_bytes integer NOT NULL CHECK(sample_bytes BETWEEN 1 AND 16384),
 sample_sha256 text NOT NULL CHECK(sample_sha256 ~ '^[a-f0-9]{64}$'),mime text,extension text,
 PRIMARY KEY(academy_id,inspection_id,attempt_no),
 FOREIGN KEY(academy_id,inspection_id,attempt_no) REFERENCES public.file_inspection_attempts(academy_id,inspection_id,attempt_no),
 CHECK((mime IS NULL AND extension IS NULL) OR(mime IS NOT NULL AND extension IS NOT NULL AND mime ~ '^[a-z0-9][a-z0-9.+-]{0,99}/[a-z0-9][a-z0-9.+-]{0,99}$' AND extension ~ '^[a-z0-9]{1,20}$'))
);
ALTER TABLE public.file_content_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_content_signatures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.file_content_signatures USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY file_policy_executor ON public.file_content_signatures TO kavosh_file_policy USING(true) WITH CHECK(true);
GRANT SELECT ON public.file_content_signatures TO kavosh_runtime;
GRANT INSERT ON public.file_content_signatures TO kavosh_file_policy;

-- Reuse the existing measurement/lease/event transaction. Only the new wrapper
-- is callable by workers; invalid signature evidence rolls back all its writes.
ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text) RENAME TO finish_file_inspection_measurements;
REVOKE EXECUTE ON FUNCTION public.finish_file_inspection_measurements(uuid,uuid,uuid,text,text,bigint,text,text,text) FROM kavosh_file_worker;
GRANT CREATE ON SCHEMA public TO kavosh_file_policy;
CREATE FUNCTION public.finish_file_inspection(p_academy uuid,p_inspection uuid,p_lease uuid,p_outcome text,p_reason text,p_bytes bigint,p_sha256 text,p_etag text,p_content_type text,p_signature jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE recorded boolean; sample_size integer; attempt integer;
BEGIN
 recorded:=public.finish_file_inspection_measurements(p_academy,p_inspection,p_lease,p_outcome,p_reason,p_bytes,p_sha256,p_etag,p_content_type);
 IF NOT recorded THEN RETURN false; END IF;
 IF p_signature IS NOT NULL THEN
  IF p_outcome NOT IN ('no_detection','detected') OR jsonb_typeof(p_signature) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_CONTENT_SIGNATURE'; END IF;
  IF NOT(p_signature ?& ARRAY['detector','sampleBytes','sampleSha256','mime','extension']) OR (p_signature-ARRAY['detector','sampleBytes','sampleSha256','mime','extension'])<>'{}'::jsonb
   OR p_signature->>'detector' IS DISTINCT FROM 'file-type@22.3.0' OR jsonb_typeof(p_signature->'sampleBytes') IS DISTINCT FROM 'number'
   OR p_signature->>'sampleBytes' !~ '^[0-9]{1,5}$' OR jsonb_typeof(p_signature->'sampleSha256') IS DISTINCT FROM 'string' OR p_signature->>'sampleSha256' IS NULL OR p_signature->>'sampleSha256' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_CONTENT_SIGNATURE'; END IF;
  sample_size:=(p_signature->>'sampleBytes')::integer;
  IF sample_size NOT BETWEEN 1 AND 16384 OR sample_size>p_bytes OR(sample_size=p_bytes AND p_signature->>'sampleSha256'<>p_sha256) THEN RAISE EXCEPTION 'INVALID_CONTENT_SIGNATURE'; END IF;
  IF NOT((p_signature->'mime'='null'::jsonb AND p_signature->'extension'='null'::jsonb) OR
   (jsonb_typeof(p_signature->'mime')='string' AND jsonb_typeof(p_signature->'extension')='string' AND p_signature->>'mime' ~ '^[a-z0-9][a-z0-9.+-]{0,99}/[a-z0-9][a-z0-9.+-]{0,99}$' AND p_signature->>'extension' ~ '^[a-z0-9]{1,20}$')) THEN RAISE EXCEPTION 'INVALID_CONTENT_SIGNATURE'; END IF;
  SELECT q.attempt_no INTO attempt FROM public.file_inspection_jobs q WHERE q.academy_id=p_academy AND q.inspection_id=p_inspection;
  INSERT INTO public.file_content_signatures(academy_id,inspection_id,attempt_no,detector,sample_bytes,sample_sha256,mime,extension)
   VALUES(p_academy,p_inspection,attempt,p_signature->>'detector',sample_size,p_signature->>'sampleSha256',p_signature->>'mime',p_signature->>'extension');
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) FROM PUBLIC;
ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) TO kavosh_file_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_file_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 24 $$;

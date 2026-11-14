-- Preserving unsigned-source structural observations,not render/malware/signature
-- clearance. Never fabricate evidence for already inspected historical files.
CREATE FUNCTION public.valid_file_pdf_evidence(j jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE keys text[];k text;n numeric;r jsonb;p jsonb;b jsonb;m numeric[];c numeric[];u numeric;i integer;
BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR octet_length(j::text)>1048576
  OR j->'validator' IS DISTINCT FROM '"pikepdf@10.17.0"'::jsonb OR j->'qpdf' IS DISTINCT FROM '"12.4.2"'::jsonb
  OR j->'policyVersion' IS DISTINCT FROM '1'::jsonb OR j->'maximumPages' IS DISTINCT FROM '1000'::jsonb
  OR j->'maximumObjects' IS DISTINCT FROM '50000'::jsonb OR j->'maximumDepth' IS DISTINCT FROM '64'::jsonb THEN RETURN false;END IF;
 IF j->'outcome'='"screened"'::jsonb THEN keys:=ARRAY['pageCount','objectCount','pages','interactiveForms','coordinateSpace'];
 ELSIF j->'outcome'='"rejected"'::jsonb THEN keys:=ARRAY['reason'];ELSE RETURN false;END IF;
 keys:=keys||ARRAY['validator','qpdf','policyVersion','maximumPages','maximumObjects','maximumDepth','outcome','inputBytes','inputSha256','resources'];
 IF NOT(j ?& keys) OR j-keys<>'{}'::jsonb OR jsonb_typeof(j->'inputSha256') IS DISTINCT FROM 'string' OR j->>'inputSha256'!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(j->'inputBytes') IS DISTINCT FROM 'number' OR j->>'inputBytes'!~'^[1-9][0-9]{0,7}$' OR(j->>'inputBytes')::numeric>10485760 THEN RETURN false;END IF;
 r:=j->'resources';
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT(r ?& ARRAY['peakRssKiB','userCpuMicros','systemCpuMicros'])
  OR r-ARRAY['peakRssKiB','userCpuMicros','systemCpuMicros']<>'{}'::jsonb THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['peakRssKiB','userCpuMicros','systemCpuMicros'] LOOP
  IF jsonb_typeof(r->k) IS DISTINCT FROM 'number' OR r->>k!~'^[0-9]{1,16}$' THEN RETURN false;END IF;
  n:=(r->>k)::numeric;IF n<(CASE WHEN k='peakRssKiB' THEN 1 ELSE 0 END) OR n>9007199254740991 THEN RETURN false;END IF;
 END LOOP;
 IF j->>'outcome'='rejected' THEN
  RETURN jsonb_typeof(j->'reason')='string' AND coalesce(j->>'reason'=ANY(ARRAY['ACTIVE_CONTENT','EMBEDDED_FILE','EXTERNAL_STREAM','XFA_FORM','ENCRYPTED','EXISTING_SIGNATURE','GEOMETRY_INVALID','STRUCTURE_LIMIT','PAGE_LIMIT','MALFORMED_PDF']),false);
 END IF;
 IF j->'coordinateSpace' IS DISTINCT FROM '"pdf-default-user-space"'::jsonb OR jsonb_typeof(j->'interactiveForms') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(j->'pages') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['pageCount','objectCount'] LOOP
  IF jsonb_typeof(j->k) IS DISTINCT FROM 'number' OR j->>k!~'^[1-9][0-9]{0,4}$'
   OR(j->>k)::numeric>(CASE WHEN k='pageCount' THEN 1000 ELSE 50000 END) THEN RETURN false;END IF;
 END LOOP;
 IF jsonb_array_length(j->'pages')<>(j->>'pageCount')::integer THEN RETURN false;END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(j->'pages') LOOP
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& ARRAY['mediaBox','cropBox','rotation','userUnit'])
   OR p-ARRAY['mediaBox','cropBox','rotation','userUnit']<>'{}'::jsonb
   OR jsonb_typeof(p->'rotation') IS DISTINCT FROM 'number' OR NOT(p->'rotation'=ANY(ARRAY['0'::jsonb,'90'::jsonb,'180'::jsonb,'270'::jsonb]))
   OR jsonb_typeof(p->'userUnit') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
  u:=(p->>'userUnit')::numeric;IF u<=0 OR u>75000 THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['mediaBox','cropBox'] LOOP
   b:=p->k;IF jsonb_typeof(b) IS DISTINCT FROM 'array' OR jsonb_array_length(b)<>4 THEN RETURN false;END IF;
   FOR i IN 0..3 LOOP
    IF jsonb_typeof(b->i) IS DISTINCT FROM 'number' OR abs((b->>i)::numeric)>20000 THEN RETURN false;END IF;
   END LOOP;
  END LOOP;
  m:=ARRAY[(p#>>'{mediaBox,0}')::numeric,(p#>>'{mediaBox,1}')::numeric,(p#>>'{mediaBox,2}')::numeric,(p#>>'{mediaBox,3}')::numeric];
  c:=ARRAY[(p#>>'{cropBox,0}')::numeric,(p#>>'{cropBox,1}')::numeric,(p#>>'{cropBox,2}')::numeric,(p#>>'{cropBox,3}')::numeric];
  IF m[1]>=m[3] OR m[2]>=m[4] OR c[1]>=c[3] OR c[2]>=c[4] OR c[1]<m[1] OR c[2]<m[2] OR c[3]>m[3] OR c[4]>m[4]
   OR(m[3]-m[1])*u>20000 OR(m[4]-m[2])*u>20000 THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.valid_file_pdf_evidence(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_file_pdf_evidence(jsonb) TO kavosh_file_policy;

CREATE TABLE public.file_pdf_evidence(
 academy_id uuid NOT NULL,inspection_id uuid NOT NULL,attempt_no integer NOT NULL,
 input_bytes bigint NOT NULL,input_sha256 text NOT NULL,result jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,inspection_id,attempt_no),
 FOREIGN KEY(academy_id,inspection_id,attempt_no,input_bytes,input_sha256)
  REFERENCES public.file_inspection_attempts(academy_id,inspection_id,attempt_no,measured_bytes,sha256),
 CHECK(public.valid_file_pdf_evidence(result)),
 CHECK(input_bytes=(result->>'inputBytes')::bigint AND input_sha256=result->>'inputSha256')
);
ALTER TABLE public.file_pdf_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_pdf_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.file_pdf_evidence
 USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid)
 WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY file_policy_executor ON public.file_pdf_evidence TO kavosh_file_policy USING(true) WITH CHECK(true);
GRANT SELECT ON public.file_pdf_evidence TO kavosh_runtime;
GRANT SELECT,INSERT ON public.file_pdf_evidence TO kavosh_file_policy;

ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb) RENAME TO finish_file_inspection_scanner_evidence;
REVOKE EXECUTE ON FUNCTION public.finish_file_inspection_scanner_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb) FROM kavosh_file_worker;
GRANT CREATE ON SCHEMA public TO kavosh_file_policy;
CREATE FUNCTION public.finish_file_inspection(p_academy uuid,p_inspection uuid,p_lease uuid,p_outcome text,p_reason text,p_bytes bigint,p_sha256 text,p_etag text,p_content_type text,p_signature jsonb,p_image jsonb DEFAULT NULL,p_database jsonb DEFAULT NULL,p_pdf jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE recorded boolean;attempt integer;claimed text;file_id uuid;
BEGIN
 recorded:=public.finish_file_inspection_scanner_evidence(p_academy,p_inspection,p_lease,p_outcome,p_reason,p_bytes,p_sha256,p_etag,p_content_type,p_signature,p_image,p_database);
 IF recorded IS FALSE THEN RETURN false;END IF;
 IF recorded IS DISTINCT FROM true THEN RAISE EXCEPTION 'MISSING_FILE_INSPECTION_RECEIPT';END IF;
 IF p_pdf IS NULL THEN RETURN true;END IF;
 IF p_outcome IS DISTINCT FROM 'no_detection' OR NOT public.valid_file_pdf_evidence(p_pdf)
  OR(p_pdf->>'inputBytes')::bigint IS DISTINCT FROM p_bytes OR p_pdf->>'inputSha256' IS DISTINCT FROM p_sha256 THEN RAISE EXCEPTION 'INVALID_FILE_PDF_EVIDENCE';END IF;
 SELECT q.attempt_no INTO STRICT attempt FROM public.file_inspection_jobs q WHERE q.academy_id=p_academy AND q.inspection_id=p_inspection;
 SELECT revision.definition->>'claimed_mime_type',r.file_id INTO STRICT claimed,file_id
  FROM public.file_inspection_requests r JOIN public.file_record_revisions revision
   ON revision.academy_id=r.academy_id AND revision.file_id=r.file_id AND revision.version=r.metadata_version
  WHERE r.academy_id=p_academy AND r.id=p_inspection;
 IF claimed IS DISTINCT FROM 'application/pdf' OR(p_pdf->>'outcome'='screened' AND p_signature->>'mime' IS DISTINCT FROM 'application/pdf') THEN RAISE EXCEPTION 'INVALID_FILE_PDF_EVIDENCE';END IF;
 INSERT INTO public.file_pdf_evidence(academy_id,inspection_id,attempt_no,input_bytes,input_sha256,result)
 VALUES(p_academy,p_inspection,attempt,p_bytes,p_sha256,p_pdf);
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id)
 VALUES(p_academy,gen_random_uuid(),CASE p_pdf->>'outcome' WHEN 'screened' THEN 'file.pdf.screened' ELSE 'file.pdf.policy_rejected.critical' END,file_id,p_inspection);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC;
ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb) TO kavosh_file_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_file_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 113 $$;

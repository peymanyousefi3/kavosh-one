-- Exact-byte UTF-8 observations,not code execution,preview or malware clearance.
-- Historical inspections/policies remain unchanged;no invented observations.
CREATE FUNCTION public.valid_file_text_evidence(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE keys text[];
BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR octet_length(j::text)>2048 OR j->'validator' IS DISTINCT FROM '"utf8-plain-text@1"'::jsonb OR j->'maximumBytes' IS DISTINCT FROM '1048576'::jsonb THEN RETURN false;END IF;
 keys=ARRAY['validator','maximumBytes','inputBytes','inputSha256','outcome'];
 IF j->>'outcome'='decoded' THEN keys=keys||ARRAY['codePoints'];ELSIF j->>'outcome'='rejected' THEN keys=keys||ARRAY['reason'];ELSE RETURN false;END IF;
 IF NOT(j ?& keys) OR j-keys<>'{}'::jsonb OR jsonb_typeof(j->'inputSha256') IS DISTINCT FROM 'string' OR j->>'inputSha256'!~'^[a-f0-9]{64}$' OR jsonb_typeof(j->'inputBytes') IS DISTINCT FROM 'number' OR j->>'inputBytes'!~'^[1-9][0-9]{0,6}$' OR(j->>'inputBytes')::integer>1048576 THEN RETURN false;END IF;
 IF j->>'outcome'='rejected' THEN RETURN jsonb_typeof(j->'reason')='string' AND coalesce(j->>'reason'=ANY(ARRAY['INVALID_UTF8','CONTROL_CHARACTERS']),false);END IF;
 RETURN jsonb_typeof(j->'codePoints')='number' AND j->>'codePoints'~'^[0-9]{1,7}$' AND(j->>'codePoints')::integer<=(j->>'inputBytes')::integer;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.valid_file_text_evidence(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_file_text_evidence(jsonb) TO kavosh_file_policy;
CREATE TABLE public.file_text_evidence(
 academy_id uuid NOT NULL,inspection_id uuid NOT NULL,attempt_no integer NOT NULL,input_bytes bigint NOT NULL,input_sha256 text NOT NULL,result jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,inspection_id,attempt_no),
 FOREIGN KEY(academy_id,inspection_id,attempt_no,input_bytes,input_sha256) REFERENCES public.file_inspection_attempts(academy_id,inspection_id,attempt_no,measured_bytes,sha256),
 CHECK(public.valid_file_text_evidence(result)),CHECK(input_bytes=(result->>'inputBytes')::bigint AND input_sha256=result->>'inputSha256')
);
ALTER TABLE public.file_text_evidence ENABLE ROW LEVEL SECURITY;ALTER TABLE public.file_text_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.file_text_evidence USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY file_policy_executor ON public.file_text_evidence TO kavosh_file_policy USING(true) WITH CHECK(true);
GRANT SELECT ON public.file_text_evidence TO kavosh_runtime;GRANT SELECT,INSERT ON public.file_text_evidence TO kavosh_file_policy;

ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb) RENAME TO finish_file_inspection_pdf_evidence;
REVOKE EXECUTE ON FUNCTION public.finish_file_inspection_pdf_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb) FROM kavosh_file_worker;
GRANT CREATE ON SCHEMA public TO kavosh_file_policy;
CREATE FUNCTION public.finish_file_inspection(p_academy uuid,p_inspection uuid,p_lease uuid,p_outcome text,p_reason text,p_bytes bigint,p_sha256 text,p_etag text,p_content_type text,p_signature jsonb,p_image jsonb DEFAULT NULL,p_database jsonb DEFAULT NULL,p_pdf jsonb DEFAULT NULL,p_text jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE recorded boolean;attempt integer;claimed text;file_id uuid;
BEGIN
 recorded=public.finish_file_inspection_pdf_evidence(p_academy,p_inspection,p_lease,p_outcome,p_reason,p_bytes,p_sha256,p_etag,p_content_type,p_signature,p_image,p_database,p_pdf);
 IF recorded IS FALSE THEN RETURN false;END IF;IF recorded IS DISTINCT FROM true THEN RAISE EXCEPTION 'MISSING_FILE_INSPECTION_RECEIPT';END IF;IF p_text IS NULL THEN RETURN true;END IF;
 IF p_outcome IS DISTINCT FROM 'no_detection' OR NOT public.valid_file_text_evidence(p_text) OR(p_text->>'inputBytes')::bigint IS DISTINCT FROM p_bytes OR p_text->>'inputSha256' IS DISTINCT FROM p_sha256 THEN RAISE EXCEPTION 'INVALID_FILE_TEXT_EVIDENCE';END IF;
 SELECT q.attempt_no INTO STRICT attempt FROM public.file_inspection_jobs q WHERE q.academy_id=p_academy AND q.inspection_id=p_inspection;
 SELECT r.definition->>'claimed_mime_type',i.file_id INTO STRICT claimed,file_id FROM public.file_inspection_requests i JOIN public.file_record_revisions r ON r.academy_id=i.academy_id AND r.file_id=i.file_id AND r.version=i.metadata_version WHERE i.academy_id=p_academy AND i.id=p_inspection;
 IF claimed IS DISTINCT FROM 'text/plain' THEN RAISE EXCEPTION 'INVALID_FILE_TEXT_EVIDENCE';END IF;
 INSERT INTO public.file_text_evidence(academy_id,inspection_id,attempt_no,input_bytes,input_sha256,result) VALUES(p_academy,p_inspection,attempt,p_bytes,p_sha256,p_text);
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),CASE p_text->>'outcome' WHEN 'decoded' THEN 'file.text.decoded' ELSE 'file.text.policy_rejected.critical' END,file_id,p_inspection);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC;
ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb) TO kavosh_file_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_file_policy;

-- Preserve native function OIDs,owners,grants,settings and historical sources.
DO $$ DECLARE d text;updated text;needle text;replacement text;
BEGIN
 d=pg_get_functiondef('public.file_copy_source(uuid,integer,uuid,integer,uuid,integer)'::regprocedure);updated=d;
 needle=$n$f.claimed_mime_type NOT IN('application/pdf','image/jpeg','image/png','image/webp','image/gif','image/avif')$n$;replacement=$n$f.claimed_mime_type NOT IN('application/pdf','image/jpeg','image/png','image/webp','image/gif','image/avif','text/plain')$n$;
 IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'TEXT_COPY_CLAIM_DEFINITION_CHANGED';END IF;updated=replace(updated,needle,replacement);
 needle=$n$image.result AS image,pdf.result AS pdf$n$;IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'TEXT_COPY_EVIDENCE_DEFINITION_CHANGED';END IF;updated=replace(updated,needle,$n$image.result AS image,pdf.result AS pdf,text_evidence.result AS text_result$n$);
 needle=$n$AND format.state='matched'$n$;IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'TEXT_COPY_FORMAT_DEFINITION_CHANGED';END IF;updated=replace(updated,needle,$n$AND(format.state='matched' OR(f.claimed_mime_type='text/plain' AND format.state='unassessed' AND format.reason_code='SIGNATURE_UNKNOWN'))$n$);
 needle=$n$AND signature.mime=f.claimed_mime_type$n$;IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'TEXT_COPY_SIGNATURE_DEFINITION_CHANGED';END IF;updated=replace(updated,needle,$n$AND(signature.mime=f.claimed_mime_type OR(f.claimed_mime_type='text/plain' AND signature.mime IS NULL))$n$);
 needle=$n$  WHERE a.academy_id=tenant$n$;IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'TEXT_COPY_JOIN_DEFINITION_CHANGED';END IF;updated=replace(updated,needle,$n$  LEFT JOIN public.file_text_evidence text_evidence ON text_evidence.academy_id=a.academy_id AND text_evidence.inspection_id=a.inspection_id AND text_evidence.attempt_no=a.attempt_no
  WHERE a.academy_id=tenant$n$);
 needle=$n$ IF f.claimed_mime_type='application/pdf' THEN$n$;IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'TEXT_COPY_PROFILE_DEFINITION_CHANGED';END IF;updated=replace(updated,needle,$n$ IF f.claimed_mime_type='text/plain' THEN
  IF e.text_result->>'outcome' IS DISTINCT FROM 'decoded' OR f.expected_bytes>1048576 OR NOT EXISTS(
   SELECT 1 FROM public.file_inspection_requests request JOIN public.file_upload_grants grant_record ON grant_record.academy_id=request.academy_id AND grant_record.id=request.grant_id
   WHERE request.academy_id=tenant AND request.id=p_inspection AND grant_record.format_policy_version IS NOT NULL AND grant_record.format_policy_snapshot->'snapshotVersion'='1'::jsonb
   AND CASE WHEN jsonb_typeof(grant_record.format_policy_snapshot->'allowedMimeTypes')='array' THEN grant_record.format_policy_snapshot->'allowedMimeTypes' ? 'text/plain'
    AND public.valid_upload_mime_list(ARRAY(SELECT jsonb_array_elements_text(grant_record.format_policy_snapshot->'allowedMimeTypes'))) ELSE false END
  ) THEN RETURN NULL;END IF;kind='plain_utf8_text';validator=e.text_result->>'validator';
 ELSIF f.claimed_mime_type='application/pdf' THEN$n$);EXECUTE updated;
 d=pg_get_functiondef('public.file_download_source(uuid,integer,uuid)'::regprocedure);needle=$n$IN('decoded_image','unsigned_source_pdf')$n$;IF position(needle IN d)=0 THEN RAISE EXCEPTION 'TEXT_DOWNLOAD_PROFILE_DEFINITION_CHANGED';END IF;EXECUTE replace(d,needle,$n$IN('decoded_image','unsigned_source_pdf','plain_utf8_text')$n$);
 d=pg_get_functiondef('public.file_storage_route_definition_valid(jsonb)'::regprocedure);needle=$n$jsonb_array_length(s->'allowedMimeTypes')>6$n$;IF position(needle IN d)=0 THEN RAISE EXCEPTION 'TEXT_SERVING_LIMIT_DEFINITION_CHANGED';END IF;updated=replace(d,needle,$n$jsonb_array_length(s->'allowedMimeTypes')>7$n$);
 needle=$n$ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf']$n$;IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'TEXT_SERVING_TYPES_DEFINITION_CHANGED';END IF;EXECUTE replace(updated,needle,$n$ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf','text/plain']$n$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 357 $$;

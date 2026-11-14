-- Explicit NEW reviewed video serving choices,never an automatic expansion of
-- existing image/PDF/text policies. Original grants retain their exact source.
DO $$ DECLARE d text;updated text;needle text;
BEGIN
 d=pg_get_functiondef('public.file_storage_route_definition_valid(jsonb)'::regprocedure);
 needle=$n$jsonb_array_length(s->'allowedMimeTypes')>7$n$;
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'VIDEO_SERVING_TYPE_LIMIT_CHANGED';END IF;
 updated=replace(d,needle,$n$jsonb_array_length(s->'allowedMimeTypes')>10$n$);
 needle=$n$ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf','text/plain']$n$;
 IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'VIDEO_SERVING_ALLOWLIST_CHANGED';END IF;
 EXECUTE replace(updated,needle,$n$ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf','text/plain','video/mp4','video/quicktime','video/webm']$n$);
 d=pg_get_functiondef('public.file_download_source(uuid,integer,uuid)'::regprocedure);
 needle=$n$IN('decoded_image','unsigned_source_pdf','plain_utf8_text')$n$;
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'VIDEO_DOWNLOAD_PROFILE_CHANGED';END IF;
 updated=replace(d,needle,$n$IN('decoded_image','unsigned_source_pdf','plain_utf8_text','decoded_video')$n$);
 needle=$n$ SELECT h.id,h.version,v.definition,v.approval_id INTO r$n$;
 IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'VIDEO_DOWNLOAD_ROUTE_CHANGED';END IF;
 updated=replace(updated,needle,$n$ IF f.claimed_mime_type IN('video/mp4','video/quicktime','video/webm') AND c.source->>'structuralProfile' IS DISTINCT FROM 'decoded_video' THEN RETURN NULL;END IF;
 IF c.source->>'structuralProfile'='decoded_video' AND(
  f.claimed_mime_type NOT IN('video/mp4','video/quicktime','video/webm') OR f.expected_bytes>134217728 OR NOT EXISTS(
   SELECT 1 FROM public.file_video_evidence ve WHERE ve.academy_id=tenant AND ve.inspection_id=c.inspection_id AND ve.attempt_no=c.inspection_attempt
   AND ve.result->>'outcome'='decoded' AND ve.result->>'mime'=f.claimed_mime_type AND ve.input_bytes=f.expected_bytes AND ve.input_sha256=c.source->>'sha256'
  )) THEN RETURN NULL;END IF;
 SELECT h.id,h.version,v.definition,v.approval_id INTO r$n$);
 EXECUTE updated;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 360 $$;

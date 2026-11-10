-- Exact decoded-video copy sources reuse current route approval,scope,fresh
-- scanner evidence and lease fencing. No serving/playback policy is enabled.
DO $$ DECLARE d text;updated text;needle text;c record;t text;found integer;
BEGIN
 d=pg_get_functiondef('public.file_copy_source(uuid,integer,uuid,integer,uuid,integer)'::regprocedure);updated=d;
 needle=$n$'image/avif','text/plain')$n$;
 IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'VIDEO_COPY_CLAIMS_CHANGED';END IF;
 updated=replace(updated,needle,$n$'image/avif','text/plain','video/mp4','video/quicktime','video/webm')$n$);
 needle=$n$text_evidence.result AS text_result$n$;
 IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'VIDEO_COPY_RESULT_CHANGED';END IF;
 updated=replace(updated,needle,$n$text_evidence.result AS text_result,video_evidence.result AS video_result$n$);
 needle=$n$  WHERE a.academy_id=tenant$n$;
 IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'VIDEO_COPY_JOIN_CHANGED';END IF;
 updated=replace(updated,needle,$n$  LEFT JOIN public.file_video_evidence video_evidence ON video_evidence.academy_id=a.academy_id AND video_evidence.inspection_id=a.inspection_id AND video_evidence.attempt_no=a.attempt_no
  WHERE a.academy_id=tenant$n$);
 needle=$n$ IF f.claimed_mime_type='text/plain' THEN$n$;
 IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'VIDEO_COPY_PROFILE_CHANGED';END IF;
 updated=replace(updated,needle,$n$ IF f.claimed_mime_type IN('video/mp4','video/quicktime','video/webm') THEN
  IF e.video_result->>'outcome' IS DISTINCT FROM 'decoded' OR e.video_result->>'mime' IS DISTINCT FROM f.claimed_mime_type
   OR(e.video_result->>'inputBytes')::bigint IS DISTINCT FROM e.measured_bytes OR e.video_result->>'inputSha256' IS DISTINCT FROM e.sha256
   OR f.expected_bytes>134217728 THEN RETURN NULL;END IF;kind='decoded_video';validator=e.video_result->>'validator';
 ELSIF f.claimed_mime_type='text/plain' THEN$n$);
 EXECUTE updated;
 d=pg_get_functiondef('public.file_storage_route_definition_base_valid(jsonb)'::regprocedure);
 IF position($n$>33554432$n$ IN d)=0 OR position($n${0,7}$n$ IN d)=0 THEN RAISE EXCEPTION 'VIDEO_ROUTE_LIMIT_CHANGED';END IF;
 EXECUTE replace(replace(d,$n$>33554432$n$,$n$>134217728$n$),$n${0,7}$n$,$n${0,8}$n$);
 -- Preserve all original exact-byte/type/hash/endpoint/outcome checks while
 -- widening only the bounded measured-byte column for reviewed video sources.
 FOREACH t IN ARRAY ARRAY['file_copy_attempts','file_copy_check_attempts'] LOOP
  found=0;
  FOR c IN SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
   WHERE conrelid=('public.'||t)::regclass AND contype='c' LOOP
   IF position('33554432' IN c.definition)>0 THEN
    found=found+1;EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s',t,c.conname,replace(c.definition,'33554432','134217728'));
   END IF;
  END LOOP;
  IF found<>1 THEN RAISE EXCEPTION 'VIDEO_COPY_RECEIPT_LIMIT_CHANGED';END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 359 $$;

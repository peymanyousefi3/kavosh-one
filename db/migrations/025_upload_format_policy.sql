CREATE FUNCTION public.valid_upload_mime_list(items text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT cardinality(items)<=64 AND (cardinality(items)=0 OR array_ndims(items)=1)
  AND count(DISTINCT item)=count(*) AND coalesce(bool_and(item IS NOT NULL AND item ~ '^[a-z0-9][a-z0-9.+-]{0,99}/[a-z0-9][a-z0-9.+-]{0,99}$'),true)
 FROM unnest(items) item
$$;
REVOKE ALL ON FUNCTION public.valid_upload_mime_list(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_upload_mime_list(text[]) TO kavosh_runtime;
ALTER TABLE public.file_storage_policies ADD COLUMN allowed_mime_types text[] NOT NULL DEFAULT
 ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif','image/heic','image/heif','video/mp4','video/quicktime','video/webm','audio/mpeg','audio/mp4','audio/wav','application/pdf','application/zip','text/plain','text/csv','application/json'];
ALTER TABLE public.file_storage_policies ADD CONSTRAINT valid_upload_mime_types CHECK(public.valid_upload_mime_list(allowed_mime_types));
GRANT INSERT(allowed_mime_types),UPDATE(allowed_mime_types) ON public.file_storage_policies TO kavosh_runtime;

-- Both native issuers already hold policy -> file locks. Reusing them here
-- prevents allocating a new slot or issuing another grant for a denied claim.
CREATE FUNCTION public.guard_upload_mime_type() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE allowed text[]; claimed text;
BEGIN
 SELECT p.allowed_mime_types INTO allowed FROM public.file_storage_policies p WHERE p.academy_id=NEW.academy_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'STORAGE_POLICY_NOT_CONFIGURED'; END IF;
 SELECT f.claimed_mime_type INTO claimed FROM public.file_records f WHERE f.academy_id=NEW.academy_id AND f.id=NEW.file_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'FILE_NOT_FOUND'; END IF;
 IF NOT(claimed=ANY(allowed)) THEN RAISE EXCEPTION 'FILE_TYPE_NOT_ALLOWED'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_upload_mime_type() FROM PUBLIC;
CREATE TRIGGER guard_reservation_mime_type BEFORE INSERT ON public.file_upload_reservations FOR EACH ROW EXECUTE FUNCTION public.guard_upload_mime_type();
CREATE TRIGGER guard_grant_mime_type BEFORE INSERT ON public.file_upload_grants FOR EACH ROW EXECUTE FUNCTION public.guard_upload_mime_type();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 25 $$;

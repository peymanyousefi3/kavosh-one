ALTER TABLE public.file_upload_grants ADD COLUMN format_policy_version integer;
ALTER TABLE public.file_upload_grants ADD COLUMN format_policy_snapshot jsonb;
CREATE INDEX file_upload_grant_history ON public.file_upload_grants(academy_id,file_id,issued_at,id);
ALTER TABLE public.file_upload_grants ADD CONSTRAINT grant_format_policy_reference FOREIGN KEY(academy_id,format_policy_version) REFERENCES public.file_storage_policy_revisions(academy_id,version);
ALTER TABLE public.file_upload_grants ADD CONSTRAINT grant_format_policy_pair CHECK(
 (format_policy_version IS NULL AND format_policy_snapshot IS NULL) OR
 (format_policy_version IS NOT NULL AND format_policy_snapshot IS NOT NULL AND format_policy_version>0 AND jsonb_typeof(format_policy_snapshot)='object'
  AND format_policy_snapshot ?& ARRAY['snapshotVersion','allowedMimeTypes'] AND format_policy_snapshot-ARRAY['snapshotVersion','allowedMimeTypes']='{}'::jsonb
  AND (format_policy_snapshot->>'snapshotVersion' IS NOT DISTINCT FROM '1') AND jsonb_typeof(format_policy_snapshot->'allowedMimeTypes')='array' AND jsonb_array_length(format_policy_snapshot->'allowedMimeTypes')<=64));
-- Legacy grants stay explicitly unknown. Never reconstruct their historical
-- format policy from today's settings or rewrite old private revisions.
CREATE OR REPLACE FUNCTION public.guard_upload_mime_type() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE allowed text[]; claimed text; policy_version integer;
BEGIN
 SELECT p.allowed_mime_types,p.version INTO allowed,policy_version FROM public.file_storage_policies p WHERE p.academy_id=NEW.academy_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'STORAGE_POLICY_NOT_CONFIGURED'; END IF;
 SELECT f.claimed_mime_type INTO claimed FROM public.file_records f WHERE f.academy_id=NEW.academy_id AND f.id=NEW.file_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'FILE_NOT_FOUND'; END IF;
 IF NOT(claimed=ANY(allowed)) THEN RAISE EXCEPTION 'FILE_TYPE_NOT_ALLOWED'; END IF;
 IF TG_TABLE_NAME='file_upload_grants' THEN
  NEW.format_policy_version:=policy_version;
  NEW.format_policy_snapshot:=jsonb_build_object('snapshotVersion',1,'allowedMimeTypes',allowed);
 END IF;
 RETURN NEW;
END $$;
-- Return the native version with the same statement, not an extra query per
-- upload response. RESTRICT refuses unforeseen dependent-object removal.
-- https://www.postgresql.org/docs/17/sql-createfunction.html
DROP FUNCTION public.issue_file_upload_grant(uuid,uuid,integer,text) RESTRICT;
CREATE FUNCTION public.issue_file_upload_grant(p_file uuid,p_actor uuid,p_metadata_version integer,p_target text)
RETURNS TABLE(id uuid,file_id uuid,metadata_version integer,storage_target_id text,issued_at timestamptz,expires_at timestamptz,format_policy_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid; allocation public.file_upload_reservations; grant_record public.file_upload_grants; issued timestamptz;
BEGIN
 IF p_target IS NULL OR p_target !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_STORAGE_TARGET'; END IF;
 PERFORM 1 FROM public.reserve_file_upload(p_file,p_actor,p_metadata_version);
 SELECT * INTO allocation FROM public.file_upload_reservations r WHERE r.academy_id=tenant AND r.file_id=p_file FOR UPDATE;
 IF allocation.storage_target_id IS NOT NULL AND allocation.storage_target_id<>p_target THEN RAISE EXCEPTION 'STORAGE_TARGET_CHANGED'; END IF;
 UPDATE public.file_upload_reservations AS r SET storage_target_id=p_target WHERE r.academy_id=tenant AND r.file_id=p_file AND r.storage_target_id IS NULL;
 issued:=date_trunc('second',clock_timestamp());
 INSERT INTO public.file_upload_grants(academy_id,file_id,metadata_version,storage_target_id,created_by,issued_at,expires_at)
 VALUES(tenant,p_file,p_metadata_version,p_target,p_actor,issued,issued+interval '300 seconds') RETURNING * INTO grant_record;
 RETURN QUERY SELECT grant_record.id,grant_record.file_id,grant_record.metadata_version,grant_record.storage_target_id,grant_record.issued_at,grant_record.expires_at,grant_record.format_policy_version;
END $$;
REVOKE ALL ON FUNCTION public.issue_file_upload_grant(uuid,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_file_upload_grant(uuid,uuid,integer,text) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 26 $$;

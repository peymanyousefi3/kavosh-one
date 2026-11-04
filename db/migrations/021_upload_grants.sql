UPDATE public.capability_catalog SET label='Upload permitted files to private quarantine' WHERE name='files.upload';
ALTER TABLE public.file_upload_reservations ADD COLUMN storage_target_id text CHECK(storage_target_id ~ '^[a-f0-9]{64}$');
CREATE TABLE public.file_upload_grants (
 academy_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),file_id uuid NOT NULL,metadata_version integer NOT NULL,
 storage_target_id text NOT NULL CHECK(storage_target_id ~ '^[a-f0-9]{64}$'),created_by uuid NOT NULL,
 issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(academy_id,id),CHECK(expires_at=issued_at+interval '300 seconds'),CHECK(issued_at=date_trunc('second',issued_at)),
 FOREIGN KEY(academy_id,file_id) REFERENCES public.file_upload_reservations(academy_id,file_id),
 FOREIGN KEY(academy_id,file_id,metadata_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE INDEX file_upload_grant_expiry ON public.file_upload_grants(academy_id,file_id,expires_at DESC);
ALTER TABLE public.file_upload_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_upload_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.file_upload_grants
 USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid)
 WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.file_upload_grants TO kavosh_runtime;
-- The service checks current feature/domain scopes. This helper additionally
-- enforces tenant/capacity/revision invariants and records grant lifetimes without
-- storing a bearer URL. No ordinary SQL grant can forge or erase these records.
CREATE FUNCTION public.issue_file_upload_grant(p_file uuid,p_actor uuid,p_metadata_version integer,p_target text)
RETURNS TABLE(id uuid,file_id uuid,metadata_version integer,storage_target_id text,issued_at timestamptz,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid; allocation public.file_upload_reservations; grant_record public.file_upload_grants; issued timestamptz;
BEGIN
 IF p_target IS NULL OR p_target !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_STORAGE_TARGET'; END IF;
 -- Preserve the policy -> file -> reservation lock order, including on retries.
 PERFORM 1 FROM public.reserve_file_upload(p_file,p_actor,p_metadata_version);
 SELECT * INTO allocation FROM public.file_upload_reservations r WHERE r.academy_id=tenant AND r.file_id=p_file FOR UPDATE;
 IF allocation.storage_target_id IS NOT NULL AND allocation.storage_target_id<>p_target THEN RAISE EXCEPTION 'STORAGE_TARGET_CHANGED'; END IF;
 UPDATE public.file_upload_reservations AS r SET storage_target_id=p_target WHERE r.academy_id=tenant AND r.file_id=p_file AND r.storage_target_id IS NULL;
 issued:=date_trunc('second',clock_timestamp());
 INSERT INTO public.file_upload_grants(academy_id,file_id,metadata_version,storage_target_id,created_by,issued_at,expires_at)
 VALUES(tenant,p_file,p_metadata_version,p_target,p_actor,issued,issued+interval '300 seconds') RETURNING * INTO grant_record;
 RETURN QUERY SELECT grant_record.id,grant_record.file_id,grant_record.metadata_version,grant_record.storage_target_id,grant_record.issued_at,grant_record.expires_at;
END $$;
REVOKE ALL ON FUNCTION public.issue_file_upload_grant(uuid,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_file_upload_grant(uuid,uuid,integer,text) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 21 $$;

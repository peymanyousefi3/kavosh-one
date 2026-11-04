INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('storage.view','View school upload policy and reserved budget','Files',true,'{}'),
 ('storage.edit','Request school upload policy changes','Files',true,'{}'),
 ('files.upload','Reserve upload capacity for permitted files','Files',true,ARRAY['hub','class','person','country','region','city']);
CREATE TABLE public.file_storage_policies (
 academy_id uuid PRIMARY KEY REFERENCES public.academies(id),uploads_enabled boolean NOT NULL DEFAULT false,
 maximum_file_bytes bigint NOT NULL CHECK(maximum_file_bytes BETWEEN 1 AND 4294967296),
 maximum_reserved_bytes bigint NOT NULL CHECK(maximum_reserved_bytes BETWEEN maximum_file_bytes AND 9007199254740991),
 maximum_files integer NOT NULL CHECK(maximum_files BETWEEN 1 AND 1000000000),
 reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes BETWEEN 0 AND 9007199254740991),reserved_files integer NOT NULL DEFAULT 0 CHECK(reserved_files>=0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),last_approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(academy_id,last_approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.file_storage_policy_revisions (
 academy_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,version),FOREIGN KEY(academy_id) REFERENCES public.file_storage_policies(academy_id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.file_storage_policies ADD CONSTRAINT current_storage_policy_revision
 FOREIGN KEY(academy_id,version) REFERENCES public.file_storage_policy_revisions(academy_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.file_upload_reservations (
 academy_id uuid NOT NULL,file_id uuid NOT NULL,reserved_bytes bigint NOT NULL CHECK(reserved_bytes BETWEEN 1 AND 4294967296),
 policy_version integer NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),released_at timestamptz,
 PRIMARY KEY(academy_id,file_id),FOREIGN KEY(academy_id,file_id) REFERENCES public.file_records(academy_id,id),
 FOREIGN KEY(academy_id,policy_version) REFERENCES public.file_storage_policy_revisions(academy_id,version),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['file_storage_policies','file_storage_policy_revisions','file_upload_reservations'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT ON public.file_storage_policies,public.file_storage_policy_revisions,public.file_upload_reservations TO kavosh_runtime;
GRANT INSERT(academy_id,uploads_enabled,maximum_file_bytes,maximum_reserved_bytes,maximum_files,last_approval_id) ON public.file_storage_policies TO kavosh_runtime;
GRANT UPDATE(uploads_enabled,maximum_file_bytes,maximum_reserved_bytes,maximum_files,version,last_approval_id) ON public.file_storage_policies TO kavosh_runtime;
GRANT INSERT ON public.file_storage_policy_revisions TO kavosh_runtime;
-- Quota mutation is intentionally separate from application-editable settings.
-- No client cancellation/timeout releases capacity; a future cleanup worker
-- must prove physical disposal and grant expiry before crediting that capacity.
CREATE FUNCTION public.reserve_file_upload(p_file uuid,p_actor uuid,p_metadata_version integer)
RETURNS TABLE(file_id uuid,reserved_bytes bigint,policy_version integer,created_at timestamptz,newly_reserved boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid; p public.file_storage_policies; f public.file_records; existing public.file_upload_reservations;
BEGIN
 SELECT * INTO p FROM public.file_storage_policies WHERE academy_id=tenant FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STORAGE_POLICY_NOT_CONFIGURED'; END IF;
 IF NOT p.uploads_enabled THEN RAISE EXCEPTION 'UPLOADS_DISABLED'; END IF;
 SELECT * INTO f FROM public.file_records WHERE academy_id=tenant AND id=p_file FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'FILE_NOT_FOUND'; END IF;
 IF f.version IS DISTINCT FROM p_metadata_version THEN RAISE EXCEPTION 'TARGET_CHANGED'; END IF;
 IF f.archived THEN RAISE EXCEPTION 'FILE_ARCHIVED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=tenant AND id=p_actor AND status='active') THEN RAISE EXCEPTION 'INVALID_RESERVATION_ACTOR'; END IF;
 IF f.expected_bytes>p.maximum_file_bytes THEN RAISE EXCEPTION 'FILE_EXCEEDS_STORAGE_LIMIT'; END IF;
 SELECT * INTO existing FROM public.file_upload_reservations r WHERE r.academy_id=tenant AND r.file_id=p_file;
 IF FOUND THEN
  IF existing.released_at IS NOT NULL THEN RAISE EXCEPTION 'UPLOAD_RESERVATION_CLOSED'; END IF;
  IF existing.reserved_bytes<>f.expected_bytes THEN RAISE EXCEPTION 'FILE_CLAIMS_CHANGED'; END IF;
  RETURN QUERY SELECT existing.file_id,existing.reserved_bytes,existing.policy_version,existing.created_at,false;RETURN;
 END IF;
 IF p.reserved_files>=p.maximum_files OR p.reserved_bytes+f.expected_bytes>p.maximum_reserved_bytes THEN RAISE EXCEPTION 'STORAGE_QUOTA_EXCEEDED'; END IF;
 INSERT INTO public.file_upload_reservations(academy_id,file_id,reserved_bytes,policy_version,created_by)
  VALUES(tenant,p_file,f.expected_bytes,p.version,p_actor) RETURNING * INTO existing;
 UPDATE public.file_storage_policies AS policy SET reserved_bytes=policy.reserved_bytes+f.expected_bytes,reserved_files=policy.reserved_files+1 WHERE policy.academy_id=tenant;
 RETURN QUERY SELECT existing.file_id,existing.reserved_bytes,existing.policy_version,existing.created_at,true;
END $$;
REVOKE ALL ON FUNCTION public.reserve_file_upload(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_file_upload(uuid,uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 20 $$;

ALTER TABLE public.file_upload_grants ADD CONSTRAINT upload_grant_file_identity UNIQUE(academy_id,file_id,id,storage_target_id);
CREATE TABLE public.file_inspection_requests (
 academy_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),file_id uuid NOT NULL,grant_id uuid NOT NULL,
 metadata_version integer NOT NULL,storage_target_id text NOT NULL CHECK(storage_target_id ~ '^[a-f0-9]{64}$'),
 requested_by uuid NOT NULL,requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,file_id),UNIQUE(academy_id,id),
 FOREIGN KEY(academy_id,file_id,grant_id,storage_target_id) REFERENCES public.file_upload_grants(academy_id,file_id,id,storage_target_id),
 FOREIGN KEY(academy_id,file_id,metadata_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),
 FOREIGN KEY(academy_id,requested_by) REFERENCES public.people(academy_id,id)
);
ALTER TABLE public.file_inspection_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_inspection_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.file_inspection_requests
 USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid)
 WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.file_inspection_requests TO kavosh_runtime;

-- Completion is an immutable, durable request, not proof of stored/clean bytes.
-- Expired upload grants may still identify legitimately uploaded objects. The
-- request neither renews a grant nor releases its reserved capacity.
CREATE FUNCTION public.request_file_inspection(p_file uuid,p_grant uuid,p_actor uuid,p_version integer)
RETURNS TABLE(id uuid,file_id uuid,grant_id uuid,metadata_version integer,requested_by uuid,requested_at timestamptz,newly_requested boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid; f public.file_records; g public.file_upload_grants; allocation public.file_upload_reservations; existing public.file_inspection_requests;
BEGIN
 -- Same policy -> file -> reservation order as grant issuance. Disabling new
 -- uploads must not prevent requesting security inspection of an existing grant.
 -- Output names are PL/pgSQL variables; qualify every source column.
 PERFORM 1 FROM public.file_storage_policies policy WHERE policy.academy_id=tenant FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'STORAGE_POLICY_NOT_CONFIGURED'; END IF;
 SELECT * INTO f FROM public.file_records file_record WHERE file_record.academy_id=tenant AND file_record.id=p_file FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'FILE_NOT_FOUND'; END IF;
 IF f.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'TARGET_CHANGED'; END IF;
 IF f.archived THEN RAISE EXCEPTION 'FILE_ARCHIVED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.people person WHERE person.academy_id=tenant AND person.id=p_actor AND person.status='active') THEN RAISE EXCEPTION 'INVALID_RESERVATION_ACTOR'; END IF;
 SELECT * INTO g FROM public.file_upload_grants upload_grant WHERE upload_grant.academy_id=tenant AND upload_grant.id=p_grant AND upload_grant.file_id=p_file;
 IF NOT FOUND THEN RAISE EXCEPTION 'UPLOAD_GRANT_NOT_FOUND'; END IF;
 SELECT * INTO allocation FROM public.file_upload_reservations r WHERE r.academy_id=tenant AND r.file_id=p_file FOR UPDATE;
 IF allocation.released_at IS NOT NULL THEN RAISE EXCEPTION 'UPLOAD_RESERVATION_CLOSED'; END IF;
 IF allocation.storage_target_id IS DISTINCT FROM g.storage_target_id THEN RAISE EXCEPTION 'STORAGE_TARGET_CHANGED'; END IF;
 SELECT * INTO existing FROM public.file_inspection_requests r WHERE r.academy_id=tenant AND r.file_id=p_file;
 IF FOUND THEN RETURN QUERY SELECT existing.id,existing.file_id,existing.grant_id,existing.metadata_version,existing.requested_by,existing.requested_at,false;RETURN; END IF;
 INSERT INTO public.file_inspection_requests(academy_id,file_id,grant_id,metadata_version,storage_target_id,requested_by)
 VALUES(tenant,p_file,p_grant,p_version,g.storage_target_id,p_actor) RETURNING * INTO existing;
 RETURN QUERY SELECT existing.id,existing.file_id,existing.grant_id,existing.metadata_version,existing.requested_by,existing.requested_at,true;
END $$;
REVOKE ALL ON FUNCTION public.request_file_inspection(uuid,uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_file_inspection(uuid,uuid,uuid,integer) TO kavosh_runtime;

CREATE FUNCTION public.close_upload_after_inspection_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.file_inspection_requests WHERE academy_id=NEW.academy_id AND file_id=NEW.file_id) THEN RAISE EXCEPTION 'UPLOAD_CLOSED_FOR_INSPECTION'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.close_upload_after_inspection_request() FROM PUBLIC;
CREATE TRIGGER no_grants_after_inspection_request BEFORE INSERT ON public.file_upload_grants
 FOR EACH ROW EXECUTE FUNCTION public.close_upload_after_inspection_request();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 22 $$;

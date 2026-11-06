-- Serving requires a NEW explicit upper-reviewed policy. Historical route
-- approvals remain unchanged and never silently turn on attachment downloads.
ALTER FUNCTION public.file_storage_route_definition_valid(jsonb) RENAME TO file_storage_route_definition_base_valid;
CREATE FUNCTION public.file_storage_route_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE s jsonb;m jsonb;
BEGIN
 IF NOT public.file_storage_route_definition_base_valid(d-'serving') THEN RETURN false;END IF;
 IF NOT(d ? 'serving') THEN RETURN true;END IF;s=d->'serving';
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR NOT(s ?& ARRAY['enabled','allowedMimeTypes','maximumLinkSeconds']) OR s-ARRAY['enabled','allowedMimeTypes','maximumLinkSeconds']<>'{}'::jsonb
 OR jsonb_typeof(s->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(s->'allowedMimeTypes') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'allowedMimeTypes')>6
 OR jsonb_typeof(s->'maximumLinkSeconds') IS DISTINCT FROM 'number' OR s->>'maximumLinkSeconds'!~'^[1-9][0-9]?$' OR(s->>'maximumLinkSeconds')::integer>60 THEN RETURN false;END IF;
 FOR m IN SELECT * FROM jsonb_array_elements(s->'allowedMimeTypes') LOOP
  IF jsonb_typeof(m) IS DISTINCT FROM 'string' OR NOT(m#>>'{}'=ANY(ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf'])) THEN RETURN false;END IF;
 END LOOP;
 RETURN(SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(s->'allowedMimeTypes'));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.file_storage_route_definition_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.file_storage_route_definition_valid(jsonb) TO kavosh_runtime;
GRANT CREATE ON SCHEMA public TO kavosh_file_policy;
CREATE FUNCTION public.file_download_source(p_file uuid,p_version integer,p_copy uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;f record;c public.file_copy_requests;r record;etag text;scope jsonb;w jsonb;
BEGIN
 SELECT * INTO f FROM public.file_catalogue WHERE academy_id=tenant AND id=p_file AND version=p_version AND NOT archived;
 SELECT q.* INTO c FROM public.file_copy_requests q JOIN public.file_copy_jobs j ON j.academy_id=q.academy_id AND j.copy_id=q.id AND j.state='verified'
 WHERE q.academy_id=tenant AND q.id=p_copy AND q.file_id=p_file;
 IF f.id IS NULL OR c.id IS NULL OR c.source->>'mime' IS DISTINCT FROM f.claimed_mime_type OR(c.source->>'bytes')::bigint IS DISTINCT FROM f.expected_bytes
 OR(f.expected_sha256 IS NOT NULL AND f.expected_sha256 IS DISTINCT FROM c.source->>'sha256')
 OR NOT coalesce(c.source->>'structuralProfile' IN('decoded_image','unsigned_source_pdf'),false) THEN RETURN NULL;END IF;
 SELECT h.id,h.version,v.definition,v.approval_id INTO r FROM public.file_storage_routes h JOIN public.file_storage_route_revisions v
 ON v.academy_id=h.academy_id AND v.route_id=h.id AND v.version=h.version
 JOIN public.approval_requests a ON a.academy_id=v.academy_id AND a.id=v.approval_id AND a.status='applied' AND a.reviewer_id=v.changed_by
 WHERE h.academy_id=tenant AND h.id=c.route_id AND v.definition->'enabled'='true'::jsonb AND v.definition#>'{serving,enabled}'='true'::jsonb
 AND v.definition->>'destinationTargetId'=c.source->>'destinationTargetId' AND v.definition#>'{serving,allowedMimeTypes}' ? f.claimed_mime_type
 AND f.expected_bytes<=(v.definition->>'maximumBytes')::bigint;
 IF r.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.file_inspection_jobs j WHERE j.academy_id=tenant AND j.inspection_id=c.inspection_id AND j.state='evidence_recorded' AND j.attempt_no=c.inspection_attempt)
 OR EXISTS(SELECT 1 FROM public.file_inspection_attempts a JOIN public.file_inspection_requests i ON i.academy_id=a.academy_id AND i.id=a.inspection_id WHERE i.academy_id=tenant AND i.file_id=p_file AND a.outcome='detected') THEN RETURN NULL;END IF;
 -- Permanent measured receipts,NOT a current scanner-database age check.
 -- Old media does not expire simply because its successful scan is old.
 SELECT a.destination_etag INTO etag FROM public.file_copy_attempts a WHERE a.academy_id=tenant AND a.copy_id=c.id AND a.outcome IN('written_verified','existing_verified')
 AND a.source_fingerprint=c.source_fingerprint AND a.measured_bytes=f.expected_bytes AND a.sha256=c.source->>'sha256' AND a.destination_target_id=c.source->>'destinationTargetId' ORDER BY a.attempt_no DESC LIMIT 1;
 IF etag IS NULL THEN
  SELECT a.destination_etag INTO etag FROM public.file_copy_checks q JOIN public.file_copy_check_attempts a ON a.academy_id=q.academy_id AND a.check_id=q.id
  WHERE q.academy_id=tenant AND q.copy_id=c.id AND q.source_fingerprint=c.source_fingerprint AND a.outcome='verified' AND a.measured_bytes=f.expected_bytes AND a.sha256=c.source->>'sha256' AND a.destination_target_id=c.source->>'destinationTargetId'
  ORDER BY a.finished_at DESC,q.id DESC,a.attempt_no DESC LIMIT 1;
 END IF;IF etag IS NULL THEN RETURN NULL;END IF;
 IF f.domain='work_private' THEN w=public.work_file_context(p_file);IF w IS NULL THEN RETURN NULL;END IF;
  scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',w->'personId','hubId',w->'hubId')),'workContext',jsonb_build_object('personId',w->'personId','hubId',w->'hubId'));
 ELSIF f.person_id IS NOT NULL THEN scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',f.person_id,'hubId',f.effective_hub_id)));
 ELSIF f.class_id IS NOT NULL THEN scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',f.class_id,'hubId',f.effective_hub_id)));
 ELSIF f.effective_hub_id IS NOT NULL THEN scope=jsonb_build_object('all',false,'hubs',jsonb_build_array(f.effective_hub_id));ELSE scope='{"all":true,"hubs":[]}'::jsonb;END IF;
 RETURN jsonb_build_object('version',1,'fileId',f.id,'fileVersion',f.version,'copyId',c.id,'artifactFingerprint',c.source_fingerprint,'routeId',r.id,'routeVersion',r.version,'routeApprovalId',r.approval_id,
 'domain',f.domain,'scope',scope,'bytes',f.expected_bytes,'sha256',c.source->>'sha256','mime',f.claimed_mime_type,'destinationTargetId',c.source->>'destinationTargetId','destinationEtag',etag,'maximumLinkSeconds',(r.definition#>>'{serving,maximumLinkSeconds}')::integer);
END $$;
REVOKE ALL ON FUNCTION public.file_download_source(uuid,integer,uuid) FROM PUBLIC;
ALTER FUNCTION public.file_download_source(uuid,integer,uuid) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.file_download_source(uuid,integer,uuid) TO kavosh_runtime;
REVOKE CREATE ON SCHEMA public FROM kavosh_file_policy;
CREATE TABLE public.file_download_grants(
 academy_id uuid NOT NULL,id uuid NOT NULL,file_id uuid NOT NULL,file_version integer NOT NULL,copy_id uuid NOT NULL,source jsonb NOT NULL,
 source_fingerprint text NOT NULL CHECK(source_fingerprint=encode(sha256(convert_to(source::text,'UTF8')),'hex')),created_by uuid NOT NULL,audit_id uuid NOT NULL,
 issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,audit_id),FOREIGN KEY(academy_id,file_id,file_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),
 FOREIGN KEY(academy_id,copy_id) REFERENCES public.file_copy_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id),
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '60 seconds')
);
CREATE INDEX file_download_grant_history ON public.file_download_grants(academy_id,file_id,id);
ALTER TABLE public.file_download_grants ENABLE ROW LEVEL SECURITY;ALTER TABLE public.file_download_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.file_download_grants USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.file_download_grants TO kavosh_runtime;
GRANT INSERT(academy_id,id,file_id,file_version,copy_id,created_by,audit_id) ON public.file_download_grants TO kavosh_runtime;
CREATE FUNCTION public.file_download_grant_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actual jsonb;a record;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 PERFORM 1 FROM public.file_records WHERE academy_id=NEW.academy_id AND id=NEW.file_id FOR SHARE;
 PERFORM 1 FROM public.file_storage_routes h JOIN public.file_copy_requests c ON c.academy_id=h.academy_id AND c.route_id=h.id WHERE c.academy_id=NEW.academy_id AND c.id=NEW.copy_id FOR SHARE OF h;
 actual=public.file_download_source(NEW.file_id,NEW.file_version,NEW.copy_id);SELECT * INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id;
 IF actual IS NULL OR a.id IS NULL OR a.actor_id IS DISTINCT FROM NEW.created_by OR a.action IS DISTINCT FROM 'file.download.link.issued' OR a.entity_id IS DISTINCT FROM NEW.id OR a.created_at IS DISTINCT FROM transaction_timestamp()
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.created_by AND status='active') THEN RAISE EXCEPTION 'FILE_DOWNLOAD_NOT_READY' USING ERRCODE='23514';END IF;
 NEW.source=actual;NEW.source_fingerprint=encode(sha256(convert_to(actual::text,'UTF8')),'hex');NEW.issued_at=date_trunc('second',clock_timestamp());NEW.expires_at=NEW.issued_at+(actual->>'maximumLinkSeconds')::integer*interval '1 second';RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.file_download_grant_guard() FROM PUBLIC;
CREATE TRIGGER file_download_grant_guard BEFORE INSERT ON public.file_download_grants FOR EACH ROW EXECUTE FUNCTION public.file_download_grant_guard();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 118 $$;

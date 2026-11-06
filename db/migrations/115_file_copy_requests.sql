-- Routine byte-copy intentions use an already reviewed route,not an additional
-- per-upload human approval. They grant no download/publication/signing rights.
CREATE FUNCTION public.file_copy_source(p_file uuid,p_version integer,p_inspection uuid,p_attempt integer,p_route uuid,p_route_version integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;f record;r record;e record;scope jsonb;w jsonb;kind text;validator text;
BEGIN
 SELECT * INTO f FROM public.file_catalogue WHERE academy_id=tenant AND id=p_file AND version=p_version AND NOT archived;
 SELECT h.id,h.version,v.definition,v.approval_id INTO r FROM public.file_storage_routes h JOIN public.file_storage_route_revisions v
  ON v.academy_id=h.academy_id AND v.route_id=h.id AND v.version=h.version
  JOIN public.approval_requests a ON a.academy_id=v.academy_id AND a.id=v.approval_id AND a.status='applied' AND a.reviewer_id=v.changed_by
  WHERE h.academy_id=tenant AND h.id=p_route AND h.version=p_route_version AND v.definition->'enabled'='true'::jsonb;
 IF f.id IS NULL OR r.id IS NULL OR f.expected_bytes>(r.definition->>'maximumBytes')::bigint
  OR f.claimed_mime_type NOT IN('application/pdf','image/jpeg','image/png','image/webp','image/gif','image/avif') THEN RETURN NULL;END IF;
 SELECT a.*,q.storage_target_id,scanner.result AS scanner,scanner.recorded_at AS scanner_recorded_at,
  image.result AS image,pdf.result AS pdf INTO e FROM public.file_inspection_attempts a
  JOIN public.file_inspection_requests q ON q.academy_id=a.academy_id AND q.id=a.inspection_id AND q.file_id=p_file
  JOIN public.file_inspection_jobs j ON j.academy_id=a.academy_id AND j.inspection_id=a.inspection_id AND j.attempt_no=a.attempt_no AND j.state='evidence_recorded'
  JOIN public.file_format_assessments format ON format.academy_id=a.academy_id AND format.inspection_id=a.inspection_id AND format.attempt_no=a.attempt_no AND format.state='matched'
  JOIN public.file_content_signatures signature ON signature.academy_id=a.academy_id AND signature.inspection_id=a.inspection_id AND signature.attempt_no=a.attempt_no AND signature.mime=f.claimed_mime_type
  JOIN public.file_scanner_observations scanner ON scanner.academy_id=a.academy_id AND scanner.inspection_id=a.inspection_id AND scanner.attempt_no=a.attempt_no
  LEFT JOIN public.file_image_evidence image ON image.academy_id=a.academy_id AND image.inspection_id=a.inspection_id AND image.attempt_no=a.attempt_no
  LEFT JOIN public.file_pdf_evidence pdf ON pdf.academy_id=a.academy_id AND pdf.inspection_id=a.inspection_id AND pdf.attempt_no=a.attempt_no
  WHERE a.academy_id=tenant AND a.inspection_id=p_inspection AND a.attempt_no=p_attempt AND a.outcome='no_detection';
 IF e.inspection_id IS NULL OR e.storage_target_id IS DISTINCT FROM r.definition->>'sourceTargetId'
  OR e.measured_bytes IS DISTINCT FROM f.expected_bytes OR(f.expected_sha256 IS NOT NULL AND f.expected_sha256 IS DISTINCT FROM e.sha256)
  OR extract(epoch FROM clock_timestamp()-(e.scanner->>'databaseCreatedAt')::timestamptz)>(e.scanner->>'maximumAgeSeconds')::numeric
  OR(e.scanner->>'observedAt')::timestamptz>clock_timestamp()+interval '5 seconds'
  OR EXISTS(SELECT 1 FROM public.file_upload_grants WHERE academy_id=tenant AND file_id=p_file AND expires_at>clock_timestamp()) THEN RETURN NULL;END IF;
 IF f.claimed_mime_type='application/pdf' THEN
  IF e.pdf->>'outcome' IS DISTINCT FROM 'screened' THEN RETURN NULL;END IF;kind='unsigned_source_pdf';validator=e.pdf->>'validator';
 ELSE
  IF e.image->>'outcome' IS DISTINCT FROM 'decoded' OR e.image->>'mime' IS DISTINCT FROM f.claimed_mime_type THEN RETURN NULL;END IF;kind='decoded_image';validator=e.image->>'validator';
 END IF;
 IF f.domain='work_private' THEN
  w=public.work_file_context(p_file);IF w IS NULL THEN RETURN NULL;END IF;
  scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',w->'personId','hubId',w->'hubId')),'workContext',jsonb_build_object('personId',w->'personId','hubId',w->'hubId'));
 ELSIF f.person_id IS NOT NULL THEN scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',f.person_id,'hubId',f.effective_hub_id)));
 ELSIF f.class_id IS NOT NULL THEN scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',f.class_id,'hubId',f.effective_hub_id)));
 ELSIF f.effective_hub_id IS NOT NULL THEN scope=jsonb_build_object('all',false,'hubs',jsonb_build_array(f.effective_hub_id));
 ELSE scope='{"all":true,"hubs":[]}'::jsonb;END IF;
 RETURN jsonb_build_object('version',1,'fileId',f.id,'fileVersion',f.version,'domain',f.domain,'scope',scope,'inspectionId',p_inspection,'attemptNo',p_attempt,
  'bytes',e.measured_bytes,'sha256',e.sha256,'mime',f.claimed_mime_type,'structuralProfile',kind,'validator',validator,'scannerRecordedAt',e.scanner_recorded_at,
  'routeId',r.id,'routeVersion',r.version,'routeApprovalId',r.approval_id,'sourceTargetId',e.storage_target_id,'destinationTargetId',r.definition->>'destinationTargetId');
END $$;
CREATE TABLE public.file_copy_requests(
 academy_id uuid NOT NULL,id uuid NOT NULL,file_id uuid NOT NULL,file_version integer NOT NULL,inspection_id uuid NOT NULL,inspection_attempt integer NOT NULL,
 route_id uuid NOT NULL,route_version integer NOT NULL,source jsonb NOT NULL,
 source_fingerprint text NOT NULL CHECK(source_fingerprint=encode(sha256(convert_to(source::text,'UTF8')),'hex')),
 requested_by uuid NOT NULL,audit_id uuid NOT NULL,requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,file_id,source_fingerprint),UNIQUE(academy_id,audit_id),
 FOREIGN KEY(academy_id,file_id,file_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),
 FOREIGN KEY(academy_id,inspection_id,inspection_attempt) REFERENCES public.file_inspection_attempts(academy_id,inspection_id,attempt_no),
 FOREIGN KEY(academy_id,route_id,route_version) REFERENCES public.file_storage_route_revisions(academy_id,route_id,version),
 FOREIGN KEY(academy_id,requested_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id)
);
CREATE INDEX file_copy_requests_file_cursor ON public.file_copy_requests(academy_id,file_id,id);
ALTER TABLE public.file_copy_requests ENABLE ROW LEVEL SECURITY;ALTER TABLE public.file_copy_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.file_copy_requests USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.file_copy_requests TO kavosh_runtime;
GRANT INSERT(academy_id,id,file_id,file_version,inspection_id,inspection_attempt,route_id,route_version,source,requested_by,audit_id) ON public.file_copy_requests TO kavosh_runtime;
CREATE FUNCTION public.file_copy_request_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actual jsonb;a record;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 PERFORM 1 FROM public.file_storage_routes WHERE academy_id=NEW.academy_id AND id=NEW.route_id FOR SHARE;
 PERFORM 1 FROM public.file_records WHERE academy_id=NEW.academy_id AND id=NEW.file_id FOR SHARE;
 actual=public.file_copy_source(NEW.file_id,NEW.file_version,NEW.inspection_id,NEW.inspection_attempt,NEW.route_id,NEW.route_version);
 SELECT * INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id;
 IF actual IS NULL OR NEW.source IS DISTINCT FROM actual OR a.id IS NULL OR a.actor_id IS DISTINCT FROM NEW.requested_by OR a.action IS DISTINCT FROM 'file.copy.requested'
  OR a.entity_id IS DISTINCT FROM NEW.id OR a.created_at IS DISTINCT FROM transaction_timestamp()
  OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.requested_by AND status='active') THEN RAISE EXCEPTION 'FILE_COPY_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 NEW.source_fingerprint=encode(sha256(convert_to(actual::text,'UTF8')),'hex');NEW.requested_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER file_copy_request_guard BEFORE INSERT ON public.file_copy_requests FOR EACH ROW EXECUTE FUNCTION public.file_copy_request_guard();
REVOKE ALL ON FUNCTION public.file_copy_source(uuid,integer,uuid,integer,uuid,integer),public.file_copy_request_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.file_copy_source(uuid,integer,uuid,integer,uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 115 $$;

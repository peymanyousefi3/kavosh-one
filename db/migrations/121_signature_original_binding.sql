-- Historical coordination starts remain unbound. Never invent a document
-- retrieval,safe-byte measurement or provider authorization for those rows.
ALTER TABLE public.signature_dispatch_starts
 ADD COLUMN original_copy_id uuid,
 ADD COLUMN original_source jsonb,
 ADD COLUMN original_source_fingerprint text,
 ADD CONSTRAINT dispatch_original_copy FOREIGN KEY(academy_id,original_copy_id) REFERENCES public.file_copy_requests(academy_id,id),
 ADD CONSTRAINT dispatch_original_identity CHECK(
  (original_copy_id IS NULL AND original_source IS NULL AND original_source_fingerprint IS NULL)
  OR(original_copy_id IS NOT NULL AND original_source IS NOT NULL AND original_source_fingerprint IS NOT NULL
   AND original_source_fingerprint~'^[a-f0-9]{64}$'
   AND original_source_fingerprint=encode(sha256(convert_to(original_source::text,'UTF8')),'hex')));
GRANT INSERT(original_copy_id,original_source_fingerprint) ON public.signature_dispatch_starts TO kavosh_runtime;

CREATE FUNCTION public.signature_dispatch_original_source(p_attempt uuid,p_copy uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;a record;r record;b record;s jsonb;BEGIN
 SELECT * INTO a FROM public.signature_send_attempts WHERE academy_id=tenant AND id=p_attempt;
 SELECT * INTO r FROM public.signature_send_requests WHERE academy_id=tenant AND id=a.request_id;
 SELECT v.* INTO b FROM public.agreement_package_contents l JOIN public.agreement_content_bindings v ON v.academy_id=l.academy_id AND v.id=l.binding_id
 WHERE l.academy_id=tenant AND l.id=r.attachment_id AND l.package_id=r.package_id;
 IF a.id IS NULL OR r.id IS NULL OR b.id IS NULL OR NOT public.signature_send_current(r.id) THEN RETURN NULL;END IF;
 s=public.file_download_source(b.file_id,b.file_version,p_copy);
 IF s IS NULL OR s->>'mime' IS DISTINCT FROM 'application/pdf' OR s->>'sha256' IS DISTINCT FROM a.document_sha256
 OR s->>'sha256' IS DISTINCT FROM b.source->>'sha256' OR s->'bytes' IS DISTINCT FROM b.source->'sizeBytes' THEN RETURN NULL;END IF;
 RETURN s;
END $$;
CREATE FUNCTION public.guard_signature_dispatch_original() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b record;c record;s jsonb;fp text;audit record;start record;BEGIN
 IF TG_TABLE_NAME='signature_dispatch_outcomes' THEN
  SELECT * INTO start FROM public.signature_dispatch_starts WHERE academy_id=NEW.academy_id AND id=NEW.start_id;
  IF start.original_copy_id IS NOT NULL THEN
   s=public.signature_dispatch_original_source(start.attempt_id,start.original_copy_id);
   NEW.source_current=NEW.source_current AND s IS NOT NULL AND s IS NOT DISTINCT FROM start.original_source;
  END IF;RETURN NEW;
 END IF;
 IF NEW.original_copy_id IS NULL THEN
  IF NEW.original_source IS NOT NULL OR NEW.original_source_fingerprint IS NOT NULL THEN RAISE EXCEPTION 'SIGNATURE_DISPATCH_ORIGINAL_CHANGED' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 -- Existing start guard already acquired policy/topology/request locks and
 -- validated the current exact approved intention and same-transaction audit.
 SELECT v.file_id,v.file_version INTO b FROM public.signature_send_attempts a JOIN public.signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id
 JOIN public.agreement_package_contents l ON l.academy_id=r.academy_id AND l.id=r.attachment_id AND l.package_id=r.package_id
 JOIN public.agreement_content_bindings v ON v.academy_id=l.academy_id AND v.id=l.binding_id WHERE a.academy_id=NEW.academy_id AND a.id=NEW.attempt_id;
 SELECT route_id INTO c FROM public.file_copy_requests WHERE academy_id=NEW.academy_id AND id=NEW.original_copy_id AND file_id=b.file_id;
 IF c.route_id IS NULL THEN RAISE EXCEPTION 'SIGNATURE_DISPATCH_ORIGINAL_CHANGED' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM public.file_records WHERE academy_id=NEW.academy_id AND id=b.file_id FOR SHARE;
 PERFORM 1 FROM public.file_storage_routes WHERE academy_id=NEW.academy_id AND id=c.route_id FOR SHARE;
 s=public.signature_dispatch_original_source(NEW.attempt_id,NEW.original_copy_id);
 fp=encode(sha256(convert_to(s::text,'UTF8')),'hex');
 SELECT changes INTO audit FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id;
 IF s IS NULL OR NEW.original_source_fingerprint IS DISTINCT FROM fp
 OR audit.changes->>'originalCopyId' IS DISTINCT FROM NEW.original_copy_id::text
 OR audit.changes->>'originalSourceFingerprint' IS DISTINCT FROM fp
 THEN RAISE EXCEPTION 'SIGNATURE_DISPATCH_ORIGINAL_CHANGED' USING ERRCODE='23514';END IF;
 NEW.original_source=s;NEW.original_source_fingerprint=fp;RETURN NEW;
END $$;
-- zz ordering preserves119's audit/source checks before the additional guard.
CREATE TRIGGER zz_signature_dispatch_original_start BEFORE INSERT ON public.signature_dispatch_starts FOR EACH ROW EXECUTE FUNCTION public.guard_signature_dispatch_original();
CREATE TRIGGER zz_signature_dispatch_original_outcome BEFORE INSERT ON public.signature_dispatch_outcomes FOR EACH ROW EXECUTE FUNCTION public.guard_signature_dispatch_original();
REVOKE ALL ON FUNCTION public.signature_dispatch_original_source(uuid,uuid),public.guard_signature_dispatch_original() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_dispatch_original_source(uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 121 $$;

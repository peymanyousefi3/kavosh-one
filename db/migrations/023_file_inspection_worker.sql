DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_file_worker') THEN CREATE ROLE kavosh_file_worker NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_file_policy') THEN CREATE ROLE kavosh_file_policy NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
GRANT kavosh_file_policy TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO kavosh_file_worker,kavosh_file_policy;
CREATE TABLE public.file_inspection_jobs (
 academy_id uuid NOT NULL,inspection_id uuid NOT NULL,state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','evidence_recorded','rejected','failed')),
 attempt_no integer NOT NULL DEFAULT 0 CHECK(attempt_no BETWEEN 0 AND 5),available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 worker_id uuid,lease_token uuid,started_at timestamptz,lease_until timestamptz,last_outcome text,last_reason text,
 PRIMARY KEY(academy_id,inspection_id),FOREIGN KEY(academy_id,inspection_id) REFERENCES public.file_inspection_requests(academy_id,id),
 CHECK((state='running' AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND started_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until>started_at)
  OR(state<>'running' AND worker_id IS NULL AND lease_token IS NULL AND started_at IS NULL AND lease_until IS NULL))
);
CREATE INDEX file_inspection_ready ON public.file_inspection_jobs(available_at,academy_id,inspection_id) WHERE state IN ('queued','running');
CREATE TABLE public.file_inspection_attempts (
 academy_id uuid NOT NULL,inspection_id uuid NOT NULL,attempt_no integer NOT NULL CHECK(attempt_no BETWEEN 1 AND 5),worker_id uuid NOT NULL,
 started_at timestamptz NOT NULL,finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome text NOT NULL CHECK(outcome IN ('no_detection','detected','content_mismatch','unavailable','lease_expired')),
 reason_code text NOT NULL CHECK(reason_code IN ('MEASURED_NO_DETECTION','MEASURED_DETECTION','CONTENT_MISMATCH','STORAGE_UNAVAILABLE','SCANNER_UNAVAILABLE','INSPECTION_TIMEOUT','INSPECTOR_INVALID_RESULT','WORKER_STOPPED','LEASE_EXPIRED','TARGET_UNAVAILABLE')),
 measured_bytes bigint CHECK(measured_bytes BETWEEN 1 AND 4294967296),sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 provider_etag text CHECK(length(provider_etag) BETWEEN 3 AND 202 AND provider_etag ~ '^"[!#-~]+"$'),
 provider_content_type text CHECK(length(provider_content_type) BETWEEN 1 AND 200 AND provider_content_type ~ '^[ -~]+$'),
 PRIMARY KEY(academy_id,inspection_id,attempt_no),FOREIGN KEY(academy_id,inspection_id) REFERENCES public.file_inspection_requests(academy_id,id),
 CHECK(finished_at>=started_at),
 CHECK((outcome IN ('no_detection','detected') AND measured_bytes IS NOT NULL AND sha256 IS NOT NULL AND provider_etag IS NOT NULL AND provider_content_type IS NOT NULL)
  OR(outcome NOT IN ('no_detection','detected') AND measured_bytes IS NULL AND sha256 IS NULL AND provider_etag IS NULL AND provider_content_type IS NULL))
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['file_inspection_jobs','file_inspection_attempts'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['academies','file_records','file_record_revisions','file_inspection_requests','file_inspection_jobs','file_inspection_attempts','outbox_events'] LOOP
  EXECUTE format('CREATE POLICY file_policy_executor ON public.%I TO kavosh_file_policy USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
GRANT SELECT ON public.academies,public.file_records,public.file_record_revisions,public.file_inspection_requests,public.file_inspection_jobs,public.file_inspection_attempts TO kavosh_file_policy;
GRANT INSERT,UPDATE ON public.file_inspection_jobs TO kavosh_file_policy;
GRANT INSERT ON public.file_inspection_attempts,public.outbox_events TO kavosh_file_policy;
GRANT SELECT(academy_id,inspection_id,state,attempt_no,available_at,last_outcome,last_reason) ON public.file_inspection_jobs TO kavosh_runtime;
GRANT SELECT ON public.file_inspection_attempts TO kavosh_runtime;

CREATE FUNCTION public.initialize_file_inspection_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO public.file_inspection_jobs(academy_id,inspection_id) VALUES(NEW.academy_id,NEW.id);RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.initialize_file_inspection_job() FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO kavosh_file_policy;
ALTER FUNCTION public.initialize_file_inspection_job() OWNER TO kavosh_file_policy;
CREATE TRIGGER initialize_file_inspection_job AFTER INSERT ON public.file_inspection_requests
 FOR EACH ROW EXECUTE FUNCTION public.initialize_file_inspection_job();
INSERT INTO public.file_inspection_jobs(academy_id,inspection_id) SELECT request.academy_id,request.id FROM public.file_inspection_requests request;

-- This internal role may lease only the minimal opaque file claims, not query
-- private profiles/credentials or mutate business rows. RLS executor membership
-- belongs only to the NOLOGIN function owner, never to web/worker logins.
CREATE FUNCTION public.claim_file_inspection(p_academies uuid[],p_worker uuid,p_lease_seconds integer)
RETURNS TABLE(academy_id uuid,inspection_id uuid,file_id uuid,storage_target_id text,lease_token uuid,attempt_no integer,expected_bytes bigint,expected_sha256 text,claimed_mime_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job public.file_inspection_jobs; request public.file_inspection_requests; revision jsonb;
BEGIN
 IF p_worker IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 OR p_academies IS NULL OR cardinality(p_academies) NOT BETWEEN 1 AND 1000 OR array_position(p_academies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'INVALID_FILE_WORKER_CLAIM'; END IF;
 SELECT candidate.* INTO job FROM public.file_inspection_jobs candidate
 JOIN public.file_inspection_requests r ON r.academy_id=candidate.academy_id AND r.id=candidate.inspection_id
 JOIN public.academies a ON a.id=candidate.academy_id
 JOIN public.file_records f ON f.academy_id=r.academy_id AND f.id=r.file_id
 WHERE candidate.academy_id=ANY(p_academies) AND a.status IN ('active','read_only') AND NOT f.archived
 AND ((candidate.state='queued' AND candidate.attempt_no<5 AND candidate.available_at<=clock_timestamp()) OR(candidate.state='running' AND candidate.lease_until<=clock_timestamp()))
 ORDER BY candidate.available_at,candidate.academy_id,candidate.inspection_id LIMIT 1 FOR UPDATE OF candidate SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF;
 IF job.state='running' THEN
  INSERT INTO public.file_inspection_attempts(academy_id,inspection_id,attempt_no,worker_id,started_at,outcome,reason_code)
   VALUES(job.academy_id,job.inspection_id,job.attempt_no,job.worker_id,job.started_at,'lease_expired','LEASE_EXPIRED');
  IF job.attempt_no>=5 THEN
   UPDATE public.file_inspection_jobs q SET state='failed',worker_id=NULL,lease_token=NULL,started_at=NULL,lease_until=NULL,last_outcome='lease_expired',last_reason='LEASE_EXPIRED' WHERE q.academy_id=job.academy_id AND q.inspection_id=job.inspection_id;
   SELECT * INTO request FROM public.file_inspection_requests r WHERE r.academy_id=job.academy_id AND r.id=job.inspection_id;
   INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(job.academy_id,gen_random_uuid(),'file.inspection.failed',request.file_id,job.inspection_id);
   -- ponytail: finalize one expired terminal lease per poll; batch only if a
   -- measured crash backlog makes the bounded one-second polling delay material.
   RETURN;
  END IF;
 END IF;
 UPDATE public.file_inspection_jobs q SET state='running',attempt_no=q.attempt_no+1,worker_id=p_worker,lease_token=gen_random_uuid(),started_at=clock_timestamp(),lease_until=clock_timestamp()+p_lease_seconds*interval '1 second'
  WHERE q.academy_id=job.academy_id AND q.inspection_id=job.inspection_id RETURNING q.* INTO job;
 SELECT * INTO request FROM public.file_inspection_requests r WHERE r.academy_id=job.academy_id AND r.id=job.inspection_id;
 SELECT r.definition INTO revision FROM public.file_record_revisions r WHERE r.academy_id=request.academy_id AND r.file_id=request.file_id AND r.version=request.metadata_version;
 RETURN QUERY SELECT job.academy_id,job.inspection_id,request.file_id,request.storage_target_id,job.lease_token,job.attempt_no,(revision->>'expected_bytes')::bigint,revision->>'expected_sha256',revision->>'claimed_mime_type';
END $$;
REVOKE ALL ON FUNCTION public.claim_file_inspection(uuid[],uuid,integer) FROM PUBLIC;
ALTER FUNCTION public.claim_file_inspection(uuid[],uuid,integer) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.claim_file_inspection(uuid[],uuid,integer) TO kavosh_file_worker;

CREATE FUNCTION public.finish_file_inspection(p_academy uuid,p_inspection uuid,p_lease uuid,p_outcome text,p_reason text,p_bytes bigint,p_sha256 text,p_etag text,p_content_type text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job public.file_inspection_jobs; request public.file_inspection_requests; revision jsonb; next_state text;
BEGIN
 SELECT * INTO job FROM public.file_inspection_jobs q WHERE q.academy_id=p_academy AND q.inspection_id=p_inspection FOR UPDATE;
 IF NOT FOUND OR job.state<>'running' OR job.lease_token IS DISTINCT FROM p_lease OR job.lease_until<=clock_timestamp() THEN RETURN false; END IF;
 SELECT * INTO request FROM public.file_inspection_requests r WHERE r.academy_id=job.academy_id AND r.id=job.inspection_id;
 SELECT r.definition INTO revision FROM public.file_record_revisions r WHERE r.academy_id=request.academy_id AND r.file_id=request.file_id AND r.version=request.metadata_version;
 IF p_outcome IN ('no_detection','detected') THEN
  IF p_bytes IS DISTINCT FROM (revision->>'expected_bytes')::bigint OR p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$' OR ((revision->>'expected_sha256') IS NOT NULL AND p_sha256<>(revision->>'expected_sha256'))
   OR p_etag IS NULL OR length(p_etag) NOT BETWEEN 3 AND 202 OR p_etag !~ '^"[!#-~]+"$' OR p_content_type IS NULL OR length(p_content_type) NOT BETWEEN 1 AND 200 OR p_content_type !~ '^[ -~]+$'
   OR p_reason IS DISTINCT FROM (CASE WHEN p_outcome='no_detection' THEN 'MEASURED_NO_DETECTION' ELSE 'MEASURED_DETECTION' END) THEN RAISE EXCEPTION 'INVALID_INSPECTION_RESULT'; END IF;
  next_state:='evidence_recorded';
 ELSIF p_outcome='content_mismatch' AND p_reason='CONTENT_MISMATCH' THEN
  next_state:='rejected';
 ELSIF p_outcome='unavailable' AND p_reason IN ('STORAGE_UNAVAILABLE','SCANNER_UNAVAILABLE','INSPECTION_TIMEOUT','INSPECTOR_INVALID_RESULT','WORKER_STOPPED','TARGET_UNAVAILABLE') THEN
  next_state:=CASE WHEN job.attempt_no>=5 THEN 'failed' ELSE 'queued' END;
 ELSE RAISE EXCEPTION 'INVALID_INSPECTION_RESULT';
 END IF;
 IF p_outcome NOT IN ('no_detection','detected') AND (p_bytes IS NOT NULL OR p_sha256 IS NOT NULL OR p_etag IS NOT NULL OR p_content_type IS NOT NULL) THEN RAISE EXCEPTION 'INVALID_INSPECTION_RESULT'; END IF;
 INSERT INTO public.file_inspection_attempts(academy_id,inspection_id,attempt_no,worker_id,started_at,outcome,reason_code,measured_bytes,sha256,provider_etag,provider_content_type)
 VALUES(job.academy_id,job.inspection_id,job.attempt_no,job.worker_id,job.started_at,p_outcome,p_reason,p_bytes,p_sha256,p_etag,p_content_type);
 UPDATE public.file_inspection_jobs q SET state=next_state,worker_id=NULL,lease_token=NULL,started_at=NULL,lease_until=NULL,last_outcome=p_outcome,last_reason=p_reason,
  available_at=clock_timestamp()+least(900,30*power(2,job.attempt_no-1))::integer*interval '1 second'
 WHERE q.academy_id=job.academy_id AND q.inspection_id=job.inspection_id;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id)
 VALUES(job.academy_id,gen_random_uuid(),CASE WHEN next_state='evidence_recorded' THEN 'file.inspection.evidence.recorded' WHEN next_state IN ('failed','rejected') THEN 'file.inspection.failed' ELSE 'file.inspection.retry.scheduled' END,request.file_id,job.inspection_id);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text) FROM PUBLIC;
ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text) TO kavosh_file_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_file_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 23 $$;
GRANT EXECUTE ON FUNCTION public.schema_revision() TO kavosh_file_worker;

-- Exact private staging receipts,not download/publication/signing authority.
CREATE TABLE public.file_copy_jobs(
 academy_id uuid NOT NULL,copy_id uuid NOT NULL,state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','verified','blocked','failed','uncertain')),
 attempt_no integer NOT NULL DEFAULT 0 CHECK(attempt_no BETWEEN 0 AND 5),available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 worker_id uuid,lease_token uuid,started_at timestamptz,lease_until timestamptz,last_outcome text,
 PRIMARY KEY(academy_id,copy_id),FOREIGN KEY(academy_id,copy_id) REFERENCES public.file_copy_requests(academy_id,id),
 CHECK((state='running' AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND started_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until>started_at)
  OR(state<>'running' AND worker_id IS NULL AND lease_token IS NULL AND started_at IS NULL AND lease_until IS NULL))
);
CREATE INDEX file_copy_ready ON public.file_copy_jobs(available_at,academy_id,copy_id) WHERE state IN('queued','running');
CREATE TABLE public.file_copy_attempts(
 academy_id uuid NOT NULL,copy_id uuid NOT NULL,attempt_no integer NOT NULL CHECK(attempt_no BETWEEN 1 AND 5),worker_id uuid NOT NULL,
 source_fingerprint text NOT NULL CHECK(source_fingerprint~'^[a-f0-9]{64}$'),started_at timestamptz NOT NULL,finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome text NOT NULL CHECK(outcome IN('written_verified','existing_verified','unavailable','source_mismatch','destination_mismatch','outcome_unknown','lease_expired')),
 sources_current boolean NOT NULL,measured_bytes bigint,sha256 text,source_target_id text,destination_target_id text,source_etag text,destination_etag text,
 PRIMARY KEY(academy_id,copy_id,attempt_no),FOREIGN KEY(academy_id,copy_id) REFERENCES public.file_copy_requests(academy_id,id),CHECK(finished_at>=started_at),
 CHECK((outcome IN('written_verified','existing_verified') AND measured_bytes IS NOT NULL AND sha256 IS NOT NULL AND source_target_id IS NOT NULL AND destination_target_id IS NOT NULL AND source_etag IS NOT NULL AND destination_etag IS NOT NULL AND measured_bytes BETWEEN 1 AND 33554432 AND sha256~'^[a-f0-9]{64}$'
  AND source_target_id~'^[a-f0-9]{64}$' AND destination_target_id~'^[a-f0-9]{64}$' AND source_target_id<>destination_target_id
  AND length(source_etag) BETWEEN 3 AND 202 AND source_etag~'^"[!#-~]+"$' AND length(destination_etag) BETWEEN 3 AND 202 AND destination_etag~'^"[!#-~]+"$')
  OR(outcome NOT IN('written_verified','existing_verified') AND measured_bytes IS NULL AND sha256 IS NULL AND source_target_id IS NULL AND destination_target_id IS NULL AND source_etag IS NULL AND destination_etag IS NULL))
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['file_copy_jobs','file_copy_attempts'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE POLICY file_policy_executor ON public.%I TO kavosh_file_policy USING(true) WITH CHECK(true)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['file_copy_requests','file_storage_routes','file_storage_route_revisions','approval_requests','people','work_engagements'] LOOP
  EXECUTE format('CREATE POLICY file_policy_copy_read ON public.%I FOR SELECT TO kavosh_file_policy USING(true)',t);
 END LOOP;
END $$;
GRANT SELECT ON public.file_copy_jobs,public.file_copy_attempts TO kavosh_runtime;
GRANT SELECT,INSERT,UPDATE ON public.file_copy_jobs TO kavosh_file_policy;
GRANT SELECT,INSERT ON public.file_copy_attempts TO kavosh_file_policy;
GRANT SELECT ON public.file_copy_requests,public.file_storage_routes,public.file_storage_route_revisions,public.file_catalogue TO kavosh_file_policy;
-- PostgreSQL row-share locks require UPDATE privilege. The NOLOGIN function
-- owner receives only immutable IDs;the worker receives neither table grant.
GRANT UPDATE(id) ON public.file_records,public.file_storage_routes TO kavosh_file_policy;
CREATE POLICY file_policy_copy_lock ON public.file_storage_routes FOR UPDATE TO kavosh_file_policy USING(true) WITH CHECK(true);
-- Function owner can resolve current opaque ownership,not private pay/contact data.
GRANT SELECT(academy_id,id,hub_id) ON public.people TO kavosh_file_policy;
GRANT SELECT(academy_id,id,person_id,hub_id) ON public.work_engagements TO kavosh_file_policy;
GRANT SELECT(academy_id,id,status,reviewer_id) ON public.approval_requests TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.file_copy_source(uuid,integer,uuid,integer,uuid,integer),public.work_file_context(uuid) TO kavosh_file_policy;
GRANT CREATE ON SCHEMA public TO kavosh_file_policy;
CREATE FUNCTION public.initialize_file_copy_job() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO public.file_copy_jobs(academy_id,copy_id) VALUES(NEW.academy_id,NEW.id);RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.initialize_file_copy_job() FROM PUBLIC;
ALTER FUNCTION public.initialize_file_copy_job() OWNER TO kavosh_file_policy;
CREATE TRIGGER initialize_file_copy_job AFTER INSERT ON public.file_copy_requests FOR EACH ROW EXECUTE FUNCTION public.initialize_file_copy_job();
-- Historical intentions receive queued work,never fabricated physical receipts.
INSERT INTO public.file_copy_jobs(academy_id,copy_id) SELECT academy_id,id FROM public.file_copy_requests;

CREATE FUNCTION public.claim_file_copy(p_academies uuid[],p_worker uuid,p_lease_seconds integer)
RETURNS TABLE(academy_id uuid,copy_id uuid,file_id uuid,lease_token uuid,attempt_no integer,source_fingerprint text,expected_bytes bigint,expected_sha256 text,source_target_id text,destination_target_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate record;j public.file_copy_jobs;r public.file_copy_requests;actual jsonb;previous_tenant text:=current_setting('app.academy_id',true);
BEGIN
 IF p_worker IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 OR p_academies IS NULL OR cardinality(p_academies) NOT BETWEEN 1 AND 1000 OR array_position(p_academies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'INVALID_FILE_COPY_CLAIM';END IF;
 -- Find first,then acquire policy/topology/file/route/job locks in the same order
 -- as finish;never retain a database connection across storage IO.
 SELECT q.academy_id,q.copy_id INTO candidate FROM public.file_copy_jobs q JOIN public.academies a ON a.id=q.academy_id
 WHERE q.academy_id=ANY(p_academies) AND a.status IN('active','read_only') AND((q.state='queued' AND q.available_at<=clock_timestamp() AND q.attempt_no<5) OR(q.state='running' AND q.lease_until<=clock_timestamp()))
 ORDER BY q.available_at,q.academy_id,q.copy_id LIMIT 1;
 IF NOT FOUND THEN RETURN;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(candidate.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(candidate.academy_id::text,9));
 SELECT * INTO STRICT r FROM public.file_copy_requests c WHERE c.academy_id=candidate.academy_id AND c.id=candidate.copy_id;
 PERFORM 1 FROM public.file_records f WHERE f.academy_id=r.academy_id AND f.id=r.file_id FOR SHARE;
 PERFORM 1 FROM public.file_storage_routes h WHERE h.academy_id=r.academy_id AND h.id=r.route_id FOR SHARE;
 SELECT * INTO j FROM public.file_copy_jobs q WHERE q.academy_id=r.academy_id AND q.copy_id=r.id AND((q.state='queued' AND q.available_at<=clock_timestamp() AND q.attempt_no<5) OR(q.state='running' AND q.lease_until<=clock_timestamp())) FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN;END IF;
 PERFORM set_config('app.academy_id',r.academy_id::text,true);
 actual=public.file_copy_source(r.file_id,r.file_version,r.inspection_id,r.inspection_attempt,r.route_id,r.route_version);
 PERFORM set_config('app.academy_id',coalesce(previous_tenant,''),true);
 IF j.state='running' THEN
  INSERT INTO public.file_copy_attempts(academy_id,copy_id,attempt_no,worker_id,source_fingerprint,started_at,outcome,sources_current)
  VALUES(j.academy_id,j.copy_id,j.attempt_no,j.worker_id,r.source_fingerprint,j.started_at,'lease_expired',actual IS NOT DISTINCT FROM r.source);
  UPDATE public.file_copy_jobs q SET state='uncertain',worker_id=NULL,lease_token=NULL,started_at=NULL,lease_until=NULL,last_outcome='lease_expired' WHERE q.academy_id=r.academy_id AND q.copy_id=r.id;
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(r.academy_id,gen_random_uuid(),'file.copy.uncertain.critical',r.file_id,r.id);RETURN;
 END IF;
 IF actual IS DISTINCT FROM r.source THEN
  UPDATE public.file_copy_jobs q SET state='blocked',last_outcome='source_changed' WHERE q.academy_id=r.academy_id AND q.copy_id=r.id;
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(r.academy_id,gen_random_uuid(),'file.copy.source_changed',r.file_id,r.id);RETURN;
 END IF;
 UPDATE public.file_copy_jobs q SET state='running',attempt_no=q.attempt_no+1,worker_id=p_worker,lease_token=gen_random_uuid(),started_at=clock_timestamp(),lease_until=clock_timestamp()+p_lease_seconds*interval '1 second'
 WHERE q.academy_id=r.academy_id AND q.copy_id=r.id RETURNING q.* INTO j;
 RETURN QUERY SELECT r.academy_id,r.id,r.file_id,j.lease_token,j.attempt_no,r.source_fingerprint,(r.source->>'bytes')::bigint,r.source->>'sha256',r.source->>'sourceTargetId',r.source->>'destinationTargetId';
END $$;
REVOKE ALL ON FUNCTION public.claim_file_copy(uuid[],uuid,integer) FROM PUBLIC;
ALTER FUNCTION public.claim_file_copy(uuid[],uuid,integer) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.claim_file_copy(uuid[],uuid,integer) TO kavosh_file_worker;

CREATE FUNCTION public.finish_file_copy(p_academy uuid,p_copy uuid,p_lease uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.file_copy_requests;j public.file_copy_jobs;actual jsonb;current_source boolean;kind text:=p_result->>'outcome';verified boolean;next_state text;previous_tenant text:=current_setting('app.academy_id',true);
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_academy::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_academy::text,9));
 SELECT * INTO r FROM public.file_copy_requests c WHERE c.academy_id=p_academy AND c.id=p_copy;IF NOT FOUND THEN RETURN false;END IF;
 PERFORM 1 FROM public.file_records f WHERE f.academy_id=r.academy_id AND f.id=r.file_id FOR SHARE;
 PERFORM 1 FROM public.file_storage_routes h WHERE h.academy_id=r.academy_id AND h.id=r.route_id FOR SHARE;
 SELECT * INTO j FROM public.file_copy_jobs q WHERE q.academy_id=p_academy AND q.copy_id=p_copy FOR UPDATE;
 IF NOT FOUND OR j.state<>'running' OR j.lease_token IS DISTINCT FROM p_lease OR j.lease_until<=clock_timestamp() THEN RETURN false;END IF;
 verified=kind IN('written_verified','existing_verified');
 IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR octet_length(p_result::text)>4096 OR kind IS NULL THEN RAISE EXCEPTION 'INVALID_FILE_COPY_RESULT';END IF;
 IF verified THEN
  IF NOT(p_result ?& ARRAY['outcome','bytes','sha256','source','destination']) OR p_result-ARRAY['outcome','bytes','sha256','source','destination']<>'{}'::jsonb
   OR p_result->'bytes' IS DISTINCT FROM r.source->'bytes' OR p_result->'sha256' IS DISTINCT FROM r.source->'sha256'
   OR jsonb_typeof(p_result->'source') IS DISTINCT FROM 'object' OR jsonb_typeof(p_result->'destination') IS DISTINCT FROM 'object'
   OR NOT((p_result->'source') ?& ARRAY['storageTargetId','etag']) OR NOT((p_result->'destination') ?& ARRAY['storageTargetId','etag'])
   OR(p_result->'source')-ARRAY['storageTargetId','etag']<>'{}'::jsonb OR(p_result->'destination')-ARRAY['storageTargetId','etag']<>'{}'::jsonb
   OR p_result#>'{source,storageTargetId}' IS DISTINCT FROM r.source->'sourceTargetId' OR p_result#>'{destination,storageTargetId}' IS DISTINCT FROM r.source->'destinationTargetId'
   OR jsonb_typeof(p_result#>'{source,etag}') IS DISTINCT FROM 'string' OR jsonb_typeof(p_result#>'{destination,etag}') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_FILE_COPY_RESULT';END IF;
 ELSE
  IF kind NOT IN('unavailable','source_mismatch','destination_mismatch','outcome_unknown') OR p_result IS DISTINCT FROM jsonb_build_object('outcome',kind) THEN RAISE EXCEPTION 'INVALID_FILE_COPY_RESULT';END IF;
 END IF;
 PERFORM set_config('app.academy_id',r.academy_id::text,true);actual=public.file_copy_source(r.file_id,r.file_version,r.inspection_id,r.inspection_attempt,r.route_id,r.route_version);
 PERFORM set_config('app.academy_id',coalesce(previous_tenant,''),true);current_source=actual IS NOT DISTINCT FROM r.source;
 next_state=CASE WHEN kind='outcome_unknown' THEN 'uncertain' WHEN NOT current_source THEN 'blocked' WHEN verified THEN 'verified' WHEN kind='unavailable' AND j.attempt_no<5 THEN 'queued' ELSE 'failed' END;
 INSERT INTO public.file_copy_attempts(academy_id,copy_id,attempt_no,worker_id,source_fingerprint,started_at,outcome,sources_current,measured_bytes,sha256,source_target_id,destination_target_id,source_etag,destination_etag)
 VALUES(r.academy_id,r.id,j.attempt_no,j.worker_id,r.source_fingerprint,j.started_at,kind,current_source,CASE WHEN verified THEN(p_result->>'bytes')::bigint END,CASE WHEN verified THEN p_result->>'sha256' END,
 CASE WHEN verified THEN p_result#>>'{source,storageTargetId}' END,CASE WHEN verified THEN p_result#>>'{destination,storageTargetId}' END,CASE WHEN verified THEN p_result#>>'{source,etag}' END,CASE WHEN verified THEN p_result#>>'{destination,etag}' END);
 UPDATE public.file_copy_jobs q SET state=next_state,worker_id=NULL,lease_token=NULL,started_at=NULL,lease_until=NULL,last_outcome=kind,available_at=clock_timestamp()+least(900,30*power(2,j.attempt_no-1))::integer*interval '1 second' WHERE q.academy_id=r.academy_id AND q.copy_id=r.id;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(r.academy_id,gen_random_uuid(),CASE WHEN next_state='uncertain' THEN 'file.copy.uncertain.critical' WHEN next_state='verified' THEN 'file.copy.verified' WHEN next_state='queued' THEN 'file.copy.retry.scheduled' ELSE 'file.copy.blocked' END,r.file_id,r.id);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_file_copy(uuid,uuid,uuid,jsonb) FROM PUBLIC;
ALTER FUNCTION public.finish_file_copy(uuid,uuid,uuid,jsonb) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.finish_file_copy(uuid,uuid,uuid,jsonb) TO kavosh_file_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_file_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 116 $$;

-- Explicit recovery observes the destination only. Never schedule another PUT
-- or infer absence/failure finality from a negative read after an uncertain write.
CREATE TABLE public.file_copy_checks(
 academy_id uuid NOT NULL,id uuid NOT NULL,copy_id uuid NOT NULL,source_fingerprint text NOT NULL CHECK(source_fingerprint~'^[a-f0-9]{64}$'),
 requested_by uuid NOT NULL,audit_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','verified','unresolved','blocked')),attempt_no integer NOT NULL DEFAULT 0 CHECK(attempt_no BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),worker_id uuid,lease_token uuid,started_at timestamptz,lease_until timestamptz,last_outcome text,
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,audit_id),FOREIGN KEY(academy_id,copy_id) REFERENCES public.file_copy_requests(academy_id,id),
 FOREIGN KEY(academy_id,requested_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id),
 CHECK((state='running' AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND started_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until>started_at)
 OR(state<>'running' AND worker_id IS NULL AND lease_token IS NULL AND started_at IS NULL AND lease_until IS NULL))
);
CREATE UNIQUE INDEX file_copy_check_active ON public.file_copy_checks(academy_id,copy_id) WHERE state IN('queued','running');
CREATE INDEX file_copy_check_history ON public.file_copy_checks(academy_id,copy_id,id);
CREATE INDEX file_copy_check_ready ON public.file_copy_checks(available_at,academy_id,id) WHERE state IN('queued','running');
CREATE TABLE public.file_copy_check_attempts(
 academy_id uuid NOT NULL,check_id uuid NOT NULL,attempt_no integer NOT NULL CHECK(attempt_no BETWEEN 1 AND 5),worker_id uuid NOT NULL,
 started_at timestamptz NOT NULL,finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),outcome text NOT NULL CHECK(outcome IN('verified','unavailable','mismatch','lease_expired')),
 sources_current boolean NOT NULL,measured_bytes bigint,sha256 text,destination_target_id text,destination_etag text,
 PRIMARY KEY(academy_id,check_id,attempt_no),FOREIGN KEY(academy_id,check_id) REFERENCES public.file_copy_checks(academy_id,id),CHECK(finished_at>=started_at),
 CHECK((outcome='verified' AND measured_bytes IS NOT NULL AND measured_bytes BETWEEN 1 AND 33554432 AND sha256 IS NOT NULL AND sha256~'^[a-f0-9]{64}$'
  AND destination_target_id IS NOT NULL AND destination_target_id~'^[a-f0-9]{64}$' AND destination_etag IS NOT NULL AND length(destination_etag) BETWEEN 3 AND 202 AND destination_etag~'^"[!#-~]+"$')
 OR(outcome<>'verified' AND measured_bytes IS NULL AND sha256 IS NULL AND destination_target_id IS NULL AND destination_etag IS NULL))
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['file_copy_checks','file_copy_check_attempts'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY file_policy_executor ON public.%I TO kavosh_file_policy USING(true) WITH CHECK(true)',t);
END LOOP;END $$;
GRANT SELECT(academy_id,id,copy_id,source_fingerprint,requested_by,audit_id,reason,requested_at,state,attempt_no,available_at,last_outcome) ON public.file_copy_checks TO kavosh_runtime;
GRANT INSERT(academy_id,id,copy_id,requested_by,audit_id,reason) ON public.file_copy_checks TO kavosh_runtime;
GRANT SELECT(academy_id,check_id,attempt_no,started_at,finished_at,outcome,sources_current,measured_bytes) ON public.file_copy_check_attempts TO kavosh_runtime;
GRANT SELECT,UPDATE ON public.file_copy_checks TO kavosh_file_policy;
GRANT SELECT,INSERT ON public.file_copy_check_attempts TO kavosh_file_policy;
GRANT SELECT(status) ON public.people TO kavosh_file_policy;
GRANT SELECT(academy_id,id,actor_id,action,entity_id,created_at) ON public.audit_events TO kavosh_file_policy;
CREATE POLICY file_policy_copy_check_audit ON public.audit_events FOR SELECT TO kavosh_file_policy USING(true);
GRANT CREATE ON SCHEMA public TO kavosh_file_policy;
CREATE FUNCTION public.file_copy_check_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.file_copy_requests;a record;actual jsonb;status text;
BEGIN
 IF NEW.academy_id IS DISTINCT FROM nullif(current_setting('app.academy_id',true),'')::uuid THEN RAISE EXCEPTION 'FILE_COPY_CHECK_NOT_READY' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 SELECT * INTO r FROM public.file_copy_requests c WHERE c.academy_id=NEW.academy_id AND c.id=NEW.copy_id;
 PERFORM 1 FROM public.file_records f WHERE f.academy_id=r.academy_id AND f.id=r.file_id FOR SHARE;
 PERFORM 1 FROM public.file_storage_routes h WHERE h.academy_id=r.academy_id AND h.id=r.route_id FOR SHARE;
 SELECT j.state INTO status FROM public.file_copy_jobs j WHERE j.academy_id=r.academy_id AND j.copy_id=r.id FOR UPDATE;
 SELECT * INTO a FROM(SELECT id,actor_id,action,entity_id,created_at FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id) x;
 actual=public.file_copy_source(r.file_id,r.file_version,r.inspection_id,r.inspection_attempt,r.route_id,r.route_version);
 IF r.id IS NULL OR status IS DISTINCT FROM 'uncertain' OR actual IS NULL OR actual IS DISTINCT FROM r.source OR a.id IS NULL
  OR a.actor_id IS DISTINCT FROM NEW.requested_by OR a.action IS DISTINCT FROM 'file.copy.reconciliation.requested' OR a.entity_id IS DISTINCT FROM NEW.id OR a.created_at IS DISTINCT FROM transaction_timestamp()
  OR NOT EXISTS(SELECT 1 FROM public.people p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.requested_by AND p.status='active') THEN RAISE EXCEPTION 'FILE_COPY_CHECK_NOT_READY' USING ERRCODE='23514';END IF;
 NEW.source_fingerprint=r.source_fingerprint;NEW.requested_at=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.file_copy_check_guard() FROM PUBLIC;
ALTER FUNCTION public.file_copy_check_guard() OWNER TO kavosh_file_policy;
CREATE TRIGGER file_copy_check_guard BEFORE INSERT ON public.file_copy_checks FOR EACH ROW EXECUTE FUNCTION public.file_copy_check_guard();

CREATE FUNCTION public.claim_file_copy_check(p_academies uuid[],p_worker uuid,p_lease_seconds integer)
RETURNS TABLE(academy_id uuid,check_id uuid,copy_id uuid,file_id uuid,lease_token uuid,attempt_no integer,source_fingerprint text,expected_bytes bigint,expected_sha256 text,destination_target_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate record;c public.file_copy_checks;r public.file_copy_requests;actual jsonb;previous_tenant text:=current_setting('app.academy_id',true);copy_state text;
BEGIN
 IF p_worker IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 OR p_academies IS NULL OR cardinality(p_academies) NOT BETWEEN 1 AND 1000 OR array_position(p_academies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'INVALID_FILE_COPY_CHECK_CLAIM';END IF;
 SELECT q.academy_id,q.id,q.copy_id INTO candidate FROM public.file_copy_checks q JOIN public.academies a ON a.id=q.academy_id
 WHERE q.academy_id=ANY(p_academies) AND a.status IN('active','read_only') AND((q.state='queued' AND q.attempt_no<5 AND q.available_at<=clock_timestamp()) OR(q.state='running' AND q.lease_until<=clock_timestamp()))
 ORDER BY q.available_at,q.academy_id,q.id LIMIT 1;IF NOT FOUND THEN RETURN;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(candidate.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(candidate.academy_id::text,9));
 SELECT * INTO STRICT r FROM public.file_copy_requests q WHERE q.academy_id=candidate.academy_id AND q.id=candidate.copy_id;
 PERFORM 1 FROM public.file_records f WHERE f.academy_id=r.academy_id AND f.id=r.file_id FOR SHARE;
 PERFORM 1 FROM public.file_storage_routes h WHERE h.academy_id=r.academy_id AND h.id=r.route_id FOR SHARE;
 SELECT j.state INTO copy_state FROM public.file_copy_jobs j WHERE j.academy_id=r.academy_id AND j.copy_id=r.id FOR UPDATE;
 SELECT * INTO c FROM public.file_copy_checks q WHERE q.academy_id=candidate.academy_id AND q.id=candidate.id
 AND((q.state='queued' AND q.attempt_no<5 AND q.available_at<=clock_timestamp()) OR(q.state='running' AND q.lease_until<=clock_timestamp())) FOR UPDATE SKIP LOCKED;IF NOT FOUND THEN RETURN;END IF;
 PERFORM set_config('app.academy_id',r.academy_id::text,true);actual=public.file_copy_source(r.file_id,r.file_version,r.inspection_id,r.inspection_attempt,r.route_id,r.route_version);PERFORM set_config('app.academy_id',coalesce(previous_tenant,''),true);
 IF c.state='running' THEN
  INSERT INTO public.file_copy_check_attempts(academy_id,check_id,attempt_no,worker_id,started_at,outcome,sources_current) VALUES(c.academy_id,c.id,c.attempt_no,c.worker_id,c.started_at,'lease_expired',actual IS NOT DISTINCT FROM r.source);
 END IF;
 IF copy_state IS DISTINCT FROM 'uncertain' OR actual IS DISTINCT FROM r.source OR c.attempt_no>=5 THEN
  UPDATE public.file_copy_checks q SET state=CASE WHEN c.attempt_no>=5 THEN 'unresolved' ELSE 'blocked' END,worker_id=NULL,lease_token=NULL,started_at=NULL,lease_until=NULL,last_outcome=CASE WHEN c.attempt_no>=5 THEN 'lease_expired' ELSE 'source_changed' END WHERE q.academy_id=c.academy_id AND q.id=c.id;
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(r.academy_id,gen_random_uuid(),'file.copy.reconciliation.unresolved',r.file_id,c.id);RETURN;
 END IF;
 UPDATE public.file_copy_checks q SET state='running',attempt_no=q.attempt_no+1,worker_id=p_worker,lease_token=gen_random_uuid(),started_at=clock_timestamp(),lease_until=clock_timestamp()+p_lease_seconds*interval '1 second' WHERE q.academy_id=c.academy_id AND q.id=c.id RETURNING q.* INTO c;
 RETURN QUERY SELECT r.academy_id,c.id,r.id,r.file_id,c.lease_token,c.attempt_no,c.source_fingerprint,(r.source->>'bytes')::bigint,r.source->>'sha256',r.source->>'destinationTargetId';
END $$;
REVOKE ALL ON FUNCTION public.claim_file_copy_check(uuid[],uuid,integer) FROM PUBLIC;
ALTER FUNCTION public.claim_file_copy_check(uuid[],uuid,integer) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.claim_file_copy_check(uuid[],uuid,integer) TO kavosh_file_worker;

CREATE FUNCTION public.finish_file_copy_check(p_academy uuid,p_check uuid,p_lease uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.file_copy_checks;r public.file_copy_requests;actual jsonb;current_source boolean;kind text:=p_result->>'outcome';next_state text;copy_state text;previous_tenant text:=current_setting('app.academy_id',true);
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_academy::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_academy::text,9));
 SELECT * INTO c FROM public.file_copy_checks q WHERE q.academy_id=p_academy AND q.id=p_check;IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO STRICT r FROM public.file_copy_requests q WHERE q.academy_id=c.academy_id AND q.id=c.copy_id;
 PERFORM 1 FROM public.file_records f WHERE f.academy_id=r.academy_id AND f.id=r.file_id FOR SHARE;
 PERFORM 1 FROM public.file_storage_routes h WHERE h.academy_id=r.academy_id AND h.id=r.route_id FOR SHARE;
 SELECT j.state INTO copy_state FROM public.file_copy_jobs j WHERE j.academy_id=r.academy_id AND j.copy_id=r.id FOR UPDATE;
 SELECT * INTO c FROM public.file_copy_checks q WHERE q.academy_id=p_academy AND q.id=p_check FOR UPDATE;
 IF c.state<>'running' OR c.lease_token IS DISTINCT FROM p_lease OR c.lease_until<=clock_timestamp() THEN RETURN false;END IF;
 IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR octet_length(p_result::text)>2048 OR kind IS NULL THEN RAISE EXCEPTION 'INVALID_FILE_COPY_CHECK_RESULT';END IF;
 IF kind='verified' THEN
  IF NOT(p_result ?& ARRAY['outcome','bytes','sha256','destination']) OR p_result-ARRAY['outcome','bytes','sha256','destination']<>'{}'::jsonb
  OR p_result->'bytes' IS DISTINCT FROM r.source->'bytes' OR p_result->'sha256' IS DISTINCT FROM r.source->'sha256'
  OR jsonb_typeof(p_result->'destination') IS DISTINCT FROM 'object' OR NOT((p_result->'destination') ?& ARRAY['storageTargetId','etag']) OR(p_result->'destination')-ARRAY['storageTargetId','etag']<>'{}'::jsonb
  OR p_result#>'{destination,storageTargetId}' IS DISTINCT FROM r.source->'destinationTargetId' OR jsonb_typeof(p_result#>'{destination,etag}') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_FILE_COPY_CHECK_RESULT';END IF;
 ELSE IF kind NOT IN('unavailable','mismatch') OR p_result IS DISTINCT FROM jsonb_build_object('outcome',kind) THEN RAISE EXCEPTION 'INVALID_FILE_COPY_CHECK_RESULT';END IF;END IF;
 PERFORM set_config('app.academy_id',r.academy_id::text,true);actual=public.file_copy_source(r.file_id,r.file_version,r.inspection_id,r.inspection_attempt,r.route_id,r.route_version);PERFORM set_config('app.academy_id',coalesce(previous_tenant,''),true);
 current_source=actual IS NOT DISTINCT FROM r.source AND copy_state IS NOT DISTINCT FROM 'uncertain';
 next_state=CASE WHEN NOT current_source THEN 'blocked' WHEN kind='verified' THEN 'verified' WHEN kind='unavailable' AND c.attempt_no<5 THEN 'queued' ELSE 'unresolved' END;
 INSERT INTO public.file_copy_check_attempts(academy_id,check_id,attempt_no,worker_id,started_at,outcome,sources_current,measured_bytes,sha256,destination_target_id,destination_etag)
 VALUES(c.academy_id,c.id,c.attempt_no,c.worker_id,c.started_at,kind,current_source,CASE WHEN kind='verified' THEN(p_result->>'bytes')::bigint END,CASE WHEN kind='verified' THEN p_result->>'sha256' END,CASE WHEN kind='verified' THEN p_result#>>'{destination,storageTargetId}' END,CASE WHEN kind='verified' THEN p_result#>>'{destination,etag}' END);
 UPDATE public.file_copy_checks q SET state=next_state,worker_id=NULL,lease_token=NULL,started_at=NULL,lease_until=NULL,last_outcome=kind,available_at=clock_timestamp()+least(900,30*power(2,c.attempt_no-1))::integer*interval '1 second' WHERE q.academy_id=c.academy_id AND q.id=c.id;
 IF kind='verified' AND copy_state='uncertain' THEN UPDATE public.file_copy_jobs j SET state=CASE WHEN current_source THEN 'verified' ELSE 'blocked' END,last_outcome='destination_reconciled' WHERE j.academy_id=r.academy_id AND j.copy_id=r.id;END IF;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(r.academy_id,gen_random_uuid(),CASE WHEN next_state='verified' THEN 'file.copy.reconciliation.verified' WHEN next_state='queued' THEN 'file.copy.reconciliation.retry.scheduled' ELSE 'file.copy.reconciliation.unresolved' END,r.file_id,c.id);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_file_copy_check(uuid,uuid,uuid,jsonb) FROM PUBLIC;
ALTER FUNCTION public.finish_file_copy_check(uuid,uuid,uuid,jsonb) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.finish_file_copy_check(uuid,uuid,uuid,jsonb) TO kavosh_file_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_file_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 117 $$;

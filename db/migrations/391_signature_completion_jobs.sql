-- Read-only provider reconciliation follows committed original-bound receipts,
-- not callback delivery. No job can send/resend an agreement or clear admission.
-- Quotas leave headroom below 2,000 live / 50 sandbox requests per hour.
-- https://developers.boldsign.com/api-overview/rate-limit
-- An operator can group connectors sharing ONE provider account. Default is one
-- group per academy; shared cross-academy accounts must share the group UUID.
ALTER TABLE public.signature_connections ADD COLUMN completion_budget_group uuid;
CREATE TABLE public.signature_completion_request_budgets(
 group_id uuid PRIMARY KEY,window_started timestamptz NOT NULL,reserved_calls integer NOT NULL CHECK(reserved_calls BETWEEN 0 AND 1600)
);
ALTER TABLE public.signature_completion_request_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_completion_request_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY completion_request_budget_executor ON public.signature_completion_request_budgets TO kavosh_signature_completion_policy USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON public.signature_completion_request_budgets TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,enabled,environment,completion_budget_group) ON public.signature_connections TO kavosh_signature_completion_policy;
CREATE POLICY signature_completion_job_connection_read ON public.signature_connections FOR SELECT TO kavosh_signature_completion_policy USING(true);
CREATE TABLE public.signature_completion_jobs(
 academy_id uuid NOT NULL,purpose text NOT NULL CHECK(purpose IN('unified_enrollment','worker_services')),start_id uuid NOT NULL,
 connection_id uuid NOT NULL,document_id uuid NOT NULL,source_fingerprint text NOT NULL CHECK(source_fingerprint~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),poll_until timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','complete','blocked')),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),priority smallint NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100),attempt_no integer NOT NULL DEFAULT 0 CHECK(attempt_no>=0),failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),
 worker_id uuid,lease_token uuid,started_at timestamptz,lease_until timestamptz,last_finished_at timestamptz,last_outcome text,evidence_id uuid,
 PRIMARY KEY(academy_id,purpose,start_id),FOREIGN KEY(academy_id,connection_id) REFERENCES public.signature_connections(academy_id,id),
 CHECK((state='running' AND worker_id IS NOT NULL AND lease_token IS NOT NULL AND started_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until>started_at) OR(state<>'running' AND worker_id IS NULL AND lease_token IS NULL AND started_at IS NULL AND lease_until IS NULL)),
 CHECK((state='complete')=(evidence_id IS NOT NULL))
);
CREATE INDEX signature_completion_job_ready ON public.signature_completion_jobs(priority DESC,available_at,academy_id,purpose,start_id) WHERE state IN('queued','running');
CREATE INDEX signature_completion_job_document ON public.signature_completion_jobs(academy_id,connection_id,document_id) WHERE state='queued';
CREATE TABLE public.signature_completion_job_attempts(
 academy_id uuid NOT NULL,purpose text NOT NULL,start_id uuid NOT NULL,attempt_no integer NOT NULL CHECK(attempt_no>0),
 worker_id uuid NOT NULL,lease_token uuid NOT NULL,started_at timestamptz NOT NULL,finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome text NOT NULL CHECK(outcome IN('recorded','not_completed','unavailable','source_changed','lease_expired','poll_window_elapsed')),evidence_id uuid,
 PRIMARY KEY(academy_id,purpose,start_id,attempt_no),FOREIGN KEY(academy_id,purpose,start_id) REFERENCES public.signature_completion_jobs(academy_id,purpose,start_id),
 CHECK(finished_at>=started_at),CHECK((outcome='recorded')=(evidence_id IS NOT NULL))
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['signature_completion_jobs','signature_completion_job_attempts'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY signature_completion_job_executor ON public.%I TO kavosh_signature_completion_policy USING(true) WITH CHECK(true)',t);
END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE ON public.signature_completion_jobs TO kavosh_signature_completion_policy;
GRANT SELECT,INSERT ON public.signature_completion_job_attempts TO kavosh_signature_completion_policy;
-- Web users see scoped operational metadata only, never worker identity,
-- lease tokens, source/document/provider routing or credential material.
CREATE POLICY completion_job_tenant_read ON public.signature_completion_jobs FOR SELECT TO kavosh_runtime USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY completion_attempt_tenant_read ON public.signature_completion_job_attempts FOR SELECT TO kavosh_runtime USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT(academy_id,purpose,start_id,created_at,poll_until,state,available_at,attempt_no,failures,last_finished_at,last_outcome,evidence_id) ON public.signature_completion_jobs TO kavosh_runtime;
GRANT SELECT(academy_id,purpose,start_id,attempt_no,started_at,finished_at,outcome,evidence_id) ON public.signature_completion_job_attempts TO kavosh_runtime;
GRANT SELECT(options) ON public.signature_send_requests,public.work_signature_send_requests TO kavosh_signature_completion_policy;
GRANT SELECT(created_at) ON public.signature_dispatch_starts,public.work_signature_dispatch_starts TO kavosh_signature_completion_policy;
GRANT SELECT(id,status) ON public.academies TO kavosh_signature_completion_policy;
CREATE POLICY signature_completion_job_academy_read ON public.academies FOR SELECT TO kavosh_signature_completion_policy USING(true);
GRANT CREATE ON SCHEMA public TO kavosh_signature_completion_policy;

CREATE FUNCTION public.signature_completion_job_source(p_academy uuid,p_purpose text,p_start uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE p_purpose WHEN 'unified_enrollment' THEN public.signature_completion_source(p_academy,p_start) WHEN 'worker_services' THEN public.work_signature_completion_source(p_academy,p_start) END
$$;
CREATE FUNCTION public.signature_completion_job_evidence(p_academy uuid,p_purpose text,p_start uuid,p_source text) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT id FROM(
  SELECT id,recorded_at FROM public.signature_completion_evidence WHERE p_purpose='unified_enrollment' AND academy_id=p_academy AND start_id=p_start AND source_fingerprint=p_source
  UNION ALL SELECT id,recorded_at FROM public.work_signature_completion_evidence WHERE p_purpose='worker_services' AND academy_id=p_academy AND start_id=p_start AND source_fingerprint=p_source
 ) e ORDER BY recorded_at DESC,id DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.signature_completion_job_source(uuid,text,uuid),public.signature_completion_job_evidence(uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_completion_job_source(uuid,text,uuid),public.signature_completion_job_evidence(uuid,text,uuid,text) TO kavosh_signature_completion_policy;

CREATE FUNCTION public.seed_signature_completion_job(p_academy uuid,p_purpose text,p_start uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s jsonb;original_created timestamptz;days integer;e uuid;BEGIN
 s=public.signature_completion_job_source(p_academy,p_purpose,p_start);IF s IS NULL THEN RETURN;END IF;
 IF p_purpose='unified_enrollment' THEN
  SELECT d.created_at,(r.options->>'expiryDays')::integer INTO original_created,days FROM public.signature_dispatch_starts d JOIN public.signature_send_attempts a ON a.academy_id=d.academy_id AND a.id=d.attempt_id JOIN public.signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id WHERE d.academy_id=p_academy AND d.id=p_start;
 ELSE
  SELECT d.created_at,(r.options->>'expiryDays')::integer INTO original_created,days FROM public.work_signature_dispatch_starts d JOIN public.work_signature_send_attempts a ON a.academy_id=d.academy_id AND a.id=d.attempt_id JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id WHERE d.academy_id=p_academy AND d.id=p_start;
 END IF;
 IF original_created IS NULL OR days IS NULL OR days NOT BETWEEN 1 AND 180 THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_JOB_SOURCE_INVALID';END IF;
 e=public.signature_completion_job_evidence(p_academy,p_purpose,p_start,s->>'sourceFingerprint');
 INSERT INTO public.signature_completion_jobs(academy_id,purpose,start_id,connection_id,document_id,source_fingerprint,poll_until,state,evidence_id)
 VALUES(p_academy,p_purpose,p_start,(s->>'connectionId')::uuid,(s->>'documentId')::uuid,s->>'sourceFingerprint',original_created+(days+2)*interval '1 day',CASE WHEN e IS NULL THEN 'queued' ELSE 'complete' END,e) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.seed_signature_completion_job(uuid,text,uuid) FROM PUBLIC;
ALTER FUNCTION public.seed_signature_completion_job(uuid,text,uuid) OWNER TO kavosh_signature_completion_policy;
CREATE FUNCTION public.enqueue_signature_completion_job() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME NOT IN('signature_transport_receipts','work_signature_transport_receipts') THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_TRIGGER_SCOPE_INVALID';END IF;
 IF NEW.state='accepted_for_processing' THEN PERFORM public.seed_signature_completion_job(NEW.academy_id,CASE WHEN TG_TABLE_NAME='signature_transport_receipts' THEN 'unified_enrollment' ELSE 'worker_services' END,NEW.start_id);END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_signature_completion_job() FROM PUBLIC;
ALTER FUNCTION public.enqueue_signature_completion_job() OWNER TO kavosh_signature_completion_policy;
CREATE TRIGGER signature_receipt_completion_job AFTER INSERT ON public.signature_transport_receipts FOR EACH ROW EXECUTE FUNCTION public.enqueue_signature_completion_job();
CREATE TRIGGER work_signature_receipt_completion_job AFTER INSERT ON public.work_signature_transport_receipts FOR EACH ROW EXECUTE FUNCTION public.enqueue_signature_completion_job();

CREATE FUNCTION public.wake_signature_completion_job() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 UPDATE public.signature_completion_jobs j SET available_at=least(j.available_at,greatest(clock_timestamp(),coalesce(j.last_finished_at,'-infinity'::timestamptz)+interval '60 seconds')),priority=greatest(j.priority,CASE WHEN NEW.event_type='Completed' THEN 100 ELSE 10 END)
 WHERE j.academy_id=NEW.academy_id AND j.connection_id=NEW.connection_id AND j.document_id=NEW.resource_id AND NEW.object_type='document' AND j.state='queued';RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.wake_signature_completion_job() FROM PUBLIC;
ALTER FUNCTION public.wake_signature_completion_job() OWNER TO kavosh_signature_completion_policy;
CREATE TRIGGER signature_callback_completion_wakeup AFTER INSERT ON public.signature_webhook_inbox FOR EACH ROW EXECUTE FUNCTION public.wake_signature_completion_job();

CREATE FUNCTION public.claim_signature_completion_job(p_academies uuid[],p_worker uuid,p_lease_seconds integer)
RETURNS TABLE(academy_id uuid,purpose text,start_id uuid,lease_token uuid,source_fingerprint text,attempt_no integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q public.signature_completion_jobs;s jsonb;e uuid;kind text;budget_group uuid;budget_limit integer;used integer;window_start timestamptz:=date_trunc('hour',clock_timestamp());reset_at timestamptz;BEGIN
 IF p_academies IS NULL OR cardinality(p_academies) NOT BETWEEN 1 AND 1000 OR array_position(p_academies,NULL) IS NOT NULL OR p_worker IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 60 AND 600 THEN RAISE EXCEPTION 'INVALID_SIGNATURE_COMPLETION_JOB_CLAIM';END IF;
 -- Bounded cleanup prevents one obsolete head item from starving later work.
 FOR q IN SELECT j.* FROM public.signature_completion_jobs j JOIN public.academies a ON a.id=j.academy_id WHERE j.academy_id=ANY(p_academies) AND a.status IN('active','read_only') AND((j.state='queued' AND j.available_at<=clock_timestamp()) OR(j.state='running' AND j.lease_until<=clock_timestamp())) ORDER BY j.priority DESC,j.available_at,j.academy_id,j.purpose,j.start_id LIMIT 8 FOR UPDATE OF j SKIP LOCKED LOOP
  s=public.signature_completion_job_source(q.academy_id,q.purpose,q.start_id);e=public.signature_completion_job_evidence(q.academy_id,q.purpose,q.start_id,q.source_fingerprint);
  IF q.state='running' THEN
   INSERT INTO public.signature_completion_job_attempts(academy_id,purpose,start_id,attempt_no,worker_id,lease_token,started_at,outcome) VALUES(q.academy_id,q.purpose,q.start_id,q.attempt_no,q.worker_id,q.lease_token,q.started_at,'lease_expired');q.failures=q.failures+1;
  END IF;
  SELECT coalesce(c.completion_budget_group,c.academy_id),CASE WHEN c.environment='Test' THEN 40 ELSE 1600 END INTO budget_group,budget_limit FROM public.signature_connections c WHERE c.academy_id=q.academy_id AND c.id=q.connection_id AND c.enabled;
  kind=CASE WHEN s IS NULL OR s->>'sourceFingerprint' IS DISTINCT FROM q.source_fingerprint OR budget_group IS NULL THEN 'source_changed' WHEN e IS NOT NULL THEN 'recorded' WHEN q.failures>=5 THEN 'lease_expired' WHEN q.poll_until<=clock_timestamp() THEN 'poll_window_elapsed' END;
  IF kind IS NOT NULL THEN
   UPDATE public.signature_completion_jobs j SET state=CASE WHEN kind='recorded' THEN 'complete' ELSE 'blocked' END,evidence_id=CASE WHEN kind='recorded' THEN e END,last_outcome=kind,failures=least(q.failures,5),worker_id=NULL,lease_token=NULL,started_at=NULL,lease_until=NULL WHERE j.academy_id=q.academy_id AND j.purpose=q.purpose AND j.start_id=q.start_id;
   IF kind<>'recorded' THEN
    INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(q.academy_id,gen_random_uuid(),'signature.completion.check.blocked.critical',q.start_id,q.start_id);
    IF NOT FOUND THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_JOB_ALERT_REQUIRED';END IF;
   END IF;CONTINUE;
  END IF;
  -- ponytail: reserve the maximum four GETs before IO. Pending checks may use
  -- only one; per-request metering is warranted if this conservative allowance
  -- limits measured throughput. No provider POST is permitted by the runner.
  INSERT INTO public.signature_completion_request_budgets AS b(group_id,window_started,reserved_calls) VALUES(budget_group,window_start,4)
  ON CONFLICT(group_id) DO UPDATE SET window_started=greatest(b.window_started,EXCLUDED.window_started),reserved_calls=CASE WHEN b.window_started<EXCLUDED.window_started THEN 4 ELSE b.reserved_calls+4 END
  WHERE b.window_started<EXCLUDED.window_started OR b.reserved_calls<=budget_limit-4 RETURNING reserved_calls INTO used;
  IF used IS NULL THEN
   SELECT b.window_started+interval '1 hour' INTO reset_at FROM public.signature_completion_request_budgets b WHERE b.group_id=budget_group;
   UPDATE public.signature_completion_jobs j SET state='queued',failures=q.failures,available_at=greatest(clock_timestamp()+interval '60 seconds',reset_at),worker_id=NULL,lease_token=NULL,started_at=NULL,lease_until=NULL WHERE j.academy_id=q.academy_id AND j.purpose=q.purpose AND j.start_id=q.start_id;CONTINUE;
  END IF;
  UPDATE public.signature_completion_jobs j SET state='running',attempt_no=j.attempt_no+1,failures=q.failures,worker_id=p_worker,lease_token=gen_random_uuid(),started_at=clock_timestamp(),lease_until=clock_timestamp()+p_lease_seconds*interval '1 second' WHERE j.academy_id=q.academy_id AND j.purpose=q.purpose AND j.start_id=q.start_id RETURNING j.* INTO q;
  RETURN QUERY SELECT q.academy_id,q.purpose,q.start_id,q.lease_token,q.source_fingerprint,q.attempt_no;RETURN;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.claim_signature_completion_job(uuid[],uuid,integer) FROM PUBLIC;
ALTER FUNCTION public.claim_signature_completion_job(uuid[],uuid,integer) OWNER TO kavosh_signature_completion_policy;

CREATE FUNCTION public.finish_signature_completion_job(p_academy uuid,p_purpose text,p_start uuid,p_lease uuid,p_outcome text,p_evidence uuid,p_retry_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q public.signature_completion_jobs;s jsonb;kind text;next_state text;fails integer;e uuid;BEGIN
 IF p_purpose NOT IN('unified_enrollment','worker_services') OR p_purpose IS NULL OR p_outcome IS NULL OR p_outcome NOT IN('recorded','not_completed','unavailable') OR(p_outcome='recorded') IS DISTINCT FROM (p_evidence IS NOT NULL) OR p_retry_seconds IS NULL OR p_retry_seconds NOT BETWEEN 60 AND 86400 THEN RAISE EXCEPTION 'INVALID_SIGNATURE_COMPLETION_JOB_RESULT';END IF;
 -- Match the original transport/evidence serialization boundary before row lock.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||CASE WHEN p_purpose='worker_services' THEN ':work-signature-transport:' ELSE ':signature-transport:' END||p_start::text,0));
 SELECT * INTO q FROM public.signature_completion_jobs j WHERE j.academy_id=p_academy AND j.purpose=p_purpose AND j.start_id=p_start FOR UPDATE;
 IF NOT FOUND OR q.state<>'running' OR q.lease_token IS DISTINCT FROM p_lease OR q.lease_until<=clock_timestamp() THEN RETURN false;END IF;
 s=public.signature_completion_job_source(q.academy_id,q.purpose,q.start_id);e=public.signature_completion_job_evidence(q.academy_id,q.purpose,q.start_id,q.source_fingerprint);
 IF p_outcome='recorded' AND NOT(
  (q.purpose='unified_enrollment' AND EXISTS(SELECT 1 FROM public.signature_completion_evidence r WHERE r.academy_id=q.academy_id AND r.start_id=q.start_id AND r.source_fingerprint=q.source_fingerprint AND r.id=p_evidence))
  OR(q.purpose='worker_services' AND EXISTS(SELECT 1 FROM public.work_signature_completion_evidence r WHERE r.academy_id=q.academy_id AND r.start_id=q.start_id AND r.source_fingerprint=q.source_fingerprint AND r.id=p_evidence))
 ) THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_JOB_EVIDENCE_REQUIRED';END IF;
 kind=CASE WHEN s IS NULL OR s->>'sourceFingerprint' IS DISTINCT FROM q.source_fingerprint THEN 'source_changed' WHEN e IS NOT NULL THEN 'recorded' WHEN q.poll_until<=clock_timestamp() THEN 'poll_window_elapsed' ELSE p_outcome END;
 fails=CASE WHEN kind='unavailable' THEN q.failures+1 ELSE 0 END;
 next_state=CASE WHEN kind='recorded' THEN 'complete' WHEN kind IN('source_changed','poll_window_elapsed') OR fails>=5 THEN 'blocked' ELSE 'queued' END;
 INSERT INTO public.signature_completion_job_attempts(academy_id,purpose,start_id,attempt_no,worker_id,lease_token,started_at,outcome,evidence_id) VALUES(q.academy_id,q.purpose,q.start_id,q.attempt_no,q.worker_id,q.lease_token,q.started_at,kind,CASE WHEN kind='recorded' THEN e END);
 UPDATE public.signature_completion_jobs j SET state=next_state,evidence_id=CASE WHEN kind='recorded' THEN e END,failures=fails,priority=0,last_outcome=kind,last_finished_at=clock_timestamp(),available_at=clock_timestamp()+p_retry_seconds*interval '1 second',worker_id=NULL,lease_token=NULL,started_at=NULL,lease_until=NULL WHERE j.academy_id=q.academy_id AND j.purpose=q.purpose AND j.start_id=q.start_id;
 IF next_state='blocked' THEN
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(q.academy_id,gen_random_uuid(),'signature.completion.check.blocked.critical',q.start_id,q.start_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_JOB_ALERT_REQUIRED';END IF;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_signature_completion_job(uuid,text,uuid,uuid,text,uuid,integer) FROM PUBLIC;
ALTER FUNCTION public.finish_signature_completion_job(uuid,text,uuid,uuid,text,uuid,integer) OWNER TO kavosh_signature_completion_policy;
GRANT EXECUTE ON FUNCTION public.claim_signature_completion_job(uuid[],uuid,integer),public.finish_signature_completion_job(uuid,text,uuid,uuid,text,uuid,integer) TO kavosh_signature_completion_worker;

-- Backfill only independently observed, still-valid original-bound receipts.
-- Private seed has no service/user grant; callbacks cannot manufacture jobs.
SELECT public.seed_signature_completion_job(academy_id,'unified_enrollment',start_id) FROM public.signature_transport_receipts WHERE state='accepted_for_processing';
SELECT public.seed_signature_completion_job(academy_id,'worker_services',start_id) FROM public.work_signature_transport_receipts WHERE state='accepted_for_processing';
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_completion_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 391 $$;

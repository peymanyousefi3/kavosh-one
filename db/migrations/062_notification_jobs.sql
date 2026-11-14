DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kavosh_automation_worker') THEN CREATE ROLE kavosh_automation_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kavosh_automation_policy') THEN CREATE ROLE kavosh_automation_policy NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('kavosh_automation_worker','kavosh_automation_policy') AND(rolcanlogin OR rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'UNSAFE_AUTOMATION_ROLE';END IF;
 EXECUTE format('GRANT kavosh_automation_policy TO %I',current_user);
END $$;
GRANT kavosh_runtime TO kavosh_automation_worker;
REVOKE kavosh_automation_worker,kavosh_automation_policy FROM kavosh_runtime;
CREATE TABLE public.notification_jobs(
 academy_id uuid NOT NULL,id uuid NOT NULL,rule_id uuid NOT NULL,rule_version integer NOT NULL,event_id uuid NOT NULL,
 requester_id uuid NOT NULL,requester_kind text NOT NULL CHECK(requester_kind IN('human','bot')),credential_id uuid NOT NULL,user_id uuid,
 locale text NOT NULL CHECK(locale IN('en','fr','zh-CN')),enqueue_request_id uuid NOT NULL,audit_id uuid NOT NULL,generation integer NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 1000),retry_of uuid,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','succeeded','cancelled','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_token uuid,lease_until timestamptz,run_id uuid,last_error text CHECK(last_error~'^[A-Z0-9_]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 day',finished_at timestamptz,
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,rule_id,event_id,requester_id,generation),UNIQUE(academy_id,retry_of),
 FOREIGN KEY(academy_id,retry_of) REFERENCES public.notification_jobs(academy_id,id),CHECK((generation=1)=(retry_of IS NULL)),
 FOREIGN KEY(academy_id,rule_id,rule_version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version),
 FOREIGN KEY(academy_id,event_id) REFERENCES public.automation_event_sources(academy_id,event_id),
 FOREIGN KEY(academy_id,requester_id,requester_kind) REFERENCES public.people(academy_id,id,kind),
 FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id),
 FOREIGN KEY(academy_id,run_id) REFERENCES public.automation_runs(academy_id,id),
 CHECK((requester_kind='human')=(user_id IS NOT NULL)),
 CHECK((status='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(lease_until IS NULL OR lease_until<=expires_at),
 CHECK((status IN('succeeded','cancelled','failed'))=(finished_at IS NOT NULL)),
 CHECK((status='succeeded')=(run_id IS NOT NULL))
);
CREATE INDEX notification_jobs_queued_claim ON public.notification_jobs(academy_id,available_at,id) WHERE status='queued';
CREATE INDEX notification_jobs_running_claim ON public.notification_jobs(academy_id,lease_until,id) WHERE status='running';
CREATE INDEX notification_jobs_owner ON public.notification_jobs(academy_id,requester_id,status);
CREATE INDEX notification_jobs_rule ON public.notification_jobs(academy_id,rule_id,created_at,id);
ALTER TABLE public.notification_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.notification_jobs USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
-- This isolated broker can see queue references across tenants, never domain
-- payloads through this policy. Every claimed domain transaction sets one tenant.
CREATE POLICY automation_broker ON public.notification_jobs TO kavosh_automation_policy USING(true) WITH CHECK(true);
CREATE FUNCTION public.notification_job_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a record;r record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NOTIFICATION_JOB_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':'||NEW.requester_id::text,17));
  SELECT * INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id AND request_id=NEW.enqueue_request_id AND action='notification.queued' AND entity_id=NEW.id AND created_at=transaction_timestamp();
  SELECT version INTO r FROM public.automation_rules WHERE academy_id=NEW.academy_id AND id=NEW.rule_id;
 IF a.id IS NULL OR a.actor_id<>NEW.requester_id OR a.actor_kind<>NEW.requester_kind OR coalesce(a.session_id,a.credential_id)<>NEW.credential_id OR r.version IS DISTINCT FROM NEW.rule_version OR
   (NEW.generation>1 AND NOT EXISTS(SELECT 1 FROM public.notification_jobs prior WHERE prior.academy_id=NEW.academy_id AND prior.id=NEW.retry_of AND prior.rule_id=NEW.rule_id AND prior.event_id=NEW.event_id AND prior.requester_id=NEW.requester_id AND prior.generation=NEW.generation-1 AND prior.status IN('failed','cancelled'))) OR
   NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.requester_id AND status='active' AND auth_user_id IS NOT DISTINCT FROM NEW.user_id) OR
   NEW.status<>'queued' OR NEW.attempts<>0 OR NEW.run_id IS NOT NULL OR NEW.last_error IS NOT NULL OR
   (SELECT count(*) FROM public.notification_jobs WHERE academy_id=NEW.academy_id AND requester_id=NEW.requester_id AND status IN('queued','running'))>=200
   THEN RAISE EXCEPTION 'NOTIFICATION_JOB_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 ELSIF TG_OP='UPDATE' THEN
  IF(to_jsonb(NEW)-ARRAY['status','attempts','available_at','lease_token','lease_until','run_id','last_error','finished_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['status','attempts','available_at','lease_token','lease_until','run_id','last_error','finished_at']) OR OLD.status IN('succeeded','cancelled','failed') THEN RAISE EXCEPTION 'NOTIFICATION_JOB_IMMUTABLE' USING ERRCODE='23514';END IF;
  IF current_user<>'kavosh_automation_policy' THEN
   IF NEW.status<>'cancelled' OR NEW.attempts<>OLD.attempts OR NEW.available_at<>OLD.available_at OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_until IS DISTINCT FROM OLD.lease_until OR NEW.last_error IS DISTINCT FROM OLD.last_error OR NEW.finished_at IS DISTINCT FROM OLD.finished_at OR
    NOT EXISTS(SELECT 1 FROM public.audit_events ev WHERE ev.academy_id=NEW.academy_id AND ev.action='notification.cancelled' AND ev.entity_id=NEW.id AND ev.created_at=transaction_timestamp() AND(ev.actor_id=NEW.requester_id OR(ev.actor_kind='human' AND(EXISTS(SELECT 1 FROM public.academies WHERE master_person_id=ev.actor_id) OR public.is_supervisor(ev.actor_id,NEW.requester_id)))))
    THEN RAISE EXCEPTION 'NOTIFICATION_CANCELLATION_AUTHORITY_REQUIRED' USING ERRCODE='23514';END IF;
   NEW.lease_token=NULL;NEW.lease_until=NULL;NEW.finished_at=clock_timestamp();NEW.last_error='CANCELLED_BY_REQUEST';
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER notification_job_guard BEFORE INSERT OR UPDATE OR DELETE ON public.notification_jobs FOR EACH ROW EXECUTE FUNCTION public.notification_job_guard();
GRANT USAGE ON SCHEMA public,auth_private TO kavosh_automation_policy;
GRANT SELECT,UPDATE ON public.notification_jobs TO kavosh_automation_policy;
GRANT SELECT ON public.people,public.automation_runs TO kavosh_automation_policy;
GRANT SELECT(id,token_hash) ON auth_private.credentials TO kavosh_automation_policy;
GRANT EXECUTE ON FUNCTION public.authenticate_human(uuid,uuid,uuid),public.authenticate_bot(text) TO kavosh_automation_policy;
GRANT SELECT ON public.notification_jobs TO kavosh_runtime;
GRANT INSERT(academy_id,id,rule_id,rule_version,event_id,requester_id,requester_kind,credential_id,user_id,locale,enqueue_request_id,audit_id,generation,retry_of) ON public.notification_jobs TO kavosh_runtime;
GRANT UPDATE(status) ON public.notification_jobs TO kavosh_runtime;

CREATE FUNCTION public.claim_notification_job(academies uuid[]) RETURNS TABLE(id uuid,academy_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF academies IS NULL OR cardinality(academies) NOT BETWEEN 1 AND 1000 OR array_position(academies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'INVALID_ACADEMY_LIST';END IF;
 WITH expired AS(SELECT j.academy_id,j.id FROM public.notification_jobs j WHERE j.academy_id=ANY(academies) AND((j.status='queued' AND j.expires_at<=clock_timestamp()) OR(j.status='running' AND j.lease_until<=clock_timestamp() AND(j.expires_at<=clock_timestamp() OR j.attempts>=5))) ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED LIMIT 100)
 UPDATE public.notification_jobs j SET status=CASE WHEN j.attempts>=5 THEN 'failed' ELSE 'cancelled' END,last_error=CASE WHEN j.attempts>=5 THEN 'ATTEMPTS_EXHAUSTED' ELSE 'JOB_EXPIRED' END,lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp() FROM expired x WHERE j.academy_id=x.academy_id AND j.id=x.id;
 RETURN QUERY WITH selected AS(SELECT j.academy_id,j.id FROM public.notification_jobs j WHERE j.academy_id=ANY(academies) AND j.expires_at>clock_timestamp() AND j.attempts<5 AND j.available_at<=clock_timestamp() AND(j.status='queued' OR(j.status='running' AND j.lease_until<=clock_timestamp())) ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE public.notification_jobs j SET status='running',attempts=j.attempts+1,lease_token=gen_random_uuid(),lease_until=least(j.expires_at,clock_timestamp()+interval '60 seconds') FROM selected s WHERE j.academy_id=s.academy_id AND j.id=s.id RETURNING j.id,j.academy_id,j.lease_token;
END $$;
CREATE FUNCTION public.notification_job_actor(job uuid,lease uuid)
RETURNS TABLE(token_id uuid,academy_id uuid,person_id uuid,capabilities text[],all_hubs boolean,hub_ids uuid[],allowed boolean,kind text,user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j record;h text;
BEGIN
 SELECT source.* INTO j FROM public.notification_jobs source WHERE source.id=job AND source.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND source.status='running' AND source.lease_token=lease AND source.lease_until>clock_timestamp();
 IF j.id IS NULL THEN RETURN;END IF;
 IF j.requester_kind='human' THEN
  RETURN QUERY SELECT c.*,j.requester_kind,j.user_id FROM public.authenticate_human(j.credential_id,j.user_id,j.academy_id) c WHERE c.person_id=j.requester_id;
 ELSE
  SELECT token_hash INTO h FROM auth_private.credentials WHERE id=j.credential_id;
  RETURN QUERY SELECT c.*,j.requester_kind,j.user_id FROM public.authenticate_bot(h) c WHERE c.person_id=j.requester_id AND c.academy_id=j.academy_id;
 END IF;
END $$;
CREATE FUNCTION public.finish_notification_job(job uuid,lease uuid,result text,run uuid,problem text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j record;
BEGIN
 IF result IS NULL OR result NOT IN('succeeded','cancelled','retry') OR problem IS NOT NULL AND problem!~'^[A-Z0-9_]{1,64}$' THEN RAISE EXCEPTION 'INVALID_JOB_RESULT';END IF;
 SELECT * INTO j FROM public.notification_jobs WHERE id=job AND academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND status='running' AND lease_token=lease AND lease_until>clock_timestamp() FOR UPDATE;
 IF j.id IS NULL THEN RETURN false;END IF;
 IF result='succeeded' AND(run IS NULL OR NOT EXISTS(SELECT 1 FROM public.automation_runs WHERE academy_id=j.academy_id AND id=run AND rule_id=j.rule_id AND event_id=j.event_id)) OR result<>'succeeded' AND run IS NOT NULL THEN RAISE EXCEPTION 'JOB_RUN_MISMATCH';END IF;
 UPDATE public.notification_jobs SET status=CASE WHEN result='retry' THEN CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END ELSE result END,
  available_at=CASE WHEN result='retry' THEN clock_timestamp()+least(300,power(2,j.attempts)::integer)*interval '1 second' ELSE available_at END,
  run_id=run,last_error=problem,lease_token=NULL,lease_until=NULL,finished_at=CASE WHEN result='retry' AND attempts<5 THEN NULL ELSE clock_timestamp() END
 WHERE academy_id=j.academy_id AND id=j.id;RETURN true;
END $$;
DO $$ DECLARE signature text;BEGIN FOREACH signature IN ARRAY ARRAY['claim_notification_job(uuid[])','notification_job_actor(uuid,uuid)','finish_notification_job(uuid,uuid,text,uuid,text)'] LOOP
 EXECUTE 'ALTER FUNCTION public.'||signature||' OWNER TO kavosh_automation_policy';
 EXECUTE 'REVOKE ALL ON FUNCTION public.'||signature||' FROM PUBLIC';
 EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||signature||' TO kavosh_automation_worker';
END LOOP;END $$;
REVOKE ALL ON FUNCTION public.notification_job_guard() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 62 $$;

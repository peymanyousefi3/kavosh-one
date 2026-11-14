-- Background financial exports use the existing isolated automation broker,
-- never a stored bearer or an approver's authority. Results remain tenant-bound.
CREATE TABLE public.report_jobs(
 academy_id uuid NOT NULL,id uuid NOT NULL,configuration jsonb NOT NULL,
 requester_id uuid NOT NULL,requester_kind text NOT NULL CHECK(requester_kind IN('human','bot')),credential_id uuid NOT NULL,user_id uuid,
 enqueue_request_id uuid NOT NULL,audit_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','succeeded','cancelled','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_token uuid,lease_until timestamptz,last_error text CHECK(last_error~'^[A-Z0-9_]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 day',finished_at timestamptz,
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,requester_id,requester_kind) REFERENCES public.people(academy_id,id,kind),
 FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id),
 CHECK((requester_kind='human')=(user_id IS NOT NULL)),CHECK((status='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(lease_until IS NULL OR lease_until<=expires_at),CHECK((status IN('succeeded','cancelled','failed'))=(finished_at IS NOT NULL)),
 CHECK(jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=65536)
);
CREATE TABLE public.report_job_results(
 academy_id uuid NOT NULL,job_id uuid NOT NULL,body text NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 4194304),
 filename text NOT NULL CHECK(filename~'^[-a-z0-9_.]{1,156}\.csv$'),sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 authorization_context jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,job_id),FOREIGN KEY(academy_id,job_id) REFERENCES public.report_jobs(academy_id,id)
);
CREATE INDEX report_jobs_claim ON public.report_jobs(academy_id,available_at,id) WHERE status IN('queued','running');
CREATE INDEX report_jobs_owner ON public.report_jobs(academy_id,requester_id,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['report_jobs','report_job_results'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY report_broker ON public.%I TO kavosh_automation_policy USING(true) WITH CHECK(true)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime,kavosh_automation_policy',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,configuration,requester_id,requester_kind,credential_id,user_id,enqueue_request_id,audit_id),UPDATE(status) ON public.report_jobs TO kavosh_runtime;
GRANT UPDATE ON public.report_jobs TO kavosh_automation_policy;
GRANT INSERT ON public.report_job_results TO kavosh_automation_policy;
CREATE FUNCTION public.report_job_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'REPORT_JOB_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':'||NEW.requester_id::text,130));
  SELECT * INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id AND request_id=NEW.enqueue_request_id AND action='report.queued' AND entity_id=NEW.id AND created_at=transaction_timestamp();
  IF a.id IS NULL OR a.actor_id<>NEW.requester_id OR a.actor_kind<>NEW.requester_kind OR coalesce(a.session_id,a.credential_id)<>NEW.credential_id OR a.changes->'configuration' IS DISTINCT FROM NEW.configuration
   OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.requester_id AND status='active' AND auth_user_id IS NOT DISTINCT FROM NEW.user_id)
   OR NEW.configuration->>'reportId' IS NULL OR NEW.configuration->>'reportId' NOT IN('finance.trial-balance','finance.profit-loss','finance.balance-sheet')
   OR NEW.configuration->'queryContractVersion' IS DISTINCT FROM '1'::jsonb OR NEW.configuration-ARRAY['reportId','queryContractVersion','parameters','pathParameters']<>'{}'::jsonb
   OR jsonb_typeof(NEW.configuration->'parameters') IS DISTINCT FROM 'object' OR NEW.configuration->'pathParameters' IS DISTINCT FROM '{}'::jsonb
   OR NEW.status<>'queued' OR NEW.attempts<>0 OR NEW.last_error IS NOT NULL
   OR(SELECT count(*) FROM public.report_jobs WHERE academy_id=NEW.academy_id AND requester_id=NEW.requester_id AND status IN('queued','running'))>=20
   THEN RAISE EXCEPTION 'REPORT_JOB_SOURCE_INVALID' USING ERRCODE='23514';END IF;
  NEW.created_at=clock_timestamp();NEW.available_at=NEW.created_at;NEW.expires_at=NEW.created_at+interval '1 day';
 ELSE
  IF(to_jsonb(NEW)-ARRAY['status','attempts','available_at','lease_token','lease_until','last_error','finished_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['status','attempts','available_at','lease_token','lease_until','last_error','finished_at']) OR OLD.status IN('succeeded','cancelled','failed') THEN RAISE EXCEPTION 'REPORT_JOB_IMMUTABLE' USING ERRCODE='23514';END IF;
  IF current_user<>'kavosh_automation_policy' THEN
   IF NEW.status<>'cancelled' OR(to_jsonb(NEW)-'status') IS DISTINCT FROM(to_jsonb(OLD)-'status') OR NOT EXISTS(SELECT 1 FROM public.audit_events ev WHERE ev.academy_id=NEW.academy_id AND ev.action='report.cancelled' AND ev.entity_id=NEW.id AND ((ev.actor_id=NEW.requester_id AND ev.actor_kind=NEW.requester_kind) OR(ev.actor_kind='human' AND EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=ev.actor_id))) AND ev.created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'REPORT_CANCEL_AUTHORITY_REQUIRED' USING ERRCODE='23514';END IF;
   NEW.lease_token=NULL;NEW.lease_until=NULL;NEW.finished_at=clock_timestamp();NEW.last_error='CANCELLED_BY_REQUEST';
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER report_job_guard BEFORE INSERT OR UPDATE OR DELETE ON public.report_jobs FOR EACH ROW EXECUTE FUNCTION public.report_job_guard();
CREATE FUNCTION public.report_result_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' OR current_user<>'kavosh_automation_policy' THEN RAISE EXCEPTION 'REPORT_RESULT_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.report_jobs WHERE academy_id=NEW.academy_id AND id=NEW.job_id AND status='running' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()) OR NEW.sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.body,'UTF8')),'hex') THEN RAISE EXCEPTION 'REPORT_RESULT_LEASE_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER report_result_guard BEFORE INSERT OR UPDATE OR DELETE ON public.report_job_results FOR EACH ROW EXECUTE FUNCTION public.report_result_guard();
CREATE FUNCTION public.report_result_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.report_jobs j WHERE j.academy_id=NEW.academy_id AND j.id=coalesce(to_jsonb(NEW)->>'job_id',to_jsonb(NEW)->>'id')::uuid AND(j.status='succeeded') IS DISTINCT FROM EXISTS(SELECT 1 FROM public.report_job_results r WHERE r.academy_id=j.academy_id AND r.job_id=j.id)) THEN RAISE EXCEPTION 'REPORT_RESULT_INCOMPLETE' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='report_jobs' AND TG_OP='UPDATE' AND to_jsonb(NEW)->>'status'='succeeded' AND((to_jsonb(OLD)->>'lease_until')::timestamptz<=clock_timestamp() OR(to_jsonb(NEW)->>'expires_at')::timestamptz<=clock_timestamp()) THEN RAISE EXCEPTION 'REPORT_RESULT_DEADLINE_EXPIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_result_complete AFTER INSERT OR UPDATE ON public.report_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.report_result_complete();
CREATE CONSTRAINT TRIGGER report_result_complete AFTER INSERT ON public.report_job_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.report_result_complete();
CREATE FUNCTION public.claim_report_job(academies uuid[]) RETURNS TABLE(id uuid,academy_id uuid,lease_token uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF academies IS NULL OR cardinality(academies) NOT BETWEEN 1 AND 1000 OR array_position(academies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'INVALID_ACADEMY_LIST';END IF;
 WITH expired AS(SELECT j.academy_id,j.id FROM public.report_jobs j WHERE j.academy_id=ANY(academies) AND((j.status='queued' AND j.expires_at<=clock_timestamp()) OR(j.status='running' AND j.lease_until<=clock_timestamp() AND(j.expires_at<=clock_timestamp() OR j.attempts>=5))) ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED LIMIT 100)
 UPDATE public.report_jobs j SET status=CASE WHEN j.attempts>=5 THEN 'failed' ELSE 'cancelled' END,last_error=CASE WHEN j.attempts>=5 THEN 'ATTEMPTS_EXHAUSTED' ELSE 'JOB_EXPIRED' END,lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp() FROM expired x WHERE j.academy_id=x.academy_id AND j.id=x.id;
 RETURN QUERY WITH selected AS(SELECT j.academy_id,j.id FROM public.report_jobs j WHERE j.academy_id=ANY(academies) AND j.expires_at>clock_timestamp() AND j.attempts<5 AND j.available_at<=clock_timestamp() AND(j.status='queued' OR(j.status='running' AND j.lease_until<=clock_timestamp())) ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE public.report_jobs j SET status='running',attempts=j.attempts+1,lease_token=gen_random_uuid(),lease_until=least(j.expires_at,clock_timestamp()+interval '60 seconds') FROM selected s WHERE j.academy_id=s.academy_id AND j.id=s.id RETURNING j.id,j.academy_id,j.lease_token;
END $$;
CREATE FUNCTION public.report_job_actor(job uuid,lease uuid) RETURNS TABLE(token_id uuid,academy_id uuid,person_id uuid,capabilities text[],all_hubs boolean,hub_ids uuid[],allowed boolean,kind text,user_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE j record;h text;BEGIN
 SELECT s.* INTO j FROM public.report_jobs s WHERE s.id=job AND s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.status='running' AND s.lease_token=lease AND s.lease_until>clock_timestamp() AND s.expires_at>clock_timestamp();IF j.id IS NULL THEN RETURN;END IF;
 IF j.requester_kind='human' THEN RETURN QUERY SELECT c.*,j.requester_kind,j.user_id FROM public.authenticate_human(j.credential_id,j.user_id,j.academy_id) c WHERE c.person_id=j.requester_id;
 ELSE SELECT token_hash INTO h FROM auth_private.credentials WHERE id=j.credential_id;RETURN QUERY SELECT c.*,j.requester_kind,j.user_id FROM public.authenticate_bot(h) c WHERE c.person_id=j.requester_id AND c.academy_id=j.academy_id;END IF;
END $$;
CREATE FUNCTION public.finish_report_job(job uuid,lease uuid,result text,problem text,p_body text,p_filename text,p_context jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE j record;BEGIN
 IF result IS NULL OR result NOT IN('succeeded','cancelled','retry') OR(problem IS NOT NULL AND problem!~'^[A-Z0-9_]{1,64}$') THEN RAISE EXCEPTION 'INVALID_JOB_RESULT';END IF;
 SELECT * INTO j FROM public.report_jobs WHERE id=job AND academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND status='running' AND lease_token=lease AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE;IF j.id IS NULL THEN RETURN false;END IF;
 IF result='succeeded' THEN
  IF p_body IS NULL OR p_filename IS NULL OR p_context IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM 'object' OR p_context-ARRAY['hubIds','includesGlobal']<>'{}'::jsonb OR jsonb_typeof(p_context->'hubIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_context->'hubIds')>10000 OR jsonb_typeof(p_context->'includesGlobal') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'REPORT_RESULT_CONTEXT_INVALID';END IF;
  INSERT INTO public.report_job_results(academy_id,job_id,body,filename,sha256,authorization_context) VALUES(j.academy_id,j.id,p_body,p_filename,encode(sha256(convert_to(p_body,'UTF8')),'hex'),p_context);
 ELSIF p_body IS NOT NULL OR p_filename IS NOT NULL OR p_context IS NOT NULL THEN RAISE EXCEPTION 'REPORT_RESULT_UNEXPECTED';END IF;
 UPDATE public.report_jobs SET status=CASE WHEN result='retry' THEN CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END ELSE result END,available_at=CASE WHEN result='retry' THEN clock_timestamp()+least(300,power(2,j.attempts)::integer)*interval '1 second' ELSE available_at END,last_error=problem,lease_token=NULL,lease_until=NULL,finished_at=CASE WHEN result='retry' AND attempts<5 THEN NULL ELSE clock_timestamp() END WHERE academy_id=j.academy_id AND id=j.id;RETURN true;
END $$;
DO $$ DECLARE signature text;BEGIN FOREACH signature IN ARRAY ARRAY['claim_report_job(uuid[])','report_job_actor(uuid,uuid)','finish_report_job(uuid,uuid,text,text,text,text,jsonb)'] LOOP
 EXECUTE 'ALTER FUNCTION public.'||signature||' OWNER TO kavosh_automation_policy';EXECUTE 'REVOKE ALL ON FUNCTION public.'||signature||' FROM PUBLIC';EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||signature||' TO kavosh_automation_worker';END LOOP;END $$;
REVOKE ALL ON FUNCTION public.report_job_guard(),public.report_result_guard(),public.report_result_complete() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 130 $$;

-- Scheduler leases are separate from reviewed configuration. A user stop can
-- acquire NO KEY UPDATE while a prepared child job holds ordinary FK locks.
CREATE TABLE public.report_schedule_work(
 academy_id uuid NOT NULL,schedule_id uuid NOT NULL,version integer NOT NULL,control_version integer NOT NULL,due_at timestamptz NOT NULL,
 lease_token uuid,lease_until timestamptz,attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 5),available_at timestamptz NOT NULL,
 blocked boolean NOT NULL DEFAULT false,last_error text CHECK(last_error~'^[A-Z0-9_]{1,64}$'),
 PRIMARY KEY(academy_id,schedule_id),FOREIGN KEY(academy_id,schedule_id) REFERENCES public.report_schedules(academy_id,id),CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE TABLE public.report_schedule_occurrences(
 academy_id uuid NOT NULL,schedule_id uuid NOT NULL,due_at timestamptz NOT NULL,version integer NOT NULL,control_version integer NOT NULL,
 outcome text NOT NULL CHECK(outcome IN('queued','missed')),job_id uuid,next_due_at timestamptz,created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(academy_id,schedule_id,due_at),UNIQUE(academy_id,job_id),
 FOREIGN KEY(academy_id,schedule_id,version) REFERENCES public.report_schedule_revisions(academy_id,schedule_id,version),FOREIGN KEY(academy_id,job_id) REFERENCES public.report_jobs(academy_id,id),
 CHECK((outcome='queued')=(job_id IS NOT NULL)),CHECK(next_due_at IS NULL OR next_due_at>due_at)
);
CREATE INDEX report_schedules_due ON public.report_schedules(academy_id,next_due_at,id) WHERE status='active';
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['report_schedule_work','report_schedule_occurrences'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime,kavosh_automation_policy',t);
 EXECUTE format('CREATE POLICY scheduler_broker ON public.%I TO kavosh_automation_policy USING(true) WITH CHECK(true)',t);
END LOOP;
FOREACH t IN ARRAY ARRAY['report_schedules','report_schedule_revisions'] LOOP EXECUTE format('CREATE POLICY scheduler_broker ON public.%I TO kavosh_automation_policy USING(true) WITH CHECK(true)',t);END LOOP;END $$;
GRANT SELECT ON public.report_schedules,public.report_schedule_revisions TO kavosh_automation_policy;
GRANT UPDATE(next_due_at,status) ON public.report_schedules TO kavosh_automation_policy;
GRANT INSERT,UPDATE ON public.report_schedule_work TO kavosh_automation_policy;
GRANT INSERT ON public.report_schedule_occurrences TO kavosh_automation_policy;
GRANT SELECT(academy_id,id,created_at,entity_id,action,actor_id,actor_kind,session_id,credential_id,changes) ON public.audit_events TO kavosh_automation_policy;
CREATE TRIGGER report_schedule_occurrences_immutable BEFORE UPDATE OR DELETE ON public.report_schedule_occurrences FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable();

-- Preserve the reviewed-edit/stop guard verbatim, adding only the restricted
-- broker's occurrence-backed advancement branch. Keep the existing function
-- OID, trigger and native approval invariants.
DO $$ DECLARE body text;BEGIN
 body=pg_get_functiondef('public.report_schedule_header_guard()'::regprocedure);
 IF position('DECLARE p record;BEGIN' IN body)=0 THEN RAISE EXCEPTION 'REPORT_SCHEDULE_GUARD_BASE_UNEXPECTED';END IF;
 body=replace(body,'DECLARE p record;BEGIN',$branch$DECLARE p record;BEGIN
 IF TG_OP='UPDATE' AND current_user='kavosh_automation_policy' THEN
  IF (to_jsonb(NEW)-ARRAY['next_due_at','status']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['next_due_at','status']) OR OLD.status<>'active'
   OR NEW.status IS DISTINCT FROM(CASE WHEN NEW.next_due_at IS NULL THEN 'stopped' ELSE 'active' END)
   OR NOT EXISTS(SELECT 1 FROM public.report_schedule_occurrences o WHERE o.academy_id=OLD.academy_id AND o.schedule_id=OLD.id AND o.due_at=OLD.next_due_at AND o.version=OLD.version AND o.control_version=OLD.control_version AND o.next_due_at IS NOT DISTINCT FROM NEW.next_due_at AND o.created_at=transaction_timestamp())
   THEN RAISE EXCEPTION 'REPORT_SCHEDULE_OCCURRENCE_REQUIRED' USING ERRCODE='23514';END IF;
  NEW.stopped_at=CASE WHEN NEW.status='stopped' THEN clock_timestamp() END;RETURN NEW;
 END IF;
 $branch$);EXECUTE body;
END $$;
CREATE FUNCTION public.claim_report_schedule(academies uuid[]) RETURNS TABLE(id uuid,academy_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE s record;BEGIN
 IF academies IS NULL OR cardinality(academies) NOT BETWEEN 1 AND 1000 OR array_position(academies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'INVALID_ACADEMY_LIST';END IF;
 SELECT source.* INTO s FROM public.report_schedules source WHERE source.academy_id=ANY(academies) AND source.status='active' AND source.next_due_at<=clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM public.report_schedule_work w WHERE w.academy_id=source.academy_id AND w.schedule_id=source.id AND w.version=source.version AND w.control_version=source.control_version AND w.due_at=source.next_due_at AND(w.blocked OR w.attempts>=5 OR w.available_at>clock_timestamp() OR w.lease_until>clock_timestamp()))
 ORDER BY source.next_due_at,source.id FOR NO KEY UPDATE SKIP LOCKED LIMIT 1;IF s.id IS NULL THEN RETURN;END IF;
 RETURN QUERY INSERT INTO public.report_schedule_work AS old(academy_id,schedule_id,version,control_version,due_at,lease_token,lease_until,attempts,available_at)
 VALUES(s.academy_id,s.id,s.version,s.control_version,s.next_due_at,gen_random_uuid(),clock_timestamp()+interval '60 seconds',1,clock_timestamp())
 ON CONFLICT ON CONSTRAINT report_schedule_work_pkey DO UPDATE SET version=EXCLUDED.version,control_version=EXCLUDED.control_version,due_at=EXCLUDED.due_at,lease_token=EXCLUDED.lease_token,lease_until=EXCLUDED.lease_until,available_at=EXCLUDED.available_at,blocked=false,last_error=NULL,
 attempts=CASE WHEN old.version=EXCLUDED.version AND old.control_version=EXCLUDED.control_version AND old.due_at=EXCLUDED.due_at THEN old.attempts+1 ELSE 1 END
 RETURNING old.schedule_id,old.academy_id,old.lease_token;
END $$;
CREATE FUNCTION public.report_schedule_actor(schedule uuid,lease uuid,school uuid)
RETURNS TABLE(token_id uuid,academy_id uuid,person_id uuid,capabilities text[],all_hubs boolean,hub_ids uuid[],allowed boolean,kind text,user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE s record;h text;BEGIN
 PERFORM set_config('app.academy_id',school::text,true);
 SELECT source.* INTO s FROM public.report_schedules source JOIN public.report_schedule_work w ON w.academy_id=source.academy_id AND w.schedule_id=source.id AND w.version=source.version AND w.control_version=source.control_version AND w.due_at=source.next_due_at
 WHERE source.id=schedule AND source.academy_id=school AND source.status='active' AND w.lease_token=lease AND w.lease_until>clock_timestamp();IF s.id IS NULL THEN RETURN;END IF;
 IF s.owner_kind='human' THEN RETURN QUERY SELECT c.*,s.owner_kind,s.user_id FROM public.authenticate_human(s.credential_id,s.user_id,s.academy_id) c WHERE c.person_id=s.owner_id;
 ELSE SELECT token_hash INTO h FROM auth_private.credentials WHERE id=s.credential_id;RETURN QUERY SELECT c.*,s.owner_kind,s.user_id FROM public.authenticate_bot(h) c WHERE c.person_id=s.owner_id AND c.academy_id=s.academy_id;END IF;
END $$;
CREATE FUNCTION public.finish_report_schedule(schedule uuid,lease uuid,result text,problem text,next_due timestamptz,job uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE s record;w record;d jsonb;j record;a record;BEGIN
 IF result IS NULL OR result NOT IN('queued','missed','paused','retry') OR(problem IS NOT NULL AND problem!~'^[A-Z0-9_]{1,64}$') OR(result='queued')<>(job IS NOT NULL) OR(result IN('paused','retry') AND next_due IS NOT NULL) THEN RAISE EXCEPTION 'INVALID_SCHEDULE_RESULT';END IF;
 SELECT source.* INTO s FROM public.report_schedules source WHERE source.id=schedule AND source.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND source.status='active' FOR NO KEY UPDATE;
 IF s.id IS NULL THEN RETURN false;END IF;
 SELECT source.* INTO w FROM public.report_schedule_work source WHERE source.academy_id=s.academy_id AND source.schedule_id=s.id AND source.version=s.version AND source.control_version=s.control_version AND source.due_at=s.next_due_at AND source.lease_token=lease AND source.lease_until>clock_timestamp() FOR UPDATE;
 IF w.schedule_id IS NULL THEN RETURN false;END IF;
 IF result IN('queued','missed') THEN
  SELECT definition INTO d FROM public.report_schedule_revisions WHERE academy_id=s.academy_id AND schedule_id=s.id AND version=s.version;
  PERFORM 1 FROM public.report_presets WHERE academy_id=s.academy_id AND id=s.preset_id FOR SHARE;
  IF NOT public.report_job_preset_current(s.preset_id,(d->>'presetVersion')::integer) OR(next_due IS NOT NULL AND next_due<=clock_timestamp()) THEN RAISE EXCEPTION 'REPORT_SCHEDULE_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF result='queued' THEN
   SELECT * INTO j FROM public.report_jobs WHERE academy_id=s.academy_id AND id=job;
   IF j.id IS NULL OR j.requester_id<>s.owner_id OR j.requester_kind<>s.owner_kind OR j.credential_id<>s.credential_id OR j.user_id IS DISTINCT FROM s.user_id OR j.preset_id IS DISTINCT FROM s.preset_id OR j.preset_version IS DISTINCT FROM(d->>'presetVersion')::integer OR j.status<>'queued'
    OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=s.academy_id AND id=j.audit_id AND created_at=transaction_timestamp())
    OR(j.window_resolution IS NOT NULL AND(j.window_resolution->>'resolvedAt')::timestamptz IS DISTINCT FROM w.due_at)
    OR clock_timestamp()>w.due_at+(d#>>'{timing,maxDelayMinutes}')::integer*interval '1 minute' THEN RAISE EXCEPTION 'REPORT_SCHEDULE_JOB_MISMATCH' USING ERRCODE='23514';END IF;
  ELSIF clock_timestamp()<=w.due_at+(d#>>'{timing,maxDelayMinutes}')::integer*interval '1 minute' THEN RAISE EXCEPTION 'REPORT_SCHEDULE_NOT_LATE' USING ERRCODE='23514';END IF;
  SELECT id INTO a FROM public.audit_events WHERE academy_id=s.academy_id AND entity_id=s.id AND action='report.schedule.'||result AND created_at=transaction_timestamp()
   AND actor_id=s.owner_id AND actor_kind=s.owner_kind AND coalesce(session_id,credential_id)=s.credential_id
   AND changes=jsonb_build_object('version',s.version,'controlVersion',s.control_version,'dueAt',to_char(w.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'nextDueAt',CASE WHEN next_due IS NOT NULL THEN to_char(next_due AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,'jobId',job,'backfillPolicy','none','externalRequestMade',false);
  IF a.id IS NULL THEN RAISE EXCEPTION 'REPORT_SCHEDULE_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;
  INSERT INTO public.report_schedule_occurrences(academy_id,schedule_id,due_at,version,control_version,outcome,job_id,next_due_at) VALUES(s.academy_id,s.id,w.due_at,s.version,s.control_version,result,job,next_due);
  UPDATE public.report_schedules SET next_due_at=next_due,status=CASE WHEN next_due IS NULL THEN 'stopped' ELSE 'active' END WHERE academy_id=s.academy_id AND id=s.id;
 END IF;
 UPDATE public.report_schedule_work SET lease_token=NULL,lease_until=NULL,blocked=result='paused' OR(result='retry' AND attempts>=5),last_error=problem,available_at=clock_timestamp()+CASE WHEN result='retry' THEN least(300,power(2,w.attempts)::integer) ELSE 0 END*interval '1 second' WHERE academy_id=s.academy_id AND schedule_id=s.id;RETURN true;
END $$;
DO $$ DECLARE signature text;BEGIN FOREACH signature IN ARRAY ARRAY['claim_report_schedule(uuid[])','report_schedule_actor(uuid,uuid,uuid)','finish_report_schedule(uuid,uuid,text,text,timestamptz,uuid)'] LOOP
 EXECUTE 'ALTER FUNCTION public.'||signature||' OWNER TO kavosh_automation_policy';EXECUTE 'REVOKE ALL ON FUNCTION public.'||signature||' FROM PUBLIC';EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||signature||' TO kavosh_automation_worker';END LOOP;END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 134 $$;

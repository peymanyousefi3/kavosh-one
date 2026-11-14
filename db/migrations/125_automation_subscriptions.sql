-- Transaction snapshots,not time cursors: a late commit must not fall behind
-- a watcher that already observed a newer,earlier-committing event.
ALTER TABLE public.automation_event_sources ADD COLUMN origin_transaction xid8;
ALTER TABLE public.automation_event_sources ALTER COLUMN origin_transaction SET DEFAULT pg_current_xact_id();
CREATE INDEX automation_event_transaction ON public.automation_event_sources(academy_id,origin_transaction,event_id) WHERE origin_transaction IS NOT NULL;
CREATE FUNCTION public.automation_subscription_source(p_rule uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('ruleId',r.id,'hubId',r.hub_id,'version',r.version,'enabled',v.definition->'enabled','mode',v.definition#>'{execution,mode}','schoolActive',a.status='active','hubActive',coalesce(h.active,true))
 FROM public.automation_rules r JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version
 JOIN public.academies a ON a.id=r.academy_id LEFT JOIN public.hubs h ON h.academy_id=r.academy_id AND h.id=r.hub_id WHERE r.id=p_rule
$$;
REVOKE ALL ON FUNCTION public.automation_subscription_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.automation_subscription_source(uuid) TO kavosh_runtime;
CREATE TABLE public.automation_subscriptions(
 academy_id uuid NOT NULL,id uuid NOT NULL,rule_id uuid NOT NULL,rule_version integer NOT NULL,owner_id uuid NOT NULL,owner_kind text NOT NULL CHECK(owner_kind IN('human','bot')),credential_id uuid NOT NULL,user_id uuid,
 locale text NOT NULL CHECK(locale IN('en','fr','zh-CN')),approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 initial_snapshot pg_snapshot NOT NULL DEFAULT pg_current_snapshot(),activation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','stopped','authorization_lost','failed')),failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),lease_token uuid,lease_until timestamptz,last_error text CHECK(last_error~'^[A-Z0-9_]{1,64}$'),stopped_at timestamptz,
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,rule_id,rule_version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version),
 FOREIGN KEY(academy_id,owner_id,owner_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK((owner_kind='human')=(user_id IS NOT NULL)),CHECK((lease_token IS NULL)=(lease_until IS NULL)),CHECK((status='active')=(stopped_at IS NULL))
);
CREATE UNIQUE INDEX automation_subscription_owner_rule ON public.automation_subscriptions(academy_id,owner_id,rule_id) WHERE status='active';
CREATE INDEX automation_subscription_claim ON public.automation_subscriptions(academy_id,available_at,id) WHERE status='active';
CREATE TABLE public.automation_subscription_events(
 academy_id uuid NOT NULL,subscription_id uuid NOT NULL,event_id uuid NOT NULL,rule_version integer NOT NULL,outcome text NOT NULL CHECK(outcome IN('ignored','queued')),job_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,subscription_id,event_id),FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id),
 FOREIGN KEY(academy_id,event_id) REFERENCES public.automation_event_sources(academy_id,event_id),FOREIGN KEY(academy_id,job_id) REFERENCES public.notification_jobs(academy_id,id),CHECK((outcome='queued')=(job_id IS NOT NULL))
);
CREATE FUNCTION public.automation_subscription_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;source jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SUBSCRIPTION_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,26));
  SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
  source=public.automation_subscription_source(NEW.rule_id);
  IF p.id IS NULL OR p.status<>'pending' OR p.action<>'automation.subscription.create' OR p.target_id<>NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'automations.view'
   OR p.requester_id<>NEW.owner_id OR p.requester_kind<>NEW.owner_kind OR p.credential_snapshot->>'token_id' IS DISTINCT FROM NEW.credential_id::text OR p.credential_snapshot->>'person_id' IS DISTINCT FROM NEW.owner_id::text
   OR p.payload IS DISTINCT FROM jsonb_build_object('ruleId',NEW.rule_id,'expectedVersion',NEW.rule_version,'locale',NEW.locale,'reason',NEW.reason)
   OR p.review_context IS DISTINCT FROM jsonb_build_object('source',source) OR source->>'version' IS DISTINCT FROM NEW.rule_version::text OR source->'enabled' IS DISTINCT FROM 'true'::jsonb OR source->>'mode' IS DISTINCT FROM 'automatic' OR source->'schoolActive' IS DISTINCT FROM 'true'::jsonb OR source->'hubActive' IS DISTINCT FROM 'true'::jsonb
   OR NEW.status<>'active' OR NEW.failure_count<>0 OR NEW.lease_token IS NOT NULL OR NEW.last_error IS NOT NULL OR NEW.stopped_at IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.owner_id AND status='active' AND auth_user_id IS NOT DISTINCT FROM NEW.user_id)
   OR(SELECT count(*) FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND status='active')>=200
  THEN RAISE EXCEPTION 'SUBSCRIPTION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  IF(to_jsonb(NEW)-ARRAY['status','failure_count','available_at','lease_token','lease_until','last_error','stopped_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['status','failure_count','available_at','lease_token','lease_until','last_error','stopped_at']) OR OLD.status='stopped' THEN RAISE EXCEPTION 'SUBSCRIPTION_IMMUTABLE' USING ERRCODE='23514';END IF;
  IF current_user<>'kavosh_automation_policy' THEN
   IF NEW.status<>'stopped' OR NEW.failure_count<>OLD.failure_count OR NEW.available_at<>OLD.available_at OR NEW.lease_token IS DISTINCT FROM OLD.lease_token OR NEW.lease_until IS DISTINCT FROM OLD.lease_until OR NEW.last_error IS DISTINCT FROM OLD.last_error OR NEW.stopped_at IS DISTINCT FROM OLD.stopped_at
    OR NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.action='automation.subscription.stopped' AND a.entity_id=NEW.id AND a.created_at=transaction_timestamp() AND(a.actor_id=NEW.owner_id OR(a.actor_kind='human' AND(EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=a.actor_id) OR public.is_supervisor(a.actor_id,NEW.owner_id))))) THEN RAISE EXCEPTION 'SUBSCRIPTION_STOP_AUTHORITY_REQUIRED' USING ERRCODE='23514';END IF;
   NEW.lease_token=NULL;NEW.lease_until=NULL;NEW.stopped_at=clock_timestamp();
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER automation_subscription_guard BEFORE INSERT OR UPDATE OR DELETE ON public.automation_subscriptions FOR EACH ROW EXECUTE FUNCTION public.automation_subscription_guard();
CREATE FUNCTION public.subscription_event_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'SUBSCRIPTION_EVENT_IMMUTABLE' USING ERRCODE='23514';END $$;
CREATE TRIGGER subscription_event_immutable BEFORE UPDATE OR DELETE ON public.automation_subscription_events FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['automation_subscriptions','automation_subscription_events'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
END LOOP;END $$;
CREATE POLICY automation_broker ON public.automation_subscriptions TO kavosh_automation_policy USING(true) WITH CHECK(true);
GRANT SELECT ON public.automation_subscriptions,public.automation_subscription_events TO kavosh_runtime,kavosh_automation_policy;
GRANT UPDATE ON public.automation_subscriptions TO kavosh_automation_policy;
GRANT INSERT ON public.automation_subscription_events TO kavosh_automation_policy;
GRANT SELECT ON public.automation_event_sources,public.automation_rules TO kavosh_automation_policy;
GRANT INSERT(academy_id,id,rule_id,rule_version,owner_id,owner_kind,credential_id,user_id,locale,approval_id,reason) ON public.automation_subscriptions TO kavosh_runtime;
GRANT UPDATE(status) ON public.automation_subscriptions TO kavosh_runtime;
CREATE FUNCTION public.claim_automation_subscription(academies uuid[]) RETURNS TABLE(id uuid,academy_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF academies IS NULL OR cardinality(academies) NOT BETWEEN 1 AND 1000 OR array_position(academies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'INVALID_ACADEMY_LIST';END IF;
 RETURN QUERY WITH chosen AS(SELECT s.academy_id,s.id FROM public.automation_subscriptions s WHERE s.academy_id=ANY(academies) AND s.status='active' AND s.available_at<=clock_timestamp() AND(s.lease_until IS NULL OR s.lease_until<=clock_timestamp()) ORDER BY s.available_at,s.id FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE public.automation_subscriptions s SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds' FROM chosen c WHERE s.academy_id=c.academy_id AND s.id=c.id RETURNING s.id,s.academy_id,s.lease_token;
END $$;
CREATE FUNCTION public.automation_subscription_actor(subscription uuid,lease uuid,school uuid)
RETURNS TABLE(token_id uuid,academy_id uuid,person_id uuid,capabilities text[],all_hubs boolean,hub_ids uuid[],allowed boolean,kind text,user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE s record;h text;BEGIN
 PERFORM set_config('app.academy_id',school::text,true);
 SELECT source.* INTO s FROM public.automation_subscriptions source WHERE source.id=subscription AND source.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND source.status='active' AND source.lease_token=lease AND source.lease_until>clock_timestamp();IF s.id IS NULL THEN RETURN;END IF;
 IF s.owner_kind='human' THEN RETURN QUERY SELECT c.*,s.owner_kind,s.user_id FROM public.authenticate_human(s.credential_id,s.user_id,s.academy_id) c WHERE c.person_id=s.owner_id;
 ELSE SELECT token_hash INTO h FROM auth_private.credentials WHERE id=s.credential_id;RETURN QUERY SELECT c.*,s.owner_kind,s.user_id FROM public.authenticate_bot(h) c WHERE c.person_id=s.owner_id AND c.academy_id=s.academy_id;END IF;
END $$;
CREATE FUNCTION public.finish_automation_subscription(subscription uuid,lease uuid,result text,event uuid,job uuid,revision integer,problem text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE s record;BEGIN
 IF result IS NULL OR result NOT IN('idle','ignored','queued','authorization_lost','retry') OR(problem IS NOT NULL AND problem!~'^[A-Z0-9_]{1,64}$') THEN RAISE EXCEPTION 'INVALID_SUBSCRIPTION_RESULT';END IF;
 SELECT * INTO s FROM public.automation_subscriptions WHERE id=subscription AND academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND status='active' AND lease_token=lease AND lease_until>clock_timestamp() FOR UPDATE;IF s.id IS NULL THEN RETURN false;END IF;
 IF(result IN('ignored','queued'))<>(event IS NOT NULL) OR(result='queued')<>(job IS NOT NULL) THEN RAISE EXCEPTION 'SUBSCRIPTION_EVENT_MISMATCH';END IF;
 IF event IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.automation_event_sources e WHERE e.academy_id=s.academy_id AND e.event_id=event AND e.origin_transaction IS NOT NULL AND e.origin_transaction<>s.activation_transaction AND NOT pg_visible_in_snapshot(e.origin_transaction,s.initial_snapshot)) OR NOT EXISTS(SELECT 1 FROM public.automation_rules WHERE academy_id=s.academy_id AND id=s.rule_id AND version=revision)
   OR(job IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.notification_jobs WHERE academy_id=s.academy_id AND id=job AND rule_id=s.rule_id AND rule_version=revision AND event_id=event AND requester_id=s.owner_id AND credential_id=s.credential_id)) THEN RAISE EXCEPTION 'SUBSCRIPTION_EVENT_MISMATCH';END IF;
  INSERT INTO public.automation_subscription_events(academy_id,subscription_id,event_id,rule_version,outcome,job_id) VALUES(s.academy_id,s.id,event,revision,result,job) ON CONFLICT DO NOTHING;
 END IF;
 UPDATE public.automation_subscriptions SET status=CASE WHEN result='authorization_lost' THEN 'authorization_lost' WHEN result='retry' AND failure_count>=4 THEN 'failed' ELSE 'active' END,
  failure_count=CASE WHEN result='retry' THEN least(5,failure_count+1) ELSE 0 END,available_at=clock_timestamp()+CASE WHEN result='retry' THEN least(300,power(2,s.failure_count+1)::integer) WHEN result='idle' THEN 1 ELSE 0 END*interval '1 second',
  lease_token=NULL,lease_until=NULL,last_error=problem,stopped_at=CASE WHEN result='authorization_lost' OR(result='retry' AND failure_count>=4) THEN clock_timestamp() ELSE NULL END WHERE academy_id=s.academy_id AND id=s.id;RETURN true;
END $$;
DO $$ DECLARE signature text;BEGIN FOREACH signature IN ARRAY ARRAY['claim_automation_subscription(uuid[])','automation_subscription_actor(uuid,uuid,uuid)','finish_automation_subscription(uuid,uuid,text,uuid,uuid,integer,text)'] LOOP
 EXECUTE 'ALTER FUNCTION public.'||signature||' OWNER TO kavosh_automation_policy';EXECUTE 'REVOKE ALL ON FUNCTION public.'||signature||' FROM PUBLIC';EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||signature||' TO kavosh_automation_worker';END LOOP;END $$;
REVOKE ALL ON FUNCTION public.automation_subscription_guard(),public.subscription_event_immutable() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 125 $$;

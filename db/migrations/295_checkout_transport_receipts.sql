-- A separately permissioned service observation,not payment/settlement proof.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_checkout_result_worker') THEN CREATE ROLE kavosh_checkout_result_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_checkout_result_policy') THEN CREATE ROLE kavosh_checkout_result_policy NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
END $$;
GRANT kavosh_checkout_result_policy TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO kavosh_checkout_result_worker,kavosh_checkout_result_policy;
CREATE TABLE public.checkout_transport_receipts(
 academy_id uuid NOT NULL,start_id uuid NOT NULL,worker_id uuid NOT NULL,state text NOT NULL CHECK(state IN('not_attempted','rejected','outcome_unknown','accepted')),
 provider_session_id text CHECK(provider_session_id~'^cs_(test|live)_[A-Za-z0-9]{1,200}$'),checkout_url text CHECK(length(checkout_url)<=8192),
 recorded_by name NOT NULL DEFAULT session_user,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,start_id),FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id),
 CHECK((state='accepted')=(provider_session_id IS NOT NULL)),CHECK(checkout_url IS NULL OR state='accepted')
);
CREATE TABLE public.checkout_transport_conflicts(
 LIKE public.checkout_transport_receipts INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 payload_fingerprint text NOT NULL CHECK(payload_fingerprint~'^[a-f0-9]{64}$'),PRIMARY KEY(academy_id,start_id,payload_fingerprint),
 FOREIGN KEY(academy_id,start_id) REFERENCES public.checkout_transport_receipts(academy_id,start_id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['checkout_transport_receipts','checkout_transport_conflicts'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY checkout_result_executor ON public.%I TO kavosh_checkout_result_policy USING(true) WITH CHECK(true)',t);
 EXECUTE format('GRANT SELECT,INSERT ON public.%I TO kavosh_checkout_result_policy',t);
 -- The general web role gets metadata only,never a bearer hosted link.
 EXECUTE format('GRANT SELECT(academy_id,start_id,worker_id,state,provider_session_id,recorded_by,received_at%s) ON public.%I TO kavosh_runtime',CASE WHEN t='checkout_transport_conflicts' THEN ',payload_fingerprint' ELSE '' END,t);
END LOOP;END $$;
CREATE POLICY checkout_result_start_read ON public.payment_checkout_dispatch_starts FOR SELECT TO kavosh_checkout_result_policy USING(true);
GRANT SELECT(academy_id,id,attempt_id) ON public.payment_checkout_dispatch_starts TO kavosh_checkout_result_policy;
CREATE POLICY checkout_result_attempt_read ON public.payment_checkout_attempts FOR SELECT TO kavosh_checkout_result_policy USING(true);
GRANT SELECT(academy_id,id,source_fingerprint,request_sha256,draft) ON public.payment_checkout_attempts TO kavosh_checkout_result_policy;
CREATE POLICY checkout_result_actor_read ON public.payment_checkout_dispatch_observations FOR SELECT TO kavosh_checkout_result_policy USING(true);
GRANT SELECT(academy_id,start_id,state,provider_session_id) ON public.payment_checkout_dispatch_observations TO kavosh_checkout_result_policy;
CREATE POLICY checkout_result_event_write ON public.outbox_events FOR INSERT TO kavosh_checkout_result_policy WITH CHECK(true);
GRANT INSERT ON public.outbox_events TO kavosh_checkout_result_policy;
GRANT CREATE ON SCHEMA public TO kavosh_checkout_result_policy;
CREATE FUNCTION public.checkout_transport_target_ready(p_academy uuid,p_start uuid,p_hash text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.payment_checkout_dispatch_starts s JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE s.academy_id=p_academy AND s.id=p_start AND a.request_sha256=p_hash)
$$;
CREATE FUNCTION public.record_checkout_transport_receipt(p_academy uuid,p_start uuid,p_worker uuid,p_hash text,p_state text,p_session text,p_url text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing record;d jsonb;fp text;added integer;BEGIN
 IF p_academy IS NULL OR p_start IS NULL OR p_worker IS NULL OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR p_state IS NULL OR p_state NOT IN('not_attempted','rejected','outcome_unknown','accepted')
 OR(p_state='accepted') IS DISTINCT FROM(p_session IS NOT NULL) OR(p_url IS NOT NULL AND(p_state<>'accepted' OR length(p_url)>8192))
 OR(p_session IS NOT NULL AND p_session!~'^cs_(test|live)_[A-Za-z0-9]{1,200}$') THEN RAISE EXCEPTION 'INVALID_CHECKOUT_TRANSPORT_RECEIPT' USING ERRCODE='23514';END IF;
 SELECT a.draft INTO d FROM public.payment_checkout_dispatch_starts s JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE s.academy_id=p_academy AND s.id=p_start AND a.request_sha256=p_hash;
 IF d IS NULL THEN RETURN 'unavailable';END IF;
 IF p_session IS NOT NULL AND NOT starts_with(p_session,CASE WHEN(d->>'livemode')::boolean THEN 'cs_live_' ELSE 'cs_test_' END) THEN RAISE EXCEPTION 'CHECKOUT_TRANSPORT_SESSION_MODE_INVALID' USING ERRCODE='23514';END IF;
 IF p_url IS NOT NULL AND(p_url~'[[:space:][:cntrl:]]' OR p_url!~('^https://checkout[.]stripe[.]com/c/pay/'||p_session||'/?([?#].*)?$')) THEN RAISE EXCEPTION 'CHECKOUT_TRANSPORT_URL_INVALID' USING ERRCODE='23514';END IF;
 -- Start authority is historical. Revoking the actor must not discard real IO.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||':checkout-transport:'||p_start::text,0));
 SELECT state,provider_session_id,checkout_url INTO existing FROM public.checkout_transport_receipts WHERE academy_id=p_academy AND start_id=p_start;
 IF NOT FOUND THEN
  INSERT INTO public.checkout_transport_receipts(academy_id,start_id,worker_id,state,provider_session_id,checkout_url) VALUES(p_academy,p_start,p_worker,p_state,p_session,p_url);
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),'checkout.transport.received',p_start,p_start);
  IF EXISTS(SELECT 1 FROM public.payment_checkout_dispatch_observations WHERE academy_id=p_academy AND start_id=p_start AND(state IS DISTINCT FROM p_state OR provider_session_id IS DISTINCT FROM p_session)) THEN
   INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),'checkout.transport.actor_conflict.critical',p_start,p_start);RETURN 'recorded_conflict';END IF;
  RETURN 'recorded';
 END IF;
 IF existing.state=p_state AND existing.provider_session_id IS NOT DISTINCT FROM p_session AND existing.checkout_url IS NOT DISTINCT FROM p_url THEN
  IF EXISTS(SELECT 1 FROM public.checkout_transport_conflicts WHERE academy_id=p_academy AND start_id=p_start) OR EXISTS(SELECT 1 FROM public.payment_checkout_dispatch_observations WHERE academy_id=p_academy AND start_id=p_start AND(state IS DISTINCT FROM p_state OR provider_session_id IS DISTINCT FROM p_session)) THEN RETURN 'duplicate_conflict';END IF;RETURN 'duplicate';
 END IF;
 fp=encode(sha256(convert_to(jsonb_build_array(1,p_state,p_session,p_url)::text,'UTF8')),'hex');
 INSERT INTO public.checkout_transport_conflicts(academy_id,start_id,worker_id,state,provider_session_id,checkout_url,payload_fingerprint) VALUES(p_academy,p_start,p_worker,p_state,p_session,p_url,fp) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS added=ROW_COUNT;
 IF added=1 THEN INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),'checkout.transport.conflict.critical',p_start,p_start);END IF;RETURN 'conflict';
END $$;
CREATE FUNCTION public.flag_checkout_actor_transport_conflict() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':checkout-transport:'||NEW.start_id::text,0));
 IF EXISTS(SELECT 1 FROM public.checkout_transport_receipts WHERE academy_id=NEW.academy_id AND start_id=NEW.start_id AND(state IS DISTINCT FROM NEW.state OR provider_session_id IS DISTINCT FROM NEW.provider_session_id)) THEN
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(NEW.academy_id,gen_random_uuid(),'checkout.transport.actor_conflict.critical',NEW.start_id,NEW.start_id);END IF;RETURN NEW;
END $$;
ALTER FUNCTION public.checkout_transport_target_ready(uuid,uuid,text) OWNER TO kavosh_checkout_result_policy;
ALTER FUNCTION public.record_checkout_transport_receipt(uuid,uuid,uuid,text,text,text,text) OWNER TO kavosh_checkout_result_policy;
ALTER FUNCTION public.flag_checkout_actor_transport_conflict() OWNER TO kavosh_checkout_result_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_checkout_result_policy;
REVOKE ALL ON FUNCTION public.checkout_transport_target_ready(uuid,uuid,text),public.record_checkout_transport_receipt(uuid,uuid,uuid,text,text,text,text),public.flag_checkout_actor_transport_conflict() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.checkout_transport_target_ready(uuid,uuid,text),public.record_checkout_transport_receipt(uuid,uuid,uuid,text,text,text,text),public.schema_revision() TO kavosh_checkout_result_worker;
CREATE TRIGGER checkout_actor_transport_conflict AFTER INSERT ON public.payment_checkout_dispatch_observations FOR EACH ROW EXECUTE FUNCTION public.flag_checkout_actor_transport_conflict();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 295 $$;

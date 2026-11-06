-- Service observations survive requester/session revocation. They are NOT
-- provider reconciliation,signature completion,delivery or admission proof.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_signature_result_worker') THEN CREATE ROLE kavosh_signature_result_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_signature_result_policy') THEN CREATE ROLE kavosh_signature_result_policy NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
END $$;
GRANT kavosh_signature_result_policy TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO kavosh_signature_result_worker,kavosh_signature_result_policy;
CREATE TABLE public.signature_transport_receipts(
 academy_id uuid NOT NULL,start_id uuid NOT NULL,worker_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN('not_attempted','outcome_unknown','accepted_for_processing')),document_id uuid,
 recorded_by name NOT NULL DEFAULT session_user,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,start_id),FOREIGN KEY(academy_id,start_id) REFERENCES public.signature_dispatch_starts(academy_id,id),
 CHECK((state='accepted_for_processing')=(document_id IS NOT NULL))
);
CREATE TABLE public.signature_transport_conflicts(
 academy_id uuid NOT NULL,start_id uuid NOT NULL,payload_fingerprint text NOT NULL CHECK(payload_fingerprint~'^[a-f0-9]{64}$'),worker_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN('not_attempted','outcome_unknown','accepted_for_processing')),document_id uuid,
 recorded_by name NOT NULL DEFAULT session_user,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,start_id,payload_fingerprint),FOREIGN KEY(academy_id,start_id) REFERENCES public.signature_transport_receipts(academy_id,start_id),
 CHECK((state='accepted_for_processing')=(document_id IS NOT NULL))
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['signature_transport_receipts','signature_transport_conflicts'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY signature_result_executor ON public.%I TO kavosh_signature_result_policy USING(true) WITH CHECK(true)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('GRANT SELECT,INSERT ON public.%I TO kavosh_signature_result_policy',t);
END LOOP;END $$;
CREATE POLICY signature_result_start_read ON public.signature_dispatch_starts FOR SELECT TO kavosh_signature_result_policy USING(true);
GRANT SELECT(academy_id,id,original_copy_id) ON public.signature_dispatch_starts TO kavosh_signature_result_policy;
CREATE POLICY signature_result_actor_read ON public.signature_dispatch_outcomes FOR SELECT TO kavosh_signature_result_policy USING(true);
GRANT SELECT(academy_id,start_id,state,document_id) ON public.signature_dispatch_outcomes TO kavosh_signature_result_policy;
CREATE POLICY signature_result_event_write ON public.outbox_events FOR INSERT TO kavosh_signature_result_policy WITH CHECK(true);
GRANT INSERT ON public.outbox_events TO kavosh_signature_result_policy;
GRANT CREATE ON SCHEMA public TO kavosh_signature_result_policy;
CREATE FUNCTION public.record_signature_transport_receipt(p_academy uuid,p_start uuid,p_worker uuid,p_state text,p_document uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing record;fp text;added integer;BEGIN
 IF p_academy IS NULL OR p_start IS NULL OR p_worker IS NULL OR p_state IS NULL OR p_state NOT IN('not_attempted','outcome_unknown','accepted_for_processing')
 OR(p_state='accepted_for_processing') IS DISTINCT FROM(p_document IS NOT NULL) THEN RAISE EXCEPTION 'INVALID_SIGNATURE_TRANSPORT_RECEIPT' USING ERRCODE='23514';END IF;
 -- Immutable bound start,not current active actor/session,is the prior
 -- authorization fact. Never discard a possibly real effect after revocation.
 IF NOT EXISTS(SELECT 1 FROM public.signature_dispatch_starts WHERE academy_id=p_academy AND id=p_start AND original_copy_id IS NOT NULL) THEN RETURN 'unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||':signature-transport:'||p_start::text,0));
 SELECT state,document_id INTO existing FROM public.signature_transport_receipts WHERE academy_id=p_academy AND start_id=p_start;
 IF NOT FOUND THEN
  INSERT INTO public.signature_transport_receipts(academy_id,start_id,worker_id,state,document_id) VALUES(p_academy,p_start,p_worker,p_state,p_document);
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),'signature.transport.received',p_start,p_start);
  IF EXISTS(SELECT 1 FROM public.signature_dispatch_outcomes WHERE academy_id=p_academy AND start_id=p_start AND(state IS DISTINCT FROM p_state OR document_id IS DISTINCT FROM p_document)) THEN
   INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),'signature.transport.actor_conflict.critical',p_start,p_start);
   RETURN 'recorded_conflict';
  END IF;
  RETURN 'recorded';
 END IF;
 IF existing.state=p_state AND existing.document_id IS NOT DISTINCT FROM p_document THEN
  IF EXISTS(SELECT 1 FROM public.signature_transport_conflicts WHERE academy_id=p_academy AND start_id=p_start)
  OR EXISTS(SELECT 1 FROM public.signature_dispatch_outcomes WHERE academy_id=p_academy AND start_id=p_start AND(state IS DISTINCT FROM p_state OR document_id IS DISTINCT FROM p_document)) THEN RETURN 'duplicate_conflict';END IF;
  RETURN 'duplicate';
 END IF;
 fp=encode(sha256(convert_to(jsonb_build_array(1,p_state,p_document)::text,'UTF8')),'hex');
 INSERT INTO public.signature_transport_conflicts(academy_id,start_id,payload_fingerprint,worker_id,state,document_id) VALUES(p_academy,p_start,fp,p_worker,p_state,p_document) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS added=ROW_COUNT;
 IF added=1 THEN INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),'signature.transport.conflict.critical',p_start,p_start);END IF;
 RETURN 'conflict';
END $$;
CREATE FUNCTION public.flag_signature_actor_transport_conflict() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':signature-transport:'||NEW.start_id::text,0));
 IF EXISTS(SELECT 1 FROM public.signature_transport_receipts WHERE academy_id=NEW.academy_id AND start_id=NEW.start_id AND(state IS DISTINCT FROM NEW.state OR document_id IS DISTINCT FROM NEW.document_id)) THEN
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(NEW.academy_id,gen_random_uuid(),'signature.transport.actor_conflict.critical',NEW.start_id,NEW.start_id);
 END IF;RETURN NEW;
END $$;
ALTER FUNCTION public.flag_signature_actor_transport_conflict() OWNER TO kavosh_signature_result_policy;
REVOKE ALL ON FUNCTION public.flag_signature_actor_transport_conflict() FROM PUBLIC;
CREATE TRIGGER signature_actor_transport_conflict AFTER INSERT ON public.signature_dispatch_outcomes FOR EACH ROW EXECUTE FUNCTION public.flag_signature_actor_transport_conflict();
ALTER FUNCTION public.record_signature_transport_receipt(uuid,uuid,uuid,text,uuid) OWNER TO kavosh_signature_result_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_result_policy;
REVOKE ALL ON FUNCTION public.record_signature_transport_receipt(uuid,uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_signature_transport_receipt(uuid,uuid,uuid,text,uuid),public.schema_revision() TO kavosh_signature_result_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 122 $$;

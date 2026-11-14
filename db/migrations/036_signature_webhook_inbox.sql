DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_signature_ingest') THEN CREATE ROLE kavosh_signature_ingest NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_signature_policy') THEN CREATE ROLE kavosh_signature_policy NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
GRANT kavosh_signature_policy TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO kavosh_signature_ingest,kavosh_signature_policy;
-- Operator registry, not webhook-selected tenant data. No secrets are stored.
CREATE TABLE public.signature_connections(
 id uuid PRIMARY KEY,academy_id uuid NOT NULL REFERENCES public.academies(id),
 region text NOT NULL CHECK(region IN ('US','CA','EU','AU')),environment text NOT NULL CHECK(environment IN ('Test','Live')),client_id uuid,
 enabled boolean NOT NULL DEFAULT false,max_events_per_minute integer NOT NULL DEFAULT 3000 CHECK(max_events_per_minute BETWEEN 1 AND 10000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(academy_id,id)
);
CREATE FUNCTION public.preserve_signature_connection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF (NEW.id,NEW.academy_id,NEW.region,NEW.environment,NEW.client_id) IS DISTINCT FROM (OLD.id,OLD.academy_id,OLD.region,OLD.environment,OLD.client_id) THEN RAISE EXCEPTION 'SIGNATURE_CONNECTION_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.preserve_signature_connection() FROM PUBLIC;
CREATE TRIGGER signature_connection_identity BEFORE UPDATE ON public.signature_connections FOR EACH ROW EXECUTE FUNCTION public.preserve_signature_connection();
CREATE TABLE public.signature_webhook_inbox(
 academy_id uuid NOT NULL,connection_id uuid NOT NULL,event_id uuid NOT NULL,
 event_created bigint NOT NULL CHECK(event_created>=0),signature_timestamp bigint NOT NULL CHECK(signature_timestamp>0),
 environment text NOT NULL CHECK(environment IN ('Test','Live')),client_id uuid,
 event_type text NOT NULL CHECK(event_type~'^[A-Za-z][A-Za-z0-9_.-]{0,99}$' AND event_type<>'Verification'),
 object_type text NOT NULL CHECK(object_type~'^[A-Za-z][A-Za-z0-9_]{0,79}$'),resource_id uuid,
 provider_status text CHECK(length(provider_status) BETWEEN 1 AND 80 AND provider_status~'^[ -~]+$'),
 payload_sha256 text NOT NULL CHECK(payload_sha256~'^[a-f0-9]{64}$'),payload_bytes integer NOT NULL CHECK(payload_bytes BETWEEN 1 AND 1048576),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,connection_id,event_id),FOREIGN KEY(academy_id,connection_id) REFERENCES public.signature_connections(academy_id,id),
 CHECK(event_created<=signature_timestamp+300),CHECK(object_type<>'document' OR resource_id IS NOT NULL)
);
CREATE INDEX signature_webhook_document ON public.signature_webhook_inbox(academy_id,connection_id,resource_id,received_at,event_id);
CREATE TABLE public.signature_webhook_conflicts(
 academy_id uuid NOT NULL,connection_id uuid NOT NULL,event_id uuid NOT NULL,payload_sha256 text NOT NULL CHECK(payload_sha256~'^[a-f0-9]{64}$'),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,connection_id,event_id,payload_sha256),
 FOREIGN KEY(academy_id,connection_id,event_id) REFERENCES public.signature_webhook_inbox(academy_id,connection_id,event_id)
);
CREATE TABLE public.signature_ingest_limits(
 connection_id uuid PRIMARY KEY REFERENCES public.signature_connections(id),window_started timestamptz NOT NULL,attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 10000)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['signature_connections','signature_webhook_inbox','signature_webhook_conflicts'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE POLICY signature_policy_executor ON public.%I TO kavosh_signature_policy USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
ALTER TABLE public.signature_ingest_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_ingest_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY signature_policy_executor ON public.signature_ingest_limits TO kavosh_signature_policy USING(true) WITH CHECK(true);
CREATE POLICY signature_policy_executor ON public.academies TO kavosh_signature_policy USING(true) WITH CHECK(true);
CREATE POLICY signature_policy_executor ON public.outbox_events TO kavosh_signature_policy USING(true) WITH CHECK(true);
GRANT SELECT ON public.academies,public.signature_connections,public.signature_webhook_inbox TO kavosh_signature_policy;
GRANT SELECT ON public.signature_webhook_conflicts TO kavosh_signature_policy;
-- Row-share locks require UPDATE privilege; the NOLOGIN executor exposes no
-- registry UPDATE function and is never inherited by a service login.
GRANT UPDATE(enabled) ON public.signature_connections TO kavosh_signature_policy;
GRANT UPDATE(status) ON public.academies TO kavosh_signature_policy;
GRANT INSERT ON public.signature_webhook_inbox,public.signature_webhook_conflicts,public.outbox_events TO kavosh_signature_policy;
GRANT SELECT,INSERT,UPDATE ON public.signature_ingest_limits TO kavosh_signature_policy;
CREATE FUNCTION public.receive_signature_event(p_connection uuid,p_target text,p_event uuid,p_created bigint,p_signed bigint,p_environment text,p_client uuid,p_type text,p_object text,p_resource uuid,p_status text,p_hash text,p_bytes integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.signature_connections; target text;inserted uuid;prior text;budget integer;
BEGIN
 SELECT sc.* INTO c FROM public.signature_connections sc JOIN public.academies a ON a.id=sc.academy_id
 WHERE sc.id=p_connection AND sc.enabled AND a.status IN ('active','read_only') FOR SHARE OF sc,a;
 IF NOT FOUND THEN RAISE EXCEPTION 'SIGNATURE_CONNECTION_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 target:=encode(sha256(convert_to(format('[1,%s,%s,%s,%s,%s]',to_json(c.id::text),to_json(c.academy_id::text),to_json(c.region),to_json(c.environment),coalesce(to_json(c.client_id::text)::text,'null')),'UTF8')),'hex');
 IF p_target IS DISTINCT FROM target OR p_environment IS DISTINCT FROM c.environment OR p_client IS DISTINCT FROM c.client_id THEN RAISE EXCEPTION 'SIGNATURE_CONNECTION_CHANGED' USING ERRCODE='23514'; END IF;
 IF p_event IS NULL OR p_created IS NULL OR p_signed IS NULL OR abs(extract(epoch FROM clock_timestamp())-p_signed)>300 THEN RAISE EXCEPTION 'SIGNATURE_TIMESTAMP_INVALID' USING ERRCODE='23514'; END IF;
 -- One bounded counter per connection, not an ever-growing minute ledger.
 INSERT INTO public.signature_ingest_limits AS l(connection_id,window_started,attempts) VALUES(c.id,date_trunc('minute',clock_timestamp()),1)
 ON CONFLICT(connection_id) DO UPDATE SET window_started=greatest(l.window_started,EXCLUDED.window_started),
 attempts=CASE WHEN l.window_started<EXCLUDED.window_started THEN 1 ELSE l.attempts+1 END
 WHERE l.window_started<EXCLUDED.window_started OR l.attempts<c.max_events_per_minute RETURNING attempts INTO budget;
 IF budget IS NULL THEN RAISE EXCEPTION 'SIGNATURE_RATE_LIMIT' USING ERRCODE='P0001'; END IF;
 INSERT INTO public.signature_webhook_inbox(academy_id,connection_id,event_id,event_created,signature_timestamp,environment,client_id,event_type,object_type,resource_id,provider_status,payload_sha256,payload_bytes)
 VALUES(c.academy_id,c.id,p_event,p_created,p_signed,p_environment,p_client,p_type,p_object,p_resource,p_status,p_hash,p_bytes)
 ON CONFLICT DO NOTHING RETURNING event_id INTO inserted;
 IF inserted IS NOT NULL THEN
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(c.academy_id,gen_random_uuid(),'signature.webhook.received',p_event,p_event);
  RETURN 'recorded';
 END IF;
 SELECT payload_sha256 INTO prior FROM public.signature_webhook_inbox WHERE academy_id=c.academy_id AND connection_id=c.id AND event_id=p_event;
 IF prior=p_hash THEN RETURN 'duplicate'; END IF;
 INSERT INTO public.signature_webhook_conflicts(academy_id,connection_id,event_id,payload_sha256) VALUES(c.academy_id,c.id,p_event,p_hash)
 ON CONFLICT DO NOTHING RETURNING event_id INTO inserted;
 IF inserted IS NOT NULL THEN
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(c.academy_id,gen_random_uuid(),'signature.webhook.conflict.critical',p_event,p_event);
 END IF;
 RETURN 'conflict';
END $$;
REVOKE ALL ON FUNCTION public.receive_signature_event(uuid,text,uuid,bigint,bigint,text,uuid,text,text,uuid,text,text,integer) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO kavosh_signature_policy;
ALTER FUNCTION public.receive_signature_event(uuid,text,uuid,bigint,bigint,text,uuid,text,text,uuid,text,text,integer) OWNER TO kavosh_signature_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_policy;
GRANT EXECUTE ON FUNCTION public.receive_signature_event(uuid,text,uuid,bigint,bigint,text,uuid,text,text,uuid,text,text,integer) TO kavosh_signature_ingest;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 36 $$;
GRANT EXECUTE ON FUNCTION public.schema_revision() TO kavosh_signature_ingest;

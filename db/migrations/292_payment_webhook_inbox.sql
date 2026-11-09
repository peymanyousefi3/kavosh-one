-- Public callbacks have one narrow native broker, never financial write grants.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_payment_ingest') THEN CREATE ROLE kavosh_payment_ingest NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_payment_policy') THEN CREATE ROLE kavosh_payment_policy NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
GRANT kavosh_payment_policy TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO kavosh_payment_ingest,kavosh_payment_policy;

CREATE TABLE public.payment_connections(
 id uuid PRIMARY KEY,academy_id uuid NOT NULL REFERENCES public.academies(id),
 account_id text NOT NULL CHECK(account_id~'^acct_[A-Za-z0-9]{1,200}$'),livemode boolean NOT NULL,
 api_version text NOT NULL CHECK(api_version='2026-10-28.endive'),
 enabled boolean NOT NULL DEFAULT false,max_events_per_minute integer NOT NULL DEFAULT 3000 CHECK(max_events_per_minute BETWEEN 1 AND 10000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(academy_id,id),UNIQUE(account_id,livemode)
);
CREATE FUNCTION public.preserve_payment_connection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF (NEW.id,NEW.academy_id,NEW.account_id,NEW.livemode,NEW.api_version) IS DISTINCT FROM (OLD.id,OLD.academy_id,OLD.account_id,OLD.livemode,OLD.api_version) THEN RAISE EXCEPTION 'PAYMENT_CONNECTION_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.preserve_payment_connection() FROM PUBLIC;
CREATE TRIGGER payment_connection_identity BEFORE UPDATE ON public.payment_connections FOR EACH ROW EXECUTE FUNCTION public.preserve_payment_connection();
CREATE TABLE public.payment_webhook_inbox(
 academy_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),connection_id uuid NOT NULL,
 event_id text NOT NULL CHECK(event_id~'^evt_[A-Za-z0-9]{1,200}$'),event_created bigint NOT NULL CHECK(event_created BETWEEN 0 AND 9007199254740691),
 signature_timestamp bigint NOT NULL CHECK(signature_timestamp>0),account_id text NOT NULL,livemode boolean NOT NULL,api_version text NOT NULL,
 event_type text NOT NULL,object_type text NOT NULL,resource_id text NOT NULL,
 payload_sha256 text NOT NULL CHECK(payload_sha256~'^[a-f0-9]{64}$'),payload_bytes integer NOT NULL CHECK(payload_bytes BETWEEN 1 AND 1048576),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,connection_id,event_id),
 FOREIGN KEY(academy_id,connection_id) REFERENCES public.payment_connections(academy_id,id),CHECK(event_created<=signature_timestamp+300),
 CHECK((object_type='checkout.session' AND event_type IN ('checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired') AND resource_id~'^cs_(test|live)_[A-Za-z0-9]{1,200}$' AND starts_with(resource_id,CASE WHEN livemode THEN 'cs_live_' ELSE 'cs_test_' END))
 OR (object_type='payment_intent' AND event_type IN ('payment_intent.succeeded','payment_intent.payment_failed','payment_intent.canceled') AND resource_id~'^pi_[A-Za-z0-9]{1,200}$')
 OR (object_type='charge' AND event_type='charge.refunded' AND resource_id~'^ch_[A-Za-z0-9]{1,200}$')
 OR (object_type='refund' AND event_type IN ('refund.created','refund.updated','refund.failed') AND resource_id~'^re_[A-Za-z0-9]{1,200}$')
 OR (object_type='dispute' AND event_type IN ('charge.dispute.created','charge.dispute.updated','charge.dispute.closed') AND resource_id~'^dp_[A-Za-z0-9]{1,200}$')
 OR (object_type='payout' AND event_type IN ('payout.paid','payout.failed','payout.canceled') AND resource_id~'^po_[A-Za-z0-9]{1,200}$'))
);
CREATE INDEX payment_webhook_resource ON public.payment_webhook_inbox(academy_id,connection_id,object_type,resource_id,received_at,id);
CREATE TABLE public.payment_webhook_conflicts(
 academy_id uuid NOT NULL,inbox_id uuid NOT NULL,payload_sha256 text NOT NULL CHECK(payload_sha256~'^[a-f0-9]{64}$'),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,inbox_id,payload_sha256),
 FOREIGN KEY(academy_id,inbox_id) REFERENCES public.payment_webhook_inbox(academy_id,id)
);
CREATE TABLE public.payment_ingest_limits(
 connection_id uuid PRIMARY KEY REFERENCES public.payment_connections(id),window_started timestamptz NOT NULL,attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 10000)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payment_connections','payment_webhook_inbox','payment_webhook_conflicts','payment_ingest_limits'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY payment_policy_executor ON public.%I TO kavosh_payment_policy USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
CREATE POLICY payment_policy_executor ON public.academies TO kavosh_payment_policy USING(true) WITH CHECK(true);
CREATE POLICY payment_policy_executor ON public.outbox_events TO kavosh_payment_policy USING(true) WITH CHECK(true);
GRANT SELECT ON public.academies,public.payment_connections,public.payment_webhook_inbox,public.payment_webhook_conflicts TO kavosh_payment_policy;
-- Only the NOLOGIN native broker can use these lock privileges. It has no
-- authority to update a school's status or connection configuration.
GRANT UPDATE(enabled) ON public.payment_connections TO kavosh_payment_policy;
GRANT UPDATE(status) ON public.academies TO kavosh_payment_policy;
GRANT INSERT ON public.payment_webhook_inbox,public.payment_webhook_conflicts,public.outbox_events TO kavosh_payment_policy;
GRANT SELECT,INSERT,UPDATE ON public.payment_ingest_limits TO kavosh_payment_policy;

CREATE FUNCTION public.receive_payment_event(p_connection uuid,p_target text,p_event text,p_created bigint,p_signed bigint,p_type text,p_object text,p_resource text,p_live boolean,p_version text,p_hash text,p_bytes integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.payment_connections;target text;inserted uuid;prior public.payment_webhook_inbox;budget integer;
BEGIN
 SELECT pc.* INTO c FROM public.payment_connections pc JOIN public.academies a ON a.id=pc.academy_id
 WHERE pc.id=p_connection AND pc.enabled AND a.status IN ('active','read_only') FOR SHARE OF pc,a;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_CONNECTION_UNAVAILABLE' USING ERRCODE='23514'; END IF;
 target:=encode(sha256(convert_to(format('[1,%s,%s,%s,%s,%s]',to_json(c.id::text),to_json(c.academy_id::text),to_json(c.account_id),to_json(c.livemode),to_json(c.api_version)),'UTF8')),'hex');
 IF p_target IS DISTINCT FROM target OR p_live IS DISTINCT FROM c.livemode OR p_version IS DISTINCT FROM c.api_version THEN RAISE EXCEPTION 'PAYMENT_CONNECTION_CHANGED' USING ERRCODE='23514'; END IF;
 IF p_event IS NULL OR p_created IS NULL OR p_signed IS NULL OR p_signed NOT BETWEEN 1 AND 9007199254740691 OR abs(extract(epoch FROM clock_timestamp())-p_signed)>300 THEN RAISE EXCEPTION 'PAYMENT_TIMESTAMP_INVALID' USING ERRCODE='23514'; END IF;
 INSERT INTO public.payment_ingest_limits AS l(connection_id,window_started,attempts) VALUES(c.id,date_trunc('minute',clock_timestamp()),1)
 ON CONFLICT(connection_id) DO UPDATE SET window_started=greatest(l.window_started,EXCLUDED.window_started),
 attempts=CASE WHEN l.window_started<EXCLUDED.window_started THEN 1 ELSE l.attempts+1 END
 WHERE l.window_started<EXCLUDED.window_started OR l.attempts<c.max_events_per_minute RETURNING attempts INTO budget;
 IF budget IS NULL THEN RAISE EXCEPTION 'PAYMENT_RATE_LIMIT' USING ERRCODE='P0001'; END IF;
 INSERT INTO public.payment_webhook_inbox(academy_id,connection_id,event_id,event_created,signature_timestamp,account_id,livemode,api_version,event_type,object_type,resource_id,payload_sha256,payload_bytes)
 VALUES(c.academy_id,c.id,p_event,p_created,p_signed,c.account_id,p_live,p_version,p_type,p_object,p_resource,p_hash,p_bytes)
 ON CONFLICT(academy_id,connection_id,event_id) DO NOTHING RETURNING id INTO inserted;
 IF inserted IS NOT NULL THEN
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(c.academy_id,gen_random_uuid(),'payment.webhook.received',inserted,inserted);
  RETURN 'recorded';
 END IF;
 SELECT * INTO STRICT prior FROM public.payment_webhook_inbox WHERE academy_id=c.academy_id AND connection_id=c.id AND event_id=p_event;
 IF prior.payload_sha256=p_hash AND (prior.event_created,prior.event_type,prior.object_type,prior.resource_id,prior.payload_bytes) IS NOT DISTINCT FROM (p_created,p_type,p_object,p_resource,p_bytes) THEN RETURN 'duplicate'; END IF;
 INSERT INTO public.payment_webhook_conflicts(academy_id,inbox_id,payload_sha256) VALUES(c.academy_id,prior.id,p_hash)
 ON CONFLICT DO NOTHING RETURNING inbox_id INTO inserted;
 IF inserted IS NOT NULL THEN
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(c.academy_id,gen_random_uuid(),'payment.webhook.conflict.critical',prior.id,prior.id);
 END IF;
 RETURN 'conflict';
END $$;
REVOKE ALL ON FUNCTION public.receive_payment_event(uuid,text,text,bigint,bigint,text,text,text,boolean,text,text,integer) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO kavosh_payment_policy;
ALTER FUNCTION public.receive_payment_event(uuid,text,text,bigint,bigint,text,text,text,boolean,text,text,integer) OWNER TO kavosh_payment_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_payment_policy;
GRANT EXECUTE ON FUNCTION public.receive_payment_event(uuid,text,text,bigint,bigint,text,text,text,boolean,text,text,integer) TO kavosh_payment_ingest;
GRANT EXECUTE ON FUNCTION public.schema_revision() TO kavosh_payment_ingest;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 292 $$;

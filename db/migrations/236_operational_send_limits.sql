-- Operational notices only,not the independently rate-limited login/recovery
-- transport. No policy means OFF;installing this schema never authorizes sends.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('delivery-policy.view','View academy operational sending limits and usage','Automation',true,ARRAY[]::text[]),
 ('delivery-policy.edit','Request reviewed academy operational sending limits','Automation',true,ARRAY[]::text[]);
CREATE TABLE public.operational_send_policy_revisions(
 academy_id uuid NOT NULL,policy_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL,source_basis jsonb NOT NULL,
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,policy_id,version),UNIQUE(academy_id,version),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.operational_send_policies(
 academy_id uuid PRIMARY KEY REFERENCES public.academies(id),id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 FOREIGN KEY(academy_id,id,version) REFERENCES public.operational_send_policy_revisions(academy_id,policy_id,version)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['operational_send_policies','operational_send_policy_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY message_policy ON public.%I TO kavosh_message_policy USING(true) WITH CHECK(true)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime,kavosh_message_policy',t);
END LOOP;END $$;
GRANT INSERT(academy_id,policy_id,version,definition,source_basis,changed_by,approval_id,reason) ON public.operational_send_policy_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,id,version),UPDATE(version) ON public.operational_send_policies TO kavosh_runtime;
CREATE FUNCTION public.operational_send_policy_basis() RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',h.id,'version',coalesce(h.version,0),'definition',r.definition)
 FROM public.academies a LEFT JOIN public.operational_send_policies h ON h.academy_id=a.id
 LEFT JOIN public.operational_send_policy_revisions r ON r.academy_id=h.academy_id AND r.policy_id=h.id AND r.version=h.version
 WHERE a.id=nullif(current_setting('app.academy_id',true),'')::uuid
$$;
CREATE FUNCTION public.operational_send_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE b jsonb;a record;k text;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SEND_POLICY_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));
 b=public.operational_send_policy_basis();SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR NEW.version<>(b->>'version')::integer+1 OR(NEW.version>1 AND NEW.policy_id IS DISTINCT FROM(b->>'id')::uuid)
 OR NEW.source_basis IS DISTINCT FROM b OR a.id IS NULL OR a.status<>'pending' OR a.action IS DISTINCT FROM 'notification.delivery-policy.change'
 OR a.target_id IS DISTINCT FROM NEW.policy_id OR a.target_version<>NEW.version-1 OR a.privacy_capability IS DISTINCT FROM 'delivery-policy.view'
 OR a.scope IS DISTINCT FROM '{"all":true,"hubs":[]}'::jsonb OR a.review_context IS DISTINCT FROM b
 OR a.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'definition',NEW.definition,'reason',NEW.reason)
 OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'SEND_POLICY_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(NEW.definition) IS DISTINCT FROM 'object' OR NOT(NEW.definition?&ARRAY['enabled','maxDailyEmailRequests','maxDailySmsRequests','maxHourlyRequestsPerRecipient'])
 OR NEW.definition-ARRAY['enabled','maxDailyEmailRequests','maxDailySmsRequests','maxHourlyRequestsPerRecipient']<>'{}'::jsonb OR jsonb_typeof(NEW.definition->'enabled') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'SEND_POLICY_INVALID' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['maxDailyEmailRequests','maxDailySmsRequests','maxHourlyRequestsPerRecipient'] LOOP
  IF jsonb_typeof(NEW.definition->k) IS DISTINCT FROM 'number' OR NEW.definition->>k!~'^(0|[1-9][0-9]{0,5})$' OR(NEW.definition->>k)::integer>(CASE WHEN k='maxHourlyRequestsPerRecipient' THEN 1000 ELSE 100000 END) THEN RAISE EXCEPTION 'SEND_POLICY_INVALID' USING ERRCODE='23514';END IF;
 END LOOP;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER operational_send_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON public.operational_send_policy_revisions FOR EACH ROW EXECUTE FUNCTION public.operational_send_policy_guard();
CREATE FUNCTION public.operational_send_policy_head_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR(TG_OP='INSERT' AND NEW.version<>1) OR(TG_OP='UPDATE' AND(ROW(NEW.academy_id,NEW.id) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id) OR NEW.version<>OLD.version+1))
 OR NOT EXISTS(SELECT 1 FROM public.operational_send_policy_revisions WHERE academy_id=NEW.academy_id AND policy_id=NEW.id AND version=NEW.version AND created_at>=transaction_timestamp()) THEN RAISE EXCEPTION 'SEND_POLICY_HEAD_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER operational_send_policy_head_guard BEFORE INSERT OR UPDATE OR DELETE ON public.operational_send_policies FOR EACH ROW EXECUTE FUNCTION public.operational_send_policy_head_guard();
CREATE FUNCTION public.operational_send_policy_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.operational_send_policies WHERE academy_id=NEW.academy_id AND id=NEW.policy_id AND version>=NEW.version)
 OR NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events e ON e.academy_id=a.academy_id AND e.request_id=a.request_id AND e.entity_id=a.entity_id AND e.event_type=a.action WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.policy_id AND a.actor_id=NEW.changed_by AND a.action='notification.delivery-policy.change' AND a.created_at=transaction_timestamp() AND a.changes->>'version'=NEW.version::text AND a.changes->>'approvalId'=NEW.approval_id::text AND a.changes->'severity'='"critical"'::jsonb)
 THEN RAISE EXCEPTION 'SEND_POLICY_EFFECT_AUDIT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER operational_send_policy_complete AFTER INSERT ON public.operational_send_policy_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.operational_send_policy_complete();
CREATE CONSTRAINT TRIGGER operational_send_policy_reviewed AFTER INSERT ON public.operational_send_policy_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.operational_send_policy_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='notification.delivery-policy.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.operational_send_policy_revisions WHERE academy_id=NEW.academy_id AND policy_id=NEW.target_id AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'SEND_POLICY_EFFECT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER operational_send_policy_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.operational_send_policy_effect();
REVOKE ALL ON FUNCTION public.operational_send_policy_basis(),public.operational_send_policy_guard(),public.operational_send_policy_head_guard(),public.operational_send_policy_complete(),public.operational_send_policy_effect() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operational_send_policy_basis() TO kavosh_runtime;

-- Immutable conservative handoff reservations,not provider charges or receipts.
CREATE TABLE public.operational_send_reservations(
 academy_id uuid NOT NULL,delivery_id uuid NOT NULL,person_id uuid NOT NULL,channel text NOT NULL CHECK(channel IN('email','sms')),recorded_at timestamptz NOT NULL,
 origin text NOT NULL CHECK(origin IN('native_handoff','historical_sending_state')),policy_id uuid,policy_version integer,
 PRIMARY KEY(academy_id,delivery_id),FOREIGN KEY(academy_id,delivery_id) REFERENCES public.notification_deliveries(academy_id,id),
 FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,policy_id,policy_version) REFERENCES public.operational_send_policy_revisions(academy_id,policy_id,version),
 CHECK((origin='native_handoff' AND policy_id IS NOT NULL AND policy_version IS NOT NULL) OR(origin='historical_sending_state' AND policy_id IS NULL AND policy_version IS NULL))
);
CREATE INDEX operational_send_daily ON public.operational_send_reservations(academy_id,channel,recorded_at);
CREATE INDEX operational_send_recipient ON public.operational_send_reservations(academy_id,person_id,recorded_at);
ALTER TABLE public.operational_send_reservations ENABLE ROW LEVEL SECURITY;ALTER TABLE public.operational_send_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY message_policy ON public.operational_send_reservations TO kavosh_message_policy USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.operational_send_reservations TO kavosh_message_policy;
-- A native historic sending state proves a handoff reservation,not delivery.
-- Preserve its actual timestamp without inventing a prior policy/approval.
INSERT INTO public.operational_send_reservations(academy_id,delivery_id,person_id,channel,recorded_at,origin)
 SELECT DISTINCT ON(d.academy_id,d.id) d.academy_id,d.id,d.person_id,d.channel,(r.definition->>'changedAt')::timestamptz,'historical_sending_state'
 FROM public.notification_deliveries d JOIN public.notification_delivery_revisions r ON r.academy_id=d.academy_id AND r.delivery_id=d.id WHERE r.definition->>'status'='sending' ORDER BY d.academy_id,d.id,r.version;
CREATE TRIGGER operational_send_reservation_immutable BEFORE UPDATE OR DELETE ON public.operational_send_reservations FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable();
CREATE FUNCTION public.operational_send_allowed(p_academy uuid,p_person uuid,p_channel text,p_at timestamptz) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d jsonb;maximum integer;day_start timestamptz;BEGIN
 SELECT r.definition INTO d FROM public.operational_send_policies h JOIN public.operational_send_policy_revisions r ON r.academy_id=h.academy_id AND r.policy_id=h.id AND r.version=h.version WHERE h.academy_id=p_academy;
 IF d->'enabled' IS DISTINCT FROM 'true'::jsonb OR p_academy IS NULL OR p_person IS NULL OR p_channel IS NULL OR p_channel NOT IN('email','sms') OR p_at IS NULL THEN RETURN false;END IF;
 maximum=(d->>CASE WHEN p_channel='email' THEN 'maxDailyEmailRequests' ELSE 'maxDailySmsRequests' END)::integer;
 IF maximum=0 OR(d->>'maxHourlyRequestsPerRecipient')::integer=0 THEN RETURN false;END IF;
 day_start=date_trunc('day',p_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 RETURN(SELECT count(*) FROM public.operational_send_reservations WHERE academy_id=p_academy AND channel=p_channel AND recorded_at>=day_start AND recorded_at<day_start+interval '24 hours')<maximum
 AND(SELECT count(*) FROM public.operational_send_reservations WHERE academy_id=p_academy AND person_id=p_person AND recorded_at>p_at-interval '1 hour')<(d->>'maxHourlyRequestsPerRecipient')::integer;
END $$;
CREATE FUNCTION public.operational_send_usage() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH instant AS(SELECT clock_timestamp() observed_at),bounds AS(SELECT observed_at,date_trunc('day',observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' day_start FROM instant)
 SELECT jsonb_build_object('asOf',b.observed_at,'utcDayStartsAt',b.day_start,'emailRequests',(SELECT count(*)::text FROM public.operational_send_reservations WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND channel='email' AND recorded_at>=b.day_start AND recorded_at<b.day_start+interval '24 hours'),
 'smsRequests',(SELECT count(*)::text FROM public.operational_send_reservations WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND channel='sms' AND recorded_at>=b.day_start AND recorded_at<b.day_start+interval '24 hours')) FROM bounds b
$$;
GRANT CREATE ON SCHEMA public TO kavosh_message_policy;
ALTER FUNCTION public.operational_send_policy_complete() OWNER TO kavosh_message_policy;
ALTER FUNCTION public.operational_send_allowed(uuid,uuid,text,timestamptz) OWNER TO kavosh_message_policy;
ALTER FUNCTION public.operational_send_usage() OWNER TO kavosh_message_policy;
REVOKE ALL ON FUNCTION public.operational_send_allowed(uuid,uuid,text,timestamptz),public.operational_send_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operational_send_usage() TO kavosh_runtime;

-- The original contact/preference/lease protocol remains private and unchanged.
ALTER FUNCTION public.begin_notification_delivery(uuid,uuid) RENAME TO begin_notification_delivery_before_limits;
REVOKE ALL ON FUNCTION public.begin_notification_delivery_before_limits(uuid,uuid) FROM PUBLIC,kavosh_message_worker,kavosh_runtime;
CREATE FUNCTION public.begin_notification_delivery(p_id uuid,p_lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d public.notification_deliveries;payload jsonb;at_time timestamptz;h record;BEGIN
 SELECT * INTO d FROM public.notification_deliveries WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_id;
 IF d.id IS NULL OR d.status<>'preparing' OR d.lease_token IS DISTINCT FROM p_lease OR d.lease_until<=clock_timestamp() THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(d.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(d.academy_id::text,9));
 PERFORM pg_advisory_xact_lock(hashtextextended(d.academy_id::text||':operational-sending',17));
 SELECT * INTO d FROM public.notification_deliveries WHERE academy_id=d.academy_id AND id=p_id AND status='preparing' AND lease_token=p_lease AND lease_until>clock_timestamp();IF NOT FOUND THEN RETURN NULL;END IF;
 IF NOT public.operational_send_allowed(d.academy_id,d.person_id,d.channel,clock_timestamp()) THEN RETURN jsonb_build_object('deferred',true);END IF;
 BEGIN
  payload=public.begin_notification_delivery_before_limits(p_id,p_lease);IF payload IS NULL THEN RETURN NULL;END IF;
  -- Recheck after potentially waiting for identity/preference locks. Use the
  -- SAME native instant for the final UTC/hour check and persisted reservation.
  at_time=clock_timestamp();IF NOT public.operational_send_allowed(d.academy_id,d.person_id,d.channel,at_time) THEN RAISE EXCEPTION 'SEND_WINDOW_CHANGED' USING ERRCODE='P7301';END IF;
  SELECT id,version INTO h FROM public.operational_send_policies WHERE academy_id=d.academy_id;
  INSERT INTO public.operational_send_reservations VALUES(d.academy_id,d.id,d.person_id,d.channel,at_time,'native_handoff',h.id,h.version);
  IF NOT EXISTS(SELECT 1 FROM public.operational_send_reservations WHERE academy_id=d.academy_id AND delivery_id=d.id AND person_id=d.person_id AND channel=d.channel AND recorded_at=at_time AND origin='native_handoff' AND policy_id=h.id AND policy_version=h.version) THEN RAISE EXCEPTION 'SEND_RESERVATION_REQUIRED' USING ERRCODE='55000';END IF;
  RETURN payload;
 EXCEPTION WHEN SQLSTATE 'P7301' THEN RETURN jsonb_build_object('deferred',true);END;
END $$;
ALTER FUNCTION public.begin_notification_delivery(uuid,uuid) OWNER TO kavosh_message_policy;
REVOKE ALL ON FUNCTION public.begin_notification_delivery(uuid,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION public.begin_notification_delivery(uuid,uuid) TO kavosh_message_worker;
CREATE OR REPLACE FUNCTION public.claim_notification_delivery(routes jsonb) RETURNS TABLE(id uuid,academy_id uuid,person_id uuid,channel text,event_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE row public.notification_deliveries;BEGIN
 IF jsonb_typeof(routes) IS DISTINCT FROM 'array' OR jsonb_array_length(routes) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'INVALID_DELIVERY_ROUTES' USING ERRCODE='22023';END IF;
 UPDATE public.notification_deliveries d SET version=version+1,status=CASE WHEN d.status='sending' THEN 'unknown' ELSE 'cancelled' END,lease_token=NULL,lease_until=NULL,last_error=CASE WHEN d.status='sending' THEN 'SEND_OUTCOME_UNKNOWN' ELSE 'EXPIRED' END
 WHERE(d.academy_id,d.id) IN(SELECT q.academy_id,q.id FROM public.notification_deliveries q JOIN jsonb_to_recordset(routes) r(academy_id uuid,channels text[]) ON r.academy_id=q.academy_id AND q.channel=ANY(r.channels) WHERE(q.status='sending' AND q.lease_until<=clock_timestamp()) OR(q.status IN('queued','preparing') AND q.expires_at<=clock_timestamp()) ORDER BY q.created_at,q.id FOR UPDATE OF q SKIP LOCKED LIMIT 100);
 -- Reject exhausted school/channel routes ONCE before scanning queued jobs,
 -- rather than re-running a global daily count for every waiting recipient.
 WITH instant AS MATERIALIZED(SELECT clock_timestamp() observed_at),bounds AS MATERIALIZED(SELECT date_trunc('day',observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' day_start FROM instant),available_routes AS MATERIALIZED(
  SELECT DISTINCT r.academy_id,ch.channel FROM jsonb_to_recordset(routes) r(academy_id uuid,channels text[]) CROSS JOIN LATERAL unnest(r.channels) AS ch(channel)
  JOIN public.operational_send_policies h ON h.academy_id=r.academy_id JOIN public.operational_send_policy_revisions v ON v.academy_id=h.academy_id AND v.policy_id=h.id AND v.version=h.version CROSS JOIN bounds b
  WHERE v.definition->'enabled'='true'::jsonb AND(v.definition->>'maxHourlyRequestsPerRecipient')::integer>0
  AND(SELECT count(*) FROM public.operational_send_reservations s WHERE s.academy_id=r.academy_id AND s.channel=ch.channel AND s.recorded_at>=b.day_start AND s.recorded_at<b.day_start+interval '24 hours')<(v.definition->>CASE WHEN ch.channel='email' THEN 'maxDailyEmailRequests' ELSE 'maxDailySmsRequests' END)::integer
 ) SELECT q.* INTO row FROM public.notification_deliveries q JOIN available_routes r ON r.academy_id=q.academy_id AND r.channel=q.channel
 WHERE q.expires_at>clock_timestamp() AND(q.status='queued' OR(q.status='preparing' AND q.lease_until<=clock_timestamp())) AND public.operational_send_allowed(q.academy_id,q.person_id,q.channel,clock_timestamp()) ORDER BY q.created_at,q.id FOR UPDATE OF q SKIP LOCKED LIMIT 1;
 IF row.id IS NULL THEN RETURN;END IF;
 UPDATE public.notification_deliveries d SET version=d.version+1,status='preparing',lease_token=gen_random_uuid(),lease_until=least(clock_timestamp()+interval '30 seconds',d.expires_at) WHERE d.academy_id=row.academy_id AND d.id=row.id RETURNING d.* INTO row;
 RETURN QUERY SELECT row.id,row.academy_id,row.person_id,row.channel,row.event_id,row.lease_token;
END $$;
REVOKE CREATE ON SCHEMA public FROM kavosh_message_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$SELECT 236$$;

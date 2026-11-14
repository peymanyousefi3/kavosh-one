-- Future rule deliveries only;no old notification backfill or provider IO.
CREATE FUNCTION identity.notification_identity_epochs(p_user uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('ownerEpoch',encode(sha256(convert_to('notification-owner:'||p_user::text,'UTF8')),'hex'),
 'emailEpoch',encode(sha256(convert_to('notification-email:'||p_user::text||':'||coalesce((SELECT id::text FROM identity.contact_change_events WHERE user_id=p_user AND field='email' ORDER BY occurred_at DESC,id DESC LIMIT 1),''),'UTF8')),'hex'),
 'phoneEpoch',encode(sha256(convert_to('notification-phone:'||p_user::text||':'||coalesce((SELECT id::text FROM identity.contact_change_events WHERE user_id=p_user AND field='phone' ORDER BY occurred_at DESC,id DESC LIMIT 1),''),'UTF8')),'hex'))
$$;
REVOKE ALL ON FUNCTION identity.notification_identity_epochs(uuid) FROM PUBLIC;
GRANT CREATE ON SCHEMA identity TO kavosh_identity_policy;
ALTER FUNCTION identity.notification_identity_epochs(uuid) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA identity FROM kavosh_identity_policy;
CREATE OR REPLACE FUNCTION public.notification_preference_identity(p_person uuid,p_session uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT identity.notification_identity_epochs(u.id) FROM public.people p JOIN identity."user" u ON u.id=p.auth_user_id JOIN identity.session s ON s."userId"=u.id
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_person AND p.kind='human' AND p.status='active' AND s.id=p_session AND s."expiresAt">clock_timestamp()
 AND u."emailVerified" AND coalesce(u."phoneNumberVerified",false) AND(NOT coalesce(u."twoFactorEnabled",false) OR s."mfaVerified")
$$;
CREATE FUNCTION public.notification_delivery_preference(p_person uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('ownerEpoch',p.owner_epoch,'emailEpoch',p.email_epoch,'phoneEpoch',p.phone_epoch,'version',p.version,'locale',p.locale,
 'email',p.email_enabled AND p.email_epoch=epochs.v->>'emailEpoch','sms',p.sms_enabled AND p.phone_epoch=epochs.v->>'phoneEpoch')
 FROM public.people person JOIN public.academies a ON a.id=person.academy_id AND a.status='active' JOIN identity."user" u ON u.id=person.auth_user_id
 CROSS JOIN LATERAL(SELECT identity.notification_identity_epochs(u.id) v) epochs JOIN public.notification_preferences p ON p.academy_id=person.academy_id AND p.person_id=person.id AND p.owner_epoch=epochs.v->>'ownerEpoch'
 WHERE person.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND person.id=p_person AND person.kind='human' AND person.status='active' AND u."emailVerified" AND coalesce(u."phoneNumberVerified",false)
$$;
GRANT SELECT ON public.notification_preferences TO kavosh_identity_policy;
GRANT CREATE ON SCHEMA public TO kavosh_identity_policy;
ALTER FUNCTION public.notification_delivery_preference(uuid) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_identity_policy;
REVOKE ALL ON FUNCTION public.notification_delivery_preference(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notification_delivery_preference(uuid) TO kavosh_runtime;

DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_message_worker') THEN CREATE ROLE kavosh_message_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_message_policy') THEN CREATE ROLE kavosh_message_policy NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname IN('kavosh_message_worker','kavosh_message_policy') AND(rolcanlogin OR rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'UNSAFE_MESSAGE_ROLE';END IF;
 GRANT kavosh_message_policy TO CURRENT_USER;
END $$;
GRANT kavosh_runtime TO kavosh_message_worker;
REVOKE kavosh_message_worker,kavosh_message_policy FROM kavosh_runtime;
CREATE TABLE public.notification_deliveries(
 academy_id uuid NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,rule_id uuid NOT NULL,rule_version integer NOT NULL,event_id uuid NOT NULL,person_id uuid NOT NULL,
 channel text NOT NULL CHECK(channel IN('email','sms')),action_index integer NOT NULL CHECK(action_index BETWEEN 0 AND 9),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 1000),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 10000),locale text NOT NULL CHECK(locale IN('en','fr','zh-CN')),
 owner_epoch text NOT NULL CHECK(owner_epoch~'^[a-f0-9]{64}$'),contact_epoch text NOT NULL CHECK(contact_epoch~'^[a-f0-9]{64}$'),preference_version integer NOT NULL CHECK(preference_version>0),
 version integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','preparing','sending','accepted','cancelled','failed','unknown')),
 lease_token uuid,lease_until timestamptz,provider_id text CHECK(length(provider_id) BETWEEN 1 AND 500),last_error text CHECK(last_error~'^[A-Z0-9_]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,run_id,person_id,action_index,channel),
 FOREIGN KEY(academy_id,run_id) REFERENCES public.automation_runs(academy_id,id),FOREIGN KEY(academy_id,rule_id,rule_version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version),
 FOREIGN KEY(academy_id,event_id) REFERENCES public.automation_event_sources(academy_id,event_id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),
 CHECK((status IN('preparing','sending'))=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),CHECK((status='accepted')=(provider_id IS NOT NULL))
);
CREATE INDEX notification_deliveries_claim ON public.notification_deliveries(academy_id,channel,created_at,id) WHERE status='queued';
CREATE INDEX notification_deliveries_lease ON public.notification_deliveries(academy_id,lease_until,id) WHERE status IN('preparing','sending');
CREATE INDEX notification_deliveries_expiry ON public.notification_deliveries(academy_id,expires_at,id) WHERE status IN('queued','preparing');
CREATE INDEX notification_deliveries_rule_budget ON public.notification_deliveries(academy_id,rule_id,created_at,channel,person_id);
CREATE INDEX notification_deliveries_own ON public.notification_deliveries(academy_id,person_id,created_at,id);
CREATE TABLE public.notification_delivery_revisions(academy_id uuid NOT NULL,delivery_id uuid NOT NULL,version integer NOT NULL,definition jsonb NOT NULL,PRIMARY KEY(academy_id,delivery_id,version),FOREIGN KEY(academy_id,delivery_id) REFERENCES public.notification_deliveries(academy_id,id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['notification_deliveries','notification_delivery_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY message_policy ON public.%I TO kavosh_message_policy USING(true) WITH CHECK(true)',t);
END LOOP;END $$;
-- Lease nonces/deadlines and raw provider references are not web-readable.
GRANT SELECT(academy_id,id,run_id,rule_id,rule_version,event_id,person_id,channel,action_index,title,body,locale,owner_epoch,contact_epoch,preference_version,version,status,last_error,created_at,changed_at,expires_at) ON public.notification_deliveries TO kavosh_runtime;
GRANT SELECT ON public.notification_delivery_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,id,run_id,rule_id,rule_version,event_id,person_id,channel,action_index,title,body,locale,owner_epoch,contact_epoch,preference_version) ON public.notification_deliveries TO kavosh_runtime;
CREATE FUNCTION public.guard_notification_delivery() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record;pref jsonb;locked_version integer;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NOTIFICATION_DELIVERY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':'||NEW.rule_id::text,16));
  SELECT ar.*,v.definition INTO r FROM public.automation_runs ar JOIN public.automation_rule_revisions v ON v.academy_id=ar.academy_id AND v.rule_id=ar.rule_id AND v.version=ar.rule_version WHERE ar.academy_id=NEW.academy_id AND ar.id=NEW.run_id;
  SELECT version INTO locked_version FROM public.notification_preferences WHERE academy_id=NEW.academy_id AND person_id=NEW.person_id AND owner_epoch=NEW.owner_epoch FOR SHARE;
  pref=public.notification_delivery_preference(NEW.person_id);
  IF r.id IS NULL OR r.created_in<>pg_current_xact_id() OR r.outcome<>'processed' OR ROW(r.rule_id,r.rule_version,r.event_id) IS DISTINCT FROM ROW(NEW.rule_id,NEW.rule_version,NEW.event_id)
  OR jsonb_typeof(r.summary->'outboundQueued') IS DISTINCT FROM 'number' OR locked_version IS DISTINCT FROM NEW.preference_version
  OR NOT coalesce(r.definition->'actions'->NEW.action_index->'channels' ? NEW.channel,false) OR pref->>NEW.channel IS DISTINCT FROM 'true' OR pref->>'ownerEpoch' IS DISTINCT FROM NEW.owner_epoch
  OR(pref->>'version')::integer IS DISTINCT FROM NEW.preference_version OR pref->>'locale' IS DISTINCT FROM NEW.locale OR pref->>(CASE WHEN NEW.channel='email' THEN 'emailEpoch' ELSE 'phoneEpoch' END) IS DISTINCT FROM NEW.contact_epoch
  OR NEW.status<>'queued' OR NEW.version<>1 OR NEW.provider_id IS NOT NULL OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.last_error IS NOT NULL THEN RAISE EXCEPTION 'NOTIFICATION_DELIVERY_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
  -- Same reservation timestamp/day as the run and portal rows,even when a
  -- transaction crosses midnight. Actual state changes retain native clock time.
  NEW.created_at=transaction_timestamp();NEW.expires_at=clock_timestamp()+interval '24 hours';
 ELSE
  IF current_user<>'kavosh_message_policy' OR OLD.status IN('accepted','cancelled','failed','unknown') OR NEW.version<>OLD.version+1
  OR(to_jsonb(NEW)-ARRAY['version','status','lease_token','lease_until','provider_id','last_error','changed_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['version','status','lease_token','lease_until','provider_id','last_error','changed_at'])
  OR NOT((OLD.status='queued' AND NEW.status IN('preparing','cancelled')) OR(OLD.status='preparing' AND NEW.status IN('preparing','sending','cancelled','failed')) OR(OLD.status='sending' AND NEW.status IN('accepted','failed','unknown')))
  THEN RAISE EXCEPTION 'NOTIFICATION_DELIVERY_TRANSITION_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER notification_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON public.notification_deliveries FOR EACH ROW EXECUTE FUNCTION public.guard_notification_delivery();
CREATE FUNCTION public.capture_notification_delivery_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO public.notification_delivery_revisions VALUES(NEW.academy_id,NEW.id,NEW.version,jsonb_build_object('status',NEW.status,'lastError',NEW.last_error,'changedAt',NEW.changed_at,'attribution',CASE WHEN NEW.version=1 THEN 'approved_rule_dispatch' ELSE 'native_delivery_policy' END,'deliveryConfirmed',false));RETURN NULL;
END $$;
CREATE TRIGGER notification_delivery_revision AFTER INSERT OR UPDATE ON public.notification_deliveries FOR EACH ROW EXECUTE FUNCTION public.capture_notification_delivery_revision();
CREATE TRIGGER notification_delivery_revision_immutable BEFORE UPDATE OR DELETE ON public.notification_delivery_revisions FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable();
CREATE FUNCTION public.require_notification_delivery_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.notification_delivery_revisions WHERE academy_id=NEW.academy_id AND delivery_id=NEW.id AND version=NEW.version AND definition=jsonb_build_object('status',NEW.status,'lastError',NEW.last_error,'changedAt',NEW.changed_at,'attribution',CASE WHEN NEW.version=1 THEN 'approved_rule_dispatch' ELSE 'native_delivery_policy' END,'deliveryConfirmed',false)) THEN RAISE EXCEPTION 'NOTIFICATION_DELIVERY_HISTORY_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER notification_delivery_history_required AFTER INSERT OR UPDATE ON public.notification_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_notification_delivery_revision();
CREATE FUNCTION public.require_outbound_notification_run() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE maximum jsonb;used bigint;sms bigint;day_start timestamptz;BEGIN
 IF NEW.summary ? 'outboundQueued' AND(SELECT count(*) FROM public.notification_deliveries WHERE academy_id=NEW.academy_id AND run_id=NEW.id) IS DISTINCT FROM(NEW.summary->>'outboundQueued')::integer THEN RAISE EXCEPTION 'NOTIFICATION_OUTBOUND_RUN_INCOMPLETE' USING ERRCODE='55000';END IF;
 IF coalesce((NEW.summary->>'outboundQueued')::integer,0)>0 AND NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events o ON o.academy_id=a.academy_id AND o.request_id=a.request_id AND o.entity_id=a.entity_id AND o.event_type=a.action AND o.created_at=transaction_timestamp() WHERE a.academy_id=NEW.academy_id AND a.actor_id=NEW.actor_id AND a.entity_id=NEW.id AND a.action='automation.dispatched' AND a.created_at=transaction_timestamp() AND a.changes->'outboundQueued'=NEW.summary->'outboundQueued') THEN RAISE EXCEPTION 'NOTIFICATION_OUTBOUND_RECEIPT_REQUIRED' USING ERRCODE='55000';END IF;
 IF NEW.summary ? 'outboundQueued' AND NEW.outcome='processed' AND((NEW.summary->>'outboundQueued')::integer+(NEW.summary->>'portalNotifications')::integer)>0 THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':'||NEW.rule_id::text,16));
  SELECT definition->'execution' INTO maximum FROM public.automation_rule_revisions WHERE academy_id=NEW.academy_id AND rule_id=NEW.rule_id AND version=NEW.rule_version;
  day_start=date_trunc('day',NEW.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  SELECT count(*),count(*) FILTER(WHERE all_rows.sms) INTO used,sms FROM(SELECT created_at,false sms FROM public.portal_notifications WHERE academy_id=NEW.academy_id AND rule_id=NEW.rule_id UNION ALL SELECT created_at,channel='sms' sms FROM public.notification_deliveries WHERE academy_id=NEW.academy_id AND rule_id=NEW.rule_id) all_rows WHERE created_at>=day_start AND created_at<day_start+interval '24 hours';
  IF used>(maximum->>'maxDailyDeliveries')::integer OR sms>(maximum->>'maxDailySms')::integer THEN RAISE EXCEPTION 'NOTIFICATION_OUTBOUND_BUDGET_EXCEEDED' USING ERRCODE='55000';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER notification_outbound_run_required AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_outbound_notification_run();

CREATE FUNCTION public.cancel_changed_notification_deliveries() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE expected bigint;actual bigint;BEGIN
 SELECT count(*) INTO expected FROM public.notification_deliveries d WHERE d.academy_id=NEW.academy_id AND d.person_id=NEW.person_id AND d.owner_epoch=NEW.owner_epoch AND d.status IN('queued','preparing') AND(CASE WHEN d.channel='email' THEN NOT NEW.email_enabled OR NEW.email_epoch IS DISTINCT FROM d.contact_epoch ELSE NOT NEW.sms_enabled OR NEW.phone_epoch IS DISTINCT FROM d.contact_epoch END);
 UPDATE public.notification_deliveries d SET status='cancelled',version=d.version+1,lease_token=NULL,lease_until=NULL,last_error='PREFERENCE_CHANGED' WHERE d.academy_id=NEW.academy_id AND d.person_id=NEW.person_id AND d.owner_epoch=NEW.owner_epoch AND d.status IN('queued','preparing') AND(CASE WHEN d.channel='email' THEN NOT NEW.email_enabled OR NEW.email_epoch IS DISTINCT FROM d.contact_epoch ELSE NOT NEW.sms_enabled OR NEW.phone_epoch IS DISTINCT FROM d.contact_epoch END);
 GET DIAGNOSTICS actual=ROW_COUNT;IF actual<>expected THEN RAISE EXCEPTION 'NOTIFICATION_PREFERENCE_CANCELLATION_INCOMPLETE' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE TRIGGER notification_preference_cancels_delivery AFTER UPDATE ON public.notification_preferences FOR EACH ROW EXECUTE FUNCTION public.cancel_changed_notification_deliveries();
CREATE FUNCTION public.claim_notification_delivery(routes jsonb) RETURNS TABLE(id uuid,academy_id uuid,person_id uuid,channel text,event_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE row public.notification_deliveries;BEGIN
 IF jsonb_typeof(routes) IS DISTINCT FROM 'array' OR jsonb_array_length(routes) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'INVALID_DELIVERY_ROUTES' USING ERRCODE='22023';END IF;
 -- Bounded cleanup,not a cross-school unbounded sweep. Expired sending is
 -- uncertain,never a license to send the same message again.
 UPDATE public.notification_deliveries d SET version=version+1,status=CASE WHEN d.status='sending' THEN 'unknown' ELSE 'cancelled' END,lease_token=NULL,lease_until=NULL,last_error=CASE WHEN d.status='sending' THEN 'SEND_OUTCOME_UNKNOWN' ELSE 'EXPIRED' END
 WHERE(d.academy_id,d.id) IN(SELECT q.academy_id,q.id FROM public.notification_deliveries q JOIN jsonb_to_recordset(routes) r(academy_id uuid,channels text[]) ON r.academy_id=q.academy_id AND q.channel=ANY(r.channels) WHERE(q.status='sending' AND q.lease_until<=clock_timestamp()) OR(q.status IN('queued','preparing') AND q.expires_at<=clock_timestamp()) ORDER BY q.created_at,q.id FOR UPDATE OF q SKIP LOCKED LIMIT 100);
 SELECT q.* INTO row FROM public.notification_deliveries q JOIN jsonb_to_recordset(routes) r(academy_id uuid,channels text[]) ON r.academy_id=q.academy_id AND q.channel=ANY(r.channels)
 WHERE q.expires_at>clock_timestamp() AND(q.status='queued' OR(q.status='preparing' AND q.lease_until<=clock_timestamp())) ORDER BY q.created_at,q.id FOR UPDATE OF q SKIP LOCKED LIMIT 1;
 IF row.id IS NULL THEN RETURN;END IF;
 UPDATE public.notification_deliveries d SET version=d.version+1,status='preparing',lease_token=gen_random_uuid(),lease_until=least(clock_timestamp()+interval '30 seconds',d.expires_at) WHERE d.academy_id=row.academy_id AND d.id=row.id RETURNING d.* INTO row;
 RETURN QUERY SELECT row.id,row.academy_id,row.person_id,row.channel,row.event_id,row.lease_token;
END $$;
CREATE FUNCTION public.begin_notification_delivery(p_id uuid,p_lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE d public.notification_deliveries;pref jsonb;contact text;BEGIN
 SELECT * INTO d FROM public.notification_deliveries WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_id;
 IF d.id IS NULL OR d.status<>'preparing' OR d.lease_token<>p_lease OR d.lease_until<=clock_timestamp() THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(d.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(d.academy_id::text,9));
 -- Same identity->preference->job lock order as self preference withdrawal.
 PERFORM 1 FROM identity."user" u JOIN public.people p ON p.auth_user_id=u.id AND p.academy_id=d.academy_id AND p.id=d.person_id FOR SHARE OF u,p;
 PERFORM 1 FROM public.notification_preferences WHERE academy_id=d.academy_id AND person_id=d.person_id AND owner_epoch=d.owner_epoch FOR SHARE;
 SELECT * INTO d FROM public.notification_deliveries WHERE academy_id=d.academy_id AND id=p_id FOR UPDATE;
 IF d.status<>'preparing' OR d.lease_token<>p_lease OR d.lease_until<=clock_timestamp() THEN RETURN NULL;END IF;
 pref=public.notification_delivery_preference(d.person_id);
 IF pref->>d.channel IS DISTINCT FROM 'true' OR(pref->>'version')::integer<d.preference_version OR pref->>'ownerEpoch' IS DISTINCT FROM d.owner_epoch OR pref->>(CASE WHEN d.channel='email' THEN 'emailEpoch' ELSE 'phoneEpoch' END) IS DISTINCT FROM d.contact_epoch
 OR EXISTS(SELECT 1 FROM public.notification_preference_revisions r WHERE r.academy_id=d.academy_id AND r.person_id=d.person_id AND r.owner_epoch=d.owner_epoch AND r.version>d.preference_version AND((r.definition->>(CASE WHEN d.channel='email' THEN 'email_enabled' ELSE 'sms_enabled' END))::boolean IS DISTINCT FROM true OR r.definition->>(CASE WHEN d.channel='email' THEN 'email_epoch' ELSE 'phone_epoch' END) IS DISTINCT FROM d.contact_epoch)) THEN
  UPDATE public.notification_deliveries SET version=version+1,status='cancelled',lease_token=NULL,lease_until=NULL,last_error='PREFERENCE_OR_IDENTITY_CHANGED' WHERE academy_id=d.academy_id AND id=d.id;RETURN NULL;
 END IF;
 SELECT CASE WHEN d.channel='email' THEN u.email ELSE u."phoneNumber" END INTO contact FROM public.people p JOIN identity."user" u ON u.id=p.auth_user_id WHERE p.academy_id=d.academy_id AND p.id=d.person_id;
 UPDATE public.notification_deliveries SET version=version+1,status='sending' WHERE academy_id=d.academy_id AND id=d.id;
 RETURN jsonb_build_object('channel',d.channel,'to',contact,'title',d.title,'body',d.body,'locale',d.locale);
END $$;
CREATE FUNCTION public.finish_notification_delivery(p_id uuid,p_lease uuid,p_outcome text,p_provider_id text,p_error text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF p_outcome NOT IN('accepted','failed','unknown','cancelled') OR(p_outcome='accepted') IS DISTINCT FROM(p_provider_id IS NOT NULL) OR length(p_provider_id)>500 OR p_error!~'^[A-Z0-9_]{1,64}$' THEN RAISE EXCEPTION 'INVALID_DELIVERY_RESULT' USING ERRCODE='22023';END IF;
 UPDATE public.notification_deliveries SET version=version+1,status=p_outcome,provider_id=p_provider_id,last_error=p_error,lease_token=NULL,lease_until=NULL
 WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_id AND lease_token=p_lease AND lease_until>clock_timestamp() AND((status='preparing' AND p_outcome IN('cancelled','failed')) OR(status='sending' AND p_outcome IN('accepted','failed','unknown')));
 RETURN FOUND;
END $$;
GRANT USAGE ON SCHEMA public,identity TO kavosh_message_policy;
GRANT SELECT ON public.people,public.academies,public.automation_runs,public.automation_rule_revisions,public.notification_preferences TO kavosh_message_policy;
GRANT SELECT ON public.notification_delivery_revisions TO kavosh_message_policy;
GRANT SELECT ON public.notification_preference_revisions TO kavosh_message_policy;
GRANT SELECT(academy_id,rule_id,created_at) ON public.portal_notifications TO kavosh_message_policy;
GRANT SELECT(academy_id,request_id,actor_id,entity_id,action,created_at,changes) ON public.audit_events TO kavosh_message_policy;
GRANT SELECT(academy_id,request_id,entity_id,event_type,created_at) ON public.outbox_events TO kavosh_message_policy;
GRANT UPDATE(id) ON public.people TO kavosh_message_policy;
GRANT UPDATE(version) ON public.notification_preferences TO kavosh_message_policy;
GRANT SELECT,UPDATE ON public.notification_deliveries TO kavosh_message_policy;
GRANT INSERT ON public.notification_delivery_revisions TO kavosh_message_policy;
GRANT SELECT(id,email,"phoneNumber","emailVerified","phoneNumberVerified") ON identity."user" TO kavosh_message_policy;
GRANT UPDATE(id) ON identity."user" TO kavosh_message_policy;
GRANT EXECUTE ON FUNCTION public.notification_delivery_preference(uuid) TO kavosh_message_policy;
GRANT CREATE ON SCHEMA public TO kavosh_message_policy;
ALTER FUNCTION public.capture_notification_delivery_revision() OWNER TO kavosh_message_policy;
ALTER FUNCTION public.require_notification_delivery_revision() OWNER TO kavosh_message_policy;
ALTER FUNCTION public.require_outbound_notification_run() OWNER TO kavosh_message_policy;
ALTER FUNCTION public.cancel_changed_notification_deliveries() OWNER TO kavosh_message_policy;
ALTER FUNCTION public.claim_notification_delivery(jsonb) OWNER TO kavosh_message_policy;
ALTER FUNCTION public.begin_notification_delivery(uuid,uuid) OWNER TO kavosh_message_policy;
ALTER FUNCTION public.finish_notification_delivery(uuid,uuid,text,text,text) OWNER TO kavosh_message_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_message_policy;
REVOKE ALL ON FUNCTION public.guard_notification_delivery(),public.capture_notification_delivery_revision(),public.require_notification_delivery_revision(),public.require_outbound_notification_run(),public.cancel_changed_notification_deliveries(),public.claim_notification_delivery(jsonb),public.begin_notification_delivery(uuid,uuid),public.finish_notification_delivery(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_notification_delivery(jsonb),public.begin_notification_delivery(uuid,uuid),public.finish_notification_delivery(uuid,uuid,text,text,text) TO kavosh_message_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 233 $$;

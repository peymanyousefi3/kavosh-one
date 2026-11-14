-- Operational delivery choices only. No marketing consent,external send or
-- optional portal/identity-security notices. Never copy email/phone values.
CREATE INDEX contact_change_latest ON identity.contact_change_events(user_id,field,occurred_at DESC,id DESC);
CREATE FUNCTION public.notification_preference_identity(p_person uuid,p_session uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
  'ownerEpoch',encode(sha256(convert_to('notification-owner:'||u.id::text,'UTF8')),'hex'),
  'emailEpoch',encode(sha256(convert_to('notification-email:'||u.id::text||':'||coalesce((SELECT e.id::text FROM identity.contact_change_events e WHERE e.user_id=u.id AND e.field='email' ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1),''),'UTF8')),'hex'),
  'phoneEpoch',encode(sha256(convert_to('notification-phone:'||u.id::text||':'||coalesce((SELECT e.id::text FROM identity.contact_change_events e WHERE e.user_id=u.id AND e.field='phone' ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1),''),'UTF8')),'hex'))
 FROM public.people p JOIN identity."user" u ON u.id=p.auth_user_id JOIN identity.session s ON s."userId"=u.id
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_person AND p.kind='human' AND p.status='active'
 AND s.id=p_session AND s."expiresAt">clock_timestamp() AND u."emailVerified" AND coalesce(u."phoneNumberVerified",false)
 AND(NOT coalesce(u."twoFactorEnabled",false) OR s."mfaVerified")
$$;
REVOKE ALL ON FUNCTION public.notification_preference_identity(uuid,uuid) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO kavosh_identity_policy;
ALTER FUNCTION public.notification_preference_identity(uuid,uuid) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_identity_policy;
GRANT EXECUTE ON FUNCTION public.notification_preference_identity(uuid,uuid) TO kavosh_runtime;

CREATE TABLE public.notification_preferences(
 academy_id uuid NOT NULL,person_id uuid NOT NULL,owner_epoch text NOT NULL CHECK(owner_epoch~'^[a-f0-9]{64}$'),
 version integer NOT NULL CHECK(version>0),email_enabled boolean NOT NULL,sms_enabled boolean NOT NULL,locale text NOT NULL CHECK(locale IN('en','fr','zh-CN')),
 email_epoch text,phone_epoch text,notice_version integer NOT NULL CHECK(notice_version=1),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,person_id,owner_epoch),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),
 CHECK((email_enabled AND email_epoch~'^[a-f0-9]{64}$' AND email_epoch IS NOT NULL) OR(NOT email_enabled AND email_epoch IS NULL)),
 CHECK((sms_enabled AND phone_epoch~'^[a-f0-9]{64}$' AND phone_epoch IS NOT NULL) OR(NOT sms_enabled AND phone_epoch IS NULL))
);
CREATE TABLE public.notification_preference_revisions(
 academy_id uuid NOT NULL,person_id uuid NOT NULL,owner_epoch text NOT NULL,version integer NOT NULL,definition jsonb NOT NULL,
 PRIMARY KEY(academy_id,person_id,owner_epoch,version),
 FOREIGN KEY(academy_id,person_id,owner_epoch) REFERENCES public.notification_preferences(academy_id,person_id,owner_epoch)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['notification_preferences','notification_preference_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,person_id,owner_epoch,version,email_enabled,sms_enabled,locale,email_epoch,phone_epoch,notice_version),UPDATE(version,email_enabled,sms_enabled,locale,email_epoch,phone_epoch,notice_version) ON public.notification_preferences TO kavosh_runtime;
GRANT INSERT ON public.notification_preference_revisions TO kavosh_runtime;
CREATE FUNCTION public.guard_notification_preference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NOTIFICATION_PREFERENCE_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.academy_id,NEW.person_id,NEW.owner_epoch) IS DISTINCT FROM ROW(OLD.academy_id,OLD.person_id,OLD.owner_epoch) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'NOTIFICATION_PREFERENCE_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'NOTIFICATION_PREFERENCE_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER notification_preference_guard BEFORE INSERT OR UPDATE OR DELETE ON public.notification_preferences FOR EACH ROW EXECUTE FUNCTION public.guard_notification_preference();
CREATE FUNCTION public.guard_notification_preference_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM public.notification_preferences p WHERE p.academy_id=NEW.academy_id AND p.person_id=NEW.person_id AND p.owner_epoch=NEW.owner_epoch AND p.version=NEW.version AND to_jsonb(p)=NEW.definition) THEN RAISE EXCEPTION 'NOTIFICATION_PREFERENCE_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER notification_preference_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.notification_preference_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_notification_preference_revision();
CREATE FUNCTION public.require_notification_preference_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE proof jsonb;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND(status='active' OR(status='read_only' AND NOT NEW.email_enabled AND NOT NEW.sms_enabled))) THEN RAISE EXCEPTION 'NOTIFICATION_PREFERENCE_ACADEMY_UNAVAILABLE' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.notification_preference_revisions r WHERE r.academy_id=NEW.academy_id AND r.person_id=NEW.person_id AND r.owner_epoch=NEW.owner_epoch AND r.version=NEW.version AND r.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'NOTIFICATION_PREFERENCE_REVISION_REQUIRED' USING ERRCODE='55000';END IF;
 SELECT public.notification_preference_identity(a.actor_id,a.session_id) INTO proof FROM public.audit_events a
 JOIN public.outbox_events o ON o.academy_id=a.academy_id AND o.request_id=a.request_id AND o.entity_id=a.entity_id AND o.event_type=a.action AND o.created_at=transaction_timestamp()
 WHERE a.academy_id=NEW.academy_id AND a.actor_id=NEW.person_id AND a.actor_kind='human' AND a.entity_id=NEW.person_id AND a.created_at=transaction_timestamp()
 AND a.action='notification-preferences.changed' AND a.changes->'version'=to_jsonb(NEW.version)
 AND a.changes->>'revisionSha256'=encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex') LIMIT 1;
 IF proof IS NULL OR proof->>'ownerEpoch' IS DISTINCT FROM NEW.owner_epoch OR(NEW.email_enabled AND proof->>'emailEpoch' IS DISTINCT FROM NEW.email_epoch) OR(NEW.sms_enabled AND proof->>'phoneEpoch' IS DISTINCT FROM NEW.phone_epoch) THEN RAISE EXCEPTION 'NOTIFICATION_PREFERENCE_SELF_RECEIPT_REQUIRED' USING ERRCODE='55000';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER notification_preference_receipt AFTER INSERT OR UPDATE ON public.notification_preferences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_notification_preference_receipt();
REVOKE ALL ON FUNCTION public.guard_notification_preference(),public.guard_notification_preference_revision(),public.require_notification_preference_receipt() FROM PUBLIC;
-- Only the non-callable deferred trigger reads event receipts;the web role
-- still cannot browse the outbox. Its identity helper has no contact values.
GRANT SELECT ON public.notification_preference_revisions TO kavosh_identity_policy;
GRANT SELECT(academy_id,request_id,entity_id,event_type,created_at) ON public.outbox_events TO kavosh_identity_policy;
GRANT CREATE ON SCHEMA public TO kavosh_identity_policy;
ALTER FUNCTION public.require_notification_preference_receipt() OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_identity_policy;
CREATE INDEX notification_preference_event_receipt ON public.outbox_events(academy_id,request_id,entity_id) WHERE event_type='notification-preferences.changed';
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 232 $$;

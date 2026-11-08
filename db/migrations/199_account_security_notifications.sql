INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('account-security.view','View scoped account contact-change history','Administration',true,ARRAY['hub','person','country','region','city']);
GRANT CREATE ON SCHEMA identity,public TO kavosh_identity_policy;
GRANT CREATE ON SCHEMA public TO kavosh_event_policy;
-- Returning an address to its SAME original identity during separately held
-- owner repair is not reassignment to a new account. Preserve the cooldown
-- for every insert,normal web write and different/unknown former identity.
-- Legacy reservations stay NULL rather than guessing their former owner.
ALTER TABLE identity.retired_emails ADD user_id uuid REFERENCES identity."user"(id);
CREATE OR REPLACE FUNCTION identity.guard_email_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='UPDATE' AND NEW.email IS NOT DISTINCT FROM OLD.email THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' THEN
  IF NOT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='identity."user"'::regclass),'member') THEN RAISE EXCEPTION 'EMAIL_CHANGE_REQUIRES_RECOVERY' USING ERRCODE='23514';END IF;
  IF NOT identity.email_available(NEW.email,NEW.id) AND NOT EXISTS(SELECT 1 FROM identity.retired_emails r WHERE r.email=NEW.email AND r.user_id=NEW.id) THEN RAISE EXCEPTION 'EMAIL_UNAVAILABLE' USING ERRCODE='23514';END IF;
 ELSIF NOT identity.email_available(NEW.email,NEW.id) THEN RAISE EXCEPTION 'EMAIL_UNAVAILABLE' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION identity.finish_email_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.email IS DISTINCT FROM OLD.email THEN
  INSERT INTO identity.retired_emails(email,expires_at,user_id) VALUES(OLD.email,clock_timestamp()+interval '16 minutes',OLD.id) ON CONFLICT(email) DO UPDATE SET expires_at=greatest(identity.retired_emails.expires_at,excluded.expires_at),user_id=excluded.user_id;
  DELETE FROM identity.session WHERE "userId"=NEW.id;DELETE FROM identity.verification WHERE value=NEW.id::text;
  INSERT INTO identity.security_events(user_id,event) VALUES(NEW.id,'email.changed');
 END IF;RETURN NULL;
END $$;
-- Explicit tenant anchors also apply when a narrow identity-policy helper
-- calls this INVOKER traversal with cross-school SELECT rights. Person UUIDs
-- are only unique WITHIN an academy;RLS alone must not make that assumption.
CREATE OR REPLACE FUNCTION public.supervisor_chain(p_person uuid) RETURNS TABLE(person_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH RECURSIVE managers(academy_id,id,next_id,seen,depth) AS(
  SELECT p.academy_id,p.id,coalesce(p.supervisor_person_id,a.master_person_id),ARRAY[p.id],0
  FROM public.people p JOIN public.academies a ON a.id=p.academy_id WHERE p.id=p_person AND p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid
  UNION ALL
  SELECT p.academy_id,p.id,coalesce(p.supervisor_person_id,a.master_person_id),m.seen||p.id,m.depth+1
  FROM managers m JOIN public.people p ON p.academy_id=m.academy_id AND p.id=m.next_id JOIN public.academies a ON a.id=p.academy_id
  WHERE NOT p.id=ANY(m.seen) AND m.depth<64
 ) SELECT id FROM managers WHERE depth>0
$$;
-- Auth transactions never lock school people or notification rows. They write
-- only private UUID/field observations and a non-locking membership snapshot.
CREATE INDEX people_contact_event_binding ON public.people(auth_user_id,academy_id,id) WHERE auth_user_id IS NOT NULL;
CREATE TABLE identity.contact_change_events(
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES identity."user"(id),field text NOT NULL CHECK(field IN('email','phone')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),origin_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE TABLE identity.contact_change_targets(
 event_id uuid NOT NULL REFERENCES identity.contact_change_events(id),academy_id uuid NOT NULL,person_id uuid NOT NULL,hub_id uuid,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','published','discarded')),published_event_id uuid,
 PRIMARY KEY(event_id,academy_id,person_id),CHECK((status='published')=(published_event_id IS NOT NULL))
);
CREATE INDEX contact_change_pending ON identity.contact_change_targets(academy_id,event_id,person_id) WHERE status='pending';
REVOKE ALL ON identity.contact_change_events,identity.contact_change_targets FROM PUBLIC;
GRANT SELECT,INSERT ON identity.contact_change_events,identity.contact_change_targets TO kavosh_identity_policy;
GRANT UPDATE(status,published_event_id) ON identity.contact_change_targets TO kavosh_identity_policy;
CREATE FUNCTION identity.contact_change_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF current_user<>'kavosh_identity_policy' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'CONTACT_CHANGE_TRIGGER_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.occurred_at=clock_timestamp();NEW.origin_transaction=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER contact_change_event_guard BEFORE INSERT ON identity.contact_change_events FOR EACH ROW EXECUTE FUNCTION identity.contact_change_event_guard();
CREATE TRIGGER contact_change_event_immutable BEFORE UPDATE OR DELETE ON identity.contact_change_events FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable();
CREATE FUNCTION identity.capture_contact_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE field text;i uuid;BEGIN
 FOR field IN SELECT 'email' WHERE NEW.email IS DISTINCT FROM OLD.email UNION ALL SELECT 'phone' WHERE OLD."phoneNumber" IS NOT NULL AND NEW."phoneNumber" IS DISTINCT FROM OLD."phoneNumber" LOOP
  i=gen_random_uuid();INSERT INTO identity.contact_change_events(id,user_id,field) VALUES(i,NEW.id,field);
  INSERT INTO identity.contact_change_targets(event_id,academy_id,person_id,hub_id) SELECT i,p.academy_id,p.id,p.hub_id FROM public.people p WHERE p.auth_user_id=NEW.id AND p.kind='human';
 END LOOP;RETURN NULL;
END $$;
ALTER FUNCTION identity.capture_contact_change() OWNER TO kavosh_identity_policy;
REVOKE ALL ON FUNCTION identity.capture_contact_change() FROM PUBLIC;
CREATE TRIGGER capture_contact_change AFTER UPDATE OF email,"phoneNumber" ON identity."user" FOR EACH ROW EXECUTE FUNCTION identity.capture_contact_change();

CREATE TABLE public.account_security_events(
 academy_id uuid NOT NULL,id uuid NOT NULL,person_id uuid NOT NULL,hub_id uuid,field text NOT NULL CHECK(field IN('email','phone')),
 occurred_at timestamptz NOT NULL,published_at timestamptz NOT NULL DEFAULT clock_timestamp(),origin_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 contact_event_id uuid NOT NULL REFERENCES identity.contact_change_events(id),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,contact_event_id,person_id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id)
);
ALTER TABLE public.account_security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_security_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.account_security_events USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY identity_contact_capture ON public.account_security_events TO kavosh_identity_policy USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.account_security_events TO kavosh_identity_policy;
GRANT SELECT ON public.account_security_events TO kavosh_event_policy;
GRANT SELECT(academy_id,id,person_id,field,occurred_at,published_at) ON public.account_security_events TO kavosh_runtime;
CREATE INDEX account_security_person_time ON public.account_security_events(academy_id,person_id,occurred_at,id);
CREATE TRIGGER account_security_immutable BEFORE UPDATE OR DELETE ON public.account_security_events FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable();
CREATE FUNCTION public.account_security_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF current_user<>'kavosh_identity_policy' OR NOT EXISTS(
  SELECT 1 FROM identity.contact_change_targets t JOIN identity.contact_change_events e ON e.id=t.event_id
  JOIN public.people p ON p.academy_id=t.academy_id AND p.id=t.person_id AND p.auth_user_id=e.user_id AND p.kind='human'
  WHERE t.event_id=NEW.contact_event_id AND t.academy_id=NEW.academy_id AND t.person_id=NEW.person_id AND t.status='pending'
   AND t.hub_id IS NOT DISTINCT FROM NEW.hub_id AND e.field=NEW.field AND e.occurred_at=NEW.occurred_at) THEN RAISE EXCEPTION 'ACCOUNT_SECURITY_NATIVE_OBSERVATION_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.published_at=clock_timestamp();NEW.origin_transaction=pg_current_xact_id();RETURN NEW;
END $$;
ALTER FUNCTION public.account_security_event_guard() OWNER TO kavosh_identity_policy;
CREATE TRIGGER account_security_event_guard BEFORE INSERT ON public.account_security_events FOR EACH ROW EXECUTE FUNCTION public.account_security_event_guard();
CREATE FUNCTION identity.contact_change_target_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF current_user<>'kavosh_identity_policy' THEN RAISE EXCEPTION 'PRIVATE_CONTACT_EVENT_WRITER_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  -- Only the private AFTER-user-change capturer inserts targets. Do not take
  -- school row locks or re-read a newer membership edition during this auth
  -- transaction;publication independently validates the stored binding.
  IF pg_trigger_depth()<2 OR NEW.status<>'pending' OR NEW.published_event_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM identity.contact_change_events e WHERE e.id=NEW.event_id AND e.origin_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'CONTACT_EVENT_BINDING_REQUIRED' USING ERRCODE='23514';END IF;
 ELSIF TG_OP='UPDATE' THEN
  IF OLD.status<>'pending' OR NEW.status NOT IN('published','discarded') OR(to_jsonb(NEW)-ARRAY['status','published_event_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['status','published_event_id']) THEN RAISE EXCEPTION 'CONTACT_EVENT_TARGET_IMMUTABLE' USING ERRCODE='23514';END IF;
  IF NEW.status='published' AND NOT EXISTS(SELECT 1 FROM public.account_security_events e WHERE e.academy_id=NEW.academy_id AND e.id=NEW.published_event_id AND e.person_id=NEW.person_id AND e.contact_event_id=NEW.event_id) THEN RAISE EXCEPTION 'CONTACT_EVENT_PUBLICATION_REQUIRED' USING ERRCODE='23514';END IF;
  IF NEW.status='discarded' AND EXISTS(SELECT 1 FROM identity.contact_change_events e JOIN public.people p ON p.auth_user_id=e.user_id AND p.kind='human' WHERE e.id=NEW.event_id AND p.academy_id=NEW.academy_id AND p.id=NEW.person_id) THEN RAISE EXCEPTION 'CONTACT_EVENT_BINDING_STILL_CURRENT' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'CONTACT_EVENT_TARGET_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER contact_change_target_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.contact_change_targets FOR EACH ROW EXECUTE FUNCTION identity.contact_change_target_guard();

ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule','report_job','pay_statement','account_security'));
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_operational_audit;
ALTER TABLE public.automation_event_sources ADD CONSTRAINT automation_event_operational_audit CHECK((source_kind IN('report_schedule','report_job','pay_statement','account_security'))=(audit_id IS NULL));
ALTER TABLE public.automation_event_sources ADD account_security_id uuid,ADD FOREIGN KEY(academy_id,account_security_id) REFERENCES public.account_security_events(academy_id,id),ADD UNIQUE(academy_id,account_security_id),ADD CHECK((source_kind='account_security')=(account_security_id IS NOT NULL));
CREATE FUNCTION public.account_security_projection(p_event uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('eventType','account.'||e.field||'_changed','entityId',e.id,'hubId',e.hub_id,'actorId',NULL,'actorKind','system','severity','critical','occurredAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',jsonb_build_object('personId',e.person_id,'contactField',e.field))
 FROM public.account_security_events e WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.id=p_event
$$;
CREATE FUNCTION public.account_security_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p jsonb:=public.account_security_projection(NEW.account_security_id);BEGIN
 IF current_user<>'kavosh_event_policy' OR p IS NULL OR NEW.source_version<>1 OR NEW.projection IS DISTINCT FROM p OR NEW.event_type IS DISTINCT FROM p->>'eventType' OR NEW.hub_id::text IS DISTINCT FROM p->>'hubId' OR NEW.event_id IS DISTINCT FROM NEW.account_security_id OR NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id()
 OR NOT EXISTS(SELECT 1 FROM public.account_security_events e JOIN public.outbox_events o ON o.academy_id=e.academy_id AND o.id=e.id AND o.entity_id=e.id AND o.event_type=NEW.event_type AND o.created_at=transaction_timestamp() WHERE e.academy_id=NEW.academy_id AND e.id=NEW.account_security_id AND e.occurred_at=NEW.occurred_at AND e.origin_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION 'ACCOUNT_SECURITY_EVENT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER account_security_source_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='account_security') EXECUTE FUNCTION public.account_security_source_guard();
CREATE FUNCTION public.capture_account_security_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE p jsonb:=public.account_security_projection(NEW.id);BEGIN
 IF p IS NULL THEN RAISE EXCEPTION 'ACCOUNT_SECURITY_PROJECTION_REQUIRED' USING ERRCODE='23514';END IF;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(NEW.academy_id,NEW.id,p->>'eventType',NEW.id,gen_random_uuid());
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,account_security_id) VALUES(NEW.academy_id,NEW.id,NULL,NULL,'account_security',1,p->>'eventType',(p->>'hubId')::uuid,NEW.occurred_at,p,NEW.id);RETURN NULL;
END $$;
ALTER FUNCTION public.capture_account_security_event() OWNER TO kavosh_event_policy;
CREATE TRIGGER capture_account_security_event AFTER INSERT ON public.account_security_events FOR EACH ROW EXECUTE FUNCTION public.capture_account_security_event();
CREATE FUNCTION public.account_security_notice_allows(p_event uuid,p_actor uuid,p_scope jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$ DECLARE e record;actor record;BEGIN
 SELECT s.person_id,p.hub_id,p.auth_user_id,f.user_id INTO e FROM public.account_security_events s JOIN public.people p ON p.academy_id=s.academy_id AND p.id=s.person_id JOIN identity.contact_change_events f ON f.id=s.contact_event_id WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.id=p_event;IF NOT FOUND THEN RETURN false;END IF;
 SELECT p.id,p.kind,p.auth_user_id,a.master_person_id INTO actor FROM public.people p JOIN public.academies a ON a.id=p.academy_id LEFT JOIN identity."user" u ON u.id=p.auth_user_id WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_actor AND p.status='active' AND(p.kind='bot' OR(u."emailVerified" AND u."phoneNumberVerified"));IF NOT FOUND THEN RETURN false;END IF;
 IF actor.kind='human' AND actor.id=actor.master_person_id THEN RETURN true;END IF;
 IF actor.kind='human' AND actor.id=e.person_id AND actor.auth_user_id=e.user_id THEN RETURN true;END IF;
 RETURN public.work_scope_allows(p_scope,e.hub_id,e.person_id);
END $$;
ALTER FUNCTION public.account_security_notice_allows(uuid,uuid,jsonb) OWNER TO kavosh_identity_policy;
GRANT EXECUTE ON FUNCTION public.work_scope_allows(jsonb,uuid,uuid) TO kavosh_identity_policy;
CREATE FUNCTION public.publish_account_security_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin)
 SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,p.id,0,'critical','Account contact changed','Open the linked account-security record to review this change. Reading this notification does not reverse it.','en','mandatory'
 FROM(SELECT person_id FROM public.account_security_events WHERE academy_id=NEW.academy_id AND id=NEW.account_security_id UNION SELECT c.person_id FROM public.account_security_events e CROSS JOIN LATERAL public.supervisor_chain(e.person_id) c WHERE e.academy_id=NEW.academy_id AND e.id=NEW.account_security_id UNION SELECT master_person_id FROM public.academies WHERE id=NEW.academy_id) audience
 JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;RETURN NULL;
END $$;
ALTER FUNCTION public.publish_account_security_alert() OWNER TO kavosh_event_policy;
CREATE TRIGGER publish_account_security_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='account_security') EXECUTE FUNCTION public.publish_account_security_alert();
DO $$ DECLARE body text;needle text:='IF source.event_id IS NULL';BEGIN
 body=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);IF position(needle IN body)=0 THEN RAISE EXCEPTION 'ACCOUNT_SECURITY_MANDATORY_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,$branch$IF source.source_kind='account_security' THEN
  IF NEW.locale<>'en' OR source.projection->>'severity' IS DISTINCT FROM 'critical' OR NEW.title IS DISTINCT FROM 'Account contact changed' OR NEW.body IS DISTINCT FROM 'Open the linked account-security record to review this change. Reading this notification does not reverse it.' OR NOT EXISTS(SELECT 1 FROM public.account_security_events e JOIN public.people p ON p.academy_id=e.academy_id AND p.id=NEW.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL WHERE e.academy_id=NEW.academy_id AND e.id=source.account_security_id AND(p.id=e.person_id OR public.is_supervisor(p.id,e.person_id) OR p.id=(SELECT master_person_id FROM public.academies WHERE id=NEW.academy_id))) THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);
END $$;

CREATE FUNCTION public.publish_pending_account_security(academies uuid[]) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE t record;i uuid;prior text:=current_setting('app.academy_id',true);BEGIN
 IF academies IS NULL OR cardinality(academies) NOT BETWEEN 1 AND 1000 OR array_position(academies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'INVALID_ACADEMY_LIST';END IF;
 SELECT q.*,e.user_id,e.field,e.occurred_at INTO t FROM identity.contact_change_targets q JOIN identity.contact_change_events e ON e.id=q.event_id WHERE q.academy_id=ANY(academies) AND q.status='pending' ORDER BY q.academy_id,q.event_id,q.person_id FOR UPDATE OF q SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.people p WHERE p.academy_id=t.academy_id AND p.id=t.person_id AND p.kind='human' AND p.auth_user_id=t.user_id) THEN UPDATE identity.contact_change_targets SET status='discarded' WHERE event_id=t.event_id AND academy_id=t.academy_id AND person_id=t.person_id;RETURN true;END IF;
 PERFORM set_config('app.academy_id',t.academy_id::text,true);i=gen_random_uuid();
 INSERT INTO public.account_security_events(academy_id,id,person_id,hub_id,field,occurred_at,contact_event_id) VALUES(t.academy_id,i,t.person_id,t.hub_id,t.field,t.occurred_at,t.event_id);
 UPDATE identity.contact_change_targets SET status='published',published_event_id=i WHERE event_id=t.event_id AND academy_id=t.academy_id AND person_id=t.person_id;
 PERFORM set_config('app.academy_id',coalesce(prior,''),true);RETURN true;
END $$;
ALTER FUNCTION public.publish_pending_account_security(uuid[]) OWNER TO kavosh_identity_policy;
REVOKE ALL ON FUNCTION identity.contact_change_event_guard(),identity.contact_change_target_guard(),public.account_security_event_guard(),public.account_security_projection(uuid),public.account_security_source_guard(),public.capture_account_security_event(),public.account_security_notice_allows(uuid,uuid,jsonb),public.publish_account_security_alert(),public.publish_pending_account_security(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_security_projection(uuid) TO kavosh_event_policy;
GRANT EXECUTE ON FUNCTION public.account_security_notice_allows(uuid,uuid,jsonb) TO kavosh_runtime;
GRANT EXECUTE ON FUNCTION public.publish_pending_account_security(uuid[]) TO kavosh_automation_worker;
REVOKE CREATE ON SCHEMA identity,public FROM kavosh_identity_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 199 $$;

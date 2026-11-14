DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='kavosh_identity') THEN
    CREATE ROLE kavosh_identity NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA identity TO kavosh_identity;
GRANT SELECT,INSERT,UPDATE,DELETE ON identity."user",identity.session,identity.account,identity.verification,identity."twoFactor",identity."rateLimit" TO kavosh_identity;

ALTER TABLE public.people ADD COLUMN auth_user_id uuid REFERENCES identity."user"(id);
CREATE UNIQUE INDEX people_identity ON public.people(academy_id,auth_user_id) WHERE auth_user_id IS NOT NULL;
ALTER TABLE public.audit_events ALTER COLUMN credential_id DROP NOT NULL;
ALTER TABLE public.audit_events ADD COLUMN session_id uuid;
ALTER TABLE public.audit_events ADD COLUMN actor_kind text NOT NULL DEFAULT 'bot';
ALTER TABLE public.audit_events ADD CHECK ((actor_kind='bot' AND credential_id IS NOT NULL AND session_id IS NULL) OR (actor_kind='human' AND credential_id IS NULL AND session_id IS NOT NULL));

CREATE TABLE identity.invites (
  token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  academy_id uuid NOT NULL, person_id uuid NOT NULL,
  email text NOT NULL, master boolean NOT NULL,
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id)
);
CREATE INDEX invites_email ON identity.invites(email);
CREATE TABLE identity.phone_challenges (
  user_id uuid PRIMARY KEY REFERENCES identity."user"(id) ON DELETE CASCADE,
  phone text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE identity.auth_budgets (
  key text PRIMARY KEY, window_start timestamptz NOT NULL, requests integer NOT NULL
);
CREATE TABLE identity.security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES identity."user"(id),
  event text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE,DELETE ON identity.phone_challenges TO kavosh_identity;
GRANT INSERT ON identity.security_events TO kavosh_identity;

CREATE FUNCTION identity.consume_budget(p_key text,p_max integer,p_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE used integer; BEGIN
  IF p_max<1 OR p_max>1000 OR p_seconds<1 OR p_seconds>86400 THEN RETURN false; END IF;
  INSERT INTO identity.auth_budgets AS b VALUES(p_key,clock_timestamp(),1)
  ON CONFLICT(key) DO UPDATE SET
    requests=CASE WHEN b.window_start+make_interval(secs=>p_seconds)>clock_timestamp() THEN b.requests+1 ELSE 1 END,
    window_start=CASE WHEN b.window_start+make_interval(secs=>p_seconds)>clock_timestamp() THEN b.window_start ELSE clock_timestamp() END
  RETURNING requests INTO used;
  RETURN used<=p_max;
END $$;

CREATE FUNCTION identity.inspect_invite(p_hash text,p_email text)
RETURNS TABLE(academy_id uuid,person_id uuid,master boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT i.academy_id,i.person_id,i.master FROM identity.invites i
  JOIN public.people p ON p.academy_id=i.academy_id AND p.id=i.person_id
  JOIN public.academies a ON a.id=i.academy_id
  WHERE i.token_hash=p_hash AND i.email=lower(btrim(p_email)) AND i.consumed_at IS NULL
    AND i.expires_at>clock_timestamp() AND p.kind='human' AND p.status<>'disabled'
    AND a.status IN ('provisioning','active')
$$;

CREATE FUNCTION identity.enforce_user_security() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF EXISTS(SELECT 1 FROM identity.invites i WHERE i.email=lower(NEW.email) AND i.master AND i.consumed_at IS NULL AND i.expires_at>clock_timestamp()) THEN
      NEW."mfaRequired":=true;
    END IF;
  ELSE
    IF OLD."mfaRequired" AND NOT NEW."mfaRequired" THEN RAISE EXCEPTION 'Required MFA cannot be disabled'; END IF;
    IF (NOT coalesce(OLD."phoneNumberVerified",false) AND coalesce(NEW."phoneNumberVerified",false))
      OR NEW."phoneNumber" IS DISTINCT FROM OLD."phoneNumber"
      OR (NOT OLD."mfaRequired" AND NEW."mfaRequired") THEN
      DELETE FROM identity.session WHERE "userId"=OLD.id;
    END IF;
  END IF;
  IF NEW."mfaRequired" AND coalesce(NEW."phoneNumberVerified",false) THEN NEW."twoFactorEnabled":=true; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enforce_user_security BEFORE INSERT OR UPDATE ON identity."user" FOR EACH ROW EXECUTE FUNCTION identity.enforce_user_security();

CREATE FUNCTION identity.accept_invite(p_hash text,p_user uuid,p_session uuid)
RETURNS TABLE(academy_id uuid,code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i identity.invites; u identity."user"; role_id uuid; person public.people; BEGIN
  SELECT * INTO u FROM identity."user" WHERE id=p_user FOR UPDATE;
  IF NOT FOUND OR NOT u."emailVerified" OR NOT coalesce(u."phoneNumberVerified",false) THEN RETURN QUERY SELECT NULL::uuid,'VERIFICATION_REQUIRED'::text; RETURN; END IF;
  SELECT * INTO i FROM identity.invites WHERE token_hash=p_hash AND email=lower(u.email)
    AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid,'INVALID_INVITATION'::text; RETURN; END IF;
  PERFORM 1 FROM public.academies a WHERE a.id=i.academy_id AND (a.status='active' OR (a.status='provisioning' AND i.master)) FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid,'ACADEMY_UNAVAILABLE'::text; RETURN; END IF;
  IF i.master AND NOT u."mfaRequired" THEN
    UPDATE identity."user" SET "mfaRequired"=true WHERE id=p_user;
    RETURN QUERY SELECT NULL::uuid,'MFA_REQUIRED'::text; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM identity.session s WHERE s.id=p_session AND s."userId"=p_user AND (NOT coalesce(u."twoFactorEnabled",false) OR s."mfaVerified") AND s."expiresAt">clock_timestamp()) THEN
    RETURN QUERY SELECT NULL::uuid,'MFA_REQUIRED'::text; RETURN;
  END IF;
  SELECT * INTO person FROM public.people WHERE public.people.academy_id=i.academy_id AND id=i.person_id FOR UPDATE;
  IF person.status='disabled' OR (person.auth_user_id IS NOT NULL AND person.auth_user_id<>p_user) THEN RETURN QUERY SELECT NULL::uuid,'INVALID_INVITATION'::text; RETURN; END IF;
  UPDATE public.people SET auth_user_id=p_user,status='active' WHERE public.people.academy_id=i.academy_id AND id=i.person_id;
  UPDATE identity.invites SET consumed_at=clock_timestamp() WHERE token_hash=p_hash;
  IF i.master THEN
    IF NOT EXISTS(SELECT 1 FROM public.academies a WHERE a.id=i.academy_id AND a.master_person_id=i.person_id) THEN RAISE EXCEPTION 'Invalid master invitation'; END IF;
    SELECT id INTO role_id FROM public.roles r WHERE r.academy_id=i.academy_id AND name='Academy master';
    IF role_id IS NULL THEN
      role_id:=gen_random_uuid(); INSERT INTO public.roles VALUES(i.academy_id,role_id,'Academy master');
      INSERT INTO public.role_permissions SELECT i.academy_id,role_id,c,'allow' FROM unnest(ARRAY['hubs.view','hubs.edit','people.view','people.edit','audit.view','credentials.revoke']) c;
    END IF;
    INSERT INTO public.role_assignments VALUES(i.academy_id,gen_random_uuid(),i.person_id,role_id,true) ON CONFLICT DO NOTHING;
    UPDATE public.academies SET status='active' WHERE id=i.academy_id AND status='provisioning';
  END IF;
  INSERT INTO identity.security_events(user_id,event) VALUES(p_user,'invitation.accepted');
  INSERT INTO public.audit_events(academy_id,id,actor_id,session_id,actor_kind,request_id,action,entity_id,changes)
    VALUES(i.academy_id,gen_random_uuid(),person.id,p_session,'human',gen_random_uuid(),'invitation.accepted',person.id,
      jsonb_build_object('status',jsonb_build_object('before',person.status,'after','active'),'identityBound',true));
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id)
    VALUES(i.academy_id,gen_random_uuid(),'invitation.accepted',person.id,gen_random_uuid());
  RETURN QUERY SELECT i.academy_id,'ACCEPTED'::text;
END $$;

CREATE FUNCTION identity.memberships(p_user uuid)
RETURNS TABLE(academy_id uuid,person_id uuid,name text,status text,master boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT a.id,p.id,a.name,a.status,p.id=a.master_person_id FROM public.people p JOIN public.academies a ON a.id=p.academy_id
  WHERE p.auth_user_id=p_user AND p.status='active' AND a.status IN ('active','read_only')
$$;

CREATE TABLE auth_private.human_rate_windows (
  session_id uuid PRIMARY KEY REFERENCES identity.session(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL, requests integer NOT NULL
);
CREATE FUNCTION public.authenticate_human(p_session uuid,p_user uuid,p_academy uuid)
RETURNS TABLE(token_id uuid,academy_id uuid,person_id uuid,capabilities text[],all_hubs boolean,hub_ids uuid[],allowed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE person uuid; used integer; current_window timestamptz:=date_trunc('minute',clock_timestamp()); BEGIN
  SELECT p.id INTO person FROM public.people p JOIN identity.session s ON s.id=p_session AND s."userId"=p.auth_user_id
  JOIN identity."user" u ON u.id=s."userId"
  WHERE p.academy_id=p_academy AND p.auth_user_id=p_user AND p.kind='human' AND p.status='active'
    AND s."expiresAt">clock_timestamp() AND u."emailVerified" AND coalesce(u."phoneNumberVerified",false)
    AND (NOT coalesce(u."twoFactorEnabled",false) OR s."mfaVerified");
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO auth_private.human_rate_windows AS r VALUES(p_session,current_window,1)
    ON CONFLICT(session_id) DO UPDATE SET window_start=current_window,
    requests=CASE WHEN r.window_start=current_window THEN r.requests+1 ELSE 1 END RETURNING requests INTO used;
  RETURN QUERY SELECT p_session,p_academy,person,ARRAY['hubs.view','hubs.edit','people.view','people.edit','audit.view','credentials.revoke']::text[],true,ARRAY[]::uuid[],used<=120;
END $$;
CREATE FUNCTION public.lock_human(p_session uuid,p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM 1 FROM identity.session s JOIN identity."user" u ON u.id=s."userId"
  JOIN public.people p ON p.auth_user_id=u.id
  WHERE s.id=p_session AND u.id=p_user AND s."expiresAt">clock_timestamp()
    AND p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.status='active'
    AND u."emailVerified" AND coalesce(u."phoneNumberVerified",false)
    AND (NOT coalesce(u."twoFactorEnabled",false) OR s."mfaVerified") FOR SHARE OF s,u,p;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION identity.consume_budget(text,integer,integer),identity.inspect_invite(text,text),identity.accept_invite(text,uuid,uuid),identity.memberships(uuid),identity.enforce_user_security() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.consume_budget(text,integer,integer),identity.inspect_invite(text,text),identity.accept_invite(text,uuid,uuid),identity.memberships(uuid) TO kavosh_identity;
REVOKE ALL ON FUNCTION public.authenticate_human(uuid,uuid,uuid),public.lock_human(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authenticate_human(uuid,uuid,uuid),public.lock_human(uuid,uuid) TO kavosh_runtime;

-- Narrow, non-login policy executor. Never grant it to either application login.
-- FORCE RLS also applies to table owners: these explicit policies avoid relying
-- on a superuser migration account for cross-tenant invitation resolution.
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_identity_policy') THEN
    CREATE ROLE kavosh_identity_policy NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT kavosh_identity_policy TO CURRENT_USER;
GRANT USAGE,CREATE ON SCHEMA identity,public TO kavosh_identity_policy;
GRANT USAGE ON SCHEMA auth_private TO kavosh_identity_policy;
GRANT SELECT ON public.academies,public.people,public.roles,public.role_permissions,public.role_assignments TO kavosh_identity_policy;
GRANT UPDATE(status) ON public.academies TO kavosh_identity_policy;
GRANT UPDATE(auth_user_id,status) ON public.people TO kavosh_identity_policy;
GRANT INSERT ON public.roles,public.role_permissions,public.role_assignments,public.audit_events,public.outbox_events TO kavosh_identity_policy;
GRANT SELECT,UPDATE ON identity."user",identity.invites TO kavosh_identity_policy;
GRANT SELECT ON identity.session TO kavosh_identity_policy;
GRANT UPDATE(id) ON identity.session TO kavosh_identity_policy;
GRANT INSERT ON identity.security_events TO kavosh_identity_policy;
GRANT SELECT,INSERT,UPDATE ON auth_private.human_rate_windows TO kavosh_identity_policy;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['academies','people','roles','role_permissions','role_assignments','audit_events','outbox_events'] LOOP
    EXECUTE format('CREATE POLICY identity_policy_executor ON public.%I TO kavosh_identity_policy USING(true) WITH CHECK(true)',t);
  END LOOP;
END $$;
ALTER FUNCTION identity.inspect_invite(text,text) OWNER TO kavosh_identity_policy;
ALTER FUNCTION identity.accept_invite(text,uuid,uuid) OWNER TO kavosh_identity_policy;
ALTER FUNCTION identity.memberships(uuid) OWNER TO kavosh_identity_policy;
ALTER FUNCTION public.authenticate_human(uuid,uuid,uuid) OWNER TO kavosh_identity_policy;
ALTER FUNCTION public.lock_human(uuid,uuid) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA identity,public FROM kavosh_identity_policy;

CREATE FUNCTION public.protect_master_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.auth_user_id IS NOT NULL AND NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
    AND EXISTS(SELECT 1 FROM public.academies a WHERE a.id=OLD.academy_id AND a.master_person_id=OLD.id) THEN
    RAISE EXCEPTION 'Master identity is not transferable';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.protect_master_identity() FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO kavosh_identity_policy;
ALTER FUNCTION public.protect_master_identity() OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_identity_policy;
CREATE TRIGGER protect_master_identity BEFORE UPDATE OF auth_user_id ON public.people
FOR EACH ROW EXECUTE FUNCTION public.protect_master_identity();

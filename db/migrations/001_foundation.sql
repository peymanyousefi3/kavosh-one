-- Run with the dedicated migration owner, never the application's credentials.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kavosh_runtime') THEN
    CREATE ROLE kavosh_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA auth_private;
REVOKE ALL ON SCHEMA auth_private FROM PUBLIC;

CREATE TABLE public.academies (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','active','read_only','suspended')),
  master_person_id uuid NOT NULL,
  master_kind text NOT NULL DEFAULT 'human' CHECK (master_kind = 'human'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.hubs (
  academy_id uuid NOT NULL REFERENCES public.academies(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  city text NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (academy_id,id)
);
CREATE TABLE public.people (
  academy_id uuid NOT NULL REFERENCES public.academies(id),
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('human','bot')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  email text CHECK (length(email) <= 254),
  hub_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','pending')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (academy_id,id),
  UNIQUE (academy_id,id,kind),
  FOREIGN KEY (academy_id,hub_id) REFERENCES public.hubs(academy_id,id)
);
ALTER TABLE public.academies ADD CONSTRAINT academy_human_master
  FOREIGN KEY (id,master_person_id,master_kind) REFERENCES public.people(academy_id,id,kind)
  DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION public.protect_master() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.master_person_id IS DISTINCT FROM OLD.master_person_id THEN
    RAISE EXCEPTION 'Academy master identity is not transferable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_master BEFORE UPDATE ON public.academies FOR EACH ROW EXECUTE FUNCTION public.protect_master();

CREATE TABLE public.roles (
  academy_id uuid NOT NULL REFERENCES public.academies(id),
  id uuid NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (academy_id,id), UNIQUE (academy_id,name)
);
CREATE TABLE public.role_permissions (
  academy_id uuid NOT NULL,
  role_id uuid NOT NULL,
  capability text NOT NULL CHECK (capability IN ('hubs.view','hubs.edit','people.view','people.edit','audit.view','credentials.revoke')),
  effect text NOT NULL CHECK (effect IN ('allow','deny')),
  PRIMARY KEY (academy_id,role_id,capability),
  FOREIGN KEY (academy_id,role_id) REFERENCES public.roles(academy_id,id)
);
CREATE TABLE public.role_assignments (
  academy_id uuid NOT NULL,
  id uuid NOT NULL,
  person_id uuid NOT NULL,
  role_id uuid NOT NULL,
  all_hubs boolean NOT NULL DEFAULT false,
  PRIMARY KEY (academy_id,id),
  UNIQUE (academy_id,person_id,role_id),
  FOREIGN KEY (academy_id,person_id) REFERENCES public.people(academy_id,id),
  FOREIGN KEY (academy_id,role_id) REFERENCES public.roles(academy_id,id)
);
CREATE TABLE public.assignment_hubs (
  academy_id uuid NOT NULL, assignment_id uuid NOT NULL, hub_id uuid NOT NULL,
  PRIMARY KEY (academy_id,assignment_id,hub_id),
  FOREIGN KEY (academy_id,assignment_id) REFERENCES public.role_assignments(academy_id,id),
  FOREIGN KEY (academy_id,hub_id) REFERENCES public.hubs(academy_id,id)
);

CREATE TABLE auth_private.credentials (
  id uuid PRIMARY KEY,
  academy_id uuid NOT NULL,
  person_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  capabilities text[] NOT NULL CHECK (capabilities <@ ARRAY['hubs.view','hubs.edit','people.view','people.edit','audit.view','credentials.revoke']::text[]),
  all_hubs boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (academy_id,person_id) REFERENCES public.people(academy_id,id)
);
CREATE TABLE auth_private.credential_hubs (
  credential_id uuid NOT NULL REFERENCES auth_private.credentials(id),
  academy_id uuid NOT NULL, hub_id uuid NOT NULL,
  PRIMARY KEY (credential_id,hub_id),
  FOREIGN KEY (academy_id,hub_id) REFERENCES public.hubs(academy_id,id)
);
-- Constrain the credential's hub academy too, not just the hub's existence.
ALTER TABLE auth_private.credentials ADD UNIQUE (academy_id,id);
ALTER TABLE auth_private.credential_hubs ADD FOREIGN KEY (academy_id,credential_id)
  REFERENCES auth_private.credentials(academy_id,id);
CREATE TABLE auth_private.rate_windows (
  credential_id uuid PRIMARY KEY REFERENCES auth_private.credentials(id),
  window_start timestamptz NOT NULL,
  requests integer NOT NULL
);

CREATE FUNCTION public.authenticate_bot(p_hash text)
RETURNS TABLE(token_id uuid,academy_id uuid,person_id uuid,capabilities text[],all_hubs boolean,hub_ids uuid[],allowed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE c auth_private.credentials; used integer; current_window timestamptz := date_trunc('minute',clock_timestamp());
BEGIN
  SELECT * INTO c FROM auth_private.credentials t
    WHERE t.token_hash = p_hash AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp();
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO auth_private.rate_windows AS r VALUES(c.id,current_window,1)
    ON CONFLICT (credential_id) DO UPDATE SET
      window_start = current_window,
      requests = CASE WHEN r.window_start = current_window THEN r.requests + 1 ELSE 1 END
    RETURNING requests INTO used;
  RETURN QUERY SELECT c.id,c.academy_id,c.person_id,c.capabilities,c.all_hubs,
    ARRAY(SELECT h.hub_id FROM auth_private.credential_hubs h WHERE h.credential_id=c.id), used <= 120;
END $$;
REVOKE ALL ON FUNCTION public.authenticate_bot(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authenticate_bot(text) TO kavosh_runtime;

CREATE FUNCTION public.lock_bot(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM auth_private.credentials t WHERE t.id=p_id
    AND t.academy_id = nullif(current_setting('app.academy_id',true),'')::uuid
    AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp() FOR SHARE;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.lock_bot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_bot(uuid) TO kavosh_runtime;

CREATE FUNCTION public.revoke_bot(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE auth_private.credentials SET revoked_at=clock_timestamp()
    WHERE id=p_id AND academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND revoked_at IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.revoke_bot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_bot(uuid) TO kavosh_runtime;

CREATE TABLE public.audit_events (
  academy_id uuid NOT NULL REFERENCES public.academies(id), id uuid NOT NULL,
  actor_id uuid NOT NULL, credential_id uuid NOT NULL, request_id uuid NOT NULL,
  action text NOT NULL, entity_id uuid NOT NULL, hub_id uuid,
  changes jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (academy_id,id),
  FOREIGN KEY (academy_id,actor_id) REFERENCES public.people(academy_id,id),
  FOREIGN KEY (academy_id,hub_id) REFERENCES public.hubs(academy_id,id)
);
CREATE TABLE public.outbox_events (
  academy_id uuid NOT NULL REFERENCES public.academies(id), id uuid NOT NULL,
  event_type text NOT NULL, entity_id uuid NOT NULL, request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (academy_id,id)
);
CREATE TABLE public.request_keys (
  academy_id uuid NOT NULL REFERENCES public.academies(id), credential_id uuid NOT NULL,
  key uuid NOT NULL, request_hash text NOT NULL, status_code integer, response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (academy_id,credential_id,key)
);
CREATE INDEX people_hub ON public.people(academy_id,hub_id,id);
CREATE INDEX assignments_person ON public.role_assignments(academy_id,person_id);
CREATE INDEX audit_time ON public.audit_events(academy_id,created_at DESC,id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['academies','hubs','people','roles','role_permissions','role_assignments','assignment_hubs','audit_events','outbox_events','request_keys'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING (%I = nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK (%I = nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t,CASE WHEN t='academies' THEN 'id' ELSE 'academy_id' END,CASE WHEN t='academies' THEN 'id' ELSE 'academy_id' END);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO kavosh_runtime;
GRANT SELECT ON public.academies,public.hubs,public.people,public.roles,public.role_permissions,public.role_assignments,public.assignment_hubs,public.audit_events TO kavosh_runtime;
GRANT INSERT ON public.hubs,public.people,public.audit_events,public.outbox_events TO kavosh_runtime;
GRANT SELECT,INSERT ON public.request_keys TO kavosh_runtime;
GRANT UPDATE (status_code,response) ON public.request_keys TO kavosh_runtime;
-- No UPDATE/DELETE of audit rows, no token table access, no role/grant writes.

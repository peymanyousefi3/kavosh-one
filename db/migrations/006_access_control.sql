CREATE TABLE public.capability_catalog (
  name text PRIMARY KEY CHECK(name ~ '^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$'),
  label text NOT NULL, workspace text NOT NULL,
  sensitive boolean NOT NULL DEFAULT false
);
INSERT INTO public.capability_catalog VALUES
 ('hubs.view','View hubs','Academy',false),('hubs.edit','Manage hubs','Academy',false),
 ('people.view','View people','People',false),('people.edit','Manage people','People',false),
 ('audit.view','View change history','Administration',true),('credentials.revoke','Revoke bot credentials','Administration',true),
 ('roles.view','View role templates','Administration',true),('roles.edit','Manage role templates','Administration',true),
 ('access.view','View assigned access','Administration',true),('access.edit','Manage assigned access','Administration',true),
 ('approvals.view','View approval cases','Administration',true),('approvals.review','Review subordinate requests','Administration',true);
GRANT SELECT ON public.capability_catalog TO kavosh_runtime,kavosh_identity_policy;
ALTER TABLE public.role_permissions DROP CONSTRAINT role_permissions_capability_check;
ALTER TABLE public.role_permissions ADD FOREIGN KEY(capability) REFERENCES public.capability_catalog(name);
ALTER TABLE auth_private.credentials DROP CONSTRAINT credentials_capabilities_check;
CREATE FUNCTION auth_private.validate_capabilities() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF cardinality(NEW.capabilities)>1000 OR EXISTS(SELECT 1 FROM unnest(NEW.capabilities) c WHERE NOT EXISTS(SELECT 1 FROM public.capability_catalog p WHERE p.name=c)) THEN
    RAISE EXCEPTION 'Unregistered capability' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION auth_private.validate_capabilities() FROM PUBLIC;
CREATE TRIGGER validate_capabilities BEFORE INSERT OR UPDATE OF capabilities ON auth_private.credentials
FOR EACH ROW EXECUTE FUNCTION auth_private.validate_capabilities();

ALTER TABLE public.roles ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE public.roles ADD COLUMN description text NOT NULL DEFAULT '' CHECK(length(description)<=1000);
ALTER TABLE public.roles ADD COLUMN system_role boolean NOT NULL DEFAULT false;
UPDATE public.roles SET system_role=true WHERE name='Academy master';
ALTER TABLE public.people ADD COLUMN access_version integer NOT NULL DEFAULT 1 CHECK(access_version>0);
ALTER TABLE public.people ADD COLUMN supervisor_person_id uuid;
ALTER TABLE public.people ADD COLUMN supervisor_kind text NOT NULL DEFAULT 'human' CHECK(supervisor_kind='human');
ALTER TABLE public.people ADD FOREIGN KEY(academy_id,supervisor_person_id,supervisor_kind) REFERENCES public.people(academy_id,id,kind);
CREATE INDEX people_supervisor ON public.people(academy_id,supervisor_person_id,id);

CREATE FUNCTION public.scope_contains(p_source jsonb,p_target jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_target->>'all'='true' THEN p_source->>'all'='true' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(coalesce(p_source->'excludedHubs','[]'::jsonb)) h
    WHERE NOT coalesce(p_target->'excludedHubs','[]'::jsonb) ? h)
  ELSE NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_target->'hubs') h WHERE NOT (
    CASE WHEN p_source->>'all'='true' THEN NOT coalesce(p_source->'excludedHubs','[]'::jsonb) ? h
      ELSE p_source->'hubs' ? h END)) END
$$;
REVOKE ALL ON FUNCTION public.scope_contains(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scope_contains(jsonb,jsonb) TO kavosh_runtime;

CREATE FUNCTION public.is_supervisor(p_supervisor uuid,p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  WITH RECURSIVE managers(id,next_id,seen,depth) AS (
    SELECT p.id,coalesce(p.supervisor_person_id,a.master_person_id),ARRAY[p.id],0
    FROM public.people p JOIN public.academies a ON a.id=p.academy_id WHERE p.id=p_person
    UNION ALL
    SELECT p.id,coalesce(p.supervisor_person_id,a.master_person_id),m.seen||p.id,m.depth+1
    FROM managers m JOIN public.people p ON p.id=m.next_id JOIN public.academies a ON a.id=p.academy_id
    WHERE NOT p.id=ANY(m.seen) AND m.depth<64
  ) SELECT EXISTS(SELECT 1 FROM managers WHERE id=p_supervisor AND depth>0)
$$;
REVOKE ALL ON FUNCTION public.is_supervisor(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_supervisor(uuid,uuid) TO kavosh_runtime;
CREATE FUNCTION public.validate_supervisor() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE current_person uuid; seen uuid[]:=ARRAY[NEW.id]; depth integer:=0; BEGIN
  IF NEW.supervisor_person_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));
  IF EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.id) THEN
    RAISE EXCEPTION 'Master cannot have a supervisor' USING ERRCODE='23514';
  END IF;
  current_person:=NEW.supervisor_person_id;
  WHILE current_person IS NOT NULL LOOP
    IF current_person=ANY(seen) OR depth>=64 THEN RAISE EXCEPTION 'Invalid supervisor hierarchy' USING ERRCODE='23514'; END IF;
    seen:=seen||current_person;depth:=depth+1;
    SELECT supervisor_person_id INTO current_person FROM public.people WHERE academy_id=NEW.academy_id AND id=current_person;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.validate_supervisor() FROM PUBLIC;
CREATE TRIGGER validate_supervisor BEFORE INSERT OR UPDATE OF supervisor_person_id ON public.people
FOR EACH ROW EXECUTE FUNCTION public.validate_supervisor();

CREATE TABLE public.approval_requests (
  academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,
  requester_id uuid NOT NULL,requester_kind text NOT NULL CHECK(requester_kind IN ('human','bot')),
  credential_snapshot jsonb NOT NULL,grants_hash text NOT NULL CHECK(grants_hash ~ '^[a-f0-9]{64}$'),
  dependency_hash text NOT NULL CHECK(dependency_hash ~ '^[a-f0-9]{64}$'),review_context jsonb NOT NULL,
  action text NOT NULL CHECK(length(action)<=100),target_id uuid NOT NULL,target_version integer NOT NULL CHECK(target_version>=0),
  payload jsonb NOT NULL,scope jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected','withdrawn','stale')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),reviewer_id uuid,reason text,decision_code text,
  created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,
  PRIMARY KEY(academy_id,id),
  FOREIGN KEY(academy_id,requester_id) REFERENCES public.people(academy_id,id),
  FOREIGN KEY(academy_id,reviewer_id) REFERENCES public.people(academy_id,id),
  CHECK((status='pending' AND reviewer_id IS NULL AND decided_at IS NULL) OR (status<>'pending' AND decided_at IS NOT NULL)),
  CHECK((status='stale' AND decision_code IS NOT NULL) OR (status<>'stale' AND decision_code IS NULL)),
  CHECK(jsonb_typeof(payload)='object' AND jsonb_typeof(scope)='object' AND jsonb_typeof(credential_snapshot)='object' AND jsonb_typeof(review_context)='object')
);
CREATE INDEX approvals_pending ON public.approval_requests(academy_id,status,created_at,id);
CREATE INDEX approvals_requester ON public.approval_requests(academy_id,requester_id,created_at,id);
ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.approval_requests
  USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid)
  WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT,INSERT ON public.approval_requests TO kavosh_runtime;
GRANT UPDATE(status,version,reviewer_id,reason,decision_code,decided_at) ON public.approval_requests TO kavosh_runtime;
GRANT UPDATE(name,description,version),DELETE ON public.roles TO kavosh_runtime;
GRANT INSERT ON public.roles,public.role_permissions,public.role_assignments,public.assignment_hubs TO kavosh_runtime;
GRANT UPDATE(effect),DELETE ON public.role_permissions TO kavosh_runtime;
GRANT DELETE ON public.role_assignments,public.assignment_hubs TO kavosh_runtime;
GRANT UPDATE(access_version,supervisor_person_id) ON public.people TO kavosh_runtime;

-- Return only safe credential metadata to approval revalidation; never hashes/tokens.
CREATE FUNCTION public.current_bot_scope(p_id uuid)
RETURNS TABLE(token_id uuid,academy_id uuid,person_id uuid,capabilities text[],all_hubs boolean,hub_ids uuid[],allowed boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT c.id,c.academy_id,c.person_id,c.capabilities,c.all_hubs,
    ARRAY(SELECT h.hub_id FROM auth_private.credential_hubs h WHERE h.credential_id=c.id),true
  FROM auth_private.credentials c WHERE c.id=p_id AND c.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid
    AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
$$;
REVOKE ALL ON FUNCTION public.current_bot_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_bot_scope(uuid) TO kavosh_runtime;

CREATE OR REPLACE FUNCTION public.authenticate_human(p_session uuid,p_user uuid,p_academy uuid)
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
  RETURN QUERY SELECT p_session,p_academy,person,ARRAY(SELECT name FROM public.capability_catalog ORDER BY name),true,ARRAY[]::uuid[],used<=120;
END $$;

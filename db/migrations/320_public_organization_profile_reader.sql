DO $$ DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['kavosh_public_profile_policy','kavosh_public_profile_service'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=n) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS',n);END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=n AND(r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid))) THEN RAISE EXCEPTION 'UNSAFE_PUBLIC_PROFILE_ROLE';END IF;
END LOOP;END $$;
GRANT kavosh_public_profile_policy TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO kavosh_public_profile_policy,kavosh_public_profile_service;
GRANT SELECT(academy_id,id,anchor_kind,person_id,hub_id,version,definition) ON public.community_profiles TO kavosh_public_profile_policy;
GRANT SELECT(id,status) ON public.academies TO kavosh_public_profile_policy;
GRANT SELECT(academy_id,id,active) ON public.hubs TO kavosh_public_profile_policy;
GRANT SELECT(academy_id,profile_id,version) ON public.profile_publication_heads,public.profile_moderation_heads TO kavosh_public_profile_policy;
GRANT SELECT(public_id) ON public.profile_publication_heads TO kavosh_public_profile_policy;
GRANT SELECT(academy_id,profile_id,version,profile_version,audience) ON public.profile_publication_changes TO kavosh_public_profile_policy;
GRANT SELECT(academy_id,profile_id,version,restricted) ON public.profile_moderation_changes TO kavosh_public_profile_policy;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['community_profiles','academies','hubs','profile_publication_heads','profile_publication_changes','profile_moderation_heads','profile_moderation_changes'] LOOP
 EXECUTE format('CREATE POLICY public_profile_source_read ON public.%I FOR SELECT TO kavosh_public_profile_policy USING(true)',t);
END LOOP;END $$;
-- Restrictive as well as permissive: even a caller-supplied tenant setting
-- cannot make this executor read a personal/student profile row.
CREATE POLICY public_profile_organization_only ON public.community_profiles AS RESTRICTIVE FOR SELECT TO kavosh_public_profile_policy USING(anchor_kind IN('academy','hub') AND person_id IS NULL);
CREATE TABLE public.profile_public_rate_windows(key text PRIMARY KEY CHECK(key~'^[a-f0-9]{64}$'),started_at timestamptz NOT NULL,used integer NOT NULL CHECK(used BETWEEN 1 AND 1000000));
CREATE INDEX profile_public_rate_cleanup ON public.profile_public_rate_windows(started_at);
ALTER TABLE public.profile_public_rate_windows ENABLE ROW LEVEL SECURITY;ALTER TABLE public.profile_public_rate_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY public_profile_budget ON public.profile_public_rate_windows TO kavosh_public_profile_policy USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.profile_public_rate_windows TO kavosh_public_profile_policy;
CREATE FUNCTION public.read_published_organization_profile(p_profile uuid,p_budget text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE school uuid;at_time timestamptz:=clock_timestamp();used integer;data jsonb;BEGIN
 IF p_profile IS NULL OR p_budget IS NULL OR p_budget!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_PUBLIC_PROFILE_INPUT' USING ERRCODE='22023';END IF;
 INSERT INTO public.profile_public_rate_windows AS r(key,started_at,used) VALUES(p_budget,date_trunc('minute',at_time),1)
 ON CONFLICT(key) DO UPDATE SET started_at=greatest(r.started_at,excluded.started_at),used=CASE WHEN r.started_at>=excluded.started_at THEN least(r.used+1,1000000) ELSE 1 END RETURNING r.used INTO used;
 IF used IS NULL THEN RAISE EXCEPTION 'PUBLIC_PROFILE_BUDGET_MISSING' USING ERRCODE='XX000';END IF;
 DELETE FROM public.profile_public_rate_windows WHERE key IN(SELECT key FROM public.profile_public_rate_windows WHERE key<>p_budget AND started_at<at_time-interval '24 hours' ORDER BY started_at,key LIMIT 25 FOR UPDATE SKIP LOCKED);
 IF used>120 THEN RETURN jsonb_build_object('limited',true);END IF;
 SELECT academy_id INTO school FROM public.profile_publication_heads WHERE public_id=p_profile;
 IF school IS NULL THEN RETURN jsonb_build_object('limited',false,'data',NULL);END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(school::text,310));PERFORM pg_advisory_xact_lock_shared(hashtextextended(school::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(school::text,9));
 SELECT jsonb_build_object('id',ph.public_id,'kind',p.anchor_kind,'profileVersion',p.version,'publicationVersion',c.version,'content',p.definition->'content','links',p.definition->'links','contentFormat','plain_text','mediaIncluded',false) INTO data
 FROM public.profile_publication_heads ph JOIN public.profile_publication_changes c ON c.academy_id=ph.academy_id AND c.profile_id=ph.profile_id AND c.version=ph.version
 JOIN public.community_profiles p ON p.academy_id=c.academy_id AND p.id=c.profile_id JOIN public.academies a ON a.id=p.academy_id LEFT JOIN public.hubs h ON h.academy_id=p.academy_id AND h.id=p.hub_id
 LEFT JOIN public.profile_moderation_heads mh ON mh.academy_id=p.academy_id AND mh.profile_id=p.id LEFT JOIN public.profile_moderation_changes mc ON mc.academy_id=mh.academy_id AND mc.profile_id=mh.profile_id AND mc.version=mh.version
 WHERE ph.public_id=p_profile AND p.academy_id=school AND p.anchor_kind IN('academy','hub') AND p.person_id IS NULL AND c.audience='public' AND p.version=c.profile_version AND p.definition->'archived'='false'::jsonb AND NOT coalesce(mc.restricted,false) AND a.status IN('active','read_only') AND(p.anchor_kind='academy' OR h.active);
 RETURN jsonb_build_object('limited',false,'data',data);
END $$;
REVOKE ALL ON FUNCTION public.read_published_organization_profile(uuid,text) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO kavosh_public_profile_policy;
ALTER FUNCTION public.read_published_organization_profile(uuid,text) OWNER TO kavosh_public_profile_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_public_profile_policy;
GRANT EXECUTE ON FUNCTION public.read_published_organization_profile(uuid,text),public.schema_revision() TO kavosh_public_profile_service;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 320 $$;

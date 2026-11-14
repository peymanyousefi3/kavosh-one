-- Read-only school data behind the separately sealed owner/MFA broker.
-- The migration runner compiles that broker against the final live catalog in
-- the SAME transaction. There is no raw data grant to web/platform-service.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kavosh_disposition_policy') THEN
  CREATE ROLE kavosh_disposition_policy NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public,identity,platform_private TO kavosh_disposition_policy;
GRANT SELECT(user_id) ON platform_private.owner_registration TO kavosh_disposition_policy;
GRANT SELECT(id,"emailVerified","phoneNumberVerified","phoneNumber","mfaRequired","twoFactorEnabled") ON identity."user" TO kavosh_disposition_policy;
GRANT SELECT(id,"userId","expiresAt","mfaVerified") ON identity.session TO kavosh_disposition_policy;
GRANT EXECUTE ON FUNCTION platform_private.authorize_owner(uuid,uuid,boolean),public.schema_revision() TO kavosh_disposition_policy;
GRANT INSERT ON platform_private.audit_events TO kavosh_disposition_policy;
GRANT SELECT(id,academy_id) ON platform_private.academy_legal_holds TO kavosh_disposition_policy;
GRANT SELECT(hold_id) ON platform_private.academy_legal_hold_releases TO kavosh_disposition_policy;
DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND NOT a.attisdropped AND a.attname=CASE WHEN c.relname='academies' THEN 'id' ELSE 'academy_id' END)
 LOOP
  EXECUTE format('GRANT SELECT ON public.%I TO kavosh_disposition_policy',r.relname);
  IF NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=r.oid AND p.polname='disposition_reader_select') THEN
   EXECUTE format('CREATE POLICY disposition_reader_select ON public.%I FOR SELECT TO kavosh_disposition_policy USING(true)',r.relname);
  END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 428 $$;

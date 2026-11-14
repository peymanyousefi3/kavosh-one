INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('guardians.view','View private guardian profiles and verified contacts','People',true,ARRAY['hub','person','country','region','city']),
 ('guardians.edit','Manage private guardian profile details','People',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.guardian_profiles (
 academy_id uuid NOT NULL,person_id uuid NOT NULL,person_kind text NOT NULL DEFAULT 'human' CHECK(person_kind='human'),
 legal_name text NOT NULL CHECK(length(legal_name) BETWEEN 1 AND 200),wechat_id text CHECK(length(wechat_id) BETWEEN 1 AND 100),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,person_id),FOREIGN KEY(academy_id,person_id,person_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE TABLE public.guardian_profile_revisions (
 academy_id uuid NOT NULL,person_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),changed_by uuid NOT NULL,reason text NOT NULL CHECK(length(reason)<=2000),changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,person_id,version),FOREIGN KEY(academy_id,person_id) REFERENCES public.guardian_profiles(academy_id,person_id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['guardian_profiles','guardian_profile_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON public.guardian_profiles,public.guardian_profile_revisions TO kavosh_runtime;
GRANT UPDATE(legal_name,wechat_id,version) ON public.guardian_profiles TO kavosh_runtime;
-- Expose only contact/verification facts for a guardian in this tenant, never
-- identity secrets. Profile editors cannot manufacture verification flags.
CREATE FUNCTION public.guardian_contact_status(p_person uuid)
RETURNS TABLE(email text,phone text,email_verified boolean,phone_verified boolean,account_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(u.email,p.email),u."phoneNumber",coalesce(u."emailVerified",false),
   coalesce(u."phoneNumberVerified" AND u."phoneNumber" ~ '^[+][1-9][0-9]{7,14}$',false),
   p.status='active' AND u.id IS NOT NULL
 FROM public.guardian_profiles g JOIN public.people p ON p.academy_id=g.academy_id AND p.id=g.person_id
 LEFT JOIN identity."user" u ON u.id=p.auth_user_id
 WHERE g.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND g.person_id=p_person AND p.kind='human'
$$;
REVOKE ALL ON FUNCTION public.guardian_contact_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_contact_status(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 14 $$;

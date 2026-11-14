-- Reuse authored identity drafts and the existing protected file pipeline.
-- No new contact/name directory,public route,automatic publication or logo copy.
ALTER TABLE public.community_profiles DROP CONSTRAINT community_profiles_anchor_kind_check;
ALTER TABLE public.community_profiles ADD CHECK(anchor_kind IN('academy','person','hub'));
ALTER TABLE public.community_profiles DROP CONSTRAINT community_profiles_check;
ALTER TABLE public.community_profiles ADD CHECK((anchor_kind='academy' AND person_id IS NULL AND hub_id IS NULL) OR(anchor_kind='person' AND person_id IS NOT NULL AND hub_id IS NULL) OR(anchor_kind='hub' AND hub_id IS NOT NULL AND person_id IS NULL));
ALTER TABLE public.community_profiles ADD FOREIGN KEY(academy_id) REFERENCES public.academies(id);
CREATE UNIQUE INDEX community_profile_academy ON public.community_profiles(academy_id) WHERE anchor_kind='academy';
DO $$ DECLARE body text;needle text;fn text;BEGIN
 body=pg_get_functiondef('public.community_profile_owner(text,uuid,boolean)'::regprocedure);needle='IF p_kind=''person'' THEN';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'ACADEMY_PROFILE_OWNER_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,$branch$IF p_kind='academy' THEN
  -- Freeze status through the existing ordered platform/identity gates. The
  -- web role deliberately has no academy UPDATE privilege,even for row locks.
  IF p_lock THEN PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));END IF;
  SELECT id,status INTO r FROM public.academies WHERE id=tenant AND id=p_id;
  IF r.id IS NULL THEN RETURN NULL;END IF;active=r.status IN('active','read_only');s='{"all":true,"hubs":[]}'::jsonb;
 ELSIF p_kind='person' THEN$branch$);
 FOREACH fn IN ARRAY ARRAY['public.guard_community_profile()','public.require_community_profile_receipt()'] LOOP
  body=pg_get_functiondef(fn::regprocedure);needle='coalesce(NEW.person_id,NEW.hub_id)';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'ACADEMY_PROFILE_GUARD_BASE_UNEXPECTED';END IF;EXECUTE replace(body,needle,'coalesce(NEW.person_id,NEW.hub_id,NEW.academy_id)');
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 168 $$;

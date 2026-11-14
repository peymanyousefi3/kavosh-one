-- Private profile-image references do not publish content or grant file access.
CREATE FUNCTION public.community_profile_avatar_shape(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN v IS NULL OR v='null'::jsonb THEN true ELSE
 jsonb_typeof(v)='object' AND v ?& ARRAY['fileId','fileVersion','copyId'] AND v-ARRAY['fileId','fileVersion','copyId']='{}'::jsonb
 AND jsonb_typeof(v->'fileId')='string' AND v->>'fileId'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND jsonb_typeof(v->'copyId')='string' AND v->>'copyId'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND CASE WHEN jsonb_typeof(v->'fileVersion')='number' AND v->>'fileVersion'~'^[1-9][0-9]{0,9}$' THEN(v->>'fileVersion')::numeric<=2147483647 ELSE false END END
$$;
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.community_profile_definition_valid(jsonb)'::regprocedure);needle='d-ARRAY[''content'',''links'',''archived'']<>''{}''::jsonb';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PROFILE_IMAGE_DEFINITION_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'d-ARRAY[''content'',''links'',''archived'',''avatar'']<>''{}''::jsonb OR public.community_profile_avatar_shape(d->''avatar'') IS NOT TRUE');
END $$;
CREATE FUNCTION public.guard_community_profile_image() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE v jsonb;f public.file_records%ROWTYPE;BEGIN
 v=NEW.definition->'avatar';IF v IS NULL OR v='null'::jsonb THEN RETURN NEW;END IF;
 IF public.community_profile_avatar_shape(v) IS NOT TRUE THEN RAISE EXCEPTION 'COMMUNITY_PROFILE_AVATAR_INVALID' USING ERRCODE='23514';END IF;
 -- Archiving may retain an already saved reference,even if the file became
 -- stale/inaccessible. Archived profiles cannot issue image download links.
 IF TG_OP='UPDATE' AND NEW.definition->'archived'='true'::jsonb AND v IS NOT DISTINCT FROM OLD.definition->'avatar' THEN RETURN NEW;END IF;
 SELECT * INTO f FROM public.file_records WHERE academy_id=NEW.academy_id AND id=(v->>'fileId')::uuid FOR SHARE;
 IF f.id IS NULL OR f.domain<>'general' OR f.archived OR f.version<>(v->>'fileVersion')::integer
 OR f.claimed_mime_type NOT IN('image/jpeg','image/png','image/webp','image/gif','image/avif')
 OR f.anchor_kind<>NEW.anchor_kind OR(NEW.anchor_kind='person' AND f.person_id IS DISTINCT FROM NEW.person_id) OR(NEW.anchor_kind='hub' AND f.hub_id IS DISTINCT FROM NEW.hub_id)
 OR NOT EXISTS(SELECT 1 FROM public.file_copy_requests c WHERE c.academy_id=NEW.academy_id AND c.id=(v->>'copyId')::uuid AND c.file_id=f.id)
 THEN RAISE EXCEPTION 'COMMUNITY_PROFILE_AVATAR_INVALID' USING ERRCODE='23514';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER community_profile_image_guard BEFORE INSERT OR UPDATE ON public.community_profiles FOR EACH ROW EXECUTE FUNCTION public.guard_community_profile_image();
REVOKE ALL ON FUNCTION public.community_profile_avatar_shape(jsonb),public.guard_community_profile_image() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.community_profile_avatar_shape(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 157 $$;

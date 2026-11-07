-- Authored community content is separate from legal enrolment/contact records.
-- This migration creates no community feed,public route or implicit publication.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('profiles.view','View permitted private person/hub community profile drafts and history','Community',true,ARRAY['hub','person','country','region','city']),
 ('profiles.edit','Edit permitted private person/hub community profile drafts','Community',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.community_profiles(
 academy_id uuid NOT NULL,id uuid NOT NULL,anchor_kind text NOT NULL CHECK(anchor_kind IN('person','hub')),person_id uuid,hub_id uuid,version integer NOT NULL DEFAULT 1 CHECK(version>0),definition jsonb NOT NULL,owner_snapshot jsonb NOT NULL,
 changed_by uuid NOT NULL,reason text NOT NULL CHECK(length(reason)<=2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),
 CHECK((anchor_kind='person' AND person_id IS NOT NULL AND hub_id IS NULL) OR(anchor_kind='hub' AND hub_id IS NOT NULL AND person_id IS NULL))
);
CREATE UNIQUE INDEX community_profile_person ON public.community_profiles(academy_id,person_id) WHERE person_id IS NOT NULL;
CREATE UNIQUE INDEX community_profile_hub ON public.community_profiles(academy_id,hub_id) WHERE hub_id IS NOT NULL;
CREATE TABLE public.community_profile_revisions(academy_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,profile_id,version),FOREIGN KEY(academy_id,profile_id) REFERENCES public.community_profiles(academy_id,id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['community_profiles','community_profile_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);END LOOP;END $$;
GRANT INSERT(academy_id,id,anchor_kind,person_id,hub_id,definition,owner_snapshot,changed_by,reason),UPDATE(version,definition,owner_snapshot,changed_by,reason) ON public.community_profiles TO kavosh_runtime;
GRANT INSERT(academy_id,profile_id,version,definition) ON public.community_profile_revisions TO kavosh_runtime;
CREATE FUNCTION public.community_profile_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE v jsonb;k text;url text;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& ARRAY['content','links','archived']) OR d-ARRAY['content','links','archived']<>'{}'::jsonb OR octet_length(d::text)>65536 OR jsonb_typeof(d->'archived') IS DISTINCT FROM 'boolean' OR jsonb_typeof(d->'content') IS DISTINCT FROM 'object' OR NOT(d->'content'?'en') OR(d->'content')-ARRAY['en','fr','zh-CN']<>'{}'::jsonb OR jsonb_typeof(d->'links') IS DISTINCT FROM 'object' OR NOT(d->'links' ?& ARRAY['github','linkedin']) OR(d->'links')-ARRAY['github','linkedin']<>'{}'::jsonb THEN RETURN false;END IF;
 FOR v IN SELECT value FROM jsonb_each(d->'content') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['displayName','headline','bio']) OR v-ARRAY['displayName','headline','bio']<>'{}'::jsonb OR jsonb_typeof(v->'displayName') IS DISTINCT FROM 'string' OR length(btrim(v->>'displayName')) NOT BETWEEN 1 AND 150 OR jsonb_typeof(v->'headline') IS DISTINCT FROM 'string' OR length(v->>'headline')>200 OR jsonb_typeof(v->'bio') IS DISTINCT FROM 'string' OR length(v->>'bio')>4000 THEN RETURN false;END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['github','linkedin'] LOOP
  v=d->'links'->k;IF v='null'::jsonb THEN CONTINUE;END IF;
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN false;END IF;url=v#>>'{}';IF length(url)>500 OR url~'[[:space:]]' THEN RETURN false;END IF;
  IF k='github' THEN IF url!~'^https://github[.]com/[A-Za-z0-9][A-Za-z0-9-]{0,38}/?$' THEN RETURN false;END IF;
  ELSE IF url!~'^https://www[.]linkedin[.]com/in/[A-Za-z0-9_%.-]{1,200}/?$' OR replace(regexp_replace(url,'%[A-Fa-f0-9]{2}','','g'),'%','') IS DISTINCT FROM regexp_replace(url,'%[A-Fa-f0-9]{2}','','g') THEN RETURN false;END IF;END IF;
 END LOOP;RETURN true;
END $$;
ALTER TABLE public.community_profiles ADD CHECK(public.community_profile_definition_valid(definition));
CREATE FUNCTION public.community_profile_owner(p_kind text,p_id uuid,p_lock boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r record;s jsonb;hub uuid;active boolean;BEGIN
 IF p_kind='person' THEN
  IF p_lock THEN SELECT id,hub_id,status,kind INTO r FROM public.people WHERE academy_id=tenant AND id=p_id FOR SHARE;ELSE SELECT id,hub_id,status,kind INTO r FROM public.people WHERE academy_id=tenant AND id=p_id;END IF;
  IF r.id IS NULL OR r.kind<>'human' THEN RETURN NULL;END IF;hub=r.hub_id;active=r.status='active';s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p_id,'hubId',hub)),'workContext',jsonb_build_object('personId',p_id,'hubId',hub));
 ELSIF p_kind='hub' THEN
  IF p_lock THEN SELECT id,h.active INTO r FROM public.hubs h WHERE academy_id=tenant AND id=p_id FOR SHARE;ELSE SELECT id,h.active INTO r FROM public.hubs h WHERE academy_id=tenant AND id=p_id;END IF;
  IF r.id IS NULL THEN RETURN NULL;END IF;hub=r.id;active=r.active;s=jsonb_build_object('all',false,'hubs',jsonb_build_array(hub));
 ELSE RETURN NULL;END IF;
 RETURN jsonb_build_object('kind',p_kind,'id',p_id,'hubId',hub,'active',active,'scope',s);
END $$;
CREATE FUNCTION public.guard_community_profile() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE o jsonb;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'COMMUNITY_PROFILE_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.anchor_kind,NEW.person_id,NEW.hub_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.anchor_kind,OLD.person_id,OLD.hub_id,OLD.created_at) THEN RAISE EXCEPTION 'COMMUNITY_PROFILE_IDENTITY_CHANGED' USING ERRCODE='23514';END IF;
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'COMMUNITY_PROFILE_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 o=public.community_profile_owner(NEW.anchor_kind,coalesce(NEW.person_id,NEW.hub_id),true);
 IF o IS NULL OR NEW.owner_snapshot IS DISTINCT FROM o THEN RAISE EXCEPTION 'COMMUNITY_PROFILE_OWNER_CHANGED' USING ERRCODE='23514';END IF;
 IF NEW.definition->'archived'='false'::jsonb AND o->'active'<>'true'::jsonb THEN RAISE EXCEPTION 'COMMUNITY_PROFILE_OWNER_INACTIVE' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND status='active') THEN RAISE EXCEPTION 'COMMUNITY_PROFILE_ACTOR_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.changed_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER community_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON public.community_profiles FOR EACH ROW EXECUTE FUNCTION public.guard_community_profile();
CREATE FUNCTION public.guard_community_profile_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM public.community_profiles p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.profile_id AND p.version=NEW.version AND to_jsonb(p)=NEW.definition) THEN RAISE EXCEPTION 'COMMUNITY_PROFILE_EXACT_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER community_profile_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.community_profile_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_community_profile_revision();
CREATE FUNCTION public.require_community_profile_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE o jsonb;BEGIN
 o=public.community_profile_owner(NEW.anchor_kind,coalesce(NEW.person_id,NEW.hub_id));
 IF NOT EXISTS(SELECT 1 FROM public.community_profile_revisions r WHERE r.academy_id=NEW.academy_id AND r.profile_id=NEW.id AND r.version=NEW.version AND r.definition=to_jsonb(NEW)) OR NOT EXISTS(
  SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.id AND a.actor_id=NEW.changed_by AND a.created_at=transaction_timestamp() AND a.action=CASE WHEN NEW.version=1 THEN 'community-profile.created' ELSE 'community-profile.updated' END
  AND a.hub_id IS NOT DISTINCT FROM(o->>'hubId')::uuid AND a.changes->'version'=to_jsonb(NEW.version) AND a.changes->>'anchorKind'=NEW.anchor_kind AND a.changes->'privateDraftOnly'='true'::jsonb AND a.changes->>'revisionSha256'=encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex')) THEN RAISE EXCEPTION 'COMMUNITY_PROFILE_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER community_profile_receipt_required AFTER INSERT OR UPDATE ON public.community_profiles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_community_profile_receipt();
REVOKE ALL ON FUNCTION public.community_profile_definition_valid(jsonb),public.community_profile_owner(text,uuid,boolean),public.guard_community_profile(),public.guard_community_profile_revision(),public.require_community_profile_receipt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.community_profile_definition_valid(jsonb),public.community_profile_owner(text,uuid,boolean) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 148 $$;

-- Sparse independent moderation state cannot be reset by editing profile content.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('profile-moderation.view','View scoped private community profile restrictions and review history','Community',true,ARRAY['hub','person','country','region','city']),
 ('profile-moderation.edit','Propose scoped community profile restrictions or reviewed restoration','Community',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.profile_moderation_changes(
 academy_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),before_restricted boolean NOT NULL,restricted boolean NOT NULL,source_basis jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,profile_id,version),UNIQUE(academy_id,approval_id),CHECK(before_restricted<>restricted),FOREIGN KEY(academy_id,profile_id) REFERENCES public.community_profiles(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.profile_moderation_heads(
 academy_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),PRIMARY KEY(academy_id,profile_id),FOREIGN KEY(academy_id,profile_id,version) REFERENCES public.profile_moderation_changes(academy_id,profile_id,version)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['profile_moderation_changes','profile_moderation_heads'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,profile_id,version,before_restricted,restricted,source_basis,changed_by,approval_id,reason) ON public.profile_moderation_changes TO kavosh_runtime;
GRANT INSERT(academy_id,profile_id,version),UPDATE(version) ON public.profile_moderation_heads TO kavosh_runtime;
CREATE FUNCTION public.profile_moderation_state(p_profile uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',coalesce(h.version,0),'restricted',coalesce(c.restricted,false)) FROM public.community_profiles p LEFT JOIN public.profile_moderation_heads h ON h.academy_id=p.academy_id AND h.profile_id=p.id LEFT JOIN public.profile_moderation_changes c ON c.academy_id=h.academy_id AND c.profile_id=h.profile_id AND c.version=h.version
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_profile
$$;
CREATE FUNCTION public.profile_moderation_basis(p_profile uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('profileId',p.id,'profileVersion',p.version,'owner',public.community_profile_owner(p.anchor_kind,coalesce(p.person_id,p.hub_id,p.academy_id)))||public.profile_moderation_state(p.id) FROM public.community_profiles p WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_profile
$$;
CREATE FUNCTION public.profile_moderation_change_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;b jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PROFILE_MODERATION_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));PERFORM id FROM public.community_profiles WHERE academy_id=NEW.academy_id AND id=NEW.profile_id FOR SHARE;
 b=public.profile_moderation_basis(NEW.profile_id);SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR b->'owner'='null'::jsonb OR NEW.version<>(b->>'version')::integer+1 OR NEW.before_restricted IS DISTINCT FROM(b->>'restricted')::boolean OR NEW.source_basis IS DISTINCT FROM b OR a.id IS NULL OR a.status<>'pending' OR a.action IS DISTINCT FROM 'community-profile.moderate' OR a.target_id IS DISTINCT FROM NEW.profile_id OR a.target_version<>NEW.version-1 OR a.privacy_capability IS DISTINCT FROM 'profile-moderation.view' OR a.scope IS DISTINCT FROM b#>'{owner,scope}' OR a.review_context IS DISTINCT FROM b
 OR a.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'expectedProfileVersion',(b->>'profileVersion')::integer,'restricted',NEW.restricted,'reason',NEW.reason) OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'PROFILE_MODERATION_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER profile_moderation_change_guard BEFORE INSERT OR UPDATE OR DELETE ON public.profile_moderation_changes FOR EACH ROW EXECUTE FUNCTION public.profile_moderation_change_guard();
CREATE FUNCTION public.profile_moderation_head_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PROFILE_MODERATION_HEAD_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND(NEW.academy_id IS DISTINCT FROM OLD.academy_id OR NEW.profile_id IS DISTINCT FROM OLD.profile_id OR NEW.version<>OLD.version+1) OR NOT EXISTS(SELECT 1 FROM public.profile_moderation_changes WHERE academy_id=NEW.academy_id AND profile_id=NEW.profile_id AND version=NEW.version AND created_at>=transaction_timestamp()) THEN RAISE EXCEPTION 'PROFILE_MODERATION_HEAD_EXACT_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER profile_moderation_head_guard BEFORE INSERT OR UPDATE OR DELETE ON public.profile_moderation_heads FOR EACH ROW EXECUTE FUNCTION public.profile_moderation_head_guard();
CREATE CONSTRAINT TRIGGER profile_moderation_reviewed AFTER INSERT ON public.profile_moderation_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.profile_moderation_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;BEGIN
 b=public.profile_moderation_basis(NEW.profile_id);
 IF b->>'version' IS DISTINCT FROM NEW.version::text OR(b->>'restricted')::boolean IS DISTINCT FROM NEW.restricted OR b-ARRAY['version','restricted'] IS DISTINCT FROM NEW.source_basis-ARRAY['version','restricted']
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.profile_id AND actor_id=NEW.changed_by AND action='community-profile.moderate' AND created_at=transaction_timestamp() AND hub_id IS NOT DISTINCT FROM(NEW.source_basis#>>'{owner,hubId}')::uuid AND changes->>'approvalId'=NEW.approval_id::text AND changes->>'version'=NEW.version::text AND changes->'restricted'=to_jsonb(NEW.restricted) AND changes->'severity'='"critical"'::jsonb AND changes->'privateContentRedacted'='true'::jsonb)
 THEN RAISE EXCEPTION 'PROFILE_MODERATION_EFFECT_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER profile_moderation_complete AFTER INSERT ON public.profile_moderation_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.profile_moderation_complete();
CREATE FUNCTION public.profile_moderation_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='community-profile.moderate' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.profile_moderation_changes WHERE academy_id=NEW.academy_id AND profile_id=NEW.target_id AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PROFILE_MODERATION_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER profile_moderation_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.profile_moderation_effect_required();
CREATE FUNCTION public.community_profile_self_restriction() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.anchor_kind='person' AND NEW.person_id=NEW.changed_by AND public.profile_moderation_state(NEW.id)->'restricted'='true'::jsonb THEN RAISE EXCEPTION 'PROFILE_SELF_EDIT_RESTRICTED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER community_profile_self_restriction BEFORE UPDATE ON public.community_profiles FOR EACH ROW EXECUTE FUNCTION public.community_profile_self_restriction();
DO $$ DECLARE b text;n text:='p.action IN(''access.replace'',''supervisor.set'',''person.status'',''bot.create'',''bot-credential.prepare'',''bot.rename'')';BEGIN
 b=pg_get_functiondef('public.capture_automation_event()'::regprocedure);IF position(n IN b)=0 THEN RAISE EXCEPTION 'PROFILE_MODERATION_ALERT_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,'p.action IN(''access.replace'',''supervisor.set'',''person.status'',''bot.create'',''bot-credential.prepare'',''bot.rename'',''community-profile.moderate'')');
END $$;
REVOKE ALL ON FUNCTION public.profile_moderation_state(uuid),public.profile_moderation_basis(uuid),public.profile_moderation_change_guard(),public.profile_moderation_head_guard(),public.profile_moderation_complete(),public.profile_moderation_effect_required(),public.community_profile_self_restriction() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_moderation_state(uuid),public.profile_moderation_basis(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 192 $$;

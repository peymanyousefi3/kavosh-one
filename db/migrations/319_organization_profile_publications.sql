INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES('profiles.publish','Review public school and hub profile publication','Community',true,ARRAY['academy','hub','country','region','city']);
CREATE TABLE public.profile_publication_changes(
 academy_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),profile_version integer NOT NULL CHECK(profile_version>0),audience text NOT NULL CHECK(audience IN('public','unpublished')),
 source_basis jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,profile_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,profile_id,profile_version) REFERENCES public.community_profile_revisions(academy_id,profile_id,version),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.profile_publication_heads(
 academy_id uuid NOT NULL,profile_id uuid NOT NULL,public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,version integer NOT NULL CHECK(version>0),PRIMARY KEY(academy_id,profile_id),FOREIGN KEY(academy_id,profile_id,version) REFERENCES public.profile_publication_changes(academy_id,profile_id,version)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['profile_publication_changes','profile_publication_heads'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,profile_id,version,profile_version,audience,source_basis,changed_by,approval_id,reason) ON public.profile_publication_changes TO kavosh_runtime;
GRANT INSERT(academy_id,profile_id,version),UPDATE(version) ON public.profile_publication_heads TO kavosh_runtime;
CREATE FUNCTION public.profile_publication_basis(p_profile uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('profileId',p.id,'profileVersion',p.version,'definitionHash',encode(sha256(convert_to(p.definition::text,'UTF8')),'hex'),'owner',public.community_profile_owner(p.anchor_kind,coalesce(p.person_id,p.hub_id,p.academy_id)),
 'archived',p.definition->'archived','moderation',public.profile_moderation_state(p.id),'version',coalesce(h.version,0),'audience',coalesce(c.audience,'unpublished'))
 FROM public.community_profiles p LEFT JOIN public.profile_publication_heads h ON h.academy_id=p.academy_id AND h.profile_id=p.id LEFT JOIN public.profile_publication_changes c ON c.academy_id=h.academy_id AND c.profile_id=h.profile_id AND c.version=h.version
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_profile
$$;
CREATE FUNCTION public.guard_profile_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;a record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PROFILE_PUBLICATION_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));PERFORM id FROM public.community_profiles WHERE academy_id=NEW.academy_id AND id=NEW.profile_id FOR SHARE;
 b=public.profile_publication_basis(NEW.profile_id);SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR b->'owner'='null'::jsonb OR b#>>'{owner,kind}' NOT IN('academy','hub') THEN RAISE EXCEPTION 'ORGANIZATION_PROFILE_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.audience='public' AND(b#>'{owner,active}'<>'true'::jsonb OR b->'archived'<>'false'::jsonb OR b#>'{moderation,restricted}'<>'false'::jsonb) THEN RAISE EXCEPTION 'PROFILE_PUBLICATION_SOURCE_UNAVAILABLE' USING ERRCODE='23514';END IF;
 IF NEW.version<>(b->>'version')::integer+1 OR NEW.profile_version<>(b->>'profileVersion')::integer OR NEW.source_basis IS DISTINCT FROM b OR a.id IS NULL OR a.status<>'pending' OR a.action IS DISTINCT FROM 'community-profile.publish' OR a.target_id IS DISTINCT FROM NEW.profile_id OR a.target_version<>NEW.version-1
 OR a.privacy_capability IS DISTINCT FROM 'profiles.view' OR a.scope IS DISTINCT FROM b#>'{owner,scope}' OR a.review_context IS DISTINCT FROM b
 OR a.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'expectedProfileVersion',NEW.profile_version,'audience',NEW.audience,'reason',NEW.reason) OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'PROFILE_PUBLICATION_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER profile_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON public.profile_publication_changes FOR EACH ROW EXECUTE FUNCTION public.guard_profile_publication();
CREATE FUNCTION public.guard_profile_publication_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND(NEW.academy_id IS DISTINCT FROM OLD.academy_id OR NEW.profile_id IS DISTINCT FROM OLD.profile_id OR NEW.public_id IS DISTINCT FROM OLD.public_id OR NEW.version<>OLD.version+1))
 OR NOT EXISTS(SELECT 1 FROM public.profile_publication_changes WHERE academy_id=NEW.academy_id AND profile_id=NEW.profile_id AND version=NEW.version AND created_at>=transaction_timestamp()) THEN RAISE EXCEPTION 'PROFILE_PUBLICATION_HEAD_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER profile_publication_head_guard BEFORE INSERT OR UPDATE OR DELETE ON public.profile_publication_heads FOR EACH ROW EXECUTE FUNCTION public.guard_profile_publication_head();
CREATE CONSTRAINT TRIGGER profile_publication_reviewed AFTER INSERT ON public.profile_publication_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.complete_profile_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;BEGIN
 b=public.profile_publication_basis(NEW.profile_id);
 IF b->>'version' IS DISTINCT FROM NEW.version::text OR b->>'audience' IS DISTINCT FROM NEW.audience OR b-ARRAY['version','audience'] IS DISTINCT FROM NEW.source_basis-ARRAY['version','audience']
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.profile_id AND actor_id=NEW.changed_by AND action='community-profile.publish' AND created_at=transaction_timestamp() AND hub_id IS NOT DISTINCT FROM(NEW.source_basis#>>'{owner,hubId}')::uuid AND changes->>'approvalId'=NEW.approval_id::text AND changes->>'version'=NEW.version::text AND changes->>'audience'=NEW.audience AND changes->'severity'='"critical"'::jsonb AND changes->'privateContentRedacted'='true'::jsonb)
 THEN RAISE EXCEPTION 'PROFILE_PUBLICATION_EFFECT_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER profile_publication_complete AFTER INSERT ON public.profile_publication_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_profile_publication();
CREATE FUNCTION public.profile_publication_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='community-profile.publish' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.profile_publication_changes WHERE academy_id=NEW.academy_id AND profile_id=NEW.target_id AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PROFILE_PUBLICATION_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER profile_publication_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.profile_publication_effect_required();
REVOKE ALL ON FUNCTION public.profile_publication_basis(uuid),public.guard_profile_publication(),public.guard_profile_publication_head(),public.complete_profile_publication(),public.profile_publication_effect_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_publication_basis(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 319 $$;

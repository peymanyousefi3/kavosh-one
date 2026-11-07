-- Existing awards remain private: no implicit family/public publication.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('achievements.publish','Request reviewed private family release or withdrawal of an exact achievement','Community',true,ARRAY['hub','class','person','country','region','city']),
 ('received-achievements.view','View released own or approved-family student achievements','Community',true,ARRAY['hub','class','person','country','region','city']);
CREATE TABLE public.achievement_family_publications(
 academy_id uuid NOT NULL,id uuid NOT NULL,award_id uuid NOT NULL,award_version integer NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),state text NOT NULL CHECK(state IN('published','withdrawn')),
 source jsonb NOT NULL CHECK(jsonb_typeof(source)='object'),changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,award_id),FOREIGN KEY(academy_id,award_id,award_version) REFERENCES public.achievement_award_revisions(academy_id,award_id,version),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.achievement_family_publication_revisions(academy_id uuid NOT NULL,publication_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,publication_id,version),FOREIGN KEY(academy_id,publication_id) REFERENCES public.achievement_family_publications(academy_id,id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['achievement_family_publications','achievement_family_publication_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);END LOOP;END $$;
GRANT INSERT(academy_id,id,award_id,award_version,state,source,changed_by,approval_id,reason),UPDATE(award_version,version,state,source,changed_by,approval_id,reason) ON public.achievement_family_publications TO kavosh_runtime;
GRANT INSERT(academy_id,publication_id,version,definition) ON public.achievement_family_publication_revisions TO kavosh_runtime;
CREATE FUNCTION public.achievement_family_source(award uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('awardId',a.id,'awardVersion',a.version,'studentId',a.student_id,'hubId',a.hub_id,'classId',a.class_id,'earnedOn',a.earned_on,'reference',a.reference,'caption',a.caption,'status',a.status,'typeDefinition',a.context#>'{type,definition}')
 FROM public.achievement_awards a JOIN public.approval_requests p ON p.academy_id=a.academy_id AND p.id=a.approval_id AND p.status='applied' AND p.reviewer_id=a.changed_by AND p.target_id=a.id AND p.target_version=a.version-1 AND p.action IN('achievement.issue','achievement.change')
 JOIN public.achievement_award_revisions r ON r.academy_id=a.academy_id AND r.award_id=a.id AND r.version=a.version AND r.definition=to_jsonb(a)
 WHERE a.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND a.id=award
$$;
CREATE FUNCTION public.guard_achievement_family_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;a record;s jsonb;prior jsonb;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACHIEVEMENT_FAMILY_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.award_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.award_id,OLD.created_at) THEN RAISE EXCEPTION 'ACHIEVEMENT_FAMILY_IDENTITY_CHANGED' USING ERRCODE='23514';END IF;prior=to_jsonb(OLD);
 ELSIF NEW.version<>1 OR NEW.state<>'published' THEN RAISE EXCEPTION 'ACHIEVEMENT_FAMILY_INITIAL_PUBLICATION_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM public.achievement_awards WHERE academy_id=NEW.academy_id AND id=NEW.award_id FOR SHARE;s=public.achievement_family_source(NEW.award_id);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s IS NULL OR a.id IS NULL OR NEW.award_version<>a.version OR(NEW.state='published' AND a.status<>'awarded') OR NEW.source IS DISTINCT FROM s OR p.id IS NULL OR p.status<>'pending' OR p.action<>'achievement-family.change' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>coalesce(OLD.version,0)
 OR p.privacy_capability IS DISTINCT FROM 'achievements.view' OR p.scope IS DISTINCT FROM public.achievement_award_scope(a.student_id,a.hub_id,a.class_id) OR p.review_context IS DISTINCT FROM jsonb_build_object('before',prior,'source',s)
 OR(p.payload->>'awardId')::uuid IS DISTINCT FROM NEW.award_id OR(p.payload->>'awardVersion')::integer IS DISTINCT FROM NEW.award_version OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0) OR p.payload->>'state' IS DISTINCT FROM NEW.state OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'ACHIEVEMENT_FAMILY_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF(NEW.changed_by=a.student_id OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=a.student_id AND guardian_id=NEW.changed_by)) AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'ACHIEVEMENT_FAMILY_BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.changed_at=clock_timestamp();RETURN NEW;END $$;
CREATE TRIGGER achievement_family_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON public.achievement_family_publications FOR EACH ROW EXECUTE FUNCTION public.guard_achievement_family_publication();
CREATE FUNCTION public.guard_achievement_family_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM public.achievement_family_publications p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.publication_id AND p.version=NEW.version AND to_jsonb(p)=NEW.definition) THEN RAISE EXCEPTION 'ACHIEVEMENT_FAMILY_EXACT_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER achievement_family_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.achievement_family_publication_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_achievement_family_revision();
CREATE FUNCTION public.require_achievement_family_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.achievement_family_publication_revisions r WHERE r.academy_id=NEW.academy_id AND r.publication_id=NEW.id AND r.version=NEW.version AND r.definition=to_jsonb(NEW)) OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'ACHIEVEMENT_FAMILY_APPLIED_REVIEW_AND_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.state='published' AND NEW.source IS DISTINCT FROM public.achievement_family_source(NEW.award_id) THEN RAISE EXCEPTION 'ACHIEVEMENT_FAMILY_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER achievement_family_revision_required AFTER INSERT OR UPDATE ON public.achievement_family_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_achievement_family_revision();
CREATE FUNCTION public.achievement_family_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;BEGIN
 SELECT student_id,hub_id,class_id INTO a FROM public.achievement_awards WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'awardId')::uuid;
 IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','achievements.view','scope',public.achievement_award_scope(a.student_id,a.hub_id,a.class_id)));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END $$;
CREATE TRIGGER zz_achievement_family_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='achievement-family.change') EXECUTE FUNCTION public.achievement_family_privacy();
REVOKE ALL ON FUNCTION public.achievement_family_source(uuid),public.guard_achievement_family_publication(),public.guard_achievement_family_revision(),public.require_achievement_family_revision(),public.achievement_family_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.achievement_family_source(uuid) TO kavosh_runtime;
-- Preserve the existing function OID, owner and grants used by the payrun wrapper.
-- A selected person may have records in hubs other than their current primary hub.
CREATE OR REPLACE FUNCTION public.scope_contains_before_payrun_groups(p_source jsonb,p_target jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE w jsonb:=p_target->'workContext';c jsonb:=p_target->'recordContext';BEGIN
 IF p_source ? 'workContext' AND p_source->'workContext' IS DISTINCT FROM w THEN RETURN false;END IF;
 IF w IS NOT NULL THEN
  IF p_source ? 'recordContext' OR p_target ?| ARRAY['recordContext','recordHubIds'] OR p_target->'all' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(p_target->'people') IS DISTINCT FROM 'array' OR jsonb_array_length(p_target->'people')<>1 OR p_target#>>'{people,0,id}' IS DISTINCT FROM w->>'personId' OR p_target#>>'{people,0,hubId}' IS DISTINCT FROM w->>'hubId'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['hubs','classes','areas','excludedHubs','excludedAreas','excludedPeople','excludedClasses']) k WHERE jsonb_array_length(coalesce(p_target->k,'[]'::jsonb))>0) THEN RETURN false;END IF;
  RETURN public.work_scope_allows(p_source,(w->>'hubId')::uuid,(w->>'personId')::uuid);
 END IF;
 IF p_source ? 'recordHubIds' THEN
  IF c IS NOT NULL AND p_target->'all'='false'::jsonb AND jsonb_typeof(p_target->'hubs')='array'
   AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['areas','excludedAreas','excludedHubs','excludedClasses','excludedPeople']) k WHERE jsonb_array_length(coalesce(p_target->k,'[]'::jsonb))>0)
   AND jsonb_array_length(p_target->'hubs')<=1 AND jsonb_array_length(coalesce(p_target->'classes','[]'::jsonb))<=1 AND jsonb_array_length(coalesce(p_target->'people','[]'::jsonb))<=1
   AND jsonb_array_length(p_target->'hubs')+jsonb_array_length(coalesce(p_target->'classes','[]'::jsonb))+jsonb_array_length(coalesce(p_target->'people','[]'::jsonb))>0
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_target->'hubs') x WHERE x IS DISTINCT FROM c->>'hubId')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_target->'classes','[]'::jsonb)) x WHERE x->>'id' IS DISTINCT FROM c->>'classId' OR x->>'hubId' IS DISTINCT FROM c->>'hubId')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_target->'people','[]'::jsonb)) x WHERE x->>'id' IS DISTINCT FROM c->>'studentId' OR x->>'hubId' IS DISTINCT FROM c->>'hubId') THEN
    RETURN coalesce(p_source->'recordHubIds' ? (c->>'hubId'),false) AND public.scope_contains_before_work_records(p_source,p_target);
  END IF;
  IF p_target->'all'='true'::jsonb OR jsonb_array_length(coalesce(p_target->'areas','[]'::jsonb))>0 OR jsonb_array_length(coalesce(p_target->'people','[]'::jsonb))>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p_target->'hubs','[]'::jsonb)) h WHERE NOT(p_source->'recordHubIds' ? h)) THEN RETURN false;END IF;
 END IF;
 RETURN public.scope_contains_before_work_records(p_source,p_target);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 145 $$;

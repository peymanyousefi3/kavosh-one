-- An academic showcase is a separate exact human-reviewed release,not an
-- automatic consequence of issuing a private award or signing profile consent.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('academic-profiles.view','View private academic showcase review history','Community',true,ARRAY['academy','hub','person','country','region','city']),
 ('academic-profiles.publish','Review exact academic achievements for a shared student profile','Community',true,ARRAY['academy','hub','person','country','region','city']);
CREATE TABLE public.academic_profile_releases(
 academy_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('published','withdrawn')),
 awards jsonb NOT NULL,source jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,profile_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,profile_id) REFERENCES public.community_profiles(academy_id,id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.academic_profile_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.academic_profile_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.academic_profile_releases USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.academic_profile_releases TO kavosh_runtime,kavosh_signature_evidence_policy;
GRANT INSERT(academy_id,profile_id,version,state,awards,source,changed_by,approval_id,reason) ON public.academic_profile_releases TO kavosh_runtime;
CREATE FUNCTION public.academic_award_selection_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE x jsonb;BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v)>100 OR octet_length(v::text)>16384 THEN RETURN false;END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(v) LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR NOT(x ?& ARRAY['awardId','awardVersion']) OR x-ARRAY['awardId','awardVersion']<>'{}'::jsonb
  OR jsonb_typeof(x->'awardId') IS DISTINCT FROM 'string' OR(x->>'awardId')::uuid::text IS DISTINCT FROM x->>'awardId'
  OR jsonb_typeof(x->'awardVersion') IS DISTINCT FROM 'number' OR x->>'awardVersion'!~'^[1-9][0-9]*$' OR(x->>'awardVersion')::numeric>2147483647 THEN RETURN false;END IF;
 END LOOP;
 RETURN(SELECT count(*)=count(DISTINCT value->>'awardId') FROM jsonb_array_elements(v));
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.academic_profile_awards_source(p_profile uuid,p_awards jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;p record;items jsonb;matched integer;BEGIN
 IF tenant IS NULL OR NOT public.academic_award_selection_valid(p_awards) THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 SELECT c.id,c.person_id,c.version,h.public_id,h.version AS publication_version INTO p FROM public.community_profiles c JOIN public.student_profiles s ON s.academy_id=c.academy_id AND s.person_id=c.person_id LEFT JOIN public.profile_publication_heads h ON h.academy_id=c.academy_id AND h.profile_id=c.id WHERE c.academy_id=tenant AND c.id=p_profile AND c.anchor_kind='person';
 IF p.id IS NULL THEN RETURN NULL;END IF;
 -- One set-based original-award proof,not a query per selected achievement.
 SELECT coalesce(jsonb_agg(jsonb_build_object('awardId',w.id,'awardVersion',w.version,'hubId',w.hub_id,'classId',w.class_id,'earnedOn',w.earned_on,'caption',w.caption,'typeDefinition',w.context#>'{type,definition}') ORDER BY x.n),'[]'::jsonb),count(*) INTO items,matched
 FROM jsonb_array_elements(p_awards) WITH ORDINALITY x(value,n) JOIN public.achievement_awards w ON w.academy_id=tenant AND w.id=(x.value->>'awardId')::uuid AND w.version=(x.value->>'awardVersion')::integer AND w.student_id=p.person_id AND w.status='awarded'
 JOIN public.achievement_award_revisions r ON r.academy_id=w.academy_id AND r.award_id=w.id AND r.version=w.version AND r.definition=to_jsonb(w)
  JOIN public.approval_requests q ON q.academy_id=w.academy_id AND q.id=w.approval_id AND q.status='applied' AND q.action IN('achievement.issue','achievement.change') AND q.target_id=w.id AND q.target_version=w.version-1 AND q.reviewer_id=w.changed_by
 ;
 IF matched<>jsonb_array_length(p_awards) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('profileId',p.id,'studentId',p.person_id,'profileVersion',p.version,'publicationVersion',p.publication_version,'publicId',p.public_id,'awards',items);
END $$;
CREATE FUNCTION public.academic_profile_source(p_profile uuid,p_awards jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE b jsonb;BEGIN
 b=public.academic_profile_awards_source(p_profile,p_awards);IF b IS NULL THEN RETURN NULL;END IF;
 RETURN b||jsonb_build_object('profileEligible',public.published_profile_projection((b->>'publicId')::uuid,'members') IS NOT NULL);
END $$;
CREATE FUNCTION public.guard_academic_profile_release() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE q record;b jsonb;prior jsonb;v integer;owner jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ACADEMIC_RELEASE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 IF NOT public.academic_award_selection_valid(NEW.awards) OR(NEW.state='withdrawn' AND NEW.awards<>'[]'::jsonb) THEN RAISE EXCEPTION 'ACADEMIC_RELEASE_INPUT_INVALID' USING ERRCODE='23514';END IF;
 SELECT to_jsonb(r),r.version INTO prior,v FROM public.academic_profile_releases r WHERE r.academy_id=NEW.academy_id AND r.profile_id=NEW.profile_id ORDER BY r.version DESC LIMIT 1;
 b=public.academic_profile_source(NEW.profile_id,NEW.awards);owner=public.community_profile_owner('person',(b->>'studentId')::uuid);
 SELECT * INTO q FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR NEW.source IS DISTINCT FROM b OR NEW.version<>coalesce(v,0)+1 OR(NEW.state='published' AND b->'profileEligible' IS DISTINCT FROM 'true'::jsonb)
 OR q.id IS NULL OR q.status<>'pending' OR q.action<>'academic-profile.publish' OR q.target_id IS DISTINCT FROM NEW.profile_id OR q.target_version<>NEW.version-1 OR q.privacy_capability IS DISTINCT FROM 'academic-profiles.view' OR q.scope IS DISTINCT FROM owner->'scope'
 OR q.review_context IS DISTINCT FROM jsonb_build_object('before',prior,'source',b) OR q.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'state',NEW.state,'awards',NEW.awards,'reason',NEW.reason) OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'ACADEMIC_RELEASE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF(NEW.changed_by=(b->>'studentId')::uuid OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=(b->>'studentId')::uuid AND guardian_id=NEW.changed_by)) AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'ACADEMIC_RELEASE_BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER academic_profile_release_guard BEFORE INSERT OR UPDATE OR DELETE ON public.academic_profile_releases FOR EACH ROW EXECUTE FUNCTION public.guard_academic_profile_release();
CREATE FUNCTION public.academic_profile_release_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests q WHERE q.academy_id=NEW.academy_id AND q.id=NEW.approval_id AND q.status='applied' AND q.reviewer_id=NEW.changed_by)
 OR NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events e ON e.academy_id=a.academy_id AND e.entity_id=a.entity_id AND e.request_id=a.request_id AND e.event_type=a.action AND e.created_at=transaction_timestamp()
 WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.profile_id AND a.actor_id=NEW.changed_by AND a.actor_kind='human' AND a.action='academic-profile.publish' AND a.created_at=transaction_timestamp() AND a.changes=jsonb_build_object('version',NEW.version,'state',NEW.state,'awardCount',jsonb_array_length(NEW.awards),'approvalId',NEW.approval_id,'severity','critical','privateContentRedacted',true)) THEN RAISE EXCEPTION 'ACADEMIC_RELEASE_AUDIT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER academic_profile_release_complete AFTER INSERT ON public.academic_profile_releases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.academic_profile_release_complete();
CREATE FUNCTION public.academic_profile_effect_required() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE q record;event uuid;BEGIN
 IF NEW.action<>'academic-profile.publish' THEN RETURN NULL;END IF;SELECT * INTO q FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF q.status='applied' AND NOT EXISTS(SELECT 1 FROM public.academic_profile_releases r WHERE r.academy_id=q.academy_id AND r.profile_id=q.target_id AND r.version=q.target_version+1 AND r.approval_id=q.id AND r.changed_by=q.reviewer_id) THEN RAISE EXCEPTION 'ACADEMIC_RELEASE_EFFECT_REQUIRED' USING ERRCODE='55000';END IF;
 SELECT e.event_id INTO event FROM public.automation_event_sources e JOIN public.audit_events a ON a.academy_id=e.academy_id AND a.id=e.audit_id WHERE e.academy_id=q.academy_id AND e.approval_id=q.id AND e.source_kind='approval' AND e.source_version=q.version AND e.event_type='approval.'||CASE WHEN q.status='pending' THEN 'requested' ELSE q.status END AND e.projection->>'severity'='critical' AND e.origin_transaction=pg_current_xact_id() AND a.action=e.event_type AND a.entity_id=q.id AND a.created_at=transaction_timestamp();
 IF event IS NULL OR EXISTS(SELECT 1 FROM(SELECT c.person_id FROM public.supervisor_chain(q.requester_id) c UNION SELECT q.requester_id WHERE q.status<>'pending' UNION SELECT master_person_id FROM public.academies WHERE id=q.academy_id) audience JOIN public.people p ON p.academy_id=q.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL WHERE NOT EXISTS(SELECT 1 FROM public.portal_notifications n WHERE n.academy_id=q.academy_id AND n.event_id=event AND n.person_id=p.id AND n.origin='mandatory')) THEN RAISE EXCEPTION 'ACADEMIC_RELEASE_NOTICE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER academic_profile_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.academic_profile_effect_required();
CREATE FUNCTION public.academic_profile_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;x jsonb;a record;cap text;BEGIN
 SELECT person_id INTO p FROM public.community_profiles WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND anchor_kind='person';
 IF p.person_id IS NULL OR NOT public.academic_award_selection_valid(NEW.payload->'awards') THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 FOREACH cap IN ARRAY ARRAY['profiles.view','student-profiles.view','academic-profiles.view'] LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',public.community_profile_owner('person',p.person_id)->'scope'));END LOOP;
 FOR x IN SELECT * FROM jsonb_array_elements((NEW.payload->'awards')||coalesce((SELECT r.awards FROM public.academic_profile_releases r WHERE r.academy_id=NEW.academy_id AND r.profile_id=NEW.target_id ORDER BY r.version DESC LIMIT 1),'[]'::jsonb)) LOOP
  SELECT student_id,hub_id,class_id INTO a FROM public.achievement_awards WHERE academy_id=NEW.academy_id AND id=(x->>'awardId')::uuid AND student_id=p.person_id;
  IF a.student_id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','achievements.view','scope',public.achievement_award_scope(a.student_id,a.hub_id,a.class_id)));END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER zz_academic_profile_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='academic-profile.publish') EXECUTE FUNCTION public.academic_profile_privacy();
CREATE FUNCTION public.published_academic_profile(p_public uuid,p_audience text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;profile jsonb;r record;b jsonb;items jsonb;BEGIN
 profile=public.published_profile_projection(p_public,p_audience);IF profile IS NULL OR profile->>'kind'<>'person' THEN RETURN NULL;END IF;
 SELECT x.* INTO r FROM public.academic_profile_releases x JOIN public.profile_publication_heads h ON h.academy_id=x.academy_id AND h.profile_id=x.profile_id WHERE x.academy_id=tenant AND h.public_id=p_public ORDER BY x.version DESC LIMIT 1;
 IF r.version IS NULL OR r.state<>'published' THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests q WHERE q.academy_id=tenant AND q.id=r.approval_id AND q.status='applied' AND q.action='academic-profile.publish' AND q.target_id=r.profile_id AND q.target_version=r.version-1 AND q.reviewer_id=r.changed_by) THEN RETURN NULL;END IF;
 -- The exact profile/consent gate already ran above. Do not repeat every
 -- signing proof for each ranking row;still recheck all current award facts.
 b=public.academic_profile_awards_source(r.profile_id,r.awards);IF b IS NULL OR b IS DISTINCT FROM r.source-'profileEligible' OR r.source->'profileEligible' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('number',n,'earnedOn',x->'earnedOn','caption',x->'caption','kind',x#>'{typeDefinition,kind}','icon',x#>'{typeDefinition,icon}','labels',x#>'{typeDefinition,labels}','points',x#>'{typeDefinition,points}') ORDER BY n),'[]'::jsonb) INTO items FROM jsonb_array_elements(b->'awards') WITH ORDINALITY t(x,n);
 RETURN profile||jsonb_build_object('releaseVersion',r.version,'achievements',items,'schoolIssued',true,'academyContentPinned',true,'externalAccreditationVerified',false,'certificatePdfGenerated',false);
END $$;
-- Anonymous detail only,not an anonymous student directory or leaderboard.
-- Reuse the existing persistent keyed budget and current-public profile gate.
CREATE FUNCTION public.read_published_academic_profile(p_public uuid,p_budget text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;school uuid;previous_tenant text;data jsonb;BEGIN
 result=public.read_published_organization_profile(p_public,p_budget);IF result->'limited'='true'::jsonb OR result->'data' IS NULL OR result->'data'='null'::jsonb THEN RETURN result-'data'||jsonb_build_object('data',NULL);END IF;
 SELECT academy_id INTO school FROM public.profile_publication_heads WHERE public_id=p_public;IF school IS NULL THEN RETURN jsonb_build_object('limited',false,'data',NULL);END IF;
 previous_tenant=current_setting('app.academy_id',true);PERFORM set_config('app.academy_id',school::text,true);data=public.published_academic_profile(p_public,'public');PERFORM set_config('app.academy_id',coalesce(previous_tenant,''),true);
 RETURN jsonb_build_object('limited',false,'data',data);
END $$;
DO $$ DECLARE d text;u text;BEGIN
 d=pg_get_functiondef('public.capture_automation_event()'::regprocedure);u=replace(d,$q$p.action IN('access.replace','supervisor.set'$q$,$r$p.action IN('access.replace','supervisor.set','academic-profile.publish'$r$);IF u=d THEN RAISE EXCEPTION 'ACADEMIC_RELEASE_ALERT_SOURCE_CHANGED';END IF;EXECUTE u;
END $$;
REVOKE ALL ON FUNCTION public.academic_award_selection_valid(jsonb),public.academic_profile_awards_source(uuid,jsonb),public.academic_profile_source(uuid,jsonb),public.guard_academic_profile_release(),public.academic_profile_release_complete(),public.academic_profile_effect_required(),public.academic_profile_privacy(),public.published_academic_profile(uuid,text),public.read_published_academic_profile(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.academic_award_selection_valid(jsonb),public.academic_profile_awards_source(uuid,jsonb),public.academic_profile_source(uuid,jsonb),public.published_academic_profile(uuid,text) TO kavosh_runtime;
GRANT SELECT ON public.achievement_awards,public.achievement_award_revisions TO kavosh_signature_evidence_policy;
GRANT EXECUTE ON FUNCTION public.academic_award_selection_valid(jsonb),public.academic_profile_awards_source(uuid,jsonb),public.academic_profile_source(uuid,jsonb) TO kavosh_signature_evidence_policy;
GRANT EXECUTE ON FUNCTION public.published_academic_profile(uuid,text) TO kavosh_public_profile_policy;
GRANT SELECT(academy_id,profile_id,version,changed_by,approval_id) ON public.academic_profile_releases TO kavosh_event_policy;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy,kavosh_public_profile_policy,kavosh_event_policy;
ALTER FUNCTION public.published_academic_profile(uuid,text) OWNER TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.read_published_academic_profile(uuid,text) OWNER TO kavosh_public_profile_policy;
ALTER FUNCTION public.academic_profile_release_complete() OWNER TO kavosh_event_policy;
ALTER FUNCTION public.academic_profile_effect_required() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy,kavosh_public_profile_policy,kavosh_event_policy;
GRANT EXECUTE ON FUNCTION public.read_published_academic_profile(uuid,text) TO kavosh_public_profile_service;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 361 $$;

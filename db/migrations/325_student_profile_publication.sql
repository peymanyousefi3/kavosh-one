-- Separate rights:old organization publishers/tokens do not gain student rights.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('student-profiles.view','View student sharing status and reviewed consent pointers','Community',true,ARRAY['academy','hub','person','country','region','city']),
 ('student-profiles.publish','Review student profile sharing','Community',true,ARRAY['academy','hub','person','country','region','city']),
 ('published-profiles.view','View consented published profiles as a verified school member','Community',true,ARRAY['academy','hub','person','country','region','city']);
ALTER TABLE public.profile_publication_changes DROP CONSTRAINT profile_publication_changes_audience_check;
ALTER TABLE public.profile_publication_changes ADD CHECK(audience IN('public','members','unpublished'));
CREATE FUNCTION public.profile_publication_basis(p_profile uuid,p_audience text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE b jsonb;audience text;consent jsonb;student boolean;BEGIN
 b=public.profile_publication_basis(p_profile);IF b IS NULL THEN RETURN NULL;END IF;
 -- Organization source bytes remain unchanged,including old pending approvals.
 IF b#>>'{owner,kind}'='person' THEN
  audience=coalesce(p_audience,b->>'audience');
  SELECT EXISTS(SELECT 1 FROM public.student_profiles WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND person_id=(b#>>'{owner,id}')::uuid) INTO student;
  IF audience IN('public','members') THEN consent=public.student_profile_consent((b#>>'{owner,id}')::uuid,CASE WHEN audience='public' THEN 'public_profile' ELSE 'verified_member_profile' END);END IF;
  b=b||jsonb_build_object('studentProfile',student,'primaryHubActive',b#>>'{owner,hubId}' IS NULL OR EXISTS(SELECT 1 FROM public.hubs WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=(b#>>'{owner,hubId}')::uuid AND active),'consentAudience',audience,'consent',consent);
 END IF;RETURN b;
END $$;
REVOKE ALL ON FUNCTION public.profile_publication_basis(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_publication_basis(uuid,text) TO kavosh_runtime;
DO $$ DECLARE d text;updated text;BEGIN
 d=pg_get_functiondef('public.guard_profile_publication()'::regprocedure);
 updated=replace(d,'public.profile_publication_basis(NEW.profile_id)','public.profile_publication_basis(NEW.profile_id,NEW.audience)');
 updated=replace(updated,$old$NOT IN('academy','hub')$old$,$new$NOT IN('academy','hub','person')$new$);
 updated=replace(updated,$old$IF NEW.audience='public' AND$old$,$new$IF b#>>'{owner,kind}'<>'person' AND NEW.audience='members' THEN RAISE EXCEPTION 'PROFILE_AUDIENCE_UNSUPPORTED' USING ERRCODE='23514';END IF;
 IF b#>>'{owner,kind}'='person' AND NEW.audience<>'unpublished' AND(b->'studentProfile' IS DISTINCT FROM 'true'::jsonb OR b#>'{consent,eligible}' IS DISTINCT FROM 'true'::jsonb) THEN RAISE EXCEPTION 'STUDENT_PROFILE_CONSENT_REQUIRED' USING ERRCODE='23514';END IF;
 IF b#>>'{owner,kind}'='person' AND NEW.audience<>'unpublished' AND b->'primaryHubActive' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PROFILE_PUBLICATION_SOURCE_UNAVAILABLE' USING ERRCODE='23514';END IF;
 IF NEW.audience IN('public','members') AND$new$);
 updated=replace(updated,$old$a.action IS DISTINCT FROM 'community-profile.publish'$old$,$new$a.action IS DISTINCT FROM (CASE WHEN b#>>'{owner,kind}'='person' THEN 'student-profile.publish' ELSE 'community-profile.publish' END)$new$);
 updated=replace(updated,$old$a.privacy_capability IS DISTINCT FROM 'profiles.view'$old$,$new$a.privacy_capability IS DISTINCT FROM (CASE WHEN b#>>'{owner,kind}'='person' THEN 'student-profiles.view' ELSE 'profiles.view' END)$new$);
 IF updated=d OR strpos(updated,'STUDENT_PROFILE_CONSENT_REQUIRED')=0 OR strpos(updated,'student-profile.publish')=0 THEN RAISE EXCEPTION 'STUDENT_PUBLICATION_GUARD_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.complete_profile_publication()'::regprocedure);
 updated=replace(d,'public.profile_publication_basis(NEW.profile_id)','public.profile_publication_basis(NEW.profile_id,NEW.audience)');
 updated=replace(updated,$old$action='community-profile.publish'$old$,$new$action=CASE WHEN NEW.source_basis#>>'{owner,kind}'='person' THEN 'student-profile.publish' ELSE 'community-profile.publish' END$new$);
 IF updated=d OR strpos(updated,'student-profile.publish')=0 THEN RAISE EXCEPTION 'STUDENT_PUBLICATION_COMPLETION_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.profile_publication_effect_required()'::regprocedure);
 updated=replace(d,$old$NEW.action='community-profile.publish'$old$,$new$NEW.action IN('community-profile.publish','student-profile.publish')$new$);
 IF updated=d THEN RAISE EXCEPTION 'STUDENT_PUBLICATION_EFFECT_UPGRADE_MISMATCH';END IF;EXECUTE updated;
END $$;
-- Only selected authored profile fields,never legal profiles,care,family,
-- files or avatars. The existing public executor remains organization-only.
GRANT SELECT(academy_id,id,anchor_kind,person_id,hub_id,version,definition) ON public.community_profiles TO kavosh_signature_evidence_policy;
GRANT SELECT(id,status) ON public.academies TO kavosh_signature_evidence_policy;
GRANT SELECT(active) ON public.hubs TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,profile_id,public_id,version) ON public.profile_publication_heads TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,profile_id,version,profile_version,audience,source_basis) ON public.profile_publication_changes TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,profile_id,version) ON public.profile_moderation_heads TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,profile_id,version,restricted) ON public.profile_moderation_changes TO kavosh_signature_evidence_policy;
CREATE FUNCTION public.published_profile_projection(p_public uuid,p_audience text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r record;consent jsonb;BEGIN
 IF tenant IS NULL OR p_public IS NULL OR p_audience IS NULL OR p_audience NOT IN('public','members') THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 SELECT p.id,p.anchor_kind,p.person_id,p.version,p.definition,c.source_basis,c.audience,c.profile_version,c.version AS publication_version,ph.public_id,person.status AS person_status,person.kind AS person_kind,person.hub_id AS current_hub,coalesce(h.active,false) AS owner_hub_active,a.status AS academy_status,coalesce(mc.restricted,false) AS restricted INTO r
 FROM public.profile_publication_heads ph JOIN public.profile_publication_changes c ON c.academy_id=ph.academy_id AND c.profile_id=ph.profile_id AND c.version=ph.version
 JOIN public.community_profiles p ON p.academy_id=c.academy_id AND p.id=c.profile_id JOIN public.academies a ON a.id=p.academy_id
 LEFT JOIN public.people person ON person.academy_id=p.academy_id AND person.id=p.person_id
 LEFT JOIN public.hubs h ON h.academy_id=p.academy_id AND h.id=CASE WHEN p.anchor_kind='person' THEN person.hub_id ELSE p.hub_id END
 LEFT JOIN public.profile_moderation_heads mh ON mh.academy_id=p.academy_id AND mh.profile_id=p.id LEFT JOIN public.profile_moderation_changes mc ON mc.academy_id=mh.academy_id AND mc.profile_id=mh.profile_id AND mc.version=mh.version
 WHERE ph.academy_id=tenant AND ph.public_id=p_public;
 IF r.id IS NULL OR r.audience<>p_audience OR r.version<>r.profile_version OR r.definition->'archived' IS DISTINCT FROM 'false'::jsonb OR r.restricted OR r.academy_status NOT IN('active','read_only') THEN RETURN NULL;END IF;
 IF r.anchor_kind='person' THEN
  IF r.person_status IS DISTINCT FROM 'active' OR r.person_kind IS DISTINCT FROM 'human' OR(r.current_hub IS NOT NULL AND NOT r.owner_hub_active) THEN RETURN NULL;END IF;
  consent=public.student_profile_consent(r.person_id,CASE WHEN p_audience='public' THEN 'public_profile' ELSE 'verified_member_profile' END);
  -- New consent never silently republishes an old edition after withdrawal.
  IF consent->'eligible' IS DISTINCT FROM 'true'::jsonb OR consent IS DISTINCT FROM r.source_basis->'consent' OR r.source_basis->>'consentAudience' IS DISTINCT FROM p_audience THEN RETURN NULL;END IF;
 ELSIF p_audience<>'public' OR(r.anchor_kind='hub' AND NOT r.owner_hub_active) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('id',r.public_id,'kind',r.anchor_kind,'profileVersion',r.version,'publicationVersion',r.publication_version,'content',r.definition->'content','links',r.definition->'links','contentFormat','plain_text','mediaIncluded',false);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.published_profile_projection(uuid,text) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.published_profile_projection(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.published_profile_projection(uuid,text) TO kavosh_runtime,kavosh_public_profile_policy;
-- Keep one budgeted anonymous gateway. It may delegate only PUBLIC reads.
DO $$ DECLARE d text;updated text;BEGIN
 d=pg_get_functiondef('public.read_published_organization_profile(uuid,text)'::regprocedure);
 updated=replace(d,'used integer;data jsonb;BEGIN','used integer;data jsonb;previous_tenant text;BEGIN');
 updated=replace(updated,$old$ RETURN jsonb_build_object('limited',false,'data',data);$old$,$new$ IF data IS NULL THEN
  previous_tenant=current_setting('app.academy_id',true);PERFORM set_config('app.academy_id',school::text,true);
  data=public.published_profile_projection(p_profile,'public');
  PERFORM set_config('app.academy_id',coalesce(previous_tenant,''),true);
 END IF;
 RETURN jsonb_build_object('limited',false,'data',data);$new$);
 IF updated=d OR strpos(updated,'previous_tenant text')=0 OR strpos(updated,$q$public.published_profile_projection(p_profile,'public')$q$)=0 THEN RAISE EXCEPTION 'STUDENT_PUBLIC_GATEWAY_UPGRADE_MISMATCH';END IF;EXECUTE updated;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 325 $$;

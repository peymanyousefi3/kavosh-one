-- Distinct sharing rights: existing organization/student publishers gain no
-- worker rights. Reuse the same immutable publication and approval workflow.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('worker-profiles.view','View worker sharing status and reviewed consent pointers','Community',true,ARRAY['academy','hub','person','country','region','city']),
 ('worker-profiles.publish','Review worker profile sharing','Community',true,ARRAY['academy','hub','person','country','region','city']);
CREATE OR REPLACE FUNCTION public.profile_publication_basis(p_profile uuid,p_audience text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE b jsonb;audience text;consent jsonb;student boolean;BEGIN
 b=public.profile_publication_basis(p_profile);IF b IS NULL THEN RETURN NULL;END IF;
 IF b#>>'{owner,kind}'='person' THEN
  audience=coalesce(p_audience,b->>'audience');
  SELECT EXISTS(SELECT 1 FROM public.student_profiles WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND person_id=(b#>>'{owner,id}')::uuid) INTO student;
  IF audience IN('public','members') THEN consent=public.person_profile_consent((b#>>'{owner,id}')::uuid,CASE WHEN audience='public' THEN 'public_profile' ELSE 'verified_member_profile' END);END IF;
  -- Keep existing organization AND student dependency bytes unchanged.
  b=b||jsonb_build_object('studentProfile',student,'visibility',public.student_profile_visibility((b#>>'{owner,id}')::uuid),'primaryHubActive',b#>>'{owner,hubId}' IS NULL OR EXISTS(SELECT 1 FROM public.hubs WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=(b#>>'{owner,hubId}')::uuid AND active),'consentAudience',audience,'consent',consent);
 END IF;RETURN b;
END $$;
DO $$ DECLARE d text;updated text;BEGIN
 d=pg_get_functiondef('public.guard_profile_publication()'::regprocedure);
 updated=replace(d,$q$(b->'studentProfile' IS DISTINCT FROM 'true'::jsonb OR b#>'{consent,eligible}' IS DISTINCT FROM 'true'::jsonb)$q$,$r$(b#>'{consent,eligible}' IS DISTINCT FROM 'true'::jsonb OR (b->'studentProfile'='false'::jsonb AND b#>>'{consent,sourceKind}' IS DISTINCT FROM 'work'))$r$);
 updated=replace(updated,$q$RAISE EXCEPTION 'STUDENT_PROFILE_CONSENT_REQUIRED'$q$,$r$RAISE EXCEPTION 'PERSON_PROFILE_CONSENT_REQUIRED'$r$);
 updated=replace(updated,$q$CASE WHEN b#>>'{owner,kind}'='person' THEN 'student-profile.publish' ELSE 'community-profile.publish' END$q$,$r$CASE WHEN b#>>'{owner,kind}'<>'person' THEN 'community-profile.publish' WHEN b->'studentProfile'='true'::jsonb THEN 'student-profile.publish' ELSE 'worker-profile.publish' END$r$);
 updated=replace(updated,$q$CASE WHEN b#>>'{owner,kind}'='person' THEN 'student-profiles.view' ELSE 'profiles.view' END$q$,$r$CASE WHEN b#>>'{owner,kind}'<>'person' THEN 'profiles.view' WHEN b->'studentProfile'='true'::jsonb THEN 'student-profiles.view' ELSE 'worker-profiles.view' END$r$);
 IF updated=d OR strpos(updated,'worker-profile.publish')=0 OR strpos(updated,'worker-profiles.view')=0 OR strpos(updated,'PERSON_PROFILE_CONSENT_REQUIRED')=0 THEN RAISE EXCEPTION 'WORKER_PUBLICATION_GUARD_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.complete_profile_publication()'::regprocedure);
 updated=replace(d,$q$CASE WHEN NEW.source_basis#>>'{owner,kind}'='person' THEN 'student-profile.publish' ELSE 'community-profile.publish' END$q$,$r$CASE WHEN NEW.source_basis#>>'{owner,kind}'<>'person' THEN 'community-profile.publish' WHEN NEW.source_basis->'studentProfile'='true'::jsonb THEN 'student-profile.publish' ELSE 'worker-profile.publish' END$r$);
 IF updated=d OR strpos(updated,'worker-profile.publish')=0 THEN RAISE EXCEPTION 'WORKER_PUBLICATION_COMPLETION_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.profile_publication_effect_required()'::regprocedure);
 updated=replace(d,$q$IN('community-profile.publish','student-profile.publish')$q$,$r$IN('community-profile.publish','student-profile.publish','worker-profile.publish')$r$);
 IF updated=d THEN RAISE EXCEPTION 'WORKER_PUBLICATION_EFFECT_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.published_profile_projection(uuid,text)'::regprocedure);
 updated=replace(d,'public.student_profile_consent(r.person_id,','public.person_profile_consent(r.person_id,');
 IF updated=d THEN RAISE EXCEPTION 'WORKER_PUBLICATION_PROJECTION_UPGRADE_MISMATCH';END IF;EXECUTE updated;
END $$;
-- No automatic sharing, backfill, raw identity grant, new executor or media.
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 346 $$;

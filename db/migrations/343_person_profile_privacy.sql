-- Reuse the existing immutable privacy journal and mandatory notification
-- floor for non-student people. Historical column/function names remain for
-- compatibility;no duplicate journal or positive consent authority is added.
DO $$ DECLARE t text;c text;BEGIN
 FOREACH t IN ARRAY ARRAY['profile_consent_withdrawals','profile_visibility_choices'] LOOP
  SELECT conname INTO c FROM pg_constraint WHERE conrelid=('public.'||t)::regclass AND contype='f' AND confrelid='public.student_profiles'::regclass;
  IF c IS NULL THEN RAISE EXCEPTION 'PERSON_PRIVACY_SUBJECT_FK_CHANGED';END IF;
  EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c);
  EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY(academy_id,student_id) REFERENCES public.people(academy_id,id)',t,t||'_subject');
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.profile_consent_actor_basis(p_student uuid,p_actor uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('studentId',s.person_id,'actorId',a.id,'hubId',p.hub_id,'studentProfileVersion',s.version,'authority',CASE WHEN a.id=p.id THEN 'self' ELSE 'current_guardian' END,
  'relationshipId',r.id,'relationshipVersion',r.version,'timeZone',h.time_zone)
 FROM public.student_profiles s JOIN public.people p ON p.academy_id=s.academy_id AND p.id=s.person_id
 JOIN public.people a ON a.academy_id=p.academy_id AND a.id=p_actor AND a.kind='human' AND public.report_comment_human_verified(a.id)
 LEFT JOIN public.hubs h ON h.academy_id=p.academy_id AND h.id=p.hub_id
 LEFT JOIN LATERAL(SELECT x.id,x.version FROM public.family_relationships x WHERE x.academy_id=s.academy_id AND x.student_id=s.person_id AND x.guardian_id=a.id AND x.relationship IN('parent','legal_guardian') AND x.state='approved' AND x.valid_from<=clock_timestamp() AND(x.valid_until IS NULL OR x.valid_until>clock_timestamp()) ORDER BY x.id LIMIT 1) r ON true
 WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.person_id=p_student
 AND(a.id=p.id OR(r.id IS NOT NULL AND h.time_zone IS NOT NULL AND public.signature_signing_requires_guardian(s.date_of_birth,clock_timestamp(),h.time_zone)))
 UNION ALL
 SELECT jsonb_build_object('studentId',p.id,'actorId',p.id,'hubId',p.hub_id,'studentProfileVersion',NULL,'authority','self','relationshipId',NULL,'relationshipVersion',NULL,'timeZone',h.time_zone,'subjectKind','person')
 FROM public.people p LEFT JOIN public.hubs h ON h.academy_id=p.academy_id AND h.id=p.hub_id
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_student AND p.id=p_actor AND p.kind='human' AND public.report_comment_human_verified(p.id)
 AND NOT EXISTS(SELECT 1 FROM public.student_profiles s WHERE s.academy_id=p.academy_id AND s.person_id=p.id)
$$;
-- Only the current subject classification is needed for notification scope.
-- Never give the event policy the private family/actor source snapshot.
GRANT SELECT(academy_id,person_id) ON public.student_profiles TO kavosh_event_policy;
DO $$ DECLARE d text;updated text;fn text;needle text;BEGIN
 -- Old student dispatch cutoffs retain their exact meaning. Non-student
 -- workers now use the same post-withdrawal requirement for future consent.
 d=pg_get_functiondef('public.profile_consent_dispatch_current(uuid,text,timestamptz)'::regprocedure);
 updated=replace(d,'FROM public.student_profiles WHERE','FROM public.people WHERE');updated=replace(updated,'AND person_id=p_student','AND id=p_student');
 IF updated=d THEN RAISE EXCEPTION 'PERSON_PRIVACY_DISPATCH_BASE_CHANGED';END IF;EXECUTE updated;
 -- Native-bound notification facts use the correct subject label. Historical
 -- student facts stay byte-identical;no source snapshots or rows are rewritten.
 FOREACH fn IN ARRAY ARRAY['public.profile_consent_notice_basis(uuid)','public.profile_visibility_notice_basis(uuid)'] LOOP
  d=pg_get_functiondef(fn::regprocedure);
  IF fn='public.profile_consent_notice_basis(uuid)' THEN needle=$q$'studentId',w.student_id$q$;updated=replace(d,needle,$q$CASE WHEN EXISTS(SELECT 1 FROM public.student_profiles s WHERE s.academy_id=w.academy_id AND s.person_id=w.student_id) THEN 'studentId' ELSE 'personId' END,w.student_id$q$);
  ELSE needle=$q$'studentId',v.student_id$q$;updated=replace(d,needle,$q$CASE WHEN EXISTS(SELECT 1 FROM public.student_profiles s WHERE s.academy_id=v.academy_id AND s.person_id=v.student_id) THEN 'studentId' ELSE 'personId' END,v.student_id$q$);END IF;
  IF updated=d THEN RAISE EXCEPTION 'PERSON_PRIVACY_NOTICE_BASE_CHANGED';END IF;EXECUTE updated;
 END LOOP;
 FOREACH fn IN ARRAY ARRAY['public.profile_consent_notice_allows(uuid,jsonb)','public.profile_consent_notice_audience(uuid)'] LOOP
  d=pg_get_functiondef(fn::regprocedure);updated=replace(d,$q$b->>'studentId'$q$,$q$coalesce(b->>'studentId',b->>'personId')$q$);
  IF fn='public.profile_consent_notice_allows(uuid,jsonb)' THEN updated=replace(updated,$q$p_scopes->'student-profiles.view'$q$,$q$p_scopes->(CASE WHEN b?'personId' THEN 'people.view' ELSE 'student-profiles.view' END)$q$);END IF;
  IF updated=d THEN RAISE EXCEPTION 'PERSON_PRIVACY_NOTICE_SCOPE_CHANGED';END IF;EXECUTE updated;
 END LOOP;
END $$;
-- No raw journal/identity grant,backfill,automatic public choice or publication.
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 343 $$;

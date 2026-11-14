-- Visibility is a preference,not signature consent or an approval. Default
-- private;public editions require an explicit current family/self choice.
CREATE TABLE public.profile_visibility_choices(
 academy_id uuid NOT NULL,student_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),audience text NOT NULL CHECK(audience IN('public','members')),
 actor_id uuid NOT NULL,session_id uuid NOT NULL,request_id uuid NOT NULL,source_basis jsonb NOT NULL,changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,student_id,version),UNIQUE(academy_id,session_id,request_id),FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id)
);
ALTER TABLE public.profile_visibility_choices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_visibility_choices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.profile_visibility_choices USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.profile_visibility_choices TO kavosh_runtime;
GRANT INSERT(academy_id,student_id,version,audience,actor_id,session_id,request_id,source_basis) ON public.profile_visibility_choices TO kavosh_runtime;
GRANT SELECT(academy_id,student_id,version,audience) ON public.profile_visibility_choices TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,student_id,version,audience,actor_id,session_id,request_id,changed_at) ON public.profile_visibility_choices TO kavosh_event_policy;
CREATE FUNCTION public.student_profile_visibility(p_student uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT jsonb_build_object('version',version,'audience',audience) FROM public.profile_visibility_choices WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND student_id=p_student ORDER BY version DESC LIMIT 1),jsonb_build_object('version',0,'audience','members'))
$$;
REVOKE ALL ON FUNCTION public.student_profile_visibility(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_profile_visibility(uuid) TO kavosh_runtime,kavosh_signature_evidence_policy;
CREATE FUNCTION public.guard_profile_visibility_choice() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;u uuid;v integer;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));
 SELECT auth_user_id INTO u FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.actor_id AND kind='human';
 IF u IS NULL OR public.lock_human(NEW.session_id,u) IS NOT TRUE THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_CURRENT_HUMAN_REQUIRED' USING ERRCODE='23514';END IF;
 b=public.profile_consent_actor_basis(NEW.student_id,NEW.actor_id);SELECT coalesce(max(version),0) INTO v FROM public.profile_visibility_choices WHERE academy_id=NEW.academy_id AND student_id=NEW.student_id;
 IF b IS NULL OR NEW.source_basis IS DISTINCT FROM b OR NEW.version<>v+1 THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_CURRENT_FAMILY_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_profile_visibility_choice() FROM PUBLIC;
CREATE TRIGGER profile_visibility_choice_guard BEFORE INSERT OR UPDATE OR DELETE ON public.profile_visibility_choices FOR EACH ROW EXECUTE FUNCTION public.guard_profile_visibility_choice();
-- Add only the narrow preference to student review dependencies. Organization
-- source bytes remain unchanged;old student approvals must be reviewed anew.
DO $$ DECLARE d text;updated text;BEGIN
 d=pg_get_functiondef('public.profile_publication_basis(uuid,text)'::regprocedure);
 updated=replace(d,$q$'studentProfile',student,$q$,$r$'studentProfile',student,'visibility',public.student_profile_visibility((b#>>'{owner,id}')::uuid),$r$);
 IF updated=d THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_BASIS_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.guard_profile_publication()'::regprocedure);
 updated=replace(d,$q$IF NEW.audience IN('public','members') AND$q$,$r$IF b#>>'{owner,kind}'='person' AND NEW.audience='public' AND(b#>>'{visibility,audience}' IS DISTINCT FROM 'public' OR coalesce((b#>>'{visibility,version}')::integer,0)<1) THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_CHOICE_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.audience IN('public','members') AND$r$);
 IF updated=d THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_PUBLICATION_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.published_profile_projection(uuid,text)'::regprocedure);
 updated=replace(d,'r.audience<>p_audience',$q$(r.audience<>p_audience AND NOT(p_audience='members' AND r.audience='public' AND r.anchor_kind='person'))$q$);
 updated=replace(updated,$q$CASE WHEN p_audience='public' THEN 'public_profile'$q$,$q$CASE WHEN r.audience='public' THEN 'public_profile'$q$);
 updated=replace(updated,$q$r.source_basis->>'consentAudience' IS DISTINCT FROM p_audience$q$,$q$r.source_basis->>'consentAudience' IS DISTINCT FROM r.audience$q$);
 updated=replace(updated,$q$consent=public.student_profile_consent(r.person_id,$q$,$r$IF p_audience='public' AND(public.student_profile_visibility(r.person_id)->>'audience' IS DISTINCT FROM 'public' OR public.student_profile_visibility(r.person_id) IS DISTINCT FROM r.source_basis->'visibility') THEN RETURN NULL;END IF;
  consent=public.student_profile_consent(r.person_id,$r$);
 IF updated=d THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_PROJECTION_UPGRADE_MISMATCH';END IF;EXECUTE updated;
END $$;
CREATE FUNCTION public.profile_visibility_notice_basis(p_event uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('studentId',v.student_id,'audience',v.audience,'version',v.version,'changedAt',to_char(v.changed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'hubId',p.hub_id)
 FROM public.automation_event_sources e JOIN public.audit_events a ON a.academy_id=e.academy_id AND a.id=e.audit_id
 JOIN public.profile_visibility_choices v ON v.academy_id=a.academy_id AND v.student_id=a.entity_id AND v.request_id=a.request_id AND v.actor_id=a.actor_id AND v.session_id=a.session_id
 JOIN public.people p ON p.academy_id=v.academy_id AND p.id=v.student_id
 WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='audit' AND e.event_type='profile-visibility.change' AND a.action=e.event_type AND a.actor_kind='human'
 AND e.projection->>'entityId'=v.student_id::text AND e.projection->>'severity'='critical' AND a.changes=jsonb_build_object('audience',v.audience,'version',v.version,'severity','critical','privateContentRedacted',true)
$$;
CREATE FUNCTION public.profile_privacy_notice_basis(p_event uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(public.profile_consent_notice_basis(p_event),public.profile_visibility_notice_basis(p_event))
$$;
CREATE FUNCTION public.require_profile_visibility_effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE event uuid;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.request_id=NEW.request_id AND a.actor_id=NEW.actor_id AND a.session_id=NEW.session_id AND a.actor_kind='human' AND a.entity_id=NEW.student_id AND a.action='profile-visibility.change' AND a.created_at=transaction_timestamp()
 AND a.hub_id IS NOT DISTINCT FROM(NEW.source_basis->>'hubId')::uuid AND a.changes=jsonb_build_object('audience',NEW.audience,'version',NEW.version,'severity','critical','privateContentRedacted',true))
 OR NOT EXISTS(SELECT 1 FROM public.outbox_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.student_id AND event_type='profile-visibility.change' AND request_id=NEW.request_id AND created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT e.event_id INTO event FROM public.automation_event_sources e JOIN public.audit_events a ON a.academy_id=e.academy_id AND a.id=e.audit_id
 WHERE e.academy_id=NEW.academy_id AND e.source_kind='audit' AND e.event_type='profile-visibility.change' AND e.origin_transaction=pg_current_xact_id() AND a.request_id=NEW.request_id AND a.actor_id=NEW.actor_id AND a.session_id=NEW.session_id AND public.profile_visibility_notice_basis(e.event_id) IS NOT NULL;
 IF event IS NULL OR EXISTS(SELECT 1 FROM public.profile_consent_notice_audience(event) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL
 WHERE NOT EXISTS(SELECT 1 FROM public.portal_notifications n WHERE n.academy_id=NEW.academy_id AND n.event_id=event AND n.person_id=p.id AND n.origin='mandatory')) THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_ALERT_EFFECT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_event_policy;
ALTER FUNCTION public.profile_visibility_notice_basis(uuid) OWNER TO kavosh_event_policy;
ALTER FUNCTION public.profile_privacy_notice_basis(uuid) OWNER TO kavosh_event_policy;
ALTER FUNCTION public.require_profile_visibility_effect() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy;
REVOKE ALL ON FUNCTION public.profile_visibility_notice_basis(uuid),public.profile_privacy_notice_basis(uuid),public.require_profile_visibility_effect() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_privacy_notice_basis(uuid) TO kavosh_runtime;
CREATE CONSTRAINT TRIGGER profile_visibility_effect_required AFTER INSERT ON public.profile_visibility_choices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_profile_visibility_effect();
DO $$ DECLARE d text;updated text;fn text;old_title text:=$q$'Profile sharing consent withdrawn'$q$;old_body text:=$q$'Open the linked privacy record to review this withdrawal. Reading this notice does not restore consent or republish a profile.'$q$;BEGIN
 -- Keep established withdrawal helpers/labels and all other mandatory sources.
 FOREACH fn IN ARRAY ARRAY['public.profile_consent_notice_allows(uuid,jsonb)','public.profile_consent_notice_audience(uuid)','public.publish_profile_consent_alert()'] LOOP
  d=pg_get_functiondef(fn::regprocedure);updated=replace(d,'public.profile_consent_notice_basis(','public.profile_privacy_notice_basis(');
  IF fn='public.publish_profile_consent_alert()' THEN
   updated=replace(updated,old_title,$q$CASE WHEN NEW.event_type='profile-visibility.change' THEN 'Profile visibility preference changed' ELSE 'Profile sharing consent withdrawn' END$q$);
   updated=replace(updated,old_body,$q$CASE WHEN NEW.event_type='profile-visibility.change' THEN 'Open the linked privacy record to review this choice. A visibility choice does not grant consent or publish a profile.' ELSE 'Open the linked privacy record to review this withdrawal. Reading this notice does not restore consent or republish a profile.' END$q$);
  END IF;
  IF updated=d THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_NOTICE_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 END LOOP;
 d=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);
 updated=replace(d,$q$source.source_kind='audit' AND source.event_type='profile-consent.withdraw'$q$,$q$source.source_kind='audit' AND source.event_type IN('profile-consent.withdraw','profile-visibility.change')$q$);
 updated=replace(updated,'public.profile_consent_notice_basis(source.event_id)','public.profile_privacy_notice_basis(source.event_id)');
 updated=replace(updated,'IS DISTINCT FROM '||old_title,$q$IS DISTINCT FROM (CASE WHEN source.event_type='profile-visibility.change' THEN 'Profile visibility preference changed' ELSE 'Profile sharing consent withdrawn' END)$q$);
 updated=replace(updated,'IS DISTINCT FROM '||old_body,$q$IS DISTINCT FROM (CASE WHEN source.event_type='profile-visibility.change' THEN 'Open the linked privacy record to review this choice. A visibility choice does not grant consent or publish a profile.' ELSE 'Open the linked privacy record to review this withdrawal. Reading this notice does not restore consent or republish a profile.' END)$q$);
 IF updated=d OR strpos(updated,'Profile visibility preference changed')=0 THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_MANDATORY_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);
 updated=replace(d,$q$CASE WHEN NEW.event_type='profile-consent.withdraw' THEN$q$,$q$CASE WHEN NEW.event_type='profile-visibility.change' THEN jsonb_build_object('audience',a.changes->'audience','visibilityVersion',a.changes->'version') WHEN NEW.event_type='profile-consent.withdraw' THEN$q$);
 IF updated=d THEN RAISE EXCEPTION 'PROFILE_VISIBILITY_CAPTURE_UPGRADE_MISMATCH';END IF;EXECUTE updated;
END $$;
CREATE TRIGGER publish_profile_visibility_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='audit' AND NEW.event_type='profile-visibility.change') EXECUTE FUNCTION public.publish_profile_consent_alert();
-- No backfill or implicit public choice. Existing private histories remain
-- intact;student public editions without a pinned family choice stay hidden.
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 327 $$;

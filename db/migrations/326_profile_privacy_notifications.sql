-- Reuse the immutable audit-backed source,not another copy of family details.
GRANT SELECT(academy_id,student_id,purpose,version,actor_id,session_id,request_id,withdrawn_at) ON public.profile_consent_withdrawals TO kavosh_event_policy;
GRANT SELECT(academy_id,event_id,person_id,origin) ON public.portal_notifications TO kavosh_event_policy;
CREATE FUNCTION public.profile_consent_notice_basis(p_event uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('studentId',w.student_id,'purpose',w.purpose,'version',w.version,'withdrawnAt',to_char(w.withdrawn_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'hubId',p.hub_id)
 FROM public.automation_event_sources e JOIN public.audit_events a ON a.academy_id=e.academy_id AND a.id=e.audit_id
 JOIN public.profile_consent_withdrawals w ON w.academy_id=a.academy_id AND w.student_id=a.entity_id AND w.request_id=a.request_id AND w.actor_id=a.actor_id AND w.session_id=a.session_id
 JOIN public.people p ON p.academy_id=w.academy_id AND p.id=w.student_id
 WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='audit' AND e.event_type='profile-consent.withdraw'
 AND a.action=e.event_type AND a.actor_kind='human' AND e.projection->>'entityId'=w.student_id::text AND e.projection->>'severity'='critical'
 AND a.changes=jsonb_build_object('purpose',w.purpose,'version',w.version,'severity','critical','privateContentRedacted',true)
$$;
CREATE FUNCTION public.profile_consent_notice_allows(p_event uuid,p_scopes jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT public.scope_contains(coalesce(p_scopes->'profiles.view','{"all":false,"hubs":[]}'::jsonb),s)
 AND public.scope_contains(coalesce(p_scopes->'student-profiles.view','{"all":false,"hubs":[]}'::jsonb),s)
 FROM(SELECT b,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',b->>'studentId','hubId',b->'hubId')),'workContext',jsonb_build_object('personId',b->>'studentId','hubId',b->'hubId')) s FROM(SELECT public.profile_consent_notice_basis(p_event) b) bound WHERE b IS NOT NULL) context),false)
$$;
CREATE FUNCTION public.profile_consent_notice_audience(p_event uuid) RETURNS TABLE(person_id uuid) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT chain.person_id FROM(SELECT public.profile_consent_notice_basis(p_event) b) source CROSS JOIN LATERAL public.supervisor_chain((b->>'studentId')::uuid) chain WHERE b IS NOT NULL
 UNION SELECT master_person_id FROM public.academies WHERE id=nullif(current_setting('app.academy_id',true),'')::uuid AND public.profile_consent_notice_basis(p_event) IS NOT NULL
$$;
CREATE FUNCTION public.profile_consent_notice_upper(p_event uuid,p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.profile_consent_notice_audience(p_event) WHERE person_id=p_actor)
$$;
CREATE FUNCTION public.publish_profile_consent_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE recipients uuid[];added integer;BEGIN
 IF public.profile_consent_notice_basis(NEW.event_id) IS NULL THEN RAISE EXCEPTION 'PROFILE_PRIVACY_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT array_agg(p.id ORDER BY p.id) INTO recipients FROM public.profile_consent_notice_audience(NEW.event_id) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin)
 SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,id,0,'critical','Profile sharing consent withdrawn','Open the linked privacy record to review this withdrawal. Reading this notice does not restore consent or republish a profile.','en','mandatory' FROM unnest(recipients) id;
 GET DIAGNOSTICS added=ROW_COUNT;IF added<>coalesce(cardinality(recipients),0) THEN RAISE EXCEPTION 'PROFILE_PRIVACY_ALERT_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE FUNCTION public.require_profile_consent_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE event uuid;BEGIN
 SELECT e.event_id INTO event FROM public.automation_event_sources e JOIN public.audit_events a ON a.academy_id=e.academy_id AND a.id=e.audit_id
 WHERE e.academy_id=NEW.academy_id AND e.source_kind='audit' AND e.event_type='profile-consent.withdraw' AND e.origin_transaction=pg_current_xact_id()
 AND a.request_id=NEW.request_id AND a.actor_id=NEW.actor_id AND a.session_id=NEW.session_id AND a.entity_id=NEW.student_id AND public.profile_consent_notice_basis(e.event_id) IS NOT NULL;
 IF event IS NULL OR EXISTS(SELECT 1 FROM public.profile_consent_notice_audience(event) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL
 WHERE NOT EXISTS(SELECT 1 FROM public.portal_notifications n WHERE n.academy_id=NEW.academy_id AND n.event_id=event AND n.person_id=p.id AND n.origin='mandatory'))
 THEN RAISE EXCEPTION 'PROFILE_PRIVACY_ALERT_EFFECT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_event_policy,kavosh_runtime;
ALTER FUNCTION public.profile_consent_notice_basis(uuid) OWNER TO kavosh_event_policy;
ALTER FUNCTION public.profile_consent_notice_allows(uuid,jsonb) OWNER TO kavosh_runtime;
ALTER FUNCTION public.profile_consent_notice_upper(uuid,uuid) OWNER TO kavosh_event_policy;
ALTER FUNCTION public.publish_profile_consent_alert() OWNER TO kavosh_event_policy;
ALTER FUNCTION public.require_profile_consent_notice() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy,kavosh_runtime;
REVOKE ALL ON FUNCTION public.profile_consent_notice_basis(uuid),public.profile_consent_notice_allows(uuid,jsonb),public.profile_consent_notice_audience(uuid),public.profile_consent_notice_upper(uuid,uuid),public.publish_profile_consent_alert(),public.require_profile_consent_notice() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_consent_notice_basis(uuid),public.profile_consent_notice_audience(uuid),public.profile_consent_notice_upper(uuid,uuid) TO kavosh_runtime;
GRANT EXECUTE ON FUNCTION public.profile_consent_notice_audience(uuid) TO kavosh_event_policy;
GRANT EXECUTE ON FUNCTION public.profile_consent_notice_allows(uuid,jsonb) TO kavosh_runtime,kavosh_message_worker,kavosh_message_policy;
CREATE TRIGGER publish_profile_consent_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='audit' AND NEW.event_type='profile-consent.withdraw') EXECUTE FUNCTION public.publish_profile_consent_alert();
CREATE CONSTRAINT TRIGGER profile_consent_withdrawal_notice_required AFTER INSERT ON public.profile_consent_withdrawals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_profile_consent_notice();
DO $$ DECLARE d text;needle text:=$q$jsonb_build_object('auditId',a.id,'action',a.action)$q$;BEGIN
 d=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);IF position(needle IN d)=0 THEN RAISE EXCEPTION 'PROFILE_PRIVACY_CAPTURE_BASE_CHANGED';END IF;
 EXECUTE replace(d,needle,$branch$(jsonb_build_object('auditId',a.id,'action',a.action)||CASE WHEN NEW.event_type='profile-consent.withdraw' THEN jsonb_build_object('purpose',a.changes->'purpose','withdrawalVersion',a.changes->'version') ELSE '{}'::jsonb END)$branch$);
END $$;
DO $$ DECLARE d text;needle text:='IF source.event_id IS NULL';BEGIN
 d=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);IF position(needle IN d)=0 THEN RAISE EXCEPTION 'PROFILE_PRIVACY_MANDATORY_GUARD_BASE_CHANGED';END IF;
 EXECUTE replace(d,needle,$branch$IF source.source_kind='audit' AND source.event_type='profile-consent.withdraw' THEN
  IF public.profile_consent_notice_basis(source.event_id) IS NULL OR NEW.locale<>'en' OR NEW.title IS DISTINCT FROM 'Profile sharing consent withdrawn' OR NEW.body IS DISTINCT FROM 'Open the linked privacy record to review this withdrawal. Reading this notice does not restore consent or republish a profile.'
  OR NOT EXISTS(SELECT 1 FROM public.profile_consent_notice_audience(source.event_id) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id WHERE p.id=NEW.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL) THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);
END $$;
-- Existing rows/history stay untouched. New withdrawals cannot lose their
-- native audit source or mandatory floor even if a BEFORE trigger drops rows.
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 326 $$;

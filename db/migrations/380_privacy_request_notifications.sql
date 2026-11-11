-- Bind private-request alerts to the real immutable case/audit edition.
-- No request text,response,review note,contact or identity payload is copied.
GRANT SELECT(academy_id,id,subject_id,requested_by,origin,version) ON public.privacy_requests TO kavosh_event_policy;
GRANT SELECT(academy_id,request_id,version,state,changed_by,session_id,api_request_id,approval_id) ON public.privacy_request_revisions TO kavosh_event_policy;
CREATE FUNCTION public.privacy_request_notice_basis(event uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('requestId',h.id,'subjectId',h.subject_id,'requestedBy',h.requested_by,'origin',h.origin,'version',r.version,'state',r.state,'scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',(SELECT jsonb_agg(jsonb_build_object('id',id,'hubId',hub_id) ORDER BY id) FROM public.people WHERE id=h.subject_id OR h.origin='self' AND id=h.requested_by)))
 FROM public.automation_event_sources e JOIN public.audit_events a ON a.academy_id=e.academy_id AND a.id=e.audit_id
 JOIN public.privacy_request_revisions r ON r.academy_id=a.academy_id AND r.request_id=a.entity_id AND r.version=(a.changes->>'version')::integer AND r.changed_by=a.actor_id AND r.session_id=a.session_id AND r.api_request_id=a.request_id
 JOIN public.privacy_requests h ON h.academy_id=r.academy_id AND h.id=r.request_id
 WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=event AND e.source_kind='audit' AND e.event_type IN('privacy.request.created','privacy.request.reviewed','privacy.request.withdrawn','privacy.request.clarified')
 AND e.event_type=a.action AND a.actor_kind='human' AND e.projection->>'entityId'=h.id::text AND e.projection->>'severity'='critical'
 AND a.changes=jsonb_build_object('version',r.version,'state',r.state,'approvalId',r.approval_id,'severity','critical','privateContentRedacted',true)
$$;
CREATE FUNCTION public.privacy_request_notice_allows(event uuid,actor uuid,scopes jsonb) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH source AS MATERIALIZED(SELECT public.privacy_request_notice_basis(event) b)
 SELECT coalesce((SELECT CASE WHEN b->>'origin'='self' AND b->>'requestedBy'=actor::text THEN public.profile_consent_actor_basis((b->>'subjectId')::uuid,actor) IS NOT NULL ELSE false END OR public.scope_contains(coalesce(scopes->'privacy-requests.view','{"all":false,"hubs":[]}'::jsonb),b->'scope') FROM source WHERE b IS NOT NULL),false)
$$;
CREATE FUNCTION public.privacy_request_notice_audience(event uuid) RETURNS TABLE(person_id uuid) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH source AS MATERIALIZED(SELECT public.privacy_request_notice_basis(event) b)
 SELECT(b->>'requestedBy')::uuid FROM source WHERE b IS NOT NULL
 UNION SELECT chain.person_id FROM source CROSS JOIN LATERAL public.supervisor_chain((b->>'requestedBy')::uuid) chain WHERE b IS NOT NULL
 UNION SELECT master_person_id FROM public.academies CROSS JOIN source WHERE id=nullif(current_setting('app.academy_id',true),'')::uuid AND b IS NOT NULL
$$;
CREATE FUNCTION public.publish_privacy_request_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE recipients uuid[];added integer;BEGIN
 IF public.privacy_request_notice_basis(NEW.event_id) IS NULL THEN RAISE EXCEPTION 'PRIVACY_REQUEST_NOTICE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT array_agg(p.id ORDER BY p.id) INTO recipients FROM public.privacy_request_notice_audience(NEW.event_id) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin)
 SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,id,0,'critical','Privacy request updated','Open the linked privacy request to review its current status. Reading this notice does not disclose, correct or delete records.','en','mandatory' FROM unnest(recipients) id;
 GET DIAGNOSTICS added=ROW_COUNT;IF added<>coalesce(cardinality(recipients),0) THEN RAISE EXCEPTION 'PRIVACY_REQUEST_NOTICE_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE FUNCTION public.privacy_request_notice_required() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE event uuid;BEGIN
 SELECT e.event_id INTO event FROM public.audit_events a JOIN public.automation_event_sources e ON e.academy_id=a.academy_id AND e.audit_id=a.id WHERE a.academy_id=NEW.academy_id AND a.request_id=NEW.api_request_id AND a.entity_id=NEW.request_id AND a.actor_id=NEW.changed_by AND a.created_at=transaction_timestamp() AND e.source_kind='audit' AND e.origin_transaction=pg_current_xact_id() AND e.event_type IN('privacy.request.created','privacy.request.reviewed','privacy.request.withdrawn','privacy.request.clarified') AND(public.privacy_request_notice_basis(e.event_id)->>'version')::integer=NEW.version;
 IF event IS NULL OR EXISTS(SELECT 1 FROM public.privacy_request_notice_audience(event) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL
 WHERE NOT EXISTS(SELECT 1 FROM public.portal_notifications n WHERE n.academy_id=NEW.academy_id AND n.event_id=event AND n.person_id=p.id AND n.origin='mandatory')) THEN RAISE EXCEPTION 'PRIVACY_REQUEST_NOTICE_EFFECT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
DO $$ DECLARE body text;needle text:='IF source.event_id IS NULL';BEGIN
 body=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PRIVACY_REQUEST_MANDATORY_GUARD_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF source.source_kind='audit' AND source.event_type IN('privacy.request.created','privacy.request.reviewed','privacy.request.withdrawn','privacy.request.clarified') THEN
  IF public.privacy_request_notice_basis(source.event_id) IS NULL OR NEW.locale<>'en' OR NEW.title IS DISTINCT FROM 'Privacy request updated' OR NEW.body IS DISTINCT FROM 'Open the linked privacy request to review its current status. Reading this notice does not disclose, correct or delete records.' OR NOT EXISTS(SELECT 1 FROM public.privacy_request_notice_audience(source.event_id) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id WHERE p.id=NEW.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL) THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_event_policy,kavosh_runtime;
ALTER FUNCTION public.privacy_request_notice_basis(uuid) OWNER TO kavosh_event_policy;
ALTER FUNCTION public.privacy_request_notice_allows(uuid,uuid,jsonb) OWNER TO kavosh_runtime;
ALTER FUNCTION public.publish_privacy_request_alert() OWNER TO kavosh_event_policy;
ALTER FUNCTION public.privacy_request_notice_required() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy,kavosh_runtime;
REVOKE ALL ON FUNCTION public.privacy_request_notice_basis(uuid),public.privacy_request_notice_allows(uuid,uuid,jsonb),public.privacy_request_notice_audience(uuid),public.publish_privacy_request_alert(),public.privacy_request_notice_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_request_notice_basis(uuid) TO kavosh_runtime;
GRANT EXECUTE ON FUNCTION public.privacy_request_notice_audience(uuid) TO kavosh_event_policy;
GRANT EXECUTE ON FUNCTION public.privacy_request_notice_allows(uuid,uuid,jsonb) TO kavosh_runtime,kavosh_message_worker,kavosh_message_policy;
CREATE TRIGGER publish_privacy_request_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='audit' AND NEW.event_type IN('privacy.request.created','privacy.request.reviewed','privacy.request.withdrawn','privacy.request.clarified')) EXECUTE FUNCTION public.publish_privacy_request_alert();
CREATE CONSTRAINT TRIGGER privacy_request_notice_required AFTER INSERT ON public.privacy_request_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.privacy_request_notice_required();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 380 $$;

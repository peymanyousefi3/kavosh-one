-- Future terminal processing failures only. Withdrawal/source invalidation is
-- expected,not a critical failure. Never fabricate alerts for historical jobs.
CREATE TABLE public.profile_image_incidents(
 academy_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),profile_id uuid NOT NULL,release_version integer NOT NULL,image_no integer NOT NULL,attempt_no integer NOT NULL CHECK(attempt_no BETWEEN 1 AND 5),
 approval_id uuid NOT NULL,requester_id uuid NOT NULL,reviewer_id uuid NOT NULL,hub_id uuid,reason_code text NOT NULL CHECK(reason_code IN('unavailable','rejected','stored_bytes_mismatch','outcome_unknown','lease_expired')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),origin_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,profile_id,release_version,image_no),
 FOREIGN KEY(academy_id,profile_id,release_version,image_no) REFERENCES public.profile_image_jobs(academy_id,profile_id,release_version,image_no),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,requester_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,reviewer_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id)
);
ALTER TABLE public.profile_image_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_image_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.profile_image_incidents USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT,INSERT ON public.profile_image_incidents TO kavosh_event_policy;
GRANT SELECT ON public.profile_image_incidents TO kavosh_runtime,kavosh_signature_evidence_policy;
GRANT CREATE ON SCHEMA public TO kavosh_event_policy,kavosh_runtime;
CREATE TRIGGER image_incident_immutable BEFORE UPDATE OR DELETE ON public.profile_image_incidents FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.profile_image_incidents FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion();
CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.profile_image_incidents FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate();
CREATE FUNCTION public.image_processing_failure_context(p_profile uuid,p_version integer,p_image integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('profileId',j.profile_id,'releaseVersion',j.release_version,'imageNo',j.image_no,'attemptNo',j.attempt_no,'approvalId',r.approval_id,'requesterId',a.requester_id,'reviewerId',r.changed_by,'hubId',r.source#>'{profile,owner,hubId}','reasonCode',j.last_outcome)
 FROM public.profile_image_jobs j JOIN public.profile_image_releases r ON r.academy_id=j.academy_id AND r.profile_id=j.profile_id AND r.version=j.release_version JOIN public.approval_requests a ON a.academy_id=r.academy_id AND a.id=r.approval_id AND a.status='applied' AND a.reviewer_id=r.changed_by
 WHERE j.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND j.profile_id=p_profile AND j.release_version=p_version AND j.image_no=p_image AND j.state='blocked' AND j.attempt_no>=1 AND(j.last_outcome IN('rejected','stored_bytes_mismatch') OR j.attempt_no=5 AND j.last_outcome IN('unavailable','outcome_unknown','lease_expired'))
$$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.image_processing_failure_context(uuid,integer,integer) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.image_processing_failure_context(uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.image_processing_failure_context(uuid,integer,integer) TO kavosh_event_policy;
CREATE FUNCTION public.image_processing_incident_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE c jsonb:=public.image_processing_failure_context(NEW.profile_id,NEW.release_version,NEW.image_no);BEGIN
 IF current_user<>'kavosh_event_policy' OR NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id() OR c IS NULL OR c IS DISTINCT FROM jsonb_build_object('profileId',NEW.profile_id,'releaseVersion',NEW.release_version,'imageNo',NEW.image_no,'attemptNo',NEW.attempt_no,'approvalId',NEW.approval_id,'requesterId',NEW.requester_id,'reviewerId',NEW.reviewer_id,'hubId',NEW.hub_id,'reasonCode',NEW.reason_code) THEN RAISE EXCEPTION 'IMAGE_INCIDENT_EXACT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;NEW.recorded_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER image_incident_guard BEFORE INSERT ON public.profile_image_incidents FOR EACH ROW EXECUTE FUNCTION public.image_processing_incident_guard();
CREATE FUNCTION public.capture_image_processing_failure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE prior text:=current_setting('app.academy_id',true);c jsonb;BEGIN
 PERFORM set_config('app.academy_id',NEW.academy_id::text,true);c=public.image_processing_failure_context(NEW.profile_id,NEW.release_version,NEW.image_no);
 IF c IS NOT NULL THEN INSERT INTO public.profile_image_incidents(academy_id,profile_id,release_version,image_no,attempt_no,approval_id,requester_id,reviewer_id,hub_id,reason_code) VALUES(NEW.academy_id,NEW.profile_id,NEW.release_version,NEW.image_no,NEW.attempt_no,(c->>'approvalId')::uuid,(c->>'requesterId')::uuid,(c->>'reviewerId')::uuid,(c->>'hubId')::uuid,c->>'reasonCode');IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_INCIDENT_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;END IF;
 PERFORM set_config('app.academy_id',coalesce(prior,''),true);RETURN NULL;
END $$;
ALTER FUNCTION public.capture_image_processing_failure() OWNER TO kavosh_event_policy;
CREATE TRIGGER image_processing_failure AFTER UPDATE ON public.profile_image_jobs FOR EACH ROW WHEN(NEW.state='blocked' AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION public.capture_image_processing_failure();
DO $$ DECLARE expression text;BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='public.automation_event_sources'::regclass AND conname='automation_event_sources_source_kind_check';IF expression IS NULL THEN RAISE EXCEPTION 'IMAGE_EVENT_ENUM_CHANGED';END IF;
 ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;EXECUTE 'ALTER TABLE public.automation_event_sources ADD CONSTRAINT automation_event_sources_source_kind_check CHECK(('||expression||') OR source_kind=''image_processing'')';
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='public.automation_event_sources'::regclass AND conname='automation_event_operational_audit';IF expression IS NULL THEN RAISE EXCEPTION 'IMAGE_EVENT_AUDIT_BOUNDARY_CHANGED';END IF;
 ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_operational_audit;EXECUTE 'ALTER TABLE public.automation_event_sources ADD CONSTRAINT automation_event_operational_audit CHECK(CASE WHEN source_kind=''image_processing'' THEN audit_id IS NULL ELSE ('||expression||') END)';
END $$;
ALTER TABLE public.automation_event_sources ADD profile_image_incident_id uuid,ADD FOREIGN KEY(academy_id,profile_image_incident_id) REFERENCES public.profile_image_incidents(academy_id,id),ADD UNIQUE(academy_id,profile_image_incident_id),ADD CHECK((source_kind='image_processing')=(profile_image_incident_id IS NOT NULL));
CREATE FUNCTION public.image_processing_audience(p_incident uuid) RETURNS TABLE(person_id uuid) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH incident AS MATERIALIZED(SELECT * FROM public.profile_image_incidents WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_incident)
 SELECT reviewer_id FROM incident UNION SELECT chain.person_id FROM incident CROSS JOIN LATERAL public.supervisor_chain(requester_id) chain UNION SELECT chain.person_id FROM incident CROSS JOIN LATERAL public.supervisor_chain(reviewer_id) chain
 UNION SELECT master_person_id FROM public.academies WHERE id=nullif(current_setting('app.academy_id',true),'')::uuid AND EXISTS(SELECT 1 FROM incident)
$$;
CREATE FUNCTION public.image_processing_projection(p_incident uuid,p_origin xid8) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('eventType','profile.image.processing.blocked.critical','entityId',i.id,'hubId',i.hub_id,'actorId',NULL,'actorKind','system','severity','critical','occurredAt',to_char(i.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',jsonb_build_object('profileId',i.profile_id,'releaseVersion',i.release_version,'imageNo',i.image_no,'attemptNo',i.attempt_no,'reasonCode',i.reason_code,'imagesPublished',false,'originalsModified',false)) FROM public.profile_image_incidents i WHERE i.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND i.id=p_incident AND i.origin_transaction=p_origin
$$;
CREATE FUNCTION public.image_processing_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p jsonb:=public.image_processing_projection(NEW.profile_image_incident_id,NEW.origin_transaction);BEGIN
 IF current_user<>'kavosh_event_policy' OR NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id() OR p IS NULL OR NEW.projection IS DISTINCT FROM p OR NEW.event_id IS DISTINCT FROM NEW.profile_image_incident_id OR NEW.source_version<>1 OR NEW.event_type IS DISTINCT FROM p->>'eventType' OR NEW.hub_id::text IS DISTINCT FROM p->>'hubId' OR NEW.occurred_at IS DISTINCT FROM(p->>'occurredAt')::timestamptz OR NEW.audit_id IS NOT NULL OR NEW.approval_id IS NOT NULL THEN RAISE EXCEPTION 'IMAGE_EVENT_EXACT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER image_processing_event_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='image_processing') EXECUTE FUNCTION public.image_processing_event_guard();
CREATE FUNCTION public.capture_image_processing_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE p jsonb:=public.image_processing_projection(NEW.id,NEW.origin_transaction);BEGIN
 IF NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id() OR p IS NULL THEN RAISE EXCEPTION 'IMAGE_EVENT_ORIGIN_REQUIRED' USING ERRCODE='55000';END IF;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(NEW.academy_id,NEW.id,p->>'eventType',NEW.id,gen_random_uuid());IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_OUTBOX_REQUIRED' USING ERRCODE='55000';END IF;
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,profile_image_incident_id) VALUES(NEW.academy_id,NEW.id,NULL,NULL,'image_processing',1,p->>'eventType',NEW.hub_id,(p->>'occurredAt')::timestamptz,p,NEW.id);IF NOT FOUND THEN RAISE EXCEPTION 'IMAGE_EVENT_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
ALTER FUNCTION public.capture_image_processing_event() OWNER TO kavosh_event_policy;
CREATE TRIGGER image_processing_event AFTER INSERT ON public.profile_image_incidents FOR EACH ROW EXECUTE FUNCTION public.capture_image_processing_event();
CREATE FUNCTION public.publish_image_processing_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE recipients uuid[];added integer;BEGIN
 SELECT array_agg(p.id ORDER BY p.id) INTO recipients FROM public.image_processing_audience(NEW.profile_image_incident_id) a JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=a.person_id WHERE p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin) SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,id,0,'critical','Profile image processing needs attention','Open the linked image processing record to review this failure. Reading this notice does not retry processing,publish images or change original files.','en','mandatory' FROM unnest(recipients) id;GET DIAGNOSTICS added=ROW_COUNT;IF added<>coalesce(cardinality(recipients),0) THEN RAISE EXCEPTION 'IMAGE_NOTICE_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
ALTER FUNCTION public.publish_image_processing_alert() OWNER TO kavosh_event_policy;
CREATE TRIGGER image_processing_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='image_processing') EXECUTE FUNCTION public.publish_image_processing_alert();
DO $$ DECLARE body text;needle text:='IF source.event_id IS NULL';BEGIN
 body=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'IMAGE_MANDATORY_GUARD_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF source.source_kind='image_processing' THEN
  IF source.projection->>'severity' IS DISTINCT FROM 'critical' OR NEW.locale<>'en' OR NEW.title IS DISTINCT FROM 'Profile image processing needs attention' OR NEW.body IS DISTINCT FROM 'Open the linked image processing record to review this failure. Reading this notice does not retry processing,publish images or change original files.' OR NOT EXISTS(SELECT 1 FROM public.image_processing_audience(source.profile_image_incident_id) a JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=a.person_id WHERE p.id=NEW.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL) THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);
END $$;
CREATE FUNCTION public.image_processing_notice_allows(p_incident uuid,scopes jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT public.approval_bindings_allow(a.privacy_bindings,scopes) FROM public.profile_image_incidents i JOIN public.approval_requests a ON a.academy_id=i.academy_id AND a.id=i.approval_id WHERE i.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND i.id=p_incident),false)
$$;
ALTER FUNCTION public.image_processing_notice_allows(uuid,jsonb) OWNER TO kavosh_runtime;
CREATE FUNCTION public.image_processing_notice_current(p_incident uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.profile_image_incidents i WHERE i.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND i.id=p_incident AND public.image_processing_failure_context(i.profile_id,i.release_version,i.image_no) IS NOT NULL AND public.profile_image_job_source(i.academy_id,i.profile_id,i.release_version,i.image_no) IS NOT NULL)
$$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.image_processing_notice_current(uuid) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.image_processing_incident_guard(),public.capture_image_processing_failure(),public.image_processing_audience(uuid),public.image_processing_projection(uuid,xid8),public.image_processing_event_guard(),public.capture_image_processing_event(),public.publish_image_processing_alert(),public.image_processing_notice_allows(uuid,jsonb),public.image_processing_notice_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.image_processing_audience(uuid),public.image_processing_projection(uuid,xid8) TO kavosh_event_policy;
CREATE FUNCTION public.image_processing_notice_upper(p_incident uuid,p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT EXISTS(SELECT 1 FROM public.image_processing_audience(p_incident) WHERE person_id=p_actor) $$;
ALTER FUNCTION public.image_processing_notice_upper(uuid,uuid) OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.image_processing_notice_upper(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.image_processing_notice_allows(uuid,jsonb),public.image_processing_notice_current(uuid),public.image_processing_notice_upper(uuid,uuid) TO kavosh_runtime,kavosh_automation_worker,kavosh_automation_policy,kavosh_message_worker,kavosh_message_policy;
-- No custom/outbound recipient is implicitly authorized by a new system fact.
-- Explicit recipient/locking/last-moment checks must precede enabling delivery.
CREATE FUNCTION public.guard_image_processing_custom_delivery() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='image_processing') THEN RAISE EXCEPTION 'IMAGE_PROCESSING_CUSTOM_DELIVERY_DISABLED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_image_processing_custom_delivery() FROM PUBLIC;
CREATE TRIGGER aa_image_processing_delivery_guard BEFORE INSERT OR UPDATE ON public.notification_deliveries FOR EACH ROW EXECUTE FUNCTION public.guard_image_processing_custom_delivery();
CREATE TRIGGER aa_image_processing_portal_guard BEFORE INSERT ON public.portal_notifications FOR EACH ROW WHEN(NEW.origin='automation') EXECUTE FUNCTION public.guard_image_processing_custom_delivery();
-- A skipped producer/event/notice cannot leave a committed blocked job without
-- its durable case and complete mandatory audience. Reading is not resolution.
CREATE FUNCTION public.image_processing_failure_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE prior text:=current_setting('app.academy_id',true);c jsonb;incident uuid;BEGIN
 PERFORM set_config('app.academy_id',NEW.academy_id::text,true);c=public.image_processing_failure_context(NEW.profile_id,NEW.release_version,NEW.image_no);
 IF c IS NOT NULL THEN
  SELECT i.id INTO incident FROM public.profile_image_incidents i JOIN public.automation_event_sources e ON e.academy_id=i.academy_id AND e.profile_image_incident_id=i.id JOIN public.outbox_events o ON o.academy_id=e.academy_id AND o.id=e.event_id
  WHERE i.academy_id=NEW.academy_id AND i.profile_id=NEW.profile_id AND i.release_version=NEW.release_version AND i.image_no=NEW.image_no AND i.attempt_no=NEW.attempt_no AND i.reason_code=NEW.last_outcome AND i.origin_transaction=pg_current_xact_id() AND e.origin_transaction=i.origin_transaction AND e.source_kind='image_processing' AND e.projection=public.image_processing_projection(i.id,i.origin_transaction) AND o.event_type=e.event_type AND o.entity_id=i.id;
  IF incident IS NULL OR EXISTS(SELECT 1 FROM public.image_processing_audience(incident) a JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=a.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL WHERE NOT EXISTS(SELECT 1 FROM public.portal_notifications n WHERE n.academy_id=NEW.academy_id AND n.event_id=incident AND n.person_id=p.id AND n.origin='mandatory')) THEN RAISE EXCEPTION 'IMAGE_FAILURE_NOTICE_EFFECT_REQUIRED' USING ERRCODE='55000';END IF;
 END IF;PERFORM set_config('app.academy_id',coalesce(prior,''),true);RETURN NULL;
END $$;
ALTER FUNCTION public.image_processing_failure_complete() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.image_processing_failure_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER image_processing_failure_complete AFTER UPDATE ON public.profile_image_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.state='blocked' AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION public.image_processing_failure_complete();
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy,kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 418 $$;

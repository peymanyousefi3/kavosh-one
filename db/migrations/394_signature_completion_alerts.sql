-- Future durable incidents only. Never publish a new alert for an old row.
DO $$ DECLARE expression text;BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='public.automation_event_sources'::regclass AND conname='automation_event_sources_source_kind_check';
 IF expression IS NULL THEN RAISE EXCEPTION 'SIGNATURE_ALERT_SOURCE_ENUM_CHANGED';END IF;
 ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
 EXECUTE 'ALTER TABLE public.automation_event_sources ADD CONSTRAINT automation_event_sources_source_kind_check CHECK(('||expression||') OR source_kind=''signature_check'')';
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='public.automation_event_sources'::regclass AND conname='automation_event_operational_audit';
 IF expression IS NULL THEN RAISE EXCEPTION 'SIGNATURE_ALERT_AUDIT_BOUNDARY_CHANGED';END IF;
 ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_operational_audit;
 EXECUTE 'ALTER TABLE public.automation_event_sources ADD CONSTRAINT automation_event_operational_audit CHECK(CASE WHEN source_kind=''signature_check'' THEN audit_id IS NULL ELSE ('||expression||') END)';
END $$;
ALTER TABLE public.automation_event_sources ADD signature_completion_incident_id uuid,
 ADD FOREIGN KEY(academy_id,signature_completion_incident_id) REFERENCES public.signature_completion_incidents(academy_id,id),
 ADD UNIQUE(academy_id,signature_completion_incident_id),ADD CHECK((source_kind='signature_check')=(signature_completion_incident_id IS NOT NULL));
GRANT SELECT(actor_id) ON public.signature_dispatch_starts,public.work_signature_dispatch_starts TO kavosh_signature_completion_policy;
GRANT CREATE ON SCHEMA public TO kavosh_signature_completion_policy;

CREATE FUNCTION public.signature_check_context(p_incident uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;i public.signature_completion_incidents;parent record;BEGIN
 SELECT * INTO i FROM public.signature_completion_incidents WHERE academy_id=tenant AND id=p_incident;IF NOT FOUND THEN RETURN NULL;END IF;
 IF i.purpose='worker_services' THEN
  SELECT s.actor_id,a.request_id,w.hub_id,w.worker_id INTO parent FROM public.work_signature_dispatch_starts s JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id WHERE s.academy_id=tenant AND s.id=i.start_id;
 ELSE
  SELECT s.actor_id,a.request_id,p.hub_id,NULL::uuid worker_id INTO parent FROM public.signature_dispatch_starts s JOIN public.signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.agreement_packages p ON p.academy_id=r.academy_id AND p.id=r.package_id WHERE s.academy_id=tenant AND s.id=i.start_id;
 END IF;
 IF parent.request_id IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('purpose',i.purpose,'startId',i.start_id,'requestId',parent.request_id,'hubId',parent.hub_id,'starterId',parent.actor_id,'workerId',parent.worker_id,'origin',i.origin_transaction::text,'retryVersion',i.retry_version,'attemptNo',i.attempt_no,'reasonCode',i.reason_code,'recordedAt',i.recorded_at);
END $$;
ALTER FUNCTION public.signature_check_context(uuid) OWNER TO kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.signature_check_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_check_context(uuid) TO kavosh_event_policy;
CREATE FUNCTION public.signature_check_audience(p_incident uuid) RETURNS TABLE(person_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH context AS MATERIALIZED(SELECT public.signature_check_context(p_incident) c)
 SELECT chain.person_id FROM context CROSS JOIN LATERAL public.supervisor_chain((c->>'starterId')::uuid) chain WHERE c IS NOT NULL
 UNION SELECT chain.person_id FROM context CROSS JOIN LATERAL public.supervisor_chain((c->>'workerId')::uuid) chain WHERE c->>'workerId' IS NOT NULL
 UNION SELECT master_person_id FROM public.academies WHERE id=nullif(current_setting('app.academy_id',true),'')::uuid AND EXISTS(SELECT 1 FROM context WHERE c IS NOT NULL)
$$;
ALTER FUNCTION public.signature_check_audience(uuid) OWNER TO kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.signature_check_audience(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_check_audience(uuid) TO kavosh_event_policy;
CREATE FUNCTION public.signature_check_notice_upper(p_incident uuid,p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT EXISTS(SELECT 1 FROM public.signature_check_audience(p_incident) WHERE person_id=p_actor) $$;
ALTER FUNCTION public.signature_check_notice_upper(uuid,uuid) OWNER TO kavosh_signature_completion_policy;
CREATE FUNCTION public.signature_check_notice_current(p_incident uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT j.state='blocked' AND j.retry_version=i.retry_version FROM public.signature_completion_incidents i JOIN public.signature_completion_jobs j ON j.academy_id=i.academy_id AND j.purpose=i.purpose AND j.start_id=i.start_id WHERE i.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND i.id=p_incident),false)
$$;
ALTER FUNCTION public.signature_check_notice_current(uuid) OWNER TO kavosh_signature_completion_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_completion_policy;

CREATE FUNCTION public.signature_check_notice_allows(p_incident uuid,scopes jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;i record;p record;t record;scope jsonb;class_scope jsonb;student_scope jsonb;signer_scope jsonb;cap text;file_id uuid;BEGIN
 SELECT purpose,start_id INTO i FROM public.signature_completion_incidents WHERE academy_id=tenant AND id=p_incident;IF NOT FOUND THEN RETURN false;END IF;
 IF i.purpose='worker_services' THEN
  SELECT w.hub_id,w.worker_id INTO p FROM public.work_signature_dispatch_starts s JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id WHERE s.academy_id=tenant AND s.id=i.start_id;
  RETURN coalesce(public.work_signature_notice_allows(i.start_id,scopes) AND public.work_scope_allows(scopes->'work-signature-completions.view',p.hub_id,p.worker_id),false);
 END IF;
 SELECT pkg.* INTO p FROM public.signature_dispatch_starts s JOIN public.signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.agreement_packages pkg ON pkg.academy_id=r.academy_id AND pkg.id=r.package_id WHERE s.academy_id=tenant AND s.id=i.start_id;
 IF p.id IS NULL THEN RETURN false;END IF;
 class_scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',p.class_id,'hubId',p.hub_id)));
 SELECT jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_agg(jsonb_build_object('id',x.id,'hubId',x.hub_id) ORDER BY x.id)) INTO scope FROM public.people x WHERE x.academy_id=tenant AND x.id=ANY(ARRAY[p.student_id,p.signer_id]);
 scope=scope||jsonb_build_object('classes',class_scope->'classes');
 FOREACH cap IN ARRAY ARRAY['signature-sends.view','signature-completions.view','signatures.view'] LOOP IF NOT coalesce(public.scope_contains(scopes->cap,scope),false) THEN RETURN false;END IF;END LOOP;
 IF NOT coalesce(public.scope_contains(scopes->'enrollments.view',class_scope),false) THEN RETURN false;END IF;
 SELECT jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',id,'hubId',hub_id))) INTO student_scope FROM public.people WHERE academy_id=tenant AND id=p.student_id AND kind='human';
 SELECT jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',id,'hubId',hub_id))) INTO signer_scope FROM public.people WHERE academy_id=tenant AND id=p.signer_id AND kind='human';
 IF student_scope IS NULL OR signer_scope IS NULL OR NOT coalesce(public.scope_contains(scopes->'students.view',student_scope),false) THEN RETURN false;END IF;
 IF p.student_id<>p.signer_id AND(NOT coalesce(public.scope_contains(scopes->'families.view',student_scope),false) OR NOT coalesce(public.scope_contains(scopes->'guardians.view',signer_scope),false)) THEN RETURN false;END IF;
 SELECT h.hub_id,r.definition INTO t FROM public.agreement_templates h JOIN public.agreement_template_revisions r ON r.academy_id=h.academy_id AND r.template_id=h.id AND r.version=h.version WHERE h.academy_id=tenant AND h.id=p.template_id;
 IF NOT FOUND OR t.definition->>'kind' IS DISTINCT FROM 'unified_enrollment' OR(t.hub_id IS NOT NULL AND t.hub_id<>p.hub_id) OR NOT coalesce(public.scope_contains(scopes->'agreements.view',CASE WHEN t.hub_id IS NULL THEN '{"all":true,"hubs":[]}'::jsonb ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(t.hub_id)) END),false) THEN RETURN false;END IF;
 IF t.hub_id IS NULL AND(jsonb_array_length(coalesce(scopes#>'{agreements.view,excludedAreas}','[]'::jsonb))>0 OR jsonb_array_length(coalesce(scopes#>'{agreements.view,excludedHubs}','[]'::jsonb))>0) THEN RETURN false;END IF;
 SELECT b.file_id INTO file_id FROM public.agreement_package_contents l JOIN public.agreement_content_bindings b ON b.academy_id=l.academy_id AND b.id=l.binding_id WHERE l.academy_id=tenant AND l.package_id=p.id;
 RETURN file_id IS NOT NULL AND public.approval_bindings_allow(jsonb_build_array(jsonb_build_object('fileId',file_id)),scopes);
END $$;
ALTER FUNCTION public.signature_check_notice_allows(uuid,jsonb) OWNER TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.signature_check_notice_allows(uuid,jsonb),public.signature_check_notice_current(uuid),public.signature_check_notice_upper(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_check_notice_allows(uuid,jsonb),public.signature_check_notice_current(uuid),public.signature_check_notice_upper(uuid,uuid) TO kavosh_runtime,kavosh_automation_worker,kavosh_message_worker,kavosh_message_policy,kavosh_automation_policy;

CREATE FUNCTION public.signature_check_projection(p_incident uuid,p_origin xid8) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE c jsonb:=public.signature_check_context(p_incident);BEGIN
 IF c IS NULL OR c->>'origin' IS DISTINCT FROM p_origin::text THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('eventType',CASE WHEN c->>'purpose'='worker_services' THEN 'work.signature.completion.check.blocked.critical' ELSE 'signature.completion.check.blocked.critical' END,'entityId',p_incident,'hubId',c->'hubId','actorId',NULL,'actorKind','system','severity','critical','occurredAt',to_char((c->>'recordedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',jsonb_build_object('incidentId',p_incident,'purpose',c->'purpose','requestId',c->'requestId','startId',c->'startId','retryVersion',c->'retryVersion','attemptNo',c->'attemptNo','reasonCode',c->'reasonCode','admissionCleared',false,'paymentCleared',false));
END $$;
CREATE FUNCTION public.signature_check_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p jsonb:=public.signature_check_projection(NEW.signature_completion_incident_id,NEW.origin_transaction);BEGIN
 IF current_user<>'kavosh_event_policy' OR NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id() OR p IS NULL OR NEW.projection IS DISTINCT FROM p OR NEW.event_id IS DISTINCT FROM NEW.signature_completion_incident_id OR NEW.source_version IS DISTINCT FROM(p#>>'{attributes,retryVersion}')::integer+1 OR NEW.event_type IS DISTINCT FROM p->>'eventType' OR NEW.hub_id::text IS DISTINCT FROM p->>'hubId' OR NEW.occurred_at IS DISTINCT FROM(p->>'occurredAt')::timestamptz OR NEW.audit_id IS NOT NULL OR NEW.approval_id IS NOT NULL THEN RAISE EXCEPTION 'SIGNATURE_CHECK_EVENT_EXACT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.signature_check_projection(uuid,xid8),public.signature_check_event_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_check_projection(uuid,xid8) TO kavosh_event_policy;
CREATE TRIGGER signature_check_event_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='signature_check') EXECUTE FUNCTION public.signature_check_event_guard();
CREATE FUNCTION public.capture_signature_check_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE prior text:=current_setting('app.academy_id',true);p jsonb;BEGIN
 PERFORM set_config('app.academy_id',NEW.academy_id::text,true);p=public.signature_check_projection(NEW.id,NEW.origin_transaction);
 IF NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id() OR p IS NULL THEN RAISE EXCEPTION 'SIGNATURE_CHECK_EVENT_ORIGIN_REQUIRED' USING ERRCODE='55000';END IF;
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,signature_completion_incident_id) VALUES(NEW.academy_id,NEW.id,NULL,NULL,'signature_check',NEW.retry_version+1,p->>'eventType',(p->>'hubId')::uuid,(p->>'occurredAt')::timestamptz,p,NEW.id);
 IF NOT FOUND THEN RAISE EXCEPTION 'SIGNATURE_CHECK_EVENT_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;PERFORM set_config('app.academy_id',coalesce(prior,''),true);RETURN NULL;
END $$;
ALTER FUNCTION public.capture_signature_check_event() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.capture_signature_check_event() FROM PUBLIC;
CREATE TRIGGER signature_check_event_capture AFTER INSERT ON public.signature_completion_incidents FOR EACH ROW EXECUTE FUNCTION public.capture_signature_check_event();
CREATE FUNCTION public.publish_signature_check_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE recipients uuid[];added integer;BEGIN
 SELECT array_agg(p.id ORDER BY p.id) INTO recipients FROM public.signature_check_audience(NEW.signature_completion_incident_id) a JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=a.person_id WHERE p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin) SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,id,0,'critical','Agreement check needs attention','Open the linked agreement check to review this failure. Reading this notice does not resolve it,resend an agreement or approve enrollment or payment.','en','mandatory' FROM unnest(recipients) id;
 GET DIAGNOSTICS added=ROW_COUNT;IF added<>coalesce(cardinality(recipients),0) THEN RAISE EXCEPTION 'SIGNATURE_CHECK_ALERT_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
ALTER FUNCTION public.publish_signature_check_alert() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.publish_signature_check_alert() FROM PUBLIC;
CREATE TRIGGER signature_check_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='signature_check') EXECUTE FUNCTION public.publish_signature_check_alert();
-- Portal floor is ready; custom/outbound delivery stays explicitly disabled
-- until its recipient,locking and last-moment source checks are installed.
CREATE FUNCTION public.guard_signature_check_custom_delivery() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='signature_check') THEN RAISE EXCEPTION 'SIGNATURE_CHECK_CUSTOM_DELIVERY_DISABLED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_signature_check_custom_delivery() FROM PUBLIC;
CREATE TRIGGER aa_signature_check_custom_delivery_guard BEFORE INSERT OR UPDATE ON public.notification_deliveries FOR EACH ROW EXECUTE FUNCTION public.guard_signature_check_custom_delivery();
CREATE TRIGGER aa_signature_check_custom_portal_guard BEFORE INSERT ON public.portal_notifications FOR EACH ROW WHEN(NEW.origin='automation') EXECUTE FUNCTION public.guard_signature_check_custom_delivery();
DO $$ DECLARE body text;needle text:='IF source.event_id IS NULL';BEGIN
 body=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);IF strpos(body,needle)=0 THEN RAISE EXCEPTION 'SIGNATURE_CHECK_MANDATORY_BOUNDARY_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF source.source_kind='signature_check' THEN
  IF source.projection->>'severity' IS DISTINCT FROM 'critical' OR NEW.locale<>'en' OR NEW.title IS DISTINCT FROM 'Agreement check needs attention' OR NEW.body IS DISTINCT FROM 'Open the linked agreement check to review this failure. Reading this notice does not resolve it,resend an agreement or approve enrollment or payment.' OR NOT EXISTS(SELECT 1 FROM public.signature_check_audience(source.signature_completion_incident_id) a JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=a.person_id WHERE p.id=NEW.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL) THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 394 $$;

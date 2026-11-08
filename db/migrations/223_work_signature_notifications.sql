-- No historical alert reconstruction. Existing observations retain UNKNOWN
-- origin;only future native insertions receive their real transaction identity.
UPDATE public.capability_catalog SET label='Send reviewed worker contracts and record own delivery observations' WHERE name='work-signatures.execute';
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['work_signature_transport_receipts','work_signature_transport_conflicts','work_signature_dispatch_outcomes'] LOOP
 EXECUTE format('ALTER TABLE public.%I ADD COLUMN origin_transaction xid8',t);
 EXECUTE format('ALTER TABLE public.%I ALTER COLUMN origin_transaction SET DEFAULT pg_current_xact_id()',t);
END LOOP;END $$;
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule','report_job','pay_statement','account_security','calendar_event','work_signature'));
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_operational_audit;
ALTER TABLE public.automation_event_sources ADD CONSTRAINT automation_event_operational_audit CHECK((source_kind IN('report_schedule','report_job','pay_statement','account_security','work_signature'))=(audit_id IS NULL));
ALTER TABLE public.automation_event_sources ADD work_signature_start_id uuid,ADD work_signature_notice_key text,
 ADD FOREIGN KEY(academy_id,work_signature_start_id) REFERENCES public.work_signature_dispatch_starts(academy_id,id),
 ADD CHECK((source_kind='work_signature' AND work_signature_start_id IS NOT NULL AND work_signature_notice_key IS NOT NULL AND(work_signature_notice_key IN('received','actor_conflict') OR work_signature_notice_key~'^service_conflict:[a-f0-9]{64}$')) OR(source_kind<>'work_signature' AND work_signature_start_id IS NULL AND work_signature_notice_key IS NULL)),
 ADD UNIQUE(academy_id,work_signature_start_id,work_signature_notice_key);
GRANT SELECT(academy_id,id,attempt_id,actor_id) ON public.work_signature_dispatch_starts TO kavosh_event_policy;
GRANT SELECT(academy_id,id,request_id) ON public.work_signature_send_attempts TO kavosh_event_policy;
GRANT SELECT(academy_id,id,preparation_id) ON public.work_signature_send_requests TO kavosh_event_policy;
GRANT SELECT(academy_id,id,worker_id,hub_id) ON public.work_agreement_preparations TO kavosh_event_policy;
GRANT SELECT(academy_id,start_id,state,document_id,received_at,origin_transaction) ON public.work_signature_transport_receipts TO kavosh_event_policy;
GRANT SELECT(academy_id,start_id,payload_fingerprint,state,document_id,received_at,origin_transaction) ON public.work_signature_transport_conflicts TO kavosh_event_policy;
GRANT SELECT(academy_id,start_id,state,document_id,created_at,origin_transaction) ON public.work_signature_dispatch_outcomes TO kavosh_event_policy;

CREATE FUNCTION public.work_signature_notice_projection(p_start uuid,p_key text,p_origin xid8) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;source record;service record;actor record;conflict record;kind text;at timestamptz;state text;severity text;BEGIN
 SELECT s.id,a.id attempt_id,r.id request_id,w.hub_id INTO source FROM public.work_signature_dispatch_starts s JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id WHERE s.academy_id=tenant AND s.id=p_start;
 IF source.id IS NULL OR p_origin IS NULL THEN RETURN NULL;END IF;
 SELECT x.start_id,x.state,x.document_id,x.received_at,x.origin_transaction INTO service FROM public.work_signature_transport_receipts x WHERE x.academy_id=tenant AND x.start_id=p_start;
 IF service.start_id IS NULL THEN RETURN NULL;END IF;
 IF p_key='received' THEN
  IF service.origin_transaction IS DISTINCT FROM p_origin THEN RETURN NULL;END IF;kind='work.signature.transport.received';at=service.received_at;state=service.state;severity=CASE WHEN state='accepted_for_processing' THEN 'normal' ELSE 'critical' END;
 ELSIF p_key='actor_conflict' THEN
  SELECT x.start_id,x.state,x.document_id,x.created_at,x.origin_transaction INTO actor FROM public.work_signature_dispatch_outcomes x WHERE x.academy_id=tenant AND x.start_id=p_start;
  IF actor.start_id IS NULL OR(actor.state IS NOT DISTINCT FROM service.state AND actor.document_id IS NOT DISTINCT FROM service.document_id) OR(service.origin_transaction IS DISTINCT FROM p_origin AND actor.origin_transaction IS DISTINCT FROM p_origin) THEN RETURN NULL;END IF;
  kind='work.signature.transport.actor_conflict.critical';at=greatest(service.received_at,actor.created_at);state=service.state;severity='critical';
 ELSIF p_key~'^service_conflict:[a-f0-9]{64}$' THEN
  SELECT x.start_id,x.state,x.document_id,x.received_at,x.origin_transaction INTO conflict FROM public.work_signature_transport_conflicts x WHERE x.academy_id=tenant AND x.start_id=p_start AND x.payload_fingerprint=substring(p_key FROM 18);
  IF conflict.start_id IS NULL OR conflict.origin_transaction IS DISTINCT FROM p_origin OR(conflict.state IS NOT DISTINCT FROM service.state AND conflict.document_id IS NOT DISTINCT FROM service.document_id) THEN RETURN NULL;END IF;
  kind='work.signature.transport.conflict.critical';at=conflict.received_at;state=conflict.state;severity='critical';
 ELSE RETURN NULL;END IF;
 RETURN jsonb_build_object('eventType',kind,'entityId',p_start,'hubId',source.hub_id,'actorId',NULL,'actorKind','system','severity',severity,'occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'attributes',jsonb_build_object('requestId',source.request_id,'attemptId',source.attempt_id,'startId',p_start,'state',state,'observationConflict',p_key<>'received','providerVerified',false,'signingComplete',false));
END $$;
CREATE FUNCTION public.work_signature_notice_allows(p_start uuid,p_scopes jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT public.work_scope_allows(p_scopes->'work-pay.view',engagement.hub_id,engagement.person_id) AND public.work_scope_allows(p_scopes->'work-signatures.view',engagement.hub_id,engagement.person_id)
  AND public.scope_contains(coalesce(p_scopes->'agreements.view','{"all":false,"hubs":[]}'::jsonb),CASE WHEN template.hub_id IS NULL THEN '{"all":true,"hubs":[]}'::jsonb ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(template.hub_id)) END)
  AND file.domain='work_private' AND file.work_engagement_id=engagement.id AND public.work_file_allows(file.id,p_scopes)
  FROM public.work_signature_dispatch_starts s JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id
  JOIN public.work_engagements engagement ON engagement.academy_id=w.academy_id AND engagement.id=w.engagement_id JOIN public.agreement_templates template ON template.academy_id=w.academy_id AND template.id=w.template_id JOIN public.work_agreement_contents binding ON binding.academy_id=r.academy_id AND binding.id=r.binding_id JOIN public.file_records file ON file.academy_id=binding.academy_id AND file.id=binding.file_id
  WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.id=p_start),false)
$$;
CREATE FUNCTION public.work_signature_notice_audience(p_start uuid) RETURNS TABLE(person_id uuid) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH source AS MATERIALIZED(SELECT s.actor_id,w.worker_id FROM public.work_signature_dispatch_starts s JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.id=p_start)
 SELECT chain.person_id FROM source CROSS JOIN LATERAL public.supervisor_chain(source.actor_id) chain
 UNION SELECT chain.person_id FROM source CROSS JOIN LATERAL public.supervisor_chain(source.worker_id) chain
 UNION SELECT master_person_id FROM public.academies WHERE id=nullif(current_setting('app.academy_id',true),'')::uuid AND EXISTS(SELECT 1 FROM source)
$$;
CREATE FUNCTION public.work_signature_notice_upper(p_start uuid,p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.work_signature_dispatch_starts s JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id
 WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.id=p_start AND(p_actor=(SELECT master_person_id FROM public.academies WHERE id=s.academy_id) OR public.is_supervisor(p_actor,s.actor_id) OR public.is_supervisor(p_actor,w.worker_id)))
$$;
CREATE FUNCTION public.work_signature_notice_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE projection jsonb:=public.work_signature_notice_projection(NEW.work_signature_start_id,NEW.work_signature_notice_key,NEW.origin_transaction);BEGIN
 IF current_user<>'kavosh_event_policy' OR NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id() OR projection IS NULL OR NEW.projection IS DISTINCT FROM projection OR NEW.event_type IS DISTINCT FROM projection->>'eventType' OR NEW.source_version<>1 OR NEW.hub_id::text IS DISTINCT FROM projection->>'hubId' OR NEW.occurred_at IS DISTINCT FROM(projection->>'occurredAt')::timestamptz
 OR NOT EXISTS(SELECT 1 FROM public.outbox_events WHERE academy_id=NEW.academy_id AND id=NEW.event_id AND entity_id=NEW.work_signature_start_id AND request_id=NEW.work_signature_start_id AND event_type=NEW.event_type AND created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'WORK_SIGNATURE_NOTICE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER work_signature_notice_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='work_signature') EXECUTE FUNCTION public.work_signature_notice_guard();
CREATE FUNCTION public.publish_work_signature_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE recipients uuid[];added integer;BEGIN
 SELECT array_agg(p.id ORDER BY p.id) INTO recipients FROM public.work_signature_notice_audience(NEW.work_signature_start_id) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin) SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,id,0,'critical','Contract delivery needs attention','Open the linked contract delivery record to review this issue. Reading this notice does not resolve it or confirm a completed signature.','en','mandatory' FROM unnest(recipients) id;
 GET DIAGNOSTICS added=ROW_COUNT;IF added<>coalesce(cardinality(recipients),0) THEN RAISE EXCEPTION 'WORK_SIGNATURE_ALERT_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
ALTER FUNCTION public.publish_work_signature_alert() OWNER TO kavosh_event_policy;
CREATE TRIGGER publish_work_signature_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='work_signature' AND NEW.projection->>'severity'='critical') EXECUTE FUNCTION public.publish_work_signature_alert();
CREATE FUNCTION public.capture_work_signature_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('app.academy_id',true);keys text[];key text;projection jsonb;event uuid;BEGIN
 IF NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'WORK_SIGNATURE_NOTICE_ORIGIN_REQUIRED' USING ERRCODE='55000';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':work-signature-transport:'||NEW.start_id::text,0));
 PERFORM set_config('app.academy_id',NEW.academy_id::text,true);
 IF TG_TABLE_NAME='work_signature_transport_receipts' THEN keys=ARRAY['received','actor_conflict'];ELSIF TG_TABLE_NAME='work_signature_transport_conflicts' THEN keys=ARRAY['service_conflict:'||NEW.payload_fingerprint];ELSE keys=ARRAY['actor_conflict'];END IF;
 FOREACH key IN ARRAY keys LOOP
  projection=public.work_signature_notice_projection(NEW.start_id,key,pg_current_xact_id());IF projection IS NULL THEN IF key='actor_conflict' THEN CONTINUE;END IF;RAISE EXCEPTION 'WORK_SIGNATURE_NOTICE_PROJECTION_REQUIRED' USING ERRCODE='55000';END IF;
  event=gen_random_uuid();INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(NEW.academy_id,event,projection->>'eventType',NEW.start_id,NEW.start_id);IF NOT FOUND THEN RAISE EXCEPTION 'WORK_SIGNATURE_NOTICE_EVENT_REQUIRED' USING ERRCODE='55000';END IF;
  INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,work_signature_start_id,work_signature_notice_key)
  VALUES(NEW.academy_id,event,NULL,NULL,'work_signature',1,projection->>'eventType',(projection->>'hubId')::uuid,(projection->>'occurredAt')::timestamptz,projection,NEW.start_id,key);
  IF NOT FOUND THEN RAISE EXCEPTION 'WORK_SIGNATURE_NOTICE_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;
 END LOOP;
 PERFORM set_config('app.academy_id',coalesce(prior,''),true);RETURN NULL;
END $$;
ALTER FUNCTION public.capture_work_signature_notice() OWNER TO kavosh_event_policy;
CREATE TRIGGER work_signature_notice_capture AFTER INSERT ON public.work_signature_transport_receipts FOR EACH ROW EXECUTE FUNCTION public.capture_work_signature_notice();
CREATE TRIGGER work_signature_notice_capture AFTER INSERT ON public.work_signature_transport_conflicts FOR EACH ROW EXECUTE FUNCTION public.capture_work_signature_notice();
CREATE TRIGGER work_signature_notice_capture AFTER INSERT ON public.work_signature_dispatch_outcomes FOR EACH ROW EXECUTE FUNCTION public.capture_work_signature_notice();
-- Preserve the original fixed recorder and actor-conflict lock identities and
-- privileges. Their new domain triggers own publication exactly once.
DO $$ DECLARE body text;emission text;kind text;BEGIN
 body=pg_get_functiondef('public.record_work_signature_transport_receipt(uuid,uuid,uuid,text,uuid)'::regprocedure);
 FOREACH kind IN ARRAY ARRAY['received','actor_conflict.critical','conflict.critical'] LOOP
  emission=format('INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),''work.signature.transport.%s'',p_start,p_start); IF NOT FOUND THEN RAISE EXCEPTION ''WORK_SIGNATURE_TRANSPORT_EVENT_REQUIRED'' USING ERRCODE=''55000'';END IF;',kind);
  IF position(emission IN body)=0 THEN RAISE EXCEPTION 'WORK_SIGNATURE_RECORDER_SOURCE_CHANGED';END IF;
  IF kind='conflict.critical' THEN emission='IF added=1 THEN '||emission||'END IF;';END IF;body=replace(body,emission,'');
 END LOOP;EXECUTE body;
 body=pg_get_functiondef('public.flag_work_signature_actor_transport_conflict()'::regprocedure);
 emission='IF EXISTS(SELECT 1 FROM public.work_signature_transport_receipts';IF position(emission IN body)=0 THEN RAISE EXCEPTION 'WORK_SIGNATURE_ACTOR_SOURCE_CHANGED';END IF;
 body=substring(body FROM 1 FOR position(emission IN body)-1)||'RETURN NEW;'||substring(body FROM position('END $function$' IN body));EXECUTE body;
 body=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);emission='IF NEW.event_type LIKE ''approval.%'' OR';IF position(emission IN body)=0 THEN RAISE EXCEPTION 'WORK_SIGNATURE_AUDIT_CAPTURE_SOURCE_CHANGED';END IF;EXECUTE replace(body,emission,'IF NEW.event_type LIKE ''work.signature.transport.%'' OR NEW.event_type LIKE ''approval.%'' OR');
 body=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);emission='IF source.event_id IS NULL';IF position(emission IN body)=0 THEN RAISE EXCEPTION 'WORK_SIGNATURE_MANDATORY_SOURCE_CHANGED';END IF;
 EXECUTE replace(body,emission,$branch$IF source.source_kind='work_signature' THEN
  IF source.projection->>'severity' IS DISTINCT FROM 'critical' OR NEW.locale<>'en' OR NEW.title IS DISTINCT FROM 'Contract delivery needs attention' OR NEW.body IS DISTINCT FROM 'Open the linked contract delivery record to review this issue. Reading this notice does not resolve it or confirm a completed signature.' OR NOT EXISTS(SELECT 1 FROM public.work_signature_notice_audience(source.work_signature_start_id) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id WHERE p.id=NEW.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL) THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);
END $$;
REVOKE ALL ON FUNCTION public.work_signature_notice_projection(uuid,text,xid8),public.work_signature_notice_allows(uuid,jsonb),public.work_signature_notice_audience(uuid),public.work_signature_notice_upper(uuid,uuid),public.work_signature_notice_guard(),public.publish_work_signature_alert(),public.capture_work_signature_notice() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_notice_projection(uuid,text,xid8),public.work_signature_notice_audience(uuid) TO kavosh_event_policy;
GRANT EXECUTE ON FUNCTION public.work_signature_notice_allows(uuid,jsonb),public.work_signature_notice_upper(uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 223 $$;

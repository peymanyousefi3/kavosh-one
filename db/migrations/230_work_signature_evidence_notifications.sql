-- Preserve UNKNOWN historical origins. Only future native observations can
-- produce a bound inbox event;never reconstruct an alert or signing date.
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['work_signature_completion_evidence','work_signature_evidence_inspections','work_signature_completion_review_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ADD COLUMN origin_transaction xid8',t);
 EXECUTE format('ALTER TABLE public.%I ALTER COLUMN origin_transaction SET DEFAULT pg_current_xact_id()',t);
END LOOP;END $$;
ALTER TABLE public.automation_event_sources ADD work_signature_evidence_id uuid,
 ADD FOREIGN KEY(academy_id,work_signature_evidence_id) REFERENCES public.work_signature_completion_evidence(academy_id,id);
DO $$ DECLARE names text[];BEGIN
 SELECT array_agg(conname::text) INTO names FROM pg_constraint WHERE conrelid='public.automation_event_sources'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%work_signature_notice_key%';
 IF cardinality(names) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'WORK_NOTICE_KEY_BOUNDARY_CHANGED';END IF;
 EXECUTE format('ALTER TABLE public.automation_event_sources DROP CONSTRAINT %I',names[1]);
END $$;
ALTER TABLE public.automation_event_sources ADD CONSTRAINT work_signature_notice_key_bound CHECK(
 (source_kind='work_signature' AND work_signature_start_id IS NOT NULL AND work_signature_notice_key IS NOT NULL AND(
  (work_signature_evidence_id IS NULL AND(work_signature_notice_key IN('received','actor_conflict') OR work_signature_notice_key~'^service_conflict:[a-f0-9]{64}$'))
  OR(work_signature_evidence_id IS NOT NULL AND(work_signature_notice_key='evidence:'||work_signature_evidence_id::text OR work_signature_notice_key~'^inspection:[a-f0-9-]{36}$' OR work_signature_notice_key~'^review:[a-f0-9-]{36}:[1-9][0-9]{0,9}$'))))
 OR(source_kind<>'work_signature' AND work_signature_start_id IS NULL AND work_signature_notice_key IS NULL AND work_signature_evidence_id IS NULL));

-- The event publisher receives a closed metadata projection,not private
-- manifests,hashes,signer contacts,download grants or review narratives.
GRANT SELECT(origin_transaction) ON public.work_signature_completion_evidence TO kavosh_signature_evidence_policy;
CREATE FUNCTION public.work_signature_evidence_notice_basis(p_evidence uuid,p_inspection uuid,p_review integer,p_origin xid8) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;e record;i record;r record;b jsonb;BEGIN
 IF p_origin IS NULL OR(p_inspection IS NOT NULL AND p_review IS NOT NULL) THEN RETURN NULL;END IF;
 SELECT id,start_id,state,recorded_at,origin_transaction INTO e FROM public.work_signature_completion_evidence WHERE academy_id=tenant AND id=p_evidence;IF e.id IS NULL THEN RETURN NULL;END IF;
 b=jsonb_build_object('evidenceId',e.id,'startId',e.start_id,'evidenceState',e.state,'actorId',NULL,'actorKind','system');
 IF p_inspection IS NOT NULL THEN
  SELECT id,kind,result->>'outcome' outcome,recorded_at,origin_transaction INTO i FROM public.work_signature_evidence_inspections WHERE academy_id=tenant AND id=p_inspection AND evidence_id=e.id;
  IF i.id IS NULL OR i.origin_transaction IS DISTINCT FROM p_origin THEN RETURN NULL;END IF;
  RETURN b||jsonb_build_object('phase','inspection','inspectionId',i.id,'inspectionKind',i.kind,'inspectionOutcome',i.outcome,'eventType',CASE WHEN i.outcome='screened' THEN 'work.signature.evidence.inspection.recorded' ELSE 'work.signature.evidence.inspection.critical' END,'recordedAt',i.recorded_at,'severity',CASE WHEN i.outcome='screened' THEN 'normal' ELSE 'critical' END);
 ELSIF p_review IS NOT NULL THEN
  SELECT version,definition,origin_transaction INTO r FROM public.work_signature_completion_review_revisions WHERE academy_id=tenant AND evidence_id=e.id AND version=p_review;
  IF r.version IS NULL OR r.origin_transaction IS DISTINCT FROM p_origin THEN RETURN NULL;END IF;
  RETURN b||jsonb_build_object('phase','review','reviewVersion',r.version,'decision',r.definition#>>'{input,decision}','actorId',r.definition->>'changed_by','actorKind','human','eventType','work.signature.completion.review','recordedAt',r.definition->>'changed_at','severity','critical');
 END IF;
 IF e.origin_transaction IS DISTINCT FROM p_origin THEN RETURN NULL;END IF;
 RETURN b||jsonb_build_object('phase','evidence','eventType','work.signature.completion.evidence.critical','recordedAt',e.recorded_at,'severity','critical');
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.work_signature_evidence_notice_basis(uuid,uuid,integer,xid8) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.work_signature_evidence_notice_basis(uuid,uuid,integer,xid8) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_evidence_notice_basis(uuid,uuid,integer,xid8) TO kavosh_event_policy;

CREATE FUNCTION public.work_signature_evidence_notice_projection(p_start uuid,p_key text,p_origin xid8) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;parent record;b jsonb;BEGIN
 IF p_key IN('received','actor_conflict') OR p_key~'^service_conflict:[a-f0-9]{64}$' THEN RETURN public.work_signature_notice_projection(p_start,p_key,p_origin);END IF;
 SELECT s.id,a.id attempt_id,r.id request_id,w.hub_id INTO parent FROM public.work_signature_dispatch_starts s JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id WHERE s.academy_id=tenant AND s.id=p_start;
 IF parent.id IS NULL THEN RETURN NULL;END IF;
 IF p_key~'^evidence:[a-f0-9-]{36}$' THEN b=public.work_signature_evidence_notice_basis(substring(p_key FROM 10)::uuid,NULL,NULL,p_origin);
 ELSIF p_key~'^inspection:[a-f0-9-]{36}$' THEN
  -- The inspection lookup is confined to the closed policy helper below.
  b=public.work_signature_inspection_notice_basis(substring(p_key FROM 12)::uuid,p_origin);
 ELSIF p_key~'^review:[a-f0-9-]{36}:[1-9][0-9]{0,9}$' THEN b=public.work_signature_evidence_notice_basis(split_part(p_key,':',2)::uuid,NULL,split_part(p_key,':',3)::integer,p_origin);
 ELSE RETURN NULL;END IF;
 IF b IS NULL OR b->>'startId' IS DISTINCT FROM p_start::text THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('eventType',b->>'eventType','entityId',b->>'evidenceId','hubId',parent.hub_id,'actorId',b->'actorId','actorKind',b->>'actorKind','severity',b->>'severity','occurredAt',to_char((b->>'recordedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'attributes',jsonb_build_object('requestId',parent.request_id,'attemptId',parent.attempt_id,'startId',p_start,'evidenceId',b->>'evidenceId','phase',b->>'phase','evidenceState',b->>'evidenceState','inspectionId',b->'inspectionId','inspectionKind',b->'inspectionKind','inspectionOutcome',b->'inspectionOutcome','reviewVersion',b->'reviewVersion','decision',b->'decision','providerVerified',false,'signedByBothPartiesVerified',false,'legallyEffective',false,'paymentCleared',false));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
CREATE FUNCTION public.work_signature_inspection_notice_basis(p_inspection uuid,p_origin xid8) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT public.work_signature_evidence_notice_basis(evidence_id,id,NULL,p_origin) FROM public.work_signature_evidence_inspections WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_inspection
$$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.work_signature_inspection_notice_basis(uuid,xid8) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.work_signature_inspection_notice_basis(uuid,xid8),public.work_signature_evidence_notice_projection(uuid,text,xid8) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_inspection_notice_basis(uuid,xid8),public.work_signature_evidence_notice_projection(uuid,text,xid8) TO kavosh_event_policy;

CREATE FUNCTION public.work_signature_evidence_notice_allows(p_start uuid,p_evidence uuid,p_scopes jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT public.work_signature_notice_allows(p_start,p_scopes) AND(p_evidence IS NULL OR EXISTS(SELECT 1 FROM public.work_signature_completion_evidence e JOIN public.work_signature_dispatch_starts s ON s.academy_id=e.academy_id AND s.id=e.start_id JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.id=p_evidence AND s.id=p_start AND public.work_scope_allows(p_scopes->'work-signature-completions.view',w.hub_id,w.worker_id)))
$$;
REVOKE ALL ON FUNCTION public.work_signature_evidence_notice_allows(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_evidence_notice_allows(uuid,uuid,jsonb) TO kavosh_runtime;

GRANT SELECT(academy_id,event_id,work_signature_evidence_id,work_signature_notice_key,source_version) ON public.automation_event_sources TO kavosh_signature_evidence_policy;
CREATE FUNCTION public.work_signature_evidence_notice_state(p_event uuid) RETURNS TABLE(current_version integer,current_status text,source_current boolean)
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;event record;e record;r record;inspection record;observed record;original boolean;detected boolean;BEGIN
 SELECT work_signature_evidence_id evidence_id,work_signature_notice_key key,source_version INTO event FROM public.automation_event_sources WHERE academy_id=tenant AND event_id=p_event AND work_signature_evidence_id IS NOT NULL;IF NOT FOUND THEN RETURN;END IF;
 SELECT id,state INTO e FROM public.work_signature_completion_evidence WHERE academy_id=tenant AND id=event.evidence_id;IF e.id IS NULL THEN RETURN;END IF;
 original=coalesce(public.work_signature_completion_source_current(e.id),false);
 IF event.key LIKE 'review:%' THEN
  SELECT version,input,source,requested_by INTO r FROM public.work_signature_completion_reviews WHERE academy_id=tenant AND evidence_id=e.id;
  RETURN QUERY SELECT r.version,r.input->>'decision',coalesce(original AND r.version=event.source_version AND r.source-'scope' IS NOT DISTINCT FROM public.work_signature_completion_review_source(e.id,r.requested_by,r.input)-'scope',false);
 ELSIF event.key LIKE 'inspection:%' THEN
  SELECT id,kind,source,result->>'outcome' outcome INTO observed FROM public.work_signature_evidence_inspections WHERE academy_id=tenant AND evidence_id=e.id AND id=substring(event.key FROM 12)::uuid;IF NOT FOUND THEN RETURN;END IF;
  SELECT id,result->>'outcome' outcome INTO inspection FROM public.work_signature_evidence_inspections WHERE academy_id=tenant AND evidence_id=e.id AND kind=observed.kind ORDER BY recorded_at DESC,id DESC LIMIT 1;
  SELECT EXISTS(SELECT 1 FROM public.work_signature_evidence_inspections x WHERE x.academy_id=tenant AND x.source->>'storageTargetId'=observed.source->>'storageTargetId' AND x.source->>'artifactId'=observed.source->>'artifactId' AND x.result->>'outcome'='detected') INTO detected;
  -- The SAME physical-artifact safety boundary as private attachment serving:
  -- a later clean observation never turns a known finding into a clean status.
  RETURN QUERY SELECT 1,CASE WHEN detected THEN 'detected' ELSE inspection.outcome END,original AND((detected AND observed.outcome='detected') OR(NOT detected AND inspection.id=observed.id));
 ELSE RETURN QUERY SELECT 1,e.state,original;END IF;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.work_signature_evidence_notice_state(uuid) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.work_signature_evidence_notice_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_evidence_notice_state(uuid) TO kavosh_runtime;

CREATE OR REPLACE FUNCTION public.work_signature_notice_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE projection jsonb:=public.work_signature_evidence_notice_projection(NEW.work_signature_start_id,NEW.work_signature_notice_key,NEW.origin_transaction);phase text:=projection#>>'{attributes,phase}';BEGIN
 IF current_user<>'kavosh_event_policy' OR NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id() OR projection IS NULL OR NEW.projection IS DISTINCT FROM projection OR NEW.event_type IS DISTINCT FROM projection->>'eventType'
 OR NEW.work_signature_evidence_id::text IS DISTINCT FROM projection#>>'{attributes,evidenceId}' OR NEW.source_version<>coalesce((projection#>>'{attributes,reviewVersion}')::integer,1)
 OR NEW.hub_id::text IS DISTINCT FROM projection->>'hubId' OR NEW.occurred_at IS DISTINCT FROM(projection->>'occurredAt')::timestamptz
 OR NOT EXISTS(SELECT 1 FROM public.outbox_events o WHERE o.academy_id=NEW.academy_id AND o.id=NEW.event_id AND o.entity_id=(projection->>'entityId')::uuid AND o.event_type=NEW.event_type AND o.created_at=transaction_timestamp() AND CASE
  WHEN phase='inspection' THEN o.request_id=(projection#>>'{attributes,inspectionId}')::uuid
  WHEN phase='review' THEN EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=o.academy_id AND a.request_id=o.request_id AND a.entity_id=o.entity_id AND a.action=o.event_type AND a.created_at=transaction_timestamp() AND a.changes->>'version'=projection#>>'{attributes,reviewVersion}')
  ELSE o.request_id=NEW.work_signature_start_id END) THEN RAISE EXCEPTION 'WORK_SIGNATURE_NOTICE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;

CREATE FUNCTION public.capture_work_signature_evidence_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prior text:=current_setting('app.academy_id',true);b jsonb;key text;projection jsonb;v text;BEGIN
 PERFORM set_config('app.academy_id',NEW.academy_id::text,true);
 IF NEW.event_type='work.signature.completion.evidence.critical' THEN key='evidence:'||NEW.entity_id::text;b=public.work_signature_evidence_notice_basis(NEW.entity_id,NULL,NULL,pg_current_xact_id());
 ELSIF NEW.event_type IN('work.signature.evidence.inspection.recorded','work.signature.evidence.inspection.critical') THEN key='inspection:'||NEW.request_id::text;b=public.work_signature_inspection_notice_basis(NEW.request_id,pg_current_xact_id());
 ELSE
  SELECT a.changes->>'version' INTO STRICT v FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.request_id=NEW.request_id AND a.entity_id=NEW.entity_id AND a.action=NEW.event_type AND a.created_at=transaction_timestamp();
  key='review:'||NEW.entity_id::text||':'||v;b=public.work_signature_evidence_notice_basis(NEW.entity_id,NULL,v::integer,pg_current_xact_id());
 END IF;
 IF b IS NULL OR NEW.entity_id::text IS DISTINCT FROM b->>'evidenceId' OR NEW.event_type IS DISTINCT FROM b->>'eventType' THEN RAISE EXCEPTION 'WORK_EVIDENCE_NOTICE_ORIGINAL_RECORD_REQUIRED' USING ERRCODE='55000';END IF;
 projection=public.work_signature_evidence_notice_projection((b->>'startId')::uuid,key,pg_current_xact_id());
 IF projection IS NULL THEN RAISE EXCEPTION 'WORK_EVIDENCE_NOTICE_PROJECTION_REQUIRED' USING ERRCODE='55000';END IF;
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,work_signature_start_id,work_signature_notice_key,work_signature_evidence_id)
 VALUES(NEW.academy_id,NEW.id,NULL,NULL,'work_signature',coalesce((b->>'reviewVersion')::integer,1),NEW.event_type,(projection->>'hubId')::uuid,(projection->>'occurredAt')::timestamptz,projection,(b->>'startId')::uuid,key,NEW.entity_id);
 IF NOT FOUND THEN RAISE EXCEPTION 'WORK_EVIDENCE_NOTICE_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;
 PERFORM set_config('app.academy_id',coalesce(prior,''),true);RETURN NULL;
END $$;
ALTER FUNCTION public.capture_work_signature_evidence_notice() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.capture_work_signature_evidence_notice() FROM PUBLIC;
CREATE TRIGGER work_signature_evidence_notice_capture AFTER INSERT ON public.outbox_events FOR EACH ROW WHEN(NEW.event_type IN('work.signature.completion.evidence.critical','work.signature.evidence.inspection.recorded','work.signature.evidence.inspection.critical','work.signature.completion.review')) EXECUTE FUNCTION public.capture_work_signature_evidence_notice();

-- Existing generic audit capture must not duplicate a domain-bound source.
-- Preserve existing function identities/ACLs and exact old transport labels.
DO $$ DECLARE d text;needle text;BEGIN
 d=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);needle='IF NEW.event_type LIKE ''work.signature.transport.%'' OR';
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'WORK_EVIDENCE_GENERIC_CAPTURE_CHANGED';END IF;
 EXECUTE replace(d,needle,'IF NEW.event_type LIKE ''work.signature.completion.%'' OR NEW.event_type LIKE ''work.signature.evidence.inspection.%'' OR NEW.event_type LIKE ''work.signature.transport.%'' OR');
 d=pg_get_functiondef('public.publish_work_signature_alert()'::regprocedure);needle='''Contract delivery needs attention'',''Open the linked contract delivery record to review this issue. Reading this notice does not resolve it or confirm a completed signature.''';
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'WORK_EVIDENCE_PUBLISHER_CHANGED';END IF;
 EXECUTE replace(d,needle,'CASE WHEN NEW.work_signature_evidence_id IS NULL THEN ''Contract delivery needs attention'' ELSE ''Contract evidence updated'' END,CASE WHEN NEW.work_signature_evidence_id IS NULL THEN ''Open the linked contract delivery record to review this issue. Reading this notice does not resolve it or confirm a completed signature.'' ELSE ''Open the linked contract evidence record to review this change. Reading this notice does not approve evidence,certify signatures or clear payment.'' END');
 d=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);needle='NEW.title IS DISTINCT FROM ''Contract delivery needs attention'' OR NEW.body IS DISTINCT FROM ''Open the linked contract delivery record to review this issue. Reading this notice does not resolve it or confirm a completed signature.''';
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'WORK_EVIDENCE_MANDATORY_GUARD_CHANGED';END IF;
 EXECUTE replace(d,needle,'NEW.title IS DISTINCT FROM (CASE WHEN source.work_signature_evidence_id IS NULL THEN ''Contract delivery needs attention'' ELSE ''Contract evidence updated'' END) OR NEW.body IS DISTINCT FROM (CASE WHEN source.work_signature_evidence_id IS NULL THEN ''Open the linked contract delivery record to review this issue. Reading this notice does not resolve it or confirm a completed signature.'' ELSE ''Open the linked contract evidence record to review this change. Reading this notice does not approve evidence,certify signatures or clear payment.'' END)');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 230 $$;

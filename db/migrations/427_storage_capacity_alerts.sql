-- Alerts measure durable upload reservations,not provider usage or billing.
-- Existing media,quota history and provider originals are never discarded.
-- A distinct source kind keeps old,closed source allowlists fail-closed during
-- rolling upgrades. It must not fall back to their generic audit permissions.
DO $$ DECLARE expression text;BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='public.automation_event_sources'::regclass AND conname='automation_event_sources_source_kind_check';IF expression IS NULL THEN RAISE EXCEPTION 'STORAGE_CAPACITY_SOURCE_KINDS_CHANGED';END IF;
 ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;EXECUTE 'ALTER TABLE public.automation_event_sources ADD CONSTRAINT automation_event_sources_source_kind_check CHECK(('||expression||') OR source_kind=''storage_capacity'')';
END $$;
CREATE TABLE public.storage_capacity_policies(academy_id uuid PRIMARY KEY REFERENCES public.academies(id),version integer NOT NULL DEFAULT 1 CHECK(version>0));
CREATE TABLE public.storage_capacity_policy_revisions(
 academy_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~U&'[\0001-\001F\007F-\009F]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id) REFERENCES public.storage_capacity_policies(academy_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.storage_capacity_policies ADD FOREIGN KEY(academy_id,version) REFERENCES public.storage_capacity_policy_revisions(academy_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.storage_capacity_observations(
 academy_id uuid NOT NULL REFERENCES public.academies(id),version integer NOT NULL CHECK(version>0),snapshot jsonb NOT NULL,source_event_id uuid NOT NULL,audit_id uuid NOT NULL,event_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,version),UNIQUE(academy_id,event_id),UNIQUE(academy_id,audit_id),UNIQUE(academy_id,source_event_id),
 FOREIGN KEY(academy_id,source_event_id) REFERENCES public.outbox_events(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(academy_id,event_id) REFERENCES public.outbox_events(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['storage_capacity_policies','storage_capacity_policy_revisions','storage_capacity_observations'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY storage_capacity_no_unrelated_worker ON public.%I AS RESTRICTIVE TO kavosh_runtime USING(NOT pg_has_role(current_user,''kavosh_automation_worker'',''member'') AND NOT pg_has_role(current_user,''kavosh_message_worker'',''member'')) WITH CHECK(NOT pg_has_role(current_user,''kavosh_automation_worker'',''member'') AND NOT pg_has_role(current_user,''kavosh_message_worker'',''member''))',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate()',t);
END LOOP;END $$;
GRANT SELECT ON public.storage_capacity_policies,public.storage_capacity_policy_revisions,public.storage_capacity_observations TO kavosh_runtime,kavosh_event_policy;
GRANT INSERT(academy_id),UPDATE(version) ON public.storage_capacity_policies TO kavosh_runtime;
GRANT INSERT(academy_id,version,definition,changed_by,approval_id,reason) ON public.storage_capacity_policy_revisions TO kavosh_runtime;
GRANT SELECT ON public.file_storage_policies TO kavosh_event_policy;
-- PostgreSQL row locks require an UPDATE privilege. Grant only the immutable
-- school key,then forbid actual writes to it;quota-counter writes stay denied.
GRANT UPDATE(academy_id) ON public.file_storage_policies TO kavosh_event_policy;
GRANT INSERT ON public.storage_capacity_observations TO kavosh_event_policy;
GRANT UPDATE(academy_id) ON public.storage_capacity_policies TO kavosh_event_policy;
GRANT INSERT(academy_id,id,actor_id,session_id,credential_id,actor_kind,request_id,action,entity_id,hub_id,changes) ON public.audit_events TO kavosh_event_policy;
GRANT INSERT(academy_id,id,event_type,entity_id,request_id) ON public.outbox_events TO kavosh_event_policy;
CREATE FUNCTION public.storage_capacity_definition_valid(d jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_typeof(d)='object' AND d?&ARRAY['enabled','warningPercent','criticalPercent'] AND d-ARRAY['enabled','warningPercent','criticalPercent']='{}'::jsonb AND jsonb_typeof(d->'enabled')='boolean' AND jsonb_typeof(d->'warningPercent')='number' AND jsonb_typeof(d->'criticalPercent')='number' AND d->>'warningPercent'~'^[1-9][0-9]?$' AND d->>'criticalPercent'~'^([2-9]|[1-9][0-9]|100)$' AND(d->>'warningPercent')::numeric<(d->>'criticalPercent')::numeric,false)
$$;
ALTER TABLE public.storage_capacity_policy_revisions ADD CHECK(public.storage_capacity_definition_valid(definition));
CREATE FUNCTION public.storage_capacity_policy_basis(v integer) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',v,'definition',(SELECT definition FROM public.storage_capacity_policy_revisions WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND version=v),'quotaPolicyVersion',coalesce((SELECT version FROM public.file_storage_policies WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid),0))
$$;
CREATE FUNCTION public.storage_capacity_level(b bigint,f integer,mb bigint,mf integer,d jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN mb IS NULL THEN 'unconfigured' WHEN NOT(d->>'enabled')::boolean THEN 'disabled' WHEN b::numeric*100>=mb::numeric*(d->>'criticalPercent')::integer OR f::numeric*100>=mf::numeric*(d->>'criticalPercent')::integer THEN 'critical' WHEN b::numeric*100>=mb::numeric*(d->>'warningPercent')::integer OR f::numeric*100>=mf::numeric*(d->>'warningPercent')::integer THEN 'warning' ELSE 'normal' END
$$;
CREATE FUNCTION public.storage_capacity_status() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH source AS(SELECT nullif(current_setting('app.academy_id',true),'')::uuid tenant),limits AS(SELECT p.*,coalesce(h.version,0) alert_version,coalesce(r.definition,'{"enabled":true,"warningPercent":80,"criticalPercent":95}'::jsonb) alert_definition FROM source LEFT JOIN public.file_storage_policies p ON p.academy_id=source.tenant LEFT JOIN public.storage_capacity_policies h ON h.academy_id=source.tenant LEFT JOIN public.storage_capacity_policy_revisions r ON r.academy_id=h.academy_id AND r.version=h.version)
 SELECT jsonb_build_object('academyId',source.tenant,'configured',l.academy_id IS NOT NULL,'quotaPolicyVersion',coalesce(l.version,0),'alertPolicyVersion',l.alert_version,'definition',l.alert_definition,'thresholdSource',CASE WHEN l.alert_version=0 THEN 'default_preset' ELSE 'reviewed_configuration' END,'uploadsEnabled',l.uploads_enabled,'level',public.storage_capacity_level(l.reserved_bytes,l.reserved_files,l.maximum_reserved_bytes,l.maximum_files,l.alert_definition),'reservedBytes',l.reserved_bytes::text,'maximumReservedBytes',l.maximum_reserved_bytes::text,'reservedFiles',l.reserved_files::text,'maximumFiles',l.maximum_files::text,'bytePercent',round(l.reserved_bytes::numeric*100/l.maximum_reserved_bytes,2)::text,'filePercent',round(l.reserved_files::numeric*100/l.maximum_files,2)::text,'observationVersion',coalesce((SELECT max(version) FROM public.storage_capacity_observations WHERE academy_id=source.tenant),0),'usageBasis','reserved_claims','physicalStorageVerified',false,'automaticStoragePurchase',false) FROM source CROSS JOIN limits l
$$;
CREATE FUNCTION public.storage_capacity_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;BEGIN
 IF TG_TABLE_NAME='storage_capacity_policies' THEN
  PERFORM 1 FROM public.file_storage_policies WHERE academy_id=NEW.academy_id FOR UPDATE;PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,427));
  IF TG_OP='INSERT' THEN IF NEW.version<>1 THEN RAISE EXCEPTION 'STORAGE_CAPACITY_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
  ELSE IF NEW.academy_id IS DISTINCT FROM OLD.academy_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'STORAGE_CAPACITY_VERSION_REQUIRED' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'STORAGE_CAPACITY_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR p.action IS DISTINCT FROM 'storage.capacity-alerts.set' OR p.target_id IS DISTINCT FROM NEW.academy_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'storage.view' OR p.scope IS DISTINCT FROM '{"all":true,"hubs":[]}'::jsonb OR p.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'definition',NEW.definition,'reason',NEW.reason) OR p.review_context IS DISTINCT FROM public.storage_capacity_policy_basis(NEW.version-1) OR NOT EXISTS(SELECT 1 FROM public.storage_capacity_policies WHERE academy_id=NEW.academy_id AND version=NEW.version) OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'STORAGE_CAPACITY_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER storage_capacity_head_guard BEFORE INSERT OR UPDATE ON public.storage_capacity_policies FOR EACH ROW EXECUTE FUNCTION public.storage_capacity_policy_guard();
CREATE TRIGGER storage_capacity_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.storage_capacity_policy_revisions FOR EACH ROW EXECUTE FUNCTION public.storage_capacity_policy_guard();
CREATE TRIGGER storage_capacity_quota_identity_guard BEFORE UPDATE OF academy_id ON public.file_storage_policies FOR EACH ROW EXECUTE FUNCTION public.storage_capacity_policy_guard();
CREATE FUNCTION public.verify_storage_capacity_policy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE p record;r record;BEGIN
 IF TG_TABLE_NAME='approval_requests' THEN IF NEW.action<>'storage.capacity-alerts.set' OR NEW.status<>'applied' THEN RETURN NULL;END IF;END IF;
 SELECT v.* INTO r FROM public.storage_capacity_policies h JOIN public.storage_capacity_policy_revisions v ON v.academy_id=h.academy_id AND v.version=h.version WHERE h.academy_id=NEW.academy_id;
 SELECT id,status,reviewer_id INTO p FROM public.approval_requests WHERE academy_id=r.academy_id AND id=r.approval_id;
 IF r.version IS NULL OR p.status IS DISTINCT FROM 'applied' OR p.reviewer_id IS DISTINCT FROM r.changed_by OR NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.automation_event_sources e ON e.academy_id=a.academy_id AND e.audit_id=a.id JOIN public.outbox_events o ON o.academy_id=e.academy_id AND o.id=e.event_id AND o.request_id=a.request_id WHERE a.academy_id=r.academy_id AND a.actor_id=r.changed_by AND a.action='storage.capacity-alerts.changed' AND a.entity_id=r.academy_id AND a.changes=jsonb_build_object('approvalId',p.id,'version',r.version,'severity','critical') AND e.event_type=a.action AND o.event_type=a.action AND o.entity_id=a.entity_id) THEN RAISE EXCEPTION 'STORAGE_CAPACITY_POLICY_EFFECT_REQUIRED' USING ERRCODE='XX000';END IF;
 IF TG_TABLE_NAME='approval_requests' THEN IF p.id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'STORAGE_CAPACITY_POLICY_EFFECT_REQUIRED' USING ERRCODE='XX000';END IF;END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER storage_capacity_policy_complete AFTER INSERT OR UPDATE ON public.storage_capacity_policies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.verify_storage_capacity_policy();
CREATE CONSTRAINT TRIGGER storage_capacity_approval_complete AFTER UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.verify_storage_capacity_policy();
CREATE FUNCTION public.storage_capacity_event_attributes(audit uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT snapshot FROM public.storage_capacity_observations WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND audit_id=audit
$$;
CREATE FUNCTION public.capture_storage_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE a record;s jsonb;previous record;v integer;audit uuid:=gen_random_uuid();event uuid:=gen_random_uuid();severity text;action text;added integer;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'STORAGE_CAPACITY_READ_COMMITTED_REQUIRED' USING ERRCODE='25000';END IF;
 PERFORM 1 FROM public.file_storage_policies WHERE academy_id=NEW.academy_id FOR UPDATE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,427));
 SELECT a0.* INTO a FROM public.automation_event_sources e JOIN public.audit_events a0 ON a0.academy_id=e.academy_id AND a0.id=e.audit_id WHERE e.academy_id=NEW.academy_id AND e.event_id=NEW.id AND a0.request_id=NEW.request_id AND a0.action=NEW.event_type AND a0.entity_id=NEW.entity_id AND a0.created_at=transaction_timestamp();
 IF a.id IS NULL THEN RAISE EXCEPTION 'STORAGE_CAPACITY_SOURCE_REQUIRED' USING ERRCODE='XX000';END IF;
 s=public.storage_capacity_status();SELECT * INTO previous FROM public.storage_capacity_observations WHERE academy_id=NEW.academy_id ORDER BY version DESC LIMIT 1;
 IF previous.version IS NULL AND s->>'level' IN('normal','disabled') OR previous.version IS NOT NULL AND((s->>'level'=previous.snapshot->>'level' AND s->'quotaPolicyVersion'=previous.snapshot->'quotaPolicyVersion' AND s->'alertPolicyVersion'=previous.snapshot->'alertPolicyVersion') OR s->>'level' IN('normal','disabled') AND s->>'level'=previous.snapshot->>'level') THEN RETURN NULL;END IF;
 v=coalesce(previous.version,0)+1;s=s||jsonb_build_object('observationVersion',v);severity=CASE WHEN s->>'level'='critical' THEN 'critical' ELSE 'normal' END;action='storage.capacity.'||(s->>'level');
 INSERT INTO public.storage_capacity_observations(academy_id,version,snapshot,source_event_id,audit_id,event_id) VALUES(NEW.academy_id,v,s,NEW.id,audit,event);GET DIAGNOSTICS added=ROW_COUNT;IF added<>1 THEN RAISE EXCEPTION 'STORAGE_CAPACITY_OBSERVATION_REQUIRED' USING ERRCODE='XX000';END IF;
 INSERT INTO public.audit_events(academy_id,id,actor_id,session_id,credential_id,actor_kind,request_id,action,entity_id,hub_id,changes) VALUES(NEW.academy_id,audit,a.actor_id,a.session_id,a.credential_id,a.actor_kind,a.request_id,action,NEW.academy_id,NULL,jsonb_build_object('observationVersion',v,'level',s->>'level','severity',severity));GET DIAGNOSTICS added=ROW_COUNT;IF added<>1 THEN RAISE EXCEPTION 'STORAGE_CAPACITY_AUDIT_REQUIRED' USING ERRCODE='XX000';END IF;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(NEW.academy_id,event,action,NEW.academy_id,a.request_id);GET DIAGNOSTICS added=ROW_COUNT;IF added<>1 THEN RAISE EXCEPTION 'STORAGE_CAPACITY_EVENT_REQUIRED' USING ERRCODE='XX000';END IF;RETURN NULL;
END $$;
CREATE TRIGGER z_capture_storage_capacity AFTER INSERT ON public.outbox_events FOR EACH ROW WHEN(NEW.event_type IN('file.upload.reserved','file.upload.link.issued','file.storage.policy.updated','storage.capacity-alerts.changed','file.storage.capacity.checked')) EXECUTE FUNCTION public.capture_storage_capacity();
-- Extend only new native capacity envelopes;legacy audit snapshots stay intact.
DO $$ DECLARE body text;needle text:='jsonb_build_object(''auditId'',a.id,''action'',a.action)';kind_needle text:='a.id,NULL,''audit'',1,NEW.event_type';BEGIN
 body=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'STORAGE_CAPACITY_AUDIT_PROJECTION_CHANGED';END IF;
 IF(length(body)-length(replace(body,kind_needle,'')))/length(kind_needle)<>1 THEN RAISE EXCEPTION 'STORAGE_CAPACITY_AUDIT_KIND_CHANGED';END IF;
 body=replace(body,kind_needle,'a.id,NULL,CASE WHEN a.action LIKE ''storage.capacity.%'' THEN ''storage_capacity'' ELSE ''audit'' END,1,NEW.event_type');
 EXECUTE replace(body,needle,'('||needle||'||CASE WHEN a.action LIKE ''storage.capacity.%'' THEN coalesce(public.storage_capacity_event_attributes(a.id),''{}''::jsonb) ELSE ''{}''::jsonb END)');
END $$;
CREATE FUNCTION public.storage_capacity_notice_current(event uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH current_status AS MATERIALIZED(SELECT public.storage_capacity_status() d)
 SELECT coalesce((SELECT o.version=(d->>'observationVersion')::integer AND o.snapshot->'quotaPolicyVersion'=d->'quotaPolicyVersion' AND o.snapshot->'alertPolicyVersion'=d->'alertPolicyVersion' AND o.snapshot->>'level'=d->>'level' FROM public.storage_capacity_observations o CROSS JOIN current_status WHERE o.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND o.event_id=event),false)
$$;
CREATE FUNCTION public.storage_capacity_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s record;BEGIN
 SELECT * INTO s FROM public.storage_capacity_observations WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND audit_id=NEW.audit_id;
 IF current_user<>'kavosh_event_policy' OR NEW.source_kind<>'storage_capacity' OR s.version IS NULL OR NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.source_version<>1 OR NEW.hub_id IS NOT NULL OR NEW.event_type IS DISTINCT FROM 'storage.capacity.'||(s.snapshot->>'level') OR NEW.projection->>'entityId' IS DISTINCT FROM NEW.academy_id::text OR NEW.projection->'attributes' IS DISTINCT FROM jsonb_build_object('auditId',NEW.audit_id,'action',NEW.event_type)||s.snapshot OR NEW.projection->>'severity' IS DISTINCT FROM (CASE WHEN s.snapshot->>'level'='critical' THEN 'critical' ELSE 'normal' END) THEN RAISE EXCEPTION 'STORAGE_CAPACITY_NATIVE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER storage_capacity_event_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='storage_capacity' OR NEW.event_type LIKE 'storage.capacity.%') EXECUTE FUNCTION public.storage_capacity_event_guard();
CREATE FUNCTION public.storage_capacity_notice_allows(event uuid,scopes jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.storage_capacity_observations WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND event_id=event) AND public.scope_contains(coalesce(scopes->'storage.view','{"all":false,"hubs":[]}'::jsonb),'{"all":true,"hubs":[]}'::jsonb)
$$;
CREATE FUNCTION public.lock_storage_capacity_source() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM 1 FROM public.file_storage_policies WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid FOR SHARE;
 PERFORM 1 FROM public.storage_capacity_policies WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid FOR SHARE;
END $$;
-- Keep the critical floor for every old mandatory source. Only the separately
-- guarded capacity source can issue a normal warning/recovery/disabled notice.
ALTER TABLE public.portal_notifications DROP CONSTRAINT notification_origin_reference;
ALTER TABLE public.portal_notifications ADD CONSTRAINT notification_origin_reference CHECK(
 (origin='automation' AND run_id IS NOT NULL AND rule_id IS NOT NULL) OR
 (origin='mandatory' AND run_id IS NULL AND rule_id IS NULL AND action_index=0 AND(severity='critical' OR(severity='normal' AND title='Storage capacity status changed' AND body='Review the current reserved upload budget. This notice does not measure cloud storage,discard files or purchase capacity.')))
);
CREATE FUNCTION public.publish_storage_capacity_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE expected integer;added integer;BEGIN
 SELECT count(*) INTO expected FROM public.academies a JOIN public.people p ON p.academy_id=a.id AND p.id=a.master_person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL WHERE a.id=NEW.academy_id;
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin)
 SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,p.id,0,NEW.projection->>'severity','Storage capacity status changed','Review the current reserved upload budget. This notice does not measure cloud storage,discard files or purchase capacity.','en','mandatory' FROM public.academies a JOIN public.people p ON p.academy_id=a.id AND p.id=a.master_person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL WHERE a.id=NEW.academy_id;
 GET DIAGNOSTICS added=ROW_COUNT;IF added<>expected THEN RAISE EXCEPTION 'STORAGE_CAPACITY_NOTICE_REQUIRED' USING ERRCODE='XX000';END IF;RETURN NULL;
END $$;
DO $$ DECLARE body text;needle text:='IF source.event_id IS NULL';BEGIN
 body=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'STORAGE_CAPACITY_NOTICE_GUARD_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF source.source_kind='storage_capacity' THEN
  IF NOT EXISTS(SELECT 1 FROM public.storage_capacity_observations o JOIN public.academies a ON a.id=o.academy_id JOIN public.people p ON p.academy_id=a.id AND p.id=a.master_person_id WHERE o.academy_id=NEW.academy_id AND o.event_id=NEW.event_id AND p.id=NEW.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL AND source.projection->'attributes' @> o.snapshot) OR NEW.severity IS DISTINCT FROM source.projection->>'severity' OR NEW.locale<>'en' OR NEW.title IS DISTINCT FROM 'Storage capacity status changed' OR NEW.body IS DISTINCT FROM 'Review the current reserved upload budget. This notice does not measure cloud storage,discard files or purchase capacity.' THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);
END $$;
CREATE TRIGGER publish_storage_capacity_notice AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='storage_capacity') EXECUTE FUNCTION public.publish_storage_capacity_notice();
CREATE FUNCTION public.verify_storage_capacity_observation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.automation_event_sources e ON e.academy_id=a.academy_id AND e.audit_id=a.id JOIN public.outbox_events o ON o.academy_id=e.academy_id AND o.id=e.event_id WHERE a.academy_id=NEW.academy_id AND a.id=NEW.audit_id AND e.event_id=NEW.event_id AND a.action='storage.capacity.'||(NEW.snapshot->>'level') AND e.projection->'attributes' @> NEW.snapshot AND o.event_type=a.action AND o.entity_id=NEW.academy_id) OR EXISTS(SELECT 1 FROM public.academies a JOIN public.people p ON p.academy_id=a.id AND p.id=a.master_person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL WHERE a.id=NEW.academy_id AND NOT EXISTS(SELECT 1 FROM public.portal_notifications n WHERE n.academy_id=NEW.academy_id AND n.event_id=NEW.event_id AND n.person_id=p.id AND n.origin='mandatory')) THEN RAISE EXCEPTION 'STORAGE_CAPACITY_EFFECT_REQUIRED' USING ERRCODE='XX000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER storage_capacity_observation_complete AFTER INSERT ON public.storage_capacity_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.verify_storage_capacity_observation();
CREATE FUNCTION public.guard_storage_capacity_delivery() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='storage_capacity') THEN RETURN NEW;END IF;
 PERFORM public.lock_storage_capacity_source();IF NOT public.storage_capacity_notice_current(NEW.event_id) THEN RAISE EXCEPTION 'STORAGE_CAPACITY_DELIVERY_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER storage_capacity_portal_current BEFORE INSERT ON public.portal_notifications FOR EACH ROW WHEN(NEW.origin='automation') EXECUTE FUNCTION public.guard_storage_capacity_delivery();
CREATE TRIGGER storage_capacity_outbound_current BEFORE INSERT ON public.notification_deliveries FOR EACH ROW EXECUTE FUNCTION public.guard_storage_capacity_delivery();
CREATE CONSTRAINT TRIGGER storage_capacity_run_current AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_storage_capacity_delivery();
CREATE CONSTRAINT TRIGGER storage_capacity_handoff_current AFTER UPDATE ON public.notification_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='sending') EXECUTE FUNCTION public.guard_storage_capacity_delivery();
DO $$ DECLARE body text;needle text:='IF e.source_kind=''image_processing'' THEN';BEGIN
 body=pg_get_functiondef('public.lock_notification_delivery_source(uuid,uuid)'::regprocedure);IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'STORAGE_CAPACITY_DELIVERY_LOCK_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF e.source_kind='storage_capacity' THEN
  PERFORM public.lock_storage_capacity_source();
 ELSIF e.source_kind='image_processing' THEN$branch$);
END $$;
CREATE TRIGGER storage_capacity_observation_immutable BEFORE UPDATE OR DELETE ON public.storage_capacity_observations FOR EACH ROW EXECUTE FUNCTION public.storage_capacity_policy_guard();
-- Source manifests prevent an older daemon from claiming and cancelling work
-- whose new source policy it cannot understand. Keep old signatures/OIDs/ACLs;
-- new daemons pass their compiled,closed source-kind allowlist explicitly.
CREATE FUNCTION public.notification_source_supported(school uuid,event uuid,supported_kinds text[]) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET app.academy_id='' AS $$ BEGIN
 IF school IS NULL OR event IS NULL OR coalesce(cardinality(supported_kinds),0) NOT BETWEEN 1 AND 64 OR array_position(supported_kinds,NULL) IS NOT NULL THEN RETURN false;END IF;
 -- Function-local SET restores the caller's tenant context,also on error.
 PERFORM set_config('app.academy_id',school::text,true);
 RETURN EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=school AND event_id=event AND source_kind=ANY(supported_kinds));
END $$;
DO $$ DECLARE body text;updated text;needle text;signature text;legacy text:='ARRAY[''image_processing'',''signature_check'',''approval'',''audit'',''session'',''report_schedule'',''report_job'',''pay_statement'',''account_security'',''calendar_event'',''work_signature'',''tuition_due'',''expense_due'',''payroll_due'',''counterparty_statement'',''statement_due'',''privacy_due'',''checkout'']::text[]';BEGIN
 body=pg_get_functiondef('public.claim_notification_job(uuid[])'::regprocedure);needle='j.academy_id=ANY(academies) AND';signature='FUNCTION public.claim_notification_job(academies uuid[])';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>2 OR(length(body)-length(replace(body,signature,'')))/length(signature)<>1 THEN RAISE EXCEPTION 'STORAGE_CAPACITY_JOB_CLAIMER_CHANGED';END IF;
 updated=replace(body,signature,'FUNCTION public.claim_notification_job(academies uuid[], supported_kinds text[])');
 EXECUTE replace(updated,needle,needle||' public.notification_source_supported(j.academy_id,j.event_id,supported_kinds) AND');
 EXECUTE replace(body,needle,needle||' public.notification_source_supported(j.academy_id,j.event_id,'||legacy||') AND');
 body=pg_get_functiondef('public.claim_notification_delivery(jsonb)'::regprocedure);needle='ON r.academy_id=q.academy_id AND';signature='FUNCTION public.claim_notification_delivery(routes jsonb)';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>2 OR(length(body)-length(replace(body,signature,'')))/length(signature)<>1 THEN RAISE EXCEPTION 'STORAGE_CAPACITY_DELIVERY_CLAIMER_CHANGED';END IF;
 updated=replace(body,signature,'FUNCTION public.claim_notification_delivery(routes jsonb, supported_kinds text[])');
 EXECUTE replace(updated,needle,needle||' public.notification_source_supported(q.academy_id,q.event_id,supported_kinds) AND');
 EXECUTE replace(body,needle,needle||' public.notification_source_supported(q.academy_id,q.event_id,'||legacy||') AND');
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_automation_policy,kavosh_message_policy;
ALTER FUNCTION public.claim_notification_job(uuid[],text[]) OWNER TO kavosh_automation_policy;
ALTER FUNCTION public.claim_notification_delivery(jsonb,text[]) OWNER TO kavosh_message_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_automation_policy,kavosh_message_policy;
REVOKE ALL ON FUNCTION public.notification_source_supported(uuid,uuid,text[]),public.claim_notification_job(uuid[],text[]),public.claim_notification_delivery(jsonb,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notification_source_supported(uuid,uuid,text[]) TO kavosh_automation_policy,kavosh_message_policy;
GRANT EXECUTE ON FUNCTION public.claim_notification_job(uuid[],text[]) TO kavosh_automation_worker;
GRANT EXECUTE ON FUNCTION public.claim_notification_delivery(jsonb,text[]) TO kavosh_message_worker;
GRANT CREATE ON SCHEMA public TO kavosh_event_policy,kavosh_runtime;
ALTER FUNCTION public.notification_source_supported(uuid,uuid,text[]) OWNER TO kavosh_runtime;
ALTER FUNCTION public.verify_storage_capacity_policy() OWNER TO kavosh_event_policy;
ALTER FUNCTION public.storage_capacity_event_attributes(uuid) OWNER TO kavosh_event_policy;
ALTER FUNCTION public.capture_storage_capacity() OWNER TO kavosh_event_policy;
ALTER FUNCTION public.storage_capacity_notice_current(uuid) OWNER TO kavosh_event_policy;
ALTER FUNCTION public.storage_capacity_notice_allows(uuid,jsonb) OWNER TO kavosh_runtime;
ALTER FUNCTION public.lock_storage_capacity_source() OWNER TO kavosh_event_policy;
ALTER FUNCTION public.publish_storage_capacity_notice() OWNER TO kavosh_event_policy;
ALTER FUNCTION public.verify_storage_capacity_observation() OWNER TO kavosh_event_policy;
ALTER FUNCTION public.guard_storage_capacity_delivery() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy,kavosh_runtime;
REVOKE ALL ON FUNCTION public.storage_capacity_definition_valid(jsonb),public.storage_capacity_policy_basis(integer),public.storage_capacity_level(bigint,integer,bigint,integer,jsonb),public.storage_capacity_status(),public.storage_capacity_policy_guard(),public.verify_storage_capacity_policy(),public.storage_capacity_event_attributes(uuid),public.capture_storage_capacity(),public.storage_capacity_notice_current(uuid),public.storage_capacity_notice_allows(uuid,jsonb),public.publish_storage_capacity_notice(),public.verify_storage_capacity_observation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.storage_capacity_definition_valid(jsonb),public.storage_capacity_policy_basis(integer),public.storage_capacity_level(bigint,integer,bigint,integer,jsonb),public.storage_capacity_status(),public.storage_capacity_policy_guard() TO kavosh_runtime,kavosh_event_policy;
GRANT EXECUTE ON FUNCTION public.storage_capacity_notice_current(uuid),public.storage_capacity_notice_allows(uuid,jsonb) TO kavosh_runtime,kavosh_message_worker,kavosh_message_policy;
REVOKE ALL ON FUNCTION public.lock_storage_capacity_source() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.storage_capacity_event_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_storage_capacity_delivery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_storage_capacity_source() TO kavosh_runtime,kavosh_message_worker,kavosh_message_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 427 $$;

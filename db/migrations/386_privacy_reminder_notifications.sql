-- Reuse reviewed rules,leased subscription scans and the durable notification
-- pipeline for operational privacy follow-up. No legal-deadline determination,
-- disclosure,erasure,contact data,provider calls or inferred recipients.
CREATE FUNCTION public.privacy_due_source(p_request uuid,p_days integer,p_basis text,p_scopes jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH base AS MATERIALIZED(SELECT public.privacy_reminder_assessment($1,$3,$2,$4) s),proof AS(
 SELECT s,jsonb_build_object('hubId',CASE WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s#>'{scope,people}') p WHERE p->>'hubId' IS NULL) AND(SELECT count(DISTINCT p->>'hubId') FROM jsonb_array_elements(s#>'{scope,people}') p)=1 THEN s#>>'{scope,people,0,hubId}' END) hub FROM base WHERE s->'eligible'='true'::jsonb)
 SELECT s||hub||jsonb_build_object('sourceStamp',encode(sha256(convert_to((s||hub)::text,'UTF8')),'hex')) FROM proof
$$;
CREATE FUNCTION public.privacy_due_public(s jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT s-ARRAY['scope','sourceStamp'] $$;
CREATE FUNCTION public.privacy_due_allows(p_request uuid,p_basis text,s jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT s IS NOT NULL AND public.privacy_reminder_assessment(p_request,p_basis,0,s) IS NOT NULL $$;
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.automation_rule_guard()'::regprocedure);needle='keys||ARRAY[''sessionReminder'',''sessionFollowUp'',''tuitionReminder'',''expenseReminder'',''payrollReminder'',''statementReminder'']';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PRIVACY_TIMER_KEYS_BASE_CHANGED';END IF;
 body=replace(body,needle,'keys||ARRAY[''sessionReminder'',''sessionFollowUp'',''tuitionReminder'',''expenseReminder'',''payrollReminder'',''statementReminder'',''privacyReminder'']');needle='a=d->''trigger'';';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PRIVACY_TIMER_RULE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF d ? 'privacyReminder' THEN
  a=d->'privacyReminder';IF d ?| ARRAY['sessionReminder','sessionFollowUp','tuitionReminder','expenseReminder','payrollReminder','statementReminder'] OR jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['daysFromTarget','basis']) OR a-ARRAY['daysFromTarget','basis']<>'{}'::jsonb OR jsonb_typeof(a->'daysFromTarget') IS DISTINCT FROM 'number' OR(a->>'daysFromTarget')::numeric<>trunc((a->>'daysFromTarget')::numeric) OR(a->>'daysFromTarget')::numeric NOT BETWEEN -365 AND 3650 OR jsonb_typeof(a->'basis') IS DISTINCT FROM 'string' OR a->>'basis' NOT IN('baseline','target') THEN RAISE EXCEPTION 'AUTOMATION_PRIVACY_REMINDER_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 a=d->'trigger';$branch$);
END $$;
CREATE TABLE public.privacy_reminder_scans(academy_id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,last_privacy_request_id uuid,PRIMARY KEY(academy_id,subscription_id),FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id));
CREATE TABLE public.privacy_reminder_occurrences(
 academy_id uuid NOT NULL,id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,rule_id uuid NOT NULL,rule_version integer NOT NULL,privacy_request_id uuid NOT NULL,
 days_from_target integer NOT NULL CHECK(days_from_target BETWEEN -365 AND 3650),basis text NOT NULL CHECK(basis IN('baseline','target')),request_id uuid NOT NULL,hub_id uuid,source jsonb NOT NULL,source_stamp text NOT NULL CHECK(source_stamp~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),UNIQUE(academy_id,rule_id,privacy_request_id,days_from_target,basis,source_stamp),FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id),FOREIGN KEY(academy_id,rule_id,rule_version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version),FOREIGN KEY(academy_id,privacy_request_id) REFERENCES public.privacy_requests(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),CHECK(octet_length(source::text)<=1048576));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['privacy_reminder_scans','privacy_reminder_occurrences'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate()',t);
END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE ON public.privacy_reminder_scans TO kavosh_automation_worker;
GRANT SELECT ON public.privacy_reminder_occurrences TO kavosh_runtime,kavosh_event_policy;
GRANT INSERT(academy_id,id,subscription_id,lease_token,rule_id,rule_version,privacy_request_id,days_from_target,basis,request_id) ON public.privacy_reminder_occurrences TO kavosh_automation_worker;
CREATE FUNCTION public.privacy_reminder_scan_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT pg_has_role(current_user,'kavosh_automation_worker','member') OR(TG_OP='UPDATE' AND ROW(NEW.academy_id,NEW.subscription_id) IS DISTINCT FROM ROW(OLD.academy_id,OLD.subscription_id)) OR NOT EXISTS(SELECT 1 FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'PRIVACY_SCAN_LEASE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER privacy_reminder_scan_guard BEFORE INSERT OR UPDATE ON public.privacy_reminder_scans FOR EACH ROW EXECUTE FUNCTION public.privacy_reminder_scan_guard();
CREATE FUNCTION public.privacy_reminder_occurrence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE sub record;d jsonb;rule_hub uuid;BEGIN
 IF TG_OP<>'INSERT' OR NOT pg_has_role(current_user,'kavosh_automation_worker','member') THEN RAISE EXCEPTION 'PRIVACY_REMINDER_PRIVATE_WORKER_REQUIRED' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));PERFORM id FROM public.privacy_requests WHERE academy_id=NEW.academy_id AND id=NEW.privacy_request_id FOR SHARE;
 SELECT * INTO sub FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND rule_id=NEW.rule_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp();
 SELECT v.definition,r.hub_id INTO d,rule_hub FROM public.automation_rules r JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version WHERE r.academy_id=NEW.academy_id AND r.id=NEW.rule_id AND r.version=NEW.rule_version;
 NEW.source=public.privacy_due_source(NEW.privacy_request_id,NEW.days_from_target,NEW.basis);NEW.source_stamp=NEW.source->>'sourceStamp';NEW.hub_id=(NEW.source->>'hubId')::uuid;NEW.created_at=clock_timestamp();
 IF sub.id IS NULL OR d IS NULL OR NEW.source IS NULL OR(rule_hub IS NOT NULL AND rule_hub IS DISTINCT FROM NEW.hub_id) OR d->'enabled' IS DISTINCT FROM 'true'::jsonb OR d#>>'{execution,mode}' IS DISTINCT FROM 'automatic' OR d#>>'{privacyReminder,daysFromTarget}' IS DISTINCT FROM NEW.days_from_target::text OR d#>>'{privacyReminder,basis}' IS DISTINCT FROM NEW.basis OR(d->>'startsAt' IS NOT NULL AND clock_timestamp()<(d->>'startsAt')::timestamptz) OR(d->>'endsAt' IS NOT NULL AND clock_timestamp()>(d->>'endsAt')::timestamptz) THEN RAISE EXCEPTION 'PRIVACY_REMINDER_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER privacy_reminder_occurrence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.privacy_reminder_occurrences FOR EACH ROW EXECUTE FUNCTION public.privacy_reminder_occurrence_guard();
DO $$ DECLARE expression text;BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='public.automation_event_sources'::regclass AND conname='automation_event_sources_source_kind_check';
 IF expression IS NULL THEN RAISE EXCEPTION 'PRIVACY_TIMER_SOURCE_ENUM_BASE_CHANGED';END IF;
 ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
 EXECUTE 'ALTER TABLE public.automation_event_sources ADD CONSTRAINT automation_event_sources_source_kind_check CHECK(('||expression||') OR source_kind=''privacy_due'')';
END $$;
ALTER TABLE public.automation_event_sources ADD privacy_reminder_id uuid,ADD FOREIGN KEY(academy_id,privacy_reminder_id) REFERENCES public.privacy_reminder_occurrences(academy_id,id),ADD UNIQUE(academy_id,privacy_reminder_id),ADD CHECK((source_kind='privacy_due')=(privacy_reminder_id IS NOT NULL));
CREATE FUNCTION public.privacy_reminder_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE timer record;watch record;a record;expected jsonb;BEGIN
 SELECT * INTO timer FROM public.privacy_reminder_occurrences WHERE academy_id=NEW.academy_id AND id=NEW.privacy_reminder_id;SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
 SELECT a0.* INTO a FROM public.audit_events a0 JOIN public.outbox_events o ON o.academy_id=a0.academy_id AND o.id=NEW.event_id AND o.request_id=a0.request_id AND o.entity_id=a0.entity_id AND o.event_type=a0.action AND o.created_at=transaction_timestamp() WHERE a0.academy_id=NEW.academy_id AND a0.id=NEW.audit_id AND a0.request_id=timer.request_id AND a0.action='privacy.reminder_due' AND a0.entity_id=timer.privacy_request_id AND a0.created_at=transaction_timestamp();
 expected=public.privacy_due_public(timer.source)||jsonb_build_object('hubId',timer.hub_id,'reminder',jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id));
 IF current_user<>'kavosh_event_policy' OR timer.id IS NULL OR a.id IS NULL OR watch.id IS NULL OR NEW.event_type<>'privacy.reminder_due' OR NEW.source_version<>1 OR NEW.approval_id IS NOT NULL OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id OR a.changes->>'reminderReceiptId' IS DISTINCT FROM timer.id::text OR NEW.hub_id IS DISTINCT FROM timer.hub_id OR a.hub_id IS DISTINCT FROM timer.hub_id OR NEW.occurred_at<transaction_timestamp() OR NEW.occurred_at>clock_timestamp() OR NEW.projection IS DISTINCT FROM jsonb_build_object('eventType',NEW.event_type,'entityId',timer.privacy_request_id,'hubId',NEW.hub_id,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity','normal','occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',expected) THEN RAISE EXCEPTION 'PRIVACY_REMINDER_EXACT_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER privacy_reminder_event_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='privacy_due') EXECUTE FUNCTION public.privacy_reminder_event_guard();
DO $$ DECLARE body text;needle text:='IF NEW.event_type=''payroll.reminder_due'' THEN';BEGIN
 body=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PRIVACY_REMINDER_CAPTURE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF NEW.event_type='privacy.reminder_due' THEN
  SELECT * INTO timer FROM public.privacy_reminder_occurrences WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND privacy_request_id=NEW.entity_id;SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
  IF timer.id IS NULL OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id OR a.changes->>'reminderReceiptId' IS DISTINCT FROM timer.id::text THEN RETURN NULL;END IF;
  source=public.privacy_due_public(timer.source)||jsonb_build_object('hubId',timer.hub_id,'reminder',jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id));
  INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,privacy_reminder_id) VALUES(NEW.academy_id,NEW.id,a.id,NULL,'privacy_due',1,NEW.event_type,timer.hub_id,at,jsonb_build_object('eventType',NEW.event_type,'entityId',NEW.entity_id,'hubId',timer.hub_id,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity','normal','occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',source),timer.id);
 ELSIF NEW.event_type='payroll.reminder_due' THEN$branch$);
END $$;
CREATE FUNCTION public.privacy_reminder_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.source IS DISTINCT FROM public.privacy_due_source(NEW.privacy_request_id,NEW.days_from_target,NEW.basis) OR NOT EXISTS(SELECT 1 FROM public.automation_event_sources e JOIN public.automation_subscription_events done ON done.academy_id=e.academy_id AND done.event_id=e.event_id WHERE e.academy_id=NEW.academy_id AND e.privacy_reminder_id=NEW.id AND e.source_kind='privacy_due' AND done.subscription_id=NEW.subscription_id AND done.rule_version=NEW.rule_version AND done.outcome IN('queued','ignored')) THEN RAISE EXCEPTION 'PRIVACY_REMINDER_CURRENT_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER privacy_reminder_complete AFTER INSERT ON public.privacy_reminder_occurrences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.privacy_reminder_complete();
CREATE FUNCTION public.privacy_reminder_notice_current(p_event uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT o.source=public.privacy_due_source(o.privacy_request_id,o.days_from_target,o.basis) AND v.definition->'enabled'='true'::jsonb AND v.definition#>>'{execution,mode}'='automatic' AND v.definition#>>'{privacyReminder,daysFromTarget}'=o.days_from_target::text AND v.definition#>>'{privacyReminder,basis}'=o.basis AND(v.definition->>'startsAt' IS NULL OR clock_timestamp()>=(v.definition->>'startsAt')::timestamptz) AND(v.definition->>'endsAt' IS NULL OR clock_timestamp()<=(v.definition->>'endsAt')::timestamptz)
 FROM public.automation_event_sources e JOIN public.privacy_reminder_occurrences o ON o.academy_id=e.academy_id AND o.id=e.privacy_reminder_id JOIN public.automation_rules r ON r.academy_id=o.academy_id AND r.id=o.rule_id JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='privacy_due'),false)
$$;
CREATE FUNCTION public.privacy_reminder_notice_allows(p_event uuid,p_actor uuid,s jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE o record;p record;BEGIN
 SELECT timer.* INTO o FROM public.automation_event_sources e JOIN public.privacy_reminder_occurrences timer ON timer.academy_id=e.academy_id AND timer.id=e.privacy_reminder_id WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='privacy_due';IF NOT FOUND THEN RETURN false;END IF;
 SELECT id,hub_id,kind,status INTO p FROM public.people WHERE academy_id=o.academy_id AND id=p_actor;IF p.id IS NULL OR p.status<>'active' OR(p.kind='human' AND NOT public.report_comment_human_verified(p.id)) THEN RETURN false;END IF;
 RETURN public.privacy_due_allows(o.privacy_request_id,o.basis,s);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_runtime;
ALTER FUNCTION public.privacy_reminder_notice_current(uuid) OWNER TO kavosh_runtime;
ALTER FUNCTION public.privacy_reminder_notice_allows(uuid,uuid,jsonb) OWNER TO kavosh_runtime;
REVOKE CREATE ON SCHEMA public FROM kavosh_runtime;
CREATE FUNCTION public.privacy_reminder_delivery_current() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='automation_runs' THEN IF NEW.outcome<>'processed' OR coalesce((NEW.summary->>'portalNotifications')::integer,0)+coalesce((NEW.summary->>'outboundQueued')::integer,0)=0 THEN RETURN NULL;END IF;
 ELSE IF NEW.status<>'sending' THEN RETURN NULL;END IF;END IF;
 IF EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='privacy_due') AND NOT public.privacy_reminder_notice_current(NEW.event_id) THEN RAISE EXCEPTION 'PRIVACY_REMINDER_DELIVERY_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER privacy_reminder_delivery_current AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.privacy_reminder_delivery_current();
CREATE CONSTRAINT TRIGGER privacy_reminder_handoff_current AFTER UPDATE ON public.notification_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='sending') EXECUTE FUNCTION public.privacy_reminder_delivery_current();
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.lock_notification_delivery_source(uuid,uuid)'::regprocedure);
 needle='IF e.source_kind=''counterparty_statement'' THEN';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PRIVACY_DUE_DELIVERY_ROW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF e.source_kind='privacy_due' THEN
  PERFORM id FROM public.privacy_requests WHERE academy_id=tenant AND id=(e.projection->>'entityId')::uuid FOR SHARE;PERFORM id FROM public.automation_rules WHERE academy_id=tenant AND id=(e.projection#>>'{attributes,reminder,ruleId}')::uuid FOR SHARE;
 ELSIF e.source_kind='counterparty_statement' THEN$branch$);
END $$;
REVOKE ALL ON FUNCTION public.privacy_due_source(uuid,integer,text,jsonb),public.privacy_due_public(jsonb),public.privacy_due_allows(uuid,text,jsonb),public.privacy_reminder_scan_guard(),public.privacy_reminder_occurrence_guard(),public.privacy_reminder_event_guard(),public.privacy_reminder_complete(),public.privacy_reminder_notice_current(uuid),public.privacy_reminder_notice_allows(uuid,uuid,jsonb),public.privacy_reminder_delivery_current() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_due_source(uuid,integer,text,jsonb),public.privacy_due_public(jsonb),public.privacy_due_allows(uuid,text,jsonb),public.privacy_reminder_notice_current(uuid),public.privacy_reminder_notice_allows(uuid,uuid,jsonb) TO kavosh_runtime;
GRANT EXECUTE ON FUNCTION public.privacy_due_public(jsonb) TO kavosh_event_policy;
-- Row-lock permission stays behind the existing exact live-delivery lease.
-- The sender receives neither raw case reads nor an UPDATE grant.
GRANT SELECT(academy_id,id),UPDATE(id) ON public.privacy_requests TO kavosh_message_policy;
GRANT EXECUTE ON FUNCTION public.privacy_reminder_notice_current(uuid),public.privacy_reminder_notice_allows(uuid,uuid,jsonb) TO kavosh_message_worker,kavosh_message_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 386 $$;

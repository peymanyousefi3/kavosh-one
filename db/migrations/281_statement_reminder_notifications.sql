-- Reuse reviewed rules,leased subscription scans and the durable notification
-- pipeline. No scheduler/payment/provider code or inferred recipient identity.
CREATE FUNCTION public.statement_due_source(p_statement uuid,p_days integer,p_zone text,p_scopes jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH base AS MATERIALIZED(SELECT public.statement_reminder_source($1,$2,$3,$4) s),members AS MATERIALIZED(
  SELECT r.id,r.recipient_id,r.statement_version,w.id withdrawal_id,p.status,encode(sha256(convert_to(jsonb_build_array(p.auth_user_id,p.access_version)::text,'UTF8')),'hex') account_binding
  FROM public.counterparty_statement_releases r JOIN public.people p ON p.academy_id=r.academy_id AND p.id=r.recipient_id LEFT JOIN public.counterparty_statement_release_withdrawals w ON w.academy_id=r.academy_id AND w.release_id=r.id
  WHERE r.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND r.statement_id=$1 LIMIT 10001)
 SELECT s||jsonb_build_object('financialSourceStamp',s->>'sourceStamp','sourceStamp',encode(sha256(convert_to(jsonb_build_array(s->>'sourceStamp',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM members m))::text,'UTF8')),'hex')) FROM base WHERE s IS NOT NULL AND(SELECT count(*) FROM members)<=10000
$$;
CREATE FUNCTION public.statement_due_public(s jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('statementId',s->>'statementId','statementVersion',s->'statementVersion','dueOn',s->>'dueOn','reminderOn',s->>'reminderOn','timeZone',s->>'timeZone','daysFromDue',s->'daysFromDue','legalOverdueDetermination',false,'moneyMovementPerformed',false)
$$;
CREATE FUNCTION public.statement_due_allows(p_statement uuid,p_zone text,s jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT v.denied=0 AND v.unknown=0 AND v."sourceFingerprint" IS NOT NULL AND public.scope_contains(s->'counterparty-statements.view',v."sourceScope") IS TRUE AND public.scope_contains(s->'counterparty-settlements.view',v."sourceScope") IS TRUE
  AND(public.statement_settlement_status_read(h.id,h.version,z.today,s) ? 'unavailable') IS NOT TRUE
 FROM public.counterparty_statement_records h CROSS JOIN(SELECT (statement_timestamp() AT TIME ZONE name)::date today FROM pg_catalog.pg_timezone_names WHERE name=p_zone) z
 CROSS JOIN LATERAL public.counterparty_statement_snapshot_read(h.payee_id,h.from_on,greatest(h.through_on,z.today),s,NULL,NULL,NULL,NULL,1,h.currency_ids,false) v
 WHERE h.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND h.id=p_statement),false)
$$;
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.automation_rule_guard()'::regprocedure);needle='keys||ARRAY[''sessionReminder'',''sessionFollowUp'',''tuitionReminder'',''expenseReminder'',''payrollReminder'']';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'STATEMENT_TIMER_KEYS_BASE_CHANGED';END IF;
 body=replace(body,needle,'keys||ARRAY[''sessionReminder'',''sessionFollowUp'',''tuitionReminder'',''expenseReminder'',''payrollReminder'',''statementReminder'']');needle='a=d->''trigger'';';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'STATEMENT_TIMER_RULE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF d ? 'statementReminder' THEN
  a=d->'statementReminder';IF d ?| ARRAY['sessionReminder','sessionFollowUp','tuitionReminder','expenseReminder','payrollReminder'] OR jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['daysFromDue','timeZone']) OR a-ARRAY['daysFromDue','timeZone']<>'{}'::jsonb OR jsonb_typeof(a->'daysFromDue') IS DISTINCT FROM 'number' OR(a->>'daysFromDue')::numeric<>trunc((a->>'daysFromDue')::numeric) OR(a->>'daysFromDue')::numeric NOT BETWEEN -365 AND 3650 OR jsonb_typeof(a->'timeZone') IS DISTINCT FROM 'string' OR length(a->>'timeZone') NOT BETWEEN 1 AND 100 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=a->>'timeZone') THEN RAISE EXCEPTION 'AUTOMATION_STATEMENT_REMINDER_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 a=d->'trigger';$branch$);
END $$;
CREATE TABLE public.statement_reminder_scans(academy_id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,last_statement_id uuid,PRIMARY KEY(academy_id,subscription_id),FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id));
CREATE TABLE public.statement_reminder_occurrences(
 academy_id uuid NOT NULL,id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,rule_id uuid NOT NULL,rule_version integer NOT NULL,statement_id uuid NOT NULL,
 days_from_due integer NOT NULL CHECK(days_from_due BETWEEN -365 AND 3650),time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100),request_id uuid NOT NULL,hub_id uuid,source jsonb NOT NULL,source_stamp text NOT NULL CHECK(source_stamp~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),UNIQUE(academy_id,rule_id,statement_id,days_from_due,time_zone,source_stamp),FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id),FOREIGN KEY(academy_id,rule_id,rule_version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version),FOREIGN KEY(academy_id,statement_id) REFERENCES public.counterparty_statement_records(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),CHECK(octet_length(source::text)<=1048576));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['statement_reminder_scans','statement_reminder_occurrences'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE ON public.statement_reminder_scans TO kavosh_automation_worker;
GRANT SELECT ON public.statement_reminder_occurrences TO kavosh_runtime,kavosh_event_policy;
GRANT INSERT(academy_id,id,subscription_id,lease_token,rule_id,rule_version,statement_id,days_from_due,time_zone,request_id) ON public.statement_reminder_occurrences TO kavosh_automation_worker;
CREATE FUNCTION public.statement_reminder_scan_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT pg_has_role(current_user,'kavosh_automation_worker','member') OR(TG_OP='UPDATE' AND ROW(NEW.academy_id,NEW.subscription_id) IS DISTINCT FROM ROW(OLD.academy_id,OLD.subscription_id)) OR NOT EXISTS(SELECT 1 FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'STATEMENT_SCAN_LEASE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER statement_reminder_scan_guard BEFORE INSERT OR UPDATE ON public.statement_reminder_scans FOR EACH ROW EXECUTE FUNCTION public.statement_reminder_scan_guard();
CREATE FUNCTION public.statement_reminder_occurrence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE sub record;d jsonb;rule_hub uuid;BEGIN
 IF TG_OP<>'INSERT' OR NOT pg_has_role(current_user,'kavosh_automation_worker','member') THEN RAISE EXCEPTION 'STATEMENT_REMINDER_PRIVATE_WORKER_REQUIRED' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM public.lock_finance_book();PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));PERFORM id FROM public.counterparty_statement_records WHERE academy_id=NEW.academy_id AND id=NEW.statement_id FOR SHARE;
 SELECT * INTO sub FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND rule_id=NEW.rule_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp();
 SELECT v.definition,r.hub_id INTO d,rule_hub FROM public.automation_rules r JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version WHERE r.academy_id=NEW.academy_id AND r.id=NEW.rule_id AND r.version=NEW.rule_version;
 NEW.source=public.statement_due_source(NEW.statement_id,NEW.days_from_due,NEW.time_zone);NEW.source_stamp=NEW.source->>'sourceStamp';NEW.hub_id=(NEW.source->>'hubId')::uuid;NEW.created_at=clock_timestamp();
 IF sub.id IS NULL OR d IS NULL OR NEW.source IS NULL OR(rule_hub IS NOT NULL AND rule_hub IS DISTINCT FROM NEW.hub_id) OR d->'enabled' IS DISTINCT FROM 'true'::jsonb OR d#>>'{execution,mode}' IS DISTINCT FROM 'automatic' OR d#>>'{statementReminder,daysFromDue}' IS DISTINCT FROM NEW.days_from_due::text OR d#>>'{statementReminder,timeZone}' IS DISTINCT FROM NEW.time_zone OR(d->>'startsAt' IS NOT NULL AND clock_timestamp()<(d->>'startsAt')::timestamptz) OR(d->>'endsAt' IS NOT NULL AND clock_timestamp()>(d->>'endsAt')::timestamptz) THEN RAISE EXCEPTION 'STATEMENT_REMINDER_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER statement_reminder_occurrence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.statement_reminder_occurrences FOR EACH ROW EXECUTE FUNCTION public.statement_reminder_occurrence_guard();
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule','report_job','pay_statement','account_security','calendar_event','work_signature','tuition_due','expense_due','payroll_due','counterparty_statement','statement_due'));
ALTER TABLE public.automation_event_sources ADD statement_reminder_id uuid,ADD FOREIGN KEY(academy_id,statement_reminder_id) REFERENCES public.statement_reminder_occurrences(academy_id,id),ADD UNIQUE(academy_id,statement_reminder_id),ADD CHECK((source_kind='statement_due')=(statement_reminder_id IS NOT NULL));
CREATE FUNCTION public.statement_reminder_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE timer record;watch record;a record;expected jsonb;BEGIN
 SELECT * INTO timer FROM public.statement_reminder_occurrences WHERE academy_id=NEW.academy_id AND id=NEW.statement_reminder_id;SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
 SELECT a0.* INTO a FROM public.audit_events a0 JOIN public.outbox_events o ON o.academy_id=a0.academy_id AND o.id=NEW.event_id AND o.request_id=a0.request_id AND o.entity_id=a0.entity_id AND o.event_type=a0.action AND o.created_at=transaction_timestamp() WHERE a0.academy_id=NEW.academy_id AND a0.id=NEW.audit_id AND a0.request_id=timer.request_id AND a0.action='statement.reminder_due' AND a0.entity_id=timer.statement_id AND a0.created_at=transaction_timestamp();
 expected=public.statement_due_public(timer.source)||jsonb_build_object('hubId',timer.hub_id,'reminder',jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id));
 IF current_user<>'kavosh_event_policy' OR timer.id IS NULL OR a.id IS NULL OR watch.id IS NULL OR NEW.event_type<>'statement.reminder_due' OR NEW.source_version<>1 OR NEW.approval_id IS NOT NULL OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id OR a.changes->>'reminderReceiptId' IS DISTINCT FROM timer.id::text OR NEW.hub_id IS DISTINCT FROM timer.hub_id OR a.hub_id IS DISTINCT FROM timer.hub_id OR NEW.occurred_at<transaction_timestamp() OR NEW.occurred_at>clock_timestamp() OR NEW.projection IS DISTINCT FROM jsonb_build_object('eventType',NEW.event_type,'entityId',timer.statement_id,'hubId',NEW.hub_id,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity','normal','occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',expected) THEN RAISE EXCEPTION 'STATEMENT_REMINDER_EXACT_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER statement_reminder_event_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='statement_due') EXECUTE FUNCTION public.statement_reminder_event_guard();
DO $$ DECLARE body text;needle text:='IF NEW.event_type=''payroll.reminder_due'' THEN';BEGIN
 body=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);IF position(needle IN body)=0 THEN RAISE EXCEPTION 'STATEMENT_REMINDER_CAPTURE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF NEW.event_type='statement.reminder_due' THEN
  SELECT * INTO timer FROM public.statement_reminder_occurrences WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND statement_id=NEW.entity_id;SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
  IF timer.id IS NULL OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id OR a.changes->>'reminderReceiptId' IS DISTINCT FROM timer.id::text THEN RETURN NULL;END IF;
  source=public.statement_due_public(timer.source)||jsonb_build_object('hubId',timer.hub_id,'reminder',jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id));
  INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,statement_reminder_id) VALUES(NEW.academy_id,NEW.id,a.id,NULL,'statement_due',1,NEW.event_type,timer.hub_id,at,jsonb_build_object('eventType',NEW.event_type,'entityId',NEW.entity_id,'hubId',timer.hub_id,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity','normal','occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',source),timer.id);
 ELSIF NEW.event_type='payroll.reminder_due' THEN$branch$);
END $$;
CREATE FUNCTION public.statement_reminder_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.source IS DISTINCT FROM public.statement_due_source(NEW.statement_id,NEW.days_from_due,NEW.time_zone) OR NOT EXISTS(SELECT 1 FROM public.automation_event_sources e JOIN public.automation_subscription_events done ON done.academy_id=e.academy_id AND done.event_id=e.event_id WHERE e.academy_id=NEW.academy_id AND e.statement_reminder_id=NEW.id AND e.source_kind='statement_due' AND done.subscription_id=NEW.subscription_id AND done.rule_version=NEW.rule_version AND done.outcome IN('queued','ignored')) THEN RAISE EXCEPTION 'STATEMENT_REMINDER_CURRENT_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER statement_reminder_complete AFTER INSERT ON public.statement_reminder_occurrences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.statement_reminder_complete();
CREATE FUNCTION public.statement_reminder_copy(p_event uuid,p_actor uuid) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT r.id FROM public.automation_event_sources e JOIN public.statement_reminder_occurrences o ON o.academy_id=e.academy_id AND o.id=e.statement_reminder_id JOIN public.counterparty_statement_releases r ON r.academy_id=o.academy_id AND r.statement_id=o.statement_id AND r.statement_version=(o.source->>'statementVersion')::integer JOIN public.people p ON p.academy_id=r.academy_id AND p.id=r.recipient_id
 WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='statement_due' AND r.recipient_id=p_actor AND p.kind='human' AND p.status='active' AND public.report_comment_human_verified(p.id) AND NOT EXISTS(SELECT 1 FROM public.counterparty_statement_release_withdrawals w WHERE w.academy_id=r.academy_id AND w.release_id=r.id) ORDER BY r.id DESC LIMIT 1
$$;
CREATE FUNCTION public.statement_reminder_notice_current(p_event uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT o.source=public.statement_due_source(o.statement_id,o.days_from_due,o.time_zone) AND v.definition->'enabled'='true'::jsonb AND v.definition#>>'{execution,mode}'='automatic' AND v.definition#>>'{statementReminder,daysFromDue}'=o.days_from_due::text AND v.definition#>>'{statementReminder,timeZone}'=o.time_zone AND(v.definition->>'startsAt' IS NULL OR clock_timestamp()>=(v.definition->>'startsAt')::timestamptz) AND(v.definition->>'endsAt' IS NULL OR clock_timestamp()<=(v.definition->>'endsAt')::timestamptz)
 FROM public.automation_event_sources e JOIN public.statement_reminder_occurrences o ON o.academy_id=e.academy_id AND o.id=e.statement_reminder_id JOIN public.automation_rules r ON r.academy_id=o.academy_id AND r.id=o.rule_id JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='statement_due'),false)
$$;
CREATE FUNCTION public.statement_reminder_notice_allows(p_event uuid,p_actor uuid,s jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE o record;p record;BEGIN
 SELECT timer.* INTO o FROM public.automation_event_sources e JOIN public.statement_reminder_occurrences timer ON timer.academy_id=e.academy_id AND timer.id=e.statement_reminder_id WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='statement_due';IF NOT FOUND THEN RETURN false;END IF;
 SELECT id,hub_id,kind,status INTO p FROM public.people WHERE academy_id=o.academy_id AND id=p_actor;IF p.id IS NULL OR p.status<>'active' OR(p.kind='human' AND NOT public.report_comment_human_verified(p.id)) THEN RETURN false;END IF;
 IF p.kind='human' AND public.statement_reminder_copy(p_event,p.id) IS NOT NULL AND public.scope_contains(s->'received-statements.view',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p.id,'hubId',p.hub_id)))) IS TRUE THEN RETURN true;END IF;
 RETURN public.statement_due_allows(o.statement_id,o.time_zone,s);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_runtime;
ALTER FUNCTION public.statement_reminder_notice_current(uuid) OWNER TO kavosh_runtime;
ALTER FUNCTION public.statement_reminder_notice_allows(uuid,uuid,jsonb) OWNER TO kavosh_runtime;
REVOKE CREATE ON SCHEMA public FROM kavosh_runtime;
CREATE FUNCTION public.statement_reminder_delivery_current() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='automation_runs' THEN IF NEW.outcome<>'processed' OR coalesce((NEW.summary->>'portalNotifications')::integer,0)+coalesce((NEW.summary->>'outboundQueued')::integer,0)=0 THEN RETURN NULL;END IF;
 ELSE IF NEW.status<>'sending' THEN RETURN NULL;END IF;END IF;
 IF EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='statement_due') AND NOT public.statement_reminder_notice_current(NEW.event_id) THEN RAISE EXCEPTION 'STATEMENT_REMINDER_DELIVERY_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER statement_reminder_delivery_current AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.statement_reminder_delivery_current();
CREATE CONSTRAINT TRIGGER statement_reminder_handoff_current AFTER UPDATE ON public.notification_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='sending') EXECUTE FUNCTION public.statement_reminder_delivery_current();
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.lock_notification_delivery_source(uuid,uuid)'::regprocedure);needle='IN(''tuition_due'',''expense_due'',''payroll_due'',''counterparty_statement'') THEN PERFORM public.lock_finance_book();';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'STATEMENT_DUE_DELIVERY_BOOK_BASE_CHANGED';END IF;body=replace(body,needle,'IN(''tuition_due'',''expense_due'',''payroll_due'',''counterparty_statement'',''statement_due'') THEN PERFORM public.lock_finance_book();');
 needle='IF e.source_kind=''counterparty_statement'' THEN';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'STATEMENT_DUE_DELIVERY_ROW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF e.source_kind='statement_due' THEN
  PERFORM id FROM public.counterparty_statement_records WHERE academy_id=tenant AND id=(e.projection->>'entityId')::uuid FOR SHARE;PERFORM id FROM public.automation_rules WHERE academy_id=tenant AND id=(e.projection#>>'{attributes,reminder,ruleId}')::uuid FOR SHARE;
 ELSIF e.source_kind='counterparty_statement' THEN$branch$);
END $$;
REVOKE ALL ON FUNCTION public.statement_due_source(uuid,integer,text,jsonb),public.statement_due_public(jsonb),public.statement_due_allows(uuid,text,jsonb),public.statement_reminder_scan_guard(),public.statement_reminder_occurrence_guard(),public.statement_reminder_event_guard(),public.statement_reminder_complete(),public.statement_reminder_copy(uuid,uuid),public.statement_reminder_notice_current(uuid),public.statement_reminder_notice_allows(uuid,uuid,jsonb),public.statement_reminder_delivery_current() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.statement_due_source(uuid,integer,text,jsonb),public.statement_due_public(jsonb),public.statement_due_allows(uuid,text,jsonb),public.statement_reminder_copy(uuid,uuid),public.statement_reminder_notice_current(uuid),public.statement_reminder_notice_allows(uuid,uuid,jsonb) TO kavosh_runtime;
GRANT EXECUTE ON FUNCTION public.statement_due_public(jsonb) TO kavosh_event_policy;
GRANT EXECUTE ON FUNCTION public.statement_reminder_notice_current(uuid),public.statement_reminder_notice_allows(uuid,uuid,jsonb) TO kavosh_message_worker,kavosh_message_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 281 $$;

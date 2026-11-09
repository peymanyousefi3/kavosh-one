-- Posted worker-net timers extend the existing reviewed notification
-- pipeline. No new scheduler,arbitrary code,automatic payment or provider IO.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.automation_rule_guard()'::regprocedure);
 needle='keys||ARRAY[''sessionReminder'',''sessionFollowUp'',''tuitionReminder'',''expenseReminder'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_RULE_TIMER_BASE_CHANGED';END IF;
 body=replace(body,needle,'keys||ARRAY[''sessionReminder'',''sessionFollowUp'',''tuitionReminder'',''expenseReminder'',''payrollReminder'']');
 needle='a=d->''trigger'';';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_RULE_TRIGGER_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF d ? 'payrollReminder' THEN
  a=d->'payrollReminder';IF d ? 'sessionReminder' OR d ? 'sessionFollowUp' OR d ? 'tuitionReminder' OR d ? 'expenseReminder' OR jsonb_typeof(a) IS DISTINCT FROM 'object'
   OR NOT(a ?& ARRAY['daysFromPlannedPay','timeZone']) OR a-ARRAY['daysFromPlannedPay','timeZone']<>'{}'::jsonb
   OR jsonb_typeof(a->'daysFromPlannedPay') IS DISTINCT FROM 'number' OR(a->>'daysFromPlannedPay')::numeric<>trunc((a->>'daysFromPlannedPay')::numeric) OR(a->>'daysFromPlannedPay')::numeric NOT BETWEEN -365 AND 3650
   OR jsonb_typeof(a->'timeZone') IS DISTINCT FROM 'string' OR length(a->>'timeZone') NOT BETWEEN 1 AND 100
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=a->>'timeZone')
  THEN RAISE EXCEPTION 'AUTOMATION_PAYROLL_REMINDER_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 a=d->'trigger';$branch$);
END $$;
CREATE TABLE public.payroll_reminder_scans(
 academy_id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,last_posting_id uuid,
 PRIMARY KEY(academy_id,subscription_id),FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id));
CREATE TABLE public.payroll_reminder_occurrences(
 academy_id uuid NOT NULL,id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,rule_id uuid NOT NULL,rule_version integer NOT NULL,
 posting_id uuid NOT NULL,days_from_planned_pay integer NOT NULL CHECK(days_from_planned_pay BETWEEN -365 AND 3650),time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100),request_id uuid NOT NULL,hub_id uuid,
 source jsonb NOT NULL,source_stamp text NOT NULL CHECK(source_stamp~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),UNIQUE(academy_id,rule_id,posting_id,days_from_planned_pay,time_zone,source_stamp),
 FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id),FOREIGN KEY(academy_id,rule_id,rule_version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version),
 FOREIGN KEY(academy_id,posting_id) REFERENCES public.payrun_net_postings(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payroll_reminder_scans','payroll_reminder_occurrences'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE ON public.payroll_reminder_scans TO kavosh_automation_worker;
GRANT SELECT ON public.payroll_reminder_occurrences TO kavosh_runtime,kavosh_event_policy;
GRANT INSERT(academy_id,id,subscription_id,lease_token,rule_id,rule_version,posting_id,days_from_planned_pay,time_zone,request_id) ON public.payroll_reminder_occurrences TO kavosh_automation_worker;
CREATE FUNCTION public.payroll_reminder_scan_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT pg_has_role(current_user,'kavosh_automation_worker','member') OR(TG_OP='UPDATE' AND ROW(NEW.academy_id,NEW.subscription_id) IS DISTINCT FROM ROW(OLD.academy_id,OLD.subscription_id))
  OR NOT EXISTS(SELECT 1 FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp())
 THEN RAISE EXCEPTION 'PAYROLL_REMINDER_SCAN_LEASE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER payroll_reminder_scan_guard BEFORE INSERT OR UPDATE ON public.payroll_reminder_scans FOR EACH ROW EXECUTE FUNCTION public.payroll_reminder_scan_guard();
CREATE FUNCTION public.payroll_reminder_occurrence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE sub record;d jsonb;rule_hub uuid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYROLL_REMINDER_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT pg_has_role(current_user,'kavosh_automation_worker','member') THEN RAISE EXCEPTION 'PAYROLL_REMINDER_WORKER_REQUIRED' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM public.lock_finance_book();PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 PERFORM public.lock_hourly_worker((SELECT g.person_id FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id WHERE p.academy_id=NEW.academy_id AND p.id=NEW.posting_id));
 PERFORM id FROM public.payrun_net_postings WHERE academy_id=NEW.academy_id AND id=NEW.posting_id FOR SHARE;
 SELECT * INTO sub FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND rule_id=NEW.rule_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp();
 SELECT v.definition,r.hub_id INTO d,rule_hub FROM public.automation_rules r JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version
  WHERE r.academy_id=NEW.academy_id AND r.id=NEW.rule_id AND r.version=NEW.rule_version;
 NEW.source=public.payroll_reminder_source(NEW.posting_id,NEW.days_from_planned_pay,NEW.time_zone);NEW.source_stamp=NEW.source->>'sourceStamp';NEW.created_at=clock_timestamp();
 NEW.hub_id=(NEW.source->>'hubId')::uuid;
 IF sub.id IS NULL OR d IS NULL OR NEW.source IS NULL OR(rule_hub IS NOT NULL AND rule_hub IS DISTINCT FROM NEW.hub_id)
  OR d->'enabled' IS DISTINCT FROM 'true'::jsonb OR d#>>'{execution,mode}' IS DISTINCT FROM 'automatic'
  OR d#>>'{payrollReminder,daysFromPlannedPay}' IS DISTINCT FROM NEW.days_from_planned_pay::text OR d#>>'{payrollReminder,timeZone}' IS DISTINCT FROM NEW.time_zone
  OR(d->>'startsAt' IS NOT NULL AND clock_timestamp()<(d->>'startsAt')::timestamptz) OR(d->>'endsAt' IS NOT NULL AND clock_timestamp()>(d->>'endsAt')::timestamptz)
 THEN RAISE EXCEPTION 'PAYROLL_REMINDER_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER payroll_reminder_occurrence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_reminder_occurrences FOR EACH ROW EXECUTE FUNCTION public.payroll_reminder_occurrence_guard();
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule','report_job','pay_statement','account_security','calendar_event','work_signature','tuition_due','expense_due','payroll_due'));
ALTER TABLE public.automation_event_sources ADD payroll_reminder_id uuid,ADD FOREIGN KEY(academy_id,payroll_reminder_id) REFERENCES public.payroll_reminder_occurrences(academy_id,id),
 ADD UNIQUE(academy_id,payroll_reminder_id),ADD CHECK((source_kind='payroll_due')=(payroll_reminder_id IS NOT NULL));
CREATE FUNCTION public.payroll_reminder_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE timer record;watch record;a record;expected jsonb;BEGIN
 SELECT * INTO timer FROM public.payroll_reminder_occurrences WHERE academy_id=NEW.academy_id AND id=NEW.payroll_reminder_id;
 SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
 SELECT a0.* INTO a FROM public.audit_events a0 JOIN public.outbox_events o ON o.academy_id=a0.academy_id AND o.id=NEW.event_id AND o.request_id=a0.request_id AND o.entity_id=a0.entity_id AND o.event_type=a0.action AND o.created_at=transaction_timestamp()
  WHERE a0.academy_id=NEW.academy_id AND a0.id=NEW.audit_id AND a0.request_id=timer.request_id AND a0.action='payroll.reminder_due' AND a0.entity_id=timer.posting_id AND a0.created_at=transaction_timestamp();
 expected=timer.source||jsonb_build_object('hubId',timer.hub_id,'reminder',jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id));
 IF current_user<>'kavosh_event_policy' OR timer.id IS NULL OR a.id IS NULL OR watch.id IS NULL OR NEW.event_type<>'payroll.reminder_due' OR NEW.source_version<>1 OR NEW.approval_id IS NOT NULL
  OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id
  OR a.changes->>'reminderReceiptId' IS DISTINCT FROM timer.id::text OR NEW.hub_id IS DISTINCT FROM timer.hub_id OR a.hub_id IS DISTINCT FROM timer.hub_id OR NEW.occurred_at<transaction_timestamp() OR NEW.occurred_at>clock_timestamp()
  OR NEW.projection IS DISTINCT FROM jsonb_build_object('eventType',NEW.event_type,'entityId',timer.posting_id,'hubId',NEW.hub_id,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity','normal',
   'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',expected)
 THEN RAISE EXCEPTION 'PAYROLL_REMINDER_EXACT_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER payroll_reminder_event_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='payroll_due') EXECUTE FUNCTION public.payroll_reminder_event_guard();
DO $$ DECLARE body text;needle text:='IF NEW.event_type=''expense.reminder_due'' THEN';BEGIN
 body=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_CAPTURE_SOURCE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF NEW.event_type='payroll.reminder_due' THEN
  SELECT * INTO timer FROM public.payroll_reminder_occurrences WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND posting_id=NEW.entity_id;
  SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
  IF timer.id IS NULL OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id OR a.changes->>'reminderReceiptId' IS DISTINCT FROM timer.id::text THEN RETURN NULL;END IF;
  source=timer.source||jsonb_build_object('hubId',timer.hub_id,'reminder',jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id));
  INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,payroll_reminder_id)
  VALUES(NEW.academy_id,NEW.id,a.id,NULL,'payroll_due',1,NEW.event_type,timer.hub_id,at,jsonb_build_object('eventType',NEW.event_type,'entityId',NEW.entity_id,'hubId',timer.hub_id,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity','normal','occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',source),timer.id);
 ELSIF NEW.event_type='expense.reminder_due' THEN$branch$);
END $$;
CREATE FUNCTION public.payroll_reminder_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.source IS DISTINCT FROM public.payroll_reminder_source(NEW.posting_id,NEW.days_from_planned_pay,NEW.time_zone)
  OR NOT EXISTS(SELECT 1 FROM public.automation_event_sources e JOIN public.automation_subscription_events done ON done.academy_id=e.academy_id AND done.event_id=e.event_id
   WHERE e.academy_id=NEW.academy_id AND e.payroll_reminder_id=NEW.id AND e.source_kind='payroll_due' AND e.event_type='payroll.reminder_due'
    AND done.subscription_id=NEW.subscription_id AND done.rule_version=NEW.rule_version AND done.outcome IN('queued','ignored'))
 THEN RAISE EXCEPTION 'PAYROLL_REMINDER_CURRENT_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_reminder_complete AFTER INSERT ON public.payroll_reminder_occurrences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_reminder_complete();
-- Only currentness/permission booleans cross the passive-sender boundary.
CREATE FUNCTION public.payroll_reminder_notice_current(p_event uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT o.source=public.payroll_reminder_source_read(o.posting_id,o.days_from_planned_pay,o.time_zone)
  AND v.definition->'enabled'='true'::jsonb AND v.definition#>>'{execution,mode}'='automatic' AND v.definition#>>'{payrollReminder,daysFromPlannedPay}'=o.days_from_planned_pay::text AND v.definition#>>'{payrollReminder,timeZone}'=o.time_zone
  AND(v.definition->>'startsAt' IS NULL OR clock_timestamp()>=(v.definition->>'startsAt')::timestamptz) AND(v.definition->>'endsAt' IS NULL OR clock_timestamp()<=(v.definition->>'endsAt')::timestamptz)
  FROM public.automation_event_sources e JOIN public.payroll_reminder_occurrences o ON o.academy_id=e.academy_id AND o.id=e.payroll_reminder_id
  JOIN public.automation_rules r ON r.academy_id=o.academy_id AND r.id=o.rule_id JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version
  WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='payroll_due'),false)
$$;
CREATE FUNCTION public.payroll_reminder_notice_allows(p_event uuid,p_scopes jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT public.payroll_reminder_posting_allows(o.posting_id,p_scopes,'{"all":true,"hubs":[]}'::jsonb) FROM public.automation_event_sources e
  JOIN public.payroll_reminder_occurrences o ON o.academy_id=e.academy_id AND o.id=e.payroll_reminder_id
  WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='payroll_due'),false)
$$;
GRANT CREATE ON SCHEMA public TO kavosh_runtime;
ALTER FUNCTION public.payroll_reminder_notice_current(uuid) OWNER TO kavosh_runtime;
ALTER FUNCTION public.payroll_reminder_notice_allows(uuid,jsonb) OWNER TO kavosh_runtime;
REVOKE CREATE ON SCHEMA public FROM kavosh_runtime;
REVOKE ALL ON FUNCTION public.payroll_reminder_notice_current(uuid),public.payroll_reminder_notice_allows(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_reminder_notice_current(uuid),public.payroll_reminder_notice_allows(uuid,jsonb) TO kavosh_runtime,kavosh_message_worker,kavosh_message_policy;
CREATE FUNCTION public.payroll_reminder_delivery_current() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='automation_runs' THEN
  IF NEW.outcome<>'processed' OR coalesce((NEW.summary->>'portalNotifications')::integer,0)+coalesce((NEW.summary->>'outboundQueued')::integer,0)=0 THEN RETURN NULL;END IF;
 ELSE IF NEW.status<>'sending' THEN RETURN NULL;END IF;END IF;
 IF EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='payroll_due')
  AND NOT public.payroll_reminder_notice_current(NEW.event_id) THEN RAISE EXCEPTION 'PAYROLL_REMINDER_DELIVERY_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_reminder_delivery_current AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_reminder_delivery_current();
CREATE CONSTRAINT TRIGGER payroll_reminder_handoff_current AFTER UPDATE ON public.notification_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='sending') EXECUTE FUNCTION public.payroll_reminder_delivery_current();
REVOKE ALL ON FUNCTION public.payroll_reminder_scan_guard(),public.payroll_reminder_occurrence_guard(),public.payroll_reminder_event_guard(),public.payroll_reminder_complete(),public.payroll_reminder_delivery_current() FROM PUBLIC;
-- The lease-bound sender locks the exact original worker;no new raw payroll
-- table grants are needed for this passive principal.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.lock_notification_delivery_source(uuid,uuid)'::regprocedure);
 needle='IF e.source_kind IN(''tuition_due'',''expense_due'') THEN PERFORM public.lock_finance_book();END IF;';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_DELIVERY_BOOK_BASE_CHANGED';END IF;
 body=replace(body,needle,'IF e.source_kind IN(''tuition_due'',''expense_due'',''payroll_due'') THEN PERFORM public.lock_finance_book();END IF;');
 needle='IF e.source_kind=''expense_due'' THEN';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_DELIVERY_WORKER_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF e.source_kind='payroll_due' THEN
  PERFORM public.lock_hourly_worker((e.projection#>>'{attributes,personId}')::uuid);
  PERFORM id FROM public.automation_rules WHERE academy_id=tenant AND id=(e.projection#>>'{attributes,reminder,ruleId}')::uuid FOR SHARE;
 ELSIF e.source_kind='expense_due' THEN$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 261 $$;

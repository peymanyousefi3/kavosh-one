-- Supplier/reimbursement timers extend the existing reviewed notification
-- pipeline. No new scheduler,arbitrary code,automatic payment or provider IO.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.automation_rule_guard()'::regprocedure);
 needle='keys||ARRAY[''sessionReminder'',''sessionFollowUp'',''tuitionReminder'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'EXPENSE_RULE_TIMER_BASE_CHANGED';END IF;
 body=replace(body,needle,'keys||ARRAY[''sessionReminder'',''sessionFollowUp'',''tuitionReminder'',''expenseReminder'']');
 needle='a=d->''trigger'';';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'EXPENSE_RULE_TRIGGER_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF d ? 'expenseReminder' THEN
  a=d->'expenseReminder';IF d ? 'sessionReminder' OR d ? 'sessionFollowUp' OR d ? 'tuitionReminder' OR jsonb_typeof(a) IS DISTINCT FROM 'object'
   OR NOT(a ?& ARRAY['daysFromDue','timeZone']) OR a-ARRAY['daysFromDue','timeZone']<>'{}'::jsonb
   OR jsonb_typeof(a->'daysFromDue') IS DISTINCT FROM 'number' OR(a->>'daysFromDue')::numeric<>trunc((a->>'daysFromDue')::numeric) OR(a->>'daysFromDue')::numeric NOT BETWEEN -365 AND 3650
   OR jsonb_typeof(a->'timeZone') IS DISTINCT FROM 'string' OR length(a->>'timeZone') NOT BETWEEN 1 AND 100
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=a->>'timeZone')
  THEN RAISE EXCEPTION 'AUTOMATION_EXPENSE_REMINDER_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 a=d->'trigger';$branch$);
END $$;
CREATE TABLE public.expense_reminder_scans(
 academy_id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,last_bill_id uuid,
 PRIMARY KEY(academy_id,subscription_id),FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id));
CREATE TABLE public.expense_reminder_occurrences(
 academy_id uuid NOT NULL,id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,rule_id uuid NOT NULL,rule_version integer NOT NULL,
 bill_id uuid NOT NULL,days_from_due integer NOT NULL CHECK(days_from_due BETWEEN -365 AND 3650),time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100),request_id uuid NOT NULL,hub_id uuid,
 source jsonb NOT NULL,source_stamp text NOT NULL CHECK(source_stamp~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),UNIQUE(academy_id,rule_id,bill_id,days_from_due,time_zone,source_stamp),
 FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id),FOREIGN KEY(academy_id,rule_id,rule_version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version),
 FOREIGN KEY(academy_id,bill_id) REFERENCES public.expense_bills(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['expense_reminder_scans','expense_reminder_occurrences'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE ON public.expense_reminder_scans TO kavosh_automation_worker;
GRANT SELECT ON public.expense_reminder_occurrences TO kavosh_runtime,kavosh_event_policy;
GRANT INSERT(academy_id,id,subscription_id,lease_token,rule_id,rule_version,bill_id,days_from_due,time_zone,request_id) ON public.expense_reminder_occurrences TO kavosh_automation_worker;
CREATE FUNCTION public.expense_reminder_scan_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT pg_has_role(current_user,'kavosh_automation_worker','member') OR(TG_OP='UPDATE' AND ROW(NEW.academy_id,NEW.subscription_id) IS DISTINCT FROM ROW(OLD.academy_id,OLD.subscription_id))
  OR NOT EXISTS(SELECT 1 FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp())
 THEN RAISE EXCEPTION 'EXPENSE_REMINDER_SCAN_LEASE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER expense_reminder_scan_guard BEFORE INSERT OR UPDATE ON public.expense_reminder_scans FOR EACH ROW EXECUTE FUNCTION public.expense_reminder_scan_guard();
CREATE FUNCTION public.expense_reminder_occurrence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE sub record;d jsonb;rule_hub uuid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EXPENSE_REMINDER_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT pg_has_role(current_user,'kavosh_automation_worker','member') THEN RAISE EXCEPTION 'EXPENSE_REMINDER_WORKER_REQUIRED' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM public.lock_finance_book();PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 PERFORM id FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.bill_id FOR SHARE;
 SELECT * INTO sub FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND rule_id=NEW.rule_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp();
 SELECT v.definition,r.hub_id INTO d,rule_hub FROM public.automation_rules r JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version
  WHERE r.academy_id=NEW.academy_id AND r.id=NEW.rule_id AND r.version=NEW.rule_version;
 NEW.source=public.expense_reminder_source(NEW.bill_id,NEW.days_from_due,NEW.time_zone);NEW.source_stamp=NEW.source->>'sourceStamp';NEW.created_at=clock_timestamp();
 NEW.hub_id=CASE WHEN jsonb_array_length(NEW.source->'costHubIds')=1 THEN(NEW.source#>>'{costHubIds,0}')::uuid END;
 IF sub.id IS NULL OR d IS NULL OR NEW.source IS NULL OR(rule_hub IS NOT NULL AND rule_hub IS DISTINCT FROM NEW.hub_id)
  OR d->'enabled' IS DISTINCT FROM 'true'::jsonb OR d#>>'{execution,mode}' IS DISTINCT FROM 'automatic'
  OR d#>>'{expenseReminder,daysFromDue}' IS DISTINCT FROM NEW.days_from_due::text OR d#>>'{expenseReminder,timeZone}' IS DISTINCT FROM NEW.time_zone
  OR(d->>'startsAt' IS NOT NULL AND clock_timestamp()<(d->>'startsAt')::timestamptz) OR(d->>'endsAt' IS NOT NULL AND clock_timestamp()>(d->>'endsAt')::timestamptz)
 THEN RAISE EXCEPTION 'EXPENSE_REMINDER_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER expense_reminder_occurrence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.expense_reminder_occurrences FOR EACH ROW EXECUTE FUNCTION public.expense_reminder_occurrence_guard();
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule','report_job','pay_statement','account_security','calendar_event','work_signature','tuition_due','expense_due'));
ALTER TABLE public.automation_event_sources ADD expense_reminder_id uuid,ADD FOREIGN KEY(academy_id,expense_reminder_id) REFERENCES public.expense_reminder_occurrences(academy_id,id),
 ADD UNIQUE(academy_id,expense_reminder_id),ADD CHECK((source_kind='expense_due')=(expense_reminder_id IS NOT NULL));
CREATE FUNCTION public.expense_reminder_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE timer record;watch record;a record;expected jsonb;BEGIN
 SELECT * INTO timer FROM public.expense_reminder_occurrences WHERE academy_id=NEW.academy_id AND id=NEW.expense_reminder_id;
 SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
 SELECT a0.* INTO a FROM public.audit_events a0 JOIN public.outbox_events o ON o.academy_id=a0.academy_id AND o.id=NEW.event_id AND o.request_id=a0.request_id AND o.entity_id=a0.entity_id AND o.event_type=a0.action AND o.created_at=transaction_timestamp()
  WHERE a0.academy_id=NEW.academy_id AND a0.id=NEW.audit_id AND a0.request_id=timer.request_id AND a0.action='expense.reminder_due' AND a0.entity_id=timer.bill_id AND a0.created_at=transaction_timestamp();
 expected=(timer.source-ARRAY['costHubIds','fundingHubIds'])||jsonb_build_object('hubId',timer.hub_id,'reminder',jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id));
 IF current_user<>'kavosh_event_policy' OR timer.id IS NULL OR a.id IS NULL OR watch.id IS NULL OR NEW.event_type<>'expense.reminder_due' OR NEW.source_version<>1 OR NEW.approval_id IS NOT NULL
  OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id
  OR a.changes->>'reminderReceiptId' IS DISTINCT FROM timer.id::text OR NEW.hub_id IS DISTINCT FROM timer.hub_id OR a.hub_id IS DISTINCT FROM timer.hub_id OR NEW.occurred_at<transaction_timestamp() OR NEW.occurred_at>clock_timestamp()
  OR NEW.projection IS DISTINCT FROM jsonb_build_object('eventType',NEW.event_type,'entityId',timer.bill_id,'hubId',NEW.hub_id,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity','normal',
   'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',expected)
 THEN RAISE EXCEPTION 'EXPENSE_REMINDER_EXACT_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER expense_reminder_event_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='expense_due') EXECUTE FUNCTION public.expense_reminder_event_guard();
DO $$ DECLARE body text;needle text:='IF NEW.event_type=''tuition.reminder_due'' THEN';BEGIN
 body=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'EXPENSE_CAPTURE_SOURCE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF NEW.event_type='expense.reminder_due' THEN
  SELECT * INTO timer FROM public.expense_reminder_occurrences WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND bill_id=NEW.entity_id;
  SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
  IF timer.id IS NULL OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id OR a.changes->>'reminderReceiptId' IS DISTINCT FROM timer.id::text THEN RETURN NULL;END IF;
  source=(timer.source-ARRAY['costHubIds','fundingHubIds'])||jsonb_build_object('hubId',timer.hub_id,'reminder',jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id));
  INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,expense_reminder_id)
  VALUES(NEW.academy_id,NEW.id,a.id,NULL,'expense_due',1,NEW.event_type,timer.hub_id,at,jsonb_build_object('eventType',NEW.event_type,'entityId',NEW.entity_id,'hubId',timer.hub_id,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity','normal','occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',source),timer.id);
 ELSIF NEW.event_type='tuition.reminder_due' THEN$branch$);
END $$;
CREATE FUNCTION public.expense_reminder_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.source IS DISTINCT FROM public.expense_reminder_source(NEW.bill_id,NEW.days_from_due,NEW.time_zone)
  OR NOT EXISTS(SELECT 1 FROM public.automation_event_sources e JOIN public.automation_subscription_events done ON done.academy_id=e.academy_id AND done.event_id=e.event_id
   WHERE e.academy_id=NEW.academy_id AND e.expense_reminder_id=NEW.id AND e.source_kind='expense_due' AND e.event_type='expense.reminder_due'
    AND done.subscription_id=NEW.subscription_id AND done.rule_version=NEW.rule_version AND done.outcome IN('queued','ignored'))
 THEN RAISE EXCEPTION 'EXPENSE_REMINDER_CURRENT_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_reminder_complete AFTER INSERT ON public.expense_reminder_occurrences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.expense_reminder_complete();
-- Only currentness/permission booleans cross the passive-sender boundary.
CREATE FUNCTION public.expense_reminder_notice_current(p_event uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT o.source=public.expense_reminder_source(o.bill_id,o.days_from_due,o.time_zone)
  AND v.definition->'enabled'='true'::jsonb AND v.definition#>>'{execution,mode}'='automatic' AND v.definition#>>'{expenseReminder,daysFromDue}'=o.days_from_due::text AND v.definition#>>'{expenseReminder,timeZone}'=o.time_zone
  AND(v.definition->>'startsAt' IS NULL OR clock_timestamp()>=(v.definition->>'startsAt')::timestamptz) AND(v.definition->>'endsAt' IS NULL OR clock_timestamp()<=(v.definition->>'endsAt')::timestamptz)
  FROM public.automation_event_sources e JOIN public.expense_reminder_occurrences o ON o.academy_id=e.academy_id AND o.id=e.expense_reminder_id
  JOIN public.automation_rules r ON r.academy_id=o.academy_id AND r.id=o.rule_id JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version
  WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='expense_due'),false)
$$;
CREATE FUNCTION public.expense_reminder_notice_allows(p_event uuid,p_scopes jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT public.expense_reminder_bill_allows(o.bill_id,p_scopes) FROM public.automation_event_sources e
  JOIN public.expense_reminder_occurrences o ON o.academy_id=e.academy_id AND o.id=e.expense_reminder_id
  WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='expense_due'),false)
$$;
GRANT CREATE ON SCHEMA public TO kavosh_runtime;
ALTER FUNCTION public.expense_reminder_notice_current(uuid) OWNER TO kavosh_runtime;
ALTER FUNCTION public.expense_reminder_notice_allows(uuid,jsonb) OWNER TO kavosh_runtime;
REVOKE CREATE ON SCHEMA public FROM kavosh_runtime;
REVOKE ALL ON FUNCTION public.expense_reminder_notice_current(uuid),public.expense_reminder_notice_allows(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_reminder_notice_current(uuid),public.expense_reminder_notice_allows(uuid,jsonb) TO kavosh_runtime,kavosh_message_worker,kavosh_message_policy;
CREATE FUNCTION public.expense_reminder_delivery_current() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='automation_runs' THEN
  IF NEW.outcome<>'processed' OR coalesce((NEW.summary->>'portalNotifications')::integer,0)+coalesce((NEW.summary->>'outboundQueued')::integer,0)=0 THEN RETURN NULL;END IF;
 ELSE IF NEW.status<>'sending' THEN RETURN NULL;END IF;END IF;
 IF EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='expense_due')
  AND NOT public.expense_reminder_notice_current(NEW.event_id) THEN RAISE EXCEPTION 'EXPENSE_REMINDER_DELIVERY_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER expense_reminder_delivery_current AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.expense_reminder_delivery_current();
CREATE CONSTRAINT TRIGGER expense_reminder_handoff_current AFTER UPDATE ON public.notification_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='sending') EXECUTE FUNCTION public.expense_reminder_delivery_current();
REVOKE ALL ON FUNCTION public.expense_reminder_scan_guard(),public.expense_reminder_occurrence_guard(),public.expense_reminder_event_guard(),public.expense_reminder_complete(),public.expense_reminder_delivery_current() FROM PUBLIC;
GRANT SELECT(academy_id,id),UPDATE(id) ON public.expense_bills TO kavosh_message_policy;
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.lock_notification_delivery_source(uuid,uuid)'::regprocedure);
 needle='IF e.source_kind=''tuition_due'' THEN PERFORM public.lock_finance_book();END IF;';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'EXPENSE_DELIVERY_BOOK_BASE_CHANGED';END IF;
 body=replace(body,needle,'IF e.source_kind IN(''tuition_due'',''expense_due'') THEN PERFORM public.lock_finance_book();END IF;');
 needle='IF e.source_kind=''tuition_due'' THEN';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'EXPENSE_DELIVERY_ROW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF e.source_kind='expense_due' THEN
  PERFORM id FROM public.expense_bills WHERE academy_id=tenant AND id=(e.projection->>'entityId')::uuid FOR SHARE;
  PERFORM id FROM public.automation_rules WHERE academy_id=tenant AND id=(e.projection#>>'{attributes,reminder,ruleId}')::uuid FOR SHARE;
 ELSIF e.source_kind='tuition_due' THEN$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 258 $$;

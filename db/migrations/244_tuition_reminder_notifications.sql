-- Extend the existing reviewed rules;no arbitrary code or parallel scheduler.
-- Compute each invoice snapshot and context hash ONCE,even if many installments
-- fall on the same civil day. The singular243entrypoint delegates to this set.
CREATE FUNCTION public.tuition_reminder_sources(p_invoice uuid,p_days_from_due integer) RETURNS SETOF jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
 WITH target AS MATERIALIZED(
  SELECT i.id,i.student_id,i.hub_id,i.class_id,cl.time_zone,public.tuition_installment_snapshot(i.id) snapshot
  FROM public.tuition_invoices i JOIN public.classes cl ON cl.academy_id=i.academy_id AND cl.id=i.class_id
  JOIN public.billing_documents d ON d.academy_id=i.academy_id AND d.id=i.id JOIN public.academies school ON school.id=i.academy_id
  WHERE i.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND i.id=p_invoice AND i.credit_id IS NULL
   AND d.issued_at<=statement_timestamp() AND school.status='active' AND p_days_from_due BETWEEN -365 AND 3650
 ),totals AS MATERIALIZED(
  SELECT t.*,encode(sha256(convert_to(jsonb_build_array(t.id,t.student_id,t.hub_id,t.class_id,t.time_zone,snapshot->'today',snapshot->'currencyCode',snapshot->'scale')::text,'UTF8')),'hex') context_stamp,
   coalesce((SELECT sum((item->>'allocated')::numeric) FROM jsonb_array_elements(snapshot->'installments') item),0) allocated,
   NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'installments') item WHERE(item->>'planned')::numeric<0 OR(item->>'allocated')::numeric<0 OR(item->>'allocated')::numeric>(item->>'planned')::numeric) consistent FROM target t
 ) SELECT jsonb_build_object('invoiceId',t.id,'studentId',t.student_id,'hubId',t.hub_id,'classId',t.class_id,'timeZone',t.time_zone,
  'installment',(item->>'installment')::integer,'dueOn',item->'dueOn','daysFromDue',p_days_from_due,'reminderOn',((item->>'dueOn')::date+p_days_from_due)::text,
  'currencyCode',snapshot->'currencyCode','unitScale',snapshot->'scale','plannedMinor',item->'planned','allocatedMinor',item->'allocated',
  'outstandingMinor',((item->>'planned')::numeric-(item->>'allocated')::numeric)::text,
  'sourceStamp',encode(sha256(convert_to(jsonb_build_array(context_stamp,item,p_days_from_due)::text,'UTF8')),'hex'))
 FROM totals t CROSS JOIN LATERAL jsonb_array_elements(snapshot->'installments') item WHERE consistent AND(snapshot->>'received')::numeric=allocated
  AND(item->>'planned')::numeric>(item->>'allocated')::numeric AND(snapshot->>'today')::date=(item->>'dueOn')::date+p_days_from_due
$$;
CREATE OR REPLACE FUNCTION public.tuition_reminder_source(p_invoice uuid,p_installment integer,p_days_from_due integer) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
 SELECT source FROM public.tuition_reminder_sources(p_invoice,p_days_from_due) source WHERE(source->>'installment')::integer=p_installment
$$;
REVOKE ALL ON FUNCTION public.tuition_reminder_sources(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tuition_reminder_sources(uuid,integer) TO kavosh_runtime;

DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.automation_rule_guard()'::regprocedure);
 needle='keys||ARRAY[''sessionReminder'',''sessionFollowUp'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'TUITION_RULE_TIMER_BASE_CHANGED';END IF;
 body=replace(body,needle,'keys||ARRAY[''sessionReminder'',''sessionFollowUp'',''tuitionReminder'']');
 needle='a=d->''trigger'';';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'TUITION_RULE_TRIGGER_BASE_CHANGED';END IF;
 body=replace(body,needle,$branch$IF d ? 'tuitionReminder' THEN
  a=d->'tuitionReminder';IF d ? 'sessionReminder' OR d ? 'sessionFollowUp' OR jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ? 'daysFromDue') OR a-ARRAY['daysFromDue']<>'{}'::jsonb
   OR jsonb_typeof(a->'daysFromDue') IS DISTINCT FROM 'number' OR(a->>'daysFromDue')::numeric<>trunc((a->>'daysFromDue')::numeric) OR(a->>'daysFromDue')::numeric NOT BETWEEN -365 AND 3650
  THEN RAISE EXCEPTION 'AUTOMATION_TUITION_REMINDER_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 a=d->'trigger';$branch$);
 needle='''school_master'',''actor_supervisors'',''people'',''session_guardians'',''session_staff'',''statement_worker'',''calendar_guardians''';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'TUITION_RULE_AUDIENCE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||',''tuition_family''');
END $$;

-- Original invoice tuple,not mutable primary hub or arbitrary auditor rights.
-- The family branch reuses the current verified legal-family predicate.
CREATE FUNCTION public.tuition_reminder_invoice_allows(p_invoice uuid,p_actor uuid,p_scopes jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT
  (EXISTS(SELECT 1 FROM public.academies a WHERE a.id=i.academy_id AND a.master_person_id=p_actor) AND public.report_comment_human_verified(p_actor))
  OR(public.scope_contains(coalesce(p_scopes->'invoices.view','{"all":false,"hubs":[]}'::jsonb),target.scope)
   AND public.scope_contains(coalesce(p_scopes->'allocations.view','{"all":false,"hubs":[]}'::jsonb),target.scope))
  OR(public.registration_data_basis(i.student_id,p_actor) IS NOT NULL
   AND public.scope_contains(coalesce(p_scopes->'received-tuition.view','{"all":false,"hubs":[]}'::jsonb),target.scope))
 FROM public.tuition_invoices i CROSS JOIN LATERAL(SELECT jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',i.student_id,'hubId',i.hub_id)),
  'recordContext',jsonb_build_object('hubId',i.hub_id,'classId',i.class_id,'studentId',i.student_id)) scope) target
 WHERE i.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND i.id=p_invoice),false)
$$;
REVOKE ALL ON FUNCTION public.tuition_reminder_invoice_allows(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tuition_reminder_invoice_allows(uuid,uuid,jsonb) TO kavosh_runtime;

CREATE TABLE public.tuition_reminder_scans(
 academy_id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,last_invoice_id uuid,
 PRIMARY KEY(academy_id,subscription_id),FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id));
CREATE TABLE public.tuition_reminder_occurrences(
 academy_id uuid NOT NULL,id uuid NOT NULL,subscription_id uuid NOT NULL,lease_token uuid NOT NULL,rule_id uuid NOT NULL,rule_version integer NOT NULL,
 invoice_id uuid NOT NULL,installment integer NOT NULL CHECK(installment BETWEEN 1 AND 1000),days_from_due integer NOT NULL CHECK(days_from_due BETWEEN -365 AND 3650),request_id uuid NOT NULL,
 source jsonb NOT NULL,source_stamp text NOT NULL CHECK(source_stamp~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),UNIQUE(academy_id,rule_id,invoice_id,installment,days_from_due,source_stamp),
 FOREIGN KEY(academy_id,subscription_id) REFERENCES public.automation_subscriptions(academy_id,id),FOREIGN KEY(academy_id,rule_id,rule_version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version),
 FOREIGN KEY(academy_id,invoice_id) REFERENCES public.tuition_invoices(academy_id,id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['tuition_reminder_scans','tuition_reminder_occurrences'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE ON public.tuition_reminder_scans TO kavosh_automation_worker;
GRANT SELECT ON public.tuition_reminder_occurrences TO kavosh_runtime,kavosh_event_policy;
GRANT INSERT(academy_id,id,subscription_id,lease_token,rule_id,rule_version,invoice_id,installment,days_from_due,request_id) ON public.tuition_reminder_occurrences TO kavosh_automation_worker;
CREATE FUNCTION public.tuition_reminder_scan_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT pg_has_role(current_user,'kavosh_automation_worker','member') OR(TG_OP='UPDATE' AND ROW(NEW.academy_id,NEW.subscription_id) IS DISTINCT FROM ROW(OLD.academy_id,OLD.subscription_id))
  OR NOT EXISTS(SELECT 1 FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp())
 THEN RAISE EXCEPTION 'TUITION_REMINDER_SCAN_LEASE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER tuition_reminder_scan_guard BEFORE INSERT OR UPDATE ON public.tuition_reminder_scans FOR EACH ROW EXECUTE FUNCTION public.tuition_reminder_scan_guard();
CREATE FUNCTION public.tuition_reminder_occurrence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE sub record;d jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'TUITION_REMINDER_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT pg_has_role(current_user,'kavosh_automation_worker','member') THEN RAISE EXCEPTION 'TUITION_REMINDER_WORKER_REQUIRED' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM public.lock_finance_book();PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 PERFORM id FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=NEW.invoice_id FOR SHARE;
 SELECT * INTO sub FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=NEW.subscription_id AND rule_id=NEW.rule_id AND status='active' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp();
 SELECT v.definition INTO d FROM public.automation_rules r JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version
  WHERE r.academy_id=NEW.academy_id AND r.id=NEW.rule_id AND r.version=NEW.rule_version AND(r.hub_id IS NULL OR r.hub_id=(SELECT hub_id FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=NEW.invoice_id));
 NEW.source=public.tuition_reminder_source(NEW.invoice_id,NEW.installment,NEW.days_from_due);NEW.source_stamp=NEW.source->>'sourceStamp';NEW.created_at=clock_timestamp();
 IF sub.id IS NULL OR d IS NULL OR NEW.source IS NULL OR d->'enabled' IS DISTINCT FROM 'true'::jsonb OR d#>>'{execution,mode}' IS DISTINCT FROM 'automatic'
  OR d#>>'{tuitionReminder,daysFromDue}' IS DISTINCT FROM NEW.days_from_due::text
  OR(d->>'startsAt' IS NOT NULL AND clock_timestamp()<(d->>'startsAt')::timestamptz) OR(d->>'endsAt' IS NOT NULL AND clock_timestamp()>(d->>'endsAt')::timestamptz)
 THEN RAISE EXCEPTION 'TUITION_REMINDER_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER tuition_reminder_occurrence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tuition_reminder_occurrences FOR EACH ROW EXECUTE FUNCTION public.tuition_reminder_occurrence_guard();

ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule','report_job','pay_statement','account_security','calendar_event','work_signature','tuition_due'));
ALTER TABLE public.automation_event_sources ADD tuition_reminder_id uuid,ADD FOREIGN KEY(academy_id,tuition_reminder_id) REFERENCES public.tuition_reminder_occurrences(academy_id,id),
 ADD UNIQUE(academy_id,tuition_reminder_id),ADD CHECK((source_kind='tuition_due')=(tuition_reminder_id IS NOT NULL));
CREATE FUNCTION public.tuition_reminder_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE timer record;watch record;a record;expected jsonb;BEGIN
 SELECT * INTO timer FROM public.tuition_reminder_occurrences WHERE academy_id=NEW.academy_id AND id=NEW.tuition_reminder_id;
 SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
 SELECT a0.* INTO a FROM public.audit_events a0 JOIN public.outbox_events o ON o.academy_id=a0.academy_id AND o.id=NEW.event_id AND o.request_id=a0.request_id AND o.entity_id=a0.entity_id AND o.event_type=a0.action AND o.created_at=transaction_timestamp()
  WHERE a0.academy_id=NEW.academy_id AND a0.id=NEW.audit_id AND a0.request_id=timer.request_id AND a0.action='tuition.reminder_due' AND a0.entity_id=timer.invoice_id AND a0.created_at=transaction_timestamp();
 expected=timer.source||jsonb_build_object('reminder',jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id));
 IF current_user<>'kavosh_event_policy' OR timer.id IS NULL OR a.id IS NULL OR watch.id IS NULL OR NEW.event_type<>'tuition.reminder_due' OR NEW.source_version<>1 OR NEW.approval_id IS NOT NULL
  OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id
  OR a.changes->>'reminderReceiptId' IS DISTINCT FROM timer.id::text OR NEW.hub_id IS DISTINCT FROM(timer.source->>'hubId')::uuid OR NEW.occurred_at<transaction_timestamp() OR NEW.occurred_at>clock_timestamp()
  OR NEW.projection IS DISTINCT FROM jsonb_build_object('eventType',NEW.event_type,'entityId',timer.invoice_id,'hubId',NEW.hub_id,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity','normal',
   'occurredAt',to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',expected)
 THEN RAISE EXCEPTION 'TUITION_REMINDER_EXACT_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER tuition_reminder_event_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='tuition_due') EXECUTE FUNCTION public.tuition_reminder_event_guard();
DO $$ DECLARE body text;needle text:='IF NEW.event_type=''session.follow_up_due'' THEN';BEGIN
 body=pg_get_functiondef('public.capture_audited_automation_event()'::regprocedure);
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'TUITION_CAPTURE_SOURCE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF NEW.event_type='tuition.reminder_due' THEN
  SELECT * INTO timer FROM public.tuition_reminder_occurrences WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id AND invoice_id=NEW.entity_id;
  SELECT * INTO watch FROM public.automation_subscriptions WHERE academy_id=NEW.academy_id AND id=timer.subscription_id;
  IF timer.id IS NULL OR a.actor_id IS DISTINCT FROM watch.owner_id OR a.actor_kind IS DISTINCT FROM watch.owner_kind OR coalesce(a.session_id,a.credential_id) IS DISTINCT FROM watch.credential_id OR a.changes->>'reminderReceiptId' IS DISTINCT FROM timer.id::text THEN RETURN NULL;END IF;
  source=timer.source||jsonb_build_object('reminder',jsonb_build_object('receiptId',timer.id,'ruleId',timer.rule_id));
  INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,tuition_reminder_id)
  VALUES(NEW.academy_id,NEW.id,a.id,NULL,'tuition_due',1,NEW.event_type,(source->>'hubId')::uuid,at,jsonb_build_object('eventType',NEW.event_type,'entityId',NEW.entity_id,'hubId',source->'hubId','actorId',a.actor_id,'actorKind',a.actor_kind,'severity','normal','occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',source),timer.id);
 ELSIF NEW.event_type='session.follow_up_due' THEN$branch$);
END $$;
CREATE FUNCTION public.tuition_reminder_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.source IS DISTINCT FROM public.tuition_reminder_source(NEW.invoice_id,NEW.installment,NEW.days_from_due)
  OR NOT EXISTS(SELECT 1 FROM public.automation_event_sources e JOIN public.automation_subscription_events done ON done.academy_id=e.academy_id AND done.event_id=e.event_id
   WHERE e.academy_id=NEW.academy_id AND e.tuition_reminder_id=NEW.id AND e.source_kind='tuition_due' AND e.event_type='tuition.reminder_due'
    AND done.subscription_id=NEW.subscription_id AND done.rule_version=NEW.rule_version AND done.outcome IN('queued','ignored'))
 THEN RAISE EXCEPTION 'TUITION_REMINDER_CURRENT_EVENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tuition_reminder_complete AFTER INSERT ON public.tuition_reminder_occurrences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tuition_reminder_complete();

-- A deliberately small read-only definer boundary. Passive senders receive
-- two booleans,not invoice/receipt/guardian tables or operational mutations.
CREATE FUNCTION public.tuition_reminder_notice_current(p_event uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT o.source=public.tuition_reminder_source(o.invoice_id,o.installment,o.days_from_due)
  AND v.definition->'enabled'='true'::jsonb AND v.definition#>>'{execution,mode}'='automatic' AND v.definition#>>'{tuitionReminder,daysFromDue}'=o.days_from_due::text
  AND(v.definition->>'startsAt' IS NULL OR clock_timestamp()>=(v.definition->>'startsAt')::timestamptz) AND(v.definition->>'endsAt' IS NULL OR clock_timestamp()<=(v.definition->>'endsAt')::timestamptz)
  FROM public.automation_event_sources e JOIN public.tuition_reminder_occurrences o ON o.academy_id=e.academy_id AND o.id=e.tuition_reminder_id
  JOIN public.automation_rules r ON r.academy_id=o.academy_id AND r.id=o.rule_id JOIN public.automation_rule_revisions v ON v.academy_id=r.academy_id AND v.rule_id=r.id AND v.version=r.version
  WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='tuition_due'),false)
$$;
CREATE FUNCTION public.tuition_reminder_notice_allows(p_event uuid,p_actor uuid,p_scopes jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT public.tuition_reminder_invoice_allows(o.invoice_id,p_actor,p_scopes) FROM public.automation_event_sources e
  JOIN public.tuition_reminder_occurrences o ON o.academy_id=e.academy_id AND o.id=e.tuition_reminder_id
  WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=p_event AND e.source_kind='tuition_due'),false)
$$;
GRANT CREATE ON SCHEMA public TO kavosh_runtime;
ALTER FUNCTION public.tuition_reminder_notice_current(uuid) OWNER TO kavosh_runtime;
ALTER FUNCTION public.tuition_reminder_notice_allows(uuid,uuid,jsonb) OWNER TO kavosh_runtime;
REVOKE CREATE ON SCHEMA public FROM kavosh_runtime;
REVOKE ALL ON FUNCTION public.tuition_reminder_notice_current(uuid),public.tuition_reminder_notice_allows(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tuition_reminder_notice_current(uuid),public.tuition_reminder_notice_allows(uuid,uuid,jsonb) TO kavosh_runtime,kavosh_message_worker,kavosh_message_policy;
CREATE FUNCTION public.tuition_reminder_delivery_current() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF(TG_TABLE_NAME='automation_runs' AND NEW.outcome='processed' AND coalesce((NEW.summary->>'portalNotifications')::integer,0)+coalesce((NEW.summary->>'outboundQueued')::integer,0)>0)
 THEN
  IF EXISTS(SELECT 1 FROM public.automation_event_sources WHERE event_id=NEW.event_id AND source_kind='tuition_due')
   AND NOT public.tuition_reminder_notice_current(NEW.event_id) THEN RAISE EXCEPTION 'TUITION_REMINDER_DELIVERY_CHANGED' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tuition_reminder_delivery_current AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tuition_reminder_delivery_current();
CREATE FUNCTION public.tuition_reminder_handoff_current() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='sending' AND EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='tuition_due')
  AND NOT public.tuition_reminder_notice_current(NEW.event_id)
 THEN RAISE EXCEPTION 'TUITION_REMINDER_HANDOFF_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tuition_reminder_handoff_current AFTER UPDATE ON public.notification_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='sending') EXECUTE FUNCTION public.tuition_reminder_handoff_current();
REVOKE ALL ON FUNCTION public.tuition_reminder_scan_guard(),public.tuition_reminder_occurrence_guard(),public.tuition_reminder_event_guard(),public.tuition_reminder_complete(),public.tuition_reminder_delivery_current(),public.tuition_reminder_handoff_current() FROM PUBLIC;

-- Source kind is immutable and read only under the actual live delivery lease.
-- Acquire the book gate BEFORE topology only for a financial due source.
GRANT SELECT(academy_id,id) ON public.tuition_invoices,public.automation_rules TO kavosh_message_policy;
GRANT UPDATE(id) ON public.tuition_invoices,public.automation_rules TO kavosh_message_policy;
CREATE OR REPLACE FUNCTION public.lock_notification_delivery_source(p_delivery uuid,p_lease uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;e record;BEGIN
 IF tenant IS NULL THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));
 SELECT s.* INTO e FROM public.notification_deliveries d JOIN public.automation_event_sources s ON s.academy_id=d.academy_id AND s.event_id=d.event_id
  WHERE d.academy_id=tenant AND d.id=p_delivery AND d.status='preparing' AND d.lease_token=p_lease AND d.lease_until>clock_timestamp();
 IF NOT FOUND THEN RETURN false;END IF;
 IF e.source_kind='tuition_due' THEN PERFORM public.lock_finance_book();END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 IF e.source_kind='tuition_due' THEN
  PERFORM id FROM public.tuition_invoices WHERE academy_id=tenant AND id=(e.projection->>'entityId')::uuid FOR SHARE;
  PERFORM id FROM public.automation_rules WHERE academy_id=tenant AND id=(e.projection#>>'{attributes,reminder,ruleId}')::uuid FOR SHARE;
 ELSIF e.source_kind='calendar_event' THEN
  PERFORM id FROM public.calendar_events WHERE academy_id=tenant AND id=e.calendar_event_id FOR SHARE;
 ELSIF e.source_kind='pay_statement' THEN
  PERFORM public.lock_hourly_worker(public.pay_statement_notice_worker(e.event_id));
 ELSIF e.source_kind='report_schedule' THEN
  PERFORM id FROM public.report_schedules WHERE academy_id=tenant AND id=(e.projection->>'entityId')::uuid FOR SHARE;
 ELSIF e.source_kind='session' THEN
  PERFORM c.id FROM public.classes c JOIN public.class_sessions s ON s.academy_id=c.academy_id AND s.class_id=c.id WHERE s.academy_id=tenant AND s.id=e.session_id FOR SHARE OF c;
  PERFORM id FROM public.class_sessions WHERE academy_id=tenant AND id=e.session_id FOR SHARE;
 ELSIF e.source_kind='approval' THEN
  PERFORM id FROM public.approval_requests WHERE academy_id=tenant AND id=e.approval_id FOR SHARE;
 END IF;RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 244 $$;

-- Reviewed custom delivery uses the existing queue,consent,budgets and sender.
-- Keep the original mandatory portal floor independent of optional rules.
CREATE FUNCTION public.lock_signature_check_source(p_incident uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;i record;BEGIN
 SELECT purpose,start_id INTO i FROM public.signature_completion_incidents WHERE academy_id=tenant AND id=p_incident;
 IF NOT FOUND THEN RETURN false;END IF;
 -- Same transport-before-job ordering as approved rechecks and evidence finish.
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||CASE WHEN i.purpose='worker_services' THEN ':work-signature-transport:' ELSE ':signature-transport:' END||i.start_id::text,0));
 PERFORM start_id FROM public.signature_completion_jobs WHERE academy_id=tenant AND purpose=i.purpose AND start_id=i.start_id FOR SHARE;
 RETURN FOUND;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_completion_policy;
ALTER FUNCTION public.lock_signature_check_source(uuid) OWNER TO kavosh_signature_completion_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.lock_signature_check_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_signature_check_source(uuid) TO kavosh_runtime,kavosh_message_policy;

CREATE FUNCTION public.guard_signature_check_delivery() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE incident uuid;BEGIN
 IF TG_TABLE_NAME='automation_runs' THEN
  IF NEW.outcome<>'processed' OR coalesce((NEW.summary->>'portalNotifications')::integer,0)+coalesce((NEW.summary->>'outboundQueued')::integer,0)=0 THEN RETURN NEW;END IF;
 ELSIF TG_TABLE_NAME='notification_deliveries' AND TG_OP='UPDATE' THEN
  IF NEW.status<>'sending' THEN RETURN NEW;END IF;
 END IF;
 SELECT signature_completion_incident_id INTO incident FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='signature_check';
 IF incident IS NULL THEN RETURN NEW;END IF;
 PERFORM public.lock_signature_check_source(incident);
 IF NOT public.signature_check_notice_current(incident) THEN RAISE EXCEPTION 'SIGNATURE_CHECK_DELIVERY_CHANGED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_signature_check_delivery() FROM PUBLIC;
DROP TRIGGER aa_signature_check_custom_delivery_guard ON public.notification_deliveries;
DROP TRIGGER aa_signature_check_custom_portal_guard ON public.portal_notifications;
DROP FUNCTION public.guard_signature_check_custom_delivery();
CREATE TRIGGER signature_check_custom_portal_current BEFORE INSERT ON public.portal_notifications FOR EACH ROW WHEN(NEW.origin='automation') EXECUTE FUNCTION public.guard_signature_check_delivery();
CREATE TRIGGER signature_check_outbound_current BEFORE INSERT ON public.notification_deliveries FOR EACH ROW EXECUTE FUNCTION public.guard_signature_check_delivery();
CREATE CONSTRAINT TRIGGER signature_check_run_current AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_signature_check_delivery();
CREATE CONSTRAINT TRIGGER signature_check_handoff_current AFTER UPDATE ON public.notification_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='sending') EXECUTE FUNCTION public.guard_signature_check_delivery();
DO $$ DECLARE body text;needle text:='IF e.source_kind=''checkout'' THEN';BEGIN
 body=pg_get_functiondef('public.lock_notification_delivery_source(uuid,uuid)'::regprocedure);
 IF strpos(body,needle)=0 THEN RAISE EXCEPTION 'SIGNATURE_CHECK_DELIVERY_LOCK_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF e.source_kind='signature_check' THEN
  PERFORM public.lock_signature_check_source(e.signature_completion_incident_id);
 ELSIF e.source_kind='checkout' THEN$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 395 $$;

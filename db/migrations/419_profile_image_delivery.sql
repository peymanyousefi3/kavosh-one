-- Reuse reviewed rules,recipient policy,preferences,budgets and the original
-- durable sender. This enables no daemon and sends no external message.
CREATE FUNCTION public.lock_image_processing_source(p_incident uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;i record;BEGIN
 SELECT profile_id,release_version,image_no INTO i FROM public.profile_image_incidents WHERE academy_id=tenant AND id=p_incident;IF NOT FOUND THEN RETURN false;END IF;
 -- Caller holds policy then topology,as consent/publication changes do. Only
 -- the exact blocked job is locked;no raw row authority reaches the sender.
 PERFORM profile_id FROM public.profile_image_jobs WHERE academy_id=tenant AND profile_id=i.profile_id AND release_version=i.release_version AND image_no=i.image_no FOR SHARE;RETURN FOUND;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.lock_image_processing_source(uuid) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.lock_image_processing_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_image_processing_source(uuid) TO kavosh_runtime,kavosh_message_policy;
CREATE FUNCTION public.guard_image_processing_delivery() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE incident uuid;BEGIN
 IF TG_TABLE_NAME='automation_runs' THEN
  IF NEW.outcome<>'processed' OR coalesce((NEW.summary->>'portalNotifications')::integer,0)+coalesce((NEW.summary->>'outboundQueued')::integer,0)=0 THEN RETURN NEW;END IF;
 ELSIF TG_TABLE_NAME='notification_deliveries' AND TG_OP='UPDATE' THEN
  IF NEW.status<>'sending' THEN RETURN NEW;END IF;
 END IF;
 SELECT profile_image_incident_id INTO incident FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='image_processing';IF incident IS NULL THEN RETURN NEW;END IF;
 PERFORM public.lock_image_processing_source(incident);IF NOT public.image_processing_notice_current(incident) THEN RAISE EXCEPTION 'IMAGE_PROCESSING_DELIVERY_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_message_policy;
ALTER FUNCTION public.guard_image_processing_delivery() OWNER TO kavosh_message_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_message_policy;
REVOKE ALL ON FUNCTION public.guard_image_processing_delivery() FROM PUBLIC;
DROP TRIGGER aa_image_processing_delivery_guard ON public.notification_deliveries;
DROP TRIGGER aa_image_processing_portal_guard ON public.portal_notifications;
DROP FUNCTION public.guard_image_processing_custom_delivery();
CREATE TRIGGER image_processing_portal_current BEFORE INSERT ON public.portal_notifications FOR EACH ROW WHEN(NEW.origin='automation') EXECUTE FUNCTION public.guard_image_processing_delivery();
CREATE TRIGGER image_processing_outbound_current BEFORE INSERT ON public.notification_deliveries FOR EACH ROW EXECUTE FUNCTION public.guard_image_processing_delivery();
CREATE CONSTRAINT TRIGGER image_processing_run_current AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_image_processing_delivery();
CREATE CONSTRAINT TRIGGER image_processing_handoff_current AFTER UPDATE ON public.notification_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='sending') EXECUTE FUNCTION public.guard_image_processing_delivery();
DO $$ DECLARE body text;needle text:='IF e.source_kind=''signature_check'' THEN';BEGIN
 body=pg_get_functiondef('public.lock_notification_delivery_source(uuid,uuid)'::regprocedure);IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'IMAGE_DELIVERY_LOCK_SOURCE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF e.source_kind='image_processing' THEN
  PERFORM public.lock_image_processing_source(e.profile_image_incident_id);
 ELSIF e.source_kind='signature_check' THEN$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 419 $$;

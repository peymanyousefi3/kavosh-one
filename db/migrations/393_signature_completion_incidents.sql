-- Immutable system observations, not reconstructed historical alerts. Native
-- queue transitions and their outbox receipt must belong to the SAME transaction.
ALTER TABLE public.signature_completion_jobs ADD COLUMN blocked_origin_transaction xid8;
CREATE FUNCTION public.mark_signature_completion_block() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.state='blocked' AND OLD.state IS DISTINCT FROM 'blocked' THEN NEW.blocked_origin_transaction=pg_current_xact_id();
 ELSIF NEW.state='blocked' THEN NEW.blocked_origin_transaction=OLD.blocked_origin_transaction;
 ELSE NEW.blocked_origin_transaction=NULL;END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mark_signature_completion_block() FROM PUBLIC;
CREATE TRIGGER signature_completion_block_origin BEFORE UPDATE ON public.signature_completion_jobs FOR EACH ROW EXECUTE FUNCTION public.mark_signature_completion_block();

-- Purpose-specific event names prevent a colliding start UUID from choosing
-- the wrong enrollment/worker authority. Keep both brokers' identities/ACLs.
DO $$ DECLARE signature text;body text;needle text:='''signature.completion.check.blocked.critical''';BEGIN
 FOREACH signature IN ARRAY ARRAY['public.claim_signature_completion_job(uuid[],uuid,integer)','public.finish_signature_completion_job(uuid,text,uuid,uuid,text,uuid,integer)'] LOOP
  body=pg_get_functiondef(signature::regprocedure);
  IF strpos(body,needle)=0 THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_BLOCK_EVENT_SOURCE_CHANGED';END IF;
  EXECUTE replace(body,needle,'CASE WHEN q.purpose=''worker_services'' THEN ''work.signature.completion.check.blocked.critical'' ELSE ''signature.completion.check.blocked.critical'' END');
 END LOOP;
END $$;

CREATE TABLE public.signature_completion_incidents(
 academy_id uuid NOT NULL,id uuid NOT NULL,purpose text NOT NULL,start_id uuid NOT NULL,
 retry_version integer NOT NULL CHECK(retry_version>=0),attempt_no integer NOT NULL CHECK(attempt_no>=0),
 reason_code text NOT NULL CHECK(reason_code IN('source_changed','lease_expired','poll_window_elapsed','unavailable')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),origin_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,purpose,start_id,retry_version),
 FOREIGN KEY(academy_id,purpose,start_id) REFERENCES public.signature_completion_jobs(academy_id,purpose,start_id)
);
CREATE INDEX signature_completion_incident_history ON public.signature_completion_incidents(academy_id,purpose,start_id,recorded_at DESC,id DESC);
ALTER TABLE public.signature_completion_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_completion_incidents FORCE ROW LEVEL SECURITY;
CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.signature_completion_incidents FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion();
CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.signature_completion_incidents FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate();
CREATE POLICY signature_completion_incident_tenant ON public.signature_completion_incidents FOR SELECT TO kavosh_runtime USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY signature_completion_incident_executor ON public.signature_completion_incidents TO kavosh_signature_completion_policy USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.signature_completion_incidents TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,purpose,start_id,retry_version,attempt_no,reason_code,recorded_at) ON public.signature_completion_incidents TO kavosh_runtime;

CREATE FUNCTION public.guard_signature_completion_incident() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' OR current_user<>'kavosh_signature_completion_policy' THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_INCIDENT_IMMUTABLE';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_signature_completion_incident() FROM PUBLIC;
CREATE TRIGGER signature_completion_incident_guard BEFORE INSERT OR UPDATE OR DELETE ON public.signature_completion_incidents FOR EACH ROW EXECUTE FUNCTION public.guard_signature_completion_incident();

CREATE FUNCTION public.capture_signature_completion_incident() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q public.signature_completion_jobs;kind text;BEGIN
 kind=CASE NEW.event_type WHEN 'work.signature.completion.check.blocked.critical' THEN 'worker_services' WHEN 'signature.completion.check.blocked.critical' THEN 'unified_enrollment' END;
 SELECT * INTO q FROM public.signature_completion_jobs WHERE academy_id=NEW.academy_id AND purpose=kind AND start_id=NEW.entity_id;
 IF kind IS NULL OR q.start_id IS NULL OR q.state IS DISTINCT FROM 'blocked' OR NEW.request_id IS DISTINCT FROM q.start_id
 OR q.blocked_origin_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.created_at IS DISTINCT FROM transaction_timestamp() THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_INCIDENT_ORIGIN_REQUIRED' USING ERRCODE='55000';END IF;
 INSERT INTO public.signature_completion_incidents(academy_id,id,purpose,start_id,retry_version,attempt_no,reason_code)
 VALUES(NEW.academy_id,NEW.id,kind,q.start_id,q.retry_version,q.attempt_no,q.last_outcome);
 IF NOT FOUND THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_INCIDENT_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_completion_policy;
ALTER FUNCTION public.capture_signature_completion_incident() OWNER TO kavosh_signature_completion_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.capture_signature_completion_incident() FROM PUBLIC;
CREATE TRIGGER signature_completion_incident_capture AFTER INSERT ON public.outbox_events FOR EACH ROW WHEN(NEW.event_type IN('work.signature.completion.check.blocked.critical','signature.completion.check.blocked.critical')) EXECUTE FUNCTION public.capture_signature_completion_incident();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 393 $$;

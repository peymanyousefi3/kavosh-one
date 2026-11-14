-- A committed start consumes the reservation forever, including crash/timeout.
-- Transport observations are not provider reconciliation or admission clearance.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('signature-dispatch.execute','Consume signing reservations and record transport observations','People',true,ARRAY['hub','class','person','country','region','city']);
CREATE TABLE public.signature_dispatch_starts(
 academy_id uuid NOT NULL,id uuid NOT NULL,attempt_id uuid NOT NULL,actor_id uuid NOT NULL,audit_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,attempt_id),
 FOREIGN KEY(academy_id,attempt_id) REFERENCES public.signature_send_attempts(academy_id,id),
 FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id)
);
CREATE TABLE public.signature_dispatch_outcomes(
 academy_id uuid NOT NULL,id uuid NOT NULL,start_id uuid NOT NULL,actor_id uuid NOT NULL,audit_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN('not_attempted','outcome_unknown','accepted_for_processing')),
 document_id uuid,source_current boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,start_id),
 CHECK((state='accepted_for_processing')=(document_id IS NOT NULL)),
 FOREIGN KEY(academy_id,start_id) REFERENCES public.signature_dispatch_starts(academy_id,id),
 FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['signature_dispatch_starts','signature_dispatch_outcomes'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,attempt_id,actor_id,audit_id) ON public.signature_dispatch_starts TO kavosh_runtime;
GRANT INSERT(academy_id,id,start_id,actor_id,audit_id,state,document_id) ON public.signature_dispatch_outcomes TO kavosh_runtime;
CREATE FUNCTION public.guard_signature_dispatch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE attempt record;start record;audit record;event_action text;BEGIN
 IF TG_TABLE_NAME='signature_dispatch_starts' THEN
  SELECT * INTO attempt FROM public.signature_send_attempts WHERE academy_id=NEW.academy_id AND id=NEW.attempt_id;
  event_action='signature.dispatch.started';
 ELSE
  SELECT * INTO start FROM public.signature_dispatch_starts WHERE academy_id=NEW.academy_id AND id=NEW.start_id;
  IF start.id IS NULL OR start.actor_id IS DISTINCT FROM NEW.actor_id THEN RAISE EXCEPTION 'SIGNATURE_DISPATCH_INVALID' USING ERRCODE='23514';END IF;
  SELECT * INTO attempt FROM public.signature_send_attempts WHERE academy_id=NEW.academy_id AND id=start.attempt_id;
  event_action='signature.dispatch.observed';
 END IF;
 IF attempt.id IS NULL THEN RAISE EXCEPTION 'SIGNATURE_DISPATCH_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':'||attempt.request_id::text,25));
 SELECT * INTO audit FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id AND actor_id=NEW.actor_id AND entity_id=NEW.id AND action=event_action AND created_at=transaction_timestamp();
 IF audit.id IS NULL OR audit.changes->>'requestId' IS DISTINCT FROM attempt.request_id::text OR audit.changes->>'attemptId' IS DISTINCT FROM attempt.id::text
 OR audit.changes->>'severity' IS DISTINCT FROM 'critical' OR audit.changes->'providerVerified' IS DISTINCT FROM 'false'::jsonb
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.actor_id AND status='active') THEN RAISE EXCEPTION 'SIGNATURE_DISPATCH_INVALID' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='signature_dispatch_starts' THEN
  IF NOT public.signature_send_current(attempt.request_id) THEN RAISE EXCEPTION 'SIGNATURE_DISPATCH_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 ELSE
  IF audit.changes->>'state' IS DISTINCT FROM NEW.state THEN RAISE EXCEPTION 'SIGNATURE_DISPATCH_INVALID' USING ERRCODE='23514';END IF;
  -- Always retain a late observation, even if authorization expired during IO.
  NEW.source_current=public.signature_send_current(attempt.request_id);
 END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER signature_dispatch_start_guard BEFORE INSERT ON public.signature_dispatch_starts FOR EACH ROW EXECUTE FUNCTION public.guard_signature_dispatch();
CREATE TRIGGER signature_dispatch_outcome_guard BEFORE INSERT ON public.signature_dispatch_outcomes FOR EACH ROW EXECUTE FUNCTION public.guard_signature_dispatch();
REVOKE ALL ON FUNCTION public.guard_signature_dispatch() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 119 $$;

-- Consuming a start is permanent,including crash/timeout. Actor observations
-- are not independently verified transport,completed signing or legal effect.
CREATE TABLE public.work_signature_dispatch_starts(
 academy_id uuid NOT NULL,id uuid NOT NULL,attempt_id uuid NOT NULL,actor_id uuid NOT NULL,audit_id uuid NOT NULL,
 original_copy_id uuid NOT NULL,original_source jsonb NOT NULL,original_source_fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,attempt_id),
 FOREIGN KEY(academy_id,attempt_id) REFERENCES public.work_signature_send_attempts(academy_id,id),
 FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id),
 FOREIGN KEY(academy_id,original_copy_id) REFERENCES public.file_copy_requests(academy_id,id),
 CHECK(original_source_fingerprint~'^[a-f0-9]{64}$' AND original_source_fingerprint=encode(sha256(convert_to(original_source::text,'UTF8')),'hex'))
);
CREATE TABLE public.work_signature_dispatch_outcomes(
 academy_id uuid NOT NULL,id uuid NOT NULL,start_id uuid NOT NULL,actor_id uuid NOT NULL,audit_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN('not_attempted','outcome_unknown','accepted_for_processing')),document_id uuid,source_current boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,start_id),
 CHECK((state='accepted_for_processing')=(document_id IS NOT NULL)),
 FOREIGN KEY(academy_id,start_id) REFERENCES public.work_signature_dispatch_starts(academy_id,id),
 FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['work_signature_dispatch_starts','work_signature_dispatch_outcomes'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER immutable_work_dispatch BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,attempt_id,actor_id,audit_id,original_copy_id,original_source_fingerprint) ON public.work_signature_dispatch_starts TO kavosh_runtime;
GRANT INSERT(academy_id,id,start_id,actor_id,audit_id,state,document_id) ON public.work_signature_dispatch_outcomes TO kavosh_runtime;
CREATE FUNCTION public.work_signature_original_source(p_attempt uuid,p_copy uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;a record;r record;b record;s jsonb;BEGIN
 SELECT * INTO a FROM public.work_signature_send_attempts WHERE academy_id=tenant AND id=p_attempt;
 SELECT * INTO r FROM public.work_signature_send_requests WHERE academy_id=tenant AND id=a.request_id;
 SELECT * INTO b FROM public.work_agreement_contents WHERE academy_id=tenant AND id=r.binding_id AND preparation_id=r.preparation_id;
 IF a.id IS NULL OR b.id IS NULL OR NOT public.work_signature_send_current(r.id) THEN RETURN NULL;END IF;
 s=public.file_download_source(b.file_id,b.file_version,p_copy);
 IF s IS NULL OR s->>'mime' IS DISTINCT FROM 'application/pdf' OR s->>'sha256' IS DISTINCT FROM a.document_sha256 OR s->>'sha256' IS DISTINCT FROM b.source_snapshot#>>'{document,sha256}' OR s->'bytes' IS DISTINCT FROM b.source_snapshot#>'{document,sizeBytes}' THEN RETURN NULL;END IF;
 RETURN s;
END $$;
CREATE FUNCTION public.work_signature_dispatch_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a record;r record;started record;aud record;b record;route uuid;source jsonb;fp text;event_action text;BEGIN
 IF TG_TABLE_NAME='work_signature_dispatch_starts' THEN SELECT * INTO a FROM public.work_signature_send_attempts WHERE academy_id=NEW.academy_id AND id=NEW.attempt_id;event_action='work.signature.dispatch.started';
 ELSE SELECT * INTO started FROM public.work_signature_dispatch_starts WHERE academy_id=NEW.academy_id AND id=NEW.start_id;
  IF started.id IS NULL OR started.actor_id IS DISTINCT FROM NEW.actor_id THEN RAISE EXCEPTION 'WORK_SIGNATURE_DISPATCH_INVALID' USING ERRCODE='23514';END IF;
  SELECT * INTO a FROM public.work_signature_send_attempts WHERE academy_id=NEW.academy_id AND id=started.attempt_id;event_action='work.signature.dispatch.observed';
 END IF;
 SELECT * INTO r FROM public.work_signature_send_requests WHERE academy_id=NEW.academy_id AND id=a.request_id;
 IF a.id IS NULL OR r.id IS NULL THEN RAISE EXCEPTION 'WORK_SIGNATURE_DISPATCH_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':work-signature-send:'||r.binding_id::text,41));
 SELECT * INTO aud FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id AND actor_id=NEW.actor_id AND entity_id=NEW.id AND action=event_action AND created_at=transaction_timestamp();
 IF aud.id IS NULL OR aud.changes->>'requestId' IS DISTINCT FROM r.id::text OR aud.changes->>'attemptId' IS DISTINCT FROM a.id::text OR aud.changes->>'severity' IS DISTINCT FROM 'critical' OR aud.changes->'providerVerified' IS DISTINCT FROM 'false'::jsonb OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.actor_id AND status='active' AND kind=aud.actor_kind) THEN RAISE EXCEPTION 'WORK_SIGNATURE_DISPATCH_INVALID' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='work_signature_dispatch_starts' THEN
  SELECT * INTO b FROM public.work_agreement_contents WHERE academy_id=NEW.academy_id AND id=r.binding_id;
  SELECT route_id INTO route FROM public.file_copy_requests WHERE academy_id=NEW.academy_id AND id=NEW.original_copy_id AND file_id=b.file_id;
  IF route IS NULL THEN RAISE EXCEPTION 'WORK_SIGNATURE_ORIGINAL_CHANGED' USING ERRCODE='23514';END IF;
  PERFORM 1 FROM public.file_records WHERE academy_id=NEW.academy_id AND id=b.file_id FOR SHARE;PERFORM 1 FROM public.file_storage_routes WHERE academy_id=NEW.academy_id AND id=route FOR SHARE;
  source=public.work_signature_original_source(a.id,NEW.original_copy_id);fp=encode(sha256(convert_to(source::text,'UTF8')),'hex');
  IF source IS NULL OR fp IS DISTINCT FROM NEW.original_source_fingerprint OR aud.changes->>'originalCopyId' IS DISTINCT FROM NEW.original_copy_id::text OR aud.changes->>'originalSourceFingerprint' IS DISTINCT FROM fp THEN RAISE EXCEPTION 'WORK_SIGNATURE_ORIGINAL_CHANGED' USING ERRCODE='23514';END IF;
  NEW.original_source=source;
 ELSE
  IF aud.changes->>'state' IS DISTINCT FROM NEW.state THEN RAISE EXCEPTION 'WORK_SIGNATURE_DISPATCH_INVALID' USING ERRCODE='23514';END IF;
  -- Late observations survive expiry/contact changes. This is current source
  -- comparison only,never a retroactive claim that bytes were safe or sent.
  source=public.work_signature_original_source(a.id,started.original_copy_id);NEW.source_current=source IS NOT NULL AND source IS NOT DISTINCT FROM started.original_source;
 END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER work_signature_dispatch_guard BEFORE INSERT ON public.work_signature_dispatch_starts FOR EACH ROW EXECUTE FUNCTION public.work_signature_dispatch_guard();
CREATE TRIGGER work_signature_dispatch_guard BEFORE INSERT ON public.work_signature_dispatch_outcomes FOR EACH ROW EXECUTE FUNCTION public.work_signature_dispatch_guard();
CREATE FUNCTION public.work_signature_dispatch_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE event_action text:=CASE WHEN TG_TABLE_NAME='work_signature_dispatch_starts' THEN 'work.signature.dispatch.started' ELSE 'work.signature.dispatch.observed' END;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events o ON o.academy_id=a.academy_id AND o.request_id=a.request_id AND o.entity_id=a.entity_id AND o.event_type=a.action AND o.created_at=transaction_timestamp() WHERE a.academy_id=NEW.academy_id AND a.id=NEW.audit_id AND a.entity_id=NEW.id AND a.actor_id=NEW.actor_id AND a.action=event_action AND a.created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'WORK_SIGNATURE_DISPATCH_AUDIT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
ALTER FUNCTION public.work_signature_dispatch_complete() OWNER TO kavosh_event_policy;
CREATE CONSTRAINT TRIGGER work_signature_dispatch_complete AFTER INSERT ON public.work_signature_dispatch_starts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_signature_dispatch_complete();
CREATE CONSTRAINT TRIGGER work_signature_dispatch_complete AFTER INSERT ON public.work_signature_dispatch_outcomes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_signature_dispatch_complete();
-- A reservation without a committed start can be upper-reviewed cancelled.
-- Both native cancellation and consumption take the SAME binding lock. An
-- uncertain or even actor-claimed not-attempted start stays consumed forever.
DO $$ DECLARE body text;needle text:='EXISTS(SELECT 1 FROM public.work_signature_send_attempts WHERE academy_id=r.academy_id AND request_id=r.id)';BEGIN
 body=pg_get_functiondef('public.work_signature_cancel_source(uuid)'::regprocedure);IF position(needle IN body)=0 THEN RAISE EXCEPTION 'WORK_CANCEL_SOURCE_CHANGED';END IF;
 EXECUTE replace(body,needle,'EXISTS(SELECT 1 FROM public.work_signature_send_attempts a JOIN public.work_signature_dispatch_starts s ON s.academy_id=a.academy_id AND s.attempt_id=a.id WHERE a.academy_id=r.academy_id AND a.request_id=r.id)');
END $$;
REVOKE ALL ON FUNCTION public.work_signature_original_source(uuid,uuid),public.work_signature_dispatch_guard(),public.work_signature_dispatch_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_original_source(uuid,uuid) TO kavosh_runtime;
-- Preserve both dispatch-time reviewed names/verified contacts as private,
-- per-start commitments. Later profile edits never rewrite who was invited.
CREATE TABLE identity.work_signature_signer_history(
 academy_id uuid NOT NULL,start_id uuid NOT NULL,request_id uuid NOT NULL,party_role text NOT NULL CHECK(party_role IN('worker','academy_representative')),signer_id uuid NOT NULL,
 name_commitment text NOT NULL CHECK(name_commitment~'^[a-f0-9]{64}$'),email_commitment text NOT NULL CHECK(email_commitment~'^[a-f0-9]{64}$'),phone_commitment text NOT NULL CHECK(phone_commitment~'^[a-f0-9]{64}$'),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,start_id,party_role),UNIQUE(academy_id,start_id,signer_id),
 FOREIGN KEY(academy_id,start_id) REFERENCES public.work_signature_dispatch_starts(academy_id,id),
 FOREIGN KEY(academy_id,request_id) REFERENCES public.work_signature_send_requests(academy_id,id)
);
REVOKE ALL ON identity.work_signature_signer_history FROM PUBLIC;
GRANT SELECT,INSERT ON identity.work_signature_signer_history TO kavosh_identity_policy;
GRANT SELECT(academy_id,id,request_id) ON public.work_signature_send_attempts TO kavosh_identity_policy;
CREATE TRIGGER work_signature_signer_history_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.work_signature_signer_history FOR EACH ROW EXECUTE FUNCTION identity.signature_signer_history_guard();
CREATE FUNCTION identity.capture_work_signature_signers() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE request uuid;contacts jsonb;c jsonb;BEGIN
 SELECT request_id INTO request FROM public.work_signature_send_attempts WHERE academy_id=NEW.academy_id AND id=NEW.attempt_id;
 SELECT jsonb_agg(to_jsonb(x)) INTO contacts FROM public.work_signature_dispatch_contacts(request) x;
 IF contacts IS NULL OR jsonb_array_length(contacts)<>2 OR(SELECT count(DISTINCT lower(x->>'email')) FROM jsonb_array_elements(contacts) x)<>2 OR(SELECT count(DISTINCT x->>'phone_e164') FROM jsonb_array_elements(contacts) x)<>2 THEN RAISE EXCEPTION 'WORK_SIGNATURE_SIGNERS_NOT_CURRENT' USING ERRCODE='23514';END IF;
 FOR c IN SELECT * FROM jsonb_array_elements(contacts) LOOP
  INSERT INTO identity.work_signature_signer_history(academy_id,start_id,request_id,party_role,signer_id,name_commitment,email_commitment,phone_commitment)
  VALUES(NEW.academy_id,NEW.id,request,c->>'party_role',(c->>'person_id')::uuid,
   identity.signature_signer_digest(NEW.academy_id,NEW.id,(c->>'person_id')::uuid,'work:'||(c->>'party_role')||':name',c->>'legal_name'),
   identity.signature_signer_digest(NEW.academy_id,NEW.id,(c->>'person_id')::uuid,'work:'||(c->>'party_role')||':email',lower(btrim(c->>'email'))),
   identity.signature_signer_digest(NEW.academy_id,NEW.id,(c->>'person_id')::uuid,'work:'||(c->>'party_role')||':phone',c->>'phone_e164'));
 END LOOP;
 IF(SELECT count(*) FROM identity.work_signature_signer_history WHERE academy_id=NEW.academy_id AND start_id=NEW.id)<>2 THEN RAISE EXCEPTION 'WORK_SIGNATURE_SIGNERS_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE FUNCTION identity.work_signature_signer_matches(p_academy uuid,p_start uuid,p_role text,p_signer uuid,p_name text,p_email text,p_phone text)
 RETURNS TABLE(name_matches boolean,email_matches boolean,phone_matches boolean) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT p_name IS NOT NULL AND length(p_name)<=200 AND h.name_commitment=identity.signature_signer_digest(p_academy,p_start,p_signer,'work:'||p_role||':name',p_name),
 p_email IS NOT NULL AND length(p_email)<=254 AND h.email_commitment=identity.signature_signer_digest(p_academy,p_start,p_signer,'work:'||p_role||':email',lower(btrim(p_email))),
 p_phone IS NOT NULL AND p_phone~'^[+][1-9][0-9]{7,14}$' AND h.phone_commitment=identity.signature_signer_digest(p_academy,p_start,p_signer,'work:'||p_role||':phone',p_phone)
 FROM identity.work_signature_signer_history h WHERE h.academy_id=p_academy AND h.start_id=p_start AND h.party_role=p_role AND h.signer_id=p_signer
$$;
REVOKE ALL ON FUNCTION identity.capture_work_signature_signers(),identity.work_signature_signer_matches(uuid,uuid,text,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.work_signature_signer_matches(uuid,uuid,text,uuid,text,text,text) TO kavosh_identity_policy;
GRANT CREATE ON SCHEMA identity TO kavosh_identity_policy;
ALTER FUNCTION identity.capture_work_signature_signers() OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA identity FROM kavosh_identity_policy;
CREATE TRIGGER z_capture_work_signature_signers AFTER INSERT ON public.work_signature_dispatch_starts FOR EACH ROW EXECUTE FUNCTION identity.capture_work_signature_signers();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 221 $$;

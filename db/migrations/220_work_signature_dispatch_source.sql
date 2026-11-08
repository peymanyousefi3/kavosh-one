INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('work-signatures.execute','Read private worker signing execution source and reserve one manifest','Finance',true,ARRAY['hub','person','country','region','city']);
-- Narrow hydration only. Runtime never gains identity-table access. The API
-- independently checks current work,template,file and execution rights and
-- rechecks the complete current source before committing its read audit.
GRANT SELECT(academy_id,id,preparation_id,approval_id,created_by,authorization_until,prior_id,academy_signer_legal_name) ON public.work_signature_send_requests TO kavosh_identity_policy;
GRANT SELECT(academy_id,request_id) ON public.work_signature_send_cancellations TO kavosh_identity_policy;
GRANT SELECT(academy_id,id,worker_id,academy_signer_id,source_snapshot) ON public.work_agreement_preparations TO kavosh_identity_policy;
GRANT CREATE ON SCHEMA public TO kavosh_identity_policy;
CREATE FUNCTION public.work_signature_dispatch_contacts(p_request uuid)
RETURNS TABLE(party_role text,person_id uuid,legal_name text,email text,phone_e164 text,contact_fingerprint text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH contacts AS MATERIALIZED(
  SELECT party.role,party.person_id,party.legal_name,u.email,u."phoneNumber" phone,party.fingerprint
  FROM public.work_signature_send_requests r JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id
  JOIN public.approval_requests a ON a.academy_id=r.academy_id AND a.id=r.approval_id AND a.status='applied' AND a.action='work.signature.send.request' AND a.target_id=r.id AND a.reviewer_id=r.created_by
  CROSS JOIN LATERAL(VALUES('worker'::text,w.worker_id,w.source_snapshot#>>'{engagement,legalWorkerName}',w.source_snapshot#>>'{workerSigner,contactFingerprint}'),('academy_representative'::text,w.academy_signer_id,r.academy_signer_legal_name,w.source_snapshot#>>'{academySigner,contactFingerprint}')) party(role,person_id,legal_name,fingerprint)
  JOIN public.people p ON p.academy_id=r.academy_id AND p.id=party.person_id AND p.kind='human' AND p.status='active'
  JOIN identity."user" u ON u.id=p.auth_user_id AND u."emailVerified" AND u."phoneNumberVerified" AND u."phoneNumber"~'^[+][1-9][0-9]{7,14}$'
  WHERE r.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND r.id=p_request AND r.authorization_until>statement_timestamp()
   AND NOT EXISTS(SELECT 1 FROM public.work_signature_send_cancellations c WHERE c.academy_id=r.academy_id AND c.request_id=r.id)
   AND NOT EXISTS(SELECT 1 FROM public.work_signature_send_requests next WHERE next.academy_id=r.academy_id AND next.prior_id=r.id)
   AND party.legal_name IS NOT NULL AND length(btrim(party.legal_name)) BETWEEN 1 AND 200
   AND party.fingerprint=encode(sha256(convert_to(jsonb_build_array(1,r.academy_id,p.id,u.id,u.email,u."phoneNumber",u."emailVerified",u."phoneNumberVerified")::text,'UTF8')),'hex')
 ) SELECT role,person_id,legal_name,email,phone,fingerprint FROM contacts WHERE(SELECT count(*) FROM contacts)=2 ORDER BY role
$$;
ALTER FUNCTION public.work_signature_dispatch_contacts(uuid) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_identity_policy;
REVOKE ALL ON FUNCTION public.work_signature_dispatch_contacts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_dispatch_contacts(uuid) TO kavosh_runtime;

CREATE TABLE public.work_signature_send_attempts(
 academy_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,actor_id uuid NOT NULL,audit_id uuid NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),request_bytes integer NOT NULL CHECK(request_bytes BETWEEN 1 AND 16777216),document_sha256 text NOT NULL CHECK(document_sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),FOREIGN KEY(academy_id,request_id) REFERENCES public.work_signature_send_requests(academy_id,id),FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id)
);
ALTER TABLE public.work_signature_send_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_signature_send_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.work_signature_send_attempts USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.work_signature_send_attempts TO kavosh_runtime;
GRANT INSERT(academy_id,id,request_id,actor_id,audit_id,request_sha256,request_bytes,document_sha256) ON public.work_signature_send_attempts TO kavosh_runtime;
CREATE TRIGGER immutable_work_attempt BEFORE UPDATE OR DELETE ON public.work_signature_send_attempts FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable();
CREATE FUNCTION public.work_signature_attempt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record;a record;BEGIN
 SELECT * INTO r FROM public.work_signature_send_requests WHERE academy_id=NEW.academy_id AND id=NEW.request_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'WORK_SIGNATURE_ATTEMPT_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':work-signature-send:'||r.binding_id::text,41));
 SELECT * INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id AND entity_id=NEW.id AND action='work.signature.send.attempt_reserved' AND actor_id=NEW.actor_id AND created_at=transaction_timestamp();
 IF a.id IS NULL OR a.changes->>'requestId' IS DISTINCT FROM NEW.request_id::text OR a.changes->>'severity' IS DISTINCT FROM 'critical' OR a.changes->'externalRequestMade' IS DISTINCT FROM 'false'::jsonb OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.actor_id AND kind=a.actor_kind AND status='active') OR NOT public.work_signature_send_current(r.id) OR NEW.document_sha256 IS DISTINCT FROM r.context#>>'{source,content,content,document,sha256}' THEN RAISE EXCEPTION 'WORK_SIGNATURE_ATTEMPT_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER work_signature_attempt_guard BEFORE INSERT ON public.work_signature_send_attempts FOR EACH ROW EXECUTE FUNCTION public.work_signature_attempt_guard();
CREATE FUNCTION public.work_signature_attempt_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events o ON o.academy_id=a.academy_id AND o.request_id=a.request_id AND o.entity_id=a.entity_id AND o.event_type=a.action AND o.created_at=transaction_timestamp() WHERE a.academy_id=NEW.academy_id AND a.id=NEW.audit_id AND a.entity_id=NEW.id AND a.actor_id=NEW.actor_id AND a.action='work.signature.send.attempt_reserved' AND a.created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'WORK_SIGNATURE_ATTEMPT_AUDIT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
ALTER FUNCTION public.work_signature_attempt_complete() OWNER TO kavosh_event_policy;
CREATE CONSTRAINT TRIGGER work_signature_attempt_complete AFTER INSERT ON public.work_signature_send_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_signature_attempt_complete();
-- Reservation is not proof of transport. An uncertain/consumed reservation
-- must not be cancelled and silently turned into a fresh external send.
DO $$ DECLARE body text;needle text:='IF r.id IS NULL OR EXISTS';BEGIN
 body=pg_get_functiondef('public.work_signature_cancel_source(uuid)'::regprocedure);IF position(needle IN body)=0 THEN RAISE EXCEPTION 'WORK_CANCEL_SOURCE_CHANGED';END IF;
 EXECUTE replace(body,needle,'IF r.id IS NULL OR EXISTS(SELECT 1 FROM public.work_signature_send_attempts WHERE academy_id=r.academy_id AND request_id=r.id) OR EXISTS');
END $$;
REVOKE ALL ON FUNCTION public.work_signature_attempt_guard(),public.work_signature_attempt_complete() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 220 $$;

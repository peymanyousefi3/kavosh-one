-- Completion reconciliation needs the VERIFIED signer at dispatch time,not
-- whichever contact happens to be current later. Keep only private,per-start
-- domain-separated commitments;no duplicate plaintext contacts or public hashes.
CREATE TABLE identity.signature_signer_history(
 academy_id uuid NOT NULL,start_id uuid NOT NULL,request_id uuid NOT NULL,package_id uuid NOT NULL,signer_id uuid NOT NULL,
 name_commitment text NOT NULL CHECK(name_commitment~'^[a-f0-9]{64}$'),email_commitment text NOT NULL CHECK(email_commitment~'^[a-f0-9]{64}$'),phone_commitment text NOT NULL CHECK(phone_commitment~'^[a-f0-9]{64}$'),
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,start_id),
 FOREIGN KEY(academy_id,start_id) REFERENCES public.signature_dispatch_starts(academy_id,id)
);
REVOKE ALL ON identity.signature_signer_history FROM PUBLIC;
GRANT SELECT,INSERT ON identity.signature_signer_history TO kavosh_identity_policy;
GRANT SELECT(academy_id,id,request_id) ON public.signature_send_attempts TO kavosh_identity_policy;
CREATE FUNCTION identity.signature_signer_digest(p_academy uuid,p_start uuid,p_signer uuid,p_kind text,p_value text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array('kavosh-signature-signer-v1',p_academy,p_start,p_signer,p_kind,p_value)::text,'UTF8')),'hex')
$$;
CREATE FUNCTION identity.signature_signer_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SIGNATURE_SIGNER_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF current_user<>'kavosh_identity_policy' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'SIGNATURE_SIGNER_CAPTURE_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.captured_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER signature_signer_history_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.signature_signer_history FOR EACH ROW EXECUTE FUNCTION identity.signature_signer_history_guard();
CREATE FUNCTION identity.capture_signature_signer() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE request uuid;package uuid;contact record;BEGIN
 SELECT a.request_id INTO request FROM public.signature_send_attempts a WHERE a.academy_id=NEW.academy_id AND a.id=NEW.attempt_id;
 SELECT r.package_id INTO package FROM public.signature_send_requests r WHERE r.academy_id=NEW.academy_id AND r.id=request;
 SELECT * INTO contact FROM public.signature_dispatch_contact(request);
 IF package IS NULL OR contact.person_id IS NULL OR contact.legal_name IS NULL OR contact.email IS NULL OR contact.phone_e164 IS NULL THEN RAISE EXCEPTION 'SIGNATURE_SIGNER_NOT_CURRENT' USING ERRCODE='23514';END IF;
 INSERT INTO identity.signature_signer_history(academy_id,start_id,request_id,package_id,signer_id,name_commitment,email_commitment,phone_commitment)
 VALUES(NEW.academy_id,NEW.id,request,package,contact.person_id,
 identity.signature_signer_digest(NEW.academy_id,NEW.id,contact.person_id,'name',contact.legal_name),
 identity.signature_signer_digest(NEW.academy_id,NEW.id,contact.person_id,'email',lower(btrim(contact.email))),
 identity.signature_signer_digest(NEW.academy_id,NEW.id,contact.person_id,'phone',contact.phone_e164));RETURN NULL;
END $$;
-- Private comparison primitive for a future separately held reconciliation
-- role. Not callable by web,identity login,delivery,bots or current workers.
-- No backfill:old starts without recorded evidence remain unknown.
CREATE FUNCTION identity.signature_signer_matches(p_academy uuid,p_start uuid,p_signer uuid,p_name text,p_email text,p_phone text)
 RETURNS TABLE(name_matches boolean,email_matches boolean,phone_matches boolean) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT p_name IS NOT NULL AND length(p_name)<=200 AND h.name_commitment=identity.signature_signer_digest(p_academy,p_start,p_signer,'name',p_name),
 p_email IS NOT NULL AND length(p_email)<=254 AND h.email_commitment=identity.signature_signer_digest(p_academy,p_start,p_signer,'email',lower(btrim(p_email))),
 p_phone IS NOT NULL AND p_phone~'^[+][1-9][0-9]{7,14}$' AND h.phone_commitment=identity.signature_signer_digest(p_academy,p_start,p_signer,'phone',p_phone)
 FROM identity.signature_signer_history h WHERE h.academy_id=p_academy AND h.start_id=p_start AND h.signer_id=p_signer
$$;
REVOKE ALL ON FUNCTION identity.signature_signer_digest(uuid,uuid,uuid,text,text),identity.signature_signer_history_guard(),identity.capture_signature_signer(),identity.signature_signer_matches(uuid,uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.signature_signer_digest(uuid,uuid,uuid,text,text),identity.signature_signer_matches(uuid,uuid,uuid,text,text,text) TO kavosh_identity_policy;
GRANT CREATE ON SCHEMA identity TO kavosh_identity_policy;
ALTER FUNCTION identity.capture_signature_signer() OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA identity FROM kavosh_identity_policy;
CREATE TRIGGER z_capture_signature_signer AFTER INSERT ON public.signature_dispatch_starts FOR EACH ROW EXECUTE FUNCTION identity.capture_signature_signer();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 204 $$;

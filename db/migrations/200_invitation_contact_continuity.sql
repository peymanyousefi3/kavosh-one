-- Keep the original approved invitation/recipient intact after an account's
-- verified email replacement. A binding is NOT consumption,activation,new
-- authority or a transfer. The private token and all original guards remain.
-- Deliberately no invitation/person FK here:contact updates must not wait on
-- school/invitation row locks. Acceptance rechecks the exact live source.
CREATE TABLE identity.invite_account_bindings(
 token_hash text PRIMARY KEY CHECK(token_hash~'^[a-f0-9]{64}$'),user_id uuid NOT NULL REFERENCES identity."user"(id),
 academy_id uuid NOT NULL,person_id uuid NOT NULL,email text NOT NULL,master boolean NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON identity.invite_account_bindings FROM PUBLIC;
GRANT SELECT ON identity.invite_account_bindings TO kavosh_identity_policy;
GRANT INSERT ON identity.invite_account_bindings TO kavosh_identity_policy;
GRANT SELECT(email,user_id,expires_at) ON identity.retired_emails TO kavosh_identity_policy;
CREATE FUNCTION identity.invite_account_binding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF current_user<>'kavosh_identity_policy' THEN RAISE EXCEPTION 'INVITATION_CONTACT_PRIVATE_WRITER_REQUIRED' USING ERRCODE='23514';END IF;
  IF pg_trigger_depth()<2 OR NOT EXISTS(SELECT 1 FROM identity.retired_emails r WHERE r.email=NEW.email AND r.user_id=NEW.user_id AND r.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'INVITATION_CONTACT_CHANGE_REQUIRED' USING ERRCODE='23514';END IF;
  -- A concurrent cancellation/replacement must not fail the contact change.
  -- No surviving binding is authority unless this exact source still matches.
  IF NOT EXISTS(SELECT 1 FROM identity.invites i WHERE i.token_hash=NEW.token_hash AND i.academy_id=NEW.academy_id AND i.person_id=NEW.person_id AND i.email=NEW.email AND i.master=NEW.master AND i.expires_at=NEW.expires_at AND i.consumed_at IS NULL AND i.expires_at>clock_timestamp()) THEN RETURN NULL;END IF;
  NEW.created_at=clock_timestamp();RETURN NEW;
 END IF;
 IF TG_OP='DELETE' AND pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='identity."user"'::regclass),'member') AND NOT EXISTS(SELECT 1 FROM identity.invites i WHERE i.token_hash=OLD.token_hash AND i.consumed_at IS NULL AND i.expires_at>clock_timestamp()) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'INVITATION_CONTACT_BINDING_IMMUTABLE' USING ERRCODE='23514';
END $$;
CREATE TRIGGER invite_account_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.invite_account_bindings FOR EACH ROW EXECUTE FUNCTION identity.invite_account_binding_guard();
CREATE FUNCTION identity.bind_invites_after_email_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE n integer;BEGIN
 IF NEW.email IS NOT DISTINCT FROM OLD.email OR NOT OLD."emailVerified" OR NOT coalesce(OLD."phoneNumberVerified",false) THEN RETURN NULL;END IF;
 INSERT INTO identity.invite_account_bindings(token_hash,user_id,academy_id,person_id,email,master,expires_at)
 SELECT i.token_hash,OLD.id,i.academy_id,i.person_id,i.email,i.master,i.expires_at FROM identity.invites i
 JOIN public.people p ON p.academy_id=i.academy_id AND p.id=i.person_id AND p.kind='human' AND p.auth_user_id IS NULL AND lower(btrim(p.email))=i.email
 -- Availability never turns identity continuity into permission to join.
 -- The unchanged acceptance guards still reject disabled people/schools.
 JOIN public.academies a ON a.id=i.academy_id AND(a.master_person_id=i.person_id)=i.master
 WHERE i.email=OLD.email AND i.consumed_at IS NULL AND i.expires_at>clock_timestamp()
 ON CONFLICT(token_hash) DO NOTHING;GET DIAGNOSTICS n=ROW_COUNT;
 IF n>0 THEN INSERT INTO identity.security_events(user_id,event) VALUES(OLD.id,'invitation.contact_bound');END IF;RETURN NULL;
END $$;
GRANT CREATE ON SCHEMA identity TO kavosh_identity_policy;
ALTER FUNCTION identity.bind_invites_after_email_change() OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA identity FROM kavosh_identity_policy;
-- Run after finish_email_change records retirement and revokes sessions.
CREATE TRIGGER z_bind_invites_after_email_change AFTER UPDATE OF email ON identity."user" FOR EACH ROW EXECUTE FUNCTION identity.bind_invites_after_email_change();
CREATE FUNCTION identity.invitation_account_matches(p_hash text,p_user uuid,p_email text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT(NOT EXISTS(SELECT 1 FROM identity.invite_account_bindings b WHERE b.token_hash=i.token_hash) AND i.email=lower(p_email)) OR EXISTS(
  SELECT 1 FROM identity.invite_account_bindings b WHERE b.token_hash=i.token_hash AND b.user_id=p_user AND b.academy_id=i.academy_id AND b.person_id=i.person_id AND b.email=i.email AND b.master=i.master AND b.expires_at=i.expires_at)
 FROM identity.invites i WHERE i.token_hash=p_hash
$$;
REVOKE ALL ON FUNCTION identity.invite_account_binding_guard(),identity.bind_invites_after_email_change(),identity.invitation_account_matches(text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.invitation_account_matches(text,uuid,text) TO kavosh_identity_policy;
-- Identity may read only the version marker,not inherit runtime/table access.
GRANT EXECUTE ON FUNCTION public.schema_revision() TO kavosh_identity;
-- Preserve BOTH identity/source checks and the existing school/user/session/
-- invitation lock order,master MFA transition,one-person-per-school binding,
-- original recipient and current school/status/audit/outbox checks verbatim.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('identity.accept_invite(text,uuid,uuid)'::regprocedure);
 needle='v.email=lower(u.email)';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'INVITATION_CONTACT_INITIAL_SOURCE_UNEXPECTED';END IF;
 body=replace(body,needle,'identity.invitation_account_matches(v.token_hash,p_user,u.email)');
 needle='token_hash=p_hash AND email=lower(u.email)';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'INVITATION_CONTACT_FINAL_SOURCE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'token_hash=p_hash AND identity.invitation_account_matches(token_hash,p_user,u.email)');
 body=pg_get_functiondef('identity.inspect_invite(text,text)'::regprocedure);needle='i.email=lower(btrim(p_email))';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'INVITATION_CONTACT_SIGNUP_SOURCE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,needle||' AND NOT EXISTS(SELECT 1 FROM identity.invite_account_bindings b WHERE b.token_hash=i.token_hash)');
 body=pg_get_functiondef('identity.cleanup_expired_auth()'::regprocedure);needle='DELETE FROM identity.invites WHERE expires_at<now()-interval ''7 days'';';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'INVITATION_CONTACT_CLEANUP_SOURCE_UNEXPECTED';END IF;
 -- Keep a stale binding if a separately held owner changed a still-live
 -- parent:removing it would restore address-only acceptance for that token.
 EXECUTE replace(body,needle,needle||'DELETE FROM identity.invite_account_bindings b WHERE NOT EXISTS(SELECT 1 FROM identity.invites i WHERE i.token_hash=b.token_hash);');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 200 $$;

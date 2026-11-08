-- Private,session-bound phone replacement. Email codes are keyed digests;
-- neither code nor password is persisted here. Existing OTP verification is
-- still required;this permission alone cannot change an account's phone.
CREATE TABLE identity.phone_change_requests(
 user_id uuid PRIMARY KEY REFERENCES identity."user"(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES identity.session(id) ON DELETE CASCADE,
 request_id uuid NOT NULL UNIQUE,code_hash text NOT NULL CHECK(code_hash~'^[a-f0-9]{64}$'),
 phone text NOT NULL CHECK(phone~'^[+][1-9][0-9]{7,14}$'),state text NOT NULL CHECK(state IN('pending','authorized')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=2048),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,authorized_at timestamptz,
 CHECK((state='authorized')=(authorized_at IS NOT NULL)),CHECK(expires_at<=created_at+interval '15 minutes')
);
REVOKE ALL ON identity.phone_change_requests FROM PUBLIC;
GRANT SELECT ON identity.phone_change_requests TO kavosh_identity;
CREATE INDEX phone_change_expiry ON identity.phone_change_requests(expires_at);
CREATE FUNCTION identity.phone_change_source(p_user uuid,p_session uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('userId',u.id,'sessionId',s.id,'email',u.email,'phone',u."phoneNumber",'passwordSha256',encode(sha256(convert_to(c.password,'UTF8')),'hex'),'mfaRequired',u."mfaRequired",'twoFactorEnabled',coalesce(u."twoFactorEnabled",false))
 FROM identity."user" u JOIN identity.session s ON s."userId"=u.id AND s.id=p_session
 CROSS JOIN LATERAL(SELECT count(*) n,max(password) password FROM identity.account WHERE "userId"=u.id AND "providerId"='credential') c
 WHERE u.id=p_user AND u."emailVerified" AND coalesce(u."phoneNumberVerified",false) AND c.n=1 AND c.password IS NOT NULL
 AND s."expiresAt">clock_timestamp() AND s."createdAt"<=clock_timestamp() AND s."createdAt">clock_timestamp()-interval '15 minutes'
 AND(NOT(coalesce(u."twoFactorEnabled",false) OR u."mfaRequired") OR s."mfaVerified")
$$;
CREATE FUNCTION identity.prepare_phone_change(p_user uuid,p_session uuid,p_request uuid,p_phone text,p_hash text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE b jsonb;at timestamptz;BEGIN
 IF p_request IS NULL OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR p_phone IS NULL OR p_phone!~'^[+][1-9][0-9]{7,14}$' THEN RETURN 'INVALID_PHONE_CHANGE';END IF;
 PERFORM id FROM identity."user" WHERE id=p_user FOR UPDATE;b=identity.phone_change_source(p_user,p_session);IF b IS NULL THEN RETURN 'VERIFICATION_REQUIRED';END IF;
 IF b->>'phone'=p_phone THEN RETURN 'PHONE_UNCHANGED';END IF;
 IF EXISTS(SELECT 1 FROM identity."user" WHERE "phoneNumber"=p_phone AND id<>p_user) THEN RETURN 'PHONE_UNAVAILABLE';END IF;
 at=clock_timestamp();INSERT INTO identity.phone_change_requests(user_id,session_id,request_id,phone,code_hash,state,attempts,source_snapshot,created_at,expires_at,authorized_at)
 VALUES(p_user,p_session,p_request,p_phone,p_hash,'pending',0,b,at,at+interval '15 minutes',NULL)
 ON CONFLICT(user_id) DO UPDATE SET session_id=excluded.session_id,request_id=excluded.request_id,phone=excluded.phone,code_hash=excluded.code_hash,state='pending',attempts=0,source_snapshot=excluded.source_snapshot,created_at=excluded.created_at,expires_at=excluded.expires_at,authorized_at=NULL;
 INSERT INTO identity.security_events(user_id,event) VALUES(p_user,'phone.change.requested');RETURN 'PREPARED';
END $$;
CREATE FUNCTION identity.authorize_phone_change(p_user uuid,p_session uuid,p_request uuid,p_hash text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r identity.phone_change_requests;b jsonb;BEGIN
 PERFORM id FROM identity."user" WHERE id=p_user FOR UPDATE;SELECT * INTO r FROM identity.phone_change_requests WHERE user_id=p_user AND session_id=p_session AND request_id=p_request FOR UPDATE;
 IF NOT FOUND OR r.state<>'pending' OR r.expires_at<=clock_timestamp() OR r.attempts>=5 THEN RETURN false;END IF;
 b=identity.phone_change_source(p_user,p_session);IF b IS NULL OR b IS DISTINCT FROM r.source_snapshot THEN RETURN false;END IF;
 IF p_hash IS DISTINCT FROM r.code_hash THEN UPDATE identity.phone_change_requests SET attempts=attempts+1,expires_at=CASE WHEN attempts>=4 THEN least(expires_at,clock_timestamp()) ELSE expires_at END WHERE user_id=p_user;RETURN false;END IF;
 UPDATE identity.phone_change_requests SET state='authorized',authorized_at=clock_timestamp(),expires_at=least(expires_at,clock_timestamp()+interval '5 minutes') WHERE user_id=p_user;
 INSERT INTO identity.security_events(user_id,event) VALUES(p_user,'phone.change.authorized');RETURN true;
END $$;
CREATE FUNCTION identity.cancel_phone_change(p_user uuid,p_session uuid,p_request uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM id FROM identity."user" WHERE id=p_user FOR UPDATE;
 DELETE FROM identity.phone_change_requests WHERE user_id=p_user AND session_id=p_session AND request_id=p_request;IF NOT FOUND THEN RETURN false;END IF;
 INSERT INTO identity.security_events(user_id,event) VALUES(p_user,'phone.change.cancelled');RETURN true;
END $$;
CREATE FUNCTION identity.guard_phone_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r identity.phone_change_requests;BEGIN
 IF OLD."phoneNumber" IS NULL OR NEW."phoneNumber" IS NOT DISTINCT FROM OLD."phoneNumber" THEN RETURN NEW;END IF;
 -- The separately held table/migration owner can perform emergency repair;
 -- the web identity role is explicitly prohibited from inheriting that owner.
 IF pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='identity."user"'::regclass),'member') THEN RETURN NEW;END IF;
 -- Permit writers already lock this user. Freeze the source session before
 -- rechecking credentials. Password writes must delete that session in their
 -- BEFORE trigger,so this orders the two changes without the opposite
 -- account->session / user->account lock order or broader recovery-row grants.
 -- Refuse an in-flight session writer rather than wait while holding this
 -- user:the library may create a replacement session needing its user FK.
 SELECT * INTO r FROM identity.phone_change_requests WHERE user_id=OLD.id AND phone=NEW."phoneNumber" AND state='authorized' AND expires_at>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'PHONE_CHANGE_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 PERFORM id FROM identity.session WHERE id=r.session_id AND "userId"=OLD.id FOR SHARE SKIP LOCKED;
 IF NOT FOUND OR NEW."phoneNumberVerified" IS DISTINCT FROM true OR NEW.email IS DISTINCT FROM OLD.email OR NEW."emailVerified" IS DISTINCT FROM true OR identity.phone_change_source(OLD.id,r.session_id) IS DISTINCT FROM r.source_snapshot THEN RAISE EXCEPTION 'PHONE_CHANGE_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
-- Must run before enforce_user_security deletes the source session/permit.
CREATE TRIGGER a_phone_change_approval BEFORE UPDATE OF "phoneNumber" ON identity."user" FOR EACH ROW EXECUTE FUNCTION identity.guard_phone_change();
CREATE FUNCTION identity.finish_phone_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF OLD."phoneNumber" IS NOT NULL AND NEW."phoneNumber" IS DISTINCT FROM OLD."phoneNumber" THEN
  DELETE FROM identity.verification WHERE value=OLD.id::text;
  INSERT INTO identity.security_events(user_id,event) VALUES(NEW.id,'phone.changed');
 END IF;RETURN NULL;
END $$;
CREATE TRIGGER finish_phone_change AFTER UPDATE OF "phoneNumber" ON identity."user" FOR EACH ROW EXECUTE FUNCTION identity.finish_phone_change();
CREATE OR REPLACE FUNCTION identity.cleanup_expired_auth() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 DELETE FROM identity.session WHERE "expiresAt"<now();DELETE FROM identity.verification WHERE "expiresAt"<now();
 DELETE FROM identity.phone_challenges WHERE expires_at<now();DELETE FROM identity.phone_change_requests WHERE expires_at<now();
 DELETE FROM identity.auth_budgets WHERE window_start<now()-interval '2 days';DELETE FROM identity.invites WHERE expires_at<now()-interval '7 days';
 DELETE FROM identity.delivery_outbox WHERE outcome IS NOT NULL AND created_at<now()-interval '7 days';
END $$;
REVOKE ALL ON FUNCTION identity.phone_change_source(uuid,uuid),identity.prepare_phone_change(uuid,uuid,uuid,text,text),identity.authorize_phone_change(uuid,uuid,uuid,text),identity.cancel_phone_change(uuid,uuid,uuid),identity.guard_phone_change(),identity.finish_phone_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.phone_change_source(uuid,uuid),identity.prepare_phone_change(uuid,uuid,uuid,text,text),identity.authorize_phone_change(uuid,uuid,uuid,text),identity.cancel_phone_change(uuid,uuid,uuid) TO kavosh_identity;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 197 $$;

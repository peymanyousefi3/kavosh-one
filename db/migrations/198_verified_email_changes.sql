-- Contact mutations pin the same source session before touching recovery rows.
-- A password change may delete it and then create a replacement (user FK).
-- Refuse contention instead of waiting on that writer while holding its user.
CREATE OR REPLACE FUNCTION identity.prepare_phone_change(p_user uuid,p_session uuid,p_request uuid,p_phone text,p_hash text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE b jsonb;at timestamptz;BEGIN
 IF p_request IS NULL OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR p_phone IS NULL OR p_phone!~'^[+][1-9][0-9]{7,14}$' THEN RETURN 'INVALID_PHONE_CHANGE';END IF;
 PERFORM id FROM identity."user" WHERE id=p_user FOR UPDATE;
 PERFORM id FROM identity.session WHERE id=p_session AND "userId"=p_user FOR SHARE SKIP LOCKED;IF NOT FOUND THEN RETURN 'VERIFICATION_REQUIRED';END IF;
 b=identity.phone_change_source(p_user,p_session);IF b IS NULL THEN RETURN 'VERIFICATION_REQUIRED';END IF;
 IF b->>'phone'=p_phone THEN RETURN 'PHONE_UNCHANGED';END IF;
 IF EXISTS(SELECT 1 FROM identity."user" WHERE "phoneNumber"=p_phone AND id<>p_user) THEN RETURN 'PHONE_UNAVAILABLE';END IF;
 at=clock_timestamp();INSERT INTO identity.phone_change_requests(user_id,session_id,request_id,phone,code_hash,state,attempts,source_snapshot,created_at,expires_at,authorized_at)
 VALUES(p_user,p_session,p_request,p_phone,p_hash,'pending',0,b,at,at+interval '15 minutes',NULL)
 ON CONFLICT(user_id) DO UPDATE SET session_id=excluded.session_id,request_id=excluded.request_id,phone=excluded.phone,code_hash=excluded.code_hash,state='pending',attempts=0,source_snapshot=excluded.source_snapshot,created_at=excluded.created_at,expires_at=excluded.expires_at,authorized_at=NULL;
 INSERT INTO identity.security_events(user_id,event) VALUES(p_user,'phone.change.requested');RETURN 'PREPARED';
END $$;
CREATE OR REPLACE FUNCTION identity.authorize_phone_change(p_user uuid,p_session uuid,p_request uuid,p_hash text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r identity.phone_change_requests;b jsonb;BEGIN
 PERFORM id FROM identity."user" WHERE id=p_user FOR UPDATE;
 PERFORM id FROM identity.session WHERE id=p_session AND "userId"=p_user FOR SHARE SKIP LOCKED;IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO r FROM identity.phone_change_requests WHERE user_id=p_user AND session_id=p_session AND request_id=p_request;
 IF NOT FOUND OR r.state<>'pending' OR r.expires_at<=clock_timestamp() OR r.attempts>=5 THEN RETURN false;END IF;
 b=identity.phone_change_source(p_user,p_session);IF b IS NULL OR b IS DISTINCT FROM r.source_snapshot THEN RETURN false;END IF;
 IF p_hash IS DISTINCT FROM r.code_hash THEN UPDATE identity.phone_change_requests SET attempts=attempts+1,expires_at=CASE WHEN attempts>=4 THEN least(expires_at,clock_timestamp()) ELSE expires_at END WHERE user_id=p_user;RETURN false;END IF;
 UPDATE identity.phone_change_requests SET state='authorized',authorized_at=clock_timestamp(),expires_at=least(expires_at,clock_timestamp()+interval '5 minutes') WHERE user_id=p_user;
 INSERT INTO identity.security_events(user_id,event) VALUES(p_user,'phone.change.authorized');RETURN true;
END $$;
CREATE OR REPLACE FUNCTION identity.cancel_phone_change(p_user uuid,p_session uuid,p_request uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM id FROM identity."user" WHERE id=p_user FOR UPDATE;
 PERFORM id FROM identity.session WHERE id=p_session AND "userId"=p_user FOR SHARE SKIP LOCKED;IF NOT FOUND THEN RETURN false;END IF;
 DELETE FROM identity.phone_change_requests WHERE user_id=p_user AND session_id=p_session AND request_id=p_request;IF NOT FOUND THEN RETURN false;END IF;
 INSERT INTO identity.security_events(user_id,event) VALUES(p_user,'phone.change.cancelled');RETURN true;
END $$;

CREATE TABLE identity.email_change_requests(
 user_id uuid PRIMARY KEY REFERENCES identity."user"(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES identity.session(id) ON DELETE CASCADE,
 request_id uuid NOT NULL UNIQUE,email text NOT NULL CHECK(length(email)<=254 AND email=lower(btrim(email)) AND email~'^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+[.][^@[:space:][:cntrl:]]+$'),
 state text NOT NULL CHECK(state IN('pending_current','pending_new')),
 current_code_hash text NOT NULL CHECK(current_code_hash~'^[a-f0-9]{64}$'),new_code_hash text CHECK(new_code_hash~'^[a-f0-9]{64}$'),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=2048),
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 CHECK((state='pending_new')=(new_code_hash IS NOT NULL)),CHECK(expires_at<=created_at+interval '15 minutes')
);
-- Better Auth's initial email-verification JWT is address-bound,not user-ID
-- bound. Do not release an old address until every pre-change 15-minute link
-- has expired. No permanent address reservation or plaintext token archive.
CREATE TABLE identity.retired_emails(email text PRIMARY KEY,expires_at timestamptz NOT NULL);
CREATE INDEX email_change_expiry ON identity.email_change_requests(expires_at);
CREATE INDEX retired_email_expiry ON identity.retired_emails(expires_at);
REVOKE ALL ON identity.email_change_requests,identity.retired_emails FROM PUBLIC;
GRANT SELECT ON identity.email_change_requests TO kavosh_identity;
CREATE FUNCTION identity.email_available(p_email text,p_user uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM identity."user" WHERE email=p_email AND id IS DISTINCT FROM p_user)
 AND NOT EXISTS(SELECT 1 FROM identity.retired_emails WHERE email=p_email AND expires_at>clock_timestamp())
$$;
CREATE FUNCTION identity.guard_email_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='UPDATE' AND NEW.email IS NOT DISTINCT FROM OLD.email THEN RETURN NEW;END IF;
 IF NOT identity.email_available(NEW.email,NEW.id) THEN RAISE EXCEPTION 'EMAIL_UNAVAILABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND NOT pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='identity."user"'::regclass),'member') THEN RAISE EXCEPTION 'EMAIL_CHANGE_REQUIRES_RECOVERY' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_email_change_approval BEFORE INSERT OR UPDATE OF email ON identity."user" FOR EACH ROW EXECUTE FUNCTION identity.guard_email_change();
CREATE FUNCTION identity.finish_email_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.email IS DISTINCT FROM OLD.email THEN
  INSERT INTO identity.retired_emails(email,expires_at) VALUES(OLD.email,clock_timestamp()+interval '16 minutes') ON CONFLICT(email) DO UPDATE SET expires_at=greatest(identity.retired_emails.expires_at,excluded.expires_at);
  DELETE FROM identity.session WHERE "userId"=NEW.id;
  DELETE FROM identity.verification WHERE value=NEW.id::text;
  INSERT INTO identity.security_events(user_id,event) VALUES(NEW.id,'email.changed');
 END IF;RETURN NULL;
END $$;
CREATE TRIGGER finish_email_change AFTER UPDATE OF email ON identity."user" FOR EACH ROW EXECUTE FUNCTION identity.finish_email_change();
CREATE FUNCTION identity.prepare_email_change(p_user uuid,p_session uuid,p_request uuid,p_email text,p_hash text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE b jsonb;at timestamptz;BEGIN
 IF p_request IS NULL OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR p_email IS NULL OR length(p_email)>254 OR p_email<>lower(btrim(p_email)) OR p_email!~'^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+[.][^@[:space:][:cntrl:]]+$' THEN RETURN 'INVALID_EMAIL_CHANGE';END IF;
 PERFORM id FROM identity."user" WHERE id=p_user FOR UPDATE;
 PERFORM id FROM identity.session WHERE id=p_session AND "userId"=p_user FOR SHARE SKIP LOCKED;IF NOT FOUND THEN RETURN 'VERIFICATION_REQUIRED';END IF;
 b=identity.phone_change_source(p_user,p_session);IF b IS NULL THEN RETURN 'VERIFICATION_REQUIRED';END IF;
 IF b->>'email'=p_email THEN RETURN 'EMAIL_UNCHANGED';END IF;
 IF NOT identity.email_available(p_email,p_user) THEN RETURN 'EMAIL_UNAVAILABLE';END IF;
 at=clock_timestamp();INSERT INTO identity.email_change_requests(user_id,session_id,request_id,email,state,current_code_hash,new_code_hash,attempts,source_snapshot,created_at,expires_at)
 VALUES(p_user,p_session,p_request,p_email,'pending_current',p_hash,NULL,0,b,at,at+interval '15 minutes')
 ON CONFLICT(user_id) DO UPDATE SET session_id=excluded.session_id,request_id=excluded.request_id,email=excluded.email,state='pending_current',current_code_hash=excluded.current_code_hash,new_code_hash=NULL,attempts=0,source_snapshot=excluded.source_snapshot,created_at=excluded.created_at,expires_at=excluded.expires_at;
 INSERT INTO identity.security_events(user_id,event) VALUES(p_user,'email.change.requested');RETURN 'PREPARED';
END $$;
CREATE FUNCTION identity.authorize_email_change(p_user uuid,p_session uuid,p_request uuid,p_hash text,p_new_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r identity.email_change_requests;until_at timestamptz;BEGIN
 IF p_new_hash IS NULL OR p_new_hash!~'^[a-f0-9]{64}$' THEN RETURN NULL;END IF;
 PERFORM id FROM identity."user" WHERE id=p_user FOR UPDATE;
 PERFORM id FROM identity.session WHERE id=p_session AND "userId"=p_user FOR SHARE SKIP LOCKED;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO r FROM identity.email_change_requests WHERE user_id=p_user AND session_id=p_session AND request_id=p_request;
 IF NOT FOUND OR r.state<>'pending_current' OR r.expires_at<=clock_timestamp() OR r.attempts>=5 OR identity.phone_change_source(p_user,p_session) IS DISTINCT FROM r.source_snapshot THEN RETURN NULL;END IF;
 IF p_hash IS DISTINCT FROM r.current_code_hash THEN UPDATE identity.email_change_requests SET attempts=attempts+1,expires_at=CASE WHEN attempts>=4 THEN least(expires_at,clock_timestamp()) ELSE expires_at END WHERE user_id=p_user;RETURN NULL;END IF;
 until_at=least(r.expires_at,clock_timestamp()+interval '5 minutes');
 UPDATE identity.email_change_requests SET state='pending_new',new_code_hash=p_new_hash,attempts=0,expires_at=until_at WHERE user_id=p_user;
 INSERT INTO identity.security_events(user_id,event) VALUES(p_user,'email.change.current_confirmed');RETURN jsonb_build_object('email',r.email,'expiresAt',until_at);
END $$;
CREATE FUNCTION identity.complete_email_change(p_user uuid,p_session uuid,p_request uuid,p_hash text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r identity.email_change_requests;constraint_name text;BEGIN
 PERFORM id FROM identity."user" WHERE id=p_user FOR UPDATE;
 PERFORM id FROM identity.session WHERE id=p_session AND "userId"=p_user FOR SHARE SKIP LOCKED;IF NOT FOUND THEN RETURN 'INVALID_EMAIL_CHANGE';END IF;
 SELECT * INTO r FROM identity.email_change_requests WHERE user_id=p_user AND session_id=p_session AND request_id=p_request;
 IF NOT FOUND OR r.state<>'pending_new' OR r.expires_at<=clock_timestamp() OR r.attempts>=5 OR identity.phone_change_source(p_user,p_session) IS DISTINCT FROM r.source_snapshot THEN RETURN 'INVALID_EMAIL_CHANGE';END IF;
 IF p_hash IS DISTINCT FROM r.new_code_hash THEN UPDATE identity.email_change_requests SET attempts=attempts+1,expires_at=CASE WHEN attempts>=4 THEN least(expires_at,clock_timestamp()) ELSE expires_at END WHERE user_id=p_user;RETURN 'INVALID_EMAIL_CHANGE';END IF;
 IF NOT identity.email_available(r.email,p_user) THEN RETURN 'EMAIL_UNAVAILABLE';END IF;
 BEGIN
  UPDATE identity."user" SET email=r.email,"emailVerified"=true,"updatedAt"=clock_timestamp() WHERE id=p_user;
 EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS constraint_name=CONSTRAINT_NAME;IF constraint_name<>'user_email_key' THEN RAISE;END IF;RETURN 'EMAIL_UNAVAILABLE';
 WHEN check_violation THEN IF SQLERRM<>'EMAIL_UNAVAILABLE' THEN RAISE;END IF;RETURN 'EMAIL_UNAVAILABLE';
 END;
 RETURN 'CHANGED';
END $$;
CREATE FUNCTION identity.cancel_email_change(p_user uuid,p_session uuid,p_request uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM id FROM identity."user" WHERE id=p_user FOR UPDATE;
 PERFORM id FROM identity.session WHERE id=p_session AND "userId"=p_user FOR SHARE SKIP LOCKED;IF NOT FOUND THEN RETURN false;END IF;
 DELETE FROM identity.email_change_requests WHERE user_id=p_user AND session_id=p_session AND request_id=p_request;IF NOT FOUND THEN RETURN false;END IF;
 INSERT INTO identity.security_events(user_id,event) VALUES(p_user,'email.change.cancelled');RETURN true;
END $$;
CREATE OR REPLACE FUNCTION identity.cleanup_expired_auth() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 DELETE FROM identity.session WHERE "expiresAt"<now();DELETE FROM identity.verification WHERE "expiresAt"<now();
 DELETE FROM identity.phone_challenges WHERE expires_at<now();DELETE FROM identity.phone_change_requests WHERE expires_at<now();
 DELETE FROM identity.email_change_requests WHERE expires_at<now();DELETE FROM identity.retired_emails WHERE expires_at<now();
 DELETE FROM identity.auth_budgets WHERE window_start<now()-interval '2 days';DELETE FROM identity.invites WHERE expires_at<now()-interval '7 days';
 DELETE FROM identity.delivery_outbox WHERE outcome IS NOT NULL AND created_at<now()-interval '7 days';
END $$;
REVOKE ALL ON FUNCTION identity.email_available(text,uuid),identity.guard_email_change(),identity.finish_email_change(),identity.prepare_email_change(uuid,uuid,uuid,text,text),identity.authorize_email_change(uuid,uuid,uuid,text,text),identity.complete_email_change(uuid,uuid,uuid,text),identity.cancel_email_change(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.email_available(text,uuid),identity.prepare_email_change(uuid,uuid,uuid,text,text),identity.authorize_email_change(uuid,uuid,uuid,text,text),identity.complete_email_change(uuid,uuid,uuid,text),identity.cancel_email_change(uuid,uuid,uuid) TO kavosh_identity;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 198 $$;

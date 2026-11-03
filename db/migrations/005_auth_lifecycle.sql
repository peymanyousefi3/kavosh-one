-- Revocation is atomic with password writes, not dependent on a later HTTP hook.
CREATE FUNCTION identity.invalidate_password_sessions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.password IS DISTINCT FROM OLD.password THEN
    DELETE FROM identity.session WHERE "userId"=NEW."userId";
    DELETE FROM identity.verification WHERE value=NEW."userId"::text;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION identity.invalidate_password_sessions() FROM PUBLIC;
CREATE TRIGGER invalidate_password_sessions BEFORE UPDATE OF password ON identity.account
FOR EACH ROW EXECUTE FUNCTION identity.invalidate_password_sessions();

CREATE INDEX session_expiry ON identity.session("expiresAt");
CREATE INDEX verification_expiry ON identity.verification("expiresAt");
CREATE FUNCTION identity.cleanup_expired_auth() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  DELETE FROM identity.session WHERE "expiresAt"<now();
  DELETE FROM identity.verification WHERE "expiresAt"<now();
  DELETE FROM identity.phone_challenges WHERE expires_at<now();
  DELETE FROM identity.auth_budgets WHERE window_start<now()-interval '2 days';
  DELETE FROM identity.invites WHERE expires_at<now()-interval '7 days';
  DELETE FROM identity.delivery_outbox WHERE outcome IS NOT NULL AND created_at<now()-interval '7 days';
END $$;
REVOKE ALL ON FUNCTION identity.cleanup_expired_auth() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.cleanup_expired_auth() TO kavosh_delivery;

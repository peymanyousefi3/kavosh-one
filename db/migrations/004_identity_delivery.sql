CREATE TABLE identity.delivery_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('email','sms')),
  payload text, expires_at timestamptz NOT NULL, available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz, attempts integer NOT NULL DEFAULT 0, delivered_at timestamptz,
  outcome text CHECK(outcome IN ('delivered','expired','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_pending ON identity.delivery_outbox(available_at) WHERE outcome IS NULL;
GRANT INSERT ON identity.delivery_outbox TO kavosh_identity;
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_delivery') THEN
    CREATE ROLE kavosh_delivery NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA identity TO kavosh_delivery;
GRANT SELECT,UPDATE ON identity.delivery_outbox TO kavosh_delivery;

-- Match the identity gateway's E.164 format. A verification flag without an
-- actual usable-format number must never satisfy account activation gates.
-- Invalid pre-existing rows fail validation for operator review; do not guess
-- replacement numbers or silently edit verification evidence during migration.
ALTER TABLE identity."user" ADD CONSTRAINT verified_phone_present
 CHECK(NOT coalesce("phoneNumberVerified",false) OR coalesce("phoneNumber" ~ '^[+][1-9][0-9]{7,14}$',false));
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 15 $$;

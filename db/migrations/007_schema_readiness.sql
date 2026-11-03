-- New academies can accept invitations after the access-control migration.
-- Derive the reserved template marker instead of relying on migration-time rows.
CREATE FUNCTION public.mark_reserved_role() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.name='Academy master' THEN NEW.system_role:=true; END IF;
  IF TG_OP='UPDATE' AND OLD.system_role AND (NEW.name<>OLD.name OR NOT NEW.system_role) THEN
    RAISE EXCEPTION 'Reserved role is protected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mark_reserved_role() FROM PUBLIC;
CREATE TRIGGER mark_reserved_role BEFORE INSERT OR UPDATE OF name,system_role ON public.roles
FOR EACH ROW EXECUTE FUNCTION public.mark_reserved_role();
UPDATE public.roles SET system_role=true WHERE name='Academy master';

CREATE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 7 $$;
REVOKE ALL ON FUNCTION public.schema_revision() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.schema_revision() TO kavosh_runtime;

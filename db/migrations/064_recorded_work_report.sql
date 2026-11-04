-- Range-led report access without scanning all historical teacher time.
-- No earned liability, recorded time or historical revision is rewritten.
CREATE INDEX session_time_start ON public.session_time_entries(academy_id,starts_at,id);
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 64 $$;

-- Own-guardian discovery must not scan every school's worker history.
-- Existing worker-first primary key remains the exact latest-version path.
CREATE INDEX work_guardian_discovery ON public.work_guardian_revisions(academy_id,guardian_id,worker_id);
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 354 $$;

-- A class selector still needs verified own/guardian authority for the exact
-- requested student. It is never permission to read the rest of the roster.
UPDATE public.capability_catalog SET scope_kinds=ARRAY['hub','class','person','country','region','city'] WHERE name='received-calendar.view';
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 215 $$;

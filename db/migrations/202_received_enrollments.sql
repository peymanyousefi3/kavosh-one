INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('received-enrollments.view','View own or current legal family class registrations','Family',true,ARRAY['hub','class','person','country','region','city']);
-- Existing roles and historical registrations gain no new authority.
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 202 $$;

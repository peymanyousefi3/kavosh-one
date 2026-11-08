INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('received-tuition.view','View own or current legal family tuition terms','Family',true,ARRAY['hub','class','person','country','region','city']);
-- No automatic grant to existing roles,students,guardians or machines.
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 201 $$;

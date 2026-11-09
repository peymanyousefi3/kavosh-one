INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('currency-valuation.view','View reference valuation of permitted posted asset accounts','Reports',true,ARRAY['hub','country','region','city']);
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 289 $$;

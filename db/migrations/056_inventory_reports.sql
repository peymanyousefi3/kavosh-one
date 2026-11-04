INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('inventory-reports.view','Read scoped historical stock and consolidated purchase-cost reports','Reports',true,ARRAY['hub','country','region','city']);
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 56 $$;

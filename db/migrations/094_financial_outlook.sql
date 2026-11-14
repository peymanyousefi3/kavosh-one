INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('financial-outlook.view','View source-scoped combined financial outlook','Reports',true,ARRAY['hub','country','region','city']);
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 94 $$;

-- Self authoring is distinct from viewing/editing other people's private drafts.
-- No automatic grants,profile creation,publication or retrospective data changes.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('self-profiles.view','View own private community profile draft','Community',true,ARRAY['hub','person','country','region','city']),
 ('self-profiles.edit','Edit own private community profile draft','Community',true,ARRAY['hub','person','country','region','city']);
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 191 $$;

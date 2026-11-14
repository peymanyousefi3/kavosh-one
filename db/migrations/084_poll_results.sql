INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('poll-results.view','Read permission-filtered poll counts and chart series, not free-text answers','Reports',true,ARRAY['hub','class','person','country','region','city']);
CREATE INDEX poll_revisions_form ON public.poll_revisions(academy_id,poll_id,((definition->>'form_version')::integer),version DESC);
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 84 $$;

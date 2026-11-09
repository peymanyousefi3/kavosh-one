-- No inferred grant to existing roles or bot credentials. Masters retain their
-- existing authority; everyone else needs an explicit scoped permission.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('notification-deliveries.view','Monitor permitted operational message delivery','Automation',true,ARRAY['hub','person','country','region','city']);
CREATE INDEX notification_deliveries_monitor ON public.notification_deliveries(academy_id,status,channel,created_at,id);
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE AS $$SELECT 235$$;

INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('receivables-reports.view','View source-scoped tuition receivables aging and customer credits','Reports',true,ARRAY['hub','class','person','country','region','city']);
-- The report's coarse candidate selection can use hub, student OR class grants
-- before its complete native record-scope intersection. The first two indexes
-- already exist; add the matching class lookup, including retained credits.
CREATE INDEX tuition_invoice_class ON public.tuition_invoices(academy_id,class_id,id);
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 90 $$;

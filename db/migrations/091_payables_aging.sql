INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payables-reports.view','View whole-bill source-scoped supplier and reimbursement aging','Reports',true,ARRAY['hub','country','region','city']);
CREATE INDEX expense_bill_posted ON public.expense_bills(academy_id,posted_on,id);
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 91 $$;

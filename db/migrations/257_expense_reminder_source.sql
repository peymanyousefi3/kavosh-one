-- Current supplier/reimbursement obligation, not bank settlement or delivery.
-- A mixed-hub bill has no single implicit time zone: its reviewed reminder
-- rule must supply an IANA zone. Only the database clock determines today.
CREATE FUNCTION public.expense_reminder_source(p_bill uuid,p_days_from_due integer,p_time_zone text) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
 WITH zone AS MATERIALIZED(
  SELECT name,(statement_timestamp() AT TIME ZONE name)::date today
  FROM pg_catalog.pg_timezone_names WHERE name=p_time_zone
 ),target AS MATERIALIZED(
  SELECT b.academy_id,b.id,b.payee_id,b.payee_version,b.due_on,b.currency_id,b.unit_scale,c.code currency_code,z.name time_zone,z.today
  FROM public.expense_bills b JOIN public.academies a ON a.id=b.academy_id
  JOIN public.finance_currencies c ON c.academy_id=b.academy_id AND c.id=b.currency_id CROSS JOIN zone z
  WHERE b.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND b.id=p_bill
   AND a.status='active' AND b.void_id IS NULL AND b.posted_on<=z.today
   AND p_days_from_due BETWEEN -365 AND 3650 AND z.today-b.due_on=p_days_from_due
 ),snapshot AS MATERIALIZED(
  SELECT b.*,v.gross,v.paid,v.balance,v.activity,
   coalesce((SELECT jsonb_agg(hub_id ORDER BY hub_id NULLS FIRST) FROM(SELECT DISTINCT l.hub_id FROM public.expense_bill_lines l WHERE l.academy_id=b.academy_id AND l.bill_id=b.id) hubs),'[]'::jsonb) cost_hubs,
   coalesce((SELECT jsonb_agg(hub_id ORDER BY hub_id NULLS FIRST) FROM(SELECT DISTINCT f.hub_id FROM public.expense_payments p JOIN public.finance_accounts f ON f.academy_id=p.academy_id AND f.id=p.funding_account WHERE p.academy_id=b.academy_id AND p.bill_id=b.id) hubs),'[]'::jsonb) funding_hubs
  FROM target b CROSS JOIN LATERAL public.expense_bill_balance(b.id,b.today) v
 ) SELECT jsonb_build_object('billId',id,'payeeId',payee_id,'payeeVersion',payee_version,
  'costHubIds',cost_hubs,'fundingHubIds',funding_hubs,'timeZone',time_zone,'dueOn',due_on::text,
  'daysFromDue',p_days_from_due,'reminderOn',today::text,'currencyId',currency_id,'currencyCode',currency_code,'unitScale',unit_scale,
  'billedMinor',gross::text,'paidMinor',paid::text,'outstandingMinor',balance::text,'recordedActivityVersion',activity::text,
  'sourceStamp',encode(sha256(convert_to(jsonb_build_array(id,payee_id,payee_version,cost_hubs,funding_hubs,time_zone,due_on,today,p_days_from_due,currency_id,currency_code,unit_scale,gross,paid,balance,activity)::text,'UTF8')),'hex'))
 FROM snapshot WHERE balance>0
$$;

-- Match the whole-bill payable report boundary, not ordinary bill totals:
-- every original cost hub and every retained funding hub, including future
-- payments and reversed payments, must be covered before computing a source.
-- Caller supplies its current effective feature scopes (including token ceiling).
CREATE FUNCTION public.expense_reminder_bill_allows(p_bill uuid,p_scopes jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT
  EXISTS(SELECT 1 FROM public.expense_bill_lines l WHERE l.academy_id=b.academy_id AND l.bill_id=b.id)
  AND NOT EXISTS(SELECT 1 FROM public.expense_bill_lines l CROSS JOIN(VALUES('expenses.view'),('expense-payments.view')) cap(name)
   WHERE l.academy_id=b.academy_id AND l.bill_id=b.id AND public.scope_contains(coalesce(p_scopes->cap.name,'{"all":false,"hubs":[]}'::jsonb),
    jsonb_build_object('all',l.hub_id IS NULL,'hubs',CASE WHEN l.hub_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(l.hub_id) END)) IS NOT TRUE)
  AND NOT EXISTS(SELECT 1 FROM public.expense_payments p JOIN public.finance_accounts f ON f.academy_id=p.academy_id AND f.id=p.funding_account
   WHERE p.academy_id=b.academy_id AND p.bill_id=b.id AND public.scope_contains(coalesce(p_scopes->'expense-payments.view','{"all":false,"hubs":[]}'::jsonb),
    jsonb_build_object('all',f.hub_id IS NULL,'hubs',CASE WHEN f.hub_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(f.hub_id) END)) IS NOT TRUE)
  FROM public.expense_bills b WHERE b.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND b.id=p_bill),false)
$$;
REVOKE ALL ON FUNCTION public.expense_reminder_source(uuid,integer,text),public.expense_reminder_bill_allows(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_reminder_source(uuid,integer,text),public.expense_reminder_bill_allows(uuid,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 257 $$;

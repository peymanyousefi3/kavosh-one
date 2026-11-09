-- Operational reminders concern approved posted WORKER NET,not forecast gross,
-- legal overdue findings,statutory remittances,bank settlement or payment IO.
-- Reuse the existing current-source worker lock and canonical dated balances.
CREATE FUNCTION public.payroll_reminder_source(p_posting uuid,p_days_from_planned_pay integer,p_time_zone text) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
 WITH zone AS MATERIALIZED(
  SELECT name,(statement_timestamp() AT TIME ZONE name)::date today FROM pg_catalog.pg_timezone_names WHERE name=p_time_zone
 ),target AS MATERIALIZED(
  SELECT p.academy_id,p.id,p.run_id,p.net_version,p.plan,g.person_id,g.currency_id,g.unit_scale,g.planned_pay_on,g.scope,
   c.code currency_code,z.name time_zone,z.today,public.payrun_net_source(g.id) current_source
  FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id
  JOIN public.academies a ON a.id=p.academy_id JOIN public.finance_currencies c ON c.academy_id=g.academy_id AND c.id=g.currency_id
  JOIN public.payrun_net_statements h ON h.academy_id=p.academy_id AND h.run_id=p.run_id AND h.version=p.net_version
  JOIN public.payrun_net_revisions n ON n.academy_id=p.academy_id AND n.run_id=p.run_id AND n.version=p.net_version AND n.state='prepared' CROSS JOIN zone z
  WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_posting AND a.status='active'
   AND p.reversal_id IS NULL AND g.cancellation_id IS NULL AND(p.input->>'postedOn')::date<=z.today
   AND p_days_from_planned_pay BETWEEN -365 AND 3650 AND z.today-g.planned_pay_on=p_days_from_planned_pay
 ),current_target AS MATERIALIZED(
  SELECT t.* FROM target t WHERE current_source->'recordedSourcesCurrent'='true'::jsonb
   AND current_source->'cancellationId'='null'::jsonb AND current_source->>'runSourceSha256'=plan#>>'{source,runSourceSha256}'
   AND public.calculated_net_current(run_id,net_version) IS TRUE
 ),snapshot AS MATERIALIZED(
  SELECT t.*,v.net,v.paid,v.balance,v.consistent,
   (SELECT count(*) FROM public.payrun_payments pay WHERE pay.academy_id=t.academy_id AND pay.posting_id=t.id)
    +(SELECT count(*) FROM public.payrun_payment_reversals r JOIN public.payrun_payments pay ON pay.academy_id=r.academy_id AND pay.id=r.payment_id WHERE pay.academy_id=t.academy_id AND pay.posting_id=t.id) activity,
   (SELECT CASE WHEN count(DISTINCT item->>'hubId')=1 AND bool_and(item->>'hubId' IS NOT NULL) THEN min(item->>'hubId')::uuid END FROM jsonb_array_elements(t.scope->'workContexts') item) hub_id
  FROM current_target t CROSS JOIN LATERAL(SELECT coalesce(sum(budget_minor),0) net,coalesce(sum(paid_minor),0) paid,coalesce(sum(balance_minor),0) balance,
   coalesce(bool_and(budget_minor>=0 AND paid_minor>=0 AND balance_minor>=0 AND budget_minor=paid_minor+balance_minor),false) consistent FROM public.payrun_payment_balances(t.id,t.today)) v
 ) SELECT jsonb_build_object('postingId',id,'runId',run_id,'personId',person_id,'hubId',hub_id,'netVersion',net_version,
  'plannedPayOn',planned_pay_on::text,'daysFromPlannedPay',p_days_from_planned_pay,'reminderOn',today::text,'timeZone',time_zone,
  'currencyId',currency_id,'currencyCode',currency_code,'unitScale',unit_scale,'netMinor',net::text,'paidMinor',paid::text,'outstandingMinor',balance::text,'recordedActivityVersion',activity::text,
  'legalOverdueDetermination',false,'bankSettlementVerified',false,'moneyMovementPerformed',false,
  'sourceStamp',encode(sha256(convert_to(jsonb_build_array(id,run_id,person_id,hub_id,net_version,planned_pay_on,p_days_from_planned_pay,today,time_zone,currency_id,currency_code,unit_scale,net,paid,balance,activity,
   encode(sha256(convert_to(plan::text,'UTF8')),'hex'),current_source->>'runSourceSha256',scope)::text,'UTF8')),'hex'))
 FROM snapshot WHERE consistent AND net=(plan#>>'{net,amounts,netMinor}')::numeric AND balance>0
$$;

-- Same original source/posting/funding/method boundary as payment-status.
-- Financial-report access is NOT lent or required for this operational source.
-- Effective scopes and the real credential ceiling are supplied separately.
CREATE FUNCTION public.payroll_reminder_posting_allows(p_posting uuid,p_scopes jsonb,p_ceiling jsonb) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT public.scope_contains(p_ceiling,g.scope) IS TRUE
  AND public.approval_scope_nonempty(coalesce(p_scopes->'payment-methods.view','{"all":false,"hubs":[]}'::jsonb))
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['payruns.view','payrun-net.view','payrun-postings.view','payrun-payments.view']) cap
   WHERE public.scope_contains(coalesce(p_scopes->cap,'{"all":false,"hubs":[]}'::jsonb),g.scope) IS NOT TRUE)
  AND public.payrun_net_source_allows(g.id,'work-pay.view',p_scopes->'work-pay.view')
  AND public.payrun_net_source_allows(g.id,'work-pay.view',p_ceiling)
  AND(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g.source_snapshot->'items') i WHERE i->>'kind'<>'manual_bonus') OR public.payrun_net_source_allows(g.id,'payroll-accruals.view',p_scopes->'payroll-accruals.view'))
  AND(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g.source_snapshot->'items') i WHERE i->>'kind'='manual_bonus') OR public.payrun_net_source_allows(g.id,'payroll-adjustments.view',p_scopes->'payroll-adjustments.view'))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.plan->'accounts') account LEFT JOIN public.finance_accounts f ON f.academy_id=p.academy_id AND f.id=(account->>'id')::uuid
   CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(p_scopes->'accounts.view',p_scopes->'journals.view',p_ceiling)) s
   WHERE f.id IS NULL OR public.scope_contains(s,jsonb_build_object('all',f.hub_id IS NULL,'hubs',CASE WHEN f.hub_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(f.hub_id) END)) IS NOT TRUE)
  AND NOT EXISTS(SELECT 1 FROM public.payrun_payments pay LEFT JOIN public.finance_accounts f ON f.academy_id=pay.academy_id AND f.id=pay.funding_account
   LEFT JOIN public.finance_payment_methods m ON m.academy_id=pay.academy_id AND m.id=pay.method_id
   WHERE pay.academy_id=p.academy_id AND pay.posting_id=p.id AND(f.id IS NULL OR m.id IS NULL
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(p_scopes->'accounts.view',p_scopes->'journals.view',p_ceiling)) s
     WHERE public.scope_contains(s,jsonb_build_object('all',f.hub_id IS NULL,'hubs',CASE WHEN f.hub_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(f.hub_id) END)) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(p_scopes->'payment-methods.view',p_ceiling)) s
     WHERE public.scope_contains(s,jsonb_build_object('all',m.hub_id IS NULL,'hubs',CASE WHEN m.hub_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(m.hub_id) END)) IS NOT TRUE)))
  FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id
  WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_posting),false)
$$;
REVOKE ALL ON FUNCTION public.payroll_reminder_source(uuid,integer,text),public.payroll_reminder_posting_allows(uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_reminder_source(uuid,integer,text),public.payroll_reminder_posting_allows(uuid,jsonb,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 259 $$;

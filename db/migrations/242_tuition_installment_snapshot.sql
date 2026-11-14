-- One current operational payment/allocation snapshot for administrative,
-- family and source-bound reminder consumers. Not a historical as-of ledger.
-- Invoker rights plus an explicit tenant predicate;never a signer/contact or
-- account-mapping projection. Every consumer still authorizes its own invoice.
CREATE FUNCTION public.tuition_installment_snapshot(p_invoice uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
 WITH target AS MATERIALIZED(
  SELECT i.academy_id,i.id,i.plan_id,i.plan_version,i.credit_id,p.unit_scale,c.code,cl.time_zone
  FROM public.tuition_invoices i JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id
  JOIN public.finance_currencies c ON c.academy_id=p.academy_id AND c.id=p.currency_id JOIN public.classes cl ON cl.academy_id=i.academy_id AND cl.id=i.class_id
  WHERE i.id=p_invoice AND i.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid
 ),assigned AS MATERIALIZED(
  SELECT l.installment,sum(l.amount_minor) amount FROM public.receipt_allocation_lines l
  JOIN public.receipt_allocation_plans h ON h.academy_id=l.academy_id AND h.receipt_id=l.receipt_id AND h.version=l.version
  JOIN public.tuition_receipts r ON r.academy_id=h.academy_id AND r.id=h.receipt_id JOIN target t ON t.academy_id=r.academy_id AND t.id=r.invoice_id
  WHERE r.reversal_id IS NULL GROUP BY l.installment
 ) SELECT jsonb_build_object('credit_id',t.credit_id,'scale',t.unit_scale,'currencyCode',t.code,'today',(statement_timestamp() AT TIME ZONE t.time_zone)::date::text,
  'received',coalesce((SELECT sum(r.amount_minor) FROM public.tuition_receipts r WHERE r.academy_id=t.academy_id AND r.invoice_id=t.id AND r.reversal_id IS NULL),0)::text,
  'installments',coalesce((SELECT jsonb_agg(jsonb_build_object('installment',s.ordinal,'dueOn',s.due_on::text,'planned',s.amount_minor::text,'allocated',coalesce(a.amount,0)::text) ORDER BY s.due_on,s.ordinal)
   FROM public.tuition_installments s LEFT JOIN assigned a ON a.installment=s.ordinal WHERE s.academy_id=t.academy_id AND s.plan_id=t.plan_id AND s.version=t.plan_version),'[]'::jsonb)) FROM target t
$$;
REVOKE ALL ON FUNCTION public.tuition_installment_snapshot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tuition_installment_snapshot(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 242 $$;

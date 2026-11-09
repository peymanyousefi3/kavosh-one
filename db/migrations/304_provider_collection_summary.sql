-- One retained-event snapshot,not a provider balance or a new posting authority.
CREATE FUNCTION public.provider_collection_accounting_summary(p_collection uuid,p_on date DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
 WITH c AS MATERIALIZED(
  SELECT pc.*,coalesce(p_on,(statement_timestamp() AT TIME ZONE cl.time_zone)::date) on_day,cl.time_zone
  FROM public.provider_collections pc JOIN public.classes cl ON cl.academy_id=pc.academy_id AND cl.id=pc.class_id
  WHERE pc.id=p_collection AND(p_on IS NULL OR p_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
 ),applications AS MATERIALIZED(
  SELECT a.applied_on on_day,a.amount_minor delta FROM c JOIN public.customer_credit_applications a ON a.academy_id=c.academy_id AND a.collection_id=c.id
  UNION ALL SELECT j.posted_on,-a.amount_minor FROM c JOIN public.customer_credit_applications a ON a.academy_id=c.academy_id AND a.collection_id=c.id JOIN public.tuition_receipts t ON t.academy_id=a.academy_id AND t.id=a.id JOIN public.finance_journals j ON j.academy_id=t.academy_id AND j.id=t.reversal_id
 ),refunds AS MATERIALIZED(
  SELECT r.posted_on on_day,r.amount_minor delta FROM c JOIN public.provider_refund_postings r ON r.academy_id=c.academy_id AND r.collection_id=c.id
 ),totals AS(
  SELECT c.*,CASE WHEN c.received_on<=c.on_day THEN c.amount_minor ELSE 0 END principal,
   coalesce((SELECT sum(delta) FROM applications WHERE on_day<=c.on_day),0) applied,
   coalesce((SELECT sum(delta) FROM refunds WHERE on_day<=c.on_day),0) refunded,
   coalesce((SELECT sum(delta) FROM applications),0) booked_applied,coalesce((SELECT sum(delta) FROM refunds),0) booked_refunded
  FROM c
 ) SELECT jsonb_build_object('on',t.on_day::text,'timeZone',t.time_zone,'principalMinor',t.principal::text,'appliedMinor',t.applied::text,'refundedMinor',t.refunded::text,
 'remainingMinor',(t.principal-t.applied-t.refunded)::text,'bookedAppliedMinor',t.booked_applied::text,'bookedRefundedMinor',t.booked_refunded::text,
 'bookedRemainingMinor',(t.amount_minor-t.booked_applied-t.booked_refunded)::text,
 'reservedAvailableMinor',(CASE WHEN t.received_on<=t.on_day THEN t.amount_minor-u.credit_used ELSE 0 END)::text,
 'providerReviewRequired',EXISTS(SELECT 1 FROM public.checkout_refund_attention a WHERE a.academy_id=t.academy_id AND a.start_id=t.start_id)
 OR EXISTS(SELECT 1 FROM public.checkout_provider_inspections i WHERE i.academy_id=t.academy_id AND i.start_id=t.start_id AND(i.object_conflict OR i.inspection->>'state'='requires_review')),
 'source','retained_accounting_events','includesFutureDatedEntries',false,'bankSettlementVerified',false,'providerBalanceVerified',false)
 FROM totals t CROSS JOIN LATERAL public.customer_credit_reservation_usage(t.academy_id,t.id,t.invoice_id,t.on_day) u
$$;
REVOKE ALL ON FUNCTION public.provider_collection_accounting_summary(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provider_collection_accounting_summary(uuid,date) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 304 $$;

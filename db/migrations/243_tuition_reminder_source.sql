-- Financial due reminders use civil days in the invoice's class time zone,
-- not elapsed 24-hour intervals or an operator-supplied clock. Negative
-- offsets mean before due;zero is due day;positive offsets mean overdue.
-- This is a current operational source,not proof of bank settlement.
CREATE FUNCTION public.tuition_reminder_source(p_invoice uuid,p_installment integer,p_days_from_due integer) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
 WITH target AS MATERIALIZED(
  SELECT i.id,i.student_id,i.hub_id,i.class_id,cl.time_zone,
   public.tuition_installment_snapshot(i.id) snapshot
  FROM public.tuition_invoices i JOIN public.classes cl ON cl.academy_id=i.academy_id AND cl.id=i.class_id
  JOIN public.billing_documents d ON d.academy_id=i.academy_id AND d.id=i.id
  JOIN public.academies school ON school.id=i.academy_id
  WHERE i.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND i.id=p_invoice
   AND i.credit_id IS NULL AND d.issued_at<=statement_timestamp() AND school.status='active'
   AND p_installment BETWEEN 1 AND 1000 AND p_days_from_due BETWEEN -365 AND 3650
 ),totals AS MATERIALIZED(
  SELECT t.*,coalesce((SELECT sum((item->>'allocated')::numeric) FROM jsonb_array_elements(snapshot->'installments') item),0) allocated,
   NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'installments') item
    WHERE(item->>'planned')::numeric<0 OR(item->>'allocated')::numeric<0 OR(item->>'allocated')::numeric>(item->>'planned')::numeric) consistent
  FROM target t
 ) SELECT jsonb_build_object('invoiceId',t.id,'studentId',t.student_id,'hubId',t.hub_id,'classId',t.class_id,'timeZone',t.time_zone,
  'installment',p_installment,'dueOn',item->'dueOn','daysFromDue',p_days_from_due,'reminderOn',((item->>'dueOn')::date+p_days_from_due)::text,
  'currencyCode',snapshot->'currencyCode','unitScale',snapshot->'scale','plannedMinor',item->'planned','allocatedMinor',item->'allocated',
  'outstandingMinor',((item->>'planned')::numeric-(item->>'allocated')::numeric)::text,
  'sourceStamp',encode(sha256(convert_to(jsonb_build_array(t.id,t.student_id,t.hub_id,t.class_id,t.time_zone,snapshot,p_installment,p_days_from_due)::text,'UTF8')),'hex'))
 FROM totals t CROSS JOIN LATERAL jsonb_array_elements(snapshot->'installments') item
 WHERE(item->>'installment')::integer=p_installment AND consistent
  AND(snapshot->>'received')::numeric=allocated
  AND(item->>'planned')::numeric>(item->>'allocated')::numeric
  AND(snapshot->>'today')::date=(item->>'dueOn')::date+p_days_from_due
$$;
REVOKE ALL ON FUNCTION public.tuition_reminder_source(uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tuition_reminder_source(uuid,integer,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 243 $$;

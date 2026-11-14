-- Audited source inspection only. No direct service grants,impersonation,
-- computed balance,payment execution or access to file bytes/provider keys.
CREATE INDEX receipt_class ON public.tuition_receipts(academy_id,class_id,id);
GRANT SELECT(academy_id,id,plan_id,plan_version,student_id,class_id,hub_id,bill_to_id,bill_to_name,description,recognition,journal_id,credit_id) ON public.tuition_invoices TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,issuer_id,issuer_version,number,issued_at,issued_on) ON public.billing_documents TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,currency_id,unit_scale) ON public.tuition_plans TO kavosh_platform_policy;
GRANT SELECT(academy_id,plan_id,version,currency_version,tax_code_id,tax_code_version,supply_on,original_minor,agreed_minor,net_minor,tax_minor,gross_minor,pricing) ON public.tuition_plan_revisions TO kavosh_platform_policy;
GRANT SELECT(academy_id,plan_id,version,ordinal,due_on,amount_minor,method_id,method_version) ON public.tuition_installments TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,invoice_id,student_id,class_id,hub_id,amount_minor,collector_id,collector_version,method_id,method_version,holding_account,holding_version,received_by,received_at,received_on,reference,evidence_file,evidence_version,reversal_id,provider_collection_id) ON public.tuition_receipts TO kavosh_platform_policy;
GRANT SELECT(academy_id,receipt_id,version) ON public.receipt_allocation_plans TO kavosh_platform_policy;
GRANT SELECT(academy_id,receipt_id,version,plan_id,plan_version,mode,total_minor) ON public.receipt_allocation_revisions TO kavosh_platform_policy;
GRANT SELECT(academy_id,receipt_id,version,installment,amount_minor) ON public.receipt_allocation_lines TO kavosh_platform_policy;

DO $$ DECLARE body text;needle text;replacement text;BEGIN
 body=pg_get_functiondef('platform_private.read_academy_directory(uuid,uuid,jsonb)'::regprocedure);
 needle='NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'',''sessions'',''class-staff'',''enrollments'',''roles'',''role-assignments'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'TUITION_DIRECTORY_COLLECTION_CHANGED';END IF;
 body=replace(body,needle,'NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'',''sessions'',''class-staff'',''enrollments'',''roles'',''role-assignments'',''tuition-invoices'',''tuition-receipts'')');
 needle='collection NOT IN(''sessions'',''class-staff'',''enrollments'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'TUITION_DIRECTORY_FILTER_CHANGED';END IF;
 body=replace(body,needle,'collection NOT IN(''sessions'',''class-staff'',''enrollments'',''tuition-invoices'',''tuition-receipts'')');
 needle=' IF collection=''roles'' THEN';
 replacement=$branch$
 IF collection='tuition-invoices' THEN
  WITH page AS MATERIALIZED(
   SELECT i.id,i.plan_id AS "planId",i.plan_version AS "planVersion",i.student_id AS "studentId",i.class_id AS "classId",i.hub_id AS "hubId",
    i.bill_to_id AS "billToId",i.bill_to_name AS "billToName",i.description,i.recognition,i.journal_id AS "journalId",i.credit_id AS "creditId",
    d.number,d.issuer_id AS "issuerId",d.issuer_version AS "issuerVersion",d.issued_at AS "issuedAt",d.issued_on::text AS "issuedOn",
    p.currency_id AS "currencyId",p.unit_scale AS "unitScale",t.currency_version AS "currencyVersion",t.tax_code_id AS "taxCodeId",t.tax_code_version AS "taxCodeVersion",t.supply_on::text AS "supplyOn",
    t.original_minor::text AS "originalMinor",t.agreed_minor::text AS "agreedMinor",t.net_minor::text AS "netMinor",t.tax_minor::text AS "taxMinor",t.gross_minor::text AS "grossMinor",t.pricing
   FROM public.tuition_invoices i JOIN public.billing_documents d ON d.academy_id=i.academy_id AND d.id=i.id
   JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id
   JOIN public.tuition_plan_revisions t ON t.academy_id=i.academy_id AND t.plan_id=i.plan_id AND t.version=i.plan_version
   WHERE i.academy_id=school AND(class_filter IS NULL OR i.class_id=class_filter) AND(after_id IS NULL OR i.id>after_id) ORDER BY i.id LIMIT page_limit+1
  ),stats AS MATERIALIZED(
   SELECT coalesce(sum((SELECT count(*) FROM public.tuition_installments x WHERE x.academy_id=school AND x.plan_id=p."planId" AND x.version=p."planVersion")),0)>20000 AS overflow FROM page p
  ) SELECT stats.overflow,coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('installments',coalesce((SELECT jsonb_agg(jsonb_build_object('ordinal',x.ordinal,'dueOn',x.due_on::text,'amountMinor',x.amount_minor::text,'methodId',x.method_id,'methodVersion',x.method_version) ORDER BY x.ordinal) FROM public.tuition_installments x WHERE x.academy_id=school AND x.plan_id=p."planId" AND x.version=p."planVersion"),'[]'::jsonb)) ORDER BY p.id) FROM page p WHERE NOT stats.overflow),'[]'::jsonb) INTO overflow,data FROM stats;
 ELSIF collection='tuition-receipts' THEN
  WITH page AS MATERIALIZED(
   SELECT r.id,r.invoice_id AS "invoiceId",r.student_id AS "studentId",r.class_id AS "classId",r.hub_id AS "hubId",r.amount_minor::text AS "amountMinor",
    r.collector_id AS "collectorId",r.collector_version AS "collectorVersion",r.method_id AS "methodId",r.method_version AS "methodVersion",r.holding_account AS "holdingAccountId",r.holding_version AS "holdingAccountVersion",
    r.received_by AS "receivedById",r.received_at AS "receivedAt",r.received_on::text AS "receivedOn",r.reference,r.evidence_file AS "evidenceFileId",r.evidence_version AS "evidenceVersion",r.reversal_id AS "reversalId",r.provider_collection_id AS "providerCollectionId",
    i.credit_id AS "invoiceCreditId",p.currency_id AS "currencyId",p.unit_scale AS "unitScale",
    a.version AS "allocationVersion",v.plan_id AS "allocationPlanId",v.plan_version AS "allocationPlanVersion",v.mode AS "allocationMode",v.total_minor::text AS "allocatedMinor"
   FROM public.tuition_receipts r JOIN public.tuition_invoices i ON i.academy_id=r.academy_id AND i.id=r.invoice_id
   JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id
   LEFT JOIN public.receipt_allocation_plans a ON a.academy_id=r.academy_id AND a.receipt_id=r.id
   LEFT JOIN public.receipt_allocation_revisions v ON v.academy_id=a.academy_id AND v.receipt_id=a.receipt_id AND v.version=a.version
   WHERE r.academy_id=school AND(class_filter IS NULL OR r.class_id=class_filter) AND(after_id IS NULL OR r.id>after_id) ORDER BY r.id LIMIT page_limit+1
  ),stats AS MATERIALIZED(
   SELECT coalesce(sum((SELECT count(*) FROM public.receipt_allocation_lines x WHERE x.academy_id=school AND x.receipt_id=p.id AND x.version=p."allocationVersion")),0)>20000 AS overflow FROM page p
  ) SELECT stats.overflow,coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('allocations',coalesce((SELECT jsonb_agg(jsonb_build_object('installment',x.installment,'amountMinor',x.amount_minor::text) ORDER BY x.installment) FROM public.receipt_allocation_lines x WHERE x.academy_id=school AND x.receipt_id=p.id AND x.version=p."allocationVersion"),'[]'::jsonb)) ORDER BY p.id) FROM page p WHERE NOT stats.overflow),'[]'::jsonb) INTO overflow,data FROM stats;
 ELSIF collection='roles' THEN$branch$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'TUITION_DIRECTORY_PROJECTION_CHANGED';END IF;
 EXECUTE replace(body,needle,replacement);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 422 $$;

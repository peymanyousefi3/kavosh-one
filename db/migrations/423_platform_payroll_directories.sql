-- Fixed owner-only payroll headers. No worker impersonation,private identity
-- reveal,source review text,computed settlement balance or payment authority.
GRANT SELECT(academy_id,id,person_id,currency_id,unit_scale,gross_minor,reference,service_from,service_through,planned_pay_on,cancellation_id) ON public.payrun_groups TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,run_id,net_version,plan,journal_id,reversal_id) ON public.payrun_net_postings TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,posting_id,input,amount_minor,posted_on,reference,reversal_id,funding_account,funding_version,method_id,method_version,evidence_file,evidence_version,handled_by) ON public.payrun_payments TO kavosh_platform_policy;
DO $$ DECLARE body text;needle text;replacement text;BEGIN
 body=pg_get_functiondef('platform_private.read_academy_directory(uuid,uuid,jsonb)'::regprocedure);
 needle='NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'',''sessions'',''class-staff'',''enrollments'',''roles'',''role-assignments'',''tuition-invoices'',''tuition-receipts'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PAYROLL_DIRECTORY_COLLECTION_CHANGED';END IF;
 body=replace(body,needle,'NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'',''sessions'',''class-staff'',''enrollments'',''roles'',''role-assignments'',''tuition-invoices'',''tuition-receipts'',''payroll-runs'',''payroll-postings'',''payroll-payments'')');
 needle=' IF collection=''tuition-invoices'' THEN';
 replacement=$branch$
 IF collection='payroll-runs' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(
   SELECT g.id,g.person_id AS "personId",g.currency_id AS "currencyId",g.unit_scale AS "unitScale",g.gross_minor::text AS "grossMinor",g.reference,
    g.service_from::text AS "serviceFrom",g.service_through::text AS "serviceThrough",g.planned_pay_on::text AS "plannedPayOn",g.cancellation_id AS "cancellationId"
   FROM public.payrun_groups g WHERE g.academy_id=school AND(after_id IS NULL OR g.id>after_id) ORDER BY g.id LIMIT page_limit+1
  ) r;
 ELSIF collection='payroll-postings' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(
   SELECT p.id,p.run_id AS "runId",g.person_id AS "personId",g.currency_id AS "currencyId",g.unit_scale AS "unitScale",p.net_version AS "netVersion",p.journal_id AS "journalId",p.reversal_id AS "reversalId",
    p.plan#>>'{net,amounts,grossMinor}' AS "grossMinor",p.plan#>>'{net,amounts,employeeDeductionMinor}' AS "employeeDeductionMinor",p.plan#>>'{net,amounts,netMinor}' AS "netMinor"
   FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id
   WHERE p.academy_id=school AND(after_id IS NULL OR p.id>after_id) ORDER BY p.id LIMIT page_limit+1
  ) r;
 ELSIF collection='payroll-payments' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(
   SELECT p.id,p.posting_id AS "postingId",n.run_id AS "runId",g.person_id AS "personId",g.currency_id AS "currencyId",g.unit_scale AS "unitScale",p.amount_minor::text AS "amountMinor",
    p.posted_on::text AS "postedOn",p.input->>'paidAt' AS "attestedPaidAt",p.reference,p.reversal_id AS "reversalId",n.reversal_id AS "postingReversalId",
    p.funding_account AS "fundingAccountId",p.funding_version AS "fundingAccountVersion",p.method_id AS "methodId",p.method_version AS "methodVersion",p.evidence_file AS "evidenceFileId",p.evidence_version AS "evidenceVersion",p.handled_by AS "handledById"
   FROM public.payrun_payments p JOIN public.payrun_net_postings n ON n.academy_id=p.academy_id AND n.id=p.posting_id JOIN public.payrun_groups g ON g.academy_id=n.academy_id AND g.id=n.run_id
   WHERE p.academy_id=school AND(after_id IS NULL OR p.id>after_id) ORDER BY p.id LIMIT page_limit+1
  ) r;
 ELSIF collection='tuition-invoices' THEN$branch$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PAYROLL_DIRECTORY_PROJECTION_CHANGED';END IF;
 EXECUTE replace(body,needle,replacement);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 423 $$;

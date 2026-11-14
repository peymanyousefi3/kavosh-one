-- Existing audited MFA-owner gateway only. Read exact retained bills and
-- attested payments;never infer tax eligibility,bank settlement or execution.
GRANT SELECT(academy_id,id,payee_id,payee_version,payable_account,payable_version,currency_id,currency_version,unit_scale,document_number,issued_on,due_on,posted_on,period_id,period_version,net_minor,tax_minor,gross_minor,recoverable_minor,evidence_file,evidence_version,void_id) ON public.expense_bills TO kavosh_platform_policy;
GRANT SELECT(academy_id,bill_id,line_number,description,hub_id,class_id,student_id,expense_account,expense_version,tax_account,tax_version,tax_code_id,tax_code_version,tax_on,input_minor,pricing,recoverable_rate,net_minor,tax_minor,gross_minor,recoverable_minor) ON public.expense_bill_lines TO kavosh_platform_policy;
GRANT SELECT(academy_id,payee_id,version,name,legal_name) ON public.financial_payee_revisions TO kavosh_platform_policy;
GRANT SELECT(academy_id,tax_code_id,version,classification,rate_millionths) ON public.finance_tax_code_revisions TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,bill_id,funding_account,funding_version,payable_account,payable_version,amount_minor,method_id,method_version,period_id,period_version,posted_on,paid_at,handled_by,reference,evidence_file,evidence_version,reversal_id) ON public.expense_payments TO kavosh_platform_policy;
DO $$ DECLARE body text;needle text;replacement text;BEGIN
 body=pg_get_functiondef('platform_private.read_academy_directory(uuid,uuid,jsonb)'::regprocedure);
 needle='NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'',''sessions'',''class-staff'',''enrollments'',''roles'',''role-assignments'',''tuition-invoices'',''tuition-receipts'',''payroll-runs'',''payroll-postings'',''payroll-payments'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'EXPENSE_DIRECTORY_COLLECTION_CHANGED';END IF;
 body=replace(body,needle,'NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'',''sessions'',''class-staff'',''enrollments'',''roles'',''role-assignments'',''tuition-invoices'',''tuition-receipts'',''payroll-runs'',''payroll-postings'',''payroll-payments'',''expense-bills'',''expense-payments'')');
 needle='collection NOT IN(''sessions'',''class-staff'',''enrollments'',''tuition-invoices'',''tuition-receipts'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'EXPENSE_DIRECTORY_FILTER_CHANGED';END IF;
 body=replace(body,needle,'collection NOT IN(''sessions'',''class-staff'',''enrollments'',''tuition-invoices'',''tuition-receipts'',''expense-bills'',''expense-payments'')');
 needle=' IF collection=''payroll-runs'' THEN';
 replacement=$branch$
 IF collection='expense-bills' THEN
  WITH page AS MATERIALIZED(
   SELECT b.id,b.payee_id AS "payeeId",b.payee_version AS "payeeVersion",p.name AS "payeeName",p.legal_name AS "payeeLegalName",b.payable_account AS "payableAccountId",b.payable_version AS "payableAccountVersion",
    b.currency_id AS "currencyId",b.currency_version AS "currencyVersion",b.unit_scale AS "unitScale",b.document_number AS "documentNumber",b.issued_on::text AS "issuedOn",b.due_on::text AS "dueOn",b.posted_on::text AS "postedOn",b.period_id AS "periodId",b.period_version AS "periodVersion",
    b.net_minor::text AS "netMinor",b.tax_minor::text AS "taxMinor",b.gross_minor::text AS "grossMinor",b.recoverable_minor::text AS "declaredRecoverableTaxMinor",b.evidence_file AS "evidenceFileId",b.evidence_version AS "evidenceVersion",b.void_id AS "voidId"
   FROM public.expense_bills b JOIN public.financial_payee_revisions p ON p.academy_id=b.academy_id AND p.payee_id=b.payee_id AND p.version=b.payee_version
   WHERE b.academy_id=school AND(after_id IS NULL OR b.id>after_id) AND(class_filter IS NULL OR EXISTS(SELECT 1 FROM public.expense_bill_lines x WHERE x.academy_id=school AND x.bill_id=b.id AND x.class_id=class_filter)) ORDER BY b.id LIMIT page_limit+1
  ) SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('lines',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'lineNumber',l.line_number,'description',l.description,'hubId',l.hub_id,'classId',l.class_id,'studentId',l.student_id,
    'expenseAccountId',l.expense_account,'expenseAccountVersion',l.expense_version,'taxAccountId',l.tax_account,'taxAccountVersion',l.tax_version,'taxCodeId',l.tax_code_id,'taxCodeVersion',l.tax_code_version,'taxOn',l.tax_on::text,
    'classification',t.classification,'rateMillionths',t.rate_millionths::text,'declaredRecoverableRateMillionths',l.recoverable_rate::text,'inputMinor',l.input_minor::text,'pricing',l.pricing,
    'netMinor',l.net_minor::text,'taxMinor',l.tax_minor::text,'grossMinor',l.gross_minor::text,'declaredRecoverableTaxMinor',l.recoverable_minor::text) ORDER BY l.line_number)
    FROM public.expense_bill_lines l JOIN public.finance_tax_code_revisions t ON t.academy_id=l.academy_id AND t.tax_code_id=l.tax_code_id AND t.version=l.tax_code_version WHERE l.academy_id=school AND l.bill_id=p.id),'[]'::jsonb)) ORDER BY p.id),'[]'::jsonb) INTO data FROM page p;
  -- Native primary key and line_number1..50 bound ALL original cost lines to
  -- at most5050/page+continuation,below the existing20000nested-entry ceiling.
 ELSIF collection='expense-payments' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO data FROM(
   SELECT p.id,p.bill_id AS "billId",b.payee_id AS "payeeId",b.payee_version AS "payeeVersion",b.currency_id AS "currencyId",b.currency_version AS "currencyVersion",b.unit_scale AS "unitScale",b.void_id AS "billVoidId",p.amount_minor::text AS "amountMinor",
    p.funding_account AS "fundingAccountId",p.funding_version AS "fundingAccountVersion",p.payable_account AS "payableAccountId",p.payable_version AS "payableAccountVersion",p.method_id AS "methodId",p.method_version AS "methodVersion",p.period_id AS "periodId",p.period_version AS "periodVersion",
    p.posted_on::text AS "postedOn",p.paid_at::text AS "attestedPaidAt",p.handled_by AS "handledById",p.reference,p.evidence_file AS "evidenceFileId",p.evidence_version AS "evidenceVersion",p.reversal_id AS "reversalId"
   FROM public.expense_payments p JOIN public.expense_bills b ON b.academy_id=p.academy_id AND b.id=p.bill_id
   WHERE p.academy_id=school AND(after_id IS NULL OR p.id>after_id) AND(class_filter IS NULL OR EXISTS(SELECT 1 FROM public.expense_bill_lines x WHERE x.academy_id=school AND x.bill_id=b.id AND x.class_id=class_filter)) ORDER BY p.id LIMIT page_limit+1
  ) r;
 ELSIF collection='payroll-runs' THEN$branch$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'EXPENSE_DIRECTORY_PROJECTION_CHANGED';END IF;
 EXECUTE replace(body,needle,replacement);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 424 $$;

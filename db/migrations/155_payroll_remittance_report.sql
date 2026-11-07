-- Extend reviewed report definitions without rewriting saved rows or identities.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);needle='''payroll.settlements'')';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'REMITTANCE_REPORT_CATALOGUE_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'''payroll.settlements'',''payroll.remittances'')');
 body=pg_get_functiondef('public.report_preset_definition_valid(jsonb)'::regprocedure);needle='WHEN ''payroll.settlements'' THEN ARRAY[''on'']';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'REMITTANCE_REPORT_WINDOW_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,needle||' WHEN ''payroll.remittances'' THEN ARRAY[''on'']');
END $$;
-- Net postings already permit tax-payable deduction/employer control accounts.
-- Remittance selection must accept those same original credit liabilities.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.payrun_remittance_plan(uuid,jsonb,uuid)'::regprocedure);
 needle='a.operational_role<>''payable''';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'REMITTANCE_ACCOUNT_ROLE_BASE_UNEXPECTED';END IF;
 body=replace(body,needle,'a.operational_role NOT IN(''payable'',''tax_payable'')');
 needle='a->>''operationalRole''<>''payable''';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'REMITTANCE_ACCOUNT_PLAN_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'a->>''operationalRole'' NOT IN(''payable'',''tax_payable'')');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 155 $$;

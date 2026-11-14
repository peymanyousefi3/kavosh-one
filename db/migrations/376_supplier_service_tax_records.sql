-- Reviewed supplier/service reporting from ORIGINAL expense payments. This
-- never posts money,assumes withholding or determines legal tax eligibility.
CREATE TABLE public.supplier_tax_records(
 academy_id uuid NOT NULL,payment_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,payment_id),FOREIGN KEY(academy_id,payment_id) REFERENCES public.expense_payments(academy_id,id)
);
CREATE TABLE public.supplier_tax_revisions(
 academy_id uuid NOT NULL,payment_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('recorded','withdrawn')),definition jsonb NOT NULL CHECK(octet_length(definition::text)<=65536),source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=1048576),changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,payment_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,payment_id) REFERENCES public.supplier_tax_records(academy_id,payment_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.supplier_tax_records ADD CONSTRAINT supplier_tax_current_revision FOREIGN KEY(academy_id,payment_id,version) REFERENCES public.supplier_tax_revisions(academy_id,payment_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['supplier_tax_records','supplier_tax_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER supplier_tax_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,payment_id),UPDATE(version) ON public.supplier_tax_records TO kavosh_runtime;
GRANT INSERT(academy_id,payment_id,version,definition,source_snapshot,changed_by,approval_id,reason) ON public.supplier_tax_revisions TO kavosh_runtime;
CREATE TRIGGER supplier_tax_header BEFORE INSERT OR UPDATE ON public.supplier_tax_records FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();

CREATE FUNCTION public.supplier_tax_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR octet_length(d::text)>65536 OR NOT(d?&ARRAY['timeZone','reportingAccount','allocation','payerReview']) OR d-ARRAY['timeZone','reportingAccount','allocation','payerReview']<>'{}'::jsonb OR jsonb_typeof(d->'payerReview') IS DISTINCT FROM 'string' OR length(btrim(d->>'payerReview')) NOT BETWEEN 1 AND 2000 OR d->>'payerReview'~'[[:cntrl:]]' THEN RETURN false;END IF;
 RETURN public.t4a_record_definition_valid((d-'payerReview')||'{"incomeTaxSources":[]}'::jsonb) AND(d#>>'{allocation,incomeTaxDeducted}')::numeric=0;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.supplier_tax_plan(p_payment uuid,p_before integer,d jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE pay record;bill record;recipient record;h record;b jsonb;binding jsonb;employer uuid;paid date;other_records jsonb;other_tax numeric;other_count integer;accounts uuid[];hubs uuid[];bindings jsonb:='[]';methods uuid[];method_hubs uuid[];bill_hubs uuid[];payment_hubs uuid[];gross numeric;allocated numeric;BEGIN
 IF p_before IS NULL OR p_before<0 OR p_before>2147483646 THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_VERSION_INVALID');END IF;
 SELECT * INTO pay FROM public.expense_payments WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_payment;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM public.lock_finance_book();PERFORM id FROM public.expense_bills WHERE academy_id=pay.academy_id AND id=pay.bill_id FOR UPDATE;
 PERFORM id FROM public.expense_payments WHERE academy_id=pay.academy_id AND id=p_payment FOR UPDATE;
 SELECT * INTO pay FROM public.expense_payments WHERE academy_id=pay.academy_id AND id=p_payment;SELECT * INTO bill FROM public.expense_bills WHERE academy_id=pay.academy_id AND id=pay.bill_id;
 SELECT p.id,p.kind,p.hub_id,p.person_id,r.version,r.name,r.legal_name INTO recipient FROM public.financial_payees p JOIN public.financial_payee_revisions r ON r.academy_id=p.academy_id AND r.payee_id=p.id AND r.version=bill.payee_version WHERE p.academy_id=bill.academy_id AND p.id=bill.payee_id;
 SELECT * INTO h FROM public.supplier_tax_records WHERE academy_id=pay.academy_id AND payment_id=p_payment;
 IF(h.payment_id IS NULL AND p_before<>0) OR(h.payment_id IS NOT NULL AND h.version NOT IN(p_before,p_before+1)) THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_VERSION_CHANGED');END IF;
 SELECT jsonb_build_object('version',version,'state',state,'definition',definition,'source',source_snapshot->'source') INTO b FROM public.supplier_tax_revisions WHERE academy_id=pay.academy_id AND payment_id=p_payment AND version=p_before;
 IF d IS DISTINCT FROM 'null'::jsonb AND public.supplier_tax_definition_valid(d) IS NOT TRUE THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_DEFINITION_INVALID');END IF;
 IF d='null'::jsonb THEN
  IF b->>'state' IS DISTINCT FROM 'recorded' THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_WITHDRAWAL_UNAVAILABLE');END IF;
  binding=b#>'{source,reportingAccount}';employer=(b#>>'{source,employerId}')::uuid;paid=(b#>>'{source,paidOn}')::date;
 ELSE
  IF pay.reversal_id IS NOT NULL OR bill.void_id IS NOT NULL THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_ACTIVE_SOURCE_REQUIRED');END IF;
  IF pay.settlement_kind<>'cash' OR pay.paid_at IS NULL OR pay.method_id IS NULL THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_NONCASH_REVIEW_REQUIRED');END IF;
  IF bill.unit_scale<>2 OR(SELECT code FROM public.finance_currencies WHERE academy_id=bill.academy_id AND id=bill.currency_id) IS DISTINCT FROM 'CAD' THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_CAD_RECOGNITION_REQUIRED');END IF;
  IF recipient.kind NOT IN('person','organization') OR nullif(btrim(recipient.legal_name),'') IS NULL THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_LEGAL_RECIPIENT_REQUIRED');END IF;
  paid=(pay.paid_at AT TIME ZONE(d->>'timeZone'))::date;
  SELECT employer_id INTO employer FROM public.payroll_employer_accounts WHERE academy_id=pay.academy_id AND id=(d#>>'{reportingAccount,id}')::uuid FOR SHARE;
  binding=public.payroll_employer_default_binding((d#>>'{reportingAccount,id}')::uuid,(d#>>'{reportingAccount,version}')::integer,employer,paid);
  IF binding IS NULL THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_REPORTING_ACCOUNT_CHANGED');END IF;
  gross=pay.amount_minor;SELECT coalesce(sum((x->>'amount')::numeric),0)*100 INTO allocated FROM(SELECT x FROM jsonb_array_elements(d#>'{allocation,income}') x UNION ALL SELECT x FROM jsonb_array_elements(d#>'{allocation,otherExcluded}') x) amounts;
  IF gross<>allocated+100*((d#>>'{allocation,gstHst}')::numeric+(d#>>'{allocation,pst}')::numeric) THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_ALLOCATION_UNRECONCILED');END IF;
 END IF;
 WITH selected AS MATERIALIZED(SELECT p.id,r.version,100*((r.definition#>>'{allocation,gstHst}')::numeric+(r.definition#>>'{allocation,pst}')::numeric) tax FROM public.supplier_tax_records x JOIN public.expense_payments p ON p.academy_id=x.academy_id AND p.id=x.payment_id JOIN public.supplier_tax_revisions r ON r.academy_id=x.academy_id AND r.payment_id=x.payment_id AND r.version=x.version WHERE x.academy_id=pay.academy_id AND p.bill_id=pay.bill_id AND p.id<>pay.id AND r.state='recorded' ORDER BY p.id LIMIT 1001)
 SELECT count(*)::integer,coalesce(sum(tax),0),coalesce(jsonb_agg(jsonb_build_object('paymentId',id,'version',version,'excludedTaxMinor',tax::text) ORDER BY id),'[]'::jsonb) INTO other_count,other_tax,other_records FROM selected;
 IF other_count>1000 THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_HISTORY_REQUIRES_BACKGROUND_JOB');END IF;
 IF d<>'null'::jsonb AND other_tax+100*((d#>>'{allocation,gstHst}')::numeric+(d#>>'{allocation,pst}')::numeric)>bill.tax_minor THEN RETURN jsonb_build_object('unavailable','SUPPLIER_TAX_EXCLUSION_CAPACITY_EXCEEDED');END IF;
 SELECT array_agg(DISTINCT l.account_id) INTO accounts FROM public.finance_journal_lines l WHERE l.academy_id=pay.academy_id AND(l.journal_id=bill.id OR l.journal_id=pay.id OR l.journal_id IN(SELECT(x->>'paymentId')::uuid FROM jsonb_array_elements(other_records) x));
 SELECT array_agg(DISTINCT hub_id) INTO hubs FROM public.finance_accounts WHERE academy_id=pay.academy_id AND id=ANY(accounts);
 SELECT array_agg(DISTINCT hub_id) INTO bill_hubs FROM public.expense_bill_lines WHERE academy_id=bill.academy_id AND bill_id=bill.id;
 SELECT array_agg(DISTINCT p.method_id) INTO methods FROM public.expense_payments p WHERE p.academy_id=pay.academy_id AND(p.id=pay.id OR p.id IN(SELECT(x->>'paymentId')::uuid FROM jsonb_array_elements(other_records) x));
 SELECT array_agg(DISTINCT hub_id) INTO method_hubs FROM public.finance_payment_methods WHERE academy_id=pay.academy_id AND id=ANY(methods);
 SELECT array_agg(DISTINCT selected_hubs.hub_id) INTO payment_hubs FROM unnest(bill_hubs||hubs) selected_hubs(hub_id);
 bindings=jsonb_build_array(public.approval_hub_binding('expenses.view',bill_hubs),public.approval_hub_binding('expense-payments.view',payment_hubs),public.approval_hub_binding('accounts.view',hubs),public.approval_hub_binding('journals.view',hubs),public.approval_hub_binding('payees.view',ARRAY[recipient.hub_id]::uuid[]),public.approval_hub_binding('payment-methods.view',method_hubs),jsonb_build_object('capability','payroll-tax.view','scope','{"all":true,"hubs":[]}'::jsonb),jsonb_build_object('capability','payroll-employers.view','scope','{"all":true,"hubs":[]}'::jsonb));
 RETURN jsonb_build_object('source',jsonb_build_object('kind','expense_payment','paymentId',pay.id,'billId',bill.id,'payeeId',recipient.id,'payeeVersion',recipient.version,'personId',recipient.person_id,'recipientKind',recipient.kind,'recipientName',recipient.name,'recipientLegalName',recipient.legal_name,'employerId',employer,'reportingAccount',binding,'taxYear',extract(year FROM paid)::integer,'paidOn',paid::text,'paidAt',to_char(pay.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'paymentReversalId',pay.reversal_id,'billVoidId',bill.void_id,'paymentSha256',encode(sha256(convert_to(to_jsonb(pay)::text,'UTF8')),'hex'),'billSha256',encode(sha256(convert_to(to_jsonb(bill)::text,'UTF8')),'hex')),'settlementMinor',pay.amount_minor::text,'grossMinor',CASE WHEN d='null'::jsonb THEN NULL ELSE gross::text END,'billTaxMinor',bill.tax_minor::text,'before',b,'otherRecords',other_records,'requiredBindings',bindings,'unavailable',NULL);
END $$;

CREATE FUNCTION public.supplier_tax_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;h record;b jsonb;i jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SUPPLIER_TAX_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.supplier_tax_records WHERE academy_id=NEW.academy_id AND payment_id=NEW.payment_id;
 b=public.supplier_tax_plan(NEW.payment_id,NEW.version-1,NEW.definition);i=jsonb_build_object('paymentId',NEW.payment_id,'expectedVersion',NEW.version-1,'definition',NEW.definition,'reason',NEW.reason);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF h.payment_id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.supplier_tax_revisions WHERE academy_id=NEW.academy_id AND payment_id=NEW.payment_id) OR b IS NULL OR b->>'unavailable' IS NOT NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'finance.supplier-tax.change' OR p.target_id IS DISTINCT FROM NEW.payment_id OR p.target_version<>NEW.version-1 OR p.payload IS DISTINCT FROM i OR p.privacy_capability IS DISTINCT FROM 'payroll-tax.view' OR p.scope IS DISTINCT FROM '{"all":true,"hubs":[]}'::jsonb OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'SUPPLIER_TAX_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by::text=b#>>'{source,personId}' AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.state=CASE WHEN NEW.definition='null'::jsonb THEN 'withdrawn' ELSE 'recorded' END;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER supplier_tax_revision BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_tax_revisions FOR EACH ROW EXECUTE FUNCTION public.supplier_tax_revision_guard();
CREATE CONSTRAINT TRIGGER supplier_tax_reviewed AFTER INSERT ON public.supplier_tax_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
-- Boolean-only acknowledgement:do not grant the web role outbox SELECT.
-- Fixed event type,current academy and current transaction,never raw events.
CREATE FUNCTION public.supplier_tax_outbox_ack(p_academy uuid,p_request uuid,p_entity uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_academy=nullif(current_setting('app.academy_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public.outbox_events WHERE academy_id=p_academy AND request_id=p_request AND entity_id=p_entity AND event_type='finance.supplier-tax.change' AND created_at=transaction_timestamp())
$$;
GRANT CREATE ON SCHEMA public TO kavosh_event_policy;
ALTER FUNCTION public.supplier_tax_outbox_ack(uuid,uuid,uuid) OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy;
REVOKE ALL ON FUNCTION public.supplier_tax_outbox_ack(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.supplier_tax_outbox_ack(uuid,uuid,uuid) TO kavosh_runtime;
CREATE FUNCTION public.supplier_tax_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.supplier_tax_plan(NEW.payment_id,NEW.version-1,NEW.definition) IS DISTINCT FROM NEW.source_snapshot OR NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.payment_id AND a.actor_id=NEW.changed_by AND a.action='finance.supplier-tax.change' AND a.created_at=transaction_timestamp() AND public.supplier_tax_outbox_ack(a.academy_id,a.request_id,a.entity_id) AND a.changes->'version'=to_jsonb(NEW.version) AND a.changes->>'approvalId'=NEW.approval_id::text AND a.changes->'severity'='"critical"'::jsonb AND a.changes->'privateContentRedacted'='true'::jsonb AND a.changes->'paymentExecuted'='false'::jsonb AND a.changes->'additionalLedgerPosting'='false'::jsonb) THEN RAISE EXCEPTION 'SUPPLIER_TAX_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_tax_complete AFTER INSERT ON public.supplier_tax_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.supplier_tax_complete();
CREATE FUNCTION public.supplier_tax_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.supplier-tax.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.supplier_tax_revisions WHERE academy_id=NEW.academy_id AND payment_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'SUPPLIER_TAX_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER supplier_tax_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.supplier_tax_effect_required();
CREATE FUNCTION public.supplier_tax_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(NEW.review_context->'requiredBindings') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.review_context->'requiredBindings')<>8 THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||(NEW.review_context->'requiredBindings');END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_supplier_tax_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='finance.supplier-tax.change') EXECUTE FUNCTION public.supplier_tax_privacy();
REVOKE ALL ON FUNCTION public.supplier_tax_definition_valid(jsonb),public.supplier_tax_plan(uuid,integer,jsonb),public.supplier_tax_revision_guard(),public.supplier_tax_complete(),public.supplier_tax_effect_required(),public.supplier_tax_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.supplier_tax_definition_valid(jsonb),public.supplier_tax_plan(uuid,integer,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 376 $$;

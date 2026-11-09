-- A payment attestation decorates ONE existing principal journal. Amounts,
-- dates,currency and balances remain authoritative in the original ledger.
CREATE TABLE public.counterparty_payments(
 academy_id uuid NOT NULL,journal_id uuid NOT NULL,principal_line smallint NOT NULL,treasury_line smallint NOT NULL,
 payee_id uuid NOT NULL,treasury_account uuid NOT NULL,method_id uuid NOT NULL,method_version integer NOT NULL,
 transferred_at timestamptz NOT NULL CHECK(transferred_at>=TIMESTAMPTZ '1900-01-01' AND transferred_at<TIMESTAMPTZ '10000-01-01'),
 transferred_at_input text NOT NULL CHECK(length(transferred_at_input)<=100 AND transferred_at_input::timestamptz=transferred_at),
 handled_by uuid,evidence_file uuid,evidence_version integer,missing_evidence_reason text NOT NULL CHECK(length(missing_evidence_reason)<=2000),
 tax_treatment text NOT NULL CHECK(tax_treatment='principal_only_no_tax_posting'),reference text NOT NULL CHECK(length(reference)<=200),
 approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,journal_id),CHECK(principal_line BETWEEN 1 AND 2 AND treasury_line BETWEEN 1 AND 2 AND principal_line<>treasury_line),
 CHECK((evidence_file IS NULL)=(evidence_version IS NULL)),CHECK(evidence_file IS NOT NULL OR length(btrim(missing_evidence_reason))>0),
 FOREIGN KEY(academy_id,journal_id,principal_line) REFERENCES public.finance_journal_counterparties(academy_id,journal_id,line_number),
 FOREIGN KEY(academy_id,journal_id,treasury_line) REFERENCES public.finance_journal_lines(academy_id,journal_id,line_number),
 FOREIGN KEY(academy_id,payee_id) REFERENCES public.financial_payees(academy_id,id),FOREIGN KEY(academy_id,treasury_account) REFERENCES public.finance_accounts(academy_id,id),
 FOREIGN KEY(academy_id,method_id,method_version) REFERENCES public.finance_payment_method_revisions(academy_id,method_id,version),
 FOREIGN KEY(academy_id,handled_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,evidence_file,evidence_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE INDEX counterparty_payment_reference ON public.counterparty_payments(academy_id,payee_id,treasury_account,method_id,reference,journal_id) WHERE reference<>'';
ALTER TABLE public.counterparty_payments ENABLE ROW LEVEL SECURITY;ALTER TABLE public.counterparty_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.counterparty_payments USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.counterparty_payments TO kavosh_runtime;
GRANT INSERT(academy_id,journal_id,principal_line,treasury_line,payee_id,treasury_account,method_id,method_version,transferred_at,transferred_at_input,handled_by,evidence_file,evidence_version,missing_evidence_reason,tax_treatment,reference,approval_id,created_by) ON public.counterparty_payments TO kavosh_runtime;

CREATE FUNCTION public.counterparty_payment_reference(p_payee uuid,p_treasury uuid,p_method uuid,p_reference text,p_on date) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;v record;frame text;
BEGIN
 IF tenant IS NULL OR p_payee IS NULL OR p_treasury IS NULL OR p_method IS NULL OR p_reference IS NULL OR length(p_reference)>200 OR p_on IS NULL OR p_on NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RAISE EXCEPTION 'COUNTERPARTY_REFERENCE_INPUT_INVALID' USING ERRCODE='22023';END IF;
 WITH history AS MATERIALIZED(
  SELECT p.journal_id,r.id correction_id,r.posted_on correction_on FROM public.counterparty_payments p LEFT JOIN public.finance_journals r ON r.academy_id=p.academy_id AND r.reverses_id=p.journal_id
  WHERE p.academy_id=tenant AND p.payee_id=p_payee AND p.treasury_account=p_treasury AND p.method_id=p_method AND p.reference=p_reference AND p_reference<>'' LIMIT 10001
 ) SELECT count(*) n,coalesce(bool_or(correction_id IS NULL OR correction_on>p_on),false) in_use,coalesce(string_agg(journal_id::text||':'||coalesce(correction_id::text,''),',' ORDER BY journal_id),'') ids INTO v FROM history;
 IF v.n>10000 THEN RAISE EXCEPTION 'COUNTERPARTY_REFERENCE_HISTORY_LIMIT' USING ERRCODE='54000';END IF;
 frame=jsonb_build_array(tenant,p_payee,p_treasury,p_method,p_reference,p_on,v.ids)::text;
 RETURN jsonb_build_object('activity',v.n::text,'inUse',v.in_use,'sourceStamp',encode(sha256(convert_to(frame,'UTF8')),'hex'));
END $$;
CREATE FUNCTION public.guard_counterparty_payment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE j record;p record;t record;b record;f record;m record;handler public.people%ROWTYPE;evidence public.file_records%ROWTYPE;source jsonb;expected jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'COUNTERPARTY_PAYMENT_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.journal_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 SELECT * INTO t FROM public.finance_journal_counterparties WHERE academy_id=NEW.academy_id AND journal_id=NEW.journal_id AND line_number=NEW.principal_line;
 SELECT l.*,a.kind,a.operational_role,h.hub_id,h.currency_id,u.unit_scale INTO b FROM public.finance_journal_lines l JOIN public.finance_accounts h ON h.academy_id=l.academy_id AND h.id=l.account_id JOIN public.finance_account_revisions a ON a.academy_id=l.academy_id AND a.account_id=l.account_id AND a.version=l.account_version JOIN public.finance_currency_revisions u ON u.academy_id=h.academy_id AND u.currency_id=h.currency_id AND u.version=h.currency_version WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.journal_id AND l.line_number=NEW.principal_line;
 SELECT l.*,a.operational_role,h.hub_id,h.currency_id,u.unit_scale INTO f FROM public.finance_journal_lines l JOIN public.finance_accounts h ON h.academy_id=l.academy_id AND h.id=l.account_id JOIN public.finance_account_revisions a ON a.academy_id=l.academy_id AND a.account_id=l.account_id AND a.version=l.account_version JOIN public.finance_currency_revisions u ON u.academy_id=h.academy_id AND u.currency_id=h.currency_id AND u.version=h.currency_version WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.journal_id AND l.line_number=NEW.treasury_line;
 -- Shared head lock permits concurrent payments but pins method version and
 -- activity until commit;an editor must not retire it after this proof check.
 PERFORM 1 FROM public.finance_payment_methods WHERE academy_id=NEW.academy_id AND id=NEW.method_id FOR SHARE;
 SELECT * INTO m FROM public.finance_payment_method_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.method_id;
 IF NEW.handled_by IS NOT NULL THEN SELECT * INTO handler FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.handled_by FOR SHARE;END IF;
 IF NEW.evidence_file IS NOT NULL THEN SELECT * INTO evidence FROM public.file_records WHERE academy_id=NEW.academy_id AND id=NEW.evidence_file FOR SHARE;END IF;
 IF NEW.reference<>'' THEN PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('counterparty-payment-reference',NEW.academy_id,NEW.payee_id,NEW.treasury_account,NEW.method_id,NEW.reference)::text,0));END IF;
 source=public.counterparty_payment_reference(NEW.payee_id,NEW.treasury_account,NEW.method_id,NEW.reference,j.posted_on);
 IF(source->>'inUse')::boolean THEN RAISE EXCEPTION 'COUNTERPARTY_PAYMENT_REFERENCE_EXISTS' USING ERRCODE='23505';END IF;
 expected=jsonb_build_object('treasuryLineNumber',NEW.treasury_line,'method',jsonb_build_object('id',NEW.method_id,'version',NEW.method_version),'transferredAt',NEW.transferred_at_input,'handledById',NEW.handled_by,'evidence',CASE WHEN NEW.evidence_file IS NULL THEN NULL ELSE jsonb_build_object('id',NEW.evidence_file,'version',NEW.evidence_version) END,'missingEvidenceReason',NEW.missing_evidence_reason,'taxTreatment',NEW.tax_treatment);
 IF j.id IS NULL OR j.reverses_id IS NOT NULL OR j.purpose<>'activity' OR j.line_count<>2 OR j.created_at<>transaction_timestamp() OR j.posted_by IS DISTINCT FROM NEW.created_by OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.reference IS DISTINCT FROM NEW.reference
  OR j.posted_on::text IS DISTINCT FROM p.payload->>'postedOn' OR j.period_id::text IS DISTINCT FROM p.payload->>'periodId' OR j.period_version::text IS DISTINCT FROM p.payload->>'periodVersion' OR j.description IS DISTINCT FROM p.payload->>'description'
  OR t.journal_id IS NULL OR t.payee_id IS DISTINCT FROM NEW.payee_id OR t.category NOT IN('loan_advance','loan_repayment')
  OR b.account_id IS NULL OR f.account_id IS NULL OR b.account_id=f.account_id OR f.account_id IS DISTINCT FROM NEW.treasury_account OR f.operational_role NOT IN('cash','bank','credit_card')
  OR b.currency_id IS DISTINCT FROM f.currency_id OR b.unit_scale IS DISTINCT FROM f.unit_scale OR b.side=f.side OR b.amount_minor<>f.amount_minor
  OR b.side IS DISTINCT FROM(CASE WHEN(t.category='loan_advance')=(b.kind='asset') THEN 'debit' ELSE 'credit' END)
  OR m.id IS NULL OR m.version IS DISTINCT FROM NEW.method_version OR NOT m.active OR(m.hub_id IS NOT NULL AND m.hub_id IS DISTINCT FROM b.hub_id AND m.hub_id IS DISTINCT FROM f.hub_id)
  OR(NEW.handled_by IS NOT NULL AND(handler.id IS NULL OR handler.kind<>'human' OR handler.status<>'active'))
  OR(NEW.evidence_file IS NOT NULL AND(evidence.id IS NULL OR evidence.version IS DISTINCT FROM NEW.evidence_version OR evidence.archived OR evidence.domain<>'finance_private' OR NOT(evidence.anchor_kind='academy' OR(evidence.anchor_kind='hub' AND(evidence.hub_id=b.hub_id OR evidence.hub_id=f.hub_id)))))
  OR p.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR p.action IS DISTINCT FROM 'finance.journal.post' OR p.target_id IS DISTINCT FROM NEW.journal_id OR p.payload->'counterpartyPayment' IS DISTINCT FROM expected
  OR p.review_context#>'{counterpartyPayment,input}' IS DISTINCT FROM expected OR p.review_context#>'{counterpartyPayment,referenceState}' IS DISTINCT FROM source
  OR p.review_context#>'{counterpartyPayment,method}' IS DISTINCT FROM jsonb_build_object('id',m.id,'version',m.version,'active',m.active,'hubId',m.hub_id,'category',m.category)
  OR p.review_context#>'{counterpartyPayment,handler}' IS DISTINCT FROM(CASE WHEN NEW.handled_by IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',handler.id,'status',handler.status,'hubId',handler.hub_id) END)
  OR p.review_context#>'{counterpartyPayment,evidence}' IS DISTINCT FROM(CASE WHEN NEW.evidence_file IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',evidence.id,'version',evidence.version,'archived',evidence.archived) END)
  OR(NEW.handled_by=NEW.created_by AND NOT EXISTS(SELECT 1 FROM public.academies a WHERE a.id=NEW.academy_id AND a.master_person_id=NEW.created_by))
  OR NOT public.report_comment_human_verified(NEW.created_by)
  OR EXISTS(SELECT 1 FROM public.finance_journal_lines l CROSS JOIN LATERAL(SELECT p.payload->'lines'->(l.line_number-1) value) x WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.journal_id AND(x.value->>'accountId' IS DISTINCT FROM l.account_id::text OR x.value->>'accountVersion' IS DISTINCT FROM l.account_version::text OR x.value->>'side' IS DISTINCT FROM l.side OR(x.value->>'amount')::numeric*('1'||repeat('0',b.unit_scale))::numeric IS DISTINCT FROM l.amount_minor OR coalesce(x.value->>'note','') IS DISTINCT FROM l.note))
 THEN RAISE EXCEPTION 'COUNTERPARTY_PAYMENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER counterparty_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON public.counterparty_payments FOR EACH ROW EXECUTE FUNCTION public.guard_counterparty_payment();
CREATE CONSTRAINT TRIGGER counterparty_payment_reviewed AFTER INSERT ON public.counterparty_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.counterparty_payment_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.journal.post' AND NEW.status='applied' AND NEW.payload ? 'counterpartyPayment' AND NOT EXISTS(SELECT 1 FROM public.counterparty_payments p WHERE p.academy_id=NEW.academy_id AND p.journal_id=NEW.target_id AND p.approval_id=NEW.id AND p.created_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'COUNTERPARTY_PAYMENT_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER counterparty_payment_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.counterparty_payment_effect_required();
CREATE FUNCTION public.counterparty_payment_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE i jsonb;m record;BEGIN
 IF NEW.action='finance.journal.post' THEN IF NOT(NEW.payload ? 'counterpartyPayment') THEN RETURN NEW;END IF;i=NEW.payload->'counterpartyPayment';
 ELSE SELECT p.payload->'counterpartyPayment' INTO i FROM public.finance_journals j JOIN public.approval_requests p ON p.academy_id=j.academy_id AND p.id=j.approval_id WHERE j.academy_id=NEW.academy_id AND j.id=(NEW.payload->>'reversesId')::uuid;IF i IS NULL THEN RETURN NEW;END IF;END IF;
 SELECT hub_id INTO m FROM public.finance_payment_methods WHERE academy_id=NEW.academy_id AND id=(i#>>'{method,id}')::uuid;
 IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('payment-methods.view',ARRAY[m.hub_id]));END IF;
 IF i->>'handledById' IS NOT NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','people.view','personId',(i->>'handledById')::uuid));END IF;
 IF i#>>'{evidence,id}' IS NOT NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('fileId',(i#>>'{evidence,id}')::uuid));END IF;
 RETURN NEW;EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;
END $$;
CREATE TRIGGER zz_counterparty_payment_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.journal.post','finance.journal.reverse')) EXECUTE FUNCTION public.counterparty_payment_privacy();
REVOKE ALL ON FUNCTION public.counterparty_payment_reference(uuid,uuid,uuid,text,date),public.guard_counterparty_payment(),public.counterparty_payment_effect_required(),public.counterparty_payment_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.counterparty_payment_reference(uuid,uuid,uuid,text,date) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 269 $$;

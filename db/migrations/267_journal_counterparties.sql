INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('counterparty-balances.view','View explicit external balance-sheet counterparties','Finance',true,ARRAY['hub','country','region','city']),
 ('counterparty-balances.edit','Request reviewed external balance-sheet entries','Finance',true,ARRAY['hub','country','region','city']);
-- Amounts and dates remain in the original immutable balanced journal. These
-- links are neither another cash ledger nor editable accounts-receivable totals.
CREATE TABLE public.finance_journal_counterparties(
 academy_id uuid NOT NULL,journal_id uuid NOT NULL,line_number smallint NOT NULL,
 payee_id uuid NOT NULL,payee_version integer NOT NULL,category text NOT NULL CHECK(category IN('loan_advance','loan_repayment','opening_balance','balance_adjustment')),
 approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,journal_id,line_number),
 FOREIGN KEY(academy_id,journal_id,line_number) REFERENCES public.finance_journal_lines(academy_id,journal_id,line_number),
 FOREIGN KEY(academy_id,payee_id,payee_version) REFERENCES public.financial_payee_revisions(academy_id,payee_id,version),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE INDEX journal_counterparties_payee ON public.finance_journal_counterparties(academy_id,payee_id,journal_id,line_number);
ALTER TABLE public.finance_journal_counterparties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_journal_counterparties FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.finance_journal_counterparties USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.finance_journal_counterparties TO kavosh_runtime;
GRANT INSERT(academy_id,journal_id,line_number,payee_id,payee_version,category,approval_id,created_by) ON public.finance_journal_counterparties TO kavosh_runtime;

CREATE FUNCTION public.guard_journal_counterparty() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE j record;p record;a record;payee record;rev record;hubs jsonb;expected jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'JOURNAL_COUNTERPARTY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.journal_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 SELECT h.id,h.hub_id,r.kind,r.operational_role INTO a FROM public.finance_journal_lines l JOIN public.finance_accounts h ON h.academy_id=l.academy_id AND h.id=l.account_id JOIN public.finance_account_revisions r ON r.academy_id=l.academy_id AND r.account_id=l.account_id AND r.version=l.account_version WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.journal_id AND l.line_number=NEW.line_number;
 SELECT * INTO payee FROM public.financial_payees WHERE academy_id=NEW.academy_id AND id=NEW.payee_id FOR SHARE;
 SELECT * INTO rev FROM public.financial_payee_revisions WHERE academy_id=NEW.academy_id AND payee_id=NEW.payee_id AND version=NEW.payee_version;
 SELECT CASE WHEN bool_or(hub_id IS NULL) THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) ELSE jsonb_build_object('all',false,'hubs',jsonb_agg(hub_id ORDER BY hub_id)) END INTO hubs FROM(
  SELECT DISTINCT h.hub_id FROM public.finance_journal_lines l JOIN public.finance_accounts h ON h.academy_id=l.academy_id AND h.id=l.account_id WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.journal_id
  UNION SELECT h.hub_id FROM jsonb_array_elements(p.payload->'counterpartyLines') t JOIN public.financial_payees h ON h.academy_id=NEW.academy_id AND h.id=(t#>>'{payee,id}')::uuid WHERE h.hub_id IS NOT NULL
 ) all_hubs;
 expected=jsonb_build_object('lineNumber',NEW.line_number,'payee',jsonb_build_object('id',NEW.payee_id,'version',NEW.payee_version),'category',NEW.category);
 IF j.id IS NULL OR j.reverses_id IS NOT NULL OR j.created_at<>transaction_timestamp() OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.posted_by IS DISTINCT FROM NEW.created_by
  OR a.id IS NULL OR a.kind NOT IN('asset','liability') OR a.operational_role NOT IN('unclassified','other')
  OR(NEW.category='opening_balance') IS DISTINCT FROM(j.purpose='opening') OR j.purpose NOT IN('opening','activity')
  OR payee.id IS NULL OR payee.kind='academy' OR payee.version IS DISTINCT FROM NEW.payee_version OR rev.active IS DISTINCT FROM true
  OR p.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR p.action IS DISTINCT FROM 'finance.journal.post' OR p.privacy_capability IS DISTINCT FROM 'journals.edit'
  OR p.target_id IS DISTINCT FROM NEW.journal_id OR p.target_version<>0 OR p.scope IS DISTINCT FROM hubs
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.payload->'counterpartyLines') t WHERE t=expected)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.review_context#>'{counterparties,payees}') v WHERE v=jsonb_build_object('id',payee.id,'version',NEW.payee_version,'currentVersion',payee.version,'active',rev.active,'currentActive',rev.active,'hubId',payee.hub_id,'personId',payee.person_id,'kind',payee.kind))
  OR NOT public.report_comment_human_verified(NEW.created_by)
  OR(payee.person_id=NEW.created_by AND NOT EXISTS(SELECT 1 FROM public.academies ac WHERE ac.id=NEW.academy_id AND ac.master_person_id=NEW.created_by))
 THEN RAISE EXCEPTION 'JOURNAL_COUNTERPARTY_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_counterparty_guard BEFORE INSERT OR UPDATE OR DELETE ON public.finance_journal_counterparties FOR EACH ROW EXECUTE FUNCTION public.guard_journal_counterparty();
CREATE CONSTRAINT TRIGGER journal_counterparty_reviewed AFTER INSERT ON public.finance_journal_counterparties DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();

CREATE FUNCTION public.complete_journal_counterparties() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;tags jsonb;expected integer;
BEGIN
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF NEW.reverses_id IS NULL THEN
  IF p.action<>'finance.journal.post' OR NOT(p.payload ? 'counterpartyLines') THEN RETURN NULL;END IF;tags=p.payload->'counterpartyLines';
  IF jsonb_typeof(tags) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'JOURNAL_COUNTERPARTY_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;
  expected=jsonb_array_length(tags);
  IF expected NOT BETWEEN 1 AND NEW.line_count OR expected<>(SELECT count(*) FROM public.finance_journal_counterparties WHERE academy_id=NEW.academy_id AND journal_id=NEW.id) THEN RAISE EXCEPTION 'JOURNAL_COUNTERPARTY_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.finance_journal_counterparties WHERE academy_id=NEW.academy_id AND journal_id=NEW.reverses_id) THEN RETURN NULL;END IF;
  IF p.action IS DISTINCT FROM 'finance.journal.reverse' OR p.payload->>'reversesId' IS DISTINCT FROM NEW.reverses_id::text THEN RAISE EXCEPTION 'JOURNAL_COUNTERPARTY_CORRECTION_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 IF p.status IS DISTINCT FROM 'applied' OR p.target_id IS DISTINCT FROM NEW.id OR p.reviewer_id IS DISTINCT FROM NEW.posted_by
  OR NOT public.report_comment_human_verified(NEW.posted_by)
  OR(NOT EXISTS(SELECT 1 FROM public.academies a WHERE a.id=NEW.academy_id AND a.master_person_id=NEW.posted_by) AND EXISTS(SELECT 1 FROM public.finance_journal_counterparties t JOIN public.financial_payees payee ON payee.academy_id=t.academy_id AND payee.id=t.payee_id WHERE t.academy_id=NEW.academy_id AND t.journal_id=coalesce(NEW.reverses_id,NEW.id) AND payee.person_id=NEW.posted_by))
 THEN RAISE EXCEPTION 'JOURNAL_COUNTERPARTY_APPROVED_HUMAN_REQUIRED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.id AND e.actor_id=NEW.posted_by AND e.created_at=transaction_timestamp() AND e.action=CASE WHEN NEW.reverses_id IS NULL THEN 'finance.journal.posted' ELSE 'finance.journal.reversed' END AND e.changes=jsonb_build_object('approvalId',NEW.approval_id,'periodId',NEW.period_id,'purpose',NEW.purpose,'lineCount',NEW.line_count,'reversesId',NEW.reverses_id,'severity','critical','hasReason',true)) THEN RAISE EXCEPTION 'JOURNAL_COUNTERPARTY_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_counterparties_complete AFTER INSERT ON public.finance_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_journal_counterparties();
CREATE FUNCTION public.journal_counterparty_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND NEW.action='finance.journal.post' AND NEW.payload ? 'counterpartyLines' THEN
  IF jsonb_typeof(NEW.payload->'counterpartyLines') IS DISTINCT FROM 'array' OR NOT EXISTS(SELECT 1 FROM public.finance_journals j WHERE j.academy_id=NEW.academy_id AND j.id=NEW.target_id AND j.approval_id=NEW.id AND j.posted_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'JOURNAL_COUNTERPARTY_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;
  IF jsonb_array_length(NEW.payload->'counterpartyLines')<>(SELECT count(*) FROM public.finance_journal_counterparties WHERE academy_id=NEW.academy_id AND journal_id=NEW.target_id) THEN RAISE EXCEPTION 'JOURNAL_COUNTERPARTY_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_counterparty_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.journal_counterparty_effect_required();

CREATE FUNCTION public.journal_counterparty_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tags jsonb;source_id uuid;t jsonb;p record;hubs uuid[];
BEGIN
 IF NEW.action='finance.journal.post' THEN tags=NEW.payload->'counterpartyLines';IF NOT(NEW.payload ? 'counterpartyLines') THEN RETURN NEW;END IF;
 ELSE
  source_id=(NEW.payload->>'reversesId')::uuid;SELECT jsonb_agg(jsonb_build_object('lineNumber',line_number,'payee',jsonb_build_object('id',payee_id,'version',payee_version),'category',category)) INTO tags FROM public.finance_journal_counterparties WHERE academy_id=NEW.academy_id AND journal_id=source_id;
  IF tags IS NULL THEN RETURN NEW;END IF;
 END IF;
 IF jsonb_typeof(tags) IS DISTINCT FROM 'array' OR jsonb_array_length(tags) NOT BETWEEN 1 AND 200 THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 IF source_id IS NULL THEN SELECT array_agg(DISTINCT a.hub_id) INTO hubs FROM jsonb_array_elements(NEW.payload->'lines') l JOIN public.finance_accounts a ON a.academy_id=NEW.academy_id AND a.id=(l->>'accountId')::uuid;
 ELSE SELECT array_agg(DISTINCT a.hub_id) INTO hubs FROM public.finance_journal_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id WHERE l.academy_id=NEW.academy_id AND l.journal_id=source_id;END IF;
 IF hubs IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('counterparty-balances.view',hubs));
 FOR t IN SELECT * FROM jsonb_array_elements(tags) LOOP
  SELECT * INTO p FROM public.financial_payees WHERE academy_id=NEW.academy_id AND id=(t#>>'{payee,id}')::uuid;
  IF p.id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;
  ELSIF p.hub_id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','payees.view','any',true));
  ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('payees.view',ARRAY[p.hub_id]),public.approval_hub_binding('counterparty-balances.view',ARRAY[p.hub_id]));END IF;
 END LOOP;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;
END $$;
CREATE TRIGGER zz_journal_counterparty_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.journal.post','finance.journal.reverse')) EXECUTE FUNCTION public.journal_counterparty_privacy();

CREATE VIEW public.counterparty_balance_events WITH(security_invoker=true) AS
 SELECT t.academy_id,t.payee_id,t.payee_version,j.id AS journal_id,t.line_number,t.category,j.posted_on,l.account_id,a.currency_id,u.unit_scale,CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END AS delta_minor
 FROM public.finance_journal_counterparties t JOIN public.finance_journals j ON j.academy_id=t.academy_id AND j.id=t.journal_id JOIN public.finance_journal_lines l ON l.academy_id=t.academy_id AND l.journal_id=t.journal_id AND l.line_number=t.line_number JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version
 UNION ALL SELECT t.academy_id,t.payee_id,t.payee_version,j.id,t.line_number,t.category,j.posted_on,l.account_id,a.currency_id,u.unit_scale,CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END
 FROM public.finance_journal_counterparties t JOIN public.finance_journals j ON j.academy_id=t.academy_id AND j.reverses_id=t.journal_id JOIN public.finance_journal_lines l ON l.academy_id=j.academy_id AND l.journal_id=j.id AND l.line_number=t.line_number JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version;
GRANT SELECT ON public.counterparty_balance_events TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.guard_journal_counterparty(),public.complete_journal_counterparties(),public.journal_counterparty_effect_required(),public.journal_counterparty_privacy() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 267 $$;

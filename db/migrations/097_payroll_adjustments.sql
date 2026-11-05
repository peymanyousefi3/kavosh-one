INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payroll-adjustments.view','View private manual gross compensation accruals','Finance',true,ARRAY['hub','person','country','region','city']),
 ('payroll-adjustments.edit','Request reviewed manual compensation accruals and corrections','Finance',true,ARRAY['hub','person','country','region','city']);
-- Gross base remuneration only. This is not payment, a contractor invoice,
-- statutory deductions, employer contributions or a sales-tax determination.
CREATE TABLE public.payroll_adjustments(
 academy_id uuid NOT NULL,id uuid NOT NULL,engagement_id uuid NOT NULL,engagement_version integer NOT NULL,terms_version integer NOT NULL,person_id uuid NOT NULL,hub_id uuid,
 reference text NOT NULL CHECK(reference~'^[A-Z0-9][A-Z0-9._-]{0,63}$'),earned_on date NOT NULL,due_on date NOT NULL,posted_on date NOT NULL,period_id uuid NOT NULL,period_version integer NOT NULL,
 currency_id uuid NOT NULL,currency_version integer NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),amount_minor numeric NOT NULL CHECK(amount_minor>0 AND amount_minor=trunc(amount_minor) AND amount_minor<1e38),
 expense_account uuid NOT NULL,expense_version integer NOT NULL,liability_account uuid NOT NULL,liability_version integer NOT NULL,
 earning_review text NOT NULL CHECK(length(btrim(earning_review)) BETWEEN 1 AND 2000),tax_review text NOT NULL CHECK(length(btrim(tax_review)) BETWEEN 1 AND 2000),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=65536),approval_id uuid NOT NULL,created_by uuid NOT NULL,void_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,engagement_id,reference),
 CHECK(earned_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' AND due_on BETWEEN earned_on AND DATE '9999-12-31' AND posted_on BETWEEN earned_on AND DATE '9999-12-31'),
 FOREIGN KEY(academy_id,engagement_id,terms_version) REFERENCES public.work_engagement_revisions(academy_id,engagement_id,version),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,currency_id,currency_version) REFERENCES public.finance_currency_revisions(academy_id,currency_id,version),FOREIGN KEY(academy_id,expense_account,expense_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,liability_account,liability_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,period_id,period_version) REFERENCES public.finance_period_revisions(academy_id,period_id,version),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.payroll_adjustment_voids(
 academy_id uuid NOT NULL,id uuid NOT NULL,adjustment_id uuid NOT NULL,source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=65536),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,adjustment_id),UNIQUE(academy_id,id,adjustment_id),FOREIGN KEY(academy_id,adjustment_id) REFERENCES public.payroll_adjustments(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.payroll_adjustments ADD CONSTRAINT payroll_adjustment_void_identity FOREIGN KEY(academy_id,void_id,id) REFERENCES public.payroll_adjustment_voids(academy_id,id,adjustment_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX payroll_adjustment_worker_due ON public.payroll_adjustments(academy_id,person_id,due_on,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payroll_adjustments','payroll_adjustment_voids'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER payroll_adjustment_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,engagement_id,engagement_version,terms_version,person_id,hub_id,reference,earned_on,due_on,posted_on,period_id,period_version,currency_id,currency_version,unit_scale,amount_minor,expense_account,expense_version,liability_account,liability_version,earning_review,tax_review,reason,source_snapshot,approval_id,created_by) ON public.payroll_adjustments TO kavosh_runtime;
GRANT UPDATE(void_id) ON public.payroll_adjustments TO kavosh_runtime;
GRANT INSERT(academy_id,id,adjustment_id,source_snapshot,reason,approval_id,created_by) ON public.payroll_adjustment_voids TO kavosh_runtime;
CREATE FUNCTION public.payroll_adjustment_source(p_work uuid,p_on date,p_expense uuid,p_liability uuid,p_period uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;w record;r record;p record;a jsonb;BEGIN
 PERFORM public.lock_pay_period_work(p_work);
 SELECT * INTO w FROM public.work_engagements WHERE academy_id=tenant AND id=p_work;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO r FROM public.work_engagement_revisions WHERE academy_id=tenant AND engagement_id=p_work AND effective_on<=p_on ORDER BY effective_on DESC,version DESC LIMIT 1;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO p FROM public.finance_periods WHERE academy_id=tenant AND id=p_period FOR SHARE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM id FROM public.finance_accounts WHERE academy_id=tenant AND id IN(p_expense,p_liability) ORDER BY id FOR SHARE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'hubId',hub_id,'version',version,'kind',kind,'role',operational_role,'active',active,'currencyId',currency_id,'currencyVersion',currency_version,'unitScale',unit_scale) ORDER BY id),'[]'::jsonb) INTO a FROM public.finance_account_catalogue WHERE academy_id=tenant AND id IN(p_expense,p_liability);
 RETURN jsonb_build_object('work',jsonb_build_object('id',w.id,'personId',w.person_id,'hubId',w.hub_id,'headerVersion',w.version,'termsVersion',r.version,'effectiveOn',r.effective_on::text,'currencyId',r.currency_id,'currencyVersion',r.currency_version,'unitScale',r.unit_scale,'employerId',r.employer_id,'employerVersion',r.employer_version,'payeeId',r.payee_id,'payeeVersion',r.payee_version,'classification',r.definition->>'classification','active',r.definition->'active','startsOn',r.definition->>'startsOn','endsOn',r.definition->>'endsOn'),
 'accounts',a,'period',jsonb_build_object('id',p.id,'version',p.version,'state',p.state,'startsOn',p.starts_on::text,'endsOn',p.ends_on::text,'closedThrough',(SELECT max(ends_on)::text FROM public.finance_periods WHERE academy_id=tenant AND state='closed' AND active_closing_run_id IS NOT NULL)));
END $$;
CREATE FUNCTION public.payroll_adjustment_void_source(p_adjustment uuid,p_period uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;b record;s jsonb;BEGIN
 SELECT * INTO b FROM public.payroll_adjustments WHERE academy_id=tenant AND id=p_adjustment;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM public.lock_pay_period_work(b.engagement_id);SELECT * INTO b FROM public.payroll_adjustments WHERE academy_id=tenant AND id=p_adjustment FOR UPDATE;
 -- The original terms/date remain available even after employment has ended.
 s=public.payroll_adjustment_source(b.engagement_id,b.earned_on,b.expense_account,b.liability_account,p_period);IF s IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('before',jsonb_build_object('id',b.id,'engagementId',b.engagement_id,'personId',b.person_id,'hubId',b.hub_id,'voidId',b.void_id,'postedOn',b.posted_on::text,'currencyId',b.currency_id,'unitScale',b.unit_scale,'amountMinor',b.amount_minor::text,'expenseAccount',b.expense_account,'expenseVersion',b.expense_version,'liabilityAccount',b.liability_account,'liabilityVersion',b.liability_version),'current',s);
END $$;
CREATE FUNCTION public.guard_payroll_adjustment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;s jsonb;w jsonb;a jsonb;e jsonb;l jsonb;expected jsonb;target jsonb;BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.void_id IS NOT NULL OR NEW.void_id IS NULL OR to_jsonb(NEW)-'void_id' IS DISTINCT FROM to_jsonb(OLD)-'void_id' THEN RAISE EXCEPTION 'PAYROLL_ADJUSTMENT_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 s=public.payroll_adjustment_source(NEW.engagement_id,NEW.earned_on,NEW.expense_account,NEW.liability_account,NEW.period_id);w=s->'work';a=s->'period';
 SELECT value INTO e FROM jsonb_array_elements(s->'accounts') WHERE value->>'id'=NEW.expense_account::text;SELECT value INTO l FROM jsonb_array_elements(s->'accounts') WHERE value->>'id'=NEW.liability_account::text;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 target=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',NEW.person_id,'hubId',NEW.hub_id)),'workContext',jsonb_build_object('personId',NEW.person_id,'hubId',NEW.hub_id));
 expected=jsonb_build_object('engagement',jsonb_build_object('id',NEW.engagement_id,'version',NEW.engagement_version),'termsVersion',NEW.terms_version,'reference',NEW.reference,'earnedOn',NEW.earned_on::text,'dueOn',NEW.due_on::text,'postedOn',NEW.posted_on::text,'period',jsonb_build_object('id',NEW.period_id,'version',NEW.period_version),'expenseAccount',jsonb_build_object('id',NEW.expense_account,'version',NEW.expense_version),'liabilityAccount',jsonb_build_object('id',NEW.liability_account,'version',NEW.liability_version),'amount',p.payload->'amount','earningReview',NEW.earning_review,'taxReview',NEW.tax_review,'reason',NEW.reason);
 IF s IS NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.adjustment.record' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.privacy_capability IS DISTINCT FROM 'payroll-adjustments.view' OR p.scope IS DISTINCT FROM target OR p.payload IS DISTINCT FROM expected OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR NOT public.report_comment_human_verified(NEW.created_by)
 OR w->>'personId' IS DISTINCT FROM NEW.person_id::text OR(w->>'hubId')::uuid IS DISTINCT FROM NEW.hub_id OR(w->>'headerVersion')::integer IS DISTINCT FROM NEW.engagement_version OR(w->>'termsVersion')::integer IS DISTINCT FROM NEW.terms_version OR(w->>'currencyId')::uuid IS DISTINCT FROM NEW.currency_id OR(w->>'currencyVersion')::integer IS DISTINCT FROM NEW.currency_version OR(w->>'unitScale')::integer IS DISTINCT FROM NEW.unit_scale OR w->'active' IS DISTINCT FROM 'true'::jsonb OR w->>'classification' NOT IN('employee','contractor') OR NEW.earned_on<(w->>'startsOn')::date OR(w->>'endsOn' IS NOT NULL AND NEW.earned_on>(w->>'endsOn')::date)
 OR jsonb_typeof(p.payload->'amount') IS DISTINCT FROM 'string' OR length(p.payload->>'amount')>80 OR p.payload->>'amount'!~'^[0-9]+(\.[0-9]+)?$' THEN RAISE EXCEPTION 'PAYROLL_ADJUSTMENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF(p.payload->>'amount')::numeric*power(10::numeric,NEW.unit_scale) IS DISTINCT FROM NEW.amount_minor THEN RAISE EXCEPTION 'PAYROLL_ADJUSTMENT_AMOUNT_INVALID' USING ERRCODE='23514';END IF;
 IF e IS NULL OR l IS NULL OR e->>'kind'<>'expense' OR e->>'role'<>'expense' OR l->>'kind'<>'liability' OR l->>'role'<>'payable' OR e->'active'<>'true'::jsonb OR l->'active'<>'true'::jsonb
 OR(e->>'version')::integer<>NEW.expense_version OR(l->>'version')::integer<>NEW.liability_version OR e->>'currencyId'<>NEW.currency_id::text OR l->>'currencyId'<>NEW.currency_id::text OR(e->>'unitScale')::integer<>NEW.unit_scale OR(l->>'unitScale')::integer<>NEW.unit_scale OR(e->>'hubId' IS NOT NULL AND(e->>'hubId')::uuid IS DISTINCT FROM NEW.hub_id) OR(l->>'hubId' IS NOT NULL AND(l->>'hubId')::uuid IS DISTINCT FROM NEW.hub_id)
 OR(a->>'version')::integer<>NEW.period_version OR a->>'state'<>'open' OR NEW.posted_on NOT BETWEEN(a->>'startsOn')::date AND(a->>'endsOn')::date OR(a->>'closedThrough' IS NOT NULL AND NEW.posted_on<=(a->>'closedThrough')::date) THEN RAISE EXCEPTION 'PAYROLL_ADJUSTMENT_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.created_by=NEW.person_id AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payroll_adjustment_guard BEFORE INSERT OR UPDATE ON public.payroll_adjustments FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_adjustment();
CREATE FUNCTION public.guard_payroll_adjustment_void() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;s jsonb;b jsonb;w jsonb;target jsonb;expected jsonb;BEGIN
 s=public.payroll_adjustment_void_source(NEW.adjustment_id,(SELECT(payload->'period'->>'id')::uuid FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id));b=s->'before';w=s#>'{current,work}';
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 target=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',w->>'personId','hubId',w->'hubId')),'workContext',jsonb_build_object('personId',w->>'personId','hubId',w->'hubId'));
 expected=jsonb_build_object('adjustmentId',NEW.adjustment_id,'period',p.payload->'period','postedOn',p.payload->'postedOn','reason',NEW.reason);
 IF s IS NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.adjustment.void' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.privacy_capability IS DISTINCT FROM 'payroll-adjustments.view' OR p.scope IS DISTINCT FROM target OR p.payload IS DISTINCT FROM expected OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR b->>'voidId' IS NOT NULL OR NOT public.report_comment_human_verified(NEW.created_by)
 OR jsonb_typeof(p.payload->'period') IS DISTINCT FROM 'object' OR p.payload->'period' IS DISTINCT FROM jsonb_build_object('id',s#>'{current,period,id}','version',s#>'{current,period,version}') OR jsonb_typeof(p.payload->'postedOn') IS DISTINCT FROM 'string' OR p.payload->>'postedOn'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR(p.payload->>'postedOn')::date<(b->>'postedOn')::date THEN RAISE EXCEPTION 'PAYROLL_ADJUSTMENT_VOID_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.created_by=(b->>'personId')::uuid AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payroll_adjustment_void_guard BEFORE INSERT ON public.payroll_adjustment_voids FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_adjustment_void();
CREATE FUNCTION public.payroll_adjustment_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE j record;v record;b record;s jsonb;BEGIN
 IF TG_TABLE_NAME='payroll_adjustments' THEN
  SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
  IF j.id IS NULL OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.posted_by IS DISTINCT FROM NEW.created_by OR j.period_id IS DISTINCT FROM NEW.period_id OR j.period_version IS DISTINCT FROM NEW.period_version OR j.posted_on IS DISTINCT FROM NEW.posted_on OR j.purpose IS DISTINCT FROM 'activity' OR j.reverses_id IS NOT NULL OR j.line_count<>2 OR j.description IS DISTINCT FROM 'Gross remuneration accrual' OR j.reference IS DISTINCT FROM 'PAYROLL-ADJUSTMENT'
  OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=1 AND account_id=NEW.expense_account AND account_version=NEW.expense_version AND side='debit' AND amount_minor=NEW.amount_minor AND note='')
  OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=2 AND account_id=NEW.liability_account AND account_version=NEW.liability_version AND side='credit' AND amount_minor=NEW.amount_minor AND note='') THEN RAISE EXCEPTION 'PAYROLL_ADJUSTMENT_POSTING_REQUIRED' USING ERRCODE='23514';END IF;
  s=public.payroll_adjustment_source(NEW.engagement_id,NEW.earned_on,NEW.expense_account,NEW.liability_account,NEW.period_id);IF s IS DISTINCT FROM NEW.source_snapshot THEN RAISE EXCEPTION 'PAYROLL_ADJUSTMENT_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO b FROM public.payroll_adjustments WHERE academy_id=NEW.academy_id AND id=NEW.adjustment_id;SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
  IF b.void_id IS DISTINCT FROM NEW.id OR j.id IS NULL OR j.reverses_id IS DISTINCT FROM b.id OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.posted_by IS DISTINCT FROM NEW.created_by OR j.description IS DISTINCT FROM 'Correction of gross remuneration accrual' OR j.reference IS DISTINCT FROM 'PAYROLL-ADJUSTMENT-CORRECTION' OR j.purpose IS DISTINCT FROM 'activity' OR j.line_count<>2
  OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=1 AND account_id=b.expense_account AND account_version=b.expense_version AND side='credit' AND amount_minor=b.amount_minor AND note='')
  OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=2 AND account_id=b.liability_account AND account_version=b.liability_version AND side='debit' AND amount_minor=b.amount_minor AND note='')
  OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND(p.payload->'period'->>'id')::uuid=j.period_id AND(p.payload->'period'->>'version')::integer=j.period_version AND(p.payload->>'postedOn')::date=j.posted_on) THEN RAISE EXCEPTION 'PAYROLL_ADJUSTMENT_VOID_POSTING_REQUIRED' USING ERRCODE='23514';END IF;
  s=public.payroll_adjustment_void_source(NEW.adjustment_id,j.period_id);
  IF s->'current' IS DISTINCT FROM NEW.source_snapshot->'current' OR(s->'before')-'voidId' IS DISTINCT FROM(NEW.source_snapshot->'before')-'voidId' THEN RAISE EXCEPTION 'PAYROLL_ADJUSTMENT_VOID_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_adjustment_complete AFTER INSERT ON public.payroll_adjustments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_adjustment_complete();
CREATE CONSTRAINT TRIGGER payroll_adjustment_void_complete AFTER INSERT ON public.payroll_adjustment_voids DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_adjustment_complete();
CREATE CONSTRAINT TRIGGER payroll_adjustment_reviewed AFTER INSERT ON public.payroll_adjustments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE CONSTRAINT TRIGGER payroll_adjustment_void_reviewed AFTER INSERT ON public.payroll_adjustment_voids DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.payroll_adjustment_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND((NEW.action='work.adjustment.record' AND NOT EXISTS(SELECT 1 FROM public.payroll_adjustments WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id)) OR(NEW.action='work.adjustment.void' AND NOT EXISTS(SELECT 1 FROM public.payroll_adjustment_voids WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id))) THEN RAISE EXCEPTION 'PAYROLL_ADJUSTMENT_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_adjustment_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_adjustment_effect_required();
CREATE FUNCTION public.payroll_adjustment_reversal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.payroll_adjustments WHERE academy_id=NEW.academy_id AND id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.payroll_adjustment_voids v JOIN public.approval_requests p ON p.academy_id=v.academy_id AND p.id=v.approval_id WHERE v.academy_id=NEW.academy_id AND v.id=NEW.id AND v.adjustment_id=NEW.reverses_id AND p.action='work.adjustment.void' AND p.target_id=NEW.id AND p.payload->>'adjustmentId'=NEW.reverses_id::text AND NEW.approval_id=p.id) THEN RAISE EXCEPTION 'PAYROLL_ADJUSTMENT_CORRECTION_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER payroll_adjustment_reversal_guard BEFORE INSERT ON public.finance_journals FOR EACH ROW WHEN(NEW.reverses_id IS NOT NULL) EXECUTE FUNCTION public.payroll_adjustment_reversal_guard();
CREATE FUNCTION public.payroll_adjustment_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE w record;b record;a record;scope jsonb;ids uuid[];BEGIN
 IF NEW.action='work.adjustment.record' THEN SELECT * INTO w FROM public.work_engagements WHERE academy_id=NEW.academy_id AND id=(NEW.payload->'engagement'->>'id')::uuid;ids=ARRAY[(NEW.payload->'expenseAccount'->>'id')::uuid,(NEW.payload->'liabilityAccount'->>'id')::uuid];
 ELSE SELECT * INTO b FROM public.payroll_adjustments WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'adjustmentId')::uuid;SELECT * INTO w FROM public.work_engagements WHERE academy_id=NEW.academy_id AND id=b.engagement_id;ids=ARRAY[b.expense_account,b.liability_account];END IF;
 IF w.id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',w.person_id,'hubId',w.hub_id)),'workContext',jsonb_build_object('personId',w.person_id,'hubId',w.hub_id));
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','work-pay.view','scope',scope));
 FOR a IN SELECT id,hub_id FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=ANY(ids) LOOP
  scope=CASE WHEN a.hub_id IS NULL THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(a.hub_id)) END;
  NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','accounts.view','scope',scope),jsonb_build_object('capability','journals.view','scope',scope));
 END LOOP;
 IF(SELECT count(*) FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=ANY(ids))<>2 THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_payroll_adjustment_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('work.adjustment.record','work.adjustment.void')) EXECUTE FUNCTION public.payroll_adjustment_privacy();
REVOKE ALL ON FUNCTION public.payroll_adjustment_source(uuid,date,uuid,uuid,uuid),public.payroll_adjustment_void_source(uuid,uuid),public.guard_payroll_adjustment(),public.guard_payroll_adjustment_void(),public.payroll_adjustment_complete(),public.payroll_adjustment_effect_required(),public.payroll_adjustment_reversal_guard(),public.payroll_adjustment_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_adjustment_source(uuid,date,uuid,uuid,uuid),public.payroll_adjustment_void_source(uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 97 $$;

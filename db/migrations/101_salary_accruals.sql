-- Regular salary gross expense/payable only. No cash, statutory deduction,
-- net payroll, sales-tax or employment-law certification is implied.
UPDATE public.capability_catalog SET label='View private recorded gross payroll earnings' WHERE name='payroll-accruals.view';
UPDATE public.capability_catalog SET label='Request reviewed gross payroll accruals and corrections' WHERE name='payroll-accruals.edit';
CREATE TABLE public.payroll_salary_accruals(
 academy_id uuid NOT NULL,id uuid NOT NULL,engagement_id uuid NOT NULL,person_id uuid NOT NULL,hub_id uuid,
 service_period_id uuid NOT NULL,service_period_version integer NOT NULL,component_code text NOT NULL CHECK(component_code~'^[A-Z0-9][A-Z0-9._-]{0,63}$'),
 reference text NOT NULL CHECK(reference~'^[A-Z0-9][A-Z0-9._-]{0,63}$'),from_on date NOT NULL,through_on date NOT NULL,due_on date NOT NULL,posted_on date NOT NULL,
 currency_id uuid NOT NULL,currency_version integer NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),amount_minor numeric NOT NULL CHECK(amount_minor>0 AND amount_minor=trunc(amount_minor) AND amount_minor<1e38),
 expense_account uuid NOT NULL,expense_version integer NOT NULL,liability_account uuid NOT NULL,liability_version integer NOT NULL,period_id uuid NOT NULL,period_version integer NOT NULL,
 input jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=2097152),approval_id uuid NOT NULL,created_by uuid NOT NULL,void_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,engagement_id,reference),
 CHECK(from_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' AND through_on BETWEEN from_on AND DATE '9999-12-31' AND through_on-from_on<=365 AND posted_on BETWEEN through_on AND DATE '9999-12-31' AND due_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
 FOREIGN KEY(academy_id,engagement_id) REFERENCES public.work_engagements(academy_id,id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,service_period_id,service_period_version) REFERENCES public.work_pay_period_revisions(academy_id,period_id,version),FOREIGN KEY(academy_id,currency_id,currency_version) REFERENCES public.finance_currency_revisions(academy_id,currency_id,version),
 FOREIGN KEY(academy_id,expense_account,expense_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,liability_account,liability_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,period_id,period_version) REFERENCES public.finance_period_revisions(academy_id,period_id,version),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED,
 EXCLUDE USING gist(academy_id WITH =,engagement_id WITH =,component_code WITH =,daterange(from_on,through_on,'[]') WITH &&) WHERE(void_id IS NULL)
);
CREATE UNIQUE INDEX salary_active_service_component ON public.payroll_salary_accruals(academy_id,service_period_id,component_code) WHERE void_id IS NULL;
CREATE INDEX salary_worker_due ON public.payroll_salary_accruals(academy_id,person_id,due_on,id);
CREATE TABLE public.payroll_salary_voids(
 academy_id uuid NOT NULL,id uuid NOT NULL,accrual_id uuid NOT NULL,input jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=2097152),approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,accrual_id),UNIQUE(academy_id,id,accrual_id),FOREIGN KEY(academy_id,accrual_id) REFERENCES public.payroll_salary_accruals(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.payroll_salary_accruals ADD CONSTRAINT salary_void_identity FOREIGN KEY(academy_id,void_id,id) REFERENCES public.payroll_salary_voids(academy_id,id,accrual_id) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payroll_salary_accruals','payroll_salary_voids'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER salary_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,engagement_id,person_id,hub_id,service_period_id,service_period_version,component_code,reference,from_on,through_on,due_on,posted_on,currency_id,currency_version,unit_scale,amount_minor,expense_account,expense_version,liability_account,liability_version,period_id,period_version,input,source_snapshot,approval_id,created_by) ON public.payroll_salary_accruals TO kavosh_runtime;
GRANT UPDATE(void_id) ON public.payroll_salary_accruals TO kavosh_runtime;
GRANT INSERT(academy_id,id,accrual_id,input,source_snapshot,approval_id,created_by) ON public.payroll_salary_voids TO kavosh_runtime;

CREATE FUNCTION public.salary_service_plan(s jsonb,code text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE d date;f date:=(s->>'from')::date;last date:=(s->>'through')::date;t jsonb;r jsonb;party jsonb;first_party jsonb;first_on date;ref_from date;ref_end date;denominator integer;offset_days integer;rate numeric;minor numeric;days jsonb:='[]'::jsonb;scale integer:=0;currency_version integer;gross numeric;fingerprint jsonb;BEGIN
 IF f IS NULL OR last IS NULL OR last<f OR last-f>365 THEN RETURN jsonb_build_object('unavailable','SALARY_SERVICE_RANGE_INVALID');END IF;
 FOR d IN SELECT f+v FROM generate_series(0,last-f) v LOOP
  SELECT value INTO t FROM jsonb_array_elements(s->'terms') WHERE(value->>'effective_on')::date<=d ORDER BY(value->>'effective_on')::date DESC,(value->>'version')::integer DESC LIMIT 1;
  IF t IS NULL OR t->'active'<>'true'::jsonb OR d<(t->>'starts_on')::date OR(t->>'ends_on' IS NOT NULL AND d>(t->>'ends_on')::date) THEN CONTINUE;END IF;
  SELECT value INTO r FROM jsonb_array_elements(t->'components') WHERE value->>'code'=code AND value->>'kind'='salary' AND d>=(value->>'from')::date AND(value->>'through' IS NULL OR d<=(value->>'through')::date);
  IF r IS NULL THEN CONTINUE;END IF;
  IF r->>'earningBasis' IS NULL THEN RETURN jsonb_build_object('unavailable','SALARY_EARNING_POLICY_REQUIRED');END IF;
  party=t->'party';IF party->>'classification' NOT IN('employee','contractor') OR party IS NULL THEN RETURN jsonb_build_object('unavailable','EFFECTIVE_COMPENSATED_WORK_REQUIRED');END IF;
  IF first_party IS NULL THEN first_party=party||jsonb_build_object('currencyId',t->'currency_id');first_on=d;
  ELSIF first_party IS DISTINCT FROM(party||jsonb_build_object('currencyId',t->'currency_id')) THEN RETURN jsonb_build_object('unavailable','SEPARATE_LEGAL_PAYROLL_REVIEW_REQUIRED');END IF;
  IF(t->>'unit_scale')::integer>=scale THEN scale=(t->>'unit_scale')::integer;currency_version=(t->>'currency_version')::integer;END IF;
  rate=trunc((r->>'amount')::numeric*power(10::numeric,(t->>'unit_scale')::integer));
  IF r->>'earningBasis'='whole_service_period' THEN ref_from=f;ref_end=last;
  ELSIF r->>'frequency'='year' THEN ref_from=date_trunc('year',d::timestamp)::date;ref_end=(ref_from+interval '1 year')::date-1;
  ELSE ref_from=date_trunc('month',d::timestamp)::date;ref_end=(ref_from+interval '1 month')::date-1;END IF;
  denominator=ref_end-ref_from+1;offset_days=d-ref_from;
  minor=round(rate*(offset_days+1)/denominator)-round(rate*offset_days/denominator);
  fingerprint=jsonb_build_array(r->>'earningBasis',r->>'frequency',rate::text,t->'unit_scale');
  days=days||jsonb_build_array(jsonb_build_object('on',d::text,'termsVersion',t->'version','referenceFrom',ref_from::text,'referenceThrough',ref_end::text,'referenceDays',denominator,'policy',r->'earningBasis','fingerprint',fingerprint,'unitScale',t->'unit_scale','minor',minor::text));
 END LOOP;
 IF first_on IS NULL THEN RETURN jsonb_build_object('unavailable','NO_APPLICABLE_SALARY_SOURCE');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(days) x WHERE x->>'policy' IN('whole_reference_period','whole_service_period') GROUP BY x->'referenceFrom',x->'referenceThrough',x->'referenceDays',x->'fingerprint' HAVING count(*)<>(min(x->>'referenceDays'))::integer) THEN RETURN jsonb_build_object('unavailable','SALARY_FULL_REFERENCE_OR_SERVICE_PERIOD_REQUIRED');END IF;
 SELECT sum((x->>'minor')::numeric*power(10::numeric,scale-(x->>'unitScale')::integer)) INTO gross FROM jsonb_array_elements(days) x;
 RETURN jsonb_build_object('engine','salary-service-native-v1','firstOn',first_on::text,'currencyId',first_party->'currencyId','currencyVersion',currency_version,'unitScale',scale,'party',first_party,'grossMinor',trunc(gross)::text,'days',days);
END $$;

CREATE FUNCTION public.salary_input_valid(i jsonb,reversing boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE keys text[];k text;r jsonb;posted date;BEGIN
 keys=CASE WHEN reversing THEN ARRAY['accrualId','period','postedOn','reason'] ELSE ARRAY['servicePeriod','componentCode','reference','postedOn','period','expenseAccount','liabilityAccount','earningReview','taxReview','reason'] END;
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& keys) OR i-keys<>'{}'::jsonb OR octet_length(i::text)>65536 THEN RETURN false;END IF;
 FOREACH k IN ARRAY CASE WHEN reversing THEN ARRAY['reason'] ELSE ARRAY['earningReview','taxReview','reason'] END LOOP
  IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR length(btrim(i->>k)) NOT BETWEEN 1 AND 2000 THEN RETURN false;END IF;
 END LOOP;
 FOREACH k IN ARRAY CASE WHEN reversing THEN ARRAY['period'] ELSE ARRAY['servicePeriod','period','expenseAccount','liabilityAccount'] END LOOP
  r=i->k;IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT(r ?& ARRAY['id','version']) OR r-ARRAY['id','version']<>'{}'::jsonb OR jsonb_typeof(r->'id') IS DISTINCT FROM 'string' OR(r->>'id')::uuid::text IS DISTINCT FROM r->>'id' OR jsonb_typeof(r->'version') IS DISTINCT FROM 'number' OR(r->>'version')::numeric NOT BETWEEN 1 AND 2147483647 OR(r->>'version')::numeric<>trunc((r->>'version')::numeric) THEN RETURN false;END IF;
 END LOOP;
 IF jsonb_typeof(i->'postedOn') IS DISTINCT FROM 'string' OR i->>'postedOn'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;posted=(i->>'postedOn')::date;IF posted NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RETURN false;END IF;
 IF reversing THEN RETURN jsonb_typeof(i->'accrualId')='string' AND(i->>'accrualId')::uuid::text=i->>'accrualId';END IF;
 RETURN jsonb_typeof(i->'componentCode')='string' AND i->>'componentCode'~'^[A-Z0-9][A-Z0-9._-]{0,63}$' AND jsonb_typeof(i->'reference')='string' AND i->>'reference'~'^[A-Z0-9][A-Z0-9._-]{0,63}$';
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;

CREATE FUNCTION public.salary_accrual_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;s jsonb;w jsonb;e jsonb;l jsonb;a jsonb;plan jsonb;target jsonb;BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.void_id IS NOT NULL OR NEW.void_id IS NULL OR to_jsonb(NEW)-'void_id' IS DISTINCT FROM to_jsonb(OLD)-'void_id' THEN RAISE EXCEPTION 'SALARY_ACCRUAL_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF NOT public.salary_input_valid(NEW.input,false) THEN RAISE EXCEPTION 'SALARY_INPUT_INVALID' USING ERRCODE='23514';END IF;
 s=public.salary_accrual_source(NEW.input,NEW.id);w=s->'work';a=s#>'{accounting,period}';plan=s->'plan';
 SELECT value INTO e FROM jsonb_array_elements(s#>'{accounting,accounts}') WHERE value->>'id'=NEW.expense_account::text;SELECT value INTO l FROM jsonb_array_elements(s#>'{accounting,accounts}') WHERE value->>'id'=NEW.liability_account::text;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 target=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',NEW.person_id,'hubId',NEW.hub_id)),'workContext',jsonb_build_object('personId',NEW.person_id,'hubId',NEW.hub_id));
 IF s IS NULL OR s ? 'unavailable' OR s ? 'oversized' OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.salary.record' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.privacy_capability IS DISTINCT FROM 'payroll-accruals.view' OR p.scope IS DISTINCT FROM target OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR NOT public.report_comment_human_verified(NEW.created_by)
 OR(w->>'id')::uuid IS DISTINCT FROM NEW.engagement_id OR(w->>'personId')::uuid IS DISTINCT FROM NEW.person_id OR(w->>'hubId')::uuid IS DISTINCT FROM NEW.hub_id OR(NEW.input#>>'{servicePeriod,id}')::uuid IS DISTINCT FROM NEW.service_period_id OR(NEW.input#>>'{servicePeriod,version}')::integer IS DISTINCT FROM NEW.service_period_version OR NEW.input->>'componentCode' IS DISTINCT FROM NEW.component_code OR NEW.input->>'reference' IS DISTINCT FROM NEW.reference
 OR(s#>>'{payroll,from}')::date IS DISTINCT FROM NEW.from_on OR(s#>>'{payroll,through}')::date IS DISTINCT FROM NEW.through_on OR(s#>>'{payroll,periods,0,definition,payOn}')::date IS DISTINCT FROM NEW.due_on OR(NEW.input->>'postedOn')::date IS DISTINCT FROM NEW.posted_on
 OR(plan->>'currencyId')::uuid IS DISTINCT FROM NEW.currency_id OR(plan->>'currencyVersion')::integer IS DISTINCT FROM NEW.currency_version OR(plan->>'unitScale')::integer IS DISTINCT FROM NEW.unit_scale OR(plan->>'grossMinor')::numeric IS DISTINCT FROM NEW.amount_minor
 OR(NEW.input#>>'{expenseAccount,id}')::uuid IS DISTINCT FROM NEW.expense_account OR(NEW.input#>>'{expenseAccount,version}')::integer IS DISTINCT FROM NEW.expense_version OR(NEW.input#>>'{liabilityAccount,id}')::uuid IS DISTINCT FROM NEW.liability_account OR(NEW.input#>>'{liabilityAccount,version}')::integer IS DISTINCT FROM NEW.liability_version OR(NEW.input#>>'{period,id}')::uuid IS DISTINCT FROM NEW.period_id OR(NEW.input#>>'{period,version}')::integer IS DISTINCT FROM NEW.period_version THEN RAISE EXCEPTION 'SALARY_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF s->>'releaseFloorOn' IS NOT NULL AND NEW.posted_on<(s->>'releaseFloorOn')::date THEN RAISE EXCEPTION 'SALARY_CORRECTION_DATE_REQUIRED' USING ERRCODE='23514';END IF;
 IF e IS NULL OR l IS NULL OR e->>'kind'<>'expense' OR e->>'role'<>'expense' OR l->>'kind'<>'liability' OR l->>'role'<>'payable' OR e->'active'<>'true'::jsonb OR l->'active'<>'true'::jsonb OR(e->>'version')::integer<>NEW.expense_version OR(l->>'version')::integer<>NEW.liability_version OR e->>'currencyId'<>NEW.currency_id::text OR l->>'currencyId'<>NEW.currency_id::text OR(e->>'unitScale')::integer<>NEW.unit_scale OR(l->>'unitScale')::integer<>NEW.unit_scale OR(e->>'hubId' IS NOT NULL AND(e->>'hubId')::uuid IS DISTINCT FROM NEW.hub_id) OR(l->>'hubId' IS NOT NULL AND(l->>'hubId')::uuid IS DISTINCT FROM NEW.hub_id)
 OR(a->>'version')::integer<>NEW.period_version OR a->>'state'<>'open' OR NEW.posted_on NOT BETWEEN(a->>'startsOn')::date AND(a->>'endsOn')::date OR(a->>'closedThrough' IS NOT NULL AND NEW.posted_on<=(a->>'closedThrough')::date) THEN RAISE EXCEPTION 'SALARY_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.created_by=NEW.person_id AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER salary_accrual_guard BEFORE INSERT OR UPDATE ON public.payroll_salary_accruals FOR EACH ROW EXECUTE FUNCTION public.salary_accrual_guard();

CREATE FUNCTION public.salary_void_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;s jsonb;w jsonb;target jsonb;BEGIN
 IF NOT public.salary_input_valid(NEW.input,true) OR(NEW.input->>'accrualId')::uuid IS DISTINCT FROM NEW.accrual_id THEN RAISE EXCEPTION 'SALARY_INPUT_INVALID' USING ERRCODE='23514';END IF;
 s=public.salary_void_source(NEW.accrual_id,(NEW.input#>>'{period,id}')::uuid);w=s#>'{current,work}';SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 target=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',w->>'personId','hubId',w->'hubId')),'workContext',jsonb_build_object('personId',w->>'personId','hubId',w->'hubId'));
 IF s IS NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.salary.void' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.privacy_capability IS DISTINCT FROM 'payroll-accruals.view' OR p.scope IS DISTINCT FROM target OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR s#>>'{before,voidId}' IS NOT NULL OR NOT public.report_comment_human_verified(NEW.created_by) OR(NEW.input#>>'{period,version}')::integer IS DISTINCT FROM(s#>>'{current,period,version}')::integer OR(NEW.input->>'postedOn')::date<(s#>>'{before,postedOn}')::date THEN RAISE EXCEPTION 'SALARY_VOID_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.created_by=(s#>>'{before,personId}')::uuid AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER salary_void_guard BEFORE INSERT ON public.payroll_salary_voids FOR EACH ROW EXECUTE FUNCTION public.salary_void_guard();

CREATE FUNCTION public.salary_posting_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE j record;b record;s jsonb;BEGIN
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF j.id IS NULL OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.posted_by IS DISTINCT FROM NEW.created_by OR j.period_id IS DISTINCT FROM(NEW.input#>>'{period,id}')::uuid OR j.period_version IS DISTINCT FROM(NEW.input#>>'{period,version}')::integer OR j.posted_on IS DISTINCT FROM(NEW.input->>'postedOn')::date OR j.purpose IS DISTINCT FROM 'activity' OR j.line_count<>2 THEN RAISE EXCEPTION 'SALARY_POSTING_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='payroll_salary_accruals' THEN
  IF j.reverses_id IS NOT NULL OR j.description IS DISTINCT FROM 'Recorded salary gross accrual' OR j.reference IS DISTINCT FROM 'PAYROLL-SALARY' OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=1 AND account_id=NEW.expense_account AND account_version=NEW.expense_version AND side='debit' AND amount_minor=NEW.amount_minor AND note='') OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=2 AND account_id=NEW.liability_account AND account_version=NEW.liability_version AND side='credit' AND amount_minor=NEW.amount_minor AND note='') THEN RAISE EXCEPTION 'SALARY_POSTING_REQUIRED' USING ERRCODE='23514';END IF;
  s=public.salary_accrual_source(NEW.input,NEW.id);IF s IS DISTINCT FROM NEW.source_snapshot THEN RAISE EXCEPTION 'SALARY_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO b FROM public.payroll_salary_accruals WHERE academy_id=NEW.academy_id AND id=NEW.accrual_id;
  IF b.void_id IS DISTINCT FROM NEW.id OR j.reverses_id IS DISTINCT FROM b.id OR j.description IS DISTINCT FROM 'Correction of salary gross accrual' OR j.reference IS DISTINCT FROM 'PAYROLL-SALARY-CORRECTION' OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=1 AND account_id=b.expense_account AND account_version=b.expense_version AND side='credit' AND amount_minor=b.amount_minor AND note='') OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=2 AND account_id=b.liability_account AND account_version=b.liability_version AND side='debit' AND amount_minor=b.amount_minor AND note='') THEN RAISE EXCEPTION 'SALARY_VOID_POSTING_REQUIRED' USING ERRCODE='23514';END IF;
  s=public.salary_void_source(NEW.accrual_id,j.period_id);IF s->'current' IS DISTINCT FROM NEW.source_snapshot->'current' OR(s->'before')-'voidId' IS DISTINCT FROM(NEW.source_snapshot->'before')-'voidId' THEN RAISE EXCEPTION 'SALARY_VOID_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER salary_posting_complete AFTER INSERT ON public.payroll_salary_accruals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.salary_posting_complete();
CREATE CONSTRAINT TRIGGER salary_void_posting_complete AFTER INSERT ON public.payroll_salary_voids DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.salary_posting_complete();
CREATE CONSTRAINT TRIGGER salary_reviewed AFTER INSERT ON public.payroll_salary_accruals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE CONSTRAINT TRIGGER salary_void_reviewed AFTER INSERT ON public.payroll_salary_voids DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.salary_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND((NEW.action='work.salary.record' AND NOT EXISTS(SELECT 1 FROM public.payroll_salary_accruals WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id)) OR(NEW.action='work.salary.void' AND NOT EXISTS(SELECT 1 FROM public.payroll_salary_voids WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id))) THEN RAISE EXCEPTION 'SALARY_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER salary_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.salary_effect_required();
CREATE FUNCTION public.salary_reversal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.payroll_salary_accruals WHERE academy_id=NEW.academy_id AND id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.payroll_salary_voids v JOIN public.approval_requests p ON p.academy_id=v.academy_id AND p.id=v.approval_id WHERE v.academy_id=NEW.academy_id AND v.id=NEW.id AND v.accrual_id=NEW.reverses_id AND p.action='work.salary.void' AND p.target_id=NEW.id AND p.payload=v.input AND NEW.approval_id=p.id) THEN RAISE EXCEPTION 'SALARY_CORRECTION_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER salary_reversal_guard BEFORE INSERT ON public.finance_journals FOR EACH ROW WHEN(NEW.reverses_id IS NOT NULL) EXECUTE FUNCTION public.salary_reversal_guard();

CREATE FUNCTION public.salary_approval_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE w record;b record;a record;s jsonb;ids uuid[];BEGIN
 IF NEW.action='work.salary.record' THEN SELECT e.* INTO w FROM public.work_pay_periods p JOIN public.work_engagements e ON e.academy_id=p.academy_id AND e.id=p.engagement_id WHERE p.academy_id=NEW.academy_id AND p.id=(NEW.payload#>>'{servicePeriod,id}')::uuid;ids=ARRAY[(NEW.payload#>>'{expenseAccount,id}')::uuid,(NEW.payload#>>'{liabilityAccount,id}')::uuid];
 ELSE SELECT * INTO b FROM public.payroll_salary_accruals WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'accrualId')::uuid;SELECT * INTO w FROM public.work_engagements WHERE academy_id=NEW.academy_id AND id=b.engagement_id;ids=ARRAY[b.expense_account,b.liability_account];END IF;
 IF w.id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',w.person_id,'hubId',w.hub_id)),'workContext',jsonb_build_object('personId',w.person_id,'hubId',w.hub_id));
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','work-pay.view','scope',s),jsonb_build_object('capability','pay-periods.view','scope',s));
 FOR a IN SELECT id,hub_id FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=ANY(ids) LOOP
  s=CASE WHEN a.hub_id IS NULL THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(a.hub_id)) END;
  NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','accounts.view','scope',s),jsonb_build_object('capability','journals.view','scope',s));
 END LOOP;
 IF(SELECT count(*) FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=ANY(ids))<>2 THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_salary_approval_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('work.salary.record','work.salary.void')) EXECUTE FUNCTION public.salary_approval_privacy();

CREATE FUNCTION public.salary_accrual_source(i jsonb,p_exclude uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;h record;v record;w record;b jsonb;s jsonb;terms jsonb;payroll jsonb;plan jsonb;accounting jsonb;floor_on date;BEGIN
 SELECT * INTO h FROM public.work_pay_periods WHERE academy_id=tenant AND id=(i#>>'{servicePeriod,id}')::uuid;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM public.lock_pay_period_work(h.engagement_id);SELECT * INTO h FROM public.work_pay_periods WHERE academy_id=tenant AND id=h.id;
 SELECT * INTO v FROM public.work_pay_period_revisions WHERE academy_id=tenant AND period_id=h.id AND version=h.version;SELECT * INTO w FROM public.work_engagements WHERE academy_id=tenant AND id=h.engagement_id;
 IF h.version<>(i#>>'{servicePeriod,version}')::integer OR v.work_version<>w.version OR v.definition->'active'<>'true'::jsonb THEN RETURN jsonb_build_object('unavailable','SALARY_SERVICE_PERIOD_REVIEW_REQUIRED');END IF;
 b=public.pay_period_basis(h.id,h.engagement_id,h.version,v.definition);IF b->'oversized'<>'false'::jsonb THEN RETURN jsonb_build_object('oversized',true);END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('engagement_id',w.id,'person_id',w.person_id,'version',x->'version','effective_on',x->'effectiveOn','currency_id',x->'currencyId','currency_version',x->'currencyVersion','currency_code',c.code,'unit_scale',x->'unitScale','active',x#>'{definition,active}','starts_on',x#>'{definition,startsOn}','ends_on',x#>'{definition,endsOn}','time_zone',x#>'{definition,timeZone}','components',x->'components','party',jsonb_build_object('employerId',x->'employerId','payeeId',x->'payeeId','classification',x#>'{definition,classification}')) ORDER BY(x->>'effectiveOn')::date,(x->>'version')::integer),'[]'::jsonb) INTO terms FROM jsonb_array_elements(b#>'{work,terms}') x JOIN public.finance_currencies c ON c.academy_id=tenant AND c.id=(x->>'currencyId')::uuid;
 payroll=jsonb_build_object('from',v.definition->'from','through',v.definition->'through','work',jsonb_build_array(jsonb_build_object('id',w.id,'person_id',w.person_id,'hub_id',w.hub_id,'version',w.version)),'terms',terms,'periods',jsonb_build_array(jsonb_build_object('id',h.id,'engagement_id',w.id,'version',h.version,'work_version',v.work_version,'definition',v.definition)));
 plan=public.salary_service_plan(payroll,i->>'componentCode');IF plan ? 'unavailable' THEN RETURN plan;END IF;
 accounting=public.payroll_adjustment_source(w.id,(plan->>'firstOn')::date,(i#>>'{expenseAccount,id}')::uuid,(i#>>'{liabilityAccount,id}')::uuid,(i#>>'{period,id}')::uuid);IF accounting IS NULL THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM public.payroll_salary_accruals a WHERE a.academy_id=tenant AND a.engagement_id=w.id AND a.component_code=i->>'componentCode' AND a.void_id IS NULL AND(p_exclude IS NULL OR a.id<>p_exclude) AND(a.service_period_id=h.id OR daterange(a.from_on,a.through_on,'[]')&&daterange((v.definition->>'from')::date,(v.definition->>'through')::date,'[]'))) THEN RETURN jsonb_build_object('unavailable','SALARY_SOURCE_ALREADY_ACCRUED');END IF;
 SELECT max(j.posted_on) INTO floor_on FROM public.payroll_salary_accruals a JOIN public.finance_journals j ON j.academy_id=a.academy_id AND j.id=a.void_id WHERE a.academy_id=tenant AND a.engagement_id=w.id AND a.component_code=i->>'componentCode' AND a.void_id IS NOT NULL AND(p_exclude IS NULL OR a.id<>p_exclude) AND(a.service_period_id=h.id OR daterange(a.from_on,a.through_on,'[]')&&daterange((v.definition->>'from')::date,(v.definition->>'through')::date,'[]'));
 s=jsonb_build_object('payroll',payroll,'work',accounting->'work','accounting',accounting-'work','plan',plan,'releaseFloorOn',floor_on::text);IF octet_length(s::text)>2097152 THEN RETURN jsonb_build_object('oversized',true);END IF;RETURN s;
END $$;

CREATE FUNCTION public.salary_void_source(p_accrual uuid,p_period uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$ DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;b record;s jsonb;BEGIN
 SELECT * INTO b FROM public.payroll_salary_accruals WHERE academy_id=tenant AND id=p_accrual;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM public.lock_pay_period_work(b.engagement_id);SELECT * INTO b FROM public.payroll_salary_accruals WHERE academy_id=tenant AND id=p_accrual FOR UPDATE;
 s=public.payroll_adjustment_source(b.engagement_id,(b.source_snapshot#>>'{plan,firstOn}')::date,b.expense_account,b.liability_account,p_period);IF s IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('before',jsonb_build_object('id',b.id,'engagementId',b.engagement_id,'personId',b.person_id,'hubId',b.hub_id,'voidId',b.void_id,'postedOn',b.posted_on::text,'amountMinor',b.amount_minor::text,'unitScale',b.unit_scale,'expenseAccount',b.expense_account,'expenseVersion',b.expense_version,'liabilityAccount',b.liability_account,'liabilityVersion',b.liability_version),'current',s);
END $$;
REVOKE ALL ON FUNCTION public.salary_service_plan(jsonb,text),public.salary_accrual_source(jsonb,uuid),public.salary_void_source(uuid,uuid),public.salary_input_valid(jsonb,boolean),public.salary_accrual_guard(),public.salary_void_guard(),public.salary_posting_complete(),public.salary_effect_required(),public.salary_reversal_guard(),public.salary_approval_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.salary_service_plan(jsonb,text),public.salary_accrual_source(jsonb,uuid),public.salary_void_source(uuid,uuid),public.salary_input_valid(jsonb,boolean) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 101 $$;

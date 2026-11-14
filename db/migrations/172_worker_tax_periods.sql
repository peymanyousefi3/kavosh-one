-- Statutory worker/employer periods are shared across jobs/classes. Existing
-- work_pay_periods remain engagement-specific service/accrual records.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('tax-periods.view','View shared employee payroll calendars','Finance',true,ARRAY['person']),
 ('tax-periods.edit','Propose shared employee payroll calendar changes','Finance',true,ARRAY['person']);
CREATE TABLE public.payroll_tax_periods(
 academy_id uuid NOT NULL,id uuid NOT NULL,profile_id uuid NOT NULL,code text NOT NULL CHECK(code~'^[A-Z0-9][A-Z0-9._-]{0,63}$'),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,profile_id,code),FOREIGN KEY(academy_id,profile_id) REFERENCES public.payroll_tax_profiles(academy_id,id)
);
CREATE TABLE public.payroll_tax_period_revisions(
 academy_id uuid NOT NULL,period_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),tax_profile_version integer NOT NULL CHECK(tax_profile_version>0),definition jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=1048576),changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,period_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,period_id) REFERENCES public.payroll_tax_periods(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.payroll_tax_periods ADD CONSTRAINT tax_period_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.payroll_tax_period_revisions(academy_id,period_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX tax_period_regular_source ON public.payroll_tax_period_revisions(academy_id,(definition->>'regularRunId'),period_id,version) WHERE definition->'active'='true'::jsonb AND definition->>'regularRunId' IS NOT NULL;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payroll_tax_periods','payroll_tax_period_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);EXECUTE format('CREATE TRIGGER tax_period_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,profile_id,code),UPDATE(version) ON public.payroll_tax_periods TO kavosh_runtime;
GRANT INSERT(academy_id,period_id,version,tax_profile_version,definition,source_snapshot,changed_by,approval_id,reason) ON public.payroll_tax_period_revisions TO kavosh_runtime;
CREATE FUNCTION public.tax_period_header_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE person uuid;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TAX_PERIOD_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT person_id INTO person FROM public.payroll_tax_profiles WHERE academy_id=NEW.academy_id AND id=NEW.profile_id;PERFORM public.lock_hourly_worker(person);
 IF(TG_OP='INSERT' AND NEW.version<>1) OR(TG_OP='UPDATE' AND(NEW.version<>OLD.version+1 OR(to_jsonb(NEW)-'version') IS DISTINCT FROM(to_jsonb(OLD)-'version'))) THEN RAISE EXCEPTION 'TAX_PERIOD_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER tax_period_header BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_tax_periods FOR EACH ROW EXECUTE FUNCTION public.tax_period_header_guard();
CREATE FUNCTION public.tax_period_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE k text;a timestamptz;b timestamptz;pay date;keys text[]:=ARRAY['startsAt','endsAt','timeZone','payOn','payPeriodsPerYear','active','review'];BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& keys) OR d-(keys||ARRAY['regularRunId'])<>'{}'::jsonb OR octet_length(d::text)>16384 OR jsonb_typeof(d->'active') IS DISTINCT FROM 'boolean' OR jsonb_typeof(d->'payPeriodsPerYear') IS DISTINCT FROM 'number' OR d->>'payPeriodsPerYear'!~'^[1-9][0-9]{0,3}$' OR(d->>'payPeriodsPerYear')::integer>2000 OR jsonb_typeof(d->'timeZone') IS DISTINCT FROM 'string' OR length(d->>'timeZone') NOT BETWEEN 1 AND 100 OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=d->>'timeZone') OR jsonb_typeof(d->'review') IS DISTINCT FROM 'string' OR length(btrim(d->>'review')) NOT BETWEEN 1 AND 2000 OR d->>'review'~'[[:cntrl:]]' THEN RETURN false;END IF;
 IF d?'regularRunId' AND d->'regularRunId'<>'null'::jsonb AND(jsonb_typeof(d->'regularRunId') IS DISTINCT FROM 'string' OR d->>'regularRunId'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['startsAt','endsAt'] LOOP
  IF jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR length(d->>k)>40 OR d->>k!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN false;END IF;
 END LOOP;
 IF jsonb_typeof(d->'payOn') IS DISTINCT FROM 'string' OR d->>'payOn'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;
 a=(d->>'startsAt')::timestamptz;b=(d->>'endsAt')::timestamptz;pay=(d->>'payOn')::date;
 RETURN a>=TIMESTAMPTZ '1900-01-01T00:00:00Z' AND b<=TIMESTAMPTZ '9999-12-31T23:59:59.999999Z' AND b>a AND b-a<=interval '367days' AND pay BETWEEN DATE '1900-01-01' AND DATE '9999-12-31';
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.tax_period_basis(p_period uuid,i jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE header_row public.payroll_tax_periods%ROWTYPE;p record;edition jsonb;prior jsonb;others jsonb;b jsonb;d jsonb:=i->'definition';pv integer:=coalesce((i->>'expectedVersion')::integer,0);n integer;run_row public.payrun_groups%ROWTYPE;run_source jsonb;regular jsonb;old_state jsonb;BEGIN
 IF public.tax_period_definition_valid(d) IS NOT TRUE THEN RETURN jsonb_build_object('unavailable','TAX_PERIOD_DEFINITION_INVALID');END IF;
 IF i?'profileId' THEN SELECT * INTO p FROM public.payroll_tax_profiles WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=(i->>'profileId')::uuid;
 ELSE SELECT * INTO header_row FROM public.payroll_tax_periods WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_period;IF NOT FOUND THEN RETURN NULL;END IF;SELECT * INTO p FROM public.payroll_tax_profiles WHERE academy_id=header_row.academy_id AND id=header_row.profile_id;END IF;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM public.lock_hourly_worker(p.person_id);
 SELECT jsonb_build_object('id',p.id,'personId',p.person_id,'employerId',p.employer_id,'taxYear',p.tax_year,'personActive',person.status='active','employerActive',party.active) INTO b FROM public.people person JOIN public.financial_payees company ON company.academy_id=person.academy_id AND company.id=p.employer_id AND company.kind='academy' JOIN public.financial_payee_revisions party ON party.academy_id=company.academy_id AND party.payee_id=company.id AND party.version=company.version WHERE person.academy_id=p.academy_id AND person.id=p.person_id;
 SELECT jsonb_build_object('version',version,'effectiveOn',effective_on::text,'active',(definition->>'active')::boolean) INTO edition FROM public.payroll_tax_profile_revisions WHERE academy_id=p.academy_id AND profile_id=p.id AND effective_on<=(d->>'payOn')::date ORDER BY effective_on DESC,version DESC LIMIT 1;
 SELECT jsonb_build_object('version',version,'taxProfileVersion',tax_profile_version,'definition',definition) INTO prior FROM public.payroll_tax_period_revisions WHERE academy_id=p.academy_id AND period_id=p_period AND version=pv;
 IF prior#>>'{definition,regularRunId}' IS NOT NULL AND prior#>'{definition,active}'='true'::jsonb THEN
  SELECT jsonb_build_object('version',coalesce(h.version,0),'state',r.state,'activePosting',EXISTS(SELECT 1 FROM public.payrun_net_postings x WHERE x.academy_id=p.academy_id AND x.run_id=(prior#>>'{definition,regularRunId}')::uuid AND x.reversal_id IS NULL)) INTO old_state FROM(VALUES(1))q(n) LEFT JOIN public.payrun_net_statements h ON h.academy_id=p.academy_id AND h.run_id=(prior#>>'{definition,regularRunId}')::uuid LEFT JOIN public.payrun_net_revisions r ON r.academy_id=h.academy_id AND r.run_id=h.run_id AND r.version=h.version;
 END IF;
 IF d->>'regularRunId' IS NOT NULL THEN
  SELECT * INTO run_row FROM public.payrun_groups WHERE academy_id=p.academy_id AND id=(d->>'regularRunId')::uuid;
  IF run_row.id IS NULL OR run_row.person_id<>p.person_id OR jsonb_array_length(run_row.source_snapshot->'contexts')<>1 OR run_row.source_snapshot#>>'{contexts,0,employerId}' IS DISTINCT FROM p.employer_id::text OR run_row.source_snapshot#>>'{contexts,0,countryCode}' IS DISTINCT FROM 'CA' OR run_row.source_snapshot#>>'{contexts,0,classification}' IS DISTINCT FROM 'employee' THEN RETURN jsonb_build_object('unavailable','TAX_PERIOD_EMPLOYEE_RUN_REQUIRED');END IF;
  run_source=public.payrun_net_source(run_row.id);regular=jsonb_build_object('runId',run_row.id,'scope',run_row.scope,'source',run_source);
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'version',s.version,'definition',s.definition-ARRAY['review','regularRunId']) ORDER BY s.id),'[]'::jsonb) INTO others FROM(SELECT h.id,h.version,r.definition FROM public.payroll_tax_periods h JOIN public.payroll_tax_period_revisions r ON r.academy_id=h.academy_id AND r.period_id=h.id AND r.version=h.version WHERE h.academy_id=p.academy_id AND h.profile_id=p.id AND h.id<>p_period AND r.definition->'active'='true'::jsonb ORDER BY h.id LIMIT 2001)s;
 b=jsonb_build_object('profile',b,'taxEdition',edition,'before',prior,'otherPeriods',others,'regularRun',regular,'priorRunState',old_state,'unavailable',NULL);n=jsonb_array_length(others);
 IF n>2000 OR octet_length(others::text)>786432 THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_REQUIRES_BACKGROUND_JOB');END IF;
 IF extract(year FROM(d->>'payOn')::date)::integer<>p.tax_year THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_PAY_YEAR_MISMATCH');END IF;
 IF edition IS NULL OR edition->'version' IS DISTINCT FROM i->'taxProfileVersion' THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_TAX_EDITION_CHANGED');END IF;
 IF old_state->>'state'='prepared' OR old_state->'activePosting'='true'::jsonb THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_UNWIND_FINANCIALS_BEFORE_CHANGE');END IF;
 IF d->'active'='true'::jsonb THEN
  IF b#>'{profile,personActive}' IS DISTINCT FROM 'true'::jsonb OR b#>'{profile,employerActive}' IS DISTINCT FROM 'true'::jsonb OR edition->'active' IS DISTINCT FROM 'true'::jsonb THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_ACTIVE_PARTIES_REQUIRED');END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(others)o WHERE o#>'{definition,payPeriodsPerYear}' IS DISTINCT FROM d->'payPeriodsPerYear') THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_ANNUAL_FREQUENCY_CONFLICT');END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(others)o WHERE o#>'{definition,timeZone}' IS DISTINCT FROM d->'timeZone') THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_TIME_ZONE_CONFLICT');END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(others)o WHERE tstzrange((o#>>'{definition,startsAt}')::timestamptz,(o#>>'{definition,endsAt}')::timestamptz,'[)')&&tstzrange((d->>'startsAt')::timestamptz,(d->>'endsAt')::timestamptz,'[)')) THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_OVERLAP');END IF;
  IF n>=(d->>'payPeriodsPerYear')::integer THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_ANNUAL_COUNT_EXCEEDED');END IF;
  IF regular IS NOT NULL THEN
   IF EXISTS(SELECT 1 FROM public.payroll_tax_periods h JOIN public.payroll_tax_period_revisions r ON r.academy_id=h.academy_id AND r.period_id=h.id AND r.version=h.version WHERE h.academy_id=p.academy_id AND h.id<>p_period AND r.definition->'active'='true'::jsonb AND r.definition->>'regularRunId'=d->>'regularRunId') THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_RUN_ALREADY_RESERVED');END IF;
   IF run_row.unit_scale<>2 OR(SELECT code FROM public.finance_currencies WHERE academy_id=p.academy_id AND id=run_row.currency_id) IS DISTINCT FROM 'CAD' THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_CAD_GROSS_REQUIRED');END IF;
   IF run_source->'recordedSourcesCurrent' IS DISTINCT FROM 'true'::jsonb OR run_source->'cancellationId'<>'null'::jsonb OR EXISTS(SELECT 1 FROM public.payrun_net_postings x JOIN public.payrun_payments pay ON pay.academy_id=x.academy_id AND pay.posting_id=x.id WHERE x.academy_id=p.academy_id AND x.run_id=run_row.id) THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_UNPAID_CURRENT_RUN_REQUIRED');END IF;
   IF((d->>'startsAt')::timestamptz AT TIME ZONE(d->>'timeZone'))::time<>TIME '00:00' OR((d->>'endsAt')::timestamptz AT TIME ZONE(d->>'timeZone'))::time<>TIME '00:00' THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_SUBDAY_SOURCE_MAPPING_REQUIRED');END IF;
   IF run_row.planned_pay_on<>(d->>'payOn')::date OR run_row.service_from<((d->>'startsAt')::timestamptz AT TIME ZONE(d->>'timeZone'))::date OR run_row.service_through>=((d->>'endsAt')::timestamptz AT TIME ZONE(d->>'timeZone'))::date THEN RETURN b||jsonb_build_object('unavailable','TAX_PERIOD_RUN_DATES_MISMATCH');END IF;
  END IF;
 END IF;RETURN b;
END $$;
CREATE FUNCTION public.tax_period_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;b jsonb;i jsonb;s jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'TAX_PERIOD_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.payroll_tax_periods WHERE academy_id=NEW.academy_id AND id=NEW.period_id;
 i=jsonb_build_object('taxProfileVersion',NEW.tax_profile_version,'definition',NEW.definition,'reason',NEW.reason)||CASE WHEN NEW.version=1 THEN jsonb_build_object('profileId',h.profile_id,'code',h.code) ELSE jsonb_build_object('expectedVersion',NEW.version-1) END;b=public.tax_period_basis(NEW.period_id,i);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',b#>>'{profile,personId}','hubId',NULL)),'workContext',jsonb_build_object('personId',b#>>'{profile,personId}','hubId',NULL));
 IF h.id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.payroll_tax_period_revisions WHERE academy_id=NEW.academy_id AND period_id=NEW.period_id) OR b IS NULL OR b->>'unavailable' IS NOT NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'work.tax-period.create' ELSE 'work.tax-period.change' END) OR p.target_id IS DISTINCT FROM NEW.period_id OR p.target_version<>NEW.version-1 OR p.payload IS DISTINCT FROM i OR p.privacy_capability IS DISTINCT FROM 'tax-periods.edit' OR p.scope IS DISTINCT FROM s OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'TAX_PERIOD_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by::text=b#>>'{profile,personId}' AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER tax_period_revision BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_tax_period_revisions FOR EACH ROW EXECUTE FUNCTION public.tax_period_revision_guard();
CREATE CONSTRAINT TRIGGER tax_period_reviewed AFTER INSERT ON public.payroll_tax_period_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.tax_period_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.tax_period_basis(NEW.period_id,(SELECT payload FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id)) IS DISTINCT FROM NEW.source_snapshot OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.period_id AND actor_id=NEW.changed_by AND action=CASE WHEN NEW.version=1 THEN 'work.tax-period.create' ELSE 'work.tax-period.change' END AND created_at=transaction_timestamp() AND changes->'version'=to_jsonb(NEW.version) AND changes->>'approvalId'=NEW.approval_id::text AND changes->'severity'='"critical"'::jsonb AND changes->'privateContentRedacted'='true'::jsonb AND changes->'paymentExecuted'='false'::jsonb) THEN RAISE EXCEPTION 'TAX_PERIOD_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tax_period_complete AFTER INSERT ON public.payroll_tax_period_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tax_period_complete();
CREATE FUNCTION public.tax_period_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action IN('work.tax-period.create','work.tax-period.change') AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.payroll_tax_period_revisions WHERE academy_id=NEW.academy_id AND period_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'TAX_PERIOD_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tax_period_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tax_period_effect_required();
REVOKE ALL ON FUNCTION public.tax_period_header_guard(),public.tax_period_definition_valid(jsonb),public.tax_period_basis(uuid,jsonb),public.tax_period_revision_guard(),public.tax_period_complete(),public.tax_period_effect_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tax_period_definition_valid(jsonb),public.tax_period_basis(uuid,jsonb) TO kavosh_runtime;
-- Review snapshots may contain the new and previous gross source. Calendar
-- rights alone must not reveal the private financial sources in that review.
CREATE FUNCTION public.tax_period_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE run_id uuid;r record;cap text;BEGIN
 FOR run_id IN SELECT DISTINCT value::uuid FROM unnest(ARRAY[NEW.payload#>>'{definition,regularRunId}',NEW.review_context#>>'{before,definition,regularRunId}']) value WHERE value IS NOT NULL LOOP
  SELECT * INTO r FROM public.payrun_groups WHERE academy_id=NEW.academy_id AND id=run_id;
  IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;CONTINUE;END IF;
  NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','payruns.view','scope',r.scope),jsonb_build_object('capability','payrun-net.view','scope',r.scope));
  FOREACH cap IN ARRAY ARRAY['work-pay.view','payroll-accruals.view','payroll-adjustments.view'] LOOP
   IF cap='work-pay.view' OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.source_snapshot->'items') v WHERE(cap='payroll-adjustments.view')=(v->>'kind'='manual_bonus')) THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'payrunNetSource',r.id));END IF;
  END LOOP;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER zz_tax_period_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('work.tax-period.create','work.tax-period.change')) EXECUTE FUNCTION public.tax_period_privacy();
-- Preserve helper identity/ACLs and make both API and native cancellation
-- respect the same worker-locked reservation. Clear it only after unwinding net.
DO $$ DECLARE body text;needle text:='RETURN jsonb_build_object(''runId'',b.id';BEGIN
 SELECT pg_get_functiondef('public.payrun_cancel_source(uuid)'::regprocedure) INTO body;
 IF strpos(body,needle)=0 THEN RAISE EXCEPTION 'PAYRUN_CANCELLATION_PATCH_SOURCE_CHANGED';END IF;
 body=replace(body,needle,'RETURN jsonb_build_object(''taxPeriodReservationActive'',EXISTS(SELECT 1 FROM public.payroll_tax_periods h JOIN public.payroll_tax_period_revisions r ON r.academy_id=h.academy_id AND r.period_id=h.id AND r.version=h.version WHERE h.academy_id=b.academy_id AND r.definition->''active''=''true''::jsonb AND r.definition->>''regularRunId''=b.id::text))||jsonb_build_object(''runId'',b.id');EXECUTE body;
END $$;
CREATE FUNCTION public.tax_period_cancellation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.payrun_cancel_source(NEW.run_id)->'taxPeriodReservationActive'='true'::jsonb THEN RAISE EXCEPTION 'TAX_PERIOD_RESERVATION_RELEASE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER a_tax_period_cancellation BEFORE INSERT ON public.payrun_group_cancellations FOR EACH ROW EXECUTE FUNCTION public.tax_period_cancellation_guard();
REVOKE ALL ON FUNCTION public.tax_period_privacy(),public.tax_period_cancellation_guard() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 172 $$;

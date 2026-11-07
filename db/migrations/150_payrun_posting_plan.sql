-- Resolve original wage liabilities across every supported gross source.
CREATE VIEW public.payroll_gross_liability_catalogue WITH(security_invoker=true) AS
 SELECT academy_id,'manual_bonus'::text kind,id source_id,liability_account,liability_version FROM public.payroll_adjustments
 UNION ALL SELECT academy_id,'hourly',id,liability_account,liability_version FROM public.payroll_hourly_accruals
 UNION ALL SELECT academy_id,'salary',id,liability_account,liability_version FROM public.payroll_salary_accruals
 UNION ALL SELECT academy_id,'project',id,liability_account,liability_version FROM public.payroll_project_accruals
 UNION ALL SELECT academy_id,'tuition_course',id,liability_account,liability_version FROM public.payroll_tuition_course_accruals
 UNION ALL SELECT academy_id,'tuition_session',id,liability_account,liability_version FROM public.payroll_tuition_session_accruals
 UNION ALL SELECT academy_id,'tuition_collection',id,liability_account,liability_version FROM public.payroll_tuition_collection_accruals;
GRANT SELECT ON public.payroll_gross_liability_catalogue TO kavosh_runtime;
CREATE FUNCTION public.payrun_posting_input_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE side text;v jsonb;k text;ref jsonb;keys text[];codes text[];d date;BEGIN
 keys=ARRAY['netVersion','allocationPolicy','deductions','employers','period','postedOn','reason'];
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& keys) OR i-keys<>'{}'::jsonb OR octet_length(i::text)>65536 OR jsonb_typeof(i->'netVersion') IS DISTINCT FROM 'number' OR(i->>'netVersion')::numeric NOT BETWEEN 1 AND 2147483647 OR(i->>'netVersion')::numeric<>trunc((i->>'netVersion')::numeric) OR i->>'allocationPolicy' IS DISTINCT FROM 'gross_weighted_largest_remainder' OR jsonb_typeof(i->'reason') IS DISTINCT FROM 'string' OR length(btrim(i->>'reason')) NOT BETWEEN 1 AND 2000 OR jsonb_typeof(i->'postedOn') IS DISTINCT FROM 'string' OR i->>'postedOn'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;
 d=(i->>'postedOn')::date;IF d NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RETURN false;END IF;
 FOREACH side IN ARRAY ARRAY['period','deductions','employers'] LOOP
  IF side='period' THEN
   ref=i->'period';IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR NOT(ref ?& ARRAY['id','version']) OR ref-ARRAY['id','version']<>'{}'::jsonb OR jsonb_typeof(ref->'id') IS DISTINCT FROM 'string' OR ref->>'id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(ref->'version') IS DISTINCT FROM 'number' OR(ref->>'version')::numeric NOT BETWEEN 1 AND 2147483647 OR(ref->>'version')::numeric<>trunc((ref->>'version')::numeric) THEN RETURN false;END IF;
  ELSE
   IF jsonb_typeof(i->side) IS DISTINCT FROM 'array' OR jsonb_array_length(i->side)>100 THEN RETURN false;END IF;codes='{}';
   FOR v IN SELECT * FROM jsonb_array_elements(i->side) LOOP
    keys=CASE WHEN side='deductions' THEN ARRAY['code','account'] ELSE ARRAY['code','expense','payable'] END;
    IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& keys) OR v-keys<>'{}'::jsonb OR jsonb_typeof(v->'code') IS DISTINCT FROM 'string' OR v->>'code'!~'^[A-Z0-9][A-Z0-9._-]{0,31}$' OR v->>'code'=ANY(codes) THEN RETURN false;END IF;codes=array_append(codes,v->>'code');
    FOREACH k IN ARRAY keys LOOP IF k='code' THEN CONTINUE;END IF;ref=v->k;
     IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR NOT(ref ?& ARRAY['id','version']) OR ref-ARRAY['id','version']<>'{}'::jsonb OR jsonb_typeof(ref->'id') IS DISTINCT FROM 'string' OR ref->>'id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(ref->'version') IS DISTINCT FROM 'number' OR(ref->>'version')::numeric NOT BETWEEN 1 AND 2147483647 OR(ref->>'version')::numeric<>trunc((ref->>'version')::numeric) THEN RETURN false;END IF;
    END LOOP;
   END LOOP;
  END IF;
 END LOOP;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.payrun_posting_plan(p_run uuid,i jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record;n record;s jsonb;origins jsonb;accounts jsonb;mapping jsonb;wages jsonb;lines jsonb;period jsonb;closed date;reversed_through date;ids uuid[];gross numeric;deductions numeric;scale integer;oversized boolean;BEGIN
 IF NOT public.payrun_posting_input_valid(i) THEN RETURN jsonb_build_object('unavailable','INVALID_PAYRUN_POSTING_INPUT');END IF;
 s=public.payrun_net_source(p_run);IF s IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO r FROM public.payrun_groups WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_run;
 WITH owners AS(SELECT DISTINCT q.run_id FROM jsonb_array_elements(r.source_snapshot->'items') x JOIN public.payrun_earning_claims q ON q.academy_id=r.academy_id AND q.kind=x->>'kind' AND q.source_id=(x->>'sourceId')::uuid AND q.allocation_id=(x->>'allocationId')::uuid)
 SELECT max((v.input->>'postedOn')::date) INTO reversed_through FROM owners o JOIN public.payrun_net_postings p ON p.academy_id=r.academy_id AND p.run_id=o.run_id JOIN public.payrun_net_posting_reversals v ON v.academy_id=p.academy_id AND v.posting_id=p.id;
 IF reversed_through IS NOT NULL AND(i->>'postedOn')::date<reversed_through THEN RETURN jsonb_build_object('unavailable','PAYRUN_REPOST_PRECEDES_RECORDED_REVERSAL');END IF;
 SELECT v.* INTO n FROM public.payrun_net_statements h JOIN public.payrun_net_revisions v ON v.academy_id=h.academy_id AND v.run_id=h.run_id AND v.version=h.version WHERE h.academy_id=r.academy_id AND h.run_id=r.id;
 IF n.version IS DISTINCT FROM(i->>'netVersion')::integer OR n.state IS DISTINCT FROM 'prepared' OR s->'cancellationId'<>'null'::jsonb OR s->'recordedSourcesCurrent' IS DISTINCT FROM 'true'::jsonb OR n.source_snapshot#>>'{source,runSourceSha256}' IS DISTINCT FROM s->>'runSourceSha256' THEN RETURN jsonb_build_object('unavailable','CURRENT_PREPARED_NET_STATEMENT_REQUIRED');END IF;
 scale=r.unit_scale;gross=r.gross_minor;deductions=(n.amounts->>'employeeDeductionMinor')::numeric;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',v->>'kind','sourceId',v->>'sourceId','allocationId',v->>'allocationId','accountId',a.liability_account,'originalAccountVersion',a.liability_version,'minor',trunc((v->>'minor')::numeric*power(10::numeric,scale-(v->>'unitScale')::integer))::text,'postedOn',v->>'postedOn') ORDER BY v->>'kind',v->>'sourceId',v->>'allocationId'),'[]'::jsonb) INTO origins
 FROM jsonb_array_elements(r.source_snapshot->'items') v JOIN public.payroll_gross_liability_catalogue a ON a.academy_id=r.academy_id AND a.kind=v->>'kind' AND a.source_id=(v->>'sourceId')::uuid;
 IF jsonb_array_length(origins)<>jsonb_array_length(r.source_snapshot->'items') OR EXISTS(SELECT 1 FROM jsonb_array_elements(origins) v WHERE(v->>'postedOn')::date>(i->>'postedOn')::date) THEN RETURN jsonb_build_object('unavailable','PAYRUN_ORIGINAL_LIABILITY_UNAVAILABLE_OR_POSTING_PRECEDES_EARNINGS');END IF;
 -- Only nonzero reviewed lines need an account. Exact code-set equality
 -- prevents dropping a deduction or adding an unrelated employer expense.
 IF EXISTS(SELECT v->>'code' FROM jsonb_array_elements(n.definition->'employeeDeductions') v WHERE(v->>'amount')::numeric>0 EXCEPT SELECT v->>'code' FROM jsonb_array_elements(i->'deductions') v)
 OR EXISTS(SELECT v->>'code' FROM jsonb_array_elements(i->'deductions') v EXCEPT SELECT v->>'code' FROM jsonb_array_elements(n.definition->'employeeDeductions') v WHERE(v->>'amount')::numeric>0)
 OR EXISTS(SELECT v->>'code' FROM jsonb_array_elements(n.definition->'employerContributions') v WHERE(v->>'amount')::numeric>0 EXCEPT SELECT v->>'code' FROM jsonb_array_elements(i->'employers') v)
 OR EXISTS(SELECT v->>'code' FROM jsonb_array_elements(i->'employers') v EXCEPT SELECT v->>'code' FROM jsonb_array_elements(n.definition->'employerContributions') v WHERE(v->>'amount')::numeric>0) THEN RETURN jsonb_build_object('unavailable','EXACT_NONZERO_NET_LINE_MAPPINGS_REQUIRED');END IF;
 WITH refs AS(
  SELECT(v->>'accountId')::uuid id,NULL::integer expected,'wage'::text role FROM jsonb_array_elements(origins) v
  UNION ALL SELECT(v#>>'{account,id}')::uuid,(v#>>'{account,version}')::integer,'deduction' FROM jsonb_array_elements(i->'deductions') v
  UNION ALL SELECT(v#>>'{expense,id}')::uuid,(v#>>'{expense,version}')::integer,'expense' FROM jsonb_array_elements(i->'employers') v
  UNION ALL SELECT(v#>>'{payable,id}')::uuid,(v#>>'{payable,version}')::integer,'employer' FROM jsonb_array_elements(i->'employers') v
 ) SELECT array_agg(DISTINCT x.id),jsonb_agg(jsonb_build_object('id',x.id,'expected',x.expected,'role',x.role,'currentVersion',a.version,'kind',a.kind,'operationalRole',a.operational_role,'currencyId',a.currency_id,'unitScale',a.unit_scale,'hubId',a.hub_id,'active',a.active) ORDER BY x.id,x.role) INTO ids,mapping FROM refs x LEFT JOIN public.finance_account_catalogue a ON a.academy_id=r.academy_id AND a.id=x.id;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(mapping) a WHERE a->'active' IS DISTINCT FROM 'true'::jsonb OR a->>'currencyId' IS DISTINCT FROM r.currency_id::text OR(a->>'expected' IS NOT NULL AND a->'expected' IS DISTINCT FROM a->'currentVersion') OR(a->>'role'='expense' AND(a->>'kind'<>'expense' OR a->>'operationalRole'<>'expense')) OR(a->>'role'<>'expense' AND(a->>'kind'<>'liability' OR a->>'operationalRole' NOT IN('payable','tax_payable'))) OR(a->>'role'='wage' AND a->>'operationalRole'<>'payable'))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(mapping) a JOIN jsonb_array_elements(origins) w ON a->>'id'=w->>'accountId' WHERE a->>'role' IN('deduction','employer')) THEN RETURN jsonb_build_object('unavailable','PAYRUN_POSTING_ACCOUNT_MAPPING_INVALID');END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'active',active,'kind',kind,'operationalRole',operational_role,'currencyId',currency_id,'unitScale',unit_scale,'hubId',hub_id) ORDER BY id),'[]'::jsonb) INTO accounts FROM public.finance_account_catalogue WHERE academy_id=r.academy_id AND id=ANY(ids);
 SELECT max(ends_on) INTO closed FROM public.finance_periods WHERE academy_id=r.academy_id AND active_closing_run_id IS NOT NULL AND state='closed';
 SELECT jsonb_build_object('id',id,'version',version,'state',state,'startsOn',starts_on::text,'endsOn',ends_on::text,'closedThrough',closed::text) INTO period FROM public.finance_periods WHERE academy_id=r.academy_id AND id=(i#>>'{period,id}')::uuid;
 IF period IS NULL OR period->>'state'<>'open' OR(period->>'version')::integer<>(i#>>'{period,version}')::integer OR(i->>'postedOn')::date NOT BETWEEN(period->>'startsOn')::date AND(period->>'endsOn')::date OR(closed IS NOT NULL AND(i->>'postedOn')::date<=closed) THEN RETURN jsonb_build_object('unavailable','PAYRUN_POSTING_OPEN_PERIOD_REQUIRED');END IF;
 WITH weights AS(SELECT v->>'accountId' id,sum((v->>'minor')::numeric) weight FROM jsonb_array_elements(origins) v GROUP BY v->>'accountId'),
 shares AS(SELECT *,CASE WHEN gross>0 THEN div(deductions*weight,gross) ELSE 0 END base,CASE WHEN gross>0 THEN mod(deductions*weight,gross) ELSE 0 END remainder FROM weights),
 ranked AS(SELECT *,row_number() OVER(ORDER BY remainder DESC,id) rank,sum(base) OVER() base_total FROM shares)
 SELECT coalesce(jsonb_agg(jsonb_build_object('accountId',id,'minor',trunc(base+CASE WHEN rank<=deductions-base_total THEN 1 ELSE 0 END)::text) ORDER BY id),'[]'::jsonb) INTO wages FROM ranked;
 WITH amounts AS(
  SELECT 'WAGE:'||(v->>'accountId') key,(v->>'accountId')::uuid account_id,'debit'::text side,(v->>'minor')::numeric minor FROM jsonb_array_elements(wages) v
  UNION ALL SELECT 'DEDUCTION:'||(v->>'code'),(v#>>'{account,id}')::uuid,'credit',(d->>'amount')::numeric*power(10::numeric,scale) FROM jsonb_array_elements(i->'deductions') v JOIN jsonb_array_elements(n.definition->'employeeDeductions') d ON v->>'code'=d->>'code'
  UNION ALL SELECT 'EMPLOYER-EXPENSE:'||(v->>'code'),(v#>>'{expense,id}')::uuid,'debit',(d->>'amount')::numeric*power(10::numeric,scale) FROM jsonb_array_elements(i->'employers') v JOIN jsonb_array_elements(n.definition->'employerContributions') d ON v->>'code'=d->>'code'
  UNION ALL SELECT 'EMPLOYER-PAYABLE:'||(v->>'code'),(v#>>'{payable,id}')::uuid,'credit',(d->>'amount')::numeric*power(10::numeric,scale) FROM jsonb_array_elements(i->'employers') v JOIN jsonb_array_elements(n.definition->'employerContributions') d ON v->>'code'=d->>'code'
 ),scaled AS(SELECT x.*,a.version account_version,a.unit_scale,CASE WHEN a.unit_scale>=scale THEN minor*power(10::numeric,a.unit_scale-scale) ELSE div(minor,power(10::numeric,scale-a.unit_scale)) END local_minor,CASE WHEN a.unit_scale<scale THEN mod(minor,power(10::numeric,scale-a.unit_scale))<>0 ELSE false END precision_lost FROM amounts x JOIN public.finance_account_catalogue a ON a.academy_id=r.academy_id AND a.id=x.account_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',key,'accountId',account_id,'accountVersion',account_version,'side',side,'amountMinor',trunc(local_minor)::text,'unitScale',unit_scale) ORDER BY key) FILTER(WHERE local_minor>0),'[]'::jsonb),coalesce(bool_or(precision_lost OR local_minor>=1e38),false) INTO lines,oversized FROM scaled;
 IF oversized THEN RETURN jsonb_build_object('unavailable','PAYRUN_POSTING_ACCOUNT_PRECISION_OR_LINE_LIMIT');END IF;
 IF jsonb_array_length(lines)>200 THEN RETURN jsonb_build_object('unavailable','PAYRUN_POSTING_REQUIRES_BACKGROUND_JOB');END IF;
 RETURN jsonb_build_object('source',s,'net',jsonb_build_object('version',n.version,'state',n.state,'definitionSha256',encode(sha256(convert_to(n.definition::text,'UTF8')),'hex'),'amounts',n.amounts),'origins',origins,'accounts',accounts,'period',period,'wageDeductions',wages,'lines',lines,'allocationPolicy',i->>'allocationPolicy','postedOn',i->>'postedOn','priorReversedThrough',reversed_through::text,'unavailable',NULL);
END $$;
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payrun-postings.view','View private payroll deduction and employer-cost ledger postings','Finance',true,ARRAY['hub','person','country','region','city']),
 ('payrun-postings.edit','Request reviewed payroll ledger postings and exact reversals','Finance',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.payrun_net_postings(
 academy_id uuid NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,net_version integer NOT NULL,input jsonb NOT NULL,plan jsonb NOT NULL,journal_id uuid,reversal_id uuid,approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,run_id,net_version) REFERENCES public.payrun_net_revisions(academy_id,run_id,version),FOREIGN KEY(academy_id,journal_id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE UNIQUE INDEX payrun_net_posting_active ON public.payrun_net_postings(academy_id,run_id) WHERE reversal_id IS NULL;
CREATE INDEX payrun_net_posting_history ON public.payrun_net_postings(academy_id,run_id,id);
CREATE INDEX payrun_earning_claim_history ON public.payrun_earning_claims(academy_id,kind,source_id,allocation_id,run_id);
CREATE TABLE public.payrun_net_posting_reversals(
 academy_id uuid NOT NULL,id uuid NOT NULL,posting_id uuid NOT NULL,input jsonb NOT NULL,source_snapshot jsonb NOT NULL,journal_id uuid,approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,posting_id),UNIQUE(academy_id,id,posting_id),FOREIGN KEY(academy_id,posting_id) REFERENCES public.payrun_net_postings(academy_id,id),FOREIGN KEY(academy_id,journal_id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
ALTER TABLE public.payrun_net_postings ADD CONSTRAINT payrun_net_reversal_identity FOREIGN KEY(academy_id,reversal_id,id) REFERENCES public.payrun_net_posting_reversals(academy_id,id,posting_id) DEFERRABLE INITIALLY DEFERRED;
CREATE OR REPLACE FUNCTION public.payrun_net_basis(p_run uuid,p_before integer) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;b jsonb;BEGIN
 s=public.payrun_net_source(p_run);IF s IS NULL THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('version',version,'state',state,'definition',definition,'amounts',amounts) INTO b FROM public.payrun_net_revisions WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND run_id=p_run AND version=p_before;
 RETURN jsonb_build_object('source',s,'before',b,'activePosting',EXISTS(SELECT 1 FROM public.payrun_net_postings WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND run_id=p_run AND reversal_id IS NULL));
END $$;
CREATE OR REPLACE FUNCTION public.payrun_cancel_source(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b record;BEGIN
 SELECT * INTO b FROM public.payrun_groups WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_id;IF NOT FOUND THEN RETURN NULL;END IF;PERFORM public.lock_hourly_worker(b.person_id);SELECT * INTO b FROM public.payrun_groups WHERE academy_id=b.academy_id AND id=p_id;
 RETURN jsonb_build_object('runId',b.id,'personId',b.person_id,'cancellationId',b.cancellation_id,'scope',b.scope,'sourceSha256',encode(sha256(convert_to(b.source_snapshot::text,'UTF8')),'hex'),'netPostingActive',EXISTS(SELECT 1 FROM public.payrun_net_postings WHERE academy_id=b.academy_id AND run_id=b.id AND reversal_id IS NULL));
END $$;
-- Old cancellation cases copied private HR source terms. Preserve those exact
-- historical snapshots,but bind their visibility to the original source rights.
-- New cancellation cases retain only a source digest and cannot copy HR terms.
UPDATE public.approval_requests p SET privacy_bindings=p.privacy_bindings||CASE
 WHEN jsonb_typeof(p.review_context#>'{source,items}') IS DISTINCT FROM 'array' THEN '[{"unresolved":true}]'::jsonb
 WHEN jsonb_array_length(p.review_context#>'{source,items}')=0 OR NOT EXISTS(SELECT 1 FROM public.payrun_groups g WHERE g.academy_id=p.academy_id AND g.id::text=p.payload->>'runId') THEN '[{"unresolved":true}]'::jsonb
 ELSE(SELECT jsonb_agg(jsonb_build_object('capability',cap,'payrunNetSource',p.payload->>'runId') ORDER BY cap) FROM unnest(ARRAY['work-pay.view','payroll-accruals.view','payroll-adjustments.view']) cap WHERE cap='work-pay.view' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.review_context#>'{source,items}') v WHERE(cap='payroll-adjustments.view')=(v->>'kind'='manual_bonus'))) END
WHERE p.action='work.payrun.cancel' AND p.review_context?'source';
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payrun_net_postings','payrun_net_posting_reversals'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);EXECUTE format('CREATE TRIGGER payrun_posting_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,run_id,net_version,input,plan,approval_id,created_by),UPDATE(reversal_id) ON public.payrun_net_postings TO kavosh_runtime;
GRANT INSERT(academy_id,id,posting_id,input,source_snapshot,approval_id,created_by) ON public.payrun_net_posting_reversals TO kavosh_runtime;
CREATE FUNCTION public.payrun_posting_reverse_source(p_id uuid,i jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record;s jsonb;period jsonb;accounts jsonb;closed date;BEGIN
 SELECT * INTO r FROM public.payrun_net_postings WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_id;IF NOT FOUND THEN RETURN NULL;END IF;
 s=public.payrun_net_source(r.run_id);SELECT * INTO r FROM public.payrun_net_postings WHERE academy_id=r.academy_id AND id=p_id;
 SELECT max(ends_on) INTO closed FROM public.finance_periods WHERE academy_id=r.academy_id AND active_closing_run_id IS NOT NULL AND state='closed';
 SELECT jsonb_build_object('id',id,'version',version,'state',state,'startsOn',starts_on::text,'endsOn',ends_on::text,'closedThrough',closed::text) INTO period FROM public.finance_periods WHERE academy_id=r.academy_id AND id=(i#>>'{period,id}')::uuid;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'active',active,'kind',kind,'unitScale',unit_scale,'hubId',hub_id) ORDER BY id),'[]'::jsonb) INTO accounts FROM public.finance_account_catalogue WHERE academy_id=r.academy_id AND id IN(SELECT(v->>'id')::uuid FROM jsonb_array_elements(r.plan->'accounts') v);
 RETURN jsonb_build_object('posting',jsonb_build_object('id',r.id,'runId',r.run_id,'reversalId',r.reversal_id,'journalId',r.journal_id,'postedOn',r.input->>'postedOn','planSha256',encode(sha256(convert_to(r.plan::text,'UTF8')),'hex')),'source',s,'accounts',accounts,'period',period);
END $$;
CREATE FUNCTION public.guard_payrun_net_posting() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;b jsonb;s jsonb;keys text[];BEGIN
 IF TG_OP='UPDATE' THEN
  IF(to_jsonb(NEW)-'reversal_id') IS DISTINCT FROM(to_jsonb(OLD)-'reversal_id') OR OLD.reversal_id IS NOT NULL OR NEW.reversal_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.payrun_net_posting_reversals v WHERE v.academy_id=NEW.academy_id AND v.id=NEW.reversal_id AND v.posting_id=NEW.id) THEN RAISE EXCEPTION 'PAYRUN_POSTING_EXACT_REVERSAL_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYRUN_POSTING_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF TG_TABLE_NAME='payrun_net_postings' THEN
  b=public.payrun_posting_plan(NEW.run_id,NEW.input);s=b->'source';
  IF b IS NULL OR b->>'unavailable' IS NOT NULL OR NEW.net_version IS DISTINCT FROM(NEW.input->>'netVersion')::integer OR NEW.plan IS DISTINCT FROM b OR NEW.reversal_id IS NOT NULL THEN RAISE EXCEPTION 'PAYRUN_POSTING_SOURCE_INVALID' USING ERRCODE='23514';END IF;
  IF p.action IS DISTINCT FROM 'work.payrun-posting.post' OR p.payload IS DISTINCT FROM jsonb_build_object('runId',NEW.run_id)||NEW.input THEN RAISE EXCEPTION 'PAYRUN_POSTING_EXACT_PAYLOAD_REQUIRED' USING ERRCODE='23514';END IF;
  NEW.journal_id=CASE WHEN jsonb_array_length(b->'lines')>0 THEN NEW.id ELSE NULL END;
 ELSE
  keys=ARRAY['postingId','period','postedOn','reason'];
  IF jsonb_typeof(NEW.input) IS DISTINCT FROM 'object' OR NOT(NEW.input ?& keys) OR NEW.input-keys<>'{}'::jsonb OR jsonb_typeof(NEW.input->'reason') IS DISTINCT FROM 'string' OR length(btrim(NEW.input->>'reason')) NOT BETWEEN 1 AND 2000 OR NEW.posting_id::text IS DISTINCT FROM NEW.input->>'postingId' THEN RAISE EXCEPTION 'PAYRUN_POSTING_REVERSAL_INPUT_INVALID' USING ERRCODE='23514';END IF;
  b=public.payrun_posting_reverse_source(NEW.posting_id,NEW.input);s=b->'source';
  IF b IS NULL OR b#>'{posting,reversalId}'<>'null'::jsonb OR NEW.source_snapshot IS DISTINCT FROM b OR p.action IS DISTINCT FROM 'work.payrun-posting.reverse' OR p.payload IS DISTINCT FROM NEW.input OR b#>>'{period,state}' IS DISTINCT FROM 'open' OR(b#>>'{period,version}')::integer IS DISTINCT FROM(NEW.input#>>'{period,version}')::integer OR(NEW.input->>'postedOn')::date NOT BETWEEN(b#>>'{period,startsOn}')::date AND(b#>>'{period,endsOn}')::date OR(NEW.input->>'postedOn')::date<(b#>>'{posting,postedOn}')::date OR(b#>>'{period,closedThrough}' IS NOT NULL AND(NEW.input->>'postedOn')::date<=(b#>>'{period,closedThrough}')::date) THEN RAISE EXCEPTION 'PAYRUN_POSTING_REVERSAL_SOURCE_INVALID' USING ERRCODE='23514';END IF;
  NEW.journal_id=CASE WHEN b#>>'{posting,journalId}' IS NOT NULL THEN NEW.id ELSE NULL END;
 END IF;
 IF p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.privacy_capability IS DISTINCT FROM 'payrun-postings.view' OR p.scope IS DISTINCT FROM s->'scope' OR p.review_context IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.created_by) THEN RAISE EXCEPTION 'PAYRUN_POSTING_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.created_by::text=s->>'personId' AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payrun_net_posting_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payrun_net_postings FOR EACH ROW EXECUTE FUNCTION public.guard_payrun_net_posting();
CREATE TRIGGER payrun_net_posting_reversal_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payrun_net_posting_reversals FOR EACH ROW EXECUTE FUNCTION public.guard_payrun_net_posting();
CREATE FUNCTION public.payrun_posting_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record;j record;v jsonb;n integer;reverse boolean;parent uuid;BEGIN
 reverse=TG_TABLE_NAME='payrun_net_posting_reversals';
 IF reverse THEN SELECT * INTO r FROM public.payrun_net_postings WHERE academy_id=NEW.academy_id AND id=NEW.posting_id;v=r.plan;parent=r.journal_id;IF r.reversal_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'PAYRUN_POSTING_REVERSAL_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE v=NEW.plan;parent=NULL;IF public.payrun_posting_plan(NEW.run_id,NEW.input) IS DISTINCT FROM v THEN RAISE EXCEPTION 'PAYRUN_POSTING_SOURCE_CHANGED' USING ERRCODE='23514';END IF;END IF;
 n=jsonb_array_length(v->'lines');SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF n=0 THEN IF j.id IS NOT NULL OR NEW.journal_id IS NOT NULL THEN RAISE EXCEPTION 'ZERO_PAYRUN_POSTING_HAS_NO_JOURNAL' USING ERRCODE='23514';END IF;
 ELSE
  IF j.id IS NULL OR NEW.journal_id IS DISTINCT FROM NEW.id OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.posted_by IS DISTINCT FROM NEW.created_by OR j.period_id IS DISTINCT FROM(NEW.input#>>'{period,id}')::uuid OR j.period_version IS DISTINCT FROM(NEW.input#>>'{period,version}')::integer OR j.posted_on IS DISTINCT FROM(NEW.input->>'postedOn')::date OR j.purpose IS DISTINCT FROM 'activity' OR j.reverses_id IS DISTINCT FROM parent OR j.line_count<>n OR j.reference IS DISTINCT FROM(CASE WHEN reverse THEN 'PAYRUN-NET-REVERSAL' ELSE 'PAYRUN-NET' END) OR j.description IS DISTINCT FROM(CASE WHEN reverse THEN 'Correction of payroll deductions and employer costs' ELSE 'Recorded payroll deductions and employer costs' END) THEN RAISE EXCEPTION 'PAYRUN_POSTING_EXACT_JOURNAL_REQUIRED' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v->'lines') WITH ORDINALITY x(l,ordinal) LEFT JOIN public.finance_journal_lines a ON a.academy_id=NEW.academy_id AND a.journal_id=NEW.id AND a.line_number=x.ordinal WHERE a.account_id IS DISTINCT FROM(x.l->>'accountId')::uuid OR a.account_version IS DISTINCT FROM(x.l->>'accountVersion')::integer OR a.amount_minor IS DISTINCT FROM(x.l->>'amountMinor')::numeric OR a.side IS DISTINCT FROM CASE WHEN reverse THEN CASE WHEN x.l->>'side'='debit' THEN 'credit' ELSE 'debit' END ELSE x.l->>'side' END OR a.note IS DISTINCT FROM '') THEN RAISE EXCEPTION 'PAYRUN_POSTING_EXACT_LINES_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.id AND a.actor_id=NEW.created_by AND a.created_at=transaction_timestamp() AND a.action=CASE WHEN reverse THEN 'work.payrun-posting.reverse' ELSE 'work.payrun-posting.post' END AND a.changes->>'approvalId'=NEW.approval_id::text AND a.changes->'paymentExecuted'='false'::jsonb) THEN RAISE EXCEPTION 'PAYRUN_POSTING_AUDIT_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payrun_posting_complete AFTER INSERT ON public.payrun_net_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payrun_posting_complete();
CREATE CONSTRAINT TRIGGER payrun_posting_reversal_complete AFTER INSERT ON public.payrun_net_posting_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payrun_posting_complete();
CREATE CONSTRAINT TRIGGER payrun_posting_reviewed AFTER INSERT ON public.payrun_net_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE CONSTRAINT TRIGGER payrun_posting_reversal_reviewed AFTER INSERT ON public.payrun_net_posting_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.payrun_posting_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND((NEW.action='work.payrun-posting.post' AND NOT EXISTS(SELECT 1 FROM public.payrun_net_postings WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id)) OR(NEW.action='work.payrun-posting.reverse' AND NOT EXISTS(SELECT 1 FROM public.payrun_net_posting_reversals WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id))) THEN RAISE EXCEPTION 'PAYRUN_POSTING_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payrun_posting_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payrun_posting_effect_required();
CREATE FUNCTION public.payrun_posting_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE run uuid;BEGIN
 IF TG_TABLE_NAME='payrun_net_revisions' THEN run=NEW.run_id;ELSE run=NEW.id;END IF;
 PERFORM public.lock_hourly_worker(person_id) FROM public.payrun_groups WHERE academy_id=NEW.academy_id AND id=run;
 IF EXISTS(SELECT 1 FROM public.payrun_net_postings WHERE academy_id=NEW.academy_id AND run_id=run AND reversal_id IS NULL) THEN RAISE EXCEPTION 'PAYRUN_NET_POSTING_REVERSAL_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER payrun_net_posted_statement BEFORE INSERT ON public.payrun_net_revisions FOR EACH ROW EXECUTE FUNCTION public.payrun_posting_source_guard();
CREATE TRIGGER payrun_net_posted_group BEFORE UPDATE OF cancellation_id ON public.payrun_groups FOR EACH ROW EXECUTE FUNCTION public.payrun_posting_source_guard();
CREATE FUNCTION public.payrun_posting_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r uuid;accounts jsonb;cap text;BEGIN
 IF NEW.action='work.payrun-posting.post' THEN r=(NEW.payload->>'runId')::uuid;accounts=NEW.review_context->'accounts';
 ELSE r=(NEW.review_context#>>'{posting,runId}')::uuid;accounts=NEW.review_context->'accounts';END IF;
 IF r IS NULL OR jsonb_typeof(accounts) IS DISTINCT FROM 'array' THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','payruns.view','scope',NEW.scope),jsonb_build_object('capability','payrun-net.view','scope',NEW.scope));
 FOREACH cap IN ARRAY ARRAY['work-pay.view','payroll-accruals.view','payroll-adjustments.view'] LOOP
  IF cap='work-pay.view' OR EXISTS(SELECT 1 FROM public.payrun_groups g CROSS JOIN LATERAL jsonb_array_elements(g.source_snapshot->'items') v WHERE g.academy_id=NEW.academy_id AND g.id=r AND(cap='payroll-adjustments.view')=(v->>'kind'='manual_bonus')) THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'payrunNetSource',r));END IF;
 END LOOP;
 FOREACH cap IN ARRAY ARRAY['accounts.view','journals.view'] LOOP
  IF jsonb_array_length(accounts)>0 THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(accounts) a WHERE a->'hubId'='null'::jsonb) THEN '{"all":true,"hubs":[]}'::jsonb ELSE jsonb_build_object('all',false,'hubs',(SELECT jsonb_agg(DISTINCT a->'hubId') FROM jsonb_array_elements(accounts) a)) END));END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER zz_payrun_posting_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('work.payrun-posting.post','work.payrun-posting.reverse')) EXECUTE FUNCTION public.payrun_posting_privacy();
CREATE FUNCTION public.payrun_posting_journal_reversal_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.reverses_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.payrun_net_postings p WHERE p.academy_id=NEW.academy_id AND p.journal_id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.payrun_net_posting_reversals r JOIN public.payrun_net_postings p ON p.academy_id=r.academy_id AND p.id=r.posting_id WHERE r.academy_id=NEW.academy_id AND r.journal_id=NEW.id AND p.journal_id=NEW.reverses_id AND p.reversal_id=r.id) THEN RAISE EXCEPTION 'PAYRUN_POSTING_NATIVE_REVERSAL_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payrun_posting_journal_reversal AFTER INSERT ON public.finance_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payrun_posting_journal_reversal_required();
REVOKE ALL ON FUNCTION public.payrun_posting_journal_reversal_required() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payrun_posting_reverse_source(uuid,jsonb),public.guard_payrun_net_posting(),public.payrun_posting_complete(),public.payrun_posting_effect_required(),public.payrun_posting_source_guard(),public.payrun_posting_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payrun_posting_reverse_source(uuid,jsonb) TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.payrun_posting_input_valid(jsonb),public.payrun_posting_plan(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payrun_posting_input_valid(jsonb),public.payrun_posting_plan(uuid,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 150 $$;

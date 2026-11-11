-- Explicit T4A service-payment recognition. No payroll/profile reclassification,
-- journal posting,government filing,or rewriting an existing payment.
UPDATE public.capability_catalog SET label='View private worker tax settings and payment recognition' WHERE name='payroll-tax.view';
UPDATE public.capability_catalog SET label='Propose reviewed worker tax settings and payment recognition' WHERE name='payroll-tax.edit';
CREATE TABLE public.t4a_payment_records(
 academy_id uuid NOT NULL,payment_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,payment_id),FOREIGN KEY(academy_id,payment_id) REFERENCES public.payrun_payments(academy_id,id)
);
CREATE TABLE public.t4a_payment_revisions(
 academy_id uuid NOT NULL,payment_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('recorded','withdrawn')),definition jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=1048576),changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,payment_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,payment_id) REFERENCES public.t4a_payment_records(academy_id,payment_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.t4a_payment_records ADD CONSTRAINT t4a_current_revision FOREIGN KEY(academy_id,payment_id,version) REFERENCES public.t4a_payment_revisions(academy_id,payment_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['t4a_payment_records','t4a_payment_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);EXECUTE format('CREATE TRIGGER t4a_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,payment_id),UPDATE(version) ON public.t4a_payment_records TO kavosh_runtime;
GRANT INSERT(academy_id,payment_id,version,definition,source_snapshot,changed_by,approval_id,reason) ON public.t4a_payment_revisions TO kavosh_runtime;
CREATE TRIGGER t4a_header_version BEFORE INSERT OR UPDATE ON public.t4a_payment_records FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();

CREATE FUNCTION public.t4a_record_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE a jsonb;v jsonb;k text;positive boolean:=false;keys text[]:=ARRAY['timeZone','reportingAccount','allocation','incomeTaxSources'];BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d?&keys) OR d-keys<>'{}'::jsonb OR octet_length(d::text)>65536 OR jsonb_typeof(d->'timeZone') IS DISTINCT FROM 'string' OR length(d->>'timeZone') NOT BETWEEN 1 AND 100 OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=d->>'timeZone') THEN RETURN false;END IF;
 v=d->'reportingAccount';IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v?&ARRAY['id','version']) OR v-ARRAY['id','version']<>'{}'::jsonb OR jsonb_typeof(v->'id') IS DISTINCT FROM 'string' OR v->>'id'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR jsonb_typeof(v->'version') IS DISTINCT FROM 'number' OR v->>'version'!~'^[1-9][0-9]{0,9}$' OR(v->>'version')::numeric>2147483646 THEN RETURN false;END IF;
 a=d->'allocation';keys=ARRAY['income','gstHst','pst','incomeTaxDeducted','otherExcluded','eligibilityReview','review'];
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a?&keys) OR a-keys<>'{}'::jsonb THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['gstHst','pst','incomeTaxDeducted'] LOOP IF public.work_money_valid(a->k,2) IS NOT TRUE THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['review'] LOOP IF jsonb_typeof(a->k) IS DISTINCT FROM 'string' OR length(btrim(a->>k)) NOT BETWEEN 1 AND 2000 OR a->>k~'[[:cntrl:]]' THEN RETURN false;END IF;END LOOP;
 v=a->'eligibilityReview';keys=ARRAY['canadianRecipient','nonEmployment','serviceReportingReviewed','sourceReference'];
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v?&keys) OR v-keys<>'{}'::jsonb OR v->'canadianRecipient' IS DISTINCT FROM 'true'::jsonb OR v->'nonEmployment' IS DISTINCT FROM 'true'::jsonb OR v->'serviceReportingReviewed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(v->'sourceReference') IS DISTINCT FROM 'string' OR length(btrim(v->>'sourceReference')) NOT BETWEEN 1 AND 2000 OR v->>'sourceReference'~'[[:cntrl:]]' THEN RETURN false;END IF;
 IF jsonb_typeof(a->'income') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'income') NOT BETWEEN 1 AND 2 THEN RETURN false;END IF;
 FOR v IN SELECT * FROM jsonb_array_elements(a->'income') LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v?&ARRAY['box','amount']) OR v-ARRAY['box','amount']<>'{}'::jsonb OR jsonb_typeof(v->'box') IS DISTINCT FROM 'string' OR v->>'box' NOT IN('020','048') OR public.work_money_valid(v->'amount',2) IS NOT TRUE THEN RETURN false;END IF;
  positive=positive OR(v->>'amount')::numeric>0;
 END LOOP;
 IF NOT positive OR jsonb_array_length(a->'income')<>(SELECT count(DISTINCT x->>'box') FROM jsonb_array_elements(a->'income') x) THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['incomeTaxSources','otherExcluded'] LOOP
  v=CASE WHEN k='incomeTaxSources' THEN d->k ELSE a->k END;
  IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v)>100 OR jsonb_array_length(v)<>(SELECT count(DISTINCT x->>'code') FROM jsonb_array_elements(v) x) THEN RETURN false;END IF;
  FOR v IN SELECT * FROM jsonb_array_elements(v) LOOP
   keys=CASE WHEN k='incomeTaxSources' THEN ARRAY['code','amount'] ELSE ARRAY['code','amount','sourceReference'] END;
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v?&keys) OR v-keys<>'{}'::jsonb OR jsonb_typeof(v->'code') IS DISTINCT FROM 'string' OR v->>'code'!~'^[A-Z0-9][A-Z0-9._-]{0,31}$' OR v->>'code'~'[[:cntrl:]]' OR public.work_money_valid(v->'amount',2) IS NOT TRUE THEN RETURN false;END IF;
   IF k='otherExcluded' AND(jsonb_typeof(v->'sourceReference') IS DISTINCT FROM 'string' OR length(btrim(v->>'sourceReference')) NOT BETWEEN 1 AND 2000 OR v->>'sourceReference'~'[[:cntrl:]]') THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN (SELECT coalesce(sum((x->>'amount')::numeric),0) FROM jsonb_array_elements(d->'incomeTaxSources') x)=(a->>'incomeTaxDeducted')::numeric;
END $$;

CREATE FUNCTION public.t4a_payment_plan(p_payment uuid,p_before integer,d jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE pay record;post record;g record;n record;head record;b jsonb;others jsonb;source jsonb;accounts jsonb;method jsonb;funding jsonb;binding jsonb;paid date;gross numeric;deducted numeric;other_net numeric;claimed numeric;line_item jsonb;other_count integer;other_bytes bigint;employer uuid;BEGIN
 SELECT * INTO pay FROM public.payrun_payments WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_payment;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO post FROM public.payrun_net_postings WHERE academy_id=pay.academy_id AND id=pay.posting_id;SELECT * INTO g FROM public.payrun_groups WHERE academy_id=pay.academy_id AND id=post.run_id;PERFORM public.lock_hourly_worker(g.person_id);
 IF g.unit_scale<>2 OR(SELECT code FROM public.finance_currencies WHERE academy_id=g.academy_id AND id=g.currency_id) IS DISTINCT FROM 'CAD' OR jsonb_array_length(g.source_snapshot->'contexts')<>1 OR g.source_snapshot#>>'{contexts,0,countryCode}' IS DISTINCT FROM 'CA' OR g.source_snapshot#>>'{contexts,0,classification}' IS DISTINCT FROM 'contractor' OR g.source_snapshot#>>'{contexts,0,reportingForm}' IS DISTINCT FROM 'T4A' THEN RETURN jsonb_build_object('unavailable','T4A_CANADIAN_CONTRACTOR_CONTEXT_REQUIRED');END IF;
 employer=(g.source_snapshot#>>'{contexts,0,employerId}')::uuid;
 SELECT * INTO head FROM public.t4a_payment_records WHERE academy_id=g.academy_id AND payment_id=p_payment;
 IF(head.payment_id IS NOT NULL AND head.version NOT IN(p_before,p_before+1)) OR(head.payment_id IS NULL AND p_before<>0) THEN RETURN jsonb_build_object('unavailable','T4A_VERSION_CHANGED');END IF;
 SELECT jsonb_build_object('version',version,'state',state,'definition',definition,'source',source_snapshot->'source') INTO b FROM public.t4a_payment_revisions WHERE academy_id=g.academy_id AND payment_id=p_payment AND version=p_before;
 IF d IS DISTINCT FROM 'null'::jsonb AND public.t4a_record_definition_valid(d) IS NOT TRUE THEN RETURN jsonb_build_object('unavailable','T4A_DEFINITION_INVALID');END IF;
 IF d='null'::jsonb THEN
  IF b->>'state' IS DISTINCT FROM 'recorded' THEN RETURN jsonb_build_object('unavailable','T4A_WITHDRAWAL_UNAVAILABLE');END IF;
  paid=(b#>>'{source,paidOn}')::date;binding=b#>'{source,reportingAccount}';
 ELSE
  IF pay.reversal_id IS NOT NULL OR post.reversal_id IS NOT NULL THEN RETURN jsonb_build_object('unavailable','T4A_ACTIVE_PAYMENT_REQUIRED');END IF;
  paid=((pay.input->>'paidAt')::timestamptz AT TIME ZONE(d->>'timeZone'))::date;
  PERFORM id FROM public.payroll_employer_accounts WHERE academy_id=g.academy_id AND id=(d#>>'{reportingAccount,id}')::uuid FOR SHARE;
  binding=public.payroll_employer_default_binding((d#>>'{reportingAccount,id}')::uuid,(d#>>'{reportingAccount,version}')::integer,employer,paid);
  IF binding IS NULL THEN RETURN jsonb_build_object('unavailable','T4A_REPORTING_ACCOUNT_CHANGED');END IF;
 END IF;
 SELECT * INTO n FROM public.payrun_net_revisions WHERE academy_id=g.academy_id AND run_id=g.id AND version=post.net_version;
 WITH selected AS MATERIALIZED(SELECT x.payment_id,r.version,r.definition,r.source_snapshot->>'netMinor' net FROM public.t4a_payment_records x JOIN public.payrun_payments p ON p.academy_id=x.academy_id AND p.id=x.payment_id JOIN public.t4a_payment_revisions r ON r.academy_id=x.academy_id AND r.payment_id=x.payment_id AND r.version=x.version WHERE x.academy_id=g.academy_id AND p.posting_id=post.id AND x.payment_id<>p_payment AND r.state='recorded' ORDER BY x.payment_id LIMIT 1001),
 stats AS(SELECT count(*)::integer n,coalesce(sum(octet_length(definition::text)),0)::bigint bytes FROM selected)
 SELECT stats.n,stats.bytes,(SELECT coalesce(jsonb_agg(jsonb_build_object('paymentId',payment_id,'version',version,'definition',definition,'netMinor',net) ORDER BY payment_id),'[]'::jsonb) FROM selected WHERE stats.n<=1000 AND stats.bytes<=524288) INTO other_count,other_bytes,others FROM stats;
 IF other_count>1000 OR other_bytes>524288 THEN RETURN jsonb_build_object('unavailable','T4A_REQUIRES_BACKGROUND_JOB');END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('paymentId',p.id,'accountId',a.id,'accountHubId',a.hub_id,'methodId',m.id,'methodHubId',m.hub_id) ORDER BY p.id),'[]'::jsonb) INTO funding FROM(SELECT * FROM public.payrun_payments WHERE academy_id=g.academy_id AND posting_id=post.id ORDER BY id LIMIT 2001) p JOIN public.finance_accounts a ON a.academy_id=p.academy_id AND a.id=p.funding_account JOIN public.finance_payment_methods m ON m.academy_id=p.academy_id AND m.id=p.method_id;
 IF jsonb_array_length(funding)>2000 THEN RETURN jsonb_build_object('unavailable','T4A_REQUIRES_BACKGROUND_JOB');END IF;
 SELECT jsonb_agg(jsonb_build_object('id',a.id,'hubId',a.hub_id) ORDER BY a.id) INTO accounts FROM public.finance_accounts a WHERE a.academy_id=g.academy_id AND(a.id IN(SELECT(x->>'id')::uuid FROM jsonb_array_elements(pay.plan->'accounts') x) OR a.id IN(SELECT(x->>'accountId')::uuid FROM jsonb_array_elements(funding) x));
 SELECT jsonb_build_object('id',id,'hubId',hub_id) INTO method FROM public.finance_payment_methods WHERE academy_id=g.academy_id AND id=pay.method_id;
 IF d<>'null'::jsonb THEN
  deducted=(d#>>'{allocation,incomeTaxDeducted}')::numeric*100;gross=pay.amount_minor+deducted;
  SELECT coalesce(sum((x->>'netMinor')::numeric),0) INTO other_net FROM jsonb_array_elements(others) x;
  IF gross>=1e38::numeric OR gross>(post.plan#>>'{net,amounts,grossMinor}')::numeric OR gross<>100*((d#>>'{allocation,gstHst}')::numeric+(d#>>'{allocation,pst}')::numeric+(SELECT coalesce(sum((x->>'amount')::numeric),0) FROM jsonb_array_elements(d#>'{allocation,income}') x)+(SELECT coalesce(sum((x->>'amount')::numeric),0) FROM jsonb_array_elements(d#>'{allocation,otherExcluded}') x)) THEN RETURN jsonb_build_object('unavailable','T4A_ALLOCATION_UNRECONCILED');END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'incomeTaxSources') x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(n.definition->'employeeDeductions') y WHERE y->>'code'=x->>'code')) THEN RETURN jsonb_build_object('unavailable','T4A_UNKNOWN_POSTED_DEDUCTION');END IF;
  FOR line_item IN SELECT * FROM jsonb_array_elements(n.definition->'employeeDeductions') LOOP
   SELECT coalesce(sum((x->>'amount')::numeric*100),0) INTO claimed FROM(SELECT x FROM jsonb_array_elements(d->'incomeTaxSources') x UNION ALL SELECT x FROM jsonb_array_elements(others) o CROSS JOIN LATERAL jsonb_array_elements(o#>'{definition,incomeTaxSources}') x) a WHERE x->>'code'=line_item->>'code';
   IF claimed>(line_item->>'amount')::numeric*100 THEN RETURN jsonb_build_object('unavailable','T4A_DEDUCTION_CAPACITY_EXCEEDED');END IF;
   IF other_net+pay.amount_minor=(post.plan#>>'{net,amounts,netMinor}')::numeric AND claimed<>(line_item->>'amount')::numeric*100 THEN RETURN jsonb_build_object('unavailable','T4A_FINAL_PAYMENT_COMPLETE_DEDUCTIONS_REQUIRED');END IF;
  END LOOP;
 END IF;
 source=jsonb_build_object('personId',g.person_id,'runId',g.id,'scope',g.scope,'employerId',employer,'taxYear',extract(year FROM paid)::integer,'reportingAccount',binding,'postingId',post.id,'netVersion',post.net_version,'paymentId',pay.id,'paymentReversalId',pay.reversal_id,'postingReversalId',post.reversal_id,'paidAt',pay.input->>'paidAt','paidOn',paid::text,'postedOn',pay.posted_on::text,'paymentSha256',encode(sha256(convert_to(jsonb_build_array(pay.input,pay.plan)::text,'UTF8')),'hex'));
 RETURN jsonb_build_object('source',source,'accounts',accounts,'method',method,'fundingHistory',funding,'evidence',NULL,'handler',NULL,'before',b,'otherRecords',others,'grossMinor',trunc(gross)::text,'netMinor',trunc(pay.amount_minor)::text,'unavailable',NULL);
END $$;

CREATE FUNCTION public.t4a_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;b jsonb;i jsonb;s jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'T4A_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.t4a_payment_records WHERE academy_id=NEW.academy_id AND payment_id=NEW.payment_id;
 i=jsonb_build_object('paymentId',NEW.payment_id,'expectedVersion',NEW.version-1,'definition',NEW.definition,'reason',NEW.reason);b=public.t4a_payment_plan(NEW.payment_id,NEW.version-1,NEW.definition);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',b#>>'{source,personId}','hubId',NULL)),'workContext',jsonb_build_object('personId',b#>>'{source,personId}','hubId',NULL));
 IF h.payment_id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.t4a_payment_revisions WHERE academy_id=NEW.academy_id AND payment_id=NEW.payment_id) OR b IS NULL OR b->>'unavailable' IS NOT NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.t4a-record.change' OR p.target_id IS DISTINCT FROM NEW.payment_id OR p.target_version<>NEW.version-1 OR p.payload IS DISTINCT FROM i OR p.privacy_capability IS DISTINCT FROM 'payroll-tax.view' OR p.scope IS DISTINCT FROM s OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'T4A_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by::text=b#>>'{source,personId}' AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.state=CASE WHEN NEW.definition='null'::jsonb THEN 'withdrawn' ELSE 'recorded' END;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER t4a_revision BEFORE INSERT OR UPDATE OR DELETE ON public.t4a_payment_revisions FOR EACH ROW EXECUTE FUNCTION public.t4a_revision_guard();
CREATE CONSTRAINT TRIGGER t4a_reviewed AFTER INSERT ON public.t4a_payment_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.t4a_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.t4a_payment_plan(NEW.payment_id,NEW.version-1,NEW.definition) IS DISTINCT FROM NEW.source_snapshot OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.payment_id AND actor_id=NEW.changed_by AND action='work.t4a-record.change' AND created_at=transaction_timestamp() AND changes->'version'=to_jsonb(NEW.version) AND changes->>'approvalId'=NEW.approval_id::text AND changes->'severity'='"critical"'::jsonb AND changes->'privateContentRedacted'='true'::jsonb AND changes->'paymentExecuted'='false'::jsonb AND changes->'additionalLedgerPosting'='false'::jsonb) THEN RAISE EXCEPTION 'T4A_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER t4a_complete AFTER INSERT ON public.t4a_payment_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.t4a_complete();
CREATE FUNCTION public.t4a_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.t4a-record.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.t4a_payment_revisions WHERE academy_id=NEW.academy_id AND payment_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'T4A_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER t4a_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.t4a_effect_required();
CREATE TRIGGER zz_t4a_payment_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.t4a-record.change') EXECUTE FUNCTION public.payrun_payment_privacy();
CREATE TRIGGER zzz_t4a_payment_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.t4a-record.change') EXECUTE FUNCTION public.paid_tax_privacy();
CREATE FUNCTION public.t4a_employer_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 NEW.privacy_bindings=NEW.privacy_bindings||'[{"capability":"payroll-employers.view","scope":{"all":true,"hubs":[]}}]'::jsonb;RETURN NEW;
END $$;
CREATE TRIGGER zzzz_t4a_employer_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.t4a-record.change') EXECUTE FUNCTION public.t4a_employer_privacy();
REVOKE ALL ON FUNCTION public.t4a_record_definition_valid(jsonb),public.t4a_payment_plan(uuid,integer,jsonb),public.t4a_revision_guard(),public.t4a_complete(),public.t4a_effect_required(),public.t4a_employer_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.t4a_record_definition_valid(jsonb),public.t4a_payment_plan(uuid,integer,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 370 $$;

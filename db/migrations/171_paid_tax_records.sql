-- Explicit recognition of actual recorded partial payments,not a proportional
-- inference from planned pay or ledger dates. No new journal or money movement.
CREATE TABLE public.paid_tax_records(
 academy_id uuid NOT NULL,payment_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,payment_id),FOREIGN KEY(academy_id,payment_id) REFERENCES public.payrun_payments(academy_id,id),FOREIGN KEY(academy_id,profile_id) REFERENCES public.payroll_tax_profiles(academy_id,id)
);
CREATE INDEX paid_tax_profile ON public.paid_tax_records(academy_id,profile_id,payment_id);
CREATE TABLE public.paid_tax_record_revisions(
 academy_id uuid NOT NULL,payment_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('recorded','withdrawn')),definition jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=1048576),changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,payment_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,payment_id) REFERENCES public.paid_tax_records(academy_id,payment_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.paid_tax_records ADD CONSTRAINT paid_tax_current_revision FOREIGN KEY(academy_id,payment_id,version) REFERENCES public.paid_tax_record_revisions(academy_id,payment_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['paid_tax_records','paid_tax_record_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);EXECUTE format('CREATE TRIGGER paid_tax_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,payment_id,profile_id),UPDATE(version,profile_id) ON public.paid_tax_records TO kavosh_runtime;
GRANT INSERT(academy_id,payment_id,version,definition,source_snapshot,changed_by,approval_id,reason) ON public.paid_tax_record_revisions TO kavosh_runtime;
CREATE FUNCTION public.paid_tax_header_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE person uuid;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAID_TAX_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT person_id INTO person FROM public.payroll_tax_profiles WHERE academy_id=NEW.academy_id AND id=NEW.profile_id;PERFORM public.lock_hourly_worker(person);
 IF(TG_OP='INSERT' AND NEW.version<>1) OR(TG_OP='UPDATE' AND(NEW.version<>OLD.version+1 OR(to_jsonb(NEW)-ARRAY['version','profile_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['version','profile_id']))) THEN RAISE EXCEPTION 'PAID_TAX_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND NEW.profile_id<>OLD.profile_id AND NOT EXISTS(SELECT 1 FROM public.paid_tax_record_revisions r JOIN public.payroll_tax_profiles a ON a.academy_id=r.academy_id AND a.id=OLD.profile_id JOIN public.payroll_tax_profiles b ON b.academy_id=a.academy_id AND b.id=NEW.profile_id AND b.person_id=a.person_id AND b.employer_id=a.employer_id WHERE r.academy_id=OLD.academy_id AND r.payment_id=OLD.payment_id AND r.version=OLD.version AND r.state='withdrawn') THEN RAISE EXCEPTION 'PAID_TAX_WITHDRAW_BEFORE_YEAR_CORRECTION' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER paid_tax_header BEFORE INSERT OR UPDATE OR DELETE ON public.paid_tax_records FOR EACH ROW EXECUTE FUNCTION public.paid_tax_header_guard();
CREATE FUNCTION public.paid_tax_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE k text;line_item jsonb;keys text[]:=ARRAY['timeZone','taxableEarnings','pensionableEarnings','insurableEarnings','employeeDeductions','employerContributions','review'];BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& keys) OR d-keys<>'{}'::jsonb OR octet_length(d::text)>65536 OR jsonb_typeof(d->'timeZone') IS DISTINCT FROM 'string' OR length(d->>'timeZone') NOT BETWEEN 1 AND 100 OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=d->>'timeZone') OR jsonb_typeof(d->'review') IS DISTINCT FROM 'string' OR length(btrim(d->>'review')) NOT BETWEEN 1 AND 2000 OR d->>'review'~'[[:cntrl:]]' THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['taxableEarnings','pensionableEarnings','insurableEarnings'] LOOP IF public.work_money_valid(d->k,2) IS NOT TRUE THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['employeeDeductions','employerContributions'] LOOP
  IF jsonb_typeof(d->k) IS DISTINCT FROM 'array' OR jsonb_array_length(d->k)>100 THEN RETURN false;END IF;
  FOR line_item IN SELECT * FROM jsonb_array_elements(d->k) LOOP
   IF jsonb_typeof(line_item) IS DISTINCT FROM 'object' OR NOT(line_item ?& ARRAY['code','kind','amount']) OR line_item-ARRAY['code','kind','amount']<>'{}'::jsonb OR jsonb_typeof(line_item->'code') IS DISTINCT FROM 'string' OR line_item->>'code'!~'^[A-Z0-9][A-Z0-9._-]{0,31}$' OR jsonb_typeof(line_item->'kind') IS DISTINCT FROM 'string' OR line_item->>'kind' NOT IN('CPP','CPP2','QPP','QPP2','EI','QPIP','income_tax','other') OR(k='employerContributions' AND line_item->>'kind'='income_tax') OR public.work_money_valid(line_item->'amount',2) IS NOT TRUE THEN RETURN false;END IF;
  END LOOP;
  IF jsonb_array_length(d->k)<>(SELECT count(DISTINCT v->>'code') FROM jsonb_array_elements(d->k) v) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION public.paid_tax_record_plan(p_profile uuid,p_payment uuid,p_before integer,d jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE h record;pay record;post record;g record;n record;head public.paid_tax_records%ROWTYPE;b jsonb;others jsonb;source jsonb;accounts jsonb;method jsonb;funding jsonb;paid date;gross numeric;deducted numeric;other_net numeric;k text;line_item jsonb;claimed numeric;cap numeric;other_count integer;other_bytes bigint;BEGIN
 SELECT * INTO h FROM public.payroll_tax_profiles WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_profile;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM public.lock_hourly_worker(h.person_id);
 SELECT * INTO pay FROM public.payrun_payments WHERE academy_id=h.academy_id AND id=p_payment;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO post FROM public.payrun_net_postings WHERE academy_id=h.academy_id AND id=pay.posting_id;SELECT * INTO g FROM public.payrun_groups WHERE academy_id=h.academy_id AND id=post.run_id;
 IF g.person_id IS DISTINCT FROM h.person_id THEN RETURN NULL;END IF;
 IF g.unit_scale<>2 OR(SELECT code FROM public.finance_currencies WHERE academy_id=h.academy_id AND id=g.currency_id) IS DISTINCT FROM 'CAD' OR jsonb_array_length(g.source_snapshot->'contexts')<>1 OR g.source_snapshot#>>'{contexts,0,employerId}' IS DISTINCT FROM h.employer_id::text OR g.source_snapshot#>>'{contexts,0,countryCode}' IS DISTINCT FROM 'CA' OR g.source_snapshot#>>'{contexts,0,classification}' IS DISTINCT FROM 'employee' THEN RETURN jsonb_build_object('unavailable','PAID_TAX_CANADIAN_EMPLOYEE_CONTEXT_REQUIRED');END IF;
 SELECT * INTO head FROM public.paid_tax_records WHERE academy_id=h.academy_id AND payment_id=p_payment;
 IF(head.payment_id IS NOT NULL AND head.version NOT IN(p_before,p_before+1)) OR(head.payment_id IS NULL AND p_before<>0) THEN RETURN jsonb_build_object('unavailable','PAID_TAX_VERSION_CHANGED');END IF;
 SELECT jsonb_build_object('version',version,'state',state,'definition',definition,'paidOn',source_snapshot#>>'{source,paidOn}') INTO b FROM public.paid_tax_record_revisions WHERE academy_id=h.academy_id AND payment_id=p_payment AND version=p_before;
 IF head.payment_id IS NOT NULL AND head.profile_id<>p_profile AND(b->>'state' IS DISTINCT FROM 'withdrawn' OR NOT EXISTS(SELECT 1 FROM public.payroll_tax_profiles old WHERE old.academy_id=h.academy_id AND old.id=head.profile_id AND old.person_id=h.person_id AND old.employer_id=h.employer_id)) THEN RETURN jsonb_build_object('unavailable','PAID_TAX_WITHDRAW_BEFORE_YEAR_CORRECTION');END IF;
 IF d IS DISTINCT FROM 'null'::jsonb AND public.paid_tax_definition_valid(d) IS NOT TRUE THEN RETURN jsonb_build_object('unavailable','PAID_TAX_DEFINITION_INVALID');END IF;
 IF d='null'::jsonb THEN IF b->>'state' IS DISTINCT FROM 'recorded' THEN RETURN jsonb_build_object('unavailable','PAID_TAX_WITHDRAWAL_UNAVAILABLE');END IF;paid=(b->>'paidOn')::date;
 ELSE
  IF pay.reversal_id IS NOT NULL OR post.reversal_id IS NOT NULL THEN RETURN jsonb_build_object('unavailable','PAID_TAX_ACTIVE_PAYMENT_REQUIRED');END IF;
  paid=((pay.input->>'paidAt')::timestamptz AT TIME ZONE(d->>'timeZone'))::date;IF extract(year FROM paid)::integer<>h.tax_year THEN RETURN jsonb_build_object('unavailable','PAID_TAX_PAYMENT_YEAR_MISMATCH');END IF;
 END IF;
 SELECT * INTO n FROM public.payrun_net_revisions WHERE academy_id=h.academy_id AND run_id=g.id AND version=post.net_version;
 WITH selected AS MATERIALIZED(SELECT x.payment_id,r.version,r.definition-'review' definition,r.source_snapshot->>'netMinor' net FROM public.paid_tax_records x JOIN public.payrun_payments p ON p.academy_id=x.academy_id AND p.id=x.payment_id JOIN public.paid_tax_record_revisions r ON r.academy_id=x.academy_id AND r.payment_id=x.payment_id AND r.version=x.version WHERE x.academy_id=h.academy_id AND p.posting_id=post.id AND x.payment_id<>p_payment AND r.state='recorded' ORDER BY x.payment_id LIMIT 1001),
 stats AS(SELECT count(*)::integer n,coalesce(sum(octet_length(definition::text)),0)::bigint bytes FROM selected),usable AS(SELECT * FROM selected WHERE(SELECT stats.n<=1000 AND stats.bytes<=524288 FROM stats))
 SELECT stats.n,stats.bytes,(SELECT coalesce(jsonb_agg(jsonb_build_object('paymentId',payment_id,'version',version,'definition',definition,'netMinor',net) ORDER BY payment_id),'[]'::jsonb) FROM usable) INTO other_count,other_bytes,others FROM stats;
 IF other_count>1000 OR other_bytes>524288 THEN RETURN jsonb_build_object('unavailable','PAID_TAX_REQUIRES_BACKGROUND_JOB');END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('paymentId',p.id,'accountId',a.id,'accountHubId',a.hub_id,'methodId',m.id,'methodHubId',m.hub_id) ORDER BY p.id),'[]'::jsonb) INTO funding FROM(SELECT * FROM public.payrun_payments WHERE academy_id=h.academy_id AND posting_id=post.id ORDER BY id LIMIT 2001) p JOIN public.finance_accounts a ON a.academy_id=p.academy_id AND a.id=p.funding_account JOIN public.finance_payment_methods m ON m.academy_id=p.academy_id AND m.id=p.method_id;
 IF jsonb_array_length(funding)>2000 THEN RETURN jsonb_build_object('unavailable','PAID_TAX_REQUIRES_BACKGROUND_JOB');END IF;
 SELECT jsonb_agg(jsonb_build_object('id',a.id,'hubId',a.hub_id) ORDER BY a.id) INTO accounts FROM public.finance_accounts a WHERE a.academy_id=h.academy_id AND(a.id IN(SELECT(x->>'id')::uuid FROM jsonb_array_elements(pay.plan->'accounts') x) OR a.id IN(SELECT(x->>'accountId')::uuid FROM jsonb_array_elements(funding) x));
 SELECT jsonb_build_object('id',m.id,'hubId',m.hub_id) INTO method FROM public.finance_payment_methods m WHERE m.academy_id=h.academy_id AND m.id=pay.method_id;
 source=jsonb_build_object('profileId',h.id,'personId',h.person_id,'runId',g.id,'scope',g.scope,'employerId',h.employer_id,'taxYear',h.tax_year,'postingId',post.id,'netVersion',post.net_version,'paymentId',pay.id,'paymentReversalId',pay.reversal_id,'postingReversalId',post.reversal_id,'paidAt',pay.input->>'paidAt','paidOn',paid::text,'postedOn',pay.posted_on::text,'paymentSha256',encode(sha256(convert_to(jsonb_build_array(pay.input,pay.plan)::text,'UTF8')),'hex'));
 IF d<>'null'::jsonb THEN
  SELECT coalesce(sum((v->>'amount')::numeric*100),0) INTO deducted FROM jsonb_array_elements(d->'employeeDeductions') v;gross=pay.amount_minor+deducted;
  IF gross>=(1e38::numeric) OR gross>(post.plan#>>'{net,amounts,grossMinor}')::numeric OR EXISTS(SELECT 1 FROM unnest(ARRAY['taxableEarnings','pensionableEarnings','insurableEarnings']) field_key WHERE(d->>field_key)::numeric*100>gross) THEN RETURN jsonb_build_object('unavailable','PAID_TAX_EARNINGS_EXCEED_ALLOCATED_GROSS');END IF;
  SELECT coalesce(sum((o->>'netMinor')::numeric),0) INTO other_net FROM jsonb_array_elements(others) o;
  FOREACH k IN ARRAY ARRAY['employeeDeductions','employerContributions'] LOOP
   FOR line_item IN SELECT * FROM jsonb_array_elements(d->k) LOOP
    SELECT(sum((a->>'amount')::numeric)*100) INTO cap FROM jsonb_array_elements(n.definition->k) a WHERE a->>'code'=line_item->>'code';
    IF cap IS NULL THEN RETURN jsonb_build_object('unavailable','PAID_TAX_UNKNOWN_POSTED_LINE');END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(others) o CROSS JOIN LATERAL jsonb_array_elements(o->'definition'->k) a WHERE a->>'code'=line_item->>'code' AND a->>'kind' IS DISTINCT FROM line_item->>'kind') THEN RETURN jsonb_build_object('unavailable','PAID_TAX_LINE_CLASSIFICATION_CONFLICT');END IF;
   END LOOP;
   FOR line_item IN SELECT * FROM jsonb_array_elements(n.definition->k) LOOP
    cap=(line_item->>'amount')::numeric*100;
    SELECT coalesce(sum((a->>'amount')::numeric*100),0) INTO claimed FROM(SELECT a FROM jsonb_array_elements(d->k) a UNION ALL SELECT a FROM jsonb_array_elements(others) o CROSS JOIN LATERAL jsonb_array_elements(o->'definition'->k) a) t WHERE a->>'code'=line_item->>'code';
    IF claimed>cap THEN RETURN jsonb_build_object('unavailable','PAID_TAX_POSTED_LINE_CAPACITY_EXCEEDED');END IF;
    IF other_net+pay.amount_minor=(post.plan#>>'{net,amounts,netMinor}')::numeric AND claimed<>cap THEN RETURN jsonb_build_object('unavailable','PAID_TAX_FINAL_PAYMENT_COMPLETE_LINES_REQUIRED');END IF;
   END LOOP;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('source',source,'accounts',accounts,'method',method,'fundingHistory',funding,'evidence',NULL,'handler',NULL,'before',b,'otherRecords',others,'grossMinor',trunc(gross)::text,'netMinor',trunc(pay.amount_minor)::text,'unavailable',NULL);
END $$;
CREATE FUNCTION public.paid_tax_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;b jsonb;i jsonb;s jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAID_TAX_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.paid_tax_records WHERE academy_id=NEW.academy_id AND payment_id=NEW.payment_id;
 i=jsonb_build_object('profileId',h.profile_id,'paymentId',NEW.payment_id,'expectedVersion',NEW.version-1,'definition',NEW.definition,'reason',NEW.reason);b=public.paid_tax_record_plan(h.profile_id,NEW.payment_id,NEW.version-1,NEW.definition);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',b#>>'{source,personId}','hubId',NULL)),'workContext',jsonb_build_object('personId',b#>>'{source,personId}','hubId',NULL));
 IF h.payment_id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.paid_tax_record_revisions WHERE academy_id=NEW.academy_id AND payment_id=NEW.payment_id) OR b IS NULL OR b->>'unavailable' IS NOT NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.paid-tax-record.change' OR p.target_id IS DISTINCT FROM NEW.payment_id OR p.target_version<>NEW.version-1 OR p.payload IS DISTINCT FROM i OR p.privacy_capability IS DISTINCT FROM 'payroll-tax.view' OR p.scope IS DISTINCT FROM s OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'PAID_TAX_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by::text=b#>>'{source,personId}' AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.state=CASE WHEN NEW.definition='null'::jsonb THEN 'withdrawn' ELSE 'recorded' END;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER paid_tax_revision BEFORE INSERT OR UPDATE OR DELETE ON public.paid_tax_record_revisions FOR EACH ROW EXECUTE FUNCTION public.paid_tax_revision_guard();
CREATE CONSTRAINT TRIGGER paid_tax_reviewed AFTER INSERT ON public.paid_tax_record_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.paid_tax_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE profile uuid;BEGIN
 SELECT profile_id INTO profile FROM public.paid_tax_records WHERE academy_id=NEW.academy_id AND payment_id=NEW.payment_id;
 IF public.paid_tax_record_plan(profile,NEW.payment_id,NEW.version-1,NEW.definition) IS DISTINCT FROM NEW.source_snapshot OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.payment_id AND actor_id=NEW.changed_by AND action='work.paid-tax-record.change' AND created_at=transaction_timestamp() AND changes->'version'=to_jsonb(NEW.version) AND changes->>'approvalId'=NEW.approval_id::text AND changes->'severity'='"critical"'::jsonb AND changes->'privateContentRedacted'='true'::jsonb AND changes->'paymentExecuted'='false'::jsonb AND changes->'additionalLedgerPosting'='false'::jsonb) THEN RAISE EXCEPTION 'PAID_TAX_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER paid_tax_complete AFTER INSERT ON public.paid_tax_record_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.paid_tax_complete();
CREATE FUNCTION public.paid_tax_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.paid-tax-record.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.paid_tax_record_revisions WHERE academy_id=NEW.academy_id AND payment_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PAID_TAX_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER paid_tax_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.paid_tax_effect_required();
CREATE TRIGGER zz_paid_tax_payment_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.paid-tax-record.change') EXECUTE FUNCTION public.payrun_payment_privacy();
CREATE FUNCTION public.paid_tax_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE method_scope jsonb;BEGIN
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','payrun-payments.view','scope',NEW.review_context#>'{source,scope}'));
 SELECT CASE WHEN bool_or(x->'methodHubId'='null'::jsonb) THEN '{"all":true,"hubs":[]}'::jsonb ELSE jsonb_build_object('all',false,'hubs',jsonb_agg(DISTINCT x->'methodHubId')) END INTO method_scope FROM jsonb_array_elements(NEW.review_context->'fundingHistory') x;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','payment-methods.view','scope',method_scope));RETURN NEW;
END $$;
CREATE TRIGGER zzz_paid_tax_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.paid-tax-record.change') EXECUTE FUNCTION public.paid_tax_privacy();
REVOKE ALL ON FUNCTION public.paid_tax_header_guard(),public.paid_tax_definition_valid(jsonb),public.paid_tax_record_plan(uuid,uuid,integer,jsonb),public.paid_tax_revision_guard(),public.paid_tax_complete(),public.paid_tax_effect_required(),public.paid_tax_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.paid_tax_definition_valid(jsonb),public.paid_tax_record_plan(uuid,uuid,integer,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 171 $$;

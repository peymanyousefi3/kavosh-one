-- Separate tax recognition of an already reviewed actual zero-net settlement.
-- Reuse tax definitions and posted amounts;never manufacture a cash payment.
CREATE TABLE public.zero_net_tax_records(
 academy_id uuid NOT NULL,posting_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,posting_id),FOREIGN KEY(academy_id,posting_id) REFERENCES public.zero_net_settlements(academy_id,posting_id),FOREIGN KEY(academy_id,profile_id) REFERENCES public.payroll_tax_profiles(academy_id,id)
);
CREATE INDEX zero_net_tax_profile ON public.zero_net_tax_records(academy_id,profile_id,posting_id);
CREATE TABLE public.zero_net_tax_revisions(
 academy_id uuid NOT NULL,posting_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),settlement_version integer NOT NULL CHECK(settlement_version>0),state text NOT NULL CHECK(state IN('recorded','withdrawn')),
 definition jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=1048576),changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,posting_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,posting_id) REFERENCES public.zero_net_tax_records(academy_id,posting_id),
 FOREIGN KEY(academy_id,posting_id,settlement_version) REFERENCES public.zero_net_settlement_revisions(academy_id,posting_id,version),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.zero_net_tax_records ADD CONSTRAINT zero_net_tax_current_revision FOREIGN KEY(academy_id,posting_id,version) REFERENCES public.zero_net_tax_revisions(academy_id,posting_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['zero_net_tax_records','zero_net_tax_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER zero_tax_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,posting_id,profile_id),UPDATE(version,profile_id) ON public.zero_net_tax_records TO kavosh_runtime;
GRANT INSERT(academy_id,posting_id,version,settlement_version,definition,source_snapshot,changed_by,approval_id,reason) ON public.zero_net_tax_revisions TO kavosh_runtime;
CREATE FUNCTION public.zero_net_tax_plan(p_profile uuid,p_posting uuid,p_before integer,p_settlement integer,d jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE h record;p record;g record;z record;zr record;head record;n record;b jsonb;s jsonb;source jsonb;binding jsonb;line_item jsonb;k text;on_day date;gross numeric;claimed numeric;BEGIN
 IF p_before IS NULL OR p_before NOT BETWEEN 0 AND 2147483646 OR p_settlement IS NULL OR p_settlement<1 OR d IS NULL THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_INPUT_INVALID');END IF;
 SELECT * INTO h FROM public.payroll_tax_profiles WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_profile;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM public.lock_hourly_worker(h.person_id);
 SELECT * INTO p FROM public.payrun_net_postings WHERE academy_id=h.academy_id AND id=p_posting;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO g FROM public.payrun_groups WHERE academy_id=p.academy_id AND id=p.run_id;IF g.person_id IS DISTINCT FROM h.person_id THEN RETURN NULL;END IF;
 SELECT * INTO z FROM public.zero_net_settlements WHERE academy_id=p.academy_id AND posting_id=p.id;IF NOT FOUND THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_RECORDED_SETTLEMENT_REQUIRED');END IF;
 IF z.version<>p_settlement THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_SETTLEMENT_VERSION_CHANGED');END IF;
 SELECT * INTO zr FROM public.zero_net_settlement_revisions WHERE academy_id=z.academy_id AND posting_id=z.posting_id AND version=z.version;
 SELECT * INTO head FROM public.zero_net_tax_records WHERE academy_id=p.academy_id AND posting_id=p.id;
 IF(head.posting_id IS NULL AND p_before<>0) OR(head.posting_id IS NOT NULL AND head.version NOT IN(p_before,p_before+1)) THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_VERSION_CHANGED');END IF;
 SELECT jsonb_build_object('version',version,'state',state,'definition',definition,'recognizedOn',source_snapshot#>>'{source,recognizedOn}') INTO b FROM public.zero_net_tax_revisions WHERE academy_id=p.academy_id AND posting_id=p.id AND version=p_before;
 IF head.posting_id IS NOT NULL AND head.profile_id<>h.id AND(b->>'state' IS DISTINCT FROM 'withdrawn' OR NOT EXISTS(SELECT 1 FROM public.payroll_tax_profiles old WHERE old.academy_id=h.academy_id AND old.id=head.profile_id AND old.person_id=h.person_id AND old.employer_id=h.employer_id)) THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_WITHDRAW_BEFORE_YEAR_CORRECTION');END IF;
 IF d='null'::jsonb THEN
  IF b->>'state' IS DISTINCT FROM 'recorded' THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_WITHDRAWAL_UNAVAILABLE');END IF;on_day=(b->>'recognizedOn')::date;
 ELSE
  IF public.paid_tax_definition_valid(d) IS NOT TRUE THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_DEFINITION_INVALID');END IF;
  IF g.unit_scale<>2 OR(SELECT code FROM public.finance_currencies WHERE academy_id=g.academy_id AND id=g.currency_id) IS DISTINCT FROM 'CAD' OR jsonb_array_length(g.source_snapshot->'contexts')<>1 OR g.source_snapshot#>>'{contexts,0,employerId}' IS DISTINCT FROM h.employer_id::text OR g.source_snapshot#>>'{contexts,0,countryCode}' IS DISTINCT FROM 'CA' OR g.source_snapshot#>>'{contexts,0,classification}' IS DISTINCT FROM 'employee' THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_CANADIAN_EMPLOYEE_CONTEXT_REQUIRED');END IF;
  IF zr.state<>'recorded' THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_RECORDED_SETTLEMENT_REQUIRED');END IF;
  s=public.zero_net_settlement_plan(p.id,z.version,zr.definition);IF s IS NULL OR s->>'unavailable' IS NOT NULL THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_ACTIVE_SETTLEMENT_SOURCE_REQUIRED');END IF;
  on_day=((zr.definition->>'settledAt')::timestamptz AT TIME ZONE(d->>'timeZone'))::date;
  IF extract(year FROM on_day)::integer<>h.tax_year THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_SETTLEMENT_YEAR_MISMATCH');END IF;
  gross=(p.plan#>>'{net,amounts,grossMinor}')::numeric;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['taxableEarnings','pensionableEarnings','insurableEarnings']) field_key WHERE(d->>field_key)::numeric*100>gross) THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_EARNINGS_EXCEED_GROSS');END IF;
  SELECT * INTO n FROM public.payrun_net_revisions WHERE academy_id=p.academy_id AND run_id=p.run_id AND version=p.net_version;
  FOREACH k IN ARRAY ARRAY['employeeDeductions','employerContributions'] LOOP
   FOR line_item IN SELECT value FROM jsonb_array_elements(d->k) LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(n.definition->k) original WHERE original->>'code'=line_item->>'code') THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_UNKNOWN_POSTED_LINE');END IF;
   END LOOP;
   FOR line_item IN SELECT value FROM jsonb_array_elements(n.definition->k) LOOP
    SELECT coalesce(sum((v->>'amount')::numeric*100),0) INTO claimed FROM jsonb_array_elements(d->k) v WHERE v->>'code'=line_item->>'code';
    IF claimed IS DISTINCT FROM(line_item->>'amount')::numeric*100 THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_COMPLETE_POSTED_LINES_REQUIRED');END IF;
   END LOOP;
  END LOOP;
  SELECT coalesce(sum((v->>'amount')::numeric*100),0) INTO claimed FROM jsonb_array_elements(d->'employeeDeductions') v;
  IF claimed<>gross THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_GROSS_CONSERVATION_REQUIRED');END IF;
  IF d?'reportingAccount' THEN
   PERFORM id FROM public.payroll_employer_accounts WHERE academy_id=h.academy_id AND id=(d#>>'{reportingAccount,id}')::uuid FOR SHARE;
   binding=public.payroll_employer_default_binding((d#>>'{reportingAccount,id}')::uuid,(d#>>'{reportingAccount,version}')::integer,h.employer_id,on_day);
   IF binding IS NULL THEN RETURN jsonb_build_object('unavailable','ZERO_NET_TAX_REPORTING_ACCOUNT_CHANGED');END IF;
   binding=binding||jsonb_build_object('businessNumberFingerprint',(SELECT encode(sha256(convert_to(jsonb_build_array(h.academy_id,left(a.account_number,9))::text,'UTF8')),'hex') FROM public.payroll_employer_accounts a WHERE a.academy_id=h.academy_id AND a.id=(d#>>'{reportingAccount,id}')::uuid));
  END IF;
 END IF;
 source=jsonb_build_object('profileId',h.id,'personId',h.person_id,'employerId',h.employer_id,'taxYear',h.tax_year,'postingId',p.id,'runId',g.id,'scope',p.plan#>'{source,scope}','netVersion',p.net_version,'postingReversalId',p.reversal_id,'settlementVersion',z.version,'settlementState',zr.state,'settledAt',zr.definition->>'settledAt','recognizedOn',on_day::text,'settlementSha256',encode(sha256(convert_to(jsonb_build_array(zr.definition,zr.source_snapshot)::text,'UTF8')),'hex'));
 IF binding IS NOT NULL THEN source=source||jsonb_build_object('reportingAccount',binding);END IF;
 RETURN jsonb_build_object('source',source,'posting',jsonb_build_object('id',p.id,'runId',g.id),'accounts',p.plan->'accounts','before',b,'grossMinor',trunc(gross)::text,'netMinor','0','unavailable',NULL);
END $$;
CREATE FUNCTION public.zero_net_tax_header_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE person uuid;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ZERO_NET_TAX_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT person_id INTO person FROM public.payroll_tax_profiles WHERE academy_id=NEW.academy_id AND id=NEW.profile_id;PERFORM public.lock_hourly_worker(person);
 IF(TG_OP='INSERT' AND NEW.version<>1) OR(TG_OP='UPDATE' AND(NEW.version<>OLD.version+1 OR(to_jsonb(NEW)-ARRAY['version','profile_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['version','profile_id']))) THEN RAISE EXCEPTION 'ZERO_NET_TAX_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND NEW.profile_id<>OLD.profile_id AND NOT EXISTS(SELECT 1 FROM public.zero_net_tax_revisions r JOIN public.payroll_tax_profiles a ON a.academy_id=r.academy_id AND a.id=OLD.profile_id JOIN public.payroll_tax_profiles b ON b.academy_id=a.academy_id AND b.id=NEW.profile_id AND b.person_id=a.person_id AND b.employer_id=a.employer_id WHERE r.academy_id=OLD.academy_id AND r.posting_id=OLD.posting_id AND r.version=OLD.version AND r.state='withdrawn') THEN RAISE EXCEPTION 'ZERO_NET_TAX_WITHDRAW_BEFORE_YEAR_CORRECTION' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER zero_net_tax_header BEFORE INSERT OR UPDATE OR DELETE ON public.zero_net_tax_records FOR EACH ROW EXECUTE FUNCTION public.zero_net_tax_header_guard();
CREATE FUNCTION public.zero_net_tax_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;b jsonb;i jsonb;s jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ZERO_NET_TAX_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.zero_net_tax_records WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id;
 i=jsonb_build_object('profileId',h.profile_id,'postingId',NEW.posting_id,'expectedVersion',NEW.version-1,'settlementVersion',NEW.settlement_version,'definition',NEW.definition,'reason',NEW.reason);
 b=public.zero_net_tax_plan(h.profile_id,NEW.posting_id,NEW.version-1,NEW.settlement_version,NEW.definition);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',b#>>'{source,personId}','hubId',NULL)),'workContext',jsonb_build_object('personId',b#>>'{source,personId}','hubId',NULL));
 IF h.posting_id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.zero_net_tax_revisions WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id) OR b IS NULL OR b->>'unavailable' IS NOT NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.zero-net-tax.change' OR p.target_id IS DISTINCT FROM NEW.posting_id OR p.target_version<>NEW.version-1 OR p.payload IS DISTINCT FROM i OR p.privacy_capability IS DISTINCT FROM 'payroll-tax.view' OR p.scope IS DISTINCT FROM s OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'ZERO_NET_TAX_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by::text=b#>>'{source,personId}' AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.state=CASE WHEN NEW.definition='null'::jsonb THEN 'withdrawn' ELSE 'recorded' END;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER zero_net_tax_revision BEFORE INSERT OR UPDATE OR DELETE ON public.zero_net_tax_revisions FOR EACH ROW EXECUTE FUNCTION public.zero_net_tax_revision_guard();
CREATE CONSTRAINT TRIGGER zero_net_tax_reviewed AFTER INSERT ON public.zero_net_tax_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.zero_net_tax_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE profile uuid;BEGIN
 SELECT profile_id INTO profile FROM public.zero_net_tax_records WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id;
 IF public.zero_net_tax_plan(profile,NEW.posting_id,NEW.version-1,NEW.settlement_version,NEW.definition) IS DISTINCT FROM NEW.source_snapshot OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.posting_id AND actor_id=NEW.changed_by AND action='work.zero-net-tax.change' AND created_at=transaction_timestamp() AND changes->'version'=to_jsonb(NEW.version) AND changes->>'approvalId'=NEW.approval_id::text AND changes->>'severity'='critical' AND changes->'privateContentRedacted'='true'::jsonb AND changes->'paymentExecuted'='false'::jsonb AND changes->'additionalLedgerPosting'='false'::jsonb) THEN RAISE EXCEPTION 'ZERO_NET_TAX_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zero_net_tax_complete AFTER INSERT ON public.zero_net_tax_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.zero_net_tax_complete();
CREATE FUNCTION public.zero_net_tax_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.zero-net-tax.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.zero_net_tax_revisions WHERE academy_id=NEW.academy_id AND posting_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'ZERO_NET_TAX_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zero_net_tax_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.zero_net_tax_effect_required();
CREATE FUNCTION public.zero_net_tax_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE cap text;run uuid;accounts jsonb;BEGIN
 run=(NEW.review_context#>>'{source,runId}')::uuid;accounts=NEW.review_context->'accounts';
 IF run IS NULL OR jsonb_typeof(accounts) IS DISTINCT FROM 'array' THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 -- The tax request's person scope is not a hub scope. Source grants bind to
 -- the actual original posting,not that unrelated request-scope shape.
 FOREACH cap IN ARRAY ARRAY['payruns.view','payrun-net.view','payrun-postings.view','payrun-payments.view'] LOOP
  NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',NEW.review_context#>'{source,scope}'));
 END LOOP;
 FOREACH cap IN ARRAY ARRAY['work-pay.view','payroll-accruals.view','payroll-adjustments.view'] LOOP
  IF cap='work-pay.view' OR EXISTS(SELECT 1 FROM public.payrun_groups g CROSS JOIN LATERAL jsonb_array_elements(g.source_snapshot->'items') v WHERE g.academy_id=NEW.academy_id AND g.id=run AND(cap='payroll-adjustments.view')=(v->>'kind'='manual_bonus')) THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'payrunNetSource',run));END IF;
 END LOOP;
 FOREACH cap IN ARRAY ARRAY['accounts.view','journals.view'] LOOP
  IF jsonb_array_length(accounts)>0 THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(accounts) a WHERE a->'hubId'='null'::jsonb) THEN '{"all":true,"hubs":[]}'::jsonb ELSE jsonb_build_object('all',false,'hubs',(SELECT jsonb_agg(DISTINCT a->'hubId') FROM jsonb_array_elements(accounts) a)) END));END IF;
 END LOOP;
 IF NEW.review_context#>'{source,reportingAccount}' IS NOT NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"capability":"payroll-employers.view","scope":{"all":true,"hubs":[]}}]'::jsonb;END IF;RETURN NEW;
END $$;
CREATE TRIGGER zzz_zero_tax_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.zero-net-tax.change') EXECUTE FUNCTION public.zero_net_tax_privacy();
REVOKE ALL ON FUNCTION public.zero_net_tax_plan(uuid,uuid,integer,integer,jsonb),public.zero_net_tax_header_guard(),public.zero_net_tax_revision_guard(),public.zero_net_tax_complete(),public.zero_net_tax_effect_required(),public.zero_net_tax_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.zero_net_tax_plan(uuid,uuid,integer,integer,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 411 $$;

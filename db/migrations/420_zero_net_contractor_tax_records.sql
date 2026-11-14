-- Separate reviewed contractor tax allocation of an actual zero-net settlement.
-- No cash payment,ledger posting,automatic eligibility decision or CRA filing.
CREATE TABLE public.zero_net_t4a_records(
 academy_id uuid NOT NULL,posting_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,posting_id),FOREIGN KEY(academy_id,posting_id) REFERENCES public.zero_net_settlements(academy_id,posting_id)
);
CREATE TABLE public.zero_net_t4a_revisions(
 academy_id uuid NOT NULL,posting_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),settlement_version integer NOT NULL CHECK(settlement_version>0),state text NOT NULL CHECK(state IN('recorded','withdrawn')),
 definition jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=1048576),changed_by uuid NOT NULL,approval_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,posting_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,posting_id) REFERENCES public.zero_net_t4a_records(academy_id,posting_id),
 FOREIGN KEY(academy_id,posting_id,settlement_version) REFERENCES public.zero_net_settlement_revisions(academy_id,posting_id,version),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.zero_net_t4a_records ADD CONSTRAINT zero_net_t4a_current_revision FOREIGN KEY(academy_id,posting_id,version) REFERENCES public.zero_net_t4a_revisions(academy_id,posting_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['zero_net_t4a_records','zero_net_t4a_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER zero_t4a_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,posting_id),UPDATE(version) ON public.zero_net_t4a_records TO kavosh_runtime;
GRANT INSERT(academy_id,posting_id,version,settlement_version,definition,source_snapshot,changed_by,approval_id,reason) ON public.zero_net_t4a_revisions TO kavosh_runtime;
-- The header has exactly the existing posting/version identity shape. Reuse
-- its original immutable-header and same-worker locking guard unchanged.
CREATE TRIGGER zero_t4a_header BEFORE INSERT OR UPDATE OR DELETE ON public.zero_net_t4a_records FOR EACH ROW EXECUTE FUNCTION public.zero_net_settlement_header_guard();

CREATE FUNCTION public.zero_net_t4a_plan(p_posting uuid,p_before integer,p_settlement integer,d jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;g record;z record;zr record;h record;n record;b jsonb;s jsonb;binding jsonb;source jsonb;deductions jsonb;line_item jsonb;on_day date;employer uuid;gross numeric;withheld numeric;non_tax numeric;claimed numeric;BEGIN
 IF p_before IS NULL OR p_before NOT BETWEEN 0 AND 2147483646 OR p_settlement IS NULL OR p_settlement<1 OR d IS NULL THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_INPUT_INVALID');END IF;
 SELECT * INTO p FROM public.payrun_net_postings WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_posting;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO g FROM public.payrun_groups WHERE academy_id=p.academy_id AND id=p.run_id;PERFORM public.lock_hourly_worker(g.person_id);
 SELECT * INTO z FROM public.zero_net_settlements WHERE academy_id=p.academy_id AND posting_id=p.id;IF NOT FOUND THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_RECORDED_SETTLEMENT_REQUIRED');END IF;
 IF z.version<>p_settlement THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_SETTLEMENT_VERSION_CHANGED');END IF;
 SELECT * INTO zr FROM public.zero_net_settlement_revisions WHERE academy_id=z.academy_id AND posting_id=z.posting_id AND version=z.version;
 SELECT * INTO h FROM public.zero_net_t4a_records WHERE academy_id=p.academy_id AND posting_id=p.id;
 IF(h.posting_id IS NULL AND p_before<>0) OR(h.posting_id IS NOT NULL AND h.version NOT IN(p_before,p_before+1)) THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_VERSION_CHANGED');END IF;
 SELECT jsonb_build_object('version',version,'state',state,'definition',definition,'source',source_snapshot->'source') INTO b FROM public.zero_net_t4a_revisions WHERE academy_id=p.academy_id AND posting_id=p.id AND version=p_before;
 employer=(g.source_snapshot#>>'{contexts,0,employerId}')::uuid;
 IF d='null'::jsonb THEN
  IF b->>'state' IS DISTINCT FROM 'recorded' THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_WITHDRAWAL_UNAVAILABLE');END IF;
  on_day=(b#>>'{source,recognizedOn}')::date;binding=b#>'{source,reportingAccount}';
 ELSE
  IF public.t4a_record_definition_valid(d) IS NOT TRUE THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_DEFINITION_INVALID');END IF;
  IF g.unit_scale<>2 OR(SELECT code FROM public.finance_currencies WHERE academy_id=g.academy_id AND id=g.currency_id) IS DISTINCT FROM 'CAD'
   OR jsonb_array_length(g.source_snapshot->'contexts')<>1 OR g.source_snapshot#>>'{contexts,0,countryCode}' IS DISTINCT FROM 'CA'
   OR g.source_snapshot#>>'{contexts,0,classification}' IS DISTINCT FROM 'contractor' OR g.source_snapshot#>>'{contexts,0,reportingForm}' IS DISTINCT FROM 'T4A' THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_CANADIAN_CONTRACTOR_CONTEXT_REQUIRED');END IF;
  IF zr.state<>'recorded' THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_RECORDED_SETTLEMENT_REQUIRED');END IF;
  s=public.zero_net_settlement_plan(p.id,z.version,zr.definition);IF s IS NULL OR s->>'unavailable' IS NOT NULL THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_ACTIVE_SETTLEMENT_SOURCE_REQUIRED');END IF;
  on_day=((zr.definition->>'settledAt')::timestamptz AT TIME ZONE(d->>'timeZone'))::date;
  gross=(p.plan#>>'{net,amounts,grossMinor}')::numeric;withheld=(d#>>'{allocation,incomeTaxDeducted}')::numeric*100;
  SELECT coalesce(sum((v->>'amount')::numeric*100),0) INTO non_tax FROM jsonb_array_elements(coalesce(d->'nonTaxDeductionSources','[]'::jsonb)) v;
  IF gross IS NULL OR gross<=0 OR gross>=1e38::numeric OR gross<>withheld+non_tax
   OR gross<>100*((d#>>'{allocation,gstHst}')::numeric+(d#>>'{allocation,pst}')::numeric+(SELECT coalesce(sum((v->>'amount')::numeric),0) FROM jsonb_array_elements(d#>'{allocation,income}') v)+(SELECT coalesce(sum((v->>'amount')::numeric),0) FROM jsonb_array_elements(d#>'{allocation,otherExcluded}') v)) THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_ALLOCATION_UNRECONCILED');END IF;
  SELECT * INTO n FROM public.payrun_net_revisions WHERE academy_id=p.academy_id AND run_id=p.run_id AND version=p.net_version;
  deductions=(d->'incomeTaxSources')||coalesce(d->'nonTaxDeductionSources','[]'::jsonb);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(deductions) v WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(n.definition->'employeeDeductions') original WHERE original->>'code'=v->>'code')) THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_UNKNOWN_POSTED_DEDUCTION');END IF;
  FOR line_item IN SELECT value FROM jsonb_array_elements(n.definition->'employeeDeductions') LOOP
   SELECT coalesce(sum((v->>'amount')::numeric*100),0) INTO claimed FROM jsonb_array_elements(deductions) v WHERE v->>'code'=line_item->>'code';
   IF claimed IS DISTINCT FROM(line_item->>'amount')::numeric*100 THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_COMPLETE_POSTED_DEDUCTIONS_REQUIRED');END IF;
  END LOOP;
  PERFORM id FROM public.payroll_employer_accounts WHERE academy_id=g.academy_id AND id=(d#>>'{reportingAccount,id}')::uuid FOR SHARE;
  binding=public.payroll_employer_default_binding((d#>>'{reportingAccount,id}')::uuid,(d#>>'{reportingAccount,version}')::integer,employer,on_day);
  IF binding IS NULL THEN RETURN jsonb_build_object('unavailable','ZERO_NET_T4A_REPORTING_ACCOUNT_CHANGED');END IF;
 END IF;
 source=jsonb_build_object('personId',g.person_id,'employerId',employer,'taxYear',extract(year FROM on_day)::integer,'runId',g.id,'scope',p.plan#>'{source,scope}',
  'postingId',p.id,'netVersion',p.net_version,'postingReversalId',p.reversal_id,'settlementVersion',z.version,'settlementState',zr.state,
  'settledAt',zr.definition->>'settledAt','recognizedOn',on_day::text,'reportingAccount',binding,
  'settlementSha256',encode(sha256(convert_to(jsonb_build_array(zr.definition,zr.source_snapshot)::text,'UTF8')),'hex'));
 RETURN jsonb_build_object('source',source,'accounts',p.plan->'accounts','before',b,'grossMinor',trunc(gross)::text,'netMinor','0','nonTaxDeductedMinor',trunc(non_tax)::text,'unavailable',NULL);
END $$;
CREATE FUNCTION public.zero_net_t4a_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;b jsonb;i jsonb;s jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ZERO_NET_T4A_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.zero_net_t4a_records WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id;
 i=jsonb_build_object('postingId',NEW.posting_id,'expectedVersion',NEW.version-1,'settlementVersion',NEW.settlement_version,'definition',NEW.definition,'reason',NEW.reason);
 b=public.zero_net_t4a_plan(NEW.posting_id,NEW.version-1,NEW.settlement_version,NEW.definition);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',b#>>'{source,personId}','hubId',NULL)),'workContext',jsonb_build_object('personId',b#>>'{source,personId}','hubId',NULL));
 IF h.posting_id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.zero_net_t4a_revisions WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id)
  OR b IS NULL OR b->>'unavailable' IS NOT NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.zero-net-t4a.change' OR p.target_id IS DISTINCT FROM NEW.posting_id OR p.target_version<>NEW.version-1
  OR p.payload IS DISTINCT FROM i OR p.privacy_capability IS DISTINCT FROM 'payroll-tax.view' OR p.scope IS DISTINCT FROM s OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'ZERO_NET_T4A_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by::text=b#>>'{source,personId}' AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.state=CASE WHEN NEW.definition='null'::jsonb THEN 'withdrawn' ELSE 'recorded' END;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER zero_net_t4a_revision BEFORE INSERT OR UPDATE OR DELETE ON public.zero_net_t4a_revisions FOR EACH ROW EXECUTE FUNCTION public.zero_net_t4a_revision_guard();
CREATE CONSTRAINT TRIGGER zero_net_t4a_reviewed AFTER INSERT ON public.zero_net_t4a_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.zero_net_t4a_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.zero_net_t4a_plan(NEW.posting_id,NEW.version-1,NEW.settlement_version,NEW.definition) IS DISTINCT FROM NEW.source_snapshot
  OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.posting_id AND actor_id=NEW.changed_by AND action='work.zero-net-t4a.change' AND created_at=transaction_timestamp()
   AND changes->'version'=to_jsonb(NEW.version) AND changes->>'approvalId'=NEW.approval_id::text AND changes->>'severity'='critical' AND changes->'privateContentRedacted'='true'::jsonb AND changes->'paymentExecuted'='false'::jsonb AND changes->'additionalLedgerPosting'='false'::jsonb) THEN RAISE EXCEPTION 'ZERO_NET_T4A_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zero_net_t4a_complete AFTER INSERT ON public.zero_net_t4a_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.zero_net_t4a_complete();
CREATE FUNCTION public.zero_net_t4a_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.zero-net-t4a.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.zero_net_t4a_revisions WHERE academy_id=NEW.academy_id AND posting_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'ZERO_NET_T4A_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zero_net_t4a_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.zero_net_t4a_effect_required();
-- Reuse the existing exact original posting/source/accounts and employer
-- privacy binding. No native tax function or privilege is broadened.
CREATE TRIGGER zzz_zero_net_t4a_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.zero-net-t4a.change') EXECUTE FUNCTION public.zero_net_tax_privacy();
REVOKE ALL ON FUNCTION public.zero_net_t4a_plan(uuid,integer,integer,jsonb),public.zero_net_t4a_revision_guard(),public.zero_net_t4a_complete(),public.zero_net_t4a_effect_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.zero_net_t4a_plan(uuid,integer,integer,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 420 $$;

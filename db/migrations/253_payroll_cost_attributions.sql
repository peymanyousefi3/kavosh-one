-- Analytical payroll assignments only. Original earnings,employer costs,
-- statutory preparations,hourly overlap pricing and payments are untouched.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payroll-cost-attribution.view','View reviewed payroll analytical assignments','Finance',true,ARRAY['hub','country','region','city']),
 ('payroll-cost-attribution.edit','Request payroll analytical assignments without changing pay','Finance',true,ARRAY['hub','country','region','city']);
CREATE VIEW public.payroll_cost_attribution_origins WITH(security_invoker=true) AS
 SELECT academy_id,id journal_id,'manual_bonus'::text kind,person_id,hub_id,NULL::uuid class_id,NULL::uuid student_id,NULL::jsonb hourly_allocations FROM public.payroll_adjustments
 UNION ALL SELECT academy_id,id,'salary',person_id,hub_id,NULL::uuid,NULL::uuid,NULL::jsonb FROM public.payroll_salary_accruals
 UNION ALL SELECT academy_id,id,'project',person_id,hub_id,NULL::uuid,NULL::uuid,NULL::jsonb FROM public.payroll_project_accruals
 UNION ALL SELECT academy_id,id,'hourly',person_id,NULL::uuid,NULL::uuid,NULL::uuid,earning_plan->'sourceAllocations' FROM public.payroll_hourly_accruals
 UNION ALL SELECT x.academy_id,x.id,'tuition_course',x.person_id,x.hub_id,i.class_id,i.student_id,NULL::jsonb FROM public.payroll_tuition_course_accruals x JOIN public.tuition_invoices i ON i.academy_id=x.academy_id AND i.id=x.invoice_id
 UNION ALL SELECT x.academy_id,x.id,'tuition_session',x.person_id,x.hub_id,i.class_id,i.student_id,NULL::jsonb FROM public.payroll_tuition_session_accruals x JOIN public.tuition_invoices i ON i.academy_id=x.academy_id AND i.id=x.invoice_id
 UNION ALL SELECT x.academy_id,x.journal_id,'tuition_collection',x.person_id,x.hub_id,i.class_id,i.student_id,NULL::jsonb FROM public.payroll_tuition_collection_accruals x JOIN public.tuition_invoices i ON i.academy_id=x.academy_id AND i.id=x.invoice_id WHERE x.journal_id IS NOT NULL
 UNION ALL SELECT p.academy_id,p.journal_id,'employer_contribution',g.person_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::jsonb FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id WHERE p.journal_id IS NOT NULL;
GRANT SELECT ON public.payroll_cost_attribution_origins TO kavosh_runtime;
CREATE TABLE public.payroll_cost_attributions(
 academy_id uuid NOT NULL,journal_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,journal_id),FOREIGN KEY(academy_id,journal_id) REFERENCES public.finance_journals(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE TABLE public.payroll_cost_attribution_revisions(
 academy_id uuid NOT NULL,journal_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),input jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=262144),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,journal_id,version),FOREIGN KEY(academy_id,journal_id) REFERENCES public.payroll_cost_attributions(academy_id,journal_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.payroll_cost_attributions ADD CONSTRAINT payroll_cost_attribution_current FOREIGN KEY(academy_id,journal_id,version) REFERENCES public.payroll_cost_attribution_revisions(academy_id,journal_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payroll_cost_attributions','payroll_cost_attribution_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER payroll_cost_attribution_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,journal_id,version,created_by),UPDATE(version) ON public.payroll_cost_attributions TO kavosh_runtime;
GRANT INSERT(academy_id,journal_id,version,input,source_snapshot,changed_by,approval_id) ON public.payroll_cost_attribution_revisions TO kavosh_runtime;
CREATE TRIGGER payroll_cost_attribution_header BEFORE INSERT OR UPDATE ON public.payroll_cost_attributions FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.payroll_cost_attribution_source(i jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;j record;o record;l record;v integer;expected_action text;accounts jsonb;scope_hubs jsonb;targets jsonb;parts jsonb;rows jsonb:='[]';BEGIN
 IF NOT public.manual_journal_attribution_input_valid(i) THEN RETURN jsonb_build_object('unavailable','PAYROLL_ATTRIBUTION_INPUT_INVALID');END IF;
 SELECT h.*,p.action,p.status,p.scope INTO j FROM public.finance_journals h JOIN public.approval_requests p ON p.academy_id=h.academy_id AND p.id=h.approval_id WHERE h.academy_id=tenant AND h.id=(i->>'journalId')::uuid;
 IF j.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO o FROM public.payroll_cost_attribution_origins WHERE academy_id=tenant AND journal_id=j.id;
 expected_action=CASE o.kind WHEN 'manual_bonus' THEN 'work.adjustment.record' WHEN 'salary' THEN 'work.salary.record' WHEN 'project' THEN 'work.project.record' WHEN 'hourly' THEN 'work.hourly.record' WHEN 'tuition_course' THEN 'work.tuition_course.record' WHEN 'tuition_session' THEN 'work.tuition_session.record' WHEN 'tuition_collection' THEN 'work.tuition_collection.record' WHEN 'employer_contribution' THEN 'work.payrun-posting.post' END;
 IF o.journal_id IS NULL OR j.reverses_id IS NOT NULL OR j.purpose<>'activity' OR j.status<>'applied' OR j.action IS DISTINCT FROM expected_action THEN RETURN jsonb_build_object('unavailable','POSTED_PAYROLL_COST_SOURCE_REQUIRED');END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':'||j.id::text,35));
 SELECT version INTO v FROM public.payroll_cost_attributions WHERE academy_id=tenant AND journal_id=j.id;
 IF EXISTS(SELECT 1 FROM public.finance_journals r WHERE r.academy_id=tenant AND r.reverses_id=j.id) THEN RETURN jsonb_build_object('unavailable','REVERSED_PAYROLL_ATTRIBUTION_SOURCE');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(i->'lines') x WHERE NOT EXISTS(SELECT 1 FROM public.finance_journal_lines entry JOIN public.finance_account_revisions r ON r.academy_id=entry.academy_id AND r.account_id=entry.account_id AND r.version=entry.account_version WHERE entry.academy_id=tenant AND entry.journal_id=j.id AND entry.line_number=(x->>'lineNumber')::integer AND r.kind='expense' AND entry.side='debit')) THEN RETURN jsonb_build_object('unavailable','PAYROLL_ATTRIBUTION_LINE_NOT_COST');END IF;
 SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id,a.version) INTO accounts FROM(
  SELECT DISTINCT h.id,r.version,h.hub_id AS "hubId",r.kind,h.currency_id AS "currencyId",h.currency_version AS "currencyVersion",u.unit_scale AS "unitScale" FROM public.finance_journal_lines entry JOIN public.finance_accounts h ON h.academy_id=entry.academy_id AND h.id=entry.account_id JOIN public.finance_account_revisions r ON r.academy_id=entry.academy_id AND r.account_id=entry.account_id AND r.version=entry.account_version JOIN public.finance_currency_revisions u ON u.academy_id=h.academy_id AND u.currency_id=h.currency_id AND u.version=h.currency_version WHERE entry.academy_id=tenant AND entry.journal_id=j.id) a;
 SELECT coalesce(jsonb_agg(DISTINCT h ORDER BY h),'[]'::jsonb) INTO scope_hubs FROM(
  SELECT value h FROM jsonb_array_elements(coalesce(j.scope->'hubs','[]')) UNION SELECT value->'hubId' FROM jsonb_array_elements(coalesce(j.scope->'people','[]')||coalesce(j.scope->'classes','[]')||coalesce(j.scope->'workContexts','[]'))
  UNION SELECT j.scope#>'{workContext,hubId}' WHERE j.scope ? 'workContext' UNION SELECT 'null'::jsonb WHERE j.scope->'all'='true'::jsonb) hubs;
 FOR l IN SELECT x.*,r.kind,h.hub_id,h.currency_id,h.currency_version,u.unit_scale FROM public.finance_journal_lines x JOIN public.finance_accounts h ON h.academy_id=x.academy_id AND h.id=x.account_id JOIN public.finance_account_revisions r ON r.academy_id=x.academy_id AND r.account_id=x.account_id AND r.version=x.account_version JOIN public.finance_currency_revisions u ON u.academy_id=h.academy_id AND u.currency_id=h.currency_id AND u.version=h.currency_version WHERE x.academy_id=tenant AND x.journal_id=j.id AND r.kind='expense' AND x.side='debit' ORDER BY x.line_number LOOP
  SELECT x->'targets' INTO targets FROM jsonb_array_elements(i->'lines') x WHERE(x->>'lineNumber')::integer=l.line_number;
  IF targets IS NULL AND o.kind='hourly' THEN
   SELECT jsonb_agg(jsonb_build_object('hubId',hub,'classId',class,'studentId',NULL,'weight',1,'amountMinor',amount::text) ORDER BY hub,class) INTO parts FROM(
    SELECT(p->>'hubId')::uuid hub,(p->>'classId')::uuid class,sum((p#>>'{gross,minor}')::numeric) amount FROM jsonb_array_elements(o.hourly_allocations) p GROUP BY p->>'hubId',p->>'classId') a;
  ELSE
   targets=coalesce(targets,jsonb_build_array(jsonb_build_object('hubId',CASE WHEN o.kind='employer_contribution' THEN l.hub_id ELSE o.hub_id END,'classId',o.class_id,'studentId',o.student_id,'weight',1)));
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(targets) t WHERE(t->>'hubId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.hubs h WHERE h.academy_id=tenant AND h.id=(t->>'hubId')::uuid)) OR(t->>'classId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.classes c WHERE c.academy_id=tenant AND c.id=(t->>'classId')::uuid AND c.hub_id=(t->>'hubId')::uuid)) OR(t->>'studentId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.student_profiles p WHERE p.academy_id=tenant AND p.person_id=(t->>'studentId')::uuid))) THEN RETURN jsonb_build_object('unavailable','PAYROLL_ATTRIBUTION_TARGET_CHANGED');END IF;
   WITH picks AS(SELECT t,jsonb_build_array(t->>'hubId',t->>'classId',t->>'studentId')::text k,(t->>'weight')::numeric w FROM jsonb_array_elements(targets) t),shares AS(SELECT *,floor(l.amount_minor*w/sum(w) OVER()) base,mod(l.amount_minor*w,sum(w) OVER()) rem FROM picks),ranked AS(SELECT *,row_number() OVER(ORDER BY rem DESC,k COLLATE "C") rn,l.amount_minor-sum(base) OVER() residual FROM shares)
   SELECT jsonb_agg(t||jsonb_build_object('amountMinor',(base+CASE WHEN rn<=residual THEN 1 ELSE 0 END)::text) ORDER BY k COLLATE "C") INTO parts FROM ranked;
  END IF;
  IF parts IS NULL OR(SELECT sum((p->>'amountMinor')::numeric) FROM jsonb_array_elements(parts) p) IS DISTINCT FROM l.amount_minor THEN RETURN jsonb_build_object('unavailable','PAYROLL_ATTRIBUTION_ORIGINAL_ALLOCATION_INVALID');END IF;
  rows=rows||jsonb_build_array(jsonb_build_object('lineNumber',l.line_number,'accountId',l.account_id,'accountVersion',l.account_version,'originalAccountHubId',l.hub_id,'currencyId',l.currency_id,'currencyVersion',l.currency_version,'unitScale',l.unit_scale,'amountMinor',l.amount_minor::text,'targets',parts));
 END LOOP;
 IF jsonb_array_length(rows)=0 THEN RETURN jsonb_build_object('unavailable','JOURNAL_HAS_NO_PAYROLL_COST_LINES');END IF;
 RETURN jsonb_build_object('before',jsonb_build_object('version',coalesce(v,0)),'journalId',j.id,'sourceKind',o.kind,'personId',o.person_id,'postedOn',j.posted_on::text,'originalApprovalId',j.approval_id,'sourceHubs',scope_hubs,'accounts',accounts,'allocationPolicy','largest_remainder_original_cost_minor_units_original_hourly_splits_when_omitted','lines',rows);
END $$;
CREATE FUNCTION public.payroll_cost_attribution_scope(s jsonb,previous jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN bool_or(h IS NULL) THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) ELSE jsonb_build_object('all',false,'hubs',jsonb_agg(h ORDER BY h)) END FROM(
 SELECT(value#>>'{}')::uuid h FROM jsonb_array_elements(s->'sourceHubs') UNION SELECT(a->>'hubId')::uuid FROM jsonb_array_elements(s->'accounts') a
 UNION SELECT(t->>'hubId')::uuid FROM jsonb_array_elements(s->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'targets') t
 UNION SELECT(t->>'hubId')::uuid FROM jsonb_array_elements(previous->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'targets') t) hubs
$$;
CREATE FUNCTION public.payroll_cost_attribution_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;h record;s jsonb;previous jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYROLL_ATTRIBUTION_REVISION_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT public.manual_journal_attribution_input_valid(NEW.input) THEN RAISE EXCEPTION 'PAYROLL_ATTRIBUTION_INPUT_INVALID' USING ERRCODE='23514';END IF;
 s=public.payroll_cost_attribution_source(NEW.input);SELECT * INTO h FROM public.payroll_cost_attributions WHERE academy_id=NEW.academy_id AND journal_id=NEW.journal_id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 SELECT source_snapshot INTO previous FROM public.payroll_cost_attribution_revisions WHERE academy_id=NEW.academy_id AND journal_id=NEW.journal_id AND version=NEW.version-1;
 IF s->>'personId'=NEW.changed_by::text AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'PAYROLL_ATTRIBUTION_BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 IF h.journal_id IS NULL OR h.version<>NEW.version OR(NEW.version=1 AND h.created_by<>NEW.changed_by) OR NEW.version<>(NEW.input->>'expectedVersion')::integer+1 OR NEW.version<>(SELECT count(*)+1 FROM public.payroll_cost_attribution_revisions WHERE academy_id=NEW.academy_id AND journal_id=NEW.journal_id)
 OR s IS NULL OR s ? 'unavailable' OR s->>'journalId' IS DISTINCT FROM NEW.journal_id::text OR NEW.source_snapshot-'before' IS DISTINCT FROM s-'before' OR NEW.source_snapshot#>>'{before,version}' IS DISTINCT FROM NEW.input->>'expectedVersion'
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.cost-attribution.replace' OR p.target_id IS DISTINCT FROM NEW.journal_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'payroll-cost-attribution.view' OR p.scope IS DISTINCT FROM public.payroll_cost_attribution_scope(s,previous) OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM NEW.source_snapshot OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'PAYROLL_ATTRIBUTION_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payroll_cost_attribution_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_cost_attribution_revisions FOR EACH ROW EXECUTE FUNCTION public.payroll_cost_attribution_guard();
CREATE CONSTRAINT TRIGGER payroll_cost_attribution_reviewed AFTER INSERT ON public.payroll_cost_attribution_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.payroll_cost_attribution_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;BEGIN
 s=public.payroll_cost_attribution_source(NEW.input);
 IF s IS NULL OR s-'before' IS DISTINCT FROM NEW.source_snapshot-'before' THEN RAISE EXCEPTION 'PAYROLL_ATTRIBUTION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.journal_id AND e.actor_id=NEW.changed_by AND e.action='work.cost-attribution.replaced' AND e.created_at=transaction_timestamp() AND e.changes=jsonb_build_object('severity','critical','approvalId',NEW.approval_id,'afterVersion',NEW.version,'accountingPosted',false,'payrollRecalculated',false)) THEN RAISE EXCEPTION 'PAYROLL_ATTRIBUTION_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_cost_attribution_complete AFTER INSERT ON public.payroll_cost_attribution_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_cost_attribution_complete();
CREATE FUNCTION public.payroll_cost_attribution_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.cost-attribution.replace' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.payroll_cost_attribution_revisions r WHERE r.academy_id=NEW.academy_id AND r.journal_id=NEW.target_id AND r.version=NEW.target_version+1 AND r.approval_id=NEW.id AND r.changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PAYROLL_ATTRIBUTION_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_cost_attribution_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_cost_attribution_effect();
-- One single-level source-binding bundle keeps the existing64binding limit.
-- The original guarded approval is immutable;only its resource proofs are
-- copied,not private notes,terms,tax data or a creator's role grants.
DO $$ DECLARE body text;needle text:='ELSIF b ? ''expenseCostPeople'' THEN';BEGIN
 body=pg_get_functiondef('public.approval_bindings_allow(jsonb,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PAYROLL_ATTRIBUTION_PRIVACY_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'ELSIF b ? ''payrollCostSourceBindings'' THEN
  IF b->>''capability'' IS DISTINCT FROM ''payroll-cost-attribution.view'' OR jsonb_typeof(b->''payrollCostSourceBindings'') IS DISTINCT FROM ''array'' THEN RETURN false;END IF;
  IF jsonb_array_length(b->''payrollCostSourceBindings'') NOT BETWEEN 1 AND 64 OR EXISTS(SELECT 1 FROM jsonb_array_elements(b->''payrollCostSourceBindings'') nested WHERE nested ? ''payrollCostSourceBindings'') THEN RETURN false;END IF;
  IF public.approval_bindings_allow(b->''payrollCostSourceBindings'',p_scopes) IS NOT TRUE THEN RETURN false;END IF;
  '||needle);
END $$;
CREATE FUNCTION public.payroll_cost_attribution_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;original jsonb;prior jsonb;t jsonb;hubs uuid[];classes jsonb:='[]';people jsonb:='[]';cap text;BEGIN
 s=NEW.review_context;
 SELECT p.privacy_bindings INTO original FROM public.finance_journals j JOIN public.approval_requests p ON p.academy_id=j.academy_id AND p.id=j.approval_id WHERE j.academy_id=NEW.academy_id AND j.id=NEW.target_id AND p.id=(s->>'originalApprovalId')::uuid;
 IF original IS NULL OR jsonb_array_length(original)=0 THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','payroll-cost-attribution.view','payrollCostSourceBindings',original));
 SELECT source_snapshot INTO prior FROM public.payroll_cost_attribution_revisions r JOIN public.payroll_cost_attributions a ON a.academy_id=r.academy_id AND a.journal_id=r.journal_id AND a.version=r.version WHERE r.academy_id=NEW.academy_id AND r.journal_id=NEW.target_id;
 FOREACH cap IN ARRAY ARRAY['accounts.view','ledger.view','financial-reports.view'] LOOP
  SELECT array_agg((a->>'hubId')::uuid) INTO hubs FROM jsonb_array_elements(s->'accounts') a;NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding(cap,hubs));
 END LOOP;
 -- The financial report's worker scope is separate from its account scope.
 SELECT scope INTO original FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=(s->>'originalApprovalId')::uuid;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','financial-reports.view','scope',original));
 hubs=NULL;
 FOR t IN SELECT target FROM jsonb_array_elements(s->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'targets') target UNION SELECT target FROM jsonb_array_elements(prior->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'targets') target LOOP
  hubs=array_append(hubs,(t->>'hubId')::uuid);IF t->>'classId' IS NOT NULL THEN classes=classes||jsonb_build_array(jsonb_build_object('id',t->>'classId','hubId',t->>'hubId'));END IF;IF t->>'studentId' IS NOT NULL THEN people=people||jsonb_build_array(t->'studentId');END IF;
 END LOOP;
 IF hubs IS NOT NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('payroll-cost-attribution.view',hubs));END IF;
 IF jsonb_array_length(classes)>0 THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','classes.view','scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',(SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(classes)))));END IF;
 IF jsonb_array_length(people)>0 THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','students.view','expenseCostPeople',(SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(people))));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;
END $$;
CREATE TRIGGER zz_payroll_cost_attribution_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.cost-attribution.replace') EXECUTE FUNCTION public.payroll_cost_attribution_privacy();
REVOKE ALL ON FUNCTION public.payroll_cost_attribution_source(jsonb),public.payroll_cost_attribution_scope(jsonb,jsonb),public.payroll_cost_attribution_guard(),public.payroll_cost_attribution_complete(),public.payroll_cost_attribution_effect(),public.payroll_cost_attribution_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_cost_attribution_source(jsonb),public.payroll_cost_attribution_scope(jsonb,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 253 $$;

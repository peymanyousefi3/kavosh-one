-- Reviewed manual statements do not post another expense or execute payment.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payrun-net.view','View private reviewed net-pay statements','Finance',true,ARRAY['hub','person','country','region','city']),
 ('payrun-net.edit','Propose reviewed net-pay statements and withdrawals','Finance',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.payrun_net_statements(
 academy_id uuid NOT NULL,run_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,run_id),FOREIGN KEY(academy_id,run_id) REFERENCES public.payrun_groups(academy_id,id)
);
CREATE TABLE public.payrun_net_revisions(
 academy_id uuid NOT NULL,run_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('prepared','withdrawn')),definition jsonb NOT NULL,amounts jsonb NOT NULL,source_snapshot jsonb NOT NULL,
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,run_id,version),FOREIGN KEY(academy_id,run_id) REFERENCES public.payrun_net_statements(academy_id,run_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),UNIQUE(academy_id,approval_id)
);
ALTER TABLE public.payrun_net_statements ADD CONSTRAINT payrun_net_current_revision FOREIGN KEY(academy_id,run_id,version) REFERENCES public.payrun_net_revisions(academy_id,run_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER payrun_net_header BEFORE INSERT OR UPDATE ON public.payrun_net_statements FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payrun_net_statements','payrun_net_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER payrun_net_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,run_id),UPDATE(version) ON public.payrun_net_statements TO kavosh_runtime;
GRANT INSERT(academy_id,run_id,version,state,definition,source_snapshot,changed_by,approval_id,reason) ON public.payrun_net_revisions TO kavosh_runtime;
CREATE FUNCTION public.payrun_net_amounts(d jsonb,gross numeric,scale integer) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE side text;line jsonb;k text;keys text[];codes text[];v numeric;employee numeric:=0;employer numeric:=0;BEGIN
 IF scale IS NULL OR scale NOT BETWEEN 0 AND 18 OR gross IS NULL OR gross::text!~'^[0-9]+([.]0+)?$' OR gross<>trunc(gross) OR jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& ARRAY['calculationBasis','employeeDeductions','employerContributions','taxReview']) OR d-ARRAY['calculationBasis','employeeDeductions','employerContributions','taxReview']<>'{}'::jsonb OR d->>'calculationBasis' IS DISTINCT FROM 'manual_reviewed' OR jsonb_typeof(d->'taxReview') IS DISTINCT FROM 'string' OR length(btrim(d->>'taxReview')) NOT BETWEEN 1 AND 2000 OR d->>'taxReview'~'[[:cntrl:]]' OR octet_length(d::text)>65536 THEN RETURN NULL;END IF;
 FOREACH side IN ARRAY ARRAY['employeeDeductions','employerContributions'] LOOP
  IF jsonb_typeof(d->side) IS DISTINCT FROM 'array' OR jsonb_array_length(d->side)>100 THEN RETURN NULL;END IF;codes='{}';
  keys=ARRAY['code','label','amount']||CASE WHEN side='employeeDeductions' THEN ARRAY['authorityKind','authorityReference'] ELSE ARRAY['obligationReference'] END;
  FOR line IN SELECT * FROM jsonb_array_elements(d->side) LOOP
   IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR NOT(line ?& keys) OR line-keys<>'{}'::jsonb THEN RETURN NULL;END IF;
   FOREACH k IN ARRAY keys LOOP IF jsonb_typeof(line->k) IS DISTINCT FROM 'string' OR line->>k~'[[:cntrl:]]' THEN RETURN NULL;END IF;END LOOP;
   IF line->>'code'!~'^[A-Z0-9][A-Z0-9._-]{0,31}$' OR line->>'code'=ANY(codes) OR length(btrim(line->>'label')) NOT BETWEEN 1 AND 150 OR length(line->>'amount')>80 OR line->>'amount'!~'^[0-9]+([.][0-9]+)?$' THEN RETURN NULL;END IF;
   codes=array_append(codes,line->>'code');
   IF side='employeeDeductions' THEN IF line->>'authorityKind' NOT IN('statute','court_order','written_authorization') OR length(btrim(line->>'authorityReference')) NOT BETWEEN 1 AND 1000 THEN RETURN NULL;END IF;
   ELSE IF length(btrim(line->>'obligationReference')) NOT BETWEEN 1 AND 1000 THEN RETURN NULL;END IF;END IF;
   v=(line->>'amount')::numeric*power(10::numeric,scale);IF v<>trunc(v) OR v>power(10::numeric,38)-1 THEN RETURN NULL;END IF;
   IF side='employeeDeductions' THEN employee=employee+v;ELSE employer=employer+v;END IF;
  END LOOP;
 END LOOP;
 IF employee>gross THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('grossMinor',trunc(gross)::text,'employeeDeductionMinor',trunc(employee)::text,'employerContributionMinor',trunc(employer)::text,'netMinor',trunc(gross-employee)::text,'employerCostMinor',trunc(gross+employer)::text);
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
CREATE FUNCTION public.payrun_net_source(p_run uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record;current_sources boolean;BEGIN
 SELECT * INTO r FROM public.payrun_groups WHERE id=p_run AND academy_id=nullif(current_setting('app.academy_id',true),'')::uuid;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM public.lock_hourly_worker(r.person_id);SELECT * INTO r FROM public.payrun_groups WHERE id=p_run AND academy_id=r.academy_id;
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.source_snapshot->'items') v LEFT JOIN public.payrun_earning_catalogue c ON c.kind=v->>'kind' AND c.source_id=(v->>'sourceId')::uuid AND c.allocation_id=(v->>'allocationId')::uuid
 WHERE(c.void_id IS NULL AND c.person_id::text=v->>'personId' AND c.hub_id::text IS NOT DISTINCT FROM v->>'hubId' AND c.currency_id::text=v->>'currencyId' AND c.unit_scale=(v->>'unitScale')::integer AND c.amount_minor=(v->>'minor')::numeric AND c.posted_on=(v->>'postedOn')::date AND c.due_on=(v->>'dueOn')::date AND c.from_on=(v->>'from')::date AND c.through_on=(v->>'through')::date) IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM public.payrun_earning_claims q WHERE q.academy_id=r.academy_id AND q.run_id=r.id AND q.kind=v->>'kind' AND q.source_id=(v->>'sourceId')::uuid AND q.allocation_id=(v->>'allocationId')::uuid AND q.released_by IS NULL)) INTO current_sources;
 RETURN jsonb_build_object('runId',r.id,'personId',r.person_id,'currencyId',r.currency_id,'unitScale',r.unit_scale,'grossMinor',trunc(r.gross_minor)::text,'scope',r.scope,'cancellationId',r.cancellation_id,'recordedSourcesCurrent',current_sources,'runSourceSha256',encode(sha256(convert_to(r.source_snapshot::text,'UTF8')),'hex'));
END $$;
CREATE FUNCTION public.payrun_net_basis(p_run uuid,p_before integer) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;b jsonb;BEGIN
 s=public.payrun_net_source(p_run);IF s IS NULL THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('version',version,'state',state,'definition',definition,'amounts',amounts) INTO b FROM public.payrun_net_revisions WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND run_id=p_run AND version=p_before;
 RETURN jsonb_build_object('source',s,'before',b);
END $$;
CREATE FUNCTION public.guard_payrun_net_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;b jsonb;a jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYRUN_NET_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.payrun_net_statements WHERE academy_id=NEW.academy_id AND run_id=NEW.run_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 b=public.payrun_net_basis(NEW.run_id,NEW.version-1);a=public.payrun_net_amounts(NEW.definition,(b#>>'{source,grossMinor}')::numeric,(b#>>'{source,unitScale}')::integer);
 IF h.version IS DISTINCT FROM NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.payrun_net_revisions WHERE academy_id=NEW.academy_id AND run_id=NEW.run_id) OR a IS NULL OR b IS NULL OR(NEW.version=1 AND NEW.state<>'prepared') OR(NEW.version>1 AND b->'before'='null'::jsonb)
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.payrun-net.change' OR p.target_id IS DISTINCT FROM NEW.run_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'payrun-net.view' OR p.scope IS DISTINCT FROM b#>'{source,scope}' OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b
 OR p.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'state',NEW.state,'definition',NEW.definition,'reason',NEW.reason) OR NOT public.report_comment_human_verified(NEW.changed_by)
 OR(NEW.state='prepared' AND(b#>'{source,cancellationId}'<>'null'::jsonb OR b#>'{source,recordedSourcesCurrent}' IS DISTINCT FROM 'true'::jsonb)) THEN RAISE EXCEPTION 'PAYRUN_NET_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by::text=b#>>'{source,personId}' AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.amounts=a;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payrun_net_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payrun_net_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_payrun_net_revision();
CREATE CONSTRAINT TRIGGER payrun_net_review_applied AFTER INSERT ON public.payrun_net_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.payrun_net_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.payrun_net_basis(NEW.run_id,NEW.version-1) IS DISTINCT FROM NEW.source_snapshot THEN RAISE EXCEPTION 'PAYRUN_NET_SOURCES_CHANGED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.run_id AND a.actor_id=NEW.changed_by AND a.action='work.payrun-net.change' AND a.created_at=transaction_timestamp() AND a.changes->'version'=to_jsonb(NEW.version) AND a.changes->>'approvalId'=NEW.approval_id::text AND a.changes->>'state'=NEW.state AND a.changes->'severity'='"critical"'::jsonb AND a.changes->'paymentExecuted'='false'::jsonb AND a.changes->'additionalLedgerPosting'='false'::jsonb) THEN RAISE EXCEPTION 'PAYRUN_NET_AUDIT_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payrun_net_sources_complete AFTER INSERT ON public.payrun_net_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payrun_net_complete();
CREATE FUNCTION public.payrun_net_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.payrun-net.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.payrun_net_revisions r WHERE r.academy_id=NEW.academy_id AND r.run_id=NEW.target_id AND r.version=NEW.target_version+1 AND r.approval_id=NEW.id AND r.changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PAYRUN_NET_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payrun_net_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payrun_net_effect_required();
-- Source privacy is re-evaluated dynamically,including newly hidden hourly
-- engagements;retained approval payloads must not outlive source authority.
CREATE FUNCTION public.payrun_net_source_allows(p_run uuid,cap text,s jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE r record;v jsonb;h record;BEGIN
 IF cap NOT IN('work-pay.view','payroll-accruals.view','payroll-adjustments.view') OR NOT public.approval_scope_nonempty(s) THEN RETURN false;END IF;
 SELECT * INTO r FROM public.payrun_groups WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_run;IF NOT FOUND THEN RETURN false;END IF;
 FOR v IN SELECT * FROM jsonb_array_elements(r.source_snapshot->'items') LOOP
  IF cap='work-pay.view' OR(cap='payroll-adjustments.view')=(v->>'kind'='manual_bonus') THEN
   IF public.work_scope_allows(s,(v->>'hubId')::uuid,(v->>'personId')::uuid) IS NOT TRUE THEN RETURN false;END IF;
   IF v->>'kind'='hourly' THEN SELECT source_snapshot INTO h FROM public.payroll_hourly_accruals WHERE academy_id=r.academy_id AND id=(v->>'sourceId')::uuid;
    IF h.source_snapshot IS NULL OR public.payroll_preparation_allows(h.source_snapshot->'payroll',jsonb_build_array(s),'[{"all":true,"hubs":[]}]'::jsonb) IS NOT TRUE THEN RETURN false;END IF;
   END IF;
  END IF;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION public.payrun_net_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record;cap text;BEGIN
 SELECT * INTO r FROM public.payrun_groups WHERE academy_id=NEW.academy_id AND id=NEW.target_id;IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','payruns.view','scope',r.scope));
 FOREACH cap IN ARRAY ARRAY['work-pay.view','payroll-accruals.view','payroll-adjustments.view'] LOOP
  IF cap='work-pay.view' OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.source_snapshot->'items') v WHERE(cap='payroll-adjustments.view')=(v->>'kind'='manual_bonus')) THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'payrunNetSource',r.id));END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER zz_payrun_net_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.payrun-net.change') EXECUTE FUNCTION public.payrun_net_privacy();
-- Preserve the existing validator OID,owner and ACLs used by all readers.
DO $$ DECLARE body text;needle text:='  ELSIF b ? ''personId'' THEN';BEGIN
 SELECT pg_get_functiondef('public.approval_bindings_allow(jsonb,jsonb)'::regprocedure) INTO body;
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'APPROVAL_BINDING_EXTENSION_POINT_MISSING';END IF;
 EXECUTE replace(body,needle,'  ELSIF b ? ''payrunNetSource'' THEN
   IF public.payrun_net_source_allows((b->>''payrunNetSource'')::uuid,b->>''capability'',p_scopes->(b->>''capability'')) IS NOT TRUE THEN RETURN false;END IF;
'||needle);
END $$;
REVOKE ALL ON FUNCTION public.payrun_net_amounts(jsonb,numeric,integer),public.payrun_net_source(uuid),public.payrun_net_basis(uuid,integer),public.guard_payrun_net_revision(),public.payrun_net_complete(),public.payrun_net_effect_required(),public.payrun_net_source_allows(uuid,text,jsonb),public.payrun_net_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payrun_net_amounts(jsonb,numeric,integer),public.payrun_net_source(uuid),public.payrun_net_basis(uuid,integer),public.payrun_net_source_allows(uuid,text,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 149 $$;

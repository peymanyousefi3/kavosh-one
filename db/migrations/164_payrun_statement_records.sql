-- Retained, human-reviewed statement content. No PDF delivery, payment,
-- statutory calculation or legal certification is performed by this layer.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('paystatements.view','View private payroll statement records','Finance',true,ARRAY['hub','person','country','region','city']),
 ('paystatements.edit','Request reviewed payroll statement records and withdrawals','Finance',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.payrun_statement_records(
 academy_id uuid NOT NULL,posting_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,posting_id),FOREIGN KEY(academy_id,posting_id) REFERENCES public.payrun_net_postings(academy_id,id)
);
CREATE TABLE public.payrun_statement_revisions(
 academy_id uuid NOT NULL,posting_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('recorded','withdrawn')),input jsonb NOT NULL CHECK(octet_length(input::text)<=131072),source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=524288),content jsonb NOT NULL CHECK(octet_length(content::text)<=262144),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,posting_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,posting_id) REFERENCES public.payrun_statement_records(academy_id,posting_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.payrun_statement_records ADD CONSTRAINT pay_statement_current_revision FOREIGN KEY(academy_id,posting_id,version) REFERENCES public.payrun_statement_revisions(academy_id,posting_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER pay_statement_header BEFORE INSERT OR UPDATE ON public.payrun_statement_records FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payrun_statement_records','payrun_statement_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER pay_statement_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,posting_id),UPDATE(version) ON public.payrun_statement_records TO kavosh_runtime;
GRANT INSERT(academy_id,posting_id,version,input,source_snapshot,changed_by,approval_id) ON public.payrun_statement_revisions TO kavosh_runtime;

CREATE FUNCTION public.pay_statement_source(p_posting uuid,p_before integer) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;r record;n record;s jsonb;b jsonb;names jsonb;employer jsonb;ctx jsonb;BEGIN
 SELECT * INTO p FROM public.payrun_net_postings WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_posting;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO r FROM public.payrun_groups WHERE academy_id=p.academy_id AND id=p.run_id;PERFORM public.lock_hourly_worker(r.person_id);
 SELECT * INTO p FROM public.payrun_net_postings WHERE academy_id=r.academy_id AND id=p_posting;
 s=public.payrun_net_source(r.id);ctx=r.source_snapshot->'contexts'->0;
 SELECT * INTO n FROM public.payrun_net_revisions WHERE academy_id=r.academy_id AND run_id=r.id AND version=p.net_version;
 SELECT jsonb_build_object('version',version,'state',state,'contentSha256',encode(sha256(convert_to(content::text,'UTF8')),'hex')) INTO b FROM public.payrun_statement_revisions WHERE academy_id=r.academy_id AND posting_id=p_posting AND version=p_before;
 SELECT coalesce(jsonb_agg(DISTINCT e.definition->>'legalWorkerName' ORDER BY e.definition->>'legalWorkerName'),'[]'::jsonb) INTO names FROM jsonb_array_elements(r.source_snapshot->'terms') t JOIN public.work_engagement_revisions e ON e.academy_id=r.academy_id AND e.engagement_id=(t->>'engagementId')::uuid AND e.version=(t->>'version')::integer;
 SELECT jsonb_build_object('id',payee_id,'version',version,'legalName',legal_name) INTO employer FROM public.financial_payee_revisions WHERE academy_id=r.academy_id AND payee_id=(ctx->>'employerId')::uuid AND version=(ctx->>'employerVersion')::integer;
 RETURN jsonb_build_object('posting',jsonb_build_object('id',p.id,'runId',p.run_id,'netVersion',p.net_version,'postedOn',p.input->>'postedOn','reversalId',p.reversal_id,'planSha256',encode(sha256(convert_to(p.plan::text,'UTF8')),'hex')),
 'accounts',p.plan->'accounts','scope',r.scope,'personId',r.person_id,'currencyId',r.currency_id,'currencyCode',(SELECT code FROM public.finance_currencies WHERE academy_id=r.academy_id AND id=r.currency_id),'unitScale',r.unit_scale,'reference',r.reference,'serviceFrom',r.service_from::text,'serviceThrough',r.service_through::text,'plannedPayOn',r.planned_pay_on::text,
 'amounts',p.plan#>'{net,amounts}','employeeDeductions',(SELECT coalesce(jsonb_agg(jsonb_build_object('code',v->>'code','label',v->>'label','amount',v->>'amount') ORDER BY v->>'code'),'[]'::jsonb) FROM jsonb_array_elements(n.definition->'employeeDeductions') v),
 'employerContributions',(SELECT coalesce(jsonb_agg(jsonb_build_object('code',v->>'code','label',v->>'label','amount',v->>'amount') ORDER BY v->>'code'),'[]'::jsonb) FROM jsonb_array_elements(n.definition->'employerContributions') v),
 'earnings',r.source_snapshot->'items','workerNames',names,'employer',employer,'legalContext',ctx,'sourceCurrent',s->'recordedSourcesCurrent','runCancelled',r.cancellation_id IS NOT NULL,'runSourceSha256',s->'runSourceSha256','before',b);
END $$;
CREATE FUNCTION public.pay_statement_input_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE d jsonb;e jsonb;k text;v jsonb;stamp date;BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& ARRAY['expectedVersion','definition','reason']) OR i-ARRAY['expectedVersion','definition','reason']<>'{}'::jsonb OR octet_length(i::text)>131072 OR jsonb_typeof(i->'expectedVersion') IS DISTINCT FROM 'number' OR i->>'expectedVersion'!~'^(0|[1-9][0-9]*)$' OR(i->>'expectedVersion')::numeric>2147483646 OR jsonb_typeof(i->'reason') IS DISTINCT FROM 'string' OR length(btrim(i->>'reason')) NOT BETWEEN 1 AND 2000 OR i->>'reason'~'[[:cntrl:]]' THEN RETURN false;END IF;
 d=i->'definition';IF d='null'::jsonb THEN RETURN(i->>'expectedVersion')::integer>0;END IF;
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& ARRAY['statementOn','language','workerName','employerAddress','earnings','vacationPay','review']) OR d-ARRAY['statementOn','language','workerName','employerAddress','earnings','vacationPay','review']<>'{}'::jsonb OR d->>'language' IS NULL OR d->>'language' NOT IN('en','fr','zh-CN') THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['statementOn','workerName','review'] LOOP IF jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR length(btrim(d->>k)) NOT BETWEEN 1 AND (CASE WHEN k='review' THEN 2000 ELSE 200 END) OR d->>k~'[[:cntrl:]]' THEN RETURN false;END IF;END LOOP;
 IF d->>'statementOn'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;stamp=(d->>'statementOn')::date;IF stamp NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RETURN false;END IF;
 IF jsonb_typeof(d->'employerAddress') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'employerAddress') NOT BETWEEN 1 AND 6 OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'employerAddress') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR length(btrim(x#>>'{}')) NOT BETWEEN 1 AND 200 OR x#>>'{}'~'[[:cntrl:]]') THEN RETURN false;END IF;
 v=d->'vacationPay';IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['amount','explanation']) OR v-ARRAY['amount','explanation']<>'{}'::jsonb OR jsonb_typeof(v->'amount') IS DISTINCT FROM 'string' OR length(v->>'amount')>80 OR v->>'amount'!~'^[0-9]+([.][0-9]+)?$' OR jsonb_typeof(v->'explanation') IS DISTINCT FROM 'string' OR length(btrim(v->>'explanation')) NOT BETWEEN 1 AND 1000 OR v->>'explanation'~'[[:cntrl:]]' THEN RETURN false;END IF;
 IF jsonb_typeof(d->'earnings') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'earnings') NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;
 FOR e IN SELECT * FROM jsonb_array_elements(d->'earnings') LOOP
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR NOT(e ?& ARRAY['kind','sourceId','allocationId','label','calculation','rateDescription']) OR e-ARRAY['kind','sourceId','allocationId','label','calculation','rateDescription']<>'{}'::jsonb OR e->>'kind' IS NULL OR e->>'kind' NOT IN('hourly','salary','project','manual_bonus','tuition_course','tuition_session','tuition_collection') THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['sourceId','allocationId','label','calculation','rateDescription'] LOOP
   IF jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR length(btrim(e->>k)) NOT BETWEEN 1 AND (CASE WHEN k='calculation' THEN 1000 WHEN k='label' THEN 150 ELSE 300 END) OR e->>k~'[[:cntrl:]]' THEN RETURN false;END IF;
   IF k IN('sourceId','allocationId') AND(e->>k)::uuid::text IS DISTINCT FROM e->>k THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN jsonb_array_length(d->'earnings')=(SELECT count(DISTINCT jsonb_build_array(x.value->>'kind',x.value->>'sourceId',x.value->>'allocationId')) FROM jsonb_array_elements(d->'earnings') x);
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.pay_statement_content(s jsonb,d jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE scale integer;vacation numeric;earnings jsonb;BEGIN
 scale=(s->>'unitScale')::integer;
 IF s#>>'{posting,reversalId}' IS NOT NULL OR s->'sourceCurrent' IS DISTINCT FROM 'true'::jsonb OR s->'runCancelled' IS DISTINCT FROM 'false'::jsonb THEN RETURN jsonb_build_object('unavailable','PAY_STATEMENT_SOURCE_UNAVAILABLE');END IF;
 IF nullif(btrim(s#>>'{employer,legalName}'),'') IS NULL OR NOT(s->'workerNames' ? (d->>'workerName')) THEN RETURN jsonb_build_object('unavailable','PAY_STATEMENT_LEGAL_PARTIES_REQUIRED');END IF;
 IF(d->>'statementOn')::date<(s#>>'{posting,postedOn}')::date THEN RETURN jsonb_build_object('unavailable','PAY_STATEMENT_DATE_PRECEDES_POSTING');END IF;
 IF NOT public.work_money_valid(d#>'{vacationPay,amount}',scale) THEN RETURN jsonb_build_object('unavailable','PAY_STATEMENT_VACATION_PRECISION_INVALID');END IF;
 vacation=(d#>>'{vacationPay,amount}')::numeric*power(10::numeric,scale);IF vacation>(s#>>'{amounts,grossMinor}')::numeric THEN RETURN jsonb_build_object('unavailable','PAY_STATEMENT_VACATION_EXCEEDS_GROSS');END IF;
 IF jsonb_array_length(d->'earnings')<>jsonb_array_length(s->'earnings') OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'earnings') a WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'earnings') b WHERE b->>'kind'=a->>'kind' AND b->>'sourceId'=a->>'sourceId' AND b->>'allocationId'=a->>'allocationId')) THEN RETURN jsonb_build_object('unavailable','PAY_STATEMENT_COMPLETE_EARNINGS_REQUIRED');END IF;
 SELECT jsonb_agg(jsonb_build_object('kind',a->>'kind','sourceId',a->>'sourceId','allocationId',a->>'allocationId','hubId',a->'hubId','from',a->>'from','through',a->>'through','unitScale',(a->>'unitScale')::integer,'grossMinor',a->>'minor','offPeriodSource',a->'offPeriodSource','label',b->>'label','calculation',b->>'calculation','rateDescription',b->>'rateDescription') ORDER BY a->>'kind',a->>'sourceId',a->>'allocationId') INTO earnings FROM jsonb_array_elements(s->'earnings') a JOIN jsonb_array_elements(d->'earnings') b ON b->>'kind'=a->>'kind' AND b->>'sourceId'=a->>'sourceId' AND b->>'allocationId'=a->>'allocationId';
 RETURN jsonb_build_object('formatVersion',1,'statementOn',d->>'statementOn','language',d->>'language','reference',s->>'reference','serviceFrom',s->>'serviceFrom','serviceThrough',s->>'serviceThrough','plannedPayOn',s->>'plannedPayOn','personId',s->>'personId','workerName',d->>'workerName','employer',s->'employer'||jsonb_build_object('address',d->'employerAddress'),'legalContext',s->'legalContext','currencyId',s->>'currencyId','currencyCode',s->>'currencyCode','unitScale',scale,'amounts',s->'amounts','earnings',earnings,'employeeDeductions',s->'employeeDeductions','employerContributions',s->'employerContributions','vacationPay',jsonb_build_object('includedInGrossMinor',trunc(vacation)::text,'explanation',d#>>'{vacationPay,explanation}'),'calculationBasis','reviewed_manual_explanations_and_original_recorded_amounts','periodCompletenessVerified',false,'grossCalculationIndependentlyVerified',false,'statutoryRulesCalculated',false,'authorityDocumentsVerified',false,'vacationEntitlementCalculated',false,'paymentExecuted',false,'paymentDateVerified',false,'deliveryPerformed',false,'isOfficialPaystub',false);
END $$;
CREATE FUNCTION public.guard_pay_statement_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;p record;current_version integer;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAY_STATEMENT_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT public.pay_statement_input_valid(NEW.input) OR(NEW.input->>'expectedVersion')::integer<>NEW.version-1 THEN RAISE EXCEPTION 'PAY_STATEMENT_INPUT_INVALID' USING ERRCODE='23514';END IF;
 s=public.pay_statement_source(NEW.posting_id,NEW.version-1);SELECT version INTO current_version FROM public.payrun_statement_records WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s IS NULL OR current_version IS DISTINCT FROM NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.payrun_statement_revisions WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id) OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.payrun-statement.change' OR p.target_id IS DISTINCT FROM NEW.posting_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR p.scope IS DISTINCT FROM s->'scope' OR p.privacy_capability IS DISTINCT FROM 'paystatements.view' OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'PAY_STATEMENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by=(s->>'personId')::uuid AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 IF NEW.input->'definition'='null'::jsonb THEN
  IF s->'before'='null'::jsonb OR s#>>'{before,state}'<>'recorded' THEN RAISE EXCEPTION 'PAY_STATEMENT_WITHDRAWAL_UNAVAILABLE' USING ERRCODE='23514';END IF;
  NEW.state='withdrawn';SELECT content INTO NEW.content FROM public.payrun_statement_revisions WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id AND version=NEW.version-1;
 ELSE NEW.state='recorded';NEW.content=public.pay_statement_content(s,NEW.input->'definition');IF NEW.content ? 'unavailable' THEN RAISE EXCEPTION '%',NEW.content->>'unavailable' USING ERRCODE='23514';END IF;END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER pay_statement_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payrun_statement_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_pay_statement_revision();
CREATE CONSTRAINT TRIGGER pay_statement_review_applied AFTER INSERT ON public.payrun_statement_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.pay_statement_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.pay_statement_source(NEW.posting_id,NEW.version-1) IS DISTINCT FROM NEW.source_snapshot THEN RAISE EXCEPTION 'PAY_STATEMENT_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.posting_id AND a.actor_id=NEW.changed_by AND a.action='work.payrun-statement.change' AND a.created_at=transaction_timestamp() AND a.changes->'version'=to_jsonb(NEW.version) AND a.changes->>'approvalId'=NEW.approval_id::text AND a.changes->>'state'=NEW.state AND a.changes->'severity'='"critical"'::jsonb AND a.changes->'paymentExecuted'='false'::jsonb AND a.changes->'additionalLedgerPosting'='false'::jsonb) THEN RAISE EXCEPTION 'PAY_STATEMENT_AUDIT_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pay_statement_complete AFTER INSERT ON public.payrun_statement_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pay_statement_complete();
CREATE FUNCTION public.pay_statement_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.payrun-statement.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.payrun_statement_revisions r WHERE r.academy_id=NEW.academy_id AND r.posting_id=NEW.target_id AND r.version=NEW.target_version+1 AND r.approval_id=NEW.id AND r.changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PAY_STATEMENT_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pay_statement_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pay_statement_effect_required();
-- Reuse original posting source/account privacy,plus the posting reader grant.
CREATE TRIGGER zz_pay_statement_source_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.payrun-statement.change') EXECUTE FUNCTION public.payrun_posting_privacy();
CREATE FUNCTION public.pay_statement_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','payrun-postings.view','scope',NEW.scope));RETURN NEW;
END $$;
CREATE TRIGGER zzz_pay_statement_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.payrun-statement.change') EXECUTE FUNCTION public.pay_statement_privacy();
REVOKE ALL ON FUNCTION public.pay_statement_source(uuid,integer),public.pay_statement_input_valid(jsonb),public.pay_statement_content(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_statement_source(uuid,integer),public.pay_statement_input_valid(jsonb),public.pay_statement_content(jsonb,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 164 $$;

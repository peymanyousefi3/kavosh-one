-- Group existing gross liabilities; never post the expense a second time.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payruns.view','View private worker payrun groups','Finance',true,ARRAY['hub','person','country','region','city']),
 ('payruns.edit','Request reviewed payrun grouping and cancellation','Finance',true,ARRAY['hub','person','country','region','city']);
CREATE VIEW public.payrun_earning_catalogue WITH(security_invoker=true) AS
 SELECT x.academy_id,'manual_bonus'::text kind,x.id source_id,x.engagement_id allocation_id,x.person_id,x.hub_id,x.currency_id,x.unit_scale,x.amount_minor,x.posted_on,x.due_on,x.earned_on from_on,x.earned_on through_on,x.void_id,jsonb_build_array(x.terms_version) terms_versions,false legacy_date_review
 FROM public.payroll_adjustments x
 UNION ALL SELECT x.academy_id,'project',x.id,x.engagement_id,x.person_id,x.hub_id,x.currency_id,x.unit_scale,x.amount_minor,x.posted_on,x.due_on,x.delivered_on,x.delivered_on,x.void_id,jsonb_build_array(x.terms_version),false FROM public.payroll_project_accruals x
 UNION ALL SELECT x.academy_id,'tuition_course',x.id,x.engagement_id,x.person_id,x.hub_id,x.currency_id,x.unit_scale,x.amount_minor,x.posted_on,x.due_on,x.earned_on,x.earned_on,x.void_id,jsonb_build_array(x.terms_version),false FROM public.payroll_tuition_course_accruals x
 UNION ALL SELECT x.academy_id,'tuition_session',x.id,x.engagement_id,x.person_id,x.hub_id,x.currency_id,x.unit_scale,x.amount_minor,x.posted_on,x.due_on,x.earned_on,x.earned_on,x.void_id,jsonb_build_array(x.terms_version),false FROM public.payroll_tuition_session_accruals x
 UNION ALL SELECT x.academy_id,'tuition_collection',x.id,x.engagement_id,x.person_id,x.hub_id,x.currency_id,x.unit_scale,x.amount_minor,x.posted_on,x.due_on,x.earned_on,x.earned_on,x.void_id,jsonb_build_array(x.terms_version),false FROM public.payroll_tuition_collection_accruals x
 UNION ALL SELECT x.academy_id,'salary',x.id,x.engagement_id,x.person_id,x.hub_id,x.currency_id,x.unit_scale,x.amount_minor,x.posted_on,x.due_on,x.from_on,x.through_on,x.void_id,
 (SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT(d->>'termsVersion')::integer v FROM jsonb_array_elements(x.source_snapshot#>'{plan,days}') d) t),false FROM public.payroll_salary_accruals x
 UNION ALL SELECT x.academy_id,'hourly',x.id,(a->>'engagementId')::uuid,x.person_id,(w->>'hub_id')::uuid,x.currency_id,x.unit_scale,(a#>>'{gross,minor}')::numeric,x.posted_on,x.due_on,x.from_on,x.through_on,x.void_id,
 (SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT(d->>'termsVersion')::integer v FROM jsonb_array_elements(x.earning_plan->'sourceAllocations') d WHERE d->>'engagementId'=a->>'engagementId') t),x.release_date_policy=0
 FROM public.payroll_hourly_accruals x CROSS JOIN LATERAL jsonb_array_elements(x.earning_plan->'workAllocations') a CROSS JOIN LATERAL jsonb_array_elements(x.source_snapshot#>'{payroll,work}') w WHERE w->>'id'=a->>'engagementId';
GRANT SELECT ON public.payrun_earning_catalogue TO kavosh_runtime;

CREATE TABLE public.payrun_groups(
 academy_id uuid NOT NULL,id uuid NOT NULL,person_id uuid NOT NULL,currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),gross_minor numeric NOT NULL CHECK(gross_minor>=0 AND gross_minor=trunc(gross_minor)),
 reference text NOT NULL,service_from date NOT NULL,service_through date NOT NULL,planned_pay_on date NOT NULL,input jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=524288),scope jsonb NOT NULL,
 approval_id uuid NOT NULL,created_by uuid NOT NULL,cancellation_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,reference),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE TABLE public.payrun_group_cancellations(
 academy_id uuid NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,input jsonb NOT NULL,source_snapshot jsonb NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,run_id),UNIQUE(academy_id,id,run_id),FOREIGN KEY(academy_id,run_id) REFERENCES public.payrun_groups(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
ALTER TABLE public.payrun_groups ADD CONSTRAINT payrun_cancel_identity FOREIGN KEY(academy_id,cancellation_id,id) REFERENCES public.payrun_group_cancellations(academy_id,id,run_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.payrun_earning_claims(
 academy_id uuid NOT NULL,run_id uuid NOT NULL,kind text NOT NULL,source_id uuid NOT NULL,allocation_id uuid NOT NULL,released_by uuid,
 PRIMARY KEY(academy_id,run_id,kind,source_id,allocation_id),FOREIGN KEY(academy_id,run_id) REFERENCES public.payrun_groups(academy_id,id),FOREIGN KEY(academy_id,released_by,run_id) REFERENCES public.payrun_group_cancellations(academy_id,id,run_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX payrun_live_earning ON public.payrun_earning_claims(academy_id,kind,source_id,allocation_id) WHERE released_by IS NULL;
CREATE INDEX payrun_worker_pay_date ON public.payrun_groups(academy_id,person_id,planned_pay_on,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payrun_groups','payrun_group_cancellations','payrun_earning_claims'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER payrun_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,input,source_snapshot,approval_id,created_by) ON public.payrun_groups TO kavosh_runtime;
GRANT UPDATE(cancellation_id) ON public.payrun_groups TO kavosh_runtime;
GRANT INSERT(academy_id,id,run_id,input,source_snapshot,approval_id,created_by) ON public.payrun_group_cancellations TO kavosh_runtime;
GRANT INSERT(academy_id,run_id,kind,source_id,allocation_id),UPDATE(released_by) ON public.payrun_earning_claims TO kavosh_runtime;

CREATE FUNCTION public.payrun_input_valid(i jsonb,cancel boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE keys text[];k text;r jsonb;d date;BEGIN
 keys=CASE WHEN cancel THEN ARRAY['runId','reason'] ELSE ARRAY['personId','currencyId','reference','serviceFrom','serviceThrough','plannedPayOn','earnings','earningReview','taxReview','reason'] END;
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& keys) OR i-keys<>'{}'::jsonb OR octet_length(i::text)>65536 THEN RETURN false;END IF;
 FOREACH k IN ARRAY CASE WHEN cancel THEN ARRAY['reason'] ELSE ARRAY['reason','earningReview','taxReview'] END LOOP IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR length(btrim(i->>k)) NOT BETWEEN 1 AND 2000 THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY CASE WHEN cancel THEN ARRAY['runId'] ELSE ARRAY['personId','currencyId'] END LOOP IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR(i->>k)::uuid::text IS DISTINCT FROM i->>k THEN RETURN false;END IF;END LOOP;
 IF cancel THEN RETURN true;END IF;
 IF jsonb_typeof(i->'reference') IS DISTINCT FROM 'string' OR i->>'reference'!~'^[A-Z0-9][A-Z0-9._-]{0,63}$' OR jsonb_typeof(i->'earnings') IS DISTINCT FROM 'array' OR jsonb_array_length(i->'earnings') NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['serviceFrom','serviceThrough','plannedPayOn'] LOOP IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR i->>k!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;d=(i->>k)::date;IF d NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RETURN false;END IF;END LOOP;
 IF(i->>'serviceThrough')::date<(i->>'serviceFrom')::date OR(i->>'serviceThrough')::date-(i->>'serviceFrom')::date>365 THEN RETURN false;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(i->'earnings') LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT(r ?& ARRAY['kind','sourceId','allocationId']) OR r-ARRAY['kind','sourceId','allocationId']<>'{}'::jsonb OR r->>'kind' IS NULL OR r->>'kind' NOT IN('hourly','salary','project','manual_bonus','tuition_course','tuition_session','tuition_collection') THEN RETURN false;END IF;
  FOREACH k IN ARRAY ARRAY['sourceId','allocationId'] LOOP IF jsonb_typeof(r->k) IS DISTINCT FROM 'string' OR(r->>k)::uuid::text IS DISTINCT FROM r->>k THEN RETURN false;END IF;END LOOP;
 END LOOP;
 RETURN jsonb_array_length(i->'earnings')=(SELECT count(DISTINCT value) FROM jsonb_array_elements(i->'earnings'));
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
-- An exact bundle is not a grant to all records of any selected person.
ALTER FUNCTION public.scope_contains(jsonb,jsonb) RENAME TO scope_contains_before_payrun_groups;
CREATE FUNCTION public.scope_contains(p_source jsonb,p_target jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF p_source ? 'workContexts' AND p_source->'workContexts' IS DISTINCT FROM p_target->'workContexts' THEN RETURN false;END IF;
 IF p_target ? 'workContexts' THEN
  IF p_source ?| ARRAY['recordContext','workContext'] OR p_target-ARRAY['all','hubs','people','workContexts']<>'{}'::jsonb OR p_target->'all' IS DISTINCT FROM 'false'::jsonb OR p_target->'hubs' IS DISTINCT FROM '[]'::jsonb OR jsonb_typeof(p_target->'workContexts') IS DISTINCT FROM 'array' OR jsonb_array_length(p_target->'workContexts') NOT BETWEEN 1 AND 200 OR p_target->'people' IS DISTINCT FROM p_target->'workContexts' THEN RETURN false;END IF;
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_target->'workContexts') v WHERE jsonb_typeof(v) IS DISTINCT FROM 'object' OR v-ARRAY['id','hubId']<>'{}'::jsonb OR NOT(v ?& ARRAY['id','hubId']) OR public.work_scope_allows(p_source,(v->>'hubId')::uuid,(v->>'id')::uuid) IS NOT TRUE);
 END IF;RETURN public.scope_contains_before_payrun_groups(p_source,p_target);
 EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.scope_contains(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scope_contains(jsonb,jsonb) TO kavosh_runtime;
CREATE FUNCTION public.payrun_scope(items jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',refs,'workContexts',refs) FROM(SELECT coalesce(jsonb_agg(r ORDER BY r->>'id',r->>'hubId'),'[]'::jsonb) refs FROM(SELECT DISTINCT jsonb_build_object('id',v->>'personId','hubId',v->'hubId') r FROM jsonb_array_elements(items) v) p) x
$$;
CREATE FUNCTION public.payrun_group_source(i jsonb,exclude_run uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;items jsonb;terms jsonb;groups jsonb;scale integer;total numeric;n integer;work_id uuid;BEGIN
 IF NOT public.payrun_input_valid(i) THEN RETURN jsonb_build_object('unavailable','PAYRUN_INPUT_INVALID');END IF;
 PERFORM public.lock_hourly_worker((i->>'personId')::uuid);
 FOR work_id IN SELECT DISTINCT c.allocation_id FROM jsonb_to_recordset(i->'earnings') r(kind text,"sourceId" uuid,"allocationId" uuid) JOIN public.payrun_earning_catalogue c ON c.academy_id=tenant AND c.kind=r.kind AND c.source_id=r."sourceId" AND c.allocation_id=r."allocationId" ORDER BY c.allocation_id LOOP PERFORM public.lock_pay_period_work(work_id);END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',c.kind,'sourceId',c.source_id,'allocationId',c.allocation_id,'personId',c.person_id,'hubId',c.hub_id,'currencyId',c.currency_id,'unitScale',c.unit_scale,'minor',trunc(c.amount_minor)::text,'postedOn',c.posted_on::text,'dueOn',c.due_on::text,'from',c.from_on::text,'through',c.through_on::text,'voidId',c.void_id,'termsVersions',c.terms_versions,'legacyDateReviewRequired',c.legacy_date_review,'offPeriodSource',c.from_on<(i->>'serviceFrom')::date OR c.through_on>(i->>'serviceThrough')::date,'claimed',EXISTS(SELECT 1 FROM public.payrun_earning_claims q WHERE q.academy_id=c.academy_id AND q.kind=c.kind AND q.source_id=c.source_id AND q.allocation_id=c.allocation_id AND q.released_by IS NULL AND(exclude_run IS NULL OR q.run_id<>exclude_run))) ORDER BY c.kind,c.source_id,c.allocation_id),'[]'::jsonb),max(c.unit_scale) INTO items,scale
 FROM jsonb_to_recordset(i->'earnings') r(kind text,"sourceId" uuid,"allocationId" uuid) JOIN public.payrun_earning_catalogue c ON c.academy_id=tenant AND c.kind=r.kind AND c.source_id=r."sourceId" AND c.allocation_id=r."allocationId";
 IF jsonb_array_length(items)<>jsonb_array_length(i->'earnings') THEN RETURN jsonb_build_object('unavailable','PAYRUN_SOURCE_NOT_FOUND','items',items);END IF;
 SELECT count(DISTINCT jsonb_build_array(v->>'allocationId',t)) INTO n FROM jsonb_array_elements(items) v CROSS JOIN LATERAL jsonb_array_elements(v->'termsVersions') t;
 IF n>1000 THEN RETURN jsonb_build_object('unavailable','PAYRUN_REQUIRES_BACKGROUND_JOB','items',items);END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q."engagementId",q.version),'[]'::jsonb) INTO terms FROM(
 SELECT DISTINCT e.engagement_id "engagementId",e.version,e.currency_id "currencyId",e.employer_id "employerId",e.employer_version "employerVersion",e.payee_id "payeeId",e.payee_version "payeeVersion",e.definition->>'classification' classification,e.definition->>'countryCode' "countryCode",e.definition->>'region' region,e.definition->>'reportingForm' "reportingForm",e.definition->'otherReportingForm' "otherReportingForm"
 FROM jsonb_array_elements(items) v CROSS JOIN LATERAL jsonb_array_elements(v->'termsVersions') t JOIN public.work_engagement_revisions e ON e.academy_id=tenant AND e.engagement_id=(v->>'allocationId')::uuid AND e.version=(t#>>'{}')::integer) q;
 SELECT coalesce(jsonb_agg(g ORDER BY g::text),'[]'::jsonb) INTO groups FROM(SELECT DISTINCT v-ARRAY['engagementId','version','currencyId'] g FROM jsonb_array_elements(terms) v) x;
 SELECT trunc(sum((v->>'minor')::numeric*power(10::numeric,scale-(v->>'unitScale')::integer))) INTO total FROM jsonb_array_elements(items) v;
 RETURN jsonb_build_object('items',items,'terms',terms,'contexts',groups,'unitScale',scale,'grossMinor',total::text,'scope',public.payrun_scope(items),'unavailable',CASE
 WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(items) v WHERE v->>'personId'<>i->>'personId' OR v->>'currencyId'<>i->>'currencyId') THEN 'PAYRUN_WORKER_CURRENCY_MISMATCH'
 WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(items) v WHERE v->>'voidId' IS NOT NULL) THEN 'PAYRUN_SOURCE_VOIDED'
 WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(items) v WHERE v->'claimed'='true'::jsonb) THEN 'PAYRUN_EARNING_ALREADY_GROUPED'
 WHEN jsonb_array_length(terms)<>n OR EXISTS(SELECT 1 FROM jsonb_array_elements(items) v WHERE jsonb_typeof(v->'termsVersions') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'termsVersions')=0) THEN 'PAYRUN_TERMS_UNAVAILABLE'
 WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(terms) v WHERE v->>'currencyId'<>i->>'currencyId') THEN 'PAYRUN_WORKER_CURRENCY_MISMATCH'
 WHEN jsonb_array_length(groups)<>1 THEN 'PAYRUN_SEPARATE_LEGAL_CONTEXT_REQUIRED'
 WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(items) v WHERE(v->>'postedOn')::date>(i->>'plannedPayOn')::date) THEN 'PAYRUN_PAY_DATE_PRECEDES_POSTING' ELSE NULL END);
END $$;
CREATE FUNCTION public.payrun_cancel_source(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b record;BEGIN
 SELECT * INTO b FROM public.payrun_groups WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_id;IF NOT FOUND THEN RETURN NULL;END IF;PERFORM public.lock_hourly_worker(b.person_id);SELECT * INTO b FROM public.payrun_groups WHERE academy_id=b.academy_id AND id=p_id;
 RETURN jsonb_build_object('runId',b.id,'personId',b.person_id,'cancellationId',b.cancellation_id,'scope',b.scope,'source',b.source_snapshot);
END $$;
CREATE FUNCTION public.payrun_group_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;p record;BEGIN
 IF TG_OP='UPDATE' THEN IF OLD.cancellation_id IS NOT NULL OR NEW.cancellation_id IS NULL OR to_jsonb(NEW)-'cancellation_id' IS DISTINCT FROM to_jsonb(OLD)-'cancellation_id' THEN RAISE EXCEPTION 'PAYRUN_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 s=public.payrun_group_source(NEW.input,NEW.id);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s->>'unavailable' IS NOT NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.payrun.group' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.privacy_capability IS DISTINCT FROM 'payruns.view' OR p.scope IS DISTINCT FROM s->'scope' OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR NOT public.report_comment_human_verified(NEW.created_by) THEN RAISE EXCEPTION 'PAYRUN_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.created_by=(NEW.input->>'personId')::uuid AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.person_id=(NEW.input->>'personId')::uuid;NEW.currency_id=(NEW.input->>'currencyId')::uuid;NEW.reference=NEW.input->>'reference';NEW.service_from=(NEW.input->>'serviceFrom')::date;NEW.service_through=(NEW.input->>'serviceThrough')::date;NEW.planned_pay_on=(NEW.input->>'plannedPayOn')::date;NEW.unit_scale=(s->>'unitScale')::integer;NEW.gross_minor=(s->>'grossMinor')::numeric;NEW.scope=s->'scope';NEW.cancellation_id=NULL;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payrun_group_guard BEFORE INSERT OR UPDATE ON public.payrun_groups FOR EACH ROW EXECUTE FUNCTION public.payrun_group_guard();
CREATE FUNCTION public.payrun_cancel_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;p record;BEGIN
 s=public.payrun_cancel_source(NEW.run_id);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF NOT public.payrun_input_valid(NEW.input,true) OR NEW.run_id IS DISTINCT FROM(NEW.input->>'runId')::uuid OR s IS NULL OR s->>'cancellationId' IS NOT NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.payrun.cancel' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.privacy_capability IS DISTINCT FROM 'payruns.view' OR p.scope IS DISTINCT FROM s->'scope' OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR NOT public.report_comment_human_verified(NEW.created_by) THEN RAISE EXCEPTION 'PAYRUN_CANCEL_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.created_by=(s->>'personId')::uuid AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payrun_cancel_guard BEFORE INSERT ON public.payrun_group_cancellations FOR EACH ROW EXECUTE FUNCTION public.payrun_cancel_guard();
CREATE FUNCTION public.payrun_claim_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b record;BEGIN
 SELECT * INTO b FROM public.payrun_groups WHERE academy_id=NEW.academy_id AND id=NEW.run_id;PERFORM public.lock_hourly_worker(b.person_id);
 IF TG_OP='UPDATE' THEN
  IF OLD.released_by IS NOT NULL OR NEW.released_by IS NULL OR to_jsonb(NEW)-'released_by' IS DISTINCT FROM to_jsonb(OLD)-'released_by' OR NOT EXISTS(SELECT 1 FROM public.payrun_group_cancellations c WHERE c.academy_id=NEW.academy_id AND c.run_id=NEW.run_id AND c.id=NEW.released_by) THEN RAISE EXCEPTION 'PAYRUN_CLAIM_IMMUTABLE' USING ERRCODE='23514';END IF;
 ELSE
  IF b.id IS NULL OR b.cancellation_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.source_snapshot->'items') v WHERE v->>'kind'=NEW.kind AND(v->>'sourceId')::uuid=NEW.source_id AND(v->>'allocationId')::uuid=NEW.allocation_id) THEN RAISE EXCEPTION 'PAYRUN_CLAIM_MEMBERSHIP_REQUIRED' USING ERRCODE='23514';END IF;NEW.released_by=NULL;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER payrun_claim_guard BEFORE INSERT OR UPDATE ON public.payrun_earning_claims FOR EACH ROW EXECUTE FUNCTION public.payrun_claim_guard();
CREATE FUNCTION public.payrun_group_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b record;n integer;BEGIN
 IF TG_TABLE_NAME='payrun_groups' THEN SELECT * INTO b FROM public.payrun_groups WHERE academy_id=NEW.academy_id AND id=NEW.id;ELSE SELECT * INTO b FROM public.payrun_groups WHERE academy_id=NEW.academy_id AND id=NEW.run_id;END IF;
 IF TG_TABLE_NAME='payrun_group_cancellations' AND b.cancellation_id IS DISTINCT FROM(to_jsonb(NEW)->>'id')::uuid THEN RAISE EXCEPTION 'PAYRUN_CANCEL_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT count(*) INTO n FROM public.payrun_earning_claims WHERE academy_id=b.academy_id AND run_id=b.id;
 IF n<>jsonb_array_length(b.source_snapshot->'items') OR EXISTS(SELECT 1 FROM public.payrun_earning_claims WHERE academy_id=b.academy_id AND run_id=b.id AND released_by IS DISTINCT FROM b.cancellation_id) THEN RAISE EXCEPTION 'PAYRUN_EXACT_CLAIMS_REQUIRED' USING ERRCODE='23514';END IF;
 -- The header's deferred guard proves the whole source once. Claim guards
 -- still check membership/count/release, not 200 copies of the same source.
 IF TG_TABLE_NAME='payrun_groups' AND b.cancellation_id IS NULL AND public.payrun_group_source(b.input,b.id) IS DISTINCT FROM b.source_snapshot THEN RAISE EXCEPTION 'PAYRUN_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payrun_group_complete AFTER INSERT OR UPDATE ON public.payrun_groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payrun_group_complete();
CREATE CONSTRAINT TRIGGER payrun_claim_complete AFTER INSERT OR UPDATE ON public.payrun_earning_claims DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payrun_group_complete();
CREATE CONSTRAINT TRIGGER payrun_cancel_complete AFTER INSERT ON public.payrun_group_cancellations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payrun_group_complete();
CREATE CONSTRAINT TRIGGER payrun_reviewed AFTER INSERT ON public.payrun_groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE CONSTRAINT TRIGGER payrun_cancel_reviewed AFTER INSERT ON public.payrun_group_cancellations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.payrun_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND((NEW.action='work.payrun.group' AND NOT EXISTS(SELECT 1 FROM public.payrun_groups WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id)) OR(NEW.action='work.payrun.cancel' AND NOT EXISTS(SELECT 1 FROM public.payrun_group_cancellations WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id))) THEN RAISE EXCEPTION 'PAYRUN_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payrun_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payrun_effect_required();
CREATE FUNCTION public.payrun_source_void_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.void_id IS NOT DISTINCT FROM OLD.void_id THEN RETURN NEW;END IF;
 IF TG_ARGV[0]='hourly' THEN PERFORM public.lock_hourly_worker(OLD.person_id);ELSE PERFORM public.lock_pay_period_work(OLD.engagement_id);END IF;
 IF EXISTS(SELECT 1 FROM public.payrun_earning_claims c WHERE c.academy_id=OLD.academy_id AND c.kind=TG_ARGV[0] AND c.source_id=OLD.id AND c.released_by IS NULL) THEN RAISE EXCEPTION 'PAYRUN_CANCEL_BEFORE_SOURCE_CORRECTION' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
DO $$ DECLARE r record;BEGIN FOR r IN SELECT * FROM(VALUES('hourly','payroll_hourly_accruals'),('salary','payroll_salary_accruals'),('project','payroll_project_accruals'),('manual_bonus','payroll_adjustments'),('tuition_course','payroll_tuition_course_accruals'),('tuition_session','payroll_tuition_session_accruals'),('tuition_collection','payroll_tuition_collection_accruals')) x(kind,t) LOOP
 EXECUTE format('CREATE TRIGGER aa_payrun_source_void BEFORE UPDATE OF void_id ON public.%I FOR EACH ROW EXECUTE FUNCTION public.payrun_source_void_guard(%L)',r.t,r.kind);
END LOOP;END $$;
CREATE FUNCTION public.payrun_approval_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE items jsonb;cap text;s jsonb;BEGIN
 IF NEW.action='work.payrun.cancel' THEN RETURN NEW;END IF;
 items=NEW.review_context->'items';IF jsonb_typeof(items) IS DISTINCT FROM 'array' OR jsonb_array_length(items)=0 THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 FOREACH cap IN ARRAY ARRAY['work-pay.view','payroll-accruals.view','payroll-adjustments.view'] LOOP
  SELECT public.payrun_scope(coalesce(jsonb_agg(v),'[]'::jsonb)) INTO s FROM jsonb_array_elements(items) v WHERE cap='work-pay.view' OR(cap='payroll-adjustments.view')=(v->>'kind'='manual_bonus');
  IF jsonb_array_length(s->'people')>0 THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',s));END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER zz_payrun_approval_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('work.payrun.group','work.payrun.cancel')) EXECUTE FUNCTION public.payrun_approval_privacy();
REVOKE ALL ON FUNCTION public.payrun_input_valid(jsonb,boolean),public.payrun_scope(jsonb),public.payrun_group_source(jsonb,uuid),public.payrun_cancel_source(uuid),public.payrun_group_guard(),public.payrun_cancel_guard(),public.payrun_claim_guard(),public.payrun_group_complete(),public.payrun_effect_required(),public.payrun_source_void_guard(),public.payrun_approval_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payrun_input_valid(jsonb,boolean),public.payrun_scope(jsonb),public.payrun_group_source(jsonb,uuid),public.payrun_cancel_source(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 108 $$;

INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('work-pay.view','View private employee/contractor engagements and configured pay','Finance',true,ARRAY['hub','person','country','region','city']),
 ('work-pay.edit','Propose reviewed employment and compensation terms','Finance',true,ARRAY['hub','person','country','region','city']);
-- Promote the already tested generic deferred-approval guard to the shared
-- name now that both inventory and work terms use it. Existing triggers keep
-- their function identity through this rename.
ALTER FUNCTION public.inventory_approval_complete() RENAME TO reviewed_approval_complete;
CREATE OR REPLACE FUNCTION public.reviewed_approval_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=coalesce((to_jsonb(NEW)->>'created_by')::uuid,(to_jsonb(NEW)->>'changed_by')::uuid)) THEN RAISE EXCEPTION 'REVIEWED_APPROVAL_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE TABLE public.work_engagements(
 academy_id uuid NOT NULL,id uuid NOT NULL,person_id uuid NOT NULL,person_kind text NOT NULL DEFAULT 'human' CHECK(person_kind='human'),hub_id uuid,code text NOT NULL CHECK(code~'^[A-Z0-9][A-Z0-9._-]{0,63}$'),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,person_id,code),FOREIGN KEY(academy_id,person_id,person_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id)
);
CREATE TABLE public.work_engagement_revisions(
 academy_id uuid NOT NULL,engagement_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),effective_on date NOT NULL CHECK(effective_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),
 currency_id uuid NOT NULL,currency_version integer NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),employer_id uuid NOT NULL,employer_version integer NOT NULL,payee_id uuid NOT NULL,payee_version integer NOT NULL,
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),components jsonb NOT NULL CHECK(jsonb_typeof(components)='array' AND jsonb_array_length(components) BETWEEN 1 AND 50),source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,engagement_id,version),FOREIGN KEY(academy_id,engagement_id) REFERENCES public.work_engagements(academy_id,id),FOREIGN KEY(academy_id,currency_id,currency_version) REFERENCES public.finance_currency_revisions(academy_id,currency_id,version),FOREIGN KEY(academy_id,employer_id,employer_version) REFERENCES public.financial_payee_revisions(academy_id,payee_id,version),FOREIGN KEY(academy_id,payee_id,payee_version) REFERENCES public.financial_payee_revisions(academy_id,payee_id,version),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.work_engagements ADD CONSTRAINT work_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.work_engagement_revisions(academy_id,engagement_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX work_person_hub ON public.work_engagements(academy_id,person_id,hub_id,id);
CREATE INDEX work_effective_terms ON public.work_engagement_revisions(academy_id,engagement_id,effective_on DESC,version DESC);
CREATE TRIGGER work_header_version BEFORE INSERT OR UPDATE ON public.work_engagements FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.work_scope_allows(s jsonb,p_hub uuid,p_person uuid) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT(NOT(s ? 'recordHubIds') OR(p_hub IS NOT NULL AND s->'recordHubIds' ? p_hub::text)) AND NOT coalesce(s->'excludedHubs' ? p_hub::text,false) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->'excludedPeople','[]'::jsonb)) x WHERE x->>'id'=p_person::text)
 AND(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->'people','[]'::jsonb)) x WHERE x->>'id'=p_person::text)
 OR(p_hub IS NOT NULL AND(coalesce(s->'all'='true'::jsonb,false) OR coalesce(s->'hubs' ? p_hub::text,false)))
 OR(p_hub IS NULL AND coalesce(s->'all'='true'::jsonb,false) AND jsonb_array_length(coalesce(s->'excludedHubs','[]'::jsonb))=0 AND jsonb_array_length(coalesce(s->'excludedAreas','[]'::jsonb))=0))
$$;
CREATE FUNCTION public.work_money_valid(v jsonb,p_scale integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE amount numeric;BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(v#>>'{}')>80 OR(v#>>'{}')!~'^[0-9]+([.][0-9]+)?$' THEN RETURN false;END IF;
 amount=(v#>>'{}')::numeric*power(10::numeric,p_scale);RETURN amount>=0 AND amount<1e38 AND amount=trunc(amount);
 EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN false;
END $$;
CREATE FUNCTION public.work_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE e record;p record;r jsonb;s record;f date;t date;keys text[];cycle jsonb;ref_key text;BEGIN
 SELECT * INTO e FROM public.work_engagements WHERE academy_id=NEW.academy_id AND id=NEW.engagement_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF e.id IS NULL OR e.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.work_engagement_revisions WHERE academy_id=NEW.academy_id AND engagement_id=NEW.engagement_id)
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'work.engagement.create' ELSE 'work.engagement.change' END) OR p.target_id IS DISTINCT FROM NEW.engagement_id OR p.target_version IS DISTINCT FROM NEW.version-1
 OR p.payload->'definition' IS DISTINCT FROM NEW.definition OR p.payload->'components' IS DISTINCT FROM NEW.components OR(p.payload->>'effectiveOn')::date IS DISTINCT FROM NEW.effective_on
 OR(p.payload#>>'{currency,id}')::uuid IS DISTINCT FROM NEW.currency_id OR(p.payload#>>'{currency,version}')::integer IS DISTINCT FROM NEW.currency_version OR(p.payload#>>'{employer,id}')::uuid IS DISTINCT FROM NEW.employer_id OR(p.payload#>>'{employer,version}')::integer IS DISTINCT FROM NEW.employer_version OR(p.payload#>>'{payee,id}')::uuid IS DISTINCT FROM NEW.payee_id OR(p.payload#>>'{payee,version}')::integer IS DISTINCT FROM NEW.payee_version OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 OR(NEW.version=1 AND((p.payload->>'personId')::uuid IS DISTINCT FROM e.person_id OR(p.payload->>'hubId')::uuid IS DISTINCT FROM e.hub_id OR p.payload->>'code' IS DISTINCT FROM e.code)) THEN RAISE EXCEPTION 'WORK_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human') OR NOT EXISTS(SELECT 1 FROM public.finance_currency_revisions WHERE academy_id=NEW.academy_id AND currency_id=NEW.currency_id AND version=NEW.currency_version AND unit_scale=NEW.unit_scale) OR NOT EXISTS(SELECT 1 FROM public.financial_payees WHERE academy_id=NEW.academy_id AND id=NEW.employer_id AND kind='academy') THEN RAISE EXCEPTION 'WORK_PARTY_OR_CURRENCY_INVALID' USING ERRCODE='23514';END IF;
 keys=ARRAY['legalWorkerName','jobTitle','classification','workPattern','countryCode','region','timeZone','startsOn','endsOn','active','reportingForm','otherReportingForm','classificationBasis','taxReview','payCycle'];
 IF NOT(NEW.definition ?& keys) OR NEW.definition-keys<>'{}'::jsonb OR octet_length(NEW.definition::text)>20000 OR octet_length(NEW.components::text)>100000 OR NEW.definition->>'classification' IS NULL OR NEW.definition->>'classification' NOT IN('employee','contractor','volunteer','undetermined') OR NEW.definition->>'reportingForm' IS NULL OR NEW.definition->>'reportingForm' NOT IN('T4','T4A','T4A_NR','other','undetermined') OR jsonb_typeof(NEW.definition->'active') IS DISTINCT FROM 'boolean'
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['legalWorkerName','jobTitle','workPattern','region','timeZone','classificationBasis','taxReview']) k WHERE jsonb_typeof(NEW.definition->k) IS DISTINCT FROM 'string' OR length(btrim(NEW.definition->>k)) NOT BETWEEN 1 AND CASE WHEN k IN('classificationBasis','taxReview') THEN 2000 WHEN k='timeZone' THEN 100 ELSE 200 END)
 OR NEW.definition->>'countryCode' IS NULL OR NEW.definition->>'countryCode'!~'^[A-Z]{2}$' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.definition->>'timeZone')
 OR((NEW.definition->>'reportingForm'='other') IS DISTINCT FROM(jsonb_typeof(NEW.definition->'otherReportingForm')='string')) OR(jsonb_typeof(NEW.definition->'otherReportingForm')='string' AND length(btrim(NEW.definition->>'otherReportingForm')) NOT BETWEEN 1 AND 200)
 THEN RAISE EXCEPTION 'WORK_DEFINITION_INVALID' USING ERRCODE='23514';END IF;
 cycle=NEW.definition->'payCycle';
 IF jsonb_typeof(cycle) IS DISTINCT FROM 'object' OR cycle->>'kind' IS NULL OR cycle->>'kind' NOT IN('monthly','semimonthly','biweekly','weekly','custom') THEN RAISE EXCEPTION 'WORK_PAY_CYCLE_INVALID' USING ERRCODE='23514';END IF;
 keys=CASE cycle->>'kind' WHEN 'monthly' THEN ARRAY['kind','day','shortMonth'] WHEN 'semimonthly' THEN ARRAY['kind','days','shortMonth'] WHEN 'biweekly' THEN ARRAY['kind','anchorOn'] WHEN 'weekly' THEN ARRAY['kind','weekday'] ELSE ARRAY['kind','label','dates'] END;
 IF NOT(cycle ?& keys) OR cycle-keys<>'{}'::jsonb OR EXISTS(SELECT 1 FROM unnest(keys) k WHERE cycle->k='null'::jsonb) THEN RAISE EXCEPTION 'WORK_PAY_CYCLE_INVALID' USING ERRCODE='23514';END IF;
 IF cycle->>'kind'='monthly' AND(jsonb_typeof(cycle->'day')<>'number' OR(cycle->>'day')::numeric NOT BETWEEN 1 AND 31 OR(cycle->>'day')::numeric<>trunc((cycle->>'day')::numeric) OR cycle->>'shortMonth'<>'last_day') THEN RAISE EXCEPTION 'WORK_PAY_CYCLE_INVALID' USING ERRCODE='23514';END IF;
 IF cycle->>'kind'='semimonthly' THEN
  IF jsonb_typeof(cycle->'days')<>'array' OR jsonb_array_length(cycle->'days')<>2 OR cycle->>'shortMonth'<>'last_day' THEN RAISE EXCEPTION 'WORK_PAY_CYCLE_INVALID' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(cycle->'days') d WHERE jsonb_typeof(d)<>'number' OR(d#>>'{}')::numeric NOT BETWEEN 1 AND 31 OR(d#>>'{}')::numeric<>trunc((d#>>'{}')::numeric)) OR(cycle#>>'{days,0}')::integer>=(cycle#>>'{days,1}')::integer THEN RAISE EXCEPTION 'WORK_PAY_CYCLE_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 IF cycle->>'kind'='weekly' AND(jsonb_typeof(cycle->'weekday')<>'number' OR(cycle->>'weekday')::numeric NOT BETWEEN 1 AND 7 OR(cycle->>'weekday')::numeric<>trunc((cycle->>'weekday')::numeric)) THEN RAISE EXCEPTION 'WORK_PAY_CYCLE_INVALID' USING ERRCODE='23514';END IF;
 IF cycle->>'kind'='biweekly' AND(jsonb_typeof(cycle->'anchorOn')<>'string' OR(cycle->>'anchorOn')::date NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31') THEN RAISE EXCEPTION 'WORK_PAY_CYCLE_INVALID' USING ERRCODE='23514';END IF;
 IF cycle->>'kind'='custom' THEN
  IF jsonb_typeof(cycle->'label')<>'string' OR length(btrim(cycle->>'label')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(cycle->'dates')<>'array' OR jsonb_array_length(cycle->'dates') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'WORK_PAY_CYCLE_INVALID' USING ERRCODE='23514';END IF;
  IF(SELECT count(DISTINCT d) FROM jsonb_array_elements(cycle->'dates') d)<>jsonb_array_length(cycle->'dates') OR EXISTS(SELECT 1 FROM jsonb_array_elements(cycle->'dates') d WHERE jsonb_typeof(d)<>'string' OR(d#>>'{}')::date NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31') THEN RAISE EXCEPTION 'WORK_PAY_CYCLE_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 f=(NEW.definition->>'startsOn')::date;t=(NEW.definition->>'endsOn')::date;IF f IS NULL OR f NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' OR(t IS NOT NULL AND(t<f OR t>DATE '9999-12-31')) OR NEW.effective_on<f THEN RAISE EXCEPTION 'WORK_EFFECTIVE_DATES_INVALID' USING ERRCODE='23514';END IF;
 IF(SELECT count(DISTINCT x->>'code') FROM jsonb_array_elements(NEW.components) x)<>jsonb_array_length(NEW.components) THEN RAISE EXCEPTION 'WORK_COMPONENT_CODES_INVALID' USING ERRCODE='23514';END IF;
 FOR r IN SELECT * FROM jsonb_array_elements(NEW.components) LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r->>'kind' IS NULL OR r->>'kind' NOT IN('salary','hourly','headcount_hourly','tuition_percentage','project') THEN RAISE EXCEPTION 'WORK_COMPONENT_INVALID' USING ERRCODE='23514';END IF;
  keys=ARRAY['code','kind','from','through','assignment','method']||CASE r->>'kind' WHEN 'salary' THEN ARRAY['amount','frequency'] WHEN 'hourly' THEN ARRAY['amount','rounding','excessToleranceMinutes'] WHEN 'headcount_hourly' THEN ARRAY['amount','rounding','excessToleranceMinutes','minimumStudents','includedStudents','increment','headcountBasis'] WHEN 'tuition_percentage' THEN ARRAY['percent','basis'] ELSE ARRAY['amount','projectCode'] END;
  IF NOT(r ?& keys) OR r-keys<>'{}'::jsonb OR EXISTS(SELECT 1 FROM unnest(keys) k WHERE k NOT IN('through','assignment','method') AND r->k='null'::jsonb) OR jsonb_typeof(r->'code')<>'string' OR r->>'code'!~'^[A-Z0-9][A-Z0-9._-]{0,63}$' OR(r->>'from')::date NOT BETWEEN f AND DATE '9999-12-31' OR(r->>'through')::date<(r->>'from')::date OR(r->>'through')::date>DATE '9999-12-31' OR(t IS NOT NULL AND((r->>'through') IS NULL OR(r->>'through')::date>t)) THEN RAISE EXCEPTION 'WORK_COMPONENT_DATES_INVALID' USING ERRCODE='23514';END IF;
  IF(r->>'kind'='salary' AND r->>'frequency' NOT IN('month','year','pay_period')) OR(r->>'kind'='tuition_percentage' AND r->>'basis' NOT IN('session_net','session_gross','course_net','course_gross','period_collected_net','period_collected_gross')) OR(r->>'kind'='project' AND r->>'projectCode'!~'^[A-Z0-9][A-Z0-9._-]{0,63}$') THEN RAISE EXCEPTION 'WORK_COMPONENT_POLICY_INVALID' USING ERRCODE='23514';END IF;
  FOREACH ref_key IN ARRAY ARRAY['assignment','method'] LOOP
   IF r->ref_key<>'null'::jsonb AND(jsonb_typeof(r->ref_key)<>'object' OR NOT(r->ref_key ?& ARRAY['id','version']) OR(r->ref_key)-ARRAY['id','version']<>'{}'::jsonb OR jsonb_typeof(r#>ARRAY[ref_key,'id']) IS DISTINCT FROM 'string' OR jsonb_typeof(r#>ARRAY[ref_key,'version']) IS DISTINCT FROM 'number' OR(r#>>ARRAY[ref_key,'version'])::numeric NOT BETWEEN 1 AND 2147483647 OR(r#>>ARRAY[ref_key,'version'])::numeric<>trunc((r#>>ARRAY[ref_key,'version'])::numeric)) THEN RAISE EXCEPTION 'WORK_REFERENCE_INVALID' USING ERRCODE='23514';END IF;
  END LOOP;
  IF r->>'kind'='tuition_percentage' THEN IF NOT public.work_money_valid(r->'percent',4) OR(r->>'percent')::numeric>100 THEN RAISE EXCEPTION 'WORK_PERCENT_INVALID' USING ERRCODE='23514';END IF;
  ELSE IF NOT public.work_money_valid(r->'amount',NEW.unit_scale) THEN RAISE EXCEPTION 'WORK_RATE_INVALID' USING ERRCODE='23514';END IF;END IF;
  IF r->>'kind'='headcount_hourly' AND(NOT public.work_money_valid(r->'increment',NEW.unit_scale) OR(r->>'minimumStudents')::integer NOT BETWEEN 0 AND 1000000 OR(r->>'includedStudents')::integer NOT BETWEEN 0 AND 1000000 OR r->>'headcountBasis' NOT IN('enrolled','present','eligible_present')) THEN RAISE EXCEPTION 'WORK_HEADCOUNT_INVALID' USING ERRCODE='23514';END IF;
  IF r->>'kind' IN('hourly','headcount_hourly') AND(r->>'rounding' NOT IN('none','nearest_5') OR(r->>'excessToleranceMinutes')::integer NOT BETWEEN 0 AND 1440) THEN RAISE EXCEPTION 'WORK_TIME_POLICY_INVALID' USING ERRCODE='23514';END IF;
  IF r#>>'{assignment,id}' IS NOT NULL THEN
   SELECT x.class_id,c.hub_id INTO s FROM public.class_staff x JOIN public.classes c ON c.academy_id=x.academy_id AND c.id=x.class_id JOIN public.class_staff_revisions v ON v.academy_id=x.academy_id AND v.assignment_id=x.id AND v.version=(r#>>'{assignment,version}')::integer WHERE x.academy_id=NEW.academy_id AND x.id=(r#>>'{assignment,id}')::uuid AND x.person_id=e.person_id;
   IF NOT FOUND OR e.hub_id IS DISTINCT FROM s.hub_id THEN RAISE EXCEPTION 'WORK_STAFF_CONTEXT_INVALID' USING ERRCODE='23514';END IF;
  END IF;
  IF r#>>'{method,id}' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.finance_payment_methods m JOIN public.finance_payment_method_revisions v ON v.academy_id=m.academy_id AND v.method_id=m.id AND v.version=(r#>>'{method,version}')::integer WHERE m.academy_id=NEW.academy_id AND m.id=(r#>>'{method,id}')::uuid AND(m.hub_id IS NULL OR m.hub_id=e.hub_id)) THEN RAISE EXCEPTION 'WORK_METHOD_INVALID' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER work_terms_guard BEFORE INSERT ON public.work_engagement_revisions FOR EACH ROW EXECUTE FUNCTION public.work_revision_guard();
CREATE CONSTRAINT TRIGGER work_terms_applied AFTER INSERT ON public.work_engagement_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['work_engagements','work_engagement_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
END LOOP;END $$;
GRANT SELECT ON public.work_engagements,public.work_engagement_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,id,person_id,hub_id,code) ON public.work_engagements TO kavosh_runtime;
GRANT UPDATE(version) ON public.work_engagements TO kavosh_runtime;
GRANT INSERT(academy_id,engagement_id,version,effective_on,currency_id,currency_version,unit_scale,employer_id,employer_version,payee_id,payee_version,definition,components,source_snapshot,changed_by,approval_id,reason) ON public.work_engagement_revisions TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.work_scope_allows(jsonb,uuid,uuid),public.work_money_valid(jsonb,integer),public.work_revision_guard(),public.reviewed_approval_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_scope_allows(jsonb,uuid,uuid),public.work_money_valid(jsonb,integer) TO kavosh_runtime;
ALTER FUNCTION public.scope_contains(jsonb,jsonb) RENAME TO scope_contains_before_work_records;
CREATE FUNCTION public.scope_contains(p_source jsonb,p_target jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE w jsonb:=p_target->'workContext';BEGIN
 IF p_source ? 'workContext' AND p_source->'workContext' IS DISTINCT FROM w THEN RETURN false;END IF;
 IF w IS NOT NULL THEN
  IF p_source ? 'recordContext' OR p_target ?| ARRAY['recordContext','recordHubIds'] OR p_target->'all' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(p_target->'people') IS DISTINCT FROM 'array' OR jsonb_array_length(p_target->'people')<>1 OR p_target#>>'{people,0,id}' IS DISTINCT FROM w->>'personId' OR p_target#>>'{people,0,hubId}' IS DISTINCT FROM w->>'hubId'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['hubs','classes','areas','excludedHubs','excludedAreas','excludedPeople','excludedClasses']) k WHERE jsonb_array_length(coalesce(p_target->k,'[]'::jsonb))>0) THEN RETURN false;END IF;
  RETURN public.work_scope_allows(p_source,(w->>'hubId')::uuid,(w->>'personId')::uuid);
 END IF;
 IF p_source ? 'recordHubIds' AND(p_target->'all'='true'::jsonb OR jsonb_array_length(coalesce(p_target->'areas','[]'::jsonb))>0 OR jsonb_array_length(coalesce(p_target->'people','[]'::jsonb))>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p_target->'hubs','[]'::jsonb)) h WHERE NOT(p_source->'recordHubIds' ? h))) THEN RETURN false;END IF;
 RETURN public.scope_contains_before_work_records(p_source,p_target);
END $$;
REVOKE ALL ON FUNCTION public.scope_contains(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scope_contains(jsonb,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 57 $$;

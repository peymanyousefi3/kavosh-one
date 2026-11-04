INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('tuition.view','View permitted student tuition plans and installments','Finance',true,ARRAY['hub','class','person','country','region','city']),
 ('tuition.edit','Request reviewed tuition plans and corrections','Finance',true,ARRAY['hub','class','person','country','region','city']);
-- The positive grant may select a person OR class; a proposal still retains
-- both identities so explicit denials cannot disappear in the approval inbox.
ALTER FUNCTION public.scope_contains(jsonb,jsonb) RENAME TO scope_contains_geographic;
CREATE FUNCTION public.scope_contains(p_source jsonb,p_target jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE context jsonb:=p_target->'recordContext';
BEGIN
 IF p_source ? 'recordContext' AND p_source->'recordContext' IS DISTINCT FROM context THEN RETURN false;END IF;
 IF context IS NOT NULL THEN
  IF jsonb_typeof(context)<>'object' OR NOT context ?& ARRAY['hubId','classId','studentId'] THEN RETURN false;END IF;
  IF coalesce(p_source->'excludedHubs','[]'::jsonb) ? (context->>'hubId')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_source->'excludedClasses','[]'::jsonb)) c WHERE c->>'id'=context->>'classId')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_source->'excludedPeople','[]'::jsonb)) p WHERE p->>'id'=context->>'studentId') THEN RETURN false;END IF;
 END IF;
 RETURN public.scope_contains_geographic(p_source,p_target);
END $$;
REVOKE ALL ON FUNCTION public.scope_contains(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scope_contains(jsonb,jsonb) TO kavosh_runtime;
ALTER TABLE public.class_enrollments ADD CONSTRAINT enrollment_tuition_identity UNIQUE(academy_id,id,student_id,class_id,hub_id);
CREATE TABLE public.tuition_plans(
 academy_id uuid NOT NULL,id uuid NOT NULL,enrollment_id uuid NOT NULL,student_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,
 currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,enrollment_id),UNIQUE(academy_id,id,enrollment_id,currency_id),
 FOREIGN KEY(academy_id,enrollment_id,student_id,class_id,hub_id) REFERENCES public.class_enrollments(academy_id,id,student_id,class_id,hub_id),
 FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),
 FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE INDEX tuition_plans_hub ON public.tuition_plans(academy_id,hub_id,id);
CREATE INDEX tuition_plans_student ON public.tuition_plans(academy_id,student_id,id);
CREATE INDEX tuition_plans_class ON public.tuition_plans(academy_id,class_id,id);
CREATE TABLE public.tuition_plan_revisions(
 academy_id uuid NOT NULL,plan_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),enrollment_id uuid NOT NULL,enrollment_version integer NOT NULL,
 currency_id uuid NOT NULL,currency_version integer NOT NULL,tax_code_id uuid NOT NULL,tax_code_version integer NOT NULL,
 supply_on date NOT NULL CHECK(supply_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 original_minor numeric NOT NULL CHECK(original_minor=trunc(original_minor) AND original_minor BETWEEN 0 AND 99999999999999999999999999999999999999),
 agreed_minor numeric NOT NULL CHECK(agreed_minor=trunc(agreed_minor) AND agreed_minor BETWEEN 0 AND 99999999999999999999999999999999999999),
 net_minor numeric NOT NULL CHECK(net_minor=trunc(net_minor) AND net_minor BETWEEN 0 AND 99999999999999999999999999999999999999),
 tax_minor numeric NOT NULL CHECK(tax_minor=trunc(tax_minor) AND tax_minor BETWEEN 0 AND 99999999999999999999999999999999999999),
 gross_minor numeric NOT NULL CHECK(gross_minor=trunc(gross_minor) AND gross_minor BETWEEN 0 AND 99999999999999999999999999999999999999),
 pricing text NOT NULL CHECK(pricing IN ('tax_inclusive','tax_exclusive','not_applicable')),state text NOT NULL CHECK(state IN ('active','cancelled')),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
 changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,plan_id,version),
 FOREIGN KEY(academy_id,plan_id,enrollment_id,currency_id) REFERENCES public.tuition_plans(academy_id,id,enrollment_id,currency_id),
 FOREIGN KEY(academy_id,enrollment_id,enrollment_version) REFERENCES public.class_enrollment_revisions(academy_id,enrollment_id,version),
 FOREIGN KEY(academy_id,currency_id,currency_version) REFERENCES public.finance_currency_revisions(academy_id,currency_id,version),
 FOREIGN KEY(academy_id,tax_code_id,tax_code_version) REFERENCES public.finance_tax_code_revisions(academy_id,tax_code_id,version),
 FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),CHECK(net_minor+tax_minor=gross_minor)
);
CREATE TABLE public.tuition_installments(
 academy_id uuid NOT NULL,plan_id uuid NOT NULL,version integer NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 1000),
 due_on date NOT NULL CHECK(due_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 amount_minor numeric NOT NULL CHECK(amount_minor=trunc(amount_minor) AND amount_minor BETWEEN 1 AND 99999999999999999999999999999999999999),
 method_id uuid NOT NULL,method_version integer NOT NULL,
 PRIMARY KEY(academy_id,plan_id,version,ordinal),
 FOREIGN KEY(academy_id,plan_id,version) REFERENCES public.tuition_plan_revisions(academy_id,plan_id,version),
 FOREIGN KEY(academy_id,method_id,method_version) REFERENCES public.finance_payment_method_revisions(academy_id,method_id,version)
);
CREATE INDEX tuition_installments_due ON public.tuition_installments(academy_id,due_on,plan_id,version);
ALTER TABLE public.tuition_plans ADD CONSTRAINT tuition_current_revision FOREIGN KEY(academy_id,id,version)
 REFERENCES public.tuition_plan_revisions(academy_id,plan_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['tuition_plans','tuition_plan_revisions','tuition_installments'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE TRIGGER tuition_header BEFORE INSERT OR UPDATE ON public.tuition_plans FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.guard_tuition_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p public.tuition_plans%ROWTYPE;t public.finance_tax_code_revisions%ROWTYPE;tax_hub uuid;units integer;denominator numeric;expected_tax numeric;
BEGIN
 SELECT * INTO p FROM public.tuition_plans WHERE academy_id=NEW.academy_id AND id=NEW.plan_id;
 SELECT * INTO t FROM public.finance_tax_code_revisions WHERE academy_id=NEW.academy_id AND tax_code_id=NEW.tax_code_id AND version=NEW.tax_code_version;
 SELECT hub_id INTO tax_hub FROM public.finance_tax_codes WHERE academy_id=NEW.academy_id AND id=NEW.tax_code_id;
 SELECT unit_scale INTO units FROM public.finance_currency_revisions WHERE academy_id=NEW.academy_id AND currency_id=NEW.currency_id AND version=NEW.currency_version;
 IF p.version IS DISTINCT FROM NEW.version OR p.unit_scale IS DISTINCT FROM units OR (tax_hub IS NOT NULL AND tax_hub<>p.hub_id) THEN RAISE EXCEPTION 'TUITION_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
 IF (t.classification IN ('exempt','out_of_scope')) IS DISTINCT FROM (NEW.pricing='not_applicable') THEN RAISE EXCEPTION 'TUITION_TAX_PRICING_MISMATCH' USING ERRCODE='23514';END IF;
 denominator=CASE WHEN NEW.pricing='tax_inclusive' THEN 1000000+t.rate_millionths ELSE 1000000 END;
 expected_tax=div(NEW.agreed_minor*t.rate_millionths,denominator)+CASE WHEN mod(NEW.agreed_minor*t.rate_millionths,denominator)*2>=denominator THEN 1 ELSE 0 END;
 IF NEW.tax_minor IS DISTINCT FROM expected_tax OR NEW.net_minor IS DISTINCT FROM (CASE WHEN NEW.pricing='tax_inclusive' THEN NEW.agreed_minor-expected_tax ELSE NEW.agreed_minor END) THEN
  RAISE EXCEPTION 'TUITION_AMOUNT_MISMATCH' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=NEW.academy_id AND a.id=NEW.approval_id AND a.target_id=NEW.plan_id AND a.target_version=NEW.version-1
  AND a.action=CASE WHEN NEW.state='cancelled' THEN 'finance.tuition.cancel' WHEN NEW.version=1 THEN 'finance.tuition.create' ELSE 'finance.tuition.replace' END
  AND a.status IN ('pending','applied') AND a.privacy_capability='tuition.edit') THEN RAISE EXCEPTION 'TUITION_APPROVAL_MISMATCH' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.guard_tuition_installment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tuition_plans p JOIN public.finance_payment_methods m ON m.academy_id=p.academy_id AND m.id=NEW.method_id
  WHERE p.academy_id=NEW.academy_id AND p.id=NEW.plan_id AND (m.hub_id IS NULL OR m.hub_id=p.hub_id)) THEN RAISE EXCEPTION 'TUITION_METHOD_HUB_MISMATCH' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.check_tuition_schedule() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE total numeric;expected numeric;items integer;last_item integer;
BEGIN
 SELECT gross_minor INTO expected FROM public.tuition_plan_revisions WHERE academy_id=NEW.academy_id AND plan_id=NEW.plan_id AND version=NEW.version;
 SELECT coalesce(sum(amount_minor),0),count(*)::integer,coalesce(max(ordinal),0) INTO total,items,last_item FROM public.tuition_installments WHERE academy_id=NEW.academy_id AND plan_id=NEW.plan_id AND version=NEW.version;
 IF total IS DISTINCT FROM expected OR items<>last_item OR (expected=0 AND items<>0) THEN RAISE EXCEPTION 'TUITION_SCHEDULE_MISMATCH' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.guard_tuition_revision(),public.guard_tuition_installment(),public.check_tuition_schedule() FROM PUBLIC;
CREATE TRIGGER tuition_revision BEFORE INSERT ON public.tuition_plan_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_tuition_revision();
CREATE TRIGGER tuition_installment BEFORE INSERT ON public.tuition_installments FOR EACH ROW EXECUTE FUNCTION public.guard_tuition_installment();
-- ponytail: schedules are capped at 1000 rows; repeated deferred aggregates
-- remain bounded. Measure before replacing this with a more complex write API.
CREATE CONSTRAINT TRIGGER tuition_revision_schedule AFTER INSERT ON public.tuition_plan_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_tuition_schedule();
CREATE CONSTRAINT TRIGGER tuition_installment_schedule AFTER INSERT ON public.tuition_installments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_tuition_schedule();
GRANT SELECT ON public.tuition_plans,public.tuition_plan_revisions,public.tuition_installments TO kavosh_runtime;
GRANT INSERT(academy_id,id,enrollment_id,student_id,class_id,hub_id,currency_id,unit_scale,created_by) ON public.tuition_plans TO kavosh_runtime;
GRANT UPDATE(version) ON public.tuition_plans TO kavosh_runtime;
GRANT INSERT ON public.tuition_plan_revisions,public.tuition_installments TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 42 $$;

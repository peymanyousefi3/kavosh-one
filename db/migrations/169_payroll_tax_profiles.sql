-- One worker/employer/calendar-year record,not one allowance per class or hub.
-- These are reviewed declarations;no SIN or government verification is stored.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payroll-tax.view','View private employee/employer annual tax settings','Finance',true,ARRAY['person']),
 ('payroll-tax.edit','Propose reviewed annual employee tax settings','Finance',true,ARRAY['person']);
CREATE TABLE public.payroll_tax_profiles(
 academy_id uuid NOT NULL,id uuid NOT NULL,person_id uuid NOT NULL,person_kind text NOT NULL DEFAULT 'human' CHECK(person_kind='human'),employer_id uuid NOT NULL,tax_year integer NOT NULL CHECK(tax_year BETWEEN 1900 AND 9999),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,person_id,employer_id,tax_year),FOREIGN KEY(academy_id,person_id,person_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,employer_id) REFERENCES public.financial_payees(academy_id,id)
);
CREATE TABLE public.payroll_tax_profile_revisions(
 academy_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),effective_on date NOT NULL,employer_version integer NOT NULL,definition jsonb NOT NULL,source_snapshot jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,profile_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,profile_id) REFERENCES public.payroll_tax_profiles(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.payroll_tax_profiles ADD CONSTRAINT payroll_tax_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.payroll_tax_profile_revisions(academy_id,profile_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX payroll_tax_effective ON public.payroll_tax_profile_revisions(academy_id,profile_id,effective_on DESC,version DESC);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payroll_tax_profiles','payroll_tax_profile_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);EXECUTE format('CREATE TRIGGER payroll_tax_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,person_id,employer_id,tax_year),UPDATE(version) ON public.payroll_tax_profiles TO kavosh_runtime;
GRANT INSERT(academy_id,profile_id,version,effective_on,employer_version,definition,source_snapshot,changed_by,approval_id,reason) ON public.payroll_tax_profile_revisions TO kavosh_runtime;
CREATE FUNCTION public.payroll_tax_header_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYROLL_TAX_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 PERFORM public.lock_hourly_worker(NEW.person_id);
 IF(TG_OP='INSERT' AND NEW.version<>1) OR(TG_OP='UPDATE' AND(NEW.version<>OLD.version+1 OR(to_jsonb(NEW)-'version') IS DISTINCT FROM(to_jsonb(OLD)-'version'))) THEN RAISE EXCEPTION 'PAYROLL_TAX_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER payroll_tax_header_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_tax_profiles FOR EACH ROW EXECUTE FUNCTION public.payroll_tax_header_guard();
CREATE FUNCTION public.payroll_tax_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE k text;v jsonb;s text;keys text[]:=ARRAY['active','countryCode','provinceOfEmployment','federalTd1','provincialDeclaration','additionalIncomeTaxPerPay','incomeTaxExemption','incomeTaxExemptionReference','pension','ei','review'];BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& keys) OR d-keys<>'{}'::jsonb OR octet_length(d::text)>65536 OR jsonb_typeof(d->'active') IS DISTINCT FROM 'boolean' OR d->>'countryCode' IS DISTINCT FROM 'CA' OR d->>'provinceOfEmployment' IS NULL OR d->>'provinceOfEmployment' NOT IN('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT') OR public.work_money_valid(d->'additionalIncomeTaxPerPay',2) IS NOT TRUE OR d->>'incomeTaxExemption' IS NULL OR d->>'incomeTaxExemption' NOT IN('none','declared','needs_review') OR jsonb_typeof(d->'review') IS DISTINCT FROM 'string' OR length(btrim(d->>'review')) NOT BETWEEN 1 AND 2000 OR d->>'review'~'[[:cntrl:]]' THEN RETURN false;END IF;
 v=d->'incomeTaxExemptionReference';IF v<>'null'::jsonb AND(jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(btrim(v#>>'{}')) NOT BETWEEN 1 AND 2000 OR v#>>'{}'~'[[:cntrl:]]') THEN RETURN false;END IF;IF d->>'incomeTaxExemption'='declared' AND v='null'::jsonb THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['federalTd1','provincialDeclaration','pension','ei'] LOOP
  v=d->k;keys=CASE WHEN k IN('federalTd1','provincialDeclaration') THEN ARRAY['status','claimAmount','sourceReference'] WHEN k='pension' THEN ARRAY['plan','status','pensionableMonths','sourceReference'] ELSE ARRAY['status','employerPlan','multiplier','sourceReference'] END;
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& keys) OR v-keys<>'{}'::jsonb THEN RETURN false;END IF;
  IF v->'sourceReference'<>'null'::jsonb AND(jsonb_typeof(v->'sourceReference') IS DISTINCT FROM 'string' OR length(btrim(v->>'sourceReference')) NOT BETWEEN 1 AND 2000 OR v->>'sourceReference'~'[[:cntrl:]]') THEN RETURN false;END IF;
  s=v->>'status';IF s IS NULL THEN RETURN false;END IF;
  IF k IN('federalTd1','provincialDeclaration') THEN
   IF s NOT IN('recorded','not_provided','needs_review') OR(s='recorded' AND(public.work_money_valid(v->'claimAmount',2) IS NOT TRUE OR v->'sourceReference'='null'::jsonb)) OR(s<>'recorded' AND v->'claimAmount'<>'null'::jsonb) THEN RETURN false;END IF;
  ELSE
   IF s NOT IN('subject','exempt','needs_review') OR(s<>'needs_review' AND v->'sourceReference'='null'::jsonb) THEN RETURN false;END IF;
   IF k='pension' THEN
    IF v->>'plan' IS NULL OR v->>'plan' NOT IN('CPP','QPP','needs_review') OR(v->>'plan'='needs_review' AND s<>'needs_review') OR(v->>'plan'<>'needs_review' AND v->>'plan' IS DISTINCT FROM (CASE WHEN d->>'provinceOfEmployment'='QC' THEN 'QPP' ELSE 'CPP' END)) THEN RETURN false;END IF;
    IF s='needs_review' THEN IF v->'pensionableMonths'<>'null'::jsonb THEN RETURN false;END IF;
    ELSE IF jsonb_typeof(v->'pensionableMonths') IS DISTINCT FROM 'number' OR v->>'pensionableMonths'!~'^[0-9]{1,2}$' OR(v->>'pensionableMonths')::integer NOT BETWEEN 0 AND 12 THEN RETURN false;END IF;END IF;
   ELSE
    IF v->>'employerPlan' IS NULL OR v->>'employerPlan' NOT IN('standard_1_4','declared_reduced','needs_review') THEN RETURN false;END IF;
    IF v->>'employerPlan'='needs_review' THEN IF v->'multiplier'<>'null'::jsonb THEN RETURN false;END IF;
    ELSE IF public.work_money_valid(v->'multiplier',4) IS NOT TRUE OR length(v->>'multiplier')>10 OR(v->>'multiplier')::numeric<=0 OR(v->>'multiplier')::numeric>1.4 OR(v->>'employerPlan'='standard_1_4' AND(v->>'multiplier')::numeric<>1.4) OR(v->>'employerPlan'='declared_reduced' AND((v->>'multiplier')::numeric>=1.4 OR v->'sourceReference'='null'::jsonb)) THEN RETURN false;END IF;END IF;
   END IF;
  END IF;
 END LOOP;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.payroll_tax_profile_basis(p_id uuid,i jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE h record;person uuid;employer uuid;y integer;v integer:=coalesce((i->>'expectedVersion')::integer,0);p jsonb;e jsonb;b jsonb;BEGIN
 IF i?'personId' THEN person=(i->>'personId')::uuid;employer=(i#>>'{employer,id}')::uuid;y=(i->>'taxYear')::integer;
 ELSE SELECT * INTO h FROM public.payroll_tax_profiles WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_id;IF NOT FOUND THEN RETURN NULL;END IF;person=h.person_id;employer=h.employer_id;y=h.tax_year;END IF;
 SELECT jsonb_build_object('id',id,'kind',kind,'status',status) INTO p FROM public.people WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=person;
 SELECT jsonb_build_object('id',f.id,'kind',f.kind,'version',r.version,'currentVersion',f.version,'active',r.active,'currentActive',c.active,'legalName',r.legal_name,'name',r.name) INTO e FROM public.financial_payees f JOIN public.financial_payee_revisions r ON r.academy_id=f.academy_id AND r.payee_id=f.id AND r.version=(i#>>'{employer,version}')::integer JOIN public.financial_payee_revisions c ON c.academy_id=f.academy_id AND c.payee_id=f.id AND c.version=f.version WHERE f.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND f.id=employer;
 SELECT jsonb_build_object('version',version,'effectiveOn',effective_on::text,'employerVersion',employer_version,'definition',definition) INTO b FROM public.payroll_tax_profile_revisions WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND profile_id=p_id AND version=v;
 RETURN jsonb_build_object('person',p,'employer',e,'taxYear',y,'before',b);
END $$;
CREATE FUNCTION public.payroll_tax_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;b jsonb;s jsonb;i jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYROLL_TAX_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.payroll_tax_profiles WHERE academy_id=NEW.academy_id AND id=NEW.profile_id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 i=jsonb_build_object('effectiveOn',NEW.effective_on::text,'employer',jsonb_build_object('id',h.employer_id,'version',NEW.employer_version),'definition',NEW.definition,'reason',NEW.reason)||CASE WHEN NEW.version=1 THEN jsonb_build_object('personId',h.person_id,'taxYear',h.tax_year) ELSE jsonb_build_object('expectedVersion',NEW.version-1) END;b=public.payroll_tax_profile_basis(NEW.profile_id,i);
 s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',h.person_id,'hubId',NULL)),'workContext',jsonb_build_object('personId',h.person_id,'hubId',NULL));
 IF h.id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.payroll_tax_profile_revisions WHERE academy_id=NEW.academy_id AND profile_id=NEW.profile_id) OR public.payroll_tax_definition_valid(NEW.definition) IS NOT TRUE OR extract(year FROM NEW.effective_on)::integer<>h.tax_year OR NEW.effective_on NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'
 OR b#>>'{person,kind}' IS DISTINCT FROM 'human' OR b#>>'{employer,kind}' IS DISTINCT FROM 'academy' OR(NEW.definition->'active'='true'::jsonb AND(b#>>'{person,status}' IS DISTINCT FROM 'active' OR b#>'{employer,active}' IS DISTINCT FROM 'true'::jsonb OR b#>'{employer,currentActive}' IS DISTINCT FROM 'true'::jsonb OR b#>'{employer,version}' IS DISTINCT FROM b#>'{employer,currentVersion}'))
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'work.tax-profile.create' ELSE 'work.tax-profile.change' END) OR p.target_id IS DISTINCT FROM NEW.profile_id OR p.target_version<>NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'payroll-tax.view' OR p.scope IS DISTINCT FROM s OR p.payload IS DISTINCT FROM i OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'PAYROLL_TAX_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by=h.person_id AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payroll_tax_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_tax_profile_revisions FOR EACH ROW EXECUTE FUNCTION public.payroll_tax_revision_guard();
CREATE CONSTRAINT TRIGGER payroll_tax_approved AFTER INSERT ON public.payroll_tax_profile_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.payroll_tax_receipt_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.payroll_tax_profile_basis(NEW.profile_id,(SELECT payload FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id)) IS DISTINCT FROM NEW.source_snapshot OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.profile_id AND actor_id=NEW.changed_by AND created_at=transaction_timestamp() AND action=CASE WHEN NEW.version=1 THEN 'work.tax-profile.create' ELSE 'work.tax-profile.change' END AND changes->'version'=to_jsonb(NEW.version) AND changes->>'approvalId'=NEW.approval_id::text AND changes->'severity'='"critical"'::jsonb AND changes->'privateContentRedacted'='true'::jsonb AND changes->'paymentExecuted'='false'::jsonb) THEN RAISE EXCEPTION 'PAYROLL_TAX_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_tax_receipt_required AFTER INSERT ON public.payroll_tax_profile_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_tax_receipt_required();
CREATE FUNCTION public.payroll_tax_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action IN('work.tax-profile.create','work.tax-profile.change') AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.payroll_tax_profile_revisions WHERE academy_id=NEW.academy_id AND profile_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PAYROLL_TAX_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_tax_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_tax_effect_required();
REVOKE ALL ON FUNCTION public.payroll_tax_header_guard(),public.payroll_tax_definition_valid(jsonb),public.payroll_tax_profile_basis(uuid,jsonb),public.payroll_tax_revision_guard(),public.payroll_tax_receipt_required(),public.payroll_tax_effect_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_tax_definition_valid(jsonb),public.payroll_tax_profile_basis(uuid,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 169 $$;

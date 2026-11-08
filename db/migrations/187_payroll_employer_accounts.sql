-- Separate private reporting identity from shared selectable payee labels.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payroll-employers.view','View private employer payroll reporting accounts','Finance',true,ARRAY['academy']),
 ('payroll-employers.edit','Propose employer payroll reporting account editions','Finance',true,ARRAY['academy']);
CREATE TABLE public.payroll_employer_accounts(
 academy_id uuid NOT NULL,id uuid NOT NULL,employer_id uuid NOT NULL,code text NOT NULL CHECK(code~'^[A-Z0-9][A-Z0-9._-]{0,31}$'),account_number text NOT NULL CHECK(account_number~'^[0-9]{9}RP[0-9]{4}$'),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,code),UNIQUE(academy_id,account_number),FOREIGN KEY(academy_id,employer_id) REFERENCES public.financial_payees(academy_id,id)
);
CREATE TABLE public.payroll_employer_revisions(
 academy_id uuid NOT NULL,account_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),effective_on date NOT NULL CHECK(effective_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),employer_version integer NOT NULL,definition jsonb NOT NULL,source_snapshot jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,account_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,account_id) REFERENCES public.payroll_employer_accounts(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.payroll_employer_accounts ADD CONSTRAINT payroll_employer_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.payroll_employer_revisions(academy_id,account_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX payroll_employer_effective ON public.payroll_employer_revisions(academy_id,account_id,effective_on DESC,version DESC);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payroll_employer_accounts','payroll_employer_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);EXECUTE format('CREATE TRIGGER payroll_employer_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,employer_id,code,account_number),UPDATE(version) ON public.payroll_employer_accounts TO kavosh_runtime;
GRANT INSERT(academy_id,account_id,version,effective_on,employer_version,definition,source_snapshot,changed_by,approval_id,reason) ON public.payroll_employer_revisions TO kavosh_runtime;
CREATE FUNCTION public.payroll_employer_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE a jsonb;v jsonb;k text;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d?&ARRAY['active','address','review']) OR d-ARRAY['active','address','review']<>'{}'::jsonb OR octet_length(d::text)>16384 OR jsonb_typeof(d->'active') IS DISTINCT FROM 'boolean' OR jsonb_typeof(d->'review') IS DISTINCT FROM 'string' OR length(btrim(d->>'review')) NOT BETWEEN 1 AND 2000 OR d->>'review'~'[[:cntrl:]]' THEN RETURN false;END IF;
 a=d->'address';IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a?&ARRAY['lines','city','region','postalCode','countryCode']) OR a-ARRAY['lines','city','region','postalCode','countryCode']<>'{}'::jsonb OR jsonb_typeof(a->'countryCode') IS DISTINCT FROM 'string' OR a->>'countryCode'!~'^[A-Z]{2}$' OR jsonb_typeof(a->'city') IS DISTINCT FROM 'string' OR length(btrim(a->>'city')) NOT BETWEEN 1 AND 100 OR a->>'city'~'[[:cntrl:]]' THEN RETURN false;END IF;
 IF jsonb_typeof(a->'lines') IS DISTINCT FROM 'array' THEN RETURN false;END IF;IF jsonb_array_length(a->'lines') NOT BETWEEN 1 AND 3 THEN RETURN false;END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(a->'lines') LOOP IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(btrim(v#>>'{}')) NOT BETWEEN 1 AND 200 OR v#>>'{}'~'[[:cntrl:]]' THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['region','postalCode'] LOOP v=a->k;IF v<>'null'::jsonb AND(jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(btrim(v#>>'{}')) NOT BETWEEN 1 AND(CASE WHEN k='region' THEN 100 ELSE 32 END) OR v#>>'{}'~'[[:cntrl:]]') THEN RETURN false;END IF;END LOOP;RETURN true;
END $$;
CREATE FUNCTION public.payroll_employer_basis(p_id uuid,i jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE h record;e jsonb;b jsonb;employer uuid;v integer:=coalesce((i->>'expectedVersion')::integer,0);BEGIN
 employer=(i#>>'{employer,id}')::uuid;
 SELECT jsonb_build_object('id',f.id,'kind',f.kind,'version',r.version,'currentVersion',f.version,'active',r.active,'currentActive',c.active,'legalName',r.legal_name,'name',r.name) INTO e FROM public.financial_payees f JOIN public.financial_payee_revisions r ON r.academy_id=f.academy_id AND r.payee_id=f.id AND r.version=(i#>>'{employer,version}')::integer JOIN public.financial_payee_revisions c ON c.academy_id=f.academy_id AND c.payee_id=f.id AND c.version=f.version WHERE f.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND f.id=employer;
 SELECT jsonb_build_object('version',version,'effectiveOn',effective_on::text,'employerVersion',employer_version,'definition',definition) INTO b FROM public.payroll_employer_revisions WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND account_id=p_id AND version=v;
 RETURN jsonb_build_object('employer',e,'before',b);
END $$;
CREATE FUNCTION public.payroll_employer_header_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYROLL_EMPLOYER_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 IF(TG_OP='INSERT' AND NEW.version<>1) OR(TG_OP='UPDATE' AND(NEW.version<>OLD.version+1 OR(to_jsonb(NEW)-'version') IS DISTINCT FROM(to_jsonb(OLD)-'version'))) THEN RAISE EXCEPTION 'PAYROLL_EMPLOYER_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER payroll_employer_header_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_employer_accounts FOR EACH ROW EXECUTE FUNCTION public.payroll_employer_header_guard();
CREATE FUNCTION public.payroll_employer_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;b jsonb;i jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYROLL_EMPLOYER_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.payroll_employer_accounts WHERE academy_id=NEW.academy_id AND id=NEW.account_id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 i=jsonb_build_object('effectiveOn',NEW.effective_on::text,'employer',jsonb_build_object('id',h.employer_id,'version',NEW.employer_version),'definition',NEW.definition,'reason',NEW.reason)||CASE WHEN NEW.version=1 THEN jsonb_build_object('code',h.code,'accountNumber',h.account_number) ELSE jsonb_build_object('expectedVersion',NEW.version-1) END;b=public.payroll_employer_basis(NEW.account_id,i);
 IF h.id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.payroll_employer_revisions WHERE academy_id=NEW.academy_id AND account_id=NEW.account_id) OR public.payroll_employer_definition_valid(NEW.definition) IS NOT TRUE
 OR b#>>'{employer,kind}' IS DISTINCT FROM 'academy' OR b#>'{employer,version}' IS DISTINCT FROM b#>'{employer,currentVersion}' OR(NEW.definition->'active'='true'::jsonb AND(b#>'{employer,active}' IS DISTINCT FROM 'true'::jsonb OR b#>'{employer,currentActive}' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(b#>'{employer,legalName}') IS DISTINCT FROM 'string' OR length(btrim(b#>>'{employer,legalName}'))=0))
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'work.payroll-employer.create' ELSE 'work.payroll-employer.change' END) OR p.target_id IS DISTINCT FROM NEW.account_id OR p.target_version<>NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'payroll-employers.view' OR p.scope IS DISTINCT FROM '{"all":true,"hubs":[]}'::jsonb OR p.payload IS DISTINCT FROM i OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'PAYROLL_EMPLOYER_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payroll_employer_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_employer_revisions FOR EACH ROW EXECUTE FUNCTION public.payroll_employer_revision_guard();
CREATE CONSTRAINT TRIGGER payroll_employer_approved AFTER INSERT ON public.payroll_employer_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.payroll_employer_receipt_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.payroll_employer_basis(NEW.account_id,(SELECT payload FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id)) IS DISTINCT FROM NEW.source_snapshot OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.account_id AND actor_id=NEW.changed_by AND created_at=transaction_timestamp() AND action=CASE WHEN NEW.version=1 THEN 'work.payroll-employer.create' ELSE 'work.payroll-employer.change' END AND changes->'version'=to_jsonb(NEW.version) AND changes->>'approvalId'=NEW.approval_id::text AND changes->'severity'='"critical"'::jsonb AND changes->'privateContentRedacted'='true'::jsonb AND changes->'paymentExecuted'='false'::jsonb) THEN RAISE EXCEPTION 'PAYROLL_EMPLOYER_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_employer_receipt_required AFTER INSERT ON public.payroll_employer_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_employer_receipt_required();
CREATE FUNCTION public.payroll_employer_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action IN('work.payroll-employer.create','work.payroll-employer.change') AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.payroll_employer_revisions WHERE academy_id=NEW.academy_id AND account_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PAYROLL_EMPLOYER_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_employer_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_employer_effect_required();
REVOKE ALL ON FUNCTION public.payroll_employer_definition_valid(jsonb),public.payroll_employer_basis(uuid,jsonb),public.payroll_employer_header_guard(),public.payroll_employer_revision_guard(),public.payroll_employer_receipt_required(),public.payroll_employer_effect_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_employer_definition_valid(jsonb),public.payroll_employer_basis(uuid,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 187 $$;

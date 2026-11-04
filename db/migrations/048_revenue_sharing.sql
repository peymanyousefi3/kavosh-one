INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payees.view','View permitted named financial payees','Finance',true,ARRAY['hub','country','region','city']),
 ('payees.edit','Request reviewed financial payee changes','Finance',true,ARRAY['hub','country','region','city']),
 ('share-rules.view','View permitted private tuition revenue-sharing agreements','Finance',true,ARRAY['hub','class','person','country','region','city']),
 ('share-rules.edit','Request reviewed tuition revenue-sharing agreements','Finance',true,ARRAY['hub','class','person','country','region','city']);
CREATE TABLE public.financial_payees(
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,hub_id uuid,person_id uuid,person_kind text NOT NULL DEFAULT 'human' CHECK(person_kind='human'),
 kind text NOT NULL CHECK(kind IN ('academy','hub','person','organization')),code text NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(academy_id,id),
 UNIQUE NULLS NOT DISTINCT(academy_id,hub_id,code),CHECK((kind='person')=(person_id IS NOT NULL)),CHECK(kind<>'hub' OR hub_id IS NOT NULL),CHECK(kind<>'academy' OR hub_id IS NULL),
 FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,person_id,person_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE UNIQUE INDEX payee_academy_identity ON public.financial_payees(academy_id) WHERE kind='academy';
CREATE UNIQUE INDEX payee_hub_identity ON public.financial_payees(academy_id,hub_id) WHERE kind='hub';
CREATE UNIQUE INDEX payee_person_identity ON public.financial_payees(academy_id,person_id) WHERE kind='person';
CREATE INDEX financial_payees_hub ON public.financial_payees(academy_id,hub_id,id);
CREATE TABLE public.financial_payee_revisions(
 academy_id uuid NOT NULL,payee_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),legal_name text CHECK(length(legal_name) BETWEEN 1 AND 200),active boolean NOT NULL,
 changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(academy_id,payee_id,version),
 FOREIGN KEY(academy_id,payee_id) REFERENCES public.financial_payees(academy_id,id),FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.financial_payees ADD CONSTRAINT payee_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.financial_payee_revisions(academy_id,payee_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER payee_header BEFORE INSERT OR UPDATE ON public.financial_payees FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.guard_payee_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.financial_payees h WHERE h.academy_id=NEW.academy_id AND h.id=NEW.payee_id AND h.version=NEW.version)
  OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.payee_id AND p.target_version=NEW.version-1 AND p.status IN ('pending','applied') AND p.privacy_capability='payees.edit' AND p.action=CASE WHEN NEW.version=1 THEN 'finance.payee.create' ELSE 'finance.payee.replace' END) THEN RAISE EXCEPTION 'PAYEE_APPROVAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER payee_revision BEFORE INSERT ON public.financial_payee_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_payee_revision();
CREATE TABLE public.revenue_share_plans(
 academy_id uuid NOT NULL,id uuid NOT NULL,tuition_plan_id uuid NOT NULL,student_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,tuition_plan_id),FOREIGN KEY(academy_id,tuition_plan_id,student_id,class_id,hub_id) REFERENCES public.tuition_plans(academy_id,id,student_id,class_id,hub_id)
);
CREATE INDEX revenue_share_student ON public.revenue_share_plans(academy_id,student_id,id);
CREATE INDEX revenue_share_hub ON public.revenue_share_plans(academy_id,hub_id,id);
CREATE TABLE public.revenue_share_revisions(
 academy_id uuid NOT NULL,plan_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),tuition_plan_id uuid NOT NULL,tuition_version integer NOT NULL,
 basis text NOT NULL CHECK(basis IN ('net_tuition','gross_tuition')),credit_handling text NOT NULL CHECK(credit_handling IN ('retain_collections','cancel_on_credit')),active boolean NOT NULL,
 allow_overallocation boolean NOT NULL,override_reason text NOT NULL CHECK(length(override_reason)<=2000),base_minor numeric NOT NULL CHECK(base_minor=trunc(base_minor) AND base_minor>=0 AND base_minor<1e38),full_fee_total numeric NOT NULL CHECK(full_fee_total=trunc(full_fee_total) AND full_fee_total>=0),line_count integer NOT NULL CHECK(line_count BETWEEN 0 AND 100),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,plan_id,version),CHECK(NOT allow_overallocation OR length(override_reason)>0),FOREIGN KEY(academy_id,plan_id) REFERENCES public.revenue_share_plans(academy_id,id),
 FOREIGN KEY(academy_id,tuition_plan_id,tuition_version) REFERENCES public.tuition_plan_revisions(academy_id,plan_id,version),FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.revenue_share_lines(
 academy_id uuid NOT NULL,plan_id uuid NOT NULL,version integer NOT NULL,payee_id uuid NOT NULL,payee_version integer NOT NULL,
 method text NOT NULL CHECK(method IN ('percentage','flat')),value numeric NOT NULL CHECK(value=trunc(value) AND value>=0 AND value<1e38),release text NOT NULL CHECK(release IN ('proportional','first_collection','fully_collected','on_invoice')),
 PRIMARY KEY(academy_id,plan_id,version,payee_id),CHECK(method<>'percentage' OR value<=1000000),FOREIGN KEY(academy_id,plan_id,version) REFERENCES public.revenue_share_revisions(academy_id,plan_id,version),FOREIGN KEY(academy_id,payee_id,payee_version) REFERENCES public.financial_payee_revisions(academy_id,payee_id,version)
);
ALTER TABLE public.revenue_share_plans ADD CONSTRAINT revenue_share_current FOREIGN KEY(academy_id,id,version) REFERENCES public.revenue_share_revisions(academy_id,plan_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER revenue_share_header BEFORE INSERT OR UPDATE ON public.revenue_share_plans FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['financial_payees','financial_payee_revisions','revenue_share_plans','revenue_share_revisions','revenue_share_lines'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
 END LOOP;
END $$;
CREATE FUNCTION public.guard_revenue_share_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;t record;BEGIN
 SELECT * INTO h FROM public.revenue_share_plans WHERE academy_id=NEW.academy_id AND id=NEW.plan_id;
 SELECT p.version,r.state,r.net_minor,r.gross_minor INTO t FROM public.tuition_plans p JOIN public.tuition_plan_revisions r ON r.academy_id=p.academy_id AND r.plan_id=p.id AND r.version=NEW.tuition_version WHERE p.academy_id=NEW.academy_id AND p.id=NEW.tuition_plan_id;
 IF h.version IS DISTINCT FROM NEW.version OR h.tuition_plan_id IS DISTINCT FROM NEW.tuition_plan_id OR t.version IS DISTINCT FROM NEW.tuition_version OR(NEW.active AND t.state<>'active') OR NEW.base_minor IS DISTINCT FROM(CASE WHEN NEW.basis='net_tuition' THEN t.net_minor ELSE t.gross_minor END)
  OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.plan_id AND p.target_version=NEW.version-1 AND p.action='finance.sharing.replace' AND p.privacy_capability='share-rules.edit' AND p.status IN ('pending','applied')) THEN RAISE EXCEPTION 'SHARING_SOURCE_OR_APPROVAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER revenue_share_revision BEFORE INSERT ON public.revenue_share_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_revenue_share_revision();
-- Independent exact largest-remainder calculation. ASCII keys and C collation
-- match the application's stable UUID tie-break, not a database locale.
CREATE FUNCTION public.revenue_share_full_amounts(p_academy uuid,p_plan uuid,p_version integer) RETURNS TABLE(payee_id uuid,full_minor numeric) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH definition AS(SELECT base_minor FROM public.revenue_share_revisions WHERE academy_id=p_academy AND plan_id=p_plan AND version=p_version),weights AS(
  SELECT l.payee_id,'p:'||l.payee_id::text AS key,l.value AS weight FROM public.revenue_share_lines l WHERE l.academy_id=p_academy AND l.plan_id=p_plan AND l.version=p_version AND l.method='percentage'
  UNION ALL SELECT NULL::uuid,'r:academy',1000000-coalesce((SELECT sum(value) FROM public.revenue_share_lines WHERE academy_id=p_academy AND plan_id=p_plan AND version=p_version AND method='percentage'),0)),
 quotas AS(SELECT w.*,div(d.base_minor*w.weight,1000000) AS floor_amount,mod(d.base_minor*w.weight,1000000) AS remainder FROM weights w CROSS JOIN definition d),
 ranked AS(SELECT *,row_number() OVER(ORDER BY remainder DESC,key COLLATE "C") AS rank FROM quotas),
 amounts AS(SELECT r.payee_id,r.floor_amount+CASE WHEN r.rank<=(SELECT d.base_minor-coalesce(sum(q.floor_amount),0) FROM definition d CROSS JOIN quotas q GROUP BY d.base_minor) THEN 1 ELSE 0 END AS amount FROM ranked r)
 SELECT l.payee_id,CASE WHEN l.method='flat' THEN l.value ELSE a.amount END FROM public.revenue_share_lines l LEFT JOIN amounts a ON a.payee_id=l.payee_id WHERE l.academy_id=p_academy AND l.plan_id=p_plan AND l.version=p_version
$$;
CREATE FUNCTION public.validate_revenue_share_complete(p_academy uuid,p_plan uuid,p_version integer) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record;n integer;pct numeric;total numeric;BEGIN
 SELECT * INTO r FROM public.revenue_share_revisions WHERE academy_id=p_academy AND plan_id=p_plan AND version=p_version;
 SELECT count(*),coalesce(sum(value) FILTER(WHERE method='percentage'),0) INTO n,pct FROM public.revenue_share_lines WHERE academy_id=p_academy AND plan_id=p_plan AND version=p_version;
 IF r.plan_id IS NULL OR n<>r.line_count OR pct>1000000 OR NOT EXISTS(SELECT 1 FROM public.revenue_share_plans h WHERE h.academy_id=p_academy AND h.id=p_plan AND h.version=p_version) THEN RAISE EXCEPTION 'SHARING_LINES_INVALID' USING ERRCODE='23514';END IF;
 IF r.active AND EXISTS(SELECT 1 FROM public.revenue_share_lines l JOIN public.financial_payees p ON p.academy_id=l.academy_id AND p.id=l.payee_id JOIN public.financial_payee_revisions v ON v.academy_id=l.academy_id AND v.payee_id=l.payee_id AND v.version=l.payee_version WHERE l.academy_id=p_academy AND l.plan_id=p_plan AND l.version=p_version AND(p.version<>l.payee_version OR NOT v.active)) THEN RAISE EXCEPTION 'ACTIVE_CURRENT_SHARE_PAYEE_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT coalesce(sum(full_minor),0) INTO total FROM public.revenue_share_full_amounts(p_academy,p_plan,p_version);
 IF total IS DISTINCT FROM r.full_fee_total OR(total>r.base_minor AND NOT r.allow_overallocation) THEN RAISE EXCEPTION 'SHARING_TOTAL_INVALID' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION public.check_revenue_share_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE k record;BEGIN
 IF TG_LEVEL='ROW' THEN PERFORM public.validate_revenue_share_complete(NEW.academy_id,NEW.plan_id,NEW.version);
 ELSE FOR k IN SELECT DISTINCT academy_id,plan_id,version FROM inserted_share_lines LOOP PERFORM public.validate_revenue_share_complete(k.academy_id,k.plan_id,k.version);END LOOP;END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER revenue_share_complete AFTER INSERT ON public.revenue_share_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_revenue_share_complete();
CREATE TRIGGER revenue_share_lines_complete AFTER INSERT ON public.revenue_share_lines REFERENCING NEW TABLE AS inserted_share_lines FOR EACH STATEMENT EXECUTE FUNCTION public.check_revenue_share_complete();
REVOKE ALL ON FUNCTION public.guard_payee_revision(),public.guard_revenue_share_revision(),public.revenue_share_full_amounts(uuid,uuid,integer),public.validate_revenue_share_complete(uuid,uuid,integer),public.check_revenue_share_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revenue_share_full_amounts(uuid,uuid,integer),public.validate_revenue_share_complete(uuid,uuid,integer) TO kavosh_runtime;
GRANT SELECT ON public.financial_payees,public.financial_payee_revisions,public.revenue_share_plans,public.revenue_share_revisions,public.revenue_share_lines TO kavosh_runtime;
GRANT INSERT(academy_id,id,hub_id,person_id,kind,code,created_by) ON public.financial_payees TO kavosh_runtime;
GRANT UPDATE(version) ON public.financial_payees TO kavosh_runtime;
GRANT INSERT ON public.financial_payee_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,id,tuition_plan_id,student_id,class_id,hub_id) ON public.revenue_share_plans TO kavosh_runtime;
GRANT UPDATE(version) ON public.revenue_share_plans TO kavosh_runtime;
GRANT INSERT ON public.revenue_share_revisions,public.revenue_share_lines TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 48 $$;

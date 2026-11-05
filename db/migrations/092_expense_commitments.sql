INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('expense-commitments.view','View permitted scheduled expense estimates and commitments','Finance',true,ARRAY['hub','country','region','city']),
 ('expense-commitments.edit','Propose reviewed scheduled expense commitments and revisions','Finance',true,ARRAY['hub','country','region','city']);
CREATE FUNCTION public.expense_schedule_date(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE d date;BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR(v#>>'{}')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;d=(v#>>'{}')::date;RETURN d BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND to_char(d,'YYYY-MM-DD')=v#>>'{}';
 EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION public.expense_schedule_valid(s jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE keys text[];k text;BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR s->>'kind' IS NULL OR s->>'kind' NOT IN('monthly','weekly','biweekly','yearly','custom') THEN RETURN false;END IF;
 keys=CASE s->>'kind' WHEN 'monthly' THEN ARRAY['kind','day','shortMonth'] WHEN 'weekly' THEN ARRAY['kind','weekday'] WHEN 'biweekly' THEN ARRAY['kind','anchorOn'] WHEN 'yearly' THEN ARRAY['kind','month','day','shortMonth'] ELSE ARRAY['kind','dates'] END;
 IF NOT(s ?& keys) OR s-keys<>'{}'::jsonb THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['day','month','weekday'] LOOP IF k=ANY(keys) AND(jsonb_typeof(s->k) IS DISTINCT FROM 'number' OR(s->>k)::numeric<>trunc((s->>k)::numeric) OR(s->>k)::numeric NOT BETWEEN 1 AND CASE k WHEN 'month' THEN 12 WHEN 'weekday' THEN 7 ELSE 31 END) THEN RETURN false;END IF;END LOOP;
 IF 'shortMonth'=ANY(keys) AND(s->>'shortMonth' IS NULL OR s->>'shortMonth' NOT IN('last_day','skip')) THEN RETURN false;END IF;
 IF s->>'kind'='yearly' AND s->>'shortMonth'='skip' THEN PERFORM make_date(2000,(s->>'month')::integer,(s->>'day')::integer);END IF;
 IF s->>'kind'='biweekly' AND NOT public.expense_schedule_date(s->'anchorOn') THEN RETURN false;END IF;
 IF s->>'kind'='custom' THEN IF jsonb_typeof(s->'dates') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(s->'dates') NOT BETWEEN 1 AND 200 OR(SELECT count(DISTINCT d) FROM jsonb_array_elements(s->'dates') d)<>jsonb_array_length(s->'dates') OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'dates') d WHERE NOT public.expense_schedule_date(d)) THEN RETURN false;END IF;
 END IF;RETURN true;EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION public.expense_schedule_occurs(s jsonb,on_date date) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE last_day integer;day integer;BEGIN
 IF on_date IS NULL OR NOT public.expense_schedule_valid(s) THEN RETURN false;END IF;
 IF s->>'kind'='custom' THEN RETURN s->'dates' ? to_char(on_date,'YYYY-MM-DD');END IF;
 IF s->>'kind'='weekly' THEN RETURN extract(isodow FROM on_date)::integer=(s->>'weekday')::integer;END IF;
 IF s->>'kind'='biweekly' THEN RETURN on_date>=(s->>'anchorOn')::date AND(on_date-(s->>'anchorOn')::date)%14=0;END IF;
 IF s->>'kind'='yearly' AND extract(month FROM on_date)::integer<>(s->>'month')::integer THEN RETURN false;END IF;
 last_day=extract(day FROM(date_trunc('month',on_date::timestamp)+interval '1 month - 1 day'))::integer;day=(s->>'day')::integer;
 RETURN extract(day FROM on_date)::integer=CASE WHEN s->>'shortMonth'='last_day' THEN least(day,last_day) ELSE day END;
END $$;
CREATE FUNCTION public.expense_commitment_definition_valid(d jsonb,scale integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE l jsonb;total numeric:=0;keys text[]:=ARRAY['name','active','startsOn','endsOn','confidence','schedule','lines','taxReview'];BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& keys) OR d-keys<>'{}'::jsonb OR octet_length(d::text)>65536 OR jsonb_typeof(d->'name') IS DISTINCT FROM 'string' OR length(btrim(d->>'name')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(d->'taxReview') IS DISTINCT FROM 'string' OR length(btrim(d->>'taxReview')) NOT BETWEEN 1 AND 2000
 OR jsonb_typeof(d->'active') IS DISTINCT FROM 'boolean' OR d->>'confidence' IS NULL OR d->>'confidence' NOT IN('contracted','estimated') OR NOT public.expense_schedule_date(d->'startsOn') OR(d->'endsOn'<>'null'::jsonb AND(NOT public.expense_schedule_date(d->'endsOn') OR d->>'endsOn'<d->>'startsOn')) OR NOT public.expense_schedule_valid(d->'schedule') OR jsonb_typeof(d->'lines') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF scale NOT BETWEEN 0 AND 18 OR jsonb_array_length(d->'lines') NOT BETWEEN 1 AND 50 THEN RETURN false;END IF;
 FOR l IN SELECT * FROM jsonb_array_elements(d->'lines') LOOP
  keys=ARRAY['hubId','classId','studentId','description','amount'];IF jsonb_typeof(l) IS DISTINCT FROM 'object' OR NOT(l ?& keys) OR l-keys<>'{}'::jsonb OR jsonb_typeof(l->'description') IS DISTINCT FROM 'string' OR length(btrim(l->>'description')) NOT BETWEEN 1 AND 500 OR NOT public.work_money_valid(l->'amount',scale) THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['hubId','classId','studentId']) k WHERE l->k<>'null'::jsonb AND(jsonb_typeof(l->k) IS DISTINCT FROM 'string' OR(l->>k)::uuid IS NULL)) OR(l->'hubId'='null'::jsonb AND(l->'classId'<>'null'::jsonb OR l->'studentId'<>'null'::jsonb)) THEN RETURN false;END IF;
  IF(l->>'amount')::numeric<=0 THEN RETURN false;END IF;total=total+(l->>'amount')::numeric*power(10::numeric,scale);
 END LOOP;RETURN total>0 AND total<1e38;EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION public.expense_commitment_scope(lines jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('all',coalesce(bool_or(l->'hubId'='null'::jsonb),false),'hubs',coalesce(jsonb_agg(DISTINCT l->'hubId') FILTER(WHERE l->'hubId'<>'null'::jsonb),'[]'::jsonb)) FROM jsonb_array_elements(lines) l
$$;
CREATE TABLE public.expense_commitments(
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,code text NOT NULL CHECK(code~'^[A-Z0-9][A-Z0-9._-]{0,63}$'),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,code)
);
CREATE TABLE public.expense_commitment_revisions(
 academy_id uuid NOT NULL,commitment_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),effective_on date NOT NULL CHECK(effective_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),currency_id uuid NOT NULL,currency_version integer NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),payee_id uuid NOT NULL,payee_version integer NOT NULL,
 definition jsonb NOT NULL CHECK(public.expense_commitment_definition_valid(definition,unit_scale)),gross_minor numeric NOT NULL CHECK(gross_minor>0 AND gross_minor<1e38 AND gross_minor=trunc(gross_minor)),source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,commitment_id,version),FOREIGN KEY(academy_id,commitment_id) REFERENCES public.expense_commitments(academy_id,id),FOREIGN KEY(academy_id,currency_id,currency_version) REFERENCES public.finance_currency_revisions(academy_id,currency_id,version),FOREIGN KEY(academy_id,payee_id,payee_version) REFERENCES public.financial_payee_revisions(academy_id,payee_id,version),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.expense_commitments ADD FOREIGN KEY(academy_id,id,version) REFERENCES public.expense_commitment_revisions(academy_id,commitment_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX expense_commitment_effective ON public.expense_commitment_revisions(academy_id,commitment_id,effective_on DESC,version DESC);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['expense_commitments','expense_commitment_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,code) ON public.expense_commitments TO kavosh_runtime;
GRANT UPDATE(version) ON public.expense_commitments TO kavosh_runtime;
GRANT INSERT(academy_id,commitment_id,version,effective_on,currency_id,currency_version,unit_scale,payee_id,payee_version,definition,gross_minor,source_snapshot,changed_by,approval_id,reason) ON public.expense_commitment_revisions TO kavosh_runtime;
CREATE TRIGGER expense_commitment_header BEFORE INSERT OR UPDATE ON public.expense_commitments FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.guard_expense_commitment_write() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF nullif(current_setting('app.academy_id',true),'') IS NOT NULL THEN PERFORM public.lock_finance_book();PERFORM pg_advisory_xact_lock_shared(hashtextextended(current_setting('app.academy_id'),9));END IF;RETURN NULL;END $$;
CREATE TRIGGER expense_commitment_write BEFORE INSERT OR UPDATE OR DELETE ON public.expense_commitments FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write();
CREATE TRIGGER expense_commitment_write BEFORE INSERT OR UPDATE OR DELETE ON public.expense_commitment_revisions FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write();
CREATE FUNCTION public.lock_expense_commitment_sources(p_currency uuid,p_payee uuid,lines jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;BEGIN
 -- Stable current-source headers through commit, not only a final read that
 -- could race a non-key version/status update. All roles already have the
 -- necessary narrow update grants; no immutable revision privilege is added.
 PERFORM public.lock_finance_book();PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 PERFORM id FROM public.finance_currencies WHERE academy_id=tenant AND id=p_currency FOR SHARE;
 PERFORM id FROM public.financial_payees WHERE academy_id=tenant AND id=p_payee FOR SHARE;
 PERFORM id FROM public.hubs WHERE academy_id=tenant AND id IN(SELECT(l->>'hubId')::uuid FROM jsonb_array_elements(lines) l) ORDER BY id FOR SHARE;
 PERFORM id FROM public.classes WHERE academy_id=tenant AND id IN(SELECT(l->>'classId')::uuid FROM jsonb_array_elements(lines) l) ORDER BY id FOR SHARE;
 PERFORM id FROM public.people WHERE academy_id=tenant AND id IN(SELECT(l->>'studentId')::uuid FROM jsonb_array_elements(lines) l) ORDER BY id FOR SHARE;
 PERFORM person_id FROM public.student_profiles WHERE academy_id=tenant AND person_id IN(SELECT(l->>'studentId')::uuid FROM jsonb_array_elements(lines) l) ORDER BY person_id FOR SHARE;
END $$;
CREATE FUNCTION public.expense_commitment_sources(p_currency uuid,p_cv integer,p_payee uuid,p_pv integer,lines jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;currency jsonb;payee jsonb;locations jsonb;l jsonb;h jsonb;c jsonb;student jsonb;BEGIN
 PERFORM public.lock_expense_commitment_sources(p_currency,p_payee,lines);
 SELECT jsonb_build_object('id',x.id,'version',r.version,'unitScale',r.unit_scale,'code',x.code,'active',r.active,'currentVersion',x.version,'currentActive',v.active) INTO currency FROM public.finance_currencies x JOIN public.finance_currency_revisions r ON r.academy_id=x.academy_id AND r.currency_id=x.id AND r.version=p_cv JOIN public.finance_currency_revisions v ON v.academy_id=x.academy_id AND v.currency_id=x.id AND v.version=x.version WHERE x.academy_id=tenant AND x.id=p_currency;
 SELECT jsonb_build_object('id',x.id,'version',r.version,'name',r.name,'kind',x.kind,'hubId',x.hub_id,'personId',x.person_id,'active',r.active,'currentVersion',x.version,'currentActive',v.active) INTO payee FROM public.financial_payees x JOIN public.financial_payee_revisions r ON r.academy_id=x.academy_id AND r.payee_id=x.id AND r.version=p_pv JOIN public.financial_payee_revisions v ON v.academy_id=x.academy_id AND v.payee_id=x.id AND v.version=x.version WHERE x.academy_id=tenant AND x.id=p_payee;
 IF currency IS NULL OR payee IS NULL OR payee->>'kind'='academy' THEN RETURN NULL;END IF;locations='[]'::jsonb;
 FOR l IN SELECT * FROM jsonb_array_elements(lines) LOOP
  h=NULL;c=NULL;student=NULL;
  IF l->'hubId'<>'null'::jsonb THEN SELECT jsonb_build_object('id',id,'version',version,'active',active) INTO h FROM public.hubs WHERE academy_id=tenant AND id=(l->>'hubId')::uuid;IF NOT FOUND THEN RETURN NULL;END IF;END IF;
  IF payee->'hubId'<>'null'::jsonb AND payee->>'hubId' IS DISTINCT FROM l->>'hubId' THEN RETURN NULL;END IF;
  IF l->'classId'<>'null'::jsonb THEN SELECT jsonb_build_object('id',id,'version',version,'active',active) INTO c FROM public.classes WHERE academy_id=tenant AND id=(l->>'classId')::uuid AND hub_id=(l->>'hubId')::uuid;IF NOT FOUND THEN RETURN NULL;END IF;END IF;
  IF l->'studentId'<>'null'::jsonb THEN SELECT jsonb_build_object('id',p.id,'version',s.version,'status',p.status) INTO student FROM public.people p JOIN public.student_profiles s ON s.academy_id=p.academy_id AND s.person_id=p.id WHERE p.academy_id=tenant AND p.id=(l->>'studentId')::uuid;IF NOT FOUND THEN RETURN NULL;END IF;END IF;
  locations=locations||jsonb_build_array(jsonb_build_object('hub',h,'class',c,'student',student));
 END LOOP;RETURN jsonb_build_object('currency',currency,'payee',payee,'locations',locations);
END $$;
CREATE FUNCTION public.guard_expense_commitment_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;e record;before jsonb;sources jsonb;wanted numeric;scope jsonb;BEGIN
 SELECT * INTO e FROM public.expense_commitments WHERE academy_id=NEW.academy_id AND id=NEW.commitment_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 -- Money stays a JSON string before leaving PostgreSQL: JSON numeric parsing
 -- would silently round an otherwise exact revision above JavaScript 2^53.
 SELECT to_jsonb(r)||jsonb_build_object('gross_minor',r.gross_minor::text) INTO before FROM public.expense_commitment_revisions r WHERE academy_id=NEW.academy_id AND commitment_id=NEW.commitment_id AND version=NEW.version-1;
 sources=public.expense_commitment_sources(NEW.currency_id,NEW.currency_version,NEW.payee_id,NEW.payee_version,NEW.definition->'lines');scope=public.expense_commitment_scope(coalesce(before#>'{definition,lines}','[]'::jsonb)||(NEW.definition->'lines'));
 SELECT sum((l->>'amount')::numeric*power(10::numeric,NEW.unit_scale)) INTO wanted FROM jsonb_array_elements(NEW.definition->'lines') l;
 IF e.id IS NULL OR e.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.expense_commitment_revisions WHERE academy_id=NEW.academy_id AND commitment_id=NEW.commitment_id) OR sources IS NULL OR NEW.source_snapshot IS DISTINCT FROM sources OR NEW.gross_minor IS DISTINCT FROM wanted OR NEW.unit_scale IS DISTINCT FROM(sources#>>'{currency,unitScale}')::integer OR NEW.effective_on<(NEW.definition->>'startsOn')::date THEN RAISE EXCEPTION 'EXPENSE_COMMITMENT_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 IF p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'finance.expense-commitment.create' ELSE 'finance.expense-commitment.change' END) OR p.target_id IS DISTINCT FROM NEW.commitment_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.scope IS DISTINCT FROM scope OR p.privacy_capability IS DISTINCT FROM 'expense-commitments.view'
 OR p.payload->'definition' IS DISTINCT FROM NEW.definition OR(p.payload->>'effectiveOn')::date IS DISTINCT FROM NEW.effective_on OR(p.payload#>>'{currency,id}')::uuid IS DISTINCT FROM NEW.currency_id OR(p.payload#>>'{currency,version}')::integer IS DISTINCT FROM NEW.currency_version OR(p.payload#>>'{payee,id}')::uuid IS DISTINCT FROM NEW.payee_id OR(p.payload#>>'{payee,version}')::integer IS DISTINCT FROM NEW.payee_version OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR p.review_context IS DISTINCT FROM jsonb_build_object('before',before,'sources',sources)
 OR(NEW.version=1 AND p.payload->>'code' IS DISTINCT FROM e.code) OR(NEW.version>1 AND(p.payload->>'expectedVersion')::integer IS DISTINCT FROM NEW.version-1) OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'EXPENSE_COMMITMENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF(NEW.definition->>'active')::boolean AND((sources#>>'{currency,version}') IS DISTINCT FROM(sources#>>'{currency,currentVersion}') OR sources#>>'{currency,active}'<>'true' OR sources#>>'{currency,currentActive}'<>'true' OR(sources#>>'{payee,version}') IS DISTINCT FROM(sources#>>'{payee,currentVersion}') OR sources#>>'{payee,active}'<>'true' OR sources#>>'{payee,currentActive}'<>'true') THEN RAISE EXCEPTION 'EXPENSE_COMMITMENT_ACTIVE_SOURCES_REQUIRED' USING ERRCODE='23514';END IF;
 IF sources#>>'{payee,personId}'=NEW.changed_by::text AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER expense_commitment_revision_guard BEFORE INSERT ON public.expense_commitment_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_expense_commitment_revision();
CREATE CONSTRAINT TRIGGER expense_commitment_review_complete AFTER INSERT ON public.expense_commitment_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.expense_commitment_source_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.source_snapshot IS DISTINCT FROM public.expense_commitment_sources(NEW.currency_id,NEW.currency_version,NEW.payee_id,NEW.payee_version,NEW.definition->'lines') THEN RAISE EXCEPTION 'EXPENSE_COMMITMENT_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER expense_commitment_fresh_sources AFTER INSERT ON public.expense_commitment_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.expense_commitment_source_complete();
CREATE FUNCTION public.expense_commitment_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;l jsonb;classes jsonb;BEGIN
 SELECT hub_id INTO p FROM public.financial_payees WHERE academy_id=NEW.academy_id AND id=(NEW.payload#>>'{payee,id}')::uuid;IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','currencies.view','any',true),CASE WHEN p.hub_id IS NULL THEN jsonb_build_object('capability','payees.view','any',true) ELSE jsonb_build_object('capability','payees.view','scope',jsonb_build_object('all',false,'hubs',jsonb_build_array(p.hub_id))) END);
 SELECT jsonb_agg(DISTINCT jsonb_build_object('id',c.id,'hubId',c.hub_id)) INTO classes FROM jsonb_array_elements(NEW.payload#>'{definition,lines}') x JOIN public.classes c ON c.academy_id=NEW.academy_id AND c.id=(x->>'classId')::uuid;
 IF classes IS NOT NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','classes.view','scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',classes)));END IF;
 FOR l IN SELECT DISTINCT x->'studentId' FROM jsonb_array_elements(NEW.payload#>'{definition,lines}') x WHERE x->'studentId'<>'null'::jsonb LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','students.view','personId',l));END LOOP;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END $$;
CREATE TRIGGER zz_expense_commitment_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.expense-commitment.create','finance.expense-commitment.change')) EXECUTE FUNCTION public.expense_commitment_privacy();
REVOKE ALL ON FUNCTION public.expense_commitment_privacy() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_expense_commitment_write(),public.lock_expense_commitment_sources(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_expense_commitment_sources(uuid,uuid,jsonb) TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.expense_schedule_date(jsonb),public.expense_schedule_valid(jsonb),public.expense_schedule_occurs(jsonb,date),public.expense_commitment_definition_valid(jsonb,integer),public.expense_commitment_scope(jsonb),public.expense_commitment_sources(uuid,integer,uuid,integer,jsonb),public.guard_expense_commitment_revision(),public.expense_commitment_source_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_schedule_date(jsonb),public.expense_schedule_valid(jsonb),public.expense_schedule_occurs(jsonb,date),public.expense_commitment_definition_valid(jsonb,integer),public.expense_commitment_scope(jsonb),public.expense_commitment_sources(uuid,integer,uuid,integer,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 92 $$;

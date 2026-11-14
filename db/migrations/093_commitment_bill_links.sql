INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('expense-commitment-links.view','View source-scoped planned-cost and actual-bill matching','Finance',true,ARRAY['hub','country','region','city']),
 ('expense-commitment-links.edit','Propose reviewed planned-cost and bill matching or release','Finance',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.expense_commitment_bill_links(
 academy_id uuid NOT NULL,id uuid NOT NULL,commitment_id uuid NOT NULL,terms_version integer NOT NULL,occurrence_on date NOT NULL,effective_on date NOT NULL,bill_id uuid NOT NULL,
 currency_id uuid NOT NULL,expected_scale integer NOT NULL CHECK(expected_scale BETWEEN 0 AND 18),bill_scale integer NOT NULL CHECK(bill_scale BETWEEN 0 AND 18),
 expected_minor numeric NOT NULL CHECK(expected_minor>0 AND expected_minor<1e38 AND expected_minor=trunc(expected_minor)),bill_minor numeric NOT NULL CHECK(bill_minor>0 AND bill_minor<1e38 AND bill_minor=trunc(bill_minor)),
 has_variance boolean NOT NULL,variance_note text NOT NULL CHECK(length(variance_note)<=2000),source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),created_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),
 CHECK(occurrence_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),CHECK(effective_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 FOREIGN KEY(academy_id,commitment_id,terms_version) REFERENCES public.expense_commitment_revisions(academy_id,commitment_id,version),FOREIGN KEY(academy_id,bill_id) REFERENCES public.expense_bills(academy_id,id),FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.expense_commitment_bill_releases(
 academy_id uuid NOT NULL,id uuid NOT NULL,link_id uuid NOT NULL,effective_on date NOT NULL CHECK(effective_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),created_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,link_id),
 FOREIGN KEY(academy_id,link_id) REFERENCES public.expense_commitment_bill_links(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX commitment_bill_link_occurrence ON public.expense_commitment_bill_links(academy_id,commitment_id,occurrence_on,terms_version,effective_on,id);
CREATE INDEX commitment_bill_link_bill ON public.expense_commitment_bill_links(academy_id,bill_id,effective_on,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['expense_commitment_bill_links','expense_commitment_bill_releases'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER commitment_link_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('CREATE CONSTRAINT TRIGGER commitment_link_review_complete AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,commitment_id,terms_version,occurrence_on,effective_on,bill_id,currency_id,expected_scale,bill_scale,expected_minor,bill_minor,has_variance,variance_note,source_snapshot,created_by,approval_id,reason) ON public.expense_commitment_bill_links TO kavosh_runtime;
GRANT INSERT(academy_id,id,link_id,effective_on,source_snapshot,created_by,approval_id,reason) ON public.expense_commitment_bill_releases TO kavosh_runtime;
CREATE VIEW public.expense_commitment_link_intervals WITH(security_invoker=true) AS
 SELECT l.*,r.id release_id,r.effective_on release_on,v.posted_on void_on,least(r.effective_on,v.posted_on) ends_on
 FROM public.expense_commitment_bill_links l LEFT JOIN public.expense_commitment_bill_releases r ON r.academy_id=l.academy_id AND r.link_id=l.id
 JOIN public.expense_bills b ON b.academy_id=l.academy_id AND b.id=l.bill_id LEFT JOIN public.finance_journals v ON v.academy_id=b.academy_id AND v.id=b.void_id;
CREATE VIEW public.expense_commitment_link_events WITH(security_invoker=true) AS
 SELECT academy_id,id,commitment_id,terms_version,occurrence_on,bill_id,effective_on AS on_date,expected_minor AS expected_delta,bill_minor AS bill_delta FROM public.expense_commitment_link_intervals WHERE ends_on IS NULL OR ends_on>effective_on
 UNION ALL SELECT academy_id,id,commitment_id,terms_version,occurrence_on,bill_id,ends_on,-expected_minor,-bill_minor FROM public.expense_commitment_link_intervals WHERE ends_on>effective_on;
GRANT SELECT ON public.expense_commitment_link_intervals,public.expense_commitment_link_events TO kavosh_runtime;
CREATE FUNCTION public.lock_commitment_bill_link_sources(p_commitment uuid,p_bill uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM public.lock_finance_book();PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 PERFORM id FROM public.expense_commitments WHERE academy_id=tenant AND id=p_commitment FOR UPDATE;
 PERFORM id FROM public.expense_bills WHERE academy_id=tenant AND id=p_bill FOR UPDATE;
END $$;
CREATE FUNCTION public.commitment_bill_source_scopes(p_commitment uuid,p_version integer,p_bill uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('commitment',public.expense_commitment_scope((r.definition->'lines')||(latest.definition->'lines')),'bill',public.expense_commitment_scope(coalesce(cost.lines,'[]'::jsonb)),
 'combined',public.expense_commitment_scope((r.definition->'lines')||(latest.definition->'lines')||coalesce(cost.lines,'[]'::jsonb)))
 FROM public.expense_commitments h JOIN public.expense_commitment_revisions r ON r.academy_id=h.academy_id AND r.commitment_id=h.id AND r.version=p_version
 JOIN public.expense_commitment_revisions latest ON latest.academy_id=h.academy_id AND latest.commitment_id=h.id AND latest.version=h.version
 JOIN public.expense_bills b ON b.academy_id=h.academy_id AND b.id=p_bill CROSS JOIN LATERAL(SELECT jsonb_agg(jsonb_build_object('hubId',l.hub_id)) lines FROM public.expense_bill_lines l WHERE l.academy_id=b.academy_id AND l.bill_id=b.id) cost WHERE h.id=p_commitment
$$;
CREATE FUNCTION public.commitment_bill_related_allow(p_bill uuid,p_scopes jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(public.approval_scope_nonempty(p_scopes->'expense-commitment-links.view') AND public.approval_scope_nonempty(p_scopes->'expense-commitments.view') AND public.approval_scope_nonempty(p_scopes->'expenses.view') AND EXISTS(SELECT 1 FROM public.expense_bills WHERE id=p_bill)
 AND NOT EXISTS(SELECT 1 FROM public.expense_commitment_bill_links l CROSS JOIN LATERAL(SELECT public.commitment_bill_source_scopes(l.commitment_id,l.terms_version,l.bill_id) scopes) s WHERE l.bill_id=p_bill AND(public.scope_contains(p_scopes->'expense-commitment-links.view',s.scopes->'combined') AND public.scope_contains(p_scopes->'expense-commitments.view',s.scopes->'commitment') AND public.scope_contains(p_scopes->'expenses.view',s.scopes->'bill')) IS NOT TRUE),false)
$$;
CREATE FUNCTION public.commitment_cost_contexts(lines jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_agg(x.context ORDER BY x.context),'[]'::jsonb) FROM(SELECT DISTINCT jsonb_build_object('hubId',l->'hubId','classId',l->'classId','studentId',l->'studentId') context FROM jsonb_array_elements(lines) l) x
$$;
CREATE FUNCTION public.commitment_bill_link_basis(p_commitment uuid,p_version integer,p_occurrence date,p_bill uuid,p_effective date) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;h record;t record;b record;selected record;expected_peak numeric;bill_peak numeric;scopes jsonb;conflict boolean;BEGIN
 PERFORM public.lock_commitment_bill_link_sources(p_commitment,p_bill);
 SELECT * INTO h FROM public.expense_commitments WHERE academy_id=tenant AND id=p_commitment;
 SELECT * INTO t FROM public.expense_commitment_revisions WHERE academy_id=tenant AND commitment_id=p_commitment AND version=p_version;
 SELECT x.*,v.posted_on void_on INTO b FROM public.expense_bills x LEFT JOIN public.finance_journals v ON v.academy_id=x.academy_id AND v.id=x.void_id WHERE x.academy_id=tenant AND x.id=p_bill;
 IF h.id IS NULL OR t.commitment_id IS NULL OR b.id IS NULL THEN RETURN NULL;END IF;
 SELECT version,definition INTO selected FROM public.expense_commitment_revisions WHERE academy_id=tenant AND commitment_id=p_commitment AND effective_on<=p_occurrence ORDER BY effective_on DESC,version DESC LIMIT 1;
 scopes=public.commitment_bill_source_scopes(p_commitment,p_version,p_bill);
 WITH daily AS(SELECT on_date,sum(expected_delta) delta FROM public.expense_commitment_link_events WHERE academy_id=tenant AND commitment_id=p_commitment AND occurrence_on=p_occurrence AND terms_version=p_version GROUP BY on_date),running AS(SELECT on_date,sum(delta) OVER(ORDER BY on_date) used FROM daily)
 SELECT greatest(0,coalesce((SELECT sum(delta) FROM daily WHERE on_date<=p_effective),0),coalesce((SELECT max(used) FROM running WHERE on_date>=p_effective AND(b.void_on IS NULL OR on_date<b.void_on)),0)) INTO expected_peak;
 WITH daily AS(SELECT on_date,sum(bill_delta) delta FROM public.expense_commitment_link_events WHERE academy_id=tenant AND bill_id=p_bill GROUP BY on_date),running AS(SELECT on_date,sum(delta) OVER(ORDER BY on_date) used FROM daily)
 SELECT greatest(0,coalesce((SELECT sum(delta) FROM daily WHERE on_date<=p_effective),0),coalesce((SELECT max(used) FROM running WHERE on_date>=p_effective AND(b.void_on IS NULL OR on_date<b.void_on)),0)) INTO bill_peak;
 SELECT EXISTS(SELECT 1 FROM public.expense_commitment_link_intervals i WHERE i.academy_id=tenant AND i.commitment_id=p_commitment AND i.occurrence_on=p_occurrence AND i.terms_version<>p_version AND(b.void_on IS NULL OR i.effective_on<b.void_on) AND(i.ends_on IS NULL OR i.ends_on>greatest(i.effective_on,p_effective))) INTO conflict;
 RETURN jsonb_build_object('static',jsonb_build_object('commitment',jsonb_build_object('id',h.id,'code',h.code,'latestVersion',h.version),'terms',jsonb_build_object('version',t.version,'definition',t.definition,'currencyId',t.currency_id,'unitScale',t.unit_scale,'payeeId',t.payee_id,'grossMinor',t.gross_minor::text,'costContexts',public.commitment_cost_contexts(t.definition->'lines')),
 'currentOccurrenceVersion',selected.version,'occurrenceValid',coalesce(selected.version=t.version AND(t.definition->>'active')::boolean AND p_occurrence>=(t.definition->>'startsOn')::date AND(t.definition->'endsOn'='null'::jsonb OR p_occurrence<=(t.definition->>'endsOn')::date) AND public.expense_schedule_occurs(t.definition->'schedule',p_occurrence),false),
 'bill',jsonb_build_object('id',b.id,'payeeId',b.payee_id,'currencyId',b.currency_id,'unitScale',b.unit_scale,'grossMinor',b.gross_minor::text,'postedOn',b.posted_on,'dueOn',b.due_on,'voidId',b.void_id,'voidOn',b.void_on,'costContexts',public.commitment_cost_contexts((SELECT jsonb_agg(jsonb_build_object('hubId',x.hub_id,'classId',x.class_id,'studentId',x.student_id)) FROM public.expense_bill_lines x WHERE x.academy_id=tenant AND x.bill_id=b.id))),'scopes',scopes),
 'expectedCapacityMinor',(t.gross_minor-expected_peak)::text,'billCapacityMinor',(b.gross_minor-bill_peak)::text,'otherVersionConflict',conflict,
 'stamp',jsonb_build_object('occurrenceLinks',(SELECT count(*)::text FROM public.expense_commitment_bill_links WHERE academy_id=tenant AND commitment_id=p_commitment AND occurrence_on=p_occurrence),'occurrenceReleases',(SELECT count(*)::text FROM public.expense_commitment_bill_releases r JOIN public.expense_commitment_bill_links l ON l.academy_id=r.academy_id AND l.id=r.link_id WHERE l.academy_id=tenant AND l.commitment_id=p_commitment AND l.occurrence_on=p_occurrence),'billLinks',(SELECT count(*)::text FROM public.expense_commitment_bill_links WHERE academy_id=tenant AND bill_id=p_bill),'billReleases',(SELECT count(*)::text FROM public.expense_commitment_bill_releases r JOIN public.expense_commitment_bill_links l ON l.academy_id=r.academy_id AND l.id=r.link_id WHERE l.academy_id=tenant AND l.bill_id=p_bill)));
END $$;
CREATE FUNCTION public.commitment_bill_release_basis(p_link uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE l record;source jsonb;BEGIN
 SELECT * INTO l FROM public.expense_commitment_bill_links WHERE id=p_link;IF NOT FOUND THEN RETURN NULL;END IF;
 source=public.commitment_bill_link_basis(l.commitment_id,l.terms_version,l.occurrence_on,l.bill_id,l.effective_on);
 RETURN jsonb_build_object('link',jsonb_build_object('id',l.id,'commitment_id',l.commitment_id,'terms_version',l.terms_version,'occurrence_on',l.occurrence_on,'effective_on',l.effective_on,'bill_id',l.bill_id,'currency_id',l.currency_id,'expected_scale',l.expected_scale,'bill_scale',l.bill_scale,'expected_minor',l.expected_minor::text,'bill_minor',l.bill_minor::text,'has_variance',l.has_variance,'variance_note',l.variance_note),'sources',source,'releaseId',(SELECT id FROM public.expense_commitment_bill_releases WHERE link_id=l.id));
END $$;
CREATE FUNCTION public.guard_commitment_bill_link() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;s jsonb;v boolean;keys text[]:=ARRAY['commitmentId','termsVersion','occurrenceOn','billId','effectiveOn','expectedAmount','billAmount','varianceAcknowledged','varianceNote','reason'];BEGIN
 s=public.commitment_bill_link_basis(NEW.commitment_id,NEW.terms_version,NEW.occurrence_on,NEW.bill_id,NEW.effective_on);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF jsonb_typeof(p.payload) IS DISTINCT FROM 'object' OR NOT(p.payload ?& keys) OR p.payload-keys<>'{}'::jsonb OR EXISTS(SELECT 1 FROM unnest(ARRAY['commitmentId','billId','expectedAmount','billAmount','varianceNote','reason']) k WHERE jsonb_typeof(p.payload->k) IS DISTINCT FROM 'string') OR jsonb_typeof(p.payload->'termsVersion') IS DISTINCT FROM 'number' OR jsonb_typeof(p.payload->'varianceAcknowledged') IS DISTINCT FROM 'boolean' OR NOT public.expense_schedule_date(p.payload->'occurrenceOn') OR NOT public.expense_schedule_date(p.payload->'effectiveOn') THEN RAISE EXCEPTION 'COMMITMENT_BILL_LINK_TYPED_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF s IS NULL OR s#>>'{static,occurrenceValid}' IS DISTINCT FROM 'true' OR s->>'otherVersionConflict'='true' OR(s#>>'{static,bill,voidOn}' IS NOT NULL AND NEW.effective_on>=(s#>>'{static,bill,voidOn}')::date) OR NEW.effective_on<(s#>>'{static,bill,postedOn}')::date OR NEW.currency_id IS DISTINCT FROM(s#>>'{static,terms,currencyId}')::uuid OR NEW.currency_id IS DISTINCT FROM(s#>>'{static,bill,currencyId}')::uuid OR NEW.expected_scale IS DISTINCT FROM(s#>>'{static,terms,unitScale}')::integer OR NEW.bill_scale IS DISTINCT FROM(s#>>'{static,bill,unitScale}')::integer OR NEW.expected_minor>(s->>'expectedCapacityMinor')::numeric OR NEW.bill_minor>(s->>'billCapacityMinor')::numeric THEN RAISE EXCEPTION 'COMMITMENT_BILL_LINK_SOURCE_OR_CAPACITY_INVALID' USING ERRCODE='23514';END IF;
 v=NEW.expected_minor*power(10::numeric,NEW.bill_scale)<>NEW.bill_minor*power(10::numeric,NEW.expected_scale) OR NEW.occurrence_on<>(s#>>'{static,bill,dueOn}')::date OR s#>'{static,terms,costContexts}' IS DISTINCT FROM s#>'{static,bill,costContexts}' OR s#>>'{static,terms,payeeId}' IS DISTINCT FROM s#>>'{static,bill,payeeId}';
 IF p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'finance.commitment-bill.link' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'expense-commitment-links.view' OR p.scope IS DISTINCT FROM s#>'{static,scopes,combined}' OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s
 OR(p.payload->>'commitmentId')::uuid IS DISTINCT FROM NEW.commitment_id OR(p.payload->>'termsVersion')::integer IS DISTINCT FROM NEW.terms_version OR(p.payload->>'occurrenceOn')::date IS DISTINCT FROM NEW.occurrence_on OR(p.payload->>'billId')::uuid IS DISTINCT FROM NEW.bill_id OR(p.payload->>'effectiveOn')::date IS DISTINCT FROM NEW.effective_on OR NOT public.work_money_valid(p.payload->'expectedAmount',NEW.expected_scale) OR NOT public.work_money_valid(p.payload->'billAmount',NEW.bill_scale) OR(p.payload->>'expectedAmount')::numeric*power(10::numeric,NEW.expected_scale) IS DISTINCT FROM NEW.expected_minor OR(p.payload->>'billAmount')::numeric*power(10::numeric,NEW.bill_scale) IS DISTINCT FROM NEW.bill_minor OR p.payload->>'varianceNote' IS DISTINCT FROM NEW.variance_note OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR NEW.has_variance IS DISTINCT FROM v OR(v AND(p.payload->'varianceAcknowledged' IS DISTINCT FROM 'true'::jsonb OR length(btrim(NEW.variance_note))=0)) OR NOT public.report_comment_human_verified(NEW.created_by) THEN RAISE EXCEPTION 'COMMITMENT_BILL_LINK_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.financial_payees WHERE academy_id=NEW.academy_id AND id IN((s#>>'{static,bill,payeeId}')::uuid,(s#>>'{static,terms,payeeId}')::uuid) AND person_id=NEW.created_by) AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER commitment_bill_link_guard BEFORE INSERT ON public.expense_commitment_bill_links FOR EACH ROW EXECUTE FUNCTION public.guard_commitment_bill_link();
CREATE FUNCTION public.guard_commitment_bill_release() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;s jsonb;keys text[]:=ARRAY['linkId','effectiveOn','reason'];BEGIN
 s=public.commitment_bill_release_basis(NEW.link_id);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF jsonb_typeof(p.payload) IS DISTINCT FROM 'object' OR NOT(p.payload ?& keys) OR p.payload-keys<>'{}'::jsonb OR jsonb_typeof(p.payload->'linkId') IS DISTINCT FROM 'string' OR jsonb_typeof(p.payload->'reason') IS DISTINCT FROM 'string' OR NOT public.expense_schedule_date(p.payload->'effectiveOn') THEN RAISE EXCEPTION 'COMMITMENT_BILL_RELEASE_TYPED_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF s IS NULL OR s->'releaseId'<>'null'::jsonb OR NEW.effective_on<(s#>>'{link,effective_on}')::date OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'finance.commitment-bill.release' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'expense-commitment-links.view' OR p.scope IS DISTINCT FROM s#>'{sources,static,scopes,combined}' OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR(p.payload->>'linkId')::uuid IS DISTINCT FROM NEW.link_id OR(p.payload->>'effectiveOn')::date IS DISTINCT FROM NEW.effective_on OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR NOT public.report_comment_human_verified(NEW.created_by) THEN RAISE EXCEPTION 'COMMITMENT_BILL_RELEASE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.financial_payees WHERE academy_id=NEW.academy_id AND id IN((s#>>'{sources,static,bill,payeeId}')::uuid,(s#>>'{sources,static,terms,payeeId}')::uuid) AND person_id=NEW.created_by) AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER commitment_bill_release_guard BEFORE INSERT ON public.expense_commitment_bill_releases FOR EACH ROW EXECUTE FUNCTION public.guard_commitment_bill_release();
CREATE FUNCTION public.commitment_bill_link_sources_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;BEGIN
 IF TG_TABLE_NAME='expense_commitment_bill_links' THEN s=public.commitment_bill_link_basis(NEW.commitment_id,NEW.terms_version,NEW.occurrence_on,NEW.bill_id,NEW.effective_on);IF s->'static' IS DISTINCT FROM NEW.source_snapshot->'static' THEN RAISE EXCEPTION 'COMMITMENT_BILL_LINK_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 ELSE s=public.commitment_bill_release_basis(NEW.link_id);IF s#>'{sources,static}' IS DISTINCT FROM NEW.source_snapshot#>'{sources,static}' OR s->'link' IS DISTINCT FROM NEW.source_snapshot->'link' THEN RAISE EXCEPTION 'COMMITMENT_BILL_LINK_SOURCE_CHANGED' USING ERRCODE='23514';END IF;END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER commitment_bill_link_fresh AFTER INSERT ON public.expense_commitment_bill_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.commitment_bill_link_sources_complete();
CREATE CONSTRAINT TRIGGER commitment_bill_release_fresh AFTER INSERT ON public.expense_commitment_bill_releases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.commitment_bill_link_sources_complete();
CREATE FUNCTION public.commitment_bill_link_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.commitment-bill.link' AND NOT EXISTS(SELECT 1 FROM public.expense_commitment_bill_links WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id) OR NEW.action='finance.commitment-bill.release' AND NOT EXISTS(SELECT 1 FROM public.expense_commitment_bill_releases WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id) THEN RAISE EXCEPTION 'COMMITMENT_BILL_LINK_EFFECT_MISSING' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER commitment_bill_link_effect AFTER UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='applied' AND NEW.action IN('finance.commitment-bill.link','finance.commitment-bill.release')) EXECUTE FUNCTION public.commitment_bill_link_effect_required();
CREATE FUNCTION public.commitment_bill_link_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE l record;s jsonb;bill uuid;BEGIN
 IF NEW.action='finance.commitment-bill.release' THEN SELECT commitment_id,terms_version,bill_id INTO l FROM public.expense_commitment_bill_links WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'linkId')::uuid;IF FOUND THEN bill=l.bill_id;s=public.commitment_bill_source_scopes(l.commitment_id,l.terms_version,l.bill_id);END IF;
 ELSE bill=(NEW.payload->>'billId')::uuid;s=public.commitment_bill_source_scopes((NEW.payload->>'commitmentId')::uuid,(NEW.payload->>'termsVersion')::integer,bill);END IF;
 IF s IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','expense-commitments.view','scope',s->'commitment'),jsonb_build_object('capability','expenses.view','scope',s->'bill'),jsonb_build_object('capability','expense-commitment-links.view','commitmentBillLinks',bill));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END $$;
CREATE TRIGGER zz_commitment_bill_link_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.commitment-bill.link','finance.commitment-bill.release')) EXECUTE FUNCTION public.commitment_bill_link_privacy();
REVOKE ALL ON FUNCTION public.lock_commitment_bill_link_sources(uuid,uuid),public.commitment_bill_source_scopes(uuid,integer,uuid),public.commitment_bill_link_basis(uuid,integer,date,uuid,date),public.commitment_bill_release_basis(uuid),public.guard_commitment_bill_link(),public.guard_commitment_bill_release(),public.commitment_bill_link_sources_complete(),public.commitment_bill_link_effect_required(),public.commitment_bill_link_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_commitment_bill_link_sources(uuid,uuid),public.commitment_bill_source_scopes(uuid,integer,uuid),public.commitment_bill_link_basis(uuid,integer,date,uuid,date),public.commitment_bill_release_basis(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 93 $$;
CREATE OR REPLACE FUNCTION public.lock_expense_commitment_sources(p_currency uuid,p_payee uuid,lines jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;BEGIN
 -- Stable current-source headers through commit, not only a final read that
 -- could race a non-key version/status update. All roles already have the
 -- necessary narrow update grants; no immutable revision privilege is added.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM public.lock_finance_book();PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 PERFORM id FROM public.finance_currencies WHERE academy_id=tenant AND id=p_currency FOR SHARE;
 PERFORM id FROM public.financial_payees WHERE academy_id=tenant AND id=p_payee FOR SHARE;
 PERFORM id FROM public.hubs WHERE academy_id=tenant AND id IN(SELECT(l->>'hubId')::uuid FROM jsonb_array_elements(lines) l) ORDER BY id FOR SHARE;
 PERFORM id FROM public.classes WHERE academy_id=tenant AND id IN(SELECT(l->>'classId')::uuid FROM jsonb_array_elements(lines) l) ORDER BY id FOR SHARE;
 PERFORM id FROM public.people WHERE academy_id=tenant AND id IN(SELECT(l->>'studentId')::uuid FROM jsonb_array_elements(lines) l) ORDER BY id FOR SHARE;
 PERFORM person_id FROM public.student_profiles WHERE academy_id=tenant AND person_id IN(SELECT(l->>'studentId')::uuid FROM jsonb_array_elements(lines) l) ORDER BY person_id FOR SHARE;
END $$;
REVOKE ALL ON FUNCTION public.commitment_cost_contexts(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.commitment_cost_contexts(jsonb) TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.commitment_bill_related_allow(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.commitment_bill_related_allow(uuid,jsonb) TO kavosh_runtime;
-- ponytail: rare plan configuration writes serialize per academy to keep
-- dependent case scopes stable; use sorted dependency-row locks if measured
-- configuration-write throughput requires a finer gate. Reads share the gate.
CREATE OR REPLACE FUNCTION public.guard_expense_commitment_write() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF nullif(current_setting('app.academy_id',true),'') IS NOT NULL THEN
  IF TG_TABLE_NAME IN('expense_commitments','expense_commitment_revisions') THEN PERFORM pg_advisory_xact_lock(hashtextextended(current_setting('app.academy_id'),8));ELSE PERFORM pg_advisory_xact_lock_shared(hashtextextended(current_setting('app.academy_id'),8));END IF;
  PERFORM public.lock_finance_book();PERFORM pg_advisory_xact_lock_shared(hashtextextended(current_setting('app.academy_id'),9));
 END IF;RETURN NULL;END $$;
CREATE OR REPLACE FUNCTION public.approval_bindings_allow(p_bindings jsonb,p_scopes jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE b jsonb;s jsonb;f record;domain_cap text;BEGIN
 IF jsonb_typeof(p_bindings) IS DISTINCT FROM 'array' OR jsonb_array_length(p_bindings)>64 THEN RETURN false;END IF;
 FOR b IN SELECT * FROM jsonb_array_elements(p_bindings) LOOP
  IF b->'unresolved'='true'::jsonb THEN RETURN false;END IF;
  IF b ? 'fileId' THEN
   SELECT effective_hub_id,class_id,person_id,domain INTO f FROM public.file_catalogue WHERE id=(b->>'fileId')::uuid;
   IF NOT FOUND OR NOT public.approval_file_scope_allows(p_scopes->'files.view',f.effective_hub_id,f.class_id,f.person_id) THEN RETURN false;END IF;
   domain_cap=CASE f.domain WHEN 'student_private' THEN 'students.view' WHEN 'guardian_private' THEN 'guardians.view' WHEN 'agreement_definition' THEN 'agreements.view' WHEN 'finance_private' THEN 'financial-files.view' WHEN 'general' THEN NULL ELSE 'unknown.private-domain' END;
   IF domain_cap IS NOT NULL AND NOT public.approval_file_scope_allows(p_scopes->domain_cap,f.effective_hub_id,f.class_id,f.person_id) THEN RETURN false;END IF;
  ELSIF b ? 'commitmentBillLinks' THEN
   IF b->>'capability' IS DISTINCT FROM 'expense-commitment-links.view' OR public.commitment_bill_related_allow((b->>'commitmentBillLinks')::uuid,p_scopes) IS NOT TRUE THEN RETURN false;END IF;
  ELSIF b ? 'pollRecords' THEN
   IF b->>'capability' IS DISTINCT FROM 'poll-recipients.view' OR NOT public.poll_recipient_records_allow(b->'pollRecords',p_scopes->'poll-recipients.view') THEN RETURN false;END IF;
  ELSIF b ? 'studentRecords' THEN
   IF b->>'capability' IS DISTINCT FROM 'homework-recipients.view' OR NOT public.homework_recipients_allow(b->'studentRecords',p_scopes->'homework-recipients.view') THEN RETURN false;END IF;
  ELSIF b ? 'personId' THEN
   SELECT id,hub_id INTO f FROM public.people WHERE id=(b->>'personId')::uuid;
   s=p_scopes->(b->>'capability');IF NOT FOUND OR NOT public.approval_scope_nonempty(s) OR NOT public.scope_contains(s,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',f.id,'hubId',f.hub_id)))) THEN RETURN false;END IF;
  ELSE
   s=p_scopes->(b->>'capability');IF NOT public.approval_scope_nonempty(s) THEN RETURN false;END IF;
   IF b->'any' IS DISTINCT FROM 'true'::jsonb AND(jsonb_typeof(b->'scope') IS DISTINCT FROM 'object' OR NOT public.approval_scope_nonempty(b->'scope') OR NOT public.scope_contains(s,b->'scope')) THEN RETURN false;END IF;
  END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;

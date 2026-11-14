INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('pay-periods.view','View private payroll service periods and payment timing','Finance',true,ARRAY['hub','person','country','region','city']),
 ('pay-periods.edit','Propose reviewed payroll service periods and timing corrections','Finance',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.work_pay_periods(
 academy_id uuid NOT NULL,id uuid NOT NULL,engagement_id uuid NOT NULL,code text NOT NULL CHECK(code~'^[A-Z0-9][A-Z0-9._-]{0,63}$'),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,engagement_id,code),FOREIGN KEY(academy_id,engagement_id) REFERENCES public.work_engagements(academy_id,id)
);
CREATE TABLE public.work_pay_period_revisions(
 academy_id uuid NOT NULL,period_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),work_version integer NOT NULL CHECK(work_version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,period_id,version),FOREIGN KEY(academy_id,period_id) REFERENCES public.work_pay_periods(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.work_pay_periods ADD CONSTRAINT pay_period_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.work_pay_period_revisions(academy_id,period_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX pay_period_engagement ON public.work_pay_periods(academy_id,engagement_id,id);
CREATE TRIGGER pay_period_header BEFORE INSERT OR UPDATE ON public.work_pay_periods FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['work_pay_periods','work_pay_period_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 -- Reuse the existing shared policy/book/topology write gate. Only the
 -- original plan-configuration tables take its exclusive policy branch.
 EXECUTE format('CREATE TRIGGER pay_period_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,engagement_id,code) ON public.work_pay_periods TO kavosh_runtime;
GRANT UPDATE(version) ON public.work_pay_periods TO kavosh_runtime;
GRANT INSERT(academy_id,period_id,version,work_version,definition,source_snapshot,changed_by,approval_id,reason) ON public.work_pay_period_revisions TO kavosh_runtime;
CREATE FUNCTION public.lock_pay_period_work(p_engagement uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;BEGIN
 IF tenant IS NULL THEN RETURN;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM public.lock_finance_book();PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 -- One engagement lock serializes conflicting period writes and protects
 -- terms through commit, without an academy-wide period-write bottleneck.
 PERFORM id FROM public.work_engagements WHERE academy_id=tenant AND id=p_engagement FOR UPDATE;
END $$;
CREATE FUNCTION public.pay_period_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE f date;t date;p date;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& ARRAY['from','through','payOn','active','timingReview']) OR d-ARRAY['from','through','payOn','active','timingReview']<>'{}'::jsonb OR jsonb_typeof(d->'active') IS DISTINCT FROM 'boolean' OR jsonb_typeof(d->'timingReview') IS DISTINCT FROM 'string' OR length(btrim(d->>'timingReview')) NOT BETWEEN 1 AND 2000 THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['from','through','payOn']) k WHERE jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR d->>k!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$') THEN RETURN false;END IF;
 f=(d->>'from')::date;t=(d->>'through')::date;p=(d->>'payOn')::date;RETURN f BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' AND t BETWEEN f AND DATE '9999-12-31' AND t-f<=365 AND p BETWEEN DATE '1900-01-01' AND DATE '9999-12-31';
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.pay_period_basis(p_period uuid,p_engagement uuid,p_before integer,d jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;h record;prior jsonb;terms jsonb;term_count integer;other_count integer;overlap boolean;BEGIN
 PERFORM public.lock_pay_period_work(p_engagement);
 SELECT * INTO h FROM public.work_engagements WHERE academy_id=tenant AND id=p_engagement;IF NOT FOUND OR NOT public.pay_period_definition_valid(d) THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('version',r.version,'workVersion',r.work_version,'definition',r.definition) INTO prior FROM public.work_pay_period_revisions r JOIN public.work_pay_periods p ON p.academy_id=r.academy_id AND p.id=r.period_id WHERE r.academy_id=tenant AND r.period_id=p_period AND p.engagement_id=p_engagement AND r.version=p_before;
 WITH selected AS MATERIALIZED(
  SELECT r.* FROM public.work_engagement_revisions r WHERE r.academy_id=tenant AND r.engagement_id=p_engagement AND r.effective_on<=(d->>'through')::date AND(r.effective_on>=(d->>'from')::date OR r.version=(SELECT x.version FROM public.work_engagement_revisions x WHERE x.academy_id=tenant AND x.engagement_id=p_engagement AND x.effective_on<(d->>'from')::date ORDER BY x.effective_on DESC,x.version DESC LIMIT 1)) ORDER BY r.effective_on,r.version LIMIT 101
 ) SELECT count(*)::integer,CASE WHEN count(*)<=100 THEN coalesce(jsonb_agg(jsonb_build_object('version',r.version,'effectiveOn',r.effective_on::text,'currencyId',r.currency_id,'currencyVersion',r.currency_version,'unitScale',r.unit_scale,'employerId',r.employer_id,'employerVersion',r.employer_version,'payeeId',r.payee_id,'payeeVersion',r.payee_version,'definition',r.definition,'components',r.components) ORDER BY r.effective_on,r.version),'[]'::jsonb) ELSE '[]'::jsonb END INTO term_count,terms FROM selected r;
 IF octet_length(terms::text)>1048576 THEN term_count=101;terms='[]'::jsonb;END IF;
 WITH others AS MATERIALIZED(SELECT p.id,p.version,r.definition FROM public.work_pay_periods p JOIN public.work_pay_period_revisions r ON r.academy_id=p.academy_id AND r.period_id=p.id AND r.version=p.version WHERE p.academy_id=tenant AND p.engagement_id=p_engagement AND p.id<>p_period ORDER BY p.id LIMIT 10001)
 SELECT count(*)::integer,coalesce(bool_or((definition->>'active')::boolean AND daterange((definition->>'from')::date,(definition->>'through')::date,'[]')&&daterange((d->>'from')::date,(d->>'through')::date,'[]')),false) INTO other_count,overlap FROM others;
 RETURN jsonb_build_object('before',prior,'work',jsonb_build_object('id',h.id,'personId',h.person_id,'hubId',h.hub_id,'version',h.version,'terms',terms),'oversized',term_count>100 OR other_count>10000,'overlap',(d->>'active')::boolean AND overlap);
END $$;
CREATE FUNCTION public.guard_pay_period_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;w record;p record;b jsonb;s jsonb;keys text[];BEGIN
 SELECT * INTO h FROM public.work_pay_periods WHERE academy_id=NEW.academy_id AND id=NEW.period_id;SELECT * INTO w FROM public.work_engagements WHERE academy_id=NEW.academy_id AND id=h.engagement_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF h.id IS NULL OR w.id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.work_pay_period_revisions WHERE academy_id=NEW.academy_id AND period_id=NEW.period_id) OR NOT public.pay_period_definition_valid(NEW.definition) THEN RAISE EXCEPTION 'PAY_PERIOD_DEFINITION_OR_VERSION_INVALID' USING ERRCODE='23514';END IF;
 b=public.pay_period_basis(NEW.period_id,h.engagement_id,NEW.version-1,NEW.definition);s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',w.person_id,'hubId',w.hub_id)),'workContext',jsonb_build_object('personId',w.person_id,'hubId',w.hub_id));
 keys=ARRAY['workVersion','definition','reason']||CASE WHEN NEW.version=1 THEN ARRAY['engagementId','code'] ELSE ARRAY['expectedVersion'] END;
 IF p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'work.period.create' ELSE 'work.period.change' END) OR p.target_id IS DISTINCT FROM NEW.period_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.scope IS DISTINCT FROM s OR p.privacy_capability IS DISTINCT FROM 'pay-periods.view' OR NOT(p.payload ?& keys) OR p.payload-keys<>'{}'::jsonb
 OR p.payload->'definition' IS DISTINCT FROM NEW.definition OR jsonb_typeof(p.payload->'reason') IS DISTINCT FROM 'string' OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR jsonb_typeof(p.payload->'workVersion') IS DISTINCT FROM 'number' OR(p.payload->>'workVersion')::numeric IS DISTINCT FROM NEW.work_version::numeric OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NEW.work_version<>w.version
 OR(NEW.version=1 AND(jsonb_typeof(p.payload->'engagementId') IS DISTINCT FROM 'string' OR jsonb_typeof(p.payload->'code') IS DISTINCT FROM 'string' OR p.payload->>'engagementId' IS DISTINCT FROM h.engagement_id::text OR p.payload->>'code' IS DISTINCT FROM h.code)) OR(NEW.version>1 AND(jsonb_typeof(p.payload->'expectedVersion') IS DISTINCT FROM 'number' OR(p.payload->>'expectedVersion')::numeric IS DISTINCT FROM(NEW.version-1)::numeric)) OR NOT public.report_comment_human_verified(NEW.changed_by)
 OR b IS NULL OR b->'oversized' IS DISTINCT FROM 'false'::jsonb OR b->'overlap' IS DISTINCT FROM 'false'::jsonb OR jsonb_array_length(b#>'{work,terms}')=0 OR(NEW.version>1 AND b->'before'='null'::jsonb)
 THEN RAISE EXCEPTION 'PAY_PERIOD_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by=w.person_id AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER pay_period_revision_guard BEFORE INSERT ON public.work_pay_period_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_pay_period_revision();
CREATE CONSTRAINT TRIGGER pay_period_review_applied AFTER INSERT ON public.work_pay_period_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.pay_period_sources_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;b jsonb;BEGIN
 SELECT * INTO h FROM public.work_pay_periods WHERE academy_id=NEW.academy_id AND id=NEW.period_id;b=public.pay_period_basis(NEW.period_id,h.engagement_id,NEW.version-1,NEW.definition);
 -- The write itself changes its period header; compare protected source
 -- terms and the minimal previous revision, not a mutable own-row counter.
 IF b IS NULL OR b->'work' IS DISTINCT FROM NEW.source_snapshot->'work' OR b->'before' IS DISTINCT FROM NEW.source_snapshot->'before' OR b->'oversized' IS DISTINCT FROM 'false'::jsonb OR b->'overlap' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'PAY_PERIOD_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pay_period_sources_complete AFTER INSERT ON public.work_pay_period_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pay_period_sources_complete();
CREATE FUNCTION public.pay_period_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action IN('work.period.create','work.period.change') AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.work_pay_period_revisions r WHERE r.academy_id=NEW.academy_id AND r.period_id=NEW.target_id AND r.version=NEW.target_version+1 AND r.approval_id=NEW.id AND r.changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PAY_PERIOD_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pay_period_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pay_period_effect_required();
CREATE FUNCTION public.pay_period_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE e record;BEGIN
 IF NEW.action='work.period.create' THEN SELECT person_id,hub_id INTO e FROM public.work_engagements WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'engagementId')::uuid;
 ELSE SELECT w.person_id,w.hub_id INTO e FROM public.work_pay_periods p JOIN public.work_engagements w ON w.academy_id=p.academy_id AND w.id=p.engagement_id WHERE p.academy_id=NEW.academy_id AND p.id=NEW.target_id;END IF;
 IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','work-pay.view','scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',e.person_id,'hubId',e.hub_id)),'workContext',jsonb_build_object('personId',e.person_id,'hubId',e.hub_id))));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_pay_period_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('work.period.create','work.period.change')) EXECUTE FUNCTION public.pay_period_privacy();
REVOKE ALL ON FUNCTION public.lock_pay_period_work(uuid),public.pay_period_definition_valid(jsonb),public.pay_period_basis(uuid,uuid,integer,jsonb),public.guard_pay_period_revision(),public.pay_period_sources_complete(),public.pay_period_effect_required(),public.pay_period_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_pay_period_work(uuid),public.pay_period_definition_valid(jsonb),public.pay_period_basis(uuid,uuid,integer,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 95 $$;

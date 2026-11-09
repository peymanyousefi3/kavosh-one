INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('reporting-defaults.view','View school reporting-currency defaults','Finance',true,ARRAY[]::text[]),
 ('reporting-defaults.edit','Request reviewed reporting-currency defaults','Finance',true,ARRAY[]::text[]);
CREATE TABLE public.finance_reporting_preferences(
 academy_id uuid NOT NULL REFERENCES public.academies(id),version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL,source_basis jsonb NOT NULL,
 currency_id uuid NOT NULL,currency_version integer NOT NULL,maximum_rate_age_days integer NOT NULL CHECK(maximum_rate_age_days BETWEEN 0 AND 3660),
 approval_id uuid NOT NULL,changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(academy_id,version),UNIQUE(academy_id,approval_id),
 CHECK(definition=jsonb_build_object('currency',jsonb_build_object('id',currency_id,'version',currency_version),'maximumRateAgeDays',maximum_rate_age_days)),
 FOREIGN KEY(academy_id,currency_id,currency_version) REFERENCES public.finance_currency_revisions(academy_id,currency_id,version),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind));
ALTER TABLE public.finance_reporting_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_reporting_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.finance_reporting_preferences USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.finance_reporting_preferences FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write();
CREATE FUNCTION public.reporting_currency_source(i jsonb) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',coalesce((SELECT version FROM public.finance_reporting_preferences ORDER BY version DESC LIMIT 1),0),
 'definition',(SELECT definition FROM public.finance_reporting_preferences ORDER BY version DESC LIMIT 1),
 'currency',(SELECT jsonb_build_object('id',id,'version',version,'code',code,'unitScale',unit_scale,'active',active) FROM public.finance_currency_catalogue WHERE id=(i#>>'{definition,currency,id}')::uuid));
$$;
CREATE FUNCTION public.guard_reporting_currency() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;s jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'REPORTING_DEFAULTS_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM id FROM public.finance_currencies WHERE academy_id=NEW.academy_id AND id=NEW.currency_id FOR SHARE;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,291));NEW.created_at=transaction_timestamp();
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR p.action IS DISTINCT FROM 'finance.reporting-defaults.change' OR p.privacy_capability IS DISTINCT FROM 'reporting-defaults.view' OR p.target_id IS DISTINCT FROM NEW.academy_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.scope IS DISTINCT FROM '{"all":true,"hubs":[]}'::jsonb
  OR p.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'definition',NEW.definition,'reason',NEW.reason) OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'REPORTING_DEFAULTS_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 s=public.reporting_currency_source(p.payload);
 IF s IS DISTINCT FROM p.review_context OR s IS DISTINCT FROM NEW.source_basis OR(s->>'version')::integer IS DISTINCT FROM NEW.version-1 OR(s#>>'{currency,version}')::integer IS DISTINCT FROM NEW.currency_version OR(s#>>'{currency,id}')::uuid IS DISTINCT FROM NEW.currency_id OR s#>'{currency,active}' IS DISTINCT FROM 'true'::jsonb
 THEN RAISE EXCEPTION 'REPORTING_DEFAULTS_CURRENT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER reporting_currency_guard BEFORE INSERT OR UPDATE OR DELETE ON public.finance_reporting_preferences FOR EACH ROW EXECUTE FUNCTION public.guard_reporting_currency();
CREATE CONSTRAINT TRIGGER reporting_currency_reviewed AFTER INSERT ON public.finance_reporting_preferences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.complete_reporting_currency() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.academy_id AND e.actor_id=NEW.changed_by AND e.action='finance.reporting-defaults.change' AND e.hub_id IS NULL AND e.created_at=transaction_timestamp() AND e.changes=jsonb_build_object('version',NEW.version,'approvalId',NEW.approval_id,'severity','critical','hasReason',true,'ledgerAdjusted',false))
 THEN RAISE EXCEPTION 'REPORTING_DEFAULTS_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reporting_currency_complete AFTER INSERT ON public.finance_reporting_preferences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_reporting_currency();
CREATE FUNCTION public.reporting_currency_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.reporting-defaults.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.finance_reporting_preferences r WHERE r.academy_id=NEW.academy_id AND r.version=NEW.target_version+1 AND r.approval_id=NEW.id AND r.changed_by=NEW.reviewer_id)
 THEN RAISE EXCEPTION 'REPORTING_DEFAULTS_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reporting_currency_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reporting_currency_effect_required();
CREATE FUNCTION public.reporting_currency_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 NEW.privacy_bindings=NEW.privacy_bindings||'[{"capability":"currencies.view","scope":{"all":true,"hubs":[]}}]'::jsonb;RETURN NEW;
END $$;
CREATE TRIGGER zz_reporting_currency_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='finance.reporting-defaults.change') EXECUTE FUNCTION public.reporting_currency_privacy();
GRANT SELECT,INSERT ON public.finance_reporting_preferences TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.reporting_currency_source(jsonb),public.guard_reporting_currency(),public.complete_reporting_currency(),public.reporting_currency_effect_required(),public.reporting_currency_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reporting_currency_source(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 291 $$;

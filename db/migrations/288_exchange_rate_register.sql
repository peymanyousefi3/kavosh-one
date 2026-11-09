INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('exchange-rates.view','View school reference exchange rates','Finance',true,ARRAY[]::text[]),
 ('exchange-rates.edit','Request reviewed school reference rates and corrections','Finance',true,ARRAY[]::text[]);
CREATE TABLE public.finance_exchange_rates(
 academy_id uuid NOT NULL,id uuid NOT NULL,base_currency_id uuid NOT NULL,base_currency_version integer NOT NULL,quote_currency_id uuid NOT NULL,quote_currency_version integer NOT NULL,
 rate_on date NOT NULL CHECK(rate_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'),state text NOT NULL CHECK(state IN('recorded','void')),rate text,rate_numerator numeric,rate_denominator numeric,
 supersedes_id uuid,source text NOT NULL CHECK(length(btrim(source)) BETWEEN 1 AND 200),reference text NOT NULL CHECK(length(reference)<=200),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 approval_id uuid NOT NULL,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,id,base_currency_id,quote_currency_id,rate_on),UNIQUE(academy_id,supersedes_id),
 CHECK(base_currency_id<>quote_currency_id),
 CHECK((state='recorded' AND rate IS NOT NULL AND rate~'^(0|[1-9][0-9]{0,17})([.][0-9]{1,18})?$' AND rate_numerator IS NOT NULL AND rate_denominator IS NOT NULL AND rate_numerator>0 AND rate_numerator<1e36 AND rate_denominator BETWEEN 1 AND 1e18 AND rate_numerator=trunc(rate_numerator) AND rate_denominator=trunc(rate_denominator)) OR(state='void' AND rate IS NULL AND rate_numerator IS NULL AND rate_denominator IS NULL AND supersedes_id IS NOT NULL)),
 FOREIGN KEY(academy_id,base_currency_id,base_currency_version) REFERENCES public.finance_currency_revisions(academy_id,currency_id,version),
 FOREIGN KEY(academy_id,quote_currency_id,quote_currency_version) REFERENCES public.finance_currency_revisions(academy_id,currency_id,version),
 FOREIGN KEY(academy_id,supersedes_id,base_currency_id,quote_currency_id,rate_on) REFERENCES public.finance_exchange_rates(academy_id,id,base_currency_id,quote_currency_id,rate_on),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind));
CREATE UNIQUE INDEX exchange_rate_root ON public.finance_exchange_rates(academy_id,base_currency_id,quote_currency_id,rate_on) WHERE supersedes_id IS NULL;
CREATE INDEX exchange_rate_pair_day ON public.finance_exchange_rates(academy_id,base_currency_id,quote_currency_id,rate_on DESC,id);
ALTER TABLE public.finance_exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_exchange_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.finance_exchange_rates USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.finance_exchange_rates FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write();
CREATE FUNCTION public.exchange_rate_source(i jsonb) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object(
 'base',(SELECT jsonb_build_object('id',id,'version',version,'code',code,'unitScale',unit_scale,'active',active) FROM public.finance_currency_catalogue WHERE id=(i#>>'{base,id}')::uuid),
 'quote',(SELECT jsonb_build_object('id',id,'version',version,'code',code,'unitScale',unit_scale,'active',active) FROM public.finance_currency_catalogue WHERE id=(i#>>'{quote,id}')::uuid),
 'prior',(SELECT jsonb_build_object('id',id,'baseCurrencyId',base_currency_id,'quoteCurrencyId',quote_currency_id,'on',rate_on,'state',state) FROM public.finance_exchange_rates WHERE id=(i->>'supersedesId')::uuid),
 'head',(SELECT h.id FROM public.finance_exchange_rates h WHERE h.base_currency_id=(i#>>'{base,id}')::uuid AND h.quote_currency_id=(i#>>'{quote,id}')::uuid AND h.rate_on=(i->>'on')::date AND NOT EXISTS(SELECT 1 FROM public.finance_exchange_rates c WHERE c.academy_id=h.academy_id AND c.supersedes_id=h.id)));
$$;
REVOKE ALL ON FUNCTION public.exchange_rate_source(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exchange_rate_source(jsonb) TO kavosh_runtime;
CREATE FUNCTION public.guard_exchange_rate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;s jsonb;digits integer;expected_denominator numeric;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'EXCHANGE_RATE_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM id FROM public.finance_currencies WHERE academy_id=NEW.academy_id AND id IN(NEW.base_currency_id,NEW.quote_currency_id) ORDER BY id FOR SHARE;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':'||NEW.base_currency_id::text||':'||NEW.quote_currency_id::text||':'||NEW.rate_on::text,288));
 NEW.created_at=transaction_timestamp();
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status<>'pending' OR p.action<>'finance.exchange-rate.record' OR p.privacy_capability IS DISTINCT FROM 'exchange-rates.edit' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.scope IS DISTINCT FROM '{"all":true,"hubs":[]}'::jsonb
  OR p.payload-ARRAY['base','quote','on','state','rate','supersedesId','source','reference','reason']<>'{}'::jsonb OR NOT(p.payload ?& ARRAY['base','quote','on','state','rate','supersedesId','source','reference','reason'])
  OR(p.payload#>>'{base,id}')::uuid IS DISTINCT FROM NEW.base_currency_id OR(p.payload#>>'{base,version}')::integer IS DISTINCT FROM NEW.base_currency_version OR(p.payload#>>'{quote,id}')::uuid IS DISTINCT FROM NEW.quote_currency_id OR(p.payload#>>'{quote,version}')::integer IS DISTINCT FROM NEW.quote_currency_version
  OR(p.payload->>'on')::date IS DISTINCT FROM NEW.rate_on OR p.payload->>'state' IS DISTINCT FROM NEW.state OR p.payload->>'rate' IS DISTINCT FROM NEW.rate OR(p.payload->>'supersedesId')::uuid IS DISTINCT FROM NEW.supersedes_id OR p.payload->>'source' IS DISTINCT FROM NEW.source OR p.payload->>'reference' IS DISTINCT FROM NEW.reference OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 THEN RAISE EXCEPTION 'EXCHANGE_RATE_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF p.payload->'base' IS DISTINCT FROM jsonb_build_object('id',NEW.base_currency_id,'version',NEW.base_currency_version) OR p.payload->'quote' IS DISTINCT FROM jsonb_build_object('id',NEW.quote_currency_id,'version',NEW.quote_currency_version) OR NOT public.report_comment_human_verified(NEW.created_by)
 THEN RAISE EXCEPTION 'EXCHANGE_RATE_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 s=public.exchange_rate_source(p.payload);
 IF p.review_context IS DISTINCT FROM s OR s->'base' IS NULL OR s->'quote' IS NULL OR(NEW.state='recorded' AND(s#>'{base,active}' IS DISTINCT FROM 'true'::jsonb OR s#>'{quote,active}' IS DISTINCT FROM 'true'::jsonb)) OR(s#>>'{base,version}')::integer IS DISTINCT FROM NEW.base_currency_version OR(s#>>'{quote,version}')::integer IS DISTINCT FROM NEW.quote_currency_version
  OR NEW.rate_on>(clock_timestamp() AT TIME ZONE 'UTC'+interval '14 hours')::date OR(s->>'head')::uuid IS DISTINCT FROM NEW.supersedes_id OR(NEW.state='void' AND s#>>'{prior,state}'='void')
 THEN RAISE EXCEPTION 'EXCHANGE_RATE_CURRENT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.state='recorded' THEN
  digits=length(rtrim(split_part(NEW.rate,'.',2),'0'));expected_denominator=power(10::numeric,digits);
  IF NEW.rate_denominator IS DISTINCT FROM expected_denominator OR NEW.rate_numerator IS DISTINCT FROM NEW.rate::numeric*expected_denominator OR NEW.rate_numerator<=0 THEN RAISE EXCEPTION 'EXCHANGE_RATE_EXACT_RATIO_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER exchange_rate_guard BEFORE INSERT OR UPDATE OR DELETE ON public.finance_exchange_rates FOR EACH ROW EXECUTE FUNCTION public.guard_exchange_rate();
CREATE CONSTRAINT TRIGGER exchange_rate_approval_complete AFTER INSERT ON public.finance_exchange_rates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.complete_exchange_rate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.id AND e.actor_id=NEW.created_by AND e.action='finance.exchange-rate.recorded' AND e.hub_id IS NULL AND e.created_at=transaction_timestamp() AND e.changes=jsonb_build_object('approvalId',NEW.approval_id,'state',NEW.state,'hasReason',true,'severity','critical','ledgerAdjusted',false))
 THEN RAISE EXCEPTION 'EXCHANGE_RATE_CRITICAL_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER exchange_rate_complete AFTER INSERT ON public.finance_exchange_rates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_exchange_rate();
CREATE FUNCTION public.exchange_rate_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.exchange-rate.record' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.finance_exchange_rates r WHERE r.academy_id=NEW.academy_id AND r.id=NEW.target_id AND r.approval_id=NEW.id AND r.created_by=NEW.reviewer_id)
 THEN RAISE EXCEPTION 'EXCHANGE_RATE_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER exchange_rate_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.exchange_rate_effect_required();
REVOKE ALL ON FUNCTION public.complete_exchange_rate(),public.exchange_rate_effect_required() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_exchange_rate() FROM PUBLIC;
GRANT SELECT,INSERT ON public.finance_exchange_rates TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 288 $$;

INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('checkouts.execute','Reserve and consume reviewed checkout dispatches','Finance',true,ARRAY['hub','class','person','country','region','city']);
CREATE TABLE public.payment_checkout_attempts(
 academy_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,actor_id uuid NOT NULL,audit_id uuid NOT NULL,
 source_fingerprint text NOT NULL CHECK(source_fingerprint~'^[a-f0-9]{64}$'),request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),request_bytes integer NOT NULL CHECK(request_bytes BETWEEN 1 AND 16384),
 origin text NOT NULL CHECK(length(origin) BETWEEN 9 AND 2000 AND origin~'^https://[^/?#@[:space:]]+$'),draft jsonb NOT NULL CHECK(jsonb_typeof(draft)='object' AND octet_length(draft::text)<=16384),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),
 FOREIGN KEY(academy_id,request_id) REFERENCES public.payment_checkout_requests(academy_id,id),FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id)
);
CREATE TABLE public.payment_checkout_dispatch_starts(
 academy_id uuid NOT NULL,id uuid NOT NULL,attempt_id uuid NOT NULL,actor_id uuid NOT NULL,audit_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,attempt_id),FOREIGN KEY(academy_id,attempt_id) REFERENCES public.payment_checkout_attempts(academy_id,id),FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id)
);
CREATE TABLE public.payment_checkout_dispatch_observations(
 academy_id uuid NOT NULL,id uuid NOT NULL,start_id uuid NOT NULL,actor_id uuid NOT NULL,audit_id uuid NOT NULL,state text NOT NULL CHECK(state IN('not_attempted','rejected','outcome_unknown','accepted')),
 provider_session_id text CHECK(provider_session_id~'^cs_(test|live)_[A-Za-z0-9]{1,200}$'),source_current boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,start_id),CHECK((state='accepted')=(provider_session_id IS NOT NULL)),FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id),
 FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payment_checkout_attempts','payment_checkout_dispatch_starts','payment_checkout_dispatch_observations'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,request_id,actor_id,audit_id,source_fingerprint,request_sha256,request_bytes,origin,draft) ON public.payment_checkout_attempts TO kavosh_runtime;
GRANT INSERT(academy_id,id,attempt_id,actor_id,audit_id) ON public.payment_checkout_dispatch_starts TO kavosh_runtime;
GRANT INSERT(academy_id,id,start_id,actor_id,audit_id,state,provider_session_id) ON public.payment_checkout_dispatch_observations TO kavosh_runtime;
CREATE FUNCTION public.payment_checkout_live_source(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE r record;p record;s jsonb;BEGIN
 SELECT * INTO r FROM public.payment_checkout_requests WHERE id=p_request;
 IF r.id IS NULL OR r.authorization_until<=statement_timestamp() OR EXISTS(SELECT 1 FROM public.payment_checkout_cancellations c WHERE c.academy_id=r.academy_id AND c.request_id=r.id)
 OR EXISTS(SELECT 1 FROM public.payment_checkout_requests n WHERE n.academy_id=r.academy_id AND n.prior_id=r.id)
 OR NOT EXISTS(SELECT 1 FROM public.academies a WHERE a.id=r.academy_id AND a.status='active') OR NOT public.report_comment_human_verified(r.created_by) THEN RETURN NULL;END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=r.academy_id AND id=r.approval_id AND status='applied';
 IF p.id IS NULL OR p.action<>'finance.checkout.request' OR p.target_id<>r.id OR p.reviewer_id<>r.created_by THEN RETURN NULL;END IF;
 s:=public.payment_checkout_source(r.invoice_id,r.connection_id,r.prior_id);
 IF s IS NULL OR(s->>'headId')::uuid IS DISTINCT FROM r.id OR r.context IS DISTINCT FROM jsonb_build_object('source',jsonb_set(s,'{headId}',r.context#>'{source,headId}')) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('requestId',r.id,'academyId',r.academy_id,'invoiceId',r.invoice_id,'connectionId',r.connection_id,'accountId',s#>>'{connection,accountId}','livemode',s#>'{connection,livemode}','apiVersion',s#>>'{connection,apiVersion}',
 'currencyCode',r.currency_code,'unitScale',r.unit_scale,'amountMinor',trunc(r.amount_minor)::text,'sessionLifetimeMinutes',r.session_lifetime_minutes,'authorizationUntil',r.authorization_until,'approvalId',r.approval_id,'source',s);
END $$;
CREATE FUNCTION public.guard_payment_checkout_dispatch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a record;r record;st record;ev record;s jsonb;action_name text;target_request uuid;target_attempt uuid;expected jsonb;expires bigint;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='payment_checkout_attempts' THEN target_request:=NEW.request_id;target_attempt:=NEW.id;action_name:='finance.checkout.reserved';
 ELSE
  IF TG_TABLE_NAME='payment_checkout_dispatch_starts' THEN target_attempt:=NEW.attempt_id;action_name:='finance.checkout.dispatch.started';
  ELSE SELECT * INTO st FROM public.payment_checkout_dispatch_starts WHERE academy_id=NEW.academy_id AND id=NEW.start_id;IF st.id IS NULL OR st.actor_id IS DISTINCT FROM NEW.actor_id THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_INVALID' USING ERRCODE='23514';END IF;target_attempt:=st.attempt_id;action_name:='finance.checkout.dispatch.observed';END IF;
  SELECT * INTO a FROM public.payment_checkout_attempts WHERE academy_id=NEW.academy_id AND id=target_attempt;target_request:=a.request_id;
 END IF;
 SELECT * INTO r FROM public.payment_checkout_requests WHERE academy_id=NEW.academy_id AND id=target_request;
 IF r.id IS NULL THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_INVALID' USING ERRCODE='23514';END IF;
 PERFORM id FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=r.invoice_id FOR UPDATE;
 PERFORM public.lock_payment_checkout_connection(r.connection_id);
 SELECT * INTO ev FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id AND actor_id=NEW.actor_id AND action=action_name AND entity_id=NEW.id AND hub_id=r.hub_id AND created_at=transaction_timestamp();
 expected:=jsonb_build_object('requestId',r.id,'attemptId',target_attempt,'severity','critical','providerVerified',false);
 IF TG_TABLE_NAME='payment_checkout_dispatch_observations' THEN expected:=expected||jsonb_build_object('state',NEW.state);END IF;
 IF ev.id IS NULL OR ev.changes IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;
 s:=public.payment_checkout_live_source(r.id);
 IF TG_TABLE_NAME<>'payment_checkout_dispatch_observations' THEN
  IF s IS NULL OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.actor_id AND status='active') THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='payment_checkout_attempts' THEN
   IF NEW.source_fingerprint IS DISTINCT FROM encode(sha256(convert_to(s::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
   IF jsonb_typeof(NEW.draft->'expiresAt') IS DISTINCT FROM 'number' OR(NEW.draft->>'expiresAt')!~'^[1-9][0-9]{0,9}$' THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_DRAFT_INVALID' USING ERRCODE='23514';END IF;
   expires:=(NEW.draft->>'expiresAt')::bigint;
   IF expires<floor(extract(epoch FROM clock_timestamp()))+1800 OR expires>ceil(extract(epoch FROM clock_timestamp()))+r.session_lifetime_minutes*60 THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_EXPIRY_INVALID' USING ERRCODE='23514';END IF;
   expected:=jsonb_build_object('requestId',r.id,'academyId',r.academy_id,'invoiceId',r.invoice_id,'connectionId',r.connection_id,'accountId',s->>'accountId','livemode',s->'livemode','currencyCode',r.currency_code,'unitScale',r.unit_scale,'amountMinor',trunc(r.amount_minor)::text,'expiresAt',expires,
    'successUrl',NEW.origin||'/?payment_request='||r.id::text||'&payment_return=success','cancelUrl',NEW.origin||'/?payment_request='||r.id::text||'&payment_return=cancel');
   IF NEW.draft IS DISTINCT FROM expected THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_DRAFT_INVALID' USING ERRCODE='23514';END IF;
  ELSE
   IF a.source_fingerprint IS DISTINCT FROM encode(sha256(convert_to(s::text,'UTF8')),'hex') OR(a.draft->>'expiresAt')::bigint<=extract(epoch FROM clock_timestamp()) THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  END IF;
 ELSE
  NEW.source_current=s IS NOT NULL;
  IF NEW.state='accepted' AND NOT starts_with(NEW.provider_session_id,CASE WHEN(r.context#>>'{source,connection,livemode}')::boolean THEN 'cs_live_' ELSE 'cs_test_' END) THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_SESSION_MODE_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payment_checkout_attempts','payment_checkout_dispatch_starts','payment_checkout_dispatch_observations'] LOOP
 EXECUTE format('CREATE TRIGGER checkout_dispatch_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_payment_checkout_dispatch()',t);
END LOOP;END $$;
-- Untrusted actor observations never authorize another external call. A start
-- blocks cancellation/replacement even after expiry or a not_attempted claim.
CREATE FUNCTION public.guard_checkout_after_dispatch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record;target uuid;BEGIN
 IF TG_TABLE_NAME='payment_checkout_cancellations' THEN target:=NEW.request_id;ELSE target:=NEW.prior_id;END IF;
 IF target IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO r FROM public.payment_checkout_requests WHERE academy_id=NEW.academy_id AND id=target;
 PERFORM id FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=r.invoice_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.payment_checkout_attempts a JOIN public.payment_checkout_dispatch_starts st ON st.academy_id=a.academy_id AND st.attempt_id=a.id WHERE a.academy_id=NEW.academy_id AND a.request_id=target) THEN RAISE EXCEPTION 'CHECKOUT_DISPATCH_RECONCILIATION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER aaa_checkout_after_dispatch BEFORE INSERT ON public.payment_checkout_requests FOR EACH ROW EXECUTE FUNCTION public.guard_checkout_after_dispatch();
CREATE TRIGGER aaa_checkout_after_dispatch BEFORE INSERT ON public.payment_checkout_cancellations FOR EACH ROW EXECUTE FUNCTION public.guard_checkout_after_dispatch();
REVOKE ALL ON FUNCTION public.payment_checkout_live_source(uuid),public.guard_payment_checkout_dispatch(),public.guard_checkout_after_dispatch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payment_checkout_live_source(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 294 $$;

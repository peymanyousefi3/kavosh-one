INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('checkouts.view','View permitted invoice checkout requests','Finance',true,ARRAY['hub','class','person','country','region','city']),
 ('checkouts.edit','Request reviewed invoice checkout preparation','Finance',true,ARRAY['hub','class','person','country','region','city']);
-- Connection configuration contains no secrets. Ordinary runtime may read only
-- its current school's registry; the public callback remains ingest-only.
CREATE POLICY checkout_connection_read ON public.payment_connections FOR SELECT TO kavosh_runtime USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.payment_connections TO kavosh_runtime;
-- A row-share lock requires an UPDATE privilege. Keep registry writes operator-
-- only: expose a lock broker rather than grant runtime UPDATE(enabled).
CREATE FUNCTION public.lock_payment_checkout_connection(p_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM id FROM public.payment_connections WHERE id=p_id AND academy_id=nullif(current_setting('app.academy_id',true),'')::uuid FOR SHARE;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.lock_payment_checkout_connection(uuid) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO kavosh_payment_policy;
ALTER FUNCTION public.lock_payment_checkout_connection(uuid) OWNER TO kavosh_payment_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_payment_policy;
GRANT EXECUTE ON FUNCTION public.lock_payment_checkout_connection(uuid) TO kavosh_runtime;
CREATE TABLE public.payment_checkout_requests(
 academy_id uuid NOT NULL,id uuid NOT NULL,invoice_id uuid NOT NULL,student_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,connection_id uuid NOT NULL,prior_id uuid,
 amount_text text NOT NULL CHECK(length(amount_text) BETWEEN 1 AND 80),amount_minor numeric NOT NULL CHECK(amount_minor=trunc(amount_minor) AND amount_minor>0 AND amount_minor<1e38),
 currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),currency_code text NOT NULL,
 session_lifetime_minutes integer NOT NULL CHECK(session_lifetime_minutes BETWEEN 30 AND 1440),dispatch_within_minutes integer NOT NULL CHECK(dispatch_within_minutes BETWEEN 1 AND 1440),
 context jsonb NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),authorization_until timestamptz NOT NULL,
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,prior_id),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,invoice_id,student_id,class_id,hub_id) REFERENCES public.tuition_invoices(academy_id,id,student_id,class_id,hub_id),
 FOREIGN KEY(academy_id,connection_id) REFERENCES public.payment_connections(academy_id,id),FOREIGN KEY(academy_id,prior_id) REFERENCES public.payment_checkout_requests(academy_id,id),
 FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE UNIQUE INDEX checkout_one_root ON public.payment_checkout_requests(academy_id,invoice_id) WHERE prior_id IS NULL;
CREATE INDEX checkout_invoice ON public.payment_checkout_requests(academy_id,invoice_id,id);
CREATE TABLE public.payment_checkout_cancellations(
 academy_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,request_id) REFERENCES public.payment_checkout_requests(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payment_checkout_requests','payment_checkout_cancellations'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
END LOOP;END $$;
CREATE FUNCTION public.payment_checkout_source(p_invoice uuid,p_connection uuid,p_prior uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('invoice',jsonb_build_object('id',i.id,'planId',i.plan_id,'planVersion',i.plan_version,'studentId',i.student_id,'classId',i.class_id,'hubId',i.hub_id,'creditId',i.credit_id,'journalId',i.journal_id),
 'terms',jsonb_build_object('currencyId',p.currency_id,'unitScale',p.unit_scale,'currencyCode',c.code,'grossMinor',t.gross_minor::text,'receivedMinor',paid.amount::text,'outstandingMinor',(t.gross_minor-paid.amount)::text),
 'connection',jsonb_build_object('id',pc.id,'academyId',pc.academy_id,'accountId',pc.account_id,'livemode',pc.livemode,'apiVersion',pc.api_version,'enabled',pc.enabled),
 'prior',CASE WHEN old.id IS NULL THEN NULL ELSE jsonb_build_object('id',old.id,'authorizationUntil',old.authorization_until,'cancellationId',cancel.id) END,
 'headId',(SELECT r.id FROM public.payment_checkout_requests r WHERE r.academy_id=i.academy_id AND r.invoice_id=i.id AND NOT EXISTS(SELECT 1 FROM public.payment_checkout_requests s WHERE s.academy_id=r.academy_id AND s.prior_id=r.id)))
 FROM public.tuition_invoices i JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id
 JOIN public.tuition_plan_revisions t ON t.academy_id=i.academy_id AND t.plan_id=i.plan_id AND t.version=i.plan_version
 JOIN public.finance_currencies c ON c.academy_id=p.academy_id AND c.id=p.currency_id
 JOIN public.payment_connections pc ON pc.academy_id=i.academy_id AND pc.id=p_connection
 CROSS JOIN LATERAL(SELECT coalesce(sum(r.amount_minor),0) amount FROM public.tuition_receipts r WHERE r.academy_id=i.academy_id AND r.invoice_id=i.id AND r.reversal_id IS NULL) paid
 LEFT JOIN public.payment_checkout_requests old ON old.academy_id=i.academy_id AND old.invoice_id=i.id AND old.id=p_prior
 LEFT JOIN public.payment_checkout_cancellations cancel ON cancel.academy_id=old.academy_id AND cancel.request_id=old.id WHERE i.id=p_invoice;
$$;
CREATE FUNCTION public.payment_checkout_cancel_source(p_request uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',r.id,'invoiceId',r.invoice_id,'connectionId',r.connection_id,'approvalId',r.approval_id,'cancellationId',c.id,'successorId',s.id)
 FROM public.payment_checkout_requests r LEFT JOIN public.payment_checkout_cancellations c ON c.academy_id=r.academy_id AND c.request_id=r.id
 LEFT JOIN public.payment_checkout_requests s ON s.academy_id=r.academy_id AND s.prior_id=r.id WHERE r.id=p_request;
$$;
CREATE FUNCTION public.guard_payment_checkout() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;s jsonb;invoice uuid;source_scope jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CHECKOUT_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='payment_checkout_requests' THEN invoice:=NEW.invoice_id;ELSE SELECT invoice_id INTO invoice FROM public.payment_checkout_requests WHERE academy_id=NEW.academy_id AND id=NEW.request_id;END IF;
 PERFORM id FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=invoice FOR UPDATE;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.privacy_capability IS DISTINCT FROM 'checkouts.edit' OR NOT public.report_comment_human_verified(NEW.created_by)
 THEN RAISE EXCEPTION 'CHECKOUT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=transaction_timestamp();
 IF TG_TABLE_NAME='payment_checkout_requests' THEN
  PERFORM public.lock_payment_checkout_connection(NEW.connection_id);
  NEW.authorization_until=NEW.created_at+make_interval(mins=>NEW.dispatch_within_minutes);
  IF p.action IS DISTINCT FROM 'finance.checkout.request' OR p.payload IS DISTINCT FROM jsonb_build_object('invoiceId',NEW.invoice_id,'connectionId',NEW.connection_id,'priorId',NEW.prior_id,'amount',NEW.amount_text,'sessionLifetimeMinutes',NEW.session_lifetime_minutes,'dispatchWithinMinutes',NEW.dispatch_within_minutes,'reason',NEW.reason) OR length(NEW.amount_text)>80 OR NEW.amount_text!~'^[0-9]+([.][0-9]+)?$'
  THEN RAISE EXCEPTION 'CHECKOUT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
  s:=public.payment_checkout_source(NEW.invoice_id,NEW.connection_id,NEW.prior_id);
  IF s IS NULL OR p.review_context IS DISTINCT FROM jsonb_build_object('source',s) OR NEW.context IS DISTINCT FROM p.review_context OR s#>'{invoice,creditId}' IS DISTINCT FROM 'null'::jsonb OR s#>'{invoice,journalId}' IS NOT DISTINCT FROM 'null'::jsonb OR s#>'{connection,enabled}' IS DISTINCT FROM 'true'::jsonb
   OR(s#>>'{terms,currencyId}')::uuid IS DISTINCT FROM NEW.currency_id OR(s#>>'{terms,unitScale}')::integer IS DISTINCT FROM NEW.unit_scale OR s#>>'{terms,currencyCode}' IS DISTINCT FROM NEW.currency_code
   OR NEW.amount_minor IS DISTINCT FROM NEW.amount_text::numeric*power(10::numeric,NEW.unit_scale) OR NEW.amount_minor>(s#>>'{terms,outstandingMinor}')::numeric
   OR(s->>'headId')::uuid IS DISTINCT FROM NEW.prior_id OR(NEW.prior_id IS NOT NULL AND(s->'prior'='null'::jsonb OR(s#>>'{prior,cancellationId}' IS NULL AND(s#>>'{prior,authorizationUntil}')::timestamptz>statement_timestamp())))
  THEN RAISE EXCEPTION 'CHECKOUT_CURRENT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
  source_scope:=jsonb_build_object('hubId',NEW.hub_id,'classId',NEW.class_id,'studentId',NEW.student_id);
 ELSE
  s:=public.payment_checkout_cancel_source(NEW.request_id);
  IF p.action IS DISTINCT FROM 'finance.checkout.cancel' OR p.payload IS DISTINCT FROM jsonb_build_object('requestId',NEW.request_id,'reason',NEW.reason) OR s IS NULL OR p.review_context IS DISTINCT FROM jsonb_build_object('source',s) OR s->'cancellationId' IS DISTINCT FROM 'null'::jsonb OR s->'successorId' IS DISTINCT FROM 'null'::jsonb
  THEN RAISE EXCEPTION 'CHECKOUT_CANCEL_CURRENT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
  SELECT jsonb_build_object('hubId',hub_id,'classId',class_id,'studentId',student_id) INTO source_scope FROM public.payment_checkout_requests WHERE academy_id=NEW.academy_id AND id=NEW.request_id;
 END IF;
 IF p.scope->'recordContext' IS DISTINCT FROM source_scope THEN RAISE EXCEPTION 'CHECKOUT_EXACT_SCOPE_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payment_checkout_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payment_checkout_requests FOR EACH ROW EXECUTE FUNCTION public.guard_payment_checkout();
CREATE TRIGGER payment_checkout_cancel_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payment_checkout_cancellations FOR EACH ROW EXECUTE FUNCTION public.guard_payment_checkout();
CREATE CONSTRAINT TRIGGER payment_checkout_reviewed AFTER INSERT ON public.payment_checkout_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE CONSTRAINT TRIGGER payment_checkout_cancel_reviewed AFTER INSERT ON public.payment_checkout_cancellations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.complete_payment_checkout() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE event_action text;hub uuid;BEGIN
 IF TG_TABLE_NAME='payment_checkout_requests' THEN event_action:='finance.checkout.request';hub:=NEW.hub_id;ELSE event_action:='finance.checkout.cancel';SELECT hub_id INTO hub FROM public.payment_checkout_requests WHERE academy_id=NEW.academy_id AND id=NEW.request_id;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.id AND e.actor_id=NEW.created_by AND e.action=event_action AND e.hub_id=hub AND e.created_at=transaction_timestamp() AND e.changes=jsonb_build_object('approvalId',NEW.approval_id,'severity','critical','hasReason',true,'providerRequestMade',false))
 THEN RAISE EXCEPTION 'CHECKOUT_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_checkout_complete AFTER INSERT ON public.payment_checkout_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_payment_checkout();
CREATE CONSTRAINT TRIGGER payment_checkout_cancel_complete AFTER INSERT ON public.payment_checkout_cancellations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_payment_checkout();
CREATE FUNCTION public.payment_checkout_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND((NEW.action='finance.checkout.request' AND NOT EXISTS(SELECT 1 FROM public.payment_checkout_requests r WHERE r.academy_id=NEW.academy_id AND r.id=NEW.target_id AND r.approval_id=NEW.id AND r.created_by=NEW.reviewer_id)) OR(NEW.action='finance.checkout.cancel' AND NOT EXISTS(SELECT 1 FROM public.payment_checkout_cancellations r WHERE r.academy_id=NEW.academy_id AND r.id=NEW.target_id AND r.approval_id=NEW.id AND r.created_by=NEW.reviewer_id)))
 THEN RAISE EXCEPTION 'CHECKOUT_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_checkout_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payment_checkout_effect_required();
CREATE FUNCTION public.payment_checkout_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','checkouts.view','scope',NEW.scope),jsonb_build_object('capability','invoices.view','scope',NEW.scope));RETURN NEW;
END $$;
CREATE TRIGGER zz_payment_checkout_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN ('finance.checkout.request','finance.checkout.cancel')) EXECUTE FUNCTION public.payment_checkout_privacy();
GRANT SELECT,INSERT ON public.payment_checkout_requests,public.payment_checkout_cancellations TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.payment_checkout_source(uuid,uuid,uuid),public.payment_checkout_cancel_source(uuid),public.guard_payment_checkout(),public.complete_payment_checkout(),public.payment_checkout_effect_required(),public.payment_checkout_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payment_checkout_source(uuid,uuid,uuid),public.payment_checkout_cancel_source(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 293 $$;

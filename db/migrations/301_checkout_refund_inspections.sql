CREATE TABLE public.checkout_refund_inspections(
 academy_id uuid NOT NULL,id uuid NOT NULL,start_id uuid NOT NULL,principal_inspection_id uuid NOT NULL,worker_id uuid NOT NULL,request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),
 refund_inspection jsonb NOT NULL CHECK(jsonb_typeof(refund_inspection)='object' AND octet_length(refund_inspection::text)<=131072),object_conflict boolean NOT NULL,recorded_by name NOT NULL DEFAULT session_user,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id),FOREIGN KEY(academy_id,principal_inspection_id) REFERENCES public.checkout_provider_inspections(academy_id,id)
);
CREATE INDEX checkout_refund_start ON public.checkout_refund_inspections(academy_id,start_id,id);
CREATE TABLE public.checkout_refund_object_bindings(
 academy_id uuid NOT NULL,account_id text NOT NULL,livemode boolean NOT NULL,refund_id text NOT NULL,start_id uuid NOT NULL,charge_id text NOT NULL,amount numeric NOT NULL,currency text NOT NULL,
 PRIMARY KEY(academy_id,account_id,livemode,refund_id),FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id)
);
-- Append-only attention is deliberately not cleared by an empty page or a
-- later old/failed response. Explicit reviewed resolution is a separate flow.
CREATE TABLE public.checkout_refund_attention(
 academy_id uuid NOT NULL,start_id uuid NOT NULL,charge_id text NOT NULL,inspection_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,start_id,charge_id),FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id),FOREIGN KEY(academy_id,inspection_id) REFERENCES public.checkout_refund_inspections(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['checkout_refund_inspections','checkout_refund_object_bindings','checkout_refund_attention'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY checkout_result_executor ON public.%I TO kavosh_checkout_result_policy USING(true) WITH CHECK(true)',t);
 EXECUTE format('GRANT SELECT,INSERT ON public.%I TO kavosh_checkout_result_policy',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT CREATE ON SCHEMA public TO kavosh_checkout_result_policy;
CREATE FUNCTION public.record_checkout_refund_inspection(p_academy uuid,p_id uuid,p_start uuid,p_principal uuid,p_worker uuid,p_hash text,p_page jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original record;existing record;owner record;draft jsonb;j jsonb;r jsonb;field text;seen text[]:=ARRAY[]::text[];last_id text;conflict boolean;attention boolean;success_total numeric:=0;
BEGIN
 IF p_academy IS NULL OR p_id IS NULL OR p_start IS NULL OR p_principal IS NULL OR p_worker IS NULL OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR p_page IS NULL OR jsonb_typeof(p_page)<>'object' OR octet_length(p_page::text)>131072 THEN RAISE EXCEPTION 'INVALID_REFUND_INSPECTION' USING ERRCODE='23514';END IF;
 j:=p_page;SELECT * INTO original FROM public.checkout_provider_inspections WHERE academy_id=p_academy AND id=p_principal AND start_id=p_start AND request_sha256=p_hash;
 SELECT a.draft INTO draft FROM public.payment_checkout_dispatch_starts s JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE s.academy_id=p_academy AND s.id=p_start AND a.request_sha256=p_hash;
 IF original.id IS NULL OR draft IS NULL THEN RETURN 'unavailable';END IF;
 IF j->>'state' IS NULL OR j->>'state' NOT IN('principal_not_captured','refund_page') OR j->>'sessionId' IS DISTINCT FROM original.inspection->>'sessionId' OR j->>'paymentId' IS DISTINCT FROM original.inspection->>'paymentId' OR j->>'chargeId' IS DISTINCT FROM original.inspection->>'chargeId'
 OR(j->>'state'='principal_not_captured') IS DISTINCT FROM(original.inspection->>'state' IN('awaiting_payment','expired'))
 OR NOT j?'paymentId' OR NOT j?'chargeId' THEN RAISE EXCEPTION 'REFUND_INSPECTION_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 FOREACH field IN ARRAY ARRAY['absenceVerified','bankSettled','ledgerAdjusted','refundExecuted','refundAccountingPosted'] LOOP IF j->field IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'INVALID_REFUND_INSPECTION' USING ERRCODE='23514';END IF;END LOOP;
 FOREACH field IN ARRAY ARRAY['startingAfter','nextCursor'] LOOP IF NOT j?field OR jsonb_typeof(j->field) NOT IN('string','null') OR(j->field<>'null'::jsonb AND(j->>field)!~'^re_[A-Za-z0-9]{1,200}$') THEN RAISE EXCEPTION 'INVALID_REFUND_INSPECTION' USING ERRCODE='23514';END IF;END LOOP;
 IF jsonb_typeof(j->'hasMore') IS DISTINCT FROM 'boolean' OR jsonb_typeof(j->'refunds') IS DISTINCT FROM 'array' OR jsonb_array_length(j->'refunds')>100 THEN RAISE EXCEPTION 'INVALID_REFUND_INSPECTION' USING ERRCODE='23514';END IF;
 IF j->>'state'='principal_not_captured' THEN
  IF j-ARRAY['state','sessionId','paymentId','chargeId','startingAfter','nextCursor','hasMore','refunds','absenceVerified','bankSettled','ledgerAdjusted','refundExecuted','refundAccountingPosted']<>'{}'::jsonb OR j->'hasMore'<>'false'::jsonb OR j->'nextCursor'<>'null'::jsonb OR j->'refunds'<>'[]'::jsonb THEN RAISE EXCEPTION 'INVALID_REFUND_INSPECTION' USING ERRCODE='23514';END IF;
 ELSE
  IF j-ARRAY['state','sessionId','paymentId','chargeId','startingAfter','nextCursor','hasMore','refunds','absenceVerified','bankSettled','ledgerAdjusted','refundExecuted','refundAccountingPosted','observedPrincipalRefundedAmount','principalRequiresReview','currency','providerUnitScale']<>'{}'::jsonb
  OR j->'currency' IS DISTINCT FROM original.inspection->'currency' OR j->'providerUnitScale' IS DISTINCT FROM to_jsonb(CASE public.checkout_provider_amount(upper(original.inspection->>'currency'),0,1) WHEN 1 THEN 0 WHEN 100 THEN 2 WHEN 1000 THEN 3 ELSE -1 END)
  OR j->'observedPrincipalRefundedAmount' IS DISTINCT FROM original.inspection->'refundedAmount' OR j->'principalRequiresReview' IS DISTINCT FROM to_jsonb(original.inspection->>'state'='requires_review') THEN RAISE EXCEPTION 'REFUND_INSPECTION_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 attention:=original.object_conflict OR j->'principalRequiresReview'='true'::jsonb OR j->'hasMore'='true'::jsonb;
 FOR r IN SELECT * FROM jsonb_array_elements(j->'refunds') LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['id','amount','currency','createdAt','status','balanceTransactionId','failureBalanceTransactionId','reason','failureReason','pendingReason']<>'{}'::jsonb
  OR r->>'id' IS NULL OR(r->>'id')!~'^re_[A-Za-z0-9]{1,200}$' OR r->>'id'=ANY(seen) OR r->>'id' IS NOT DISTINCT FROM j->>'startingAfter'
  OR jsonb_typeof(r->'amount') IS DISTINCT FROM 'number' OR(r->>'amount')!~'^[1-9][0-9]{0,11}$' OR(r->>'amount')::numeric>(original.inspection->>'amount')::numeric
  OR r->'currency' IS DISTINCT FROM original.inspection->'currency' OR jsonb_typeof(r->'createdAt') IS DISTINCT FROM 'number' OR(r->>'createdAt')!~'^[1-9][0-9]{0,9}$' OR(r->>'createdAt')::numeric>9999999999
  OR NOT r?'status' OR jsonb_typeof(r->'status') NOT IN('string','null') OR(r->'status'<>'null'::jsonb AND r->>'status' NOT IN('pending','requires_action','succeeded','failed','canceled'))
  OR NOT r?'reason' OR jsonb_typeof(r->'reason') NOT IN('string','null') OR(r->'reason'<>'null'::jsonb AND r->>'reason' NOT IN('duplicate','fraudulent','requested_by_customer','expired_uncaptured_charge')) THEN RAISE EXCEPTION 'INVALID_REFUND_FACTS' USING ERRCODE='23514';END IF;
  FOREACH field IN ARRAY ARRAY['balanceTransactionId','failureBalanceTransactionId','failureReason','pendingReason'] LOOP
   IF NOT r?field OR jsonb_typeof(r->field) NOT IN('string','null') OR(r->field<>'null'::jsonb AND(r->>field)!~CASE WHEN field IN('balanceTransactionId','failureBalanceTransactionId') THEN '^txn_[A-Za-z0-9]{1,200}$' ELSE '^[a-z][a-z0-9_]{0,63}$' END) THEN RAISE EXCEPTION 'INVALID_REFUND_FACTS' USING ERRCODE='23514';END IF;
  END LOOP;
  IF r->>'status'='succeeded' THEN success_total:=success_total+(r->>'amount')::numeric;END IF;
  attention:=coalesce(attention,false) OR r->>'status' IS NULL OR r->>'status' NOT IN('failed','canceled');seen:=array_append(seen,r->>'id');last_id:=r->>'id';
 END LOOP;
 IF success_total>coalesce((original.inspection->>'amount')::numeric,0) OR(j->'hasMore'='true'::jsonb AND last_id IS NULL) OR j->>'nextCursor' IS DISTINCT FROM(CASE WHEN j->'hasMore'='true'::jsonb THEN last_id ELSE NULL END) THEN RAISE EXCEPTION 'REFUND_PAGE_INVALID' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||':checkout-provider:'||(draft->>'accountId'),0));
 SELECT * INTO existing FROM public.checkout_refund_inspections WHERE academy_id=p_academy AND id=p_id;
 IF FOUND THEN IF existing.start_id=p_start AND existing.principal_inspection_id=p_principal AND existing.request_sha256=p_hash AND existing.refund_inspection=j THEN RETURN CASE WHEN existing.object_conflict THEN 'duplicate_conflict' ELSE 'duplicate' END;END IF;RAISE EXCEPTION 'REFUND_INSPECTION_ID_CONFLICT' USING ERRCODE='23514';END IF;
 conflict:=original.object_conflict;
 FOR r IN SELECT * FROM jsonb_array_elements(j->'refunds') LOOP
  INSERT INTO public.checkout_refund_object_bindings(academy_id,account_id,livemode,refund_id,start_id,charge_id,amount,currency) VALUES(p_academy,draft->>'accountId',(draft->>'livemode')::boolean,r->>'id',p_start,j->>'chargeId',(r->>'amount')::numeric,r->>'currency') ON CONFLICT DO NOTHING;
  conflict:=conflict OR NOT EXISTS(SELECT 1 FROM public.checkout_refund_object_bindings WHERE academy_id=p_academy AND account_id=draft->>'accountId' AND livemode=(draft->>'livemode')::boolean AND refund_id=r->>'id' AND start_id=p_start AND charge_id=j->>'chargeId' AND amount=(r->>'amount')::numeric AND currency=r->>'currency');
 END LOOP;
 INSERT INTO public.checkout_refund_inspections(academy_id,id,start_id,principal_inspection_id,worker_id,request_sha256,refund_inspection,object_conflict) VALUES(p_academy,p_id,p_start,p_principal,p_worker,p_hash,j,conflict);
 IF(coalesce(attention,false) OR conflict) AND j->>'chargeId' IS NOT NULL THEN INSERT INTO public.checkout_refund_attention(academy_id,start_id,charge_id,inspection_id) VALUES(p_academy,p_start,j->>'chargeId',p_id) ON CONFLICT DO NOTHING;END IF;
 IF conflict THEN INSERT INTO public.checkout_refund_attention(academy_id,start_id,charge_id,inspection_id) SELECT p_academy,b.start_id,b.charge_id,p_id FROM public.checkout_refund_object_bindings b WHERE b.academy_id=p_academy AND b.account_id=draft->>'accountId' AND b.livemode=(draft->>'livemode')::boolean AND b.refund_id=ANY(seen) ON CONFLICT DO NOTHING;END IF;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),CASE WHEN coalesce(attention,false) OR conflict THEN 'checkout.refunds.review_required.critical' ELSE 'checkout.refunds.observed' END,p_start,p_id);
 RETURN CASE WHEN conflict THEN 'recorded_conflict' ELSE 'recorded' END;
END $$;
ALTER FUNCTION public.record_checkout_refund_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb) OWNER TO kavosh_checkout_result_policy;REVOKE CREATE ON SCHEMA public FROM kavosh_checkout_result_policy;
REVOKE ALL ON FUNCTION public.record_checkout_refund_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_checkout_refund_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb) TO kavosh_checkout_result_worker;
-- Preserve both existing function identities,owners,ACLs and settings. Exact
-- body markers fail the migration rather than silently dropping a guard.
DO $$ DECLARE original text;changed text;BEGIN
 original:=pg_get_functiondef('public.customer_credit_source(uuid,uuid)'::regprocedure);
 changed:=replace(original,'''providerReviewRequired'',latest.id IS NULL','''providerReviewRequired'',EXISTS(SELECT 1 FROM public.checkout_refund_attention ra WHERE ra.academy_id=c.academy_id AND ra.start_id=c.start_id AND ra.charge_id=c.charge_id) OR latest.id IS NULL');
 IF changed=original THEN RAISE EXCEPTION 'CUSTOMER_CREDIT_REFUND_GUARD_MARKER_MISSING';END IF;EXECUTE changed;
 original:=pg_get_functiondef('public.provider_collection_source(uuid)'::regprocedure);
 changed:=replace(original,'WHERE i.id=p_inspection AND NOT i.object_conflict','WHERE i.id=p_inspection AND NOT EXISTS(SELECT 1 FROM public.checkout_refund_attention ra WHERE ra.academy_id=i.academy_id AND ra.start_id=i.start_id AND ra.charge_id=i.inspection->>''chargeId'') AND NOT i.object_conflict');
 IF changed=original THEN RAISE EXCEPTION 'PROVIDER_COLLECTION_REFUND_GUARD_MARKER_MISSING';END IF;EXECUTE changed;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 301 $$;

-- Retained provider observations,not permission to accept/close a dispute,
-- return customer credit,post a chargeback or claim bank settlement.
CREATE TABLE public.checkout_dispute_inspections(
 academy_id uuid NOT NULL,id uuid NOT NULL,start_id uuid NOT NULL,principal_inspection_id uuid NOT NULL,worker_id uuid NOT NULL,request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),
 dispute_inspection jsonb NOT NULL CHECK(jsonb_typeof(dispute_inspection)='object' AND octet_length(dispute_inspection::text)<=131072),object_conflict boolean NOT NULL,origin_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),recorded_by name NOT NULL DEFAULT session_user,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id),FOREIGN KEY(academy_id,principal_inspection_id) REFERENCES public.checkout_provider_inspections(academy_id,id)
);
CREATE INDEX checkout_dispute_start ON public.checkout_dispute_inspections(academy_id,start_id,id);
CREATE TABLE public.checkout_dispute_object_bindings(
 academy_id uuid NOT NULL,account_id text NOT NULL,livemode boolean NOT NULL,dispute_id text NOT NULL,start_id uuid NOT NULL,charge_id text NOT NULL,
 PRIMARY KEY(academy_id,account_id,livemode,dispute_id),FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id)
);
CREATE TABLE public.checkout_dispute_attention(
 academy_id uuid NOT NULL,start_id uuid NOT NULL,charge_id text NOT NULL,inspection_id uuid NOT NULL,
 PRIMARY KEY(academy_id,start_id,charge_id),FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id),FOREIGN KEY(academy_id,inspection_id) REFERENCES public.checkout_dispute_inspections(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['checkout_dispute_inspections','checkout_dispute_object_bindings','checkout_dispute_attention'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY checkout_result_executor ON public.%I TO kavosh_checkout_result_policy USING(true) WITH CHECK(true)',t);
 EXECUTE format('GRANT SELECT,INSERT ON public.%I TO kavosh_checkout_result_policy',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT CREATE ON SCHEMA public TO kavosh_checkout_result_policy;
CREATE FUNCTION public.record_checkout_dispute_inspection(p_academy uuid,p_id uuid,p_start uuid,p_principal uuid,p_worker uuid,p_hash text,p_page jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original record;existing record;draft jsonb;j jsonb:=p_page;r jsonb;field text;keys text[];seen text[]:=ARRAY[]::text[];last_id text;conflict boolean;attention boolean;BEGIN
 IF p_academy IS NULL OR p_id IS NULL OR p_start IS NULL OR p_principal IS NULL OR p_worker IS NULL OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR j IS NULL OR jsonb_typeof(j)<>'object' OR octet_length(j::text)>131072 THEN RAISE EXCEPTION 'INVALID_DISPUTE_INSPECTION' USING ERRCODE='23514';END IF;
 SELECT * INTO original FROM public.checkout_provider_inspections WHERE academy_id=p_academy AND id=p_principal AND start_id=p_start AND request_sha256=p_hash;
 SELECT a.draft INTO draft FROM public.payment_checkout_dispatch_starts s JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE s.academy_id=p_academy AND s.id=p_start AND a.request_sha256=p_hash;
 IF original.id IS NULL OR draft IS NULL THEN RETURN 'unavailable';END IF;
 IF j->>'state' IS NULL OR j->>'state' NOT IN('principal_not_captured','dispute_page') OR j->'sessionId' IS DISTINCT FROM original.inspection->'sessionId' OR j->'paymentId' IS DISTINCT FROM original.inspection->'paymentId' OR j->'chargeId' IS DISTINCT FROM coalesce(original.inspection->'chargeId','null'::jsonb)
 OR(j->>'state'='principal_not_captured') IS DISTINCT FROM(original.inspection->>'state' IN('awaiting_payment','expired')) THEN RAISE EXCEPTION 'DISPUTE_INSPECTION_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 FOREACH field IN ARRAY ARRAY['absenceVerified','bankSettled','ledgerAdjusted','creditRestored','fundsReturnVerified'] LOOP IF j->field IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'DISPUTE_INSPECTION_NOT_AUTHORITY' USING ERRCODE='23514';END IF;END LOOP;
 FOREACH field IN ARRAY ARRAY['startingAfter','nextCursor'] LOOP IF NOT j?field OR jsonb_typeof(j->field) NOT IN('string','null') OR(j->field<>'null'::jsonb AND(j->>field)!~'^du_[A-Za-z0-9]{1,200}$') THEN RAISE EXCEPTION 'INVALID_DISPUTE_CURSOR' USING ERRCODE='23514';END IF;END LOOP;
 IF jsonb_typeof(j->'hasMore') IS DISTINCT FROM 'boolean' OR jsonb_typeof(j->'disputes') IS DISTINCT FROM 'array' OR jsonb_array_length(j->'disputes')>100 THEN RAISE EXCEPTION 'INVALID_DISPUTE_PAGE' USING ERRCODE='23514';END IF;
 keys=ARRAY['state','sessionId','paymentId','chargeId','startingAfter','nextCursor','hasMore','disputes','absenceVerified','bankSettled','ledgerAdjusted','creditRestored','fundsReturnVerified'];
 IF j->>'state'='principal_not_captured' THEN
  IF j->'hasMore'<>'false'::jsonb OR j->'nextCursor'<>'null'::jsonb OR j->'disputes'<>'[]'::jsonb THEN RAISE EXCEPTION 'INVALID_DISPUTE_PAGE' USING ERRCODE='23514';END IF;
 ELSE
  keys=keys||ARRAY['currency','providerUnitScale','observedPrincipalDisputed','principalRequiresReview'];
  IF j->'currency' IS DISTINCT FROM original.inspection->'currency' OR j->'providerUnitScale' IS DISTINCT FROM to_jsonb(CASE public.checkout_provider_amount(upper(original.inspection->>'currency'),0,1) WHEN 1 THEN 0 WHEN 100 THEN 2 WHEN 1000 THEN 3 ELSE -1 END)
  OR j->'observedPrincipalDisputed' IS DISTINCT FROM original.inspection->'disputed' OR j->'principalRequiresReview' IS DISTINCT FROM to_jsonb(original.inspection->>'state'='requires_review') THEN RAISE EXCEPTION 'DISPUTE_INSPECTION_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 IF NOT(j?&keys) OR j-keys<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_DISPUTE_FIELDS' USING ERRCODE='23514';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(j->'disputes') LOOP
  keys=ARRAY['id','amount','currency','createdAt','status','reason','chargeRefundable','paymentIntentMatched','balanceTransactionIds','evidenceDueAt','hasEvidence','evidencePastDue','evidenceSubmissionCount','requiresFxReview','exceedsOriginalAmount'];
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT(r?&keys) OR r-keys<>'{}'::jsonb OR r->>'id' IS NULL OR(r->>'id')!~'^du_[A-Za-z0-9]{1,200}$' OR r->>'id'=ANY(seen) OR r->>'id' IS NOT DISTINCT FROM j->>'startingAfter'
  OR jsonb_typeof(r->'amount') IS DISTINCT FROM 'number' OR(r->>'amount')!~'^[1-9][0-9]{0,11}$' OR r->>'currency' IS NULL OR(r->>'currency')!~'^[a-z]{3}$'
  OR jsonb_typeof(r->'createdAt') IS DISTINCT FROM 'number' OR(r->>'createdAt')!~'^[1-9][0-9]{0,9}$' OR(r->>'createdAt')::numeric>9999999999
  OR r->>'status' IS NULL OR r->>'status' NOT IN('warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','appeal_needs_response','appeal_under_review','won','lost','prevented') OR r->>'reason' IS NULL OR(r->>'reason')!~'^[a-z][a-z0-9_]{0,63}$'
  OR jsonb_typeof(r->'evidenceSubmissionCount') IS DISTINCT FROM 'number' OR(r->>'evidenceSubmissionCount')!~'^(0|[1-9][0-9]{0,11})$'
  OR(jsonb_typeof(r->'evidenceDueAt') IS DISTINCT FROM 'null' AND(jsonb_typeof(r->'evidenceDueAt') IS DISTINCT FROM 'number' OR(r->>'evidenceDueAt')!~'^[1-9][0-9]{0,9}$' OR(r->>'evidenceDueAt')::numeric>9999999999)) THEN RAISE EXCEPTION 'INVALID_DISPUTE_FACTS' USING ERRCODE='23514';END IF;
  FOREACH field IN ARRAY ARRAY['chargeRefundable','paymentIntentMatched','hasEvidence','evidencePastDue','requiresFxReview','exceedsOriginalAmount'] LOOP IF jsonb_typeof(r->field) IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'INVALID_DISPUTE_FACTS' USING ERRCODE='23514';END IF;END LOOP;
  IF r->'requiresFxReview' IS DISTINCT FROM to_jsonb(r->>'currency'<>j->>'currency') OR r->'exceedsOriginalAmount' IS DISTINCT FROM to_jsonb(r->>'currency'=j->>'currency' AND(r->>'amount')::numeric>(original.inspection->>'amount')::numeric) THEN RAISE EXCEPTION 'DISPUTE_REVIEW_FLAGS_INVALID' USING ERRCODE='23514';END IF;
  IF jsonb_typeof(r->'balanceTransactionIds') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'balanceTransactionIds')>2 THEN RAISE EXCEPTION 'INVALID_DISPUTE_POINTERS' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r->'balanceTransactionIds') b WHERE jsonb_typeof(b) IS DISTINCT FROM 'string' OR(b#>>'{}')!~'^txn_[A-Za-z0-9]{1,200}$') OR jsonb_array_length(r->'balanceTransactionIds')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(r->'balanceTransactionIds')) THEN RAISE EXCEPTION 'INVALID_DISPUTE_POINTERS' USING ERRCODE='23514';END IF;
  seen=array_append(seen,r->>'id');last_id=r->>'id';
 END LOOP;
 IF(j->'hasMore'='true'::jsonb AND last_id IS NULL) OR j->>'nextCursor' IS DISTINCT FROM(CASE WHEN j->'hasMore'='true'::jsonb THEN last_id ELSE NULL END) THEN RAISE EXCEPTION 'INVALID_DISPUTE_CURSOR' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||':checkout-provider:'||(draft->>'accountId'),0));
 SELECT * INTO existing FROM public.checkout_dispute_inspections WHERE academy_id=p_academy AND id=p_id;
 IF FOUND THEN IF existing.start_id=p_start AND existing.principal_inspection_id=p_principal AND existing.request_sha256=p_hash AND existing.dispute_inspection=j THEN RETURN CASE WHEN existing.object_conflict THEN 'duplicate_conflict' ELSE 'duplicate' END;END IF;RAISE EXCEPTION 'DISPUTE_INSPECTION_ID_CONFLICT' USING ERRCODE='23514';END IF;
 conflict=original.object_conflict;
 FOR r IN SELECT value FROM jsonb_array_elements(j->'disputes') LOOP
  INSERT INTO public.checkout_dispute_object_bindings(academy_id,account_id,livemode,dispute_id,start_id,charge_id) VALUES(p_academy,draft->>'accountId',(draft->>'livemode')::boolean,r->>'id',p_start,j->>'chargeId') ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.checkout_dispute_object_bindings WHERE academy_id=p_academy AND account_id=draft->>'accountId' AND livemode=(draft->>'livemode')::boolean AND dispute_id=r->>'id') THEN RAISE EXCEPTION 'DISPUTE_BINDING_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;
  conflict=conflict OR NOT EXISTS(SELECT 1 FROM public.checkout_dispute_object_bindings WHERE academy_id=p_academy AND account_id=draft->>'accountId' AND livemode=(draft->>'livemode')::boolean AND dispute_id=r->>'id' AND start_id=p_start AND charge_id=j->>'chargeId');
 END LOOP;
 -- A refunded/expired principal may require review without being disputed.
 -- Keep that original review;do not invent a separate dispute case for it.
 attention=conflict OR cardinality(seen)>0 OR j->'hasMore'='true'::jsonb OR j->'observedPrincipalDisputed'='true'::jsonb;
 INSERT INTO public.checkout_dispute_inspections(academy_id,id,start_id,principal_inspection_id,worker_id,request_sha256,dispute_inspection,object_conflict) VALUES(p_academy,p_id,p_start,p_principal,p_worker,p_hash,j,conflict);
 IF coalesce(attention,false) AND j->>'chargeId' IS NOT NULL THEN INSERT INTO public.checkout_dispute_attention(academy_id,start_id,charge_id,inspection_id) VALUES(p_academy,p_start,j->>'chargeId',p_id) ON CONFLICT DO NOTHING;END IF;
 IF conflict THEN INSERT INTO public.checkout_dispute_attention(academy_id,start_id,charge_id,inspection_id) SELECT p_academy,b.start_id,b.charge_id,p_id FROM public.checkout_dispute_object_bindings b WHERE b.academy_id=p_academy AND b.account_id=draft->>'accountId' AND b.livemode=(draft->>'livemode')::boolean AND b.dispute_id=ANY(seen) ON CONFLICT DO NOTHING;END IF;
 IF coalesce(attention,false) AND j->>'chargeId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.checkout_dispute_attention WHERE academy_id=p_academy AND start_id=p_start AND charge_id=j->>'chargeId') THEN RAISE EXCEPTION 'DISPUTE_HOLD_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;
 IF conflict AND EXISTS(SELECT 1 FROM public.checkout_dispute_object_bindings b WHERE b.academy_id=p_academy AND b.account_id=draft->>'accountId' AND b.livemode=(draft->>'livemode')::boolean AND b.dispute_id=ANY(seen) AND NOT EXISTS(SELECT 1 FROM public.checkout_dispute_attention a WHERE a.academy_id=b.academy_id AND a.start_id=b.start_id AND a.charge_id=b.charge_id)) THEN RAISE EXCEPTION 'DISPUTE_OWNER_HOLD_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),CASE WHEN coalesce(attention,false) THEN 'checkout.disputes.review_required.critical' ELSE 'checkout.disputes.observed' END,p_start,p_id);
 RETURN CASE WHEN conflict THEN 'recorded_conflict' ELSE 'recorded' END;
END $$;
ALTER FUNCTION public.record_checkout_dispute_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb) OWNER TO kavosh_checkout_result_policy;REVOKE CREATE ON SCHEMA public FROM kavosh_checkout_result_policy;
REVOKE ALL ON FUNCTION public.record_checkout_dispute_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_checkout_dispute_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb) TO kavosh_checkout_result_worker;
GRANT SELECT(academy_id,id,start_id,dispute_inspection,object_conflict,origin_transaction) ON public.checkout_dispute_inspections TO kavosh_event_policy;
-- Preserve existing function identities/ACLs. Exact markers fail closed on
-- unexpected prior definitions rather than silently skipping money guards.
DO $$ DECLARE d text;needle text;BEGIN
 d=pg_get_functiondef('public.checkout_notice_basis(uuid,xid8)'::regprocedure);needle='IF o.event_type LIKE ''checkout.provider.%'' THEN';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'DISPUTE_NOTICE_BASE_CHANGED';END IF;
 EXECUTE replace(d,needle,$branch$IF o.event_type LIKE 'checkout.disputes.%' THEN
  SELECT id,dispute_inspection,object_conflict INTO r FROM public.checkout_dispute_inspections WHERE academy_id=tenant AND start_id=s.id AND id=o.request_id AND origin_transaction=p_origin;
  IF r.id IS NULL THEN RETURN NULL;END IF;j=r.dispute_inspection;conflict=r.object_conflict;phase='disputes';state=j->>'state';expected=CASE WHEN conflict OR j->'observedPrincipalDisputed'='true'::jsonb OR j->'hasMore'='true'::jsonb OR jsonb_array_length(j->'disputes')>0 THEN 'checkout.disputes.review_required.critical' ELSE 'checkout.disputes.observed' END;key='disputes:'||r.id::text;
 ELSIF o.event_type LIKE 'checkout.provider.%' THEN$branch$);
 d=pg_get_functiondef('public.checkout_notice_effect_required()'::regprocedure);needle='WHEN ''checkout_provider_inspections'' THEN';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'DISPUTE_EFFECT_BASE_CHANGED';END IF;EXECUTE replace(d,needle,'WHEN ''checkout_dispute_inspections'' THEN key=''disputes:''||NEW.id::text;'||E'\n '||needle);
 d=pg_get_functiondef('public.provider_credit_review_basis(uuid,uuid[])'::regprocedure);needle='IF c.id IS NULL THEN RETURN NULL;END IF;';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'DISPUTE_REVIEW_BASE_CHANGED';END IF;
 EXECUTE replace(d,needle,needle||' IF EXISTS(SELECT 1 FROM public.checkout_dispute_attention da WHERE da.academy_id=c.academy_id AND da.start_id=c.start_id AND da.charge_id=c.charge_id) THEN RETURN jsonb_build_object(''eligible'',false,''code'',''REFUND_REVIEW_DISPUTE_OR_OWNERSHIP_REQUIRED'');END IF;');
 d=pg_get_functiondef('public.provider_credit_review_required(uuid,date)'::regprocedure);needle='IF c.id IS NULL THEN RETURN true;END IF;';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'DISPUTE_HOLD_BASE_CHANGED';END IF;
 EXECUTE replace(d,needle,needle||' IF EXISTS(SELECT 1 FROM public.checkout_dispute_attention da WHERE da.academy_id=c.academy_id AND da.start_id=c.start_id AND da.charge_id=c.charge_id) THEN RETURN true;END IF;');
 d=pg_get_functiondef('public.provider_collection_source(uuid)'::regprocedure);needle='WHERE i.id=p_inspection AND NOT EXISTS';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'DISPUTE_COLLECTION_BASE_CHANGED';END IF;
 EXECUTE replace(d,needle,'WHERE i.id=p_inspection AND NOT EXISTS(SELECT 1 FROM public.checkout_dispute_attention da WHERE da.academy_id=i.academy_id AND da.start_id=i.start_id AND da.charge_id=i.inspection->>''chargeId'') AND NOT EXISTS');
END $$;
DROP TRIGGER checkout_notice_capture ON public.outbox_events;
CREATE TRIGGER checkout_notice_capture AFTER INSERT ON public.outbox_events FOR EACH ROW WHEN(NEW.event_type IN('checkout.transport.received','checkout.transport.actor_conflict.critical','checkout.transport.conflict.critical','checkout.provider.object_conflict.critical','checkout.provider.review.critical','checkout.provider.observed','checkout.fees.object_conflict.critical','checkout.fees.observed','checkout.refunds.review_required.critical','checkout.refunds.observed','checkout.refund_return.observed.critical','checkout.refund_return.object_conflict.critical','checkout.disputes.review_required.critical','checkout.disputes.observed')) EXECUTE FUNCTION public.capture_checkout_notice();
CREATE CONSTRAINT TRIGGER checkout_notice_effect AFTER INSERT ON public.checkout_dispute_inspections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.checkout_notice_effect_required();
-- Check the actual mandatory floor as well as the event. This shared guard
-- also catches a disabled publisher rather than trusting it was invoked.
DO $$ DECLARE d text;needle text;BEGIN
 d=pg_get_functiondef('public.checkout_notice_effect_required()'::regprocedure);
 needle='THEN RAISE EXCEPTION ''CHECKOUT_NOTICE_EFFECT_REQUIRED'' USING ERRCODE=''23514'';END IF;';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'CHECKOUT_ALERT_EFFECT_BASE_CHANGED';END IF;
 EXECUTE replace(d,needle,needle||$branch$
 IF EXISTS(SELECT 1 FROM public.automation_event_sources e
 CROSS JOIN LATERAL public.checkout_notice_audience(NEW.start_id) audience
 JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL
 WHERE e.academy_id=NEW.academy_id AND e.source_kind='checkout' AND e.checkout_start_id=NEW.start_id AND e.checkout_notice_key=key AND e.origin_transaction=NEW.origin_transaction AND e.projection->>'severity'='critical'
 AND NOT EXISTS(SELECT 1 FROM public.portal_notifications n WHERE n.academy_id=e.academy_id AND n.event_id=e.event_id AND n.person_id=p.id AND n.origin='mandatory')) THEN RAISE EXCEPTION 'CHECKOUT_ALERT_EFFECT_REQUIRED' USING ERRCODE='55000';END IF;
 $branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 328 $$;

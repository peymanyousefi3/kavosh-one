CREATE TABLE public.checkout_fee_inspections(
 academy_id uuid NOT NULL,id uuid NOT NULL,start_id uuid NOT NULL,principal_inspection_id uuid NOT NULL,worker_id uuid NOT NULL,request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),
 fee_inspection jsonb NOT NULL CHECK(jsonb_typeof(fee_inspection)='object' AND octet_length(fee_inspection::text)<=65536),object_conflict boolean NOT NULL,
 recorded_by name NOT NULL DEFAULT session_user,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),
 FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id),FOREIGN KEY(academy_id,principal_inspection_id) REFERENCES public.checkout_provider_inspections(academy_id,id)
);
CREATE INDEX checkout_fee_inspection_start ON public.checkout_fee_inspections(academy_id,start_id,id);
CREATE TABLE public.checkout_balance_object_bindings(
 academy_id uuid NOT NULL,account_id text NOT NULL,livemode boolean NOT NULL,transaction_id text NOT NULL,start_id uuid NOT NULL,charge_id text NOT NULL,
 PRIMARY KEY(academy_id,account_id,livemode,transaction_id),FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['checkout_fee_inspections','checkout_balance_object_bindings'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY checkout_result_executor ON public.%I TO kavosh_checkout_result_policy USING(true) WITH CHECK(true)',t);
 EXECUTE format('GRANT SELECT,INSERT ON public.%I TO kavosh_checkout_result_policy',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT SELECT ON public.checkout_provider_inspections TO kavosh_checkout_result_policy;
GRANT CREATE ON SCHEMA public TO kavosh_checkout_result_policy;
CREATE FUNCTION public.record_checkout_fee_inspection(p_academy uuid,p_id uuid,p_start uuid,p_principal uuid,p_worker uuid,p_hash text,p_fee jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original record;existing record;draft jsonb;j jsonb;field text;detail jsonb;total numeric:=0;complete boolean:=true;factor numeric;conflict boolean;BEGIN
 IF p_academy IS NULL OR p_id IS NULL OR p_start IS NULL OR p_principal IS NULL OR p_worker IS NULL OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR p_fee IS NULL OR jsonb_typeof(p_fee)<>'object' OR octet_length(p_fee::text)>65536 THEN RAISE EXCEPTION 'INVALID_FEE_INSPECTION' USING ERRCODE='23514';END IF;
 j:=p_fee;
 SELECT * INTO original FROM public.checkout_provider_inspections WHERE academy_id=p_academy AND id=p_principal AND start_id=p_start AND request_sha256=p_hash;
 SELECT a.draft INTO draft FROM public.payment_checkout_dispatch_starts s JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE s.academy_id=p_academy AND s.id=p_start AND a.request_sha256=p_hash;
 IF original.id IS NULL OR draft IS NULL THEN RETURN 'unavailable';END IF;
 IF j->>'state' IS NULL OR j->>'state' NOT IN('principal_not_captured','awaiting_balance_transaction','charge_balance') OR j->>'sessionId' IS DISTINCT FROM original.inspection->>'sessionId' OR j->>'paymentId' IS DISTINCT FROM original.inspection->>'paymentId' OR j->>'chargeId' IS DISTINCT FROM original.inspection->>'chargeId'
 OR j->'bankSettled' IS DISTINCT FROM 'false'::jsonb OR j->'ledgerAdjusted' IS DISTINCT FROM 'false'::jsonb OR j->'feePosted' IS DISTINCT FROM 'false'::jsonb OR j->'taxVerified' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'FEE_INSPECTION_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 IF(j->>'state'='principal_not_captured') IS DISTINCT FROM(original.inspection->>'state' IN('awaiting_payment','expired')) THEN RAISE EXCEPTION 'FEE_INSPECTION_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 IF j->>'state' IN('awaiting_balance_transaction','principal_not_captured') THEN
  IF j-ARRAY['state','sessionId','paymentId','chargeId','bankSettled','ledgerAdjusted','feePosted','taxVerified']<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_FEE_INSPECTION' USING ERRCODE='23514';END IF;
 ELSE
  IF j-ARRAY['state','sessionId','paymentId','chargeId','bankSettled','ledgerAdjusted','feePosted','taxVerified','balanceTransactionId','balanceType','providerUnitScale','chargeAmount','chargeCurrency','grossAmount','currency','feeAmount','netAmount','createdAt','availableOn','status','exchangeRate','reportingCategory','feeDetails','feeBreakdownComplete','requiresFxReview','principalRequiresReview']<>'{}'::jsonb
  OR j->>'balanceTransactionId' IS NULL OR(j->>'balanceTransactionId')!~'^txn_[A-Za-z0-9]{1,200}$' OR j->>'currency' IS NULL OR(j->>'currency')!~'^[a-z]{3}$'
  OR j->'chargeCurrency' IS DISTINCT FROM original.inspection->'currency' OR j->'chargeAmount' IS DISTINCT FROM original.inspection->'amount'
  OR j->>'status' IS NULL OR j->>'status' NOT IN('pending','available') OR j->>'reportingCategory' IS NULL OR(j->>'reportingCategory')!~'^[a-z][a-z0-9_]{0,63}$'
  OR NOT j?'balanceType' OR(jsonb_typeof(j->'balanceType') NOT IN('string','null')) OR(j->'balanceType'<>'null'::jsonb AND(j->>'balanceType')!~'^[a-z][a-z0-9_]{0,63}$')
  THEN RAISE EXCEPTION 'INVALID_FEE_INSPECTION' USING ERRCODE='23514';END IF;
  FOREACH field IN ARRAY ARRAY['chargeAmount','grossAmount','feeAmount','netAmount','createdAt','availableOn'] LOOP
   IF jsonb_typeof(j->field) IS DISTINCT FROM 'number' OR(j->>field)!~'^-?(0|[1-9][0-9]{0,11})$' THEN RAISE EXCEPTION 'FEE_INSPECTION_MONEY_INVALID' USING ERRCODE='23514';END IF;
  END LOOP;
  IF(j->>'grossAmount')::numeric<=0 OR(j->>'createdAt')::numeric NOT BETWEEN 1 AND 9999999999 OR(j->>'availableOn')::numeric NOT BETWEEN 1 AND 9999999999
  OR(j->>'grossAmount')::numeric-(j->>'feeAmount')::numeric<>(j->>'netAmount')::numeric
  OR(j->>'currency'=j->>'chargeCurrency' AND j->'grossAmount' IS DISTINCT FROM j->'chargeAmount')
  OR j->'requiresFxReview' IS DISTINCT FROM to_jsonb(j->>'currency'<>j->>'chargeCurrency') OR j->'principalRequiresReview' IS DISTINCT FROM to_jsonb(original.inspection->>'state'='requires_review')
  THEN RAISE EXCEPTION 'FEE_INSPECTION_MONEY_INVALID' USING ERRCODE='23514';END IF;
  factor:=public.checkout_provider_amount(upper(j->>'currency'),0,1);
  IF j->'providerUnitScale' IS DISTINCT FROM to_jsonb(CASE factor WHEN 1 THEN 0 WHEN 100 THEN 2 WHEN 1000 THEN 3 ELSE -1 END) THEN RAISE EXCEPTION 'FEE_INSPECTION_PRECISION_INVALID' USING ERRCODE='23514';END IF;
  IF NOT j?'exchangeRate' OR jsonb_typeof(j->'exchangeRate') NOT IN('number','null') OR(j->'exchangeRate'<>'null'::jsonb AND(length(j->>'exchangeRate')>40 OR(j->>'exchangeRate')::numeric<=0)) THEN RAISE EXCEPTION 'INVALID_FEE_INSPECTION' USING ERRCODE='23514';END IF;
  IF jsonb_typeof(j->'feeDetails') IS DISTINCT FROM 'array' OR jsonb_array_length(j->'feeDetails')>100 THEN RAISE EXCEPTION 'INVALID_FEE_INSPECTION' USING ERRCODE='23514';END IF;
  FOR detail IN SELECT * FROM jsonb_array_elements(j->'feeDetails') LOOP
   IF jsonb_typeof(detail) IS DISTINCT FROM 'object' OR detail-ARRAY['amount','currency','type','application']<>'{}'::jsonb OR jsonb_typeof(detail->'amount') IS DISTINCT FROM 'number' OR(detail->>'amount')!~'^-?(0|[1-9][0-9]{0,11})$'
   OR detail->>'currency' IS NULL OR(detail->>'currency')!~'^[a-z]{3}$' OR detail->>'type' IS NULL OR(detail->>'type')!~'^[a-z][a-z0-9_]{0,63}$'
   OR(detail?'application' AND(jsonb_typeof(detail->'application') NOT IN('string','null') OR(detail->'application'<>'null'::jsonb AND(detail->>'application')!~'^[A-Za-z0-9_]{1,200}$')))
   THEN RAISE EXCEPTION 'INVALID_FEE_INSPECTION' USING ERRCODE='23514';END IF;
   total:=total+(detail->>'amount')::numeric;complete:=complete AND detail->>'currency'=j->>'currency';
  END LOOP;
  complete:=complete AND total=(j->>'feeAmount')::numeric;
  IF j->'feeBreakdownComplete' IS DISTINCT FROM to_jsonb(complete) THEN RAISE EXCEPTION 'FEE_BREAKDOWN_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||':checkout-provider:'||(draft->>'accountId'),0));
 SELECT * INTO existing FROM public.checkout_fee_inspections WHERE academy_id=p_academy AND id=p_id;
 IF FOUND THEN IF existing.start_id=p_start AND existing.principal_inspection_id=p_principal AND existing.request_sha256=p_hash AND existing.fee_inspection=j THEN RETURN CASE WHEN existing.object_conflict THEN 'duplicate_conflict' ELSE 'duplicate' END;END IF;RAISE EXCEPTION 'FEE_INSPECTION_ID_CONFLICT' USING ERRCODE='23514';END IF;
 conflict:=original.object_conflict;
 IF j->>'state'='charge_balance' THEN
  INSERT INTO public.checkout_balance_object_bindings(academy_id,account_id,livemode,transaction_id,start_id,charge_id) VALUES(p_academy,draft->>'accountId',(draft->>'livemode')::boolean,j->>'balanceTransactionId',p_start,j->>'chargeId') ON CONFLICT DO NOTHING;
  conflict:=conflict OR NOT EXISTS(SELECT 1 FROM public.checkout_balance_object_bindings WHERE academy_id=p_academy AND account_id=draft->>'accountId' AND livemode=(draft->>'livemode')::boolean AND transaction_id=j->>'balanceTransactionId' AND start_id=p_start AND charge_id=j->>'chargeId');
 END IF;
 INSERT INTO public.checkout_fee_inspections(academy_id,id,start_id,principal_inspection_id,worker_id,request_sha256,fee_inspection,object_conflict) VALUES(p_academy,p_id,p_start,p_principal,p_worker,p_hash,j,conflict);
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),CASE WHEN conflict THEN 'checkout.fees.object_conflict.critical' ELSE 'checkout.fees.observed' END,p_start,p_id);
 RETURN CASE WHEN conflict THEN 'recorded_conflict' ELSE 'recorded' END;
END $$;
ALTER FUNCTION public.record_checkout_fee_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb) OWNER TO kavosh_checkout_result_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_checkout_result_policy;
REVOKE ALL ON FUNCTION public.record_checkout_fee_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_checkout_fee_inspection(uuid,uuid,uuid,uuid,uuid,text,jsonb) TO kavosh_checkout_result_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 299 $$;

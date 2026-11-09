CREATE TABLE public.checkout_provider_inspections(
 academy_id uuid NOT NULL,id uuid NOT NULL,start_id uuid NOT NULL,worker_id uuid NOT NULL,request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),
 inspection jsonb NOT NULL CHECK(jsonb_typeof(inspection)='object' AND octet_length(inspection::text)<=4096),object_conflict boolean NOT NULL,
 recorded_by name NOT NULL DEFAULT session_user,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),
 FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id)
);
CREATE TABLE public.checkout_provider_object_bindings(
 academy_id uuid NOT NULL,account_id text NOT NULL,livemode boolean NOT NULL,kind text NOT NULL CHECK(kind IN('session','payment','charge')),object_id text NOT NULL,start_id uuid NOT NULL,
 PRIMARY KEY(academy_id,account_id,livemode,kind,object_id),FOREIGN KEY(academy_id,start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id)
);
CREATE INDEX checkout_provider_inspection_start ON public.checkout_provider_inspections(academy_id,start_id,received_at,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['checkout_provider_inspections','checkout_provider_object_bindings'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY checkout_result_executor ON public.%I TO kavosh_checkout_result_policy USING(true) WITH CHECK(true)',t);
 EXECUTE format('GRANT SELECT,INSERT ON public.%I TO kavosh_checkout_result_policy',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT CREATE ON SCHEMA public TO kavosh_checkout_result_policy;
CREATE FUNCTION public.checkout_provider_amount(p_code text,p_scale integer,p_minor numeric) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE sc integer;factor numeric;amount numeric;BEGIN
 IF p_code IS NULL OR p_code!~'^[A-Z]{3}$' OR p_scale IS NULL OR p_scale NOT BETWEEN 0 AND 18 OR p_minor IS NULL OR p_minor<=0 OR p_minor>=power(10::numeric,38) OR trunc(p_minor)<>p_minor THEN RAISE EXCEPTION 'CHECKOUT_PROVIDER_MONEY_INVALID' USING ERRCODE='23514';END IF;
 sc:=CASE WHEN p_code=ANY(ARRAY['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','VND','VUV','XAF','XOF','XPF']) THEN 0 WHEN p_code=ANY(ARRAY['BHD','JOD','KWD','OMR','TND']) THEN 3 ELSE 2 END;
 factor:=power(10::numeric,abs(sc-p_scale));
 IF p_scale>sc THEN IF mod(p_minor,factor)<>0 THEN RAISE EXCEPTION 'CHECKOUT_PROVIDER_MONEY_PRECISION' USING ERRCODE='23514';END IF;amount:=p_minor/factor;ELSE amount:=p_minor*factor;END IF;
 IF amount>999999999999 OR(p_code IN('ISK','UGX') AND mod(amount,100)<>0) THEN RAISE EXCEPTION 'CHECKOUT_PROVIDER_MONEY_INVALID' USING ERRCODE='23514';END IF;RETURN amount;
END $$;
REVOKE ALL ON FUNCTION public.checkout_provider_amount(text,integer,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.checkout_provider_amount(text,integer,numeric) TO kavosh_checkout_result_policy;
CREATE FUNCTION public.record_checkout_provider_inspection(p_academy uuid,p_id uuid,p_start uuid,p_worker uuid,p_hash text,p_inspection jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d jsonb;j jsonb;existing record;state text;expected numeric;conflict boolean:=false;item record;BEGIN
 IF p_academy IS NULL OR p_id IS NULL OR p_start IS NULL OR p_worker IS NULL OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR p_inspection IS NULL OR jsonb_typeof(p_inspection)<>'object' OR octet_length(p_inspection::text)>4096 THEN RAISE EXCEPTION 'INVALID_CHECKOUT_INSPECTION' USING ERRCODE='23514';END IF;
 j:=p_inspection;state:=j->>'state';
 IF state IS NULL OR state NOT IN('awaiting_payment','expired','requires_review','captured') OR j->'bankSettled' IS DISTINCT FROM 'false'::jsonb OR j->'ledgerAdjusted' IS DISTINCT FROM 'false'::jsonb
 OR j->'paymentVerified' IS DISTINCT FROM to_jsonb(state='captured') OR j->>'sessionId' IS NULL OR(j->>'sessionId')!~'^cs_(test|live)_[A-Za-z0-9]{1,200}$'
 OR NOT j?'paymentId' OR(j->'paymentId'<>'null'::jsonb AND(j->>'paymentId')!~'^pi_[A-Za-z0-9]{1,200}$') THEN RAISE EXCEPTION 'INVALID_CHECKOUT_INSPECTION' USING ERRCODE='23514';END IF;
 IF state IN('awaiting_payment','expired') THEN
  IF j-ARRAY['sessionId','paymentId','state','bankSettled','ledgerAdjusted','paymentVerified']<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_CHECKOUT_INSPECTION' USING ERRCODE='23514';END IF;
 ELSE
  IF j-ARRAY['sessionId','paymentId','chargeId','amount','currency','cardFunding','refundedAmount','disputed','state','bankSettled','ledgerAdjusted','paymentVerified']<>'{}'::jsonb
  OR j->>'paymentId' IS NULL OR j->>'chargeId' IS NULL OR(j->>'chargeId')!~'^ch_[A-Za-z0-9]{1,200}$'
  OR jsonb_typeof(j->'amount') IS DISTINCT FROM 'number' OR(j->>'amount')!~'^[1-9][0-9]{0,11}$'
  OR jsonb_typeof(j->'refundedAmount') IS DISTINCT FROM 'number' OR(j->>'refundedAmount')!~'^(0|[1-9][0-9]{0,11})$'
  OR jsonb_typeof(j->'disputed') IS DISTINCT FROM 'boolean' OR j->>'cardFunding' IS NULL OR j->>'cardFunding' NOT IN('credit','debit','prepaid','unknown')
  OR(state='captured' AND(j->'refundedAmount' IS DISTINCT FROM '0'::jsonb OR j->'disputed' IS DISTINCT FROM 'false'::jsonb)) THEN RAISE EXCEPTION 'INVALID_CHECKOUT_INSPECTION' USING ERRCODE='23514';END IF;
 END IF;
 SELECT a.draft INTO d FROM public.payment_checkout_dispatch_starts s JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id WHERE s.academy_id=p_academy AND s.id=p_start AND a.request_sha256=p_hash;
 IF d IS NULL THEN RETURN 'unavailable';END IF;
 IF NOT starts_with(j->>'sessionId',CASE WHEN(d->>'livemode')::boolean THEN 'cs_live_' ELSE 'cs_test_' END) THEN RAISE EXCEPTION 'CHECKOUT_INSPECTION_MODE_MISMATCH' USING ERRCODE='23514';END IF;
 IF state IN('captured','requires_review') THEN
  -- Same documented provider precision as the wire adapter,not an ISO/Intl guess.
  expected:=public.checkout_provider_amount(d->>'currencyCode',(d->>'unitScale')::integer,(d->>'amountMinor')::numeric);
  IF j->>'currency' IS DISTINCT FROM lower(d->>'currencyCode') OR(j->>'amount')::numeric<>expected OR(j->>'refundedAmount')::numeric>(j->>'amount')::numeric THEN RAISE EXCEPTION 'CHECKOUT_INSPECTION_MONEY_MISMATCH' USING ERRCODE='23514';END IF;
 END IF;
 -- Account-level serialization also makes original provider object ownership
 -- unique across simultaneous starts,not merely per delivery/event identifier.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||':checkout-provider:'||(d->>'accountId'),0));
 SELECT * INTO existing FROM public.checkout_provider_inspections WHERE academy_id=p_academy AND id=p_id;
 IF FOUND THEN IF existing.start_id=p_start AND existing.request_sha256=p_hash AND existing.inspection=j THEN RETURN CASE WHEN existing.object_conflict THEN 'duplicate_conflict' ELSE 'duplicate' END;END IF;RAISE EXCEPTION 'CHECKOUT_INSPECTION_ID_CONFLICT' USING ERRCODE='23514';END IF;
 FOR item IN SELECT * FROM(VALUES('session',j->>'sessionId'),('payment',j->>'paymentId'),('charge',j->>'chargeId')) v(kind,object_id) WHERE object_id IS NOT NULL LOOP
  INSERT INTO public.checkout_provider_object_bindings(academy_id,account_id,livemode,kind,object_id,start_id) VALUES(p_academy,d->>'accountId',(d->>'livemode')::boolean,item.kind,item.object_id,p_start) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.checkout_provider_object_bindings WHERE academy_id=p_academy AND account_id=d->>'accountId' AND livemode=(d->>'livemode')::boolean AND kind=item.kind AND object_id=item.object_id AND start_id=p_start) THEN conflict:=true;END IF;
 END LOOP;
 INSERT INTO public.checkout_provider_inspections(academy_id,id,start_id,worker_id,request_sha256,inspection,object_conflict) VALUES(p_academy,p_id,p_start,p_worker,p_hash,j,conflict);
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(p_academy,gen_random_uuid(),CASE WHEN conflict THEN 'checkout.provider.object_conflict.critical' WHEN state='requires_review' THEN 'checkout.provider.review.critical' ELSE 'checkout.provider.observed' END,p_start,p_id);
 RETURN CASE WHEN conflict THEN 'recorded_conflict' ELSE 'recorded' END;
END $$;
ALTER FUNCTION public.record_checkout_provider_inspection(uuid,uuid,uuid,uuid,text,jsonb) OWNER TO kavosh_checkout_result_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_checkout_result_policy;
REVOKE ALL ON FUNCTION public.record_checkout_provider_inspection(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_checkout_provider_inspection(uuid,uuid,uuid,uuid,text,jsonb) TO kavosh_checkout_result_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 296 $$;

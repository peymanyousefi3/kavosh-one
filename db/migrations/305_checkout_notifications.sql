-- Bind future isolated service facts to the existing notification machinery.
-- Historical rows have no transaction provenance and are never reconstructed.
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['checkout_transport_receipts','checkout_transport_conflicts','payment_checkout_dispatch_observations','checkout_provider_inspections','checkout_fee_inspections','checkout_refund_inspections'] LOOP
 EXECUTE format('ALTER TABLE public.%I ADD origin_transaction xid8',t);
 EXECUTE format('ALTER TABLE public.%I ALTER COLUMN origin_transaction SET DEFAULT pg_current_xact_id()',t);
END LOOP;END $$;
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule','report_job','pay_statement','account_security','calendar_event','work_signature','tuition_due','expense_due','payroll_due','counterparty_statement','statement_due','checkout'));
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_operational_audit;
ALTER TABLE public.automation_event_sources ADD CONSTRAINT automation_event_operational_audit CHECK((source_kind IN('report_schedule','report_job','pay_statement','account_security','work_signature','counterparty_statement','checkout'))=(audit_id IS NULL));
ALTER TABLE public.automation_event_sources ADD checkout_start_id uuid,ADD checkout_notice_key text,
 ADD FOREIGN KEY(academy_id,checkout_start_id) REFERENCES public.payment_checkout_dispatch_starts(academy_id,id),
 ADD CHECK((source_kind='checkout')=(checkout_start_id IS NOT NULL AND checkout_notice_key IS NOT NULL)),
 ADD CHECK(source_kind='checkout' OR(checkout_start_id IS NULL AND checkout_notice_key IS NULL)),
 ADD UNIQUE(academy_id,checkout_start_id,checkout_notice_key);
GRANT SELECT(academy_id,id,attempt_id,actor_id) ON public.payment_checkout_dispatch_starts TO kavosh_event_policy;
GRANT SELECT(academy_id,id,request_id) ON public.payment_checkout_attempts TO kavosh_event_policy;
GRANT SELECT(academy_id,id,hub_id) ON public.payment_checkout_requests TO kavosh_event_policy;
GRANT SELECT(academy_id,start_id,state,provider_session_id,origin_transaction) ON public.checkout_transport_receipts,public.payment_checkout_dispatch_observations TO kavosh_event_policy;
GRANT SELECT(academy_id,start_id,state,provider_session_id,payload_fingerprint,origin_transaction,received_at) ON public.checkout_transport_conflicts TO kavosh_event_policy;
GRANT SELECT(academy_id,id,start_id,inspection,object_conflict,origin_transaction) ON public.checkout_provider_inspections TO kavosh_event_policy;
GRANT SELECT(academy_id,id,start_id,fee_inspection,object_conflict,origin_transaction) ON public.checkout_fee_inspections TO kavosh_event_policy;
GRANT SELECT(academy_id,id,start_id,refund_inspection,object_conflict,origin_transaction) ON public.checkout_refund_inspections TO kavosh_event_policy;
CREATE FUNCTION public.checkout_notice_basis(p_event uuid,p_origin xid8) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;o record;s record;r record;a record;j jsonb;expected text;phase text;state text;key text;conflict boolean:=false;severity text;BEGIN
 SELECT * INTO o FROM public.outbox_events WHERE academy_id=tenant AND id=p_event;
 SELECT st.id,at.id attempt_id,q.id request_id,q.hub_id INTO s FROM public.payment_checkout_dispatch_starts st JOIN public.payment_checkout_attempts at ON at.academy_id=st.academy_id AND at.id=st.attempt_id JOIN public.payment_checkout_requests q ON q.academy_id=at.academy_id AND q.id=at.request_id WHERE st.academy_id=tenant AND st.id=o.entity_id;
 IF o.id IS NULL OR s.id IS NULL OR p_origin IS NULL THEN RETURN NULL;END IF;
 IF o.event_type LIKE 'checkout.provider.%' THEN
  SELECT id,inspection,object_conflict INTO r FROM public.checkout_provider_inspections WHERE academy_id=tenant AND start_id=s.id AND id=o.request_id AND origin_transaction=p_origin;
  IF r.id IS NULL THEN RETURN NULL;END IF;j=r.inspection;conflict=r.object_conflict;phase='provider';state=j->>'state';expected=CASE WHEN conflict THEN 'checkout.provider.object_conflict.critical' WHEN state='requires_review' THEN 'checkout.provider.review.critical' ELSE 'checkout.provider.observed' END;key='provider:'||r.id::text;
 ELSIF o.event_type LIKE 'checkout.fees.%' THEN
  SELECT id,fee_inspection,object_conflict INTO r FROM public.checkout_fee_inspections WHERE academy_id=tenant AND start_id=s.id AND id=o.request_id AND origin_transaction=p_origin;
  IF r.id IS NULL THEN RETURN NULL;END IF;j=r.fee_inspection;conflict=r.object_conflict;phase='fees';state=j->>'state';expected=CASE WHEN conflict THEN 'checkout.fees.object_conflict.critical' ELSE 'checkout.fees.observed' END;key='fees:'||r.id::text;
 ELSIF o.event_type LIKE 'checkout.refunds.%' THEN
  SELECT id,refund_inspection,object_conflict INTO r FROM public.checkout_refund_inspections WHERE academy_id=tenant AND start_id=s.id AND id=o.request_id AND origin_transaction=p_origin;
  IF r.id IS NULL THEN RETURN NULL;END IF;j=r.refund_inspection;conflict=r.object_conflict;phase='refunds';state=j->>'state';expected=CASE WHEN conflict OR j->'principalRequiresReview'='true'::jsonb OR j->'hasMore'='true'::jsonb OR EXISTS(SELECT 1 FROM jsonb_array_elements(j->'refunds') x WHERE x->>'status' IS NULL OR x->>'status' NOT IN('failed','canceled')) THEN 'checkout.refunds.review_required.critical' ELSE 'checkout.refunds.observed' END;key='refunds:'||r.id::text;
 ELSIF o.event_type LIKE 'checkout.transport.%' THEN
  IF o.request_id IS DISTINCT FROM s.id THEN RETURN NULL;END IF;
  SELECT t.start_id,t.state,t.provider_session_id,t.origin_transaction INTO r FROM public.checkout_transport_receipts t WHERE t.academy_id=tenant AND t.start_id=s.id;
  IF r.start_id IS NULL THEN RETURN NULL;END IF;phase='transport';state=r.state;
  IF o.event_type='checkout.transport.received' THEN IF r.origin_transaction IS DISTINCT FROM p_origin THEN RETURN NULL;END IF;expected=o.event_type;key='transport:received';
  ELSIF o.event_type='checkout.transport.actor_conflict.critical' THEN
   SELECT t.start_id,t.state,t.provider_session_id,t.origin_transaction INTO a FROM public.payment_checkout_dispatch_observations t WHERE t.academy_id=tenant AND t.start_id=s.id;
   IF a.start_id IS NULL OR(a.state IS NOT DISTINCT FROM r.state AND a.provider_session_id IS NOT DISTINCT FROM r.provider_session_id) OR(a.origin_transaction IS DISTINCT FROM p_origin AND r.origin_transaction IS DISTINCT FROM p_origin) THEN RETURN NULL;END IF;conflict=true;expected=o.event_type;key='transport:actor_conflict';
  ELSIF o.event_type='checkout.transport.conflict.critical' THEN
   SELECT t.start_id,t.state,t.payload_fingerprint INTO a FROM public.checkout_transport_conflicts t WHERE t.academy_id=tenant AND t.start_id=s.id AND t.origin_transaction=p_origin ORDER BY t.received_at DESC,t.payload_fingerprint DESC LIMIT 1;
   IF a.start_id IS NULL THEN RETURN NULL;END IF;conflict=true;state=a.state;expected=o.event_type;key='transport:conflict:'||a.payload_fingerprint;
  ELSE RETURN NULL;END IF;
 ELSE RETURN NULL;END IF;
 IF expected IS DISTINCT FROM o.event_type THEN RETURN NULL;END IF;
 severity=CASE WHEN right(expected,9)='.critical' OR(phase='transport' AND state<>'accepted') OR(phase='fees' AND(j->'requiresFxReview'='true'::jsonb OR j->'principalRequiresReview'='true'::jsonb OR(j->>'feeAmount')::numeric<0 OR(j->>'netAmount')::numeric<0 OR j->'feeBreakdownComplete'='false'::jsonb)) THEN 'critical' ELSE 'normal' END;
 RETURN jsonb_build_object('key',key,'projection',jsonb_build_object('eventType',expected,'entityId',s.id,'hubId',s.hub_id,'actorId',NULL,'actorKind','system','severity',severity,'occurredAt',to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'attributes',jsonb_build_object('requestId',s.request_id,'attemptId',s.attempt_id,'startId',s.id,'inspectionId',CASE WHEN phase<>'transport' THEN o.request_id ELSE NULL END,'phase',phase,'state',state,'observationConflict',conflict,'bankSettled',false,'ledgerAdjusted',false)));
END $$;
CREATE FUNCTION public.checkout_notice_allows(p_start uuid,p_scopes jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT public.scope_contains(coalesce(p_scopes->'invoices.view','{"all":false,"hubs":[]}'::jsonb),context.scope) AND public.scope_contains(coalesce(p_scopes->'checkouts.view','{"all":false,"hubs":[]}'::jsonb),context.scope)
 FROM public.payment_checkout_dispatch_starts s JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id JOIN public.payment_checkout_requests q ON q.academy_id=a.academy_id AND q.id=a.request_id
 CROSS JOIN LATERAL(SELECT jsonb_build_object('all',false,'hubs',jsonb_build_array(q.hub_id),'recordContext',jsonb_build_object('hubId',q.hub_id,'classId',q.class_id,'studentId',q.student_id)) scope) context
 WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.id=p_start),false)
$$;
ALTER FUNCTION public.checkout_notice_allows(uuid,jsonb) OWNER TO kavosh_runtime;
CREATE FUNCTION public.checkout_notice_audience(p_start uuid) RETURNS TABLE(person_id uuid) LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT chain.person_id FROM public.payment_checkout_dispatch_starts s CROSS JOIN LATERAL public.supervisor_chain(s.actor_id) chain WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.id=p_start
 UNION SELECT master_person_id FROM public.academies WHERE id=nullif(current_setting('app.academy_id',true),'')::uuid AND EXISTS(SELECT 1 FROM public.payment_checkout_dispatch_starts WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_start)
$$;
CREATE FUNCTION public.checkout_notice_upper(p_start uuid,p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT EXISTS(SELECT 1 FROM public.checkout_notice_audience(p_start) WHERE person_id=p_actor) $$;
ALTER FUNCTION public.checkout_notice_upper(uuid,uuid) OWNER TO kavosh_event_policy;
CREATE FUNCTION public.checkout_notice_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb:=public.checkout_notice_basis(NEW.event_id,NEW.origin_transaction);BEGIN
 IF current_user<>'kavosh_event_policy' OR NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id() OR b IS NULL OR NEW.projection IS DISTINCT FROM b->'projection' OR NEW.checkout_notice_key IS DISTINCT FROM b->>'key' OR NEW.checkout_start_id::text IS DISTINCT FROM b#>>'{projection,entityId}' OR NEW.hub_id::text IS DISTINCT FROM b#>>'{projection,hubId}' OR NEW.event_type IS DISTINCT FROM b#>>'{projection,eventType}' OR NEW.source_version<>1 OR NEW.occurred_at IS DISTINCT FROM(b#>>'{projection,occurredAt}')::timestamptz OR NEW.approval_id IS NOT NULL OR NEW.audit_id IS NOT NULL THEN RAISE EXCEPTION 'CHECKOUT_NOTICE_EXACT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER checkout_notice_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='checkout') EXECUTE FUNCTION public.checkout_notice_guard();
CREATE FUNCTION public.publish_checkout_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE recipients uuid[];added integer;BEGIN
 SELECT array_agg(p.id ORDER BY p.id) INTO recipients FROM public.checkout_notice_audience(NEW.checkout_start_id) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin) SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,id,0,'critical','Payment needs review','Open the linked payment record to review this observation. Reading this notice does not resolve it,approve accounting or confirm bank settlement.','en','mandatory' FROM unnest(recipients) id;
 GET DIAGNOSTICS added=ROW_COUNT;IF added<>coalesce(cardinality(recipients),0) THEN RAISE EXCEPTION 'CHECKOUT_ALERT_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
ALTER FUNCTION public.publish_checkout_alert() OWNER TO kavosh_event_policy;
CREATE TRIGGER publish_checkout_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='checkout' AND NEW.projection->>'severity'='critical') EXECUTE FUNCTION public.publish_checkout_alert();
CREATE FUNCTION public.capture_checkout_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE prior text:=current_setting('app.academy_id',true);b jsonb;p jsonb;BEGIN
 PERFORM set_config('app.academy_id',NEW.academy_id::text,true);b=public.checkout_notice_basis(NEW.id,pg_current_xact_id());p=b->'projection';IF b IS NULL THEN RAISE EXCEPTION 'CHECKOUT_NOTICE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,checkout_start_id,checkout_notice_key) VALUES(NEW.academy_id,NEW.id,NULL,NULL,'checkout',1,NEW.event_type,(p->>'hubId')::uuid,(p->>'occurredAt')::timestamptz,p,NEW.entity_id,b->>'key');
 IF NOT FOUND THEN RAISE EXCEPTION 'CHECKOUT_NOTICE_PERSISTENCE_REQUIRED' USING ERRCODE='55000';END IF;PERFORM set_config('app.academy_id',coalesce(prior,''),true);RETURN NULL;
END $$;
ALTER FUNCTION public.capture_checkout_notice() OWNER TO kavosh_event_policy;
CREATE TRIGGER checkout_notice_capture AFTER INSERT ON public.outbox_events FOR EACH ROW WHEN(NEW.event_type IN('checkout.transport.received','checkout.transport.actor_conflict.critical','checkout.transport.conflict.critical','checkout.provider.object_conflict.critical','checkout.provider.review.critical','checkout.provider.observed','checkout.fees.object_conflict.critical','checkout.fees.observed','checkout.refunds.review_required.critical','checkout.refunds.observed')) EXECUTE FUNCTION public.capture_checkout_notice();
-- Converse completion:even an outbox BEFORE trigger returning NULL cannot
-- commit a new service fact while silently dropping its notification source.
CREATE FUNCTION public.checkout_notice_effect_required() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE prior text:=current_setting('app.academy_id',true);key text;BEGIN
 PERFORM set_config('app.academy_id',NEW.academy_id::text,true);
 IF NEW.origin_transaction IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'CHECKOUT_NOTICE_ORIGIN_REQUIRED' USING ERRCODE='23514';END IF;
 CASE TG_TABLE_NAME
 WHEN 'checkout_provider_inspections' THEN key='provider:'||NEW.id::text;
 WHEN 'checkout_fee_inspections' THEN key='fees:'||NEW.id::text;
 WHEN 'checkout_refund_inspections' THEN key='refunds:'||NEW.id::text;
 WHEN 'checkout_transport_receipts' THEN key='transport:received';
 WHEN 'checkout_transport_conflicts' THEN key='transport:conflict:'||NEW.payload_fingerprint;
 WHEN 'payment_checkout_dispatch_observations' THEN
  IF EXISTS(SELECT 1 FROM public.checkout_transport_receipts t WHERE t.academy_id=NEW.academy_id AND t.start_id=NEW.start_id AND(t.state IS DISTINCT FROM NEW.state OR t.provider_session_id IS DISTINCT FROM NEW.provider_session_id)) THEN key='transport:actor_conflict';ELSE PERFORM set_config('app.academy_id',coalesce(prior,''),true);RETURN NULL;END IF;
 END CASE;
 IF NOT EXISTS(SELECT 1 FROM public.automation_event_sources e WHERE e.academy_id=NEW.academy_id AND e.source_kind='checkout' AND e.checkout_start_id=NEW.start_id AND e.checkout_notice_key=key AND e.origin_transaction=NEW.origin_transaction) THEN RAISE EXCEPTION 'CHECKOUT_NOTICE_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.academy_id',coalesce(prior,''),true);RETURN NULL;
END $$;
ALTER FUNCTION public.checkout_notice_effect_required() OWNER TO kavosh_event_policy;
REVOKE ALL ON FUNCTION public.checkout_notice_effect_required() FROM PUBLIC;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['checkout_transport_receipts','checkout_transport_conflicts','payment_checkout_dispatch_observations','checkout_provider_inspections','checkout_fee_inspections','checkout_refund_inspections'] LOOP
 EXECUTE format('CREATE CONSTRAINT TRIGGER checkout_notice_effect AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.checkout_notice_effect_required()',t);
END LOOP;END $$;
DO $$ DECLARE d text;needle text:='IF source.event_id IS NULL';BEGIN
 d=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);IF position(needle IN d)=0 THEN RAISE EXCEPTION 'CHECKOUT_MANDATORY_GUARD_BASE_CHANGED';END IF;
 EXECUTE replace(d,needle,$branch$IF source.source_kind='checkout' THEN
  IF source.projection->>'severity' IS DISTINCT FROM 'critical' OR NEW.locale<>'en' OR NEW.title IS DISTINCT FROM 'Payment needs review' OR NEW.body IS DISTINCT FROM 'Open the linked payment record to review this observation. Reading this notice does not resolve it,approve accounting or confirm bank settlement.' OR NOT EXISTS(SELECT 1 FROM public.checkout_notice_audience(source.checkout_start_id) audience JOIN public.people p ON p.academy_id=NEW.academy_id AND p.id=audience.person_id WHERE p.id=NEW.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL) THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);
END $$;
REVOKE ALL ON FUNCTION public.checkout_notice_basis(uuid,xid8),public.checkout_notice_allows(uuid,jsonb),public.checkout_notice_audience(uuid),public.checkout_notice_upper(uuid,uuid),public.checkout_notice_guard(),public.publish_checkout_alert(),public.capture_checkout_notice() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.checkout_notice_basis(uuid,xid8),public.checkout_notice_audience(uuid) TO kavosh_event_policy;
GRANT EXECUTE ON FUNCTION public.checkout_notice_allows(uuid,jsonb) TO kavosh_runtime,kavosh_message_worker,kavosh_message_policy;
GRANT EXECUTE ON FUNCTION public.checkout_notice_upper(uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 305 $$;

-- Reconcile retained refund evidence,never erase observations or move money.
CREATE TABLE public.provider_credit_reviews(
 academy_id uuid NOT NULL,id uuid NOT NULL,collection_id uuid NOT NULL,inspection_ids uuid[] NOT NULL CHECK(cardinality(inspection_ids) BETWEEN 1 AND 100),
 source_stamp text NOT NULL CHECK(source_stamp~'^[a-f0-9]{64}$'),source jsonb NOT NULL,review_no bigint NOT NULL CHECK(review_no>0),approval_id uuid NOT NULL,created_by uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,collection_id,source_stamp),UNIQUE(academy_id,collection_id,review_no),FOREIGN KEY(academy_id,collection_id) REFERENCES public.provider_collections(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE INDEX provider_credit_review_history ON public.provider_credit_reviews(academy_id,collection_id,created_at DESC,id DESC);
CREATE INDEX checkout_refund_cursor_history ON public.checkout_refund_inspections(academy_id,start_id,(refund_inspection->>'startingAfter'),received_at DESC,id DESC);
ALTER TABLE public.provider_credit_reviews ENABLE ROW LEVEL SECURITY;ALTER TABLE public.provider_credit_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.provider_credit_reviews USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.provider_credit_reviews FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write();
GRANT SELECT,INSERT ON public.provider_credit_reviews TO kavosh_runtime;
CREATE FUNCTION public.provider_credit_review_pages(p_collection uuid) RETURNS uuid[] LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE c record;f record;ids uuid[]:=ARRAY[]::uuid[];cursor_id text:=NULL;BEGIN
 SELECT * INTO c FROM public.provider_collections WHERE id=p_collection;IF c.id IS NULL THEN RETURN NULL;END IF;
 FOR n IN 1..100 LOOP
  SELECT id,refund_inspection INTO f FROM public.checkout_refund_inspections WHERE academy_id=c.academy_id AND start_id=c.start_id AND refund_inspection->>'state'='refund_page' AND(refund_inspection->>'startingAfter') IS NOT DISTINCT FROM cursor_id ORDER BY received_at DESC,id DESC LIMIT 1;
  IF f.id IS NULL OR f.id=ANY(ids) THEN RETURN NULL;END IF;ids=array_append(ids,f.id);
  IF f.refund_inspection->'hasMore'='false'::jsonb THEN RETURN ids;END IF;cursor_id=f.refund_inspection->>'nextCursor';
 END LOOP;RETURN NULL;
END $$;
CREATE FUNCTION public.provider_credit_review_basis(p_collection uuid,p_pages uuid[]) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE c record;principal record;original record;f record;latest record;r jsonb;booking jsonb;booking_map jsonb;refund_map jsonb;page_id uuid;safe_on date;seen text[]:=ARRAY[]::text[];cursor_id text:=NULL;pages jsonb:='[]'::jsonb;bookings jsonb:='[]'::jsonb;history jsonb;stamp text;success_total numeric:=0;success_minor numeric:=0;minor numeric;count_success integer:=0;count_failed integer:=0;position integer:=0;BEGIN
 SELECT pc.*,q.unit_scale,q.currency_code,cl.time_zone INTO c FROM public.provider_collections pc JOIN public.payment_checkout_dispatch_starts st ON st.academy_id=pc.academy_id AND st.id=pc.start_id JOIN public.payment_checkout_attempts a ON a.academy_id=st.academy_id AND a.id=st.attempt_id JOIN public.payment_checkout_requests q ON q.academy_id=a.academy_id AND q.id=a.request_id JOIN public.classes cl ON cl.academy_id=pc.academy_id AND cl.id=pc.class_id WHERE pc.id=p_collection;
 IF c.id IS NULL THEN RETURN NULL;END IF;
 IF p_pages IS NULL OR cardinality(p_pages) NOT BETWEEN 1 AND 100 OR cardinality(p_pages)<>(SELECT count(DISTINCT x) FROM unnest(p_pages) x) OR array_position(p_pages,NULL) IS NOT NULL THEN RETURN jsonb_build_object('eligible',false,'code','REFUND_REVIEW_COMPLETE_PAGES_REQUIRED');END IF;
 SELECT * INTO principal FROM public.checkout_provider_inspections WHERE academy_id=c.academy_id AND start_id=c.start_id ORDER BY received_at DESC,id DESC LIMIT 1;
 SELECT * INTO original FROM public.checkout_provider_inspections WHERE academy_id=c.academy_id AND id=c.inspection_id;
 IF principal.id IS NULL OR principal.object_conflict OR principal.inspection->>'state' NOT IN('captured','requires_review') OR principal.inspection->>'chargeId' IS DISTINCT FROM c.charge_id OR principal.inspection->'amount' IS DISTINCT FROM original.inspection->'amount' OR principal.inspection->'currency' IS DISTINCT FROM original.inspection->'currency' OR principal.inspection->'disputed' IS DISTINCT FROM 'false'::jsonb
 OR EXISTS(SELECT 1 FROM public.checkout_provider_inspections bad WHERE bad.academy_id=c.academy_id AND bad.start_id=c.start_id AND(bad.object_conflict OR bad.inspection->'disputed'='true'::jsonb))
 OR EXISTS(SELECT 1 FROM public.checkout_refund_inspections bad WHERE bad.academy_id=c.academy_id AND bad.start_id=c.start_id AND bad.object_conflict)
 OR EXISTS(SELECT 1 FROM public.checkout_refund_attention att JOIN public.checkout_refund_inspections bad ON bad.academy_id=att.academy_id AND bad.id=att.inspection_id WHERE att.academy_id=c.academy_id AND att.start_id=c.start_id AND bad.object_conflict) THEN RETURN jsonb_build_object('eligible',false,'code','REFUND_REVIEW_DISPUTE_OR_OWNERSHIP_REQUIRED');END IF;
 -- One set-based source/booking lookup,not two queries per refund.
 SELECT coalesce(jsonb_object_agg(x.refund_id,x.value),'{}'::jsonb) INTO refund_map FROM(SELECT DISTINCT ON(e.value->>'id') e.value->>'id' refund_id,e.value FROM public.checkout_refund_inspections i CROSS JOIN LATERAL jsonb_array_elements(i.refund_inspection->'refunds') e WHERE i.academy_id=c.academy_id AND i.start_id=c.start_id ORDER BY e.value->>'id',i.received_at DESC,i.id DESC) x;
 SELECT coalesce(jsonb_object_agg(p.refund_id,jsonb_build_object('id',p.id,'amountMinor',p.amount_minor::text,'accountId',p.account_id,'livemode',p.livemode)),'{}'::jsonb),coalesce(jsonb_agg(jsonb_build_object('id',p.id,'amountMinor',p.amount_minor::text,'postedOn',p.posted_on) ORDER BY p.refund_id),'[]'::jsonb) INTO booking_map,bookings FROM public.provider_refund_postings p WHERE p.academy_id=c.academy_id AND p.collection_id=c.id;
 FOREACH page_id IN ARRAY p_pages LOOP
  position=position+1;
  SELECT f0.*,p.inspection principal INTO f FROM public.checkout_refund_inspections f0 JOIN public.checkout_provider_inspections p ON p.academy_id=f0.academy_id AND p.id=f0.principal_inspection_id WHERE f0.academy_id=c.academy_id AND f0.start_id=c.start_id AND f0.id=page_id;
  SELECT refund_inspection INTO latest FROM public.checkout_refund_inspections WHERE academy_id=c.academy_id AND start_id=c.start_id AND(refund_inspection->>'startingAfter') IS NOT DISTINCT FROM cursor_id ORDER BY received_at DESC,id DESC LIMIT 1;
  IF f.id IS NULL OR f.object_conflict OR f.principal IS DISTINCT FROM principal.inspection OR f.refund_inspection->>'state' IS DISTINCT FROM 'refund_page' OR f.refund_inspection->>'chargeId' IS DISTINCT FROM c.charge_id OR(f.refund_inspection->>'startingAfter') IS DISTINCT FROM cursor_id OR f.refund_inspection IS DISTINCT FROM latest.refund_inspection OR(f.refund_inspection->'hasMore'='true'::jsonb) IS DISTINCT FROM(position<cardinality(p_pages)) THEN RETURN jsonb_build_object('eligible',false,'code','REFUND_REVIEW_PAGE_CHAIN_CHANGED');END IF;
  pages=pages||jsonb_build_array(f.refund_inspection);cursor_id=f.refund_inspection->>'nextCursor';
  FOR r IN SELECT value FROM jsonb_array_elements(f.refund_inspection->'refunds') LOOP
   IF r->>'status' IS NULL OR r->>'status' NOT IN('succeeded','failed','canceled') THEN RETURN jsonb_build_object('eligible',false,'code','REFUND_REVIEW_UNFINISHED_REFUND');END IF;
   seen=array_append(seen,r->>'id');
   IF r IS DISTINCT FROM refund_map->(r->>'id') THEN RETURN jsonb_build_object('eligible',false,'code','REFUND_REVIEW_REFUND_FACTS_CHANGED');END IF;
   booking=booking_map->(r->>'id');
   IF r->>'status'='succeeded' THEN
    minor=(r->>'amount')::numeric*power(10::numeric,c.unit_scale)/power(10::numeric,(f.refund_inspection->>'providerUnitScale')::integer);
    IF minor<>trunc(minor) OR booking->>'id' IS NULL OR(booking->>'amountMinor')::numeric IS DISTINCT FROM minor OR booking->>'accountId' IS DISTINCT FROM c.account_id OR(booking->>'livemode')::boolean IS DISTINCT FROM c.livemode THEN RETURN jsonb_build_object('eligible',false,'code','REFUND_REVIEW_REFUND_ACCOUNTING_REQUIRED');END IF;
    success_total=success_total+(r->>'amount')::numeric;success_minor=success_minor+minor;count_success=count_success+1;
   ELSE
    IF booking IS NOT NULL THEN RETURN jsonb_build_object('eligible',false,'code','REFUND_REVIEW_FAILED_REFUND_CORRECTION_REQUIRED');END IF;count_failed=count_failed+1;
   END IF;
  END LOOP;
 END LOOP;
 IF cursor_id IS NOT NULL OR cardinality(seen)<>(SELECT count(DISTINCT v) FROM unnest(seen) v) OR success_total IS DISTINCT FROM(principal.inspection->>'refundedAmount')::numeric OR EXISTS(SELECT 1 FROM public.checkout_refund_object_bindings b WHERE b.academy_id=c.academy_id AND b.account_id=c.account_id AND b.livemode=c.livemode AND b.start_id=c.start_id AND NOT EXISTS(SELECT 1 FROM unnest(seen) v WHERE v=b.refund_id)) OR EXISTS(SELECT 1 FROM public.provider_refund_postings b WHERE b.academy_id=c.academy_id AND b.collection_id=c.id AND NOT EXISTS(SELECT 1 FROM unnest(seen) v WHERE v=b.refund_id)) THEN RETURN jsonb_build_object('eligible',false,'code','REFUND_REVIEW_TOTAL_OR_COVERAGE_MISMATCH');END IF;
 IF EXISTS(SELECT 1 FROM public.finance_journals j WHERE j.academy_id=c.academy_id AND j.reference=ANY(seen) AND j.reverses_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.finance_journals v WHERE v.academy_id=j.academy_id AND v.reverses_id=j.id)) THEN RETURN jsonb_build_object('eligible',false,'code','REFUND_REVIEW_MANUAL_RECONCILIATION_REQUIRED');END IF;
 SELECT greatest(c.received_on,coalesce(max(v.posted_on),c.received_on)) INTO safe_on FROM public.finance_journals j JOIN public.finance_journals v ON v.academy_id=j.academy_id AND v.reverses_id=j.id WHERE j.academy_id=c.academy_id AND j.reference=ANY(seen) AND j.reverses_id IS NULL;
 -- Keep ordered material transitions,not just latest values or a DISTINCT set.
 -- An old response returning after a new warning cannot revive an old review;
 -- identical refreshes do not force needless new approvals.
 WITH observations AS(
  SELECT 'provider'::text stream,i.received_at,i.id,jsonb_build_object('conflict',i.object_conflict,'fact',i.inspection) fact FROM public.checkout_provider_inspections i WHERE i.academy_id=c.academy_id AND i.start_id=c.start_id
  UNION ALL SELECT 'refunds:'||coalesce(i.refund_inspection->>'startingAfter',''),i.received_at,i.id,jsonb_build_object('conflict',i.object_conflict,'fact',i.refund_inspection) FROM public.checkout_refund_inspections i WHERE i.academy_id=c.academy_id AND i.start_id=c.start_id
 ),transitions AS(SELECT *,lag(fact) OVER(PARTITION BY stream ORDER BY received_at,id) prior FROM observations)
 SELECT coalesce(jsonb_agg(jsonb_build_array(stream,fact) ORDER BY stream,received_at,id) FILTER(WHERE fact IS DISTINCT FROM prior),'[]'::jsonb) INTO history FROM transitions;
 stamp=encode(sha256(convert_to(jsonb_build_array(c.id,c.account_id,c.livemode,c.amount_minor,c.unit_scale,principal.inspection,pages,bookings,history,safe_on)::text,'UTF8')),'hex');
 RETURN jsonb_build_object('eligible',true,'collectionId',c.id,'invoiceId',c.invoice_id,'studentId',c.student_id,'classId',c.class_id,'hubId',c.hub_id,'sourceStamp',stamp,'inspectionIds',to_jsonb(p_pages),'reconciliationFrom',safe_on::text,'pageCount',cardinality(p_pages),'refundCount',cardinality(seen),'succeededCount',count_success,'failedOrCanceledCount',count_failed,'accountedRefundMinor',trunc(success_minor)::text,'currencyCode',c.currency_code,'unitScale',c.unit_scale,'bankSettlementVerified',false,'moneyMovementPerformed',false);
END $$;
CREATE FUNCTION public.provider_credit_review_required(p_collection uuid,p_on date DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE c record;latest record;review record;b jsonb;BEGIN
 SELECT pc.*,cl.time_zone INTO c FROM public.provider_collections pc JOIN public.classes cl ON cl.academy_id=pc.academy_id AND cl.id=pc.class_id WHERE pc.id=p_collection;IF c.id IS NULL THEN RETURN true;END IF;
 SELECT * INTO review FROM public.provider_credit_reviews WHERE academy_id=c.academy_id AND collection_id=c.id ORDER BY review_no DESC LIMIT 1;
 IF review.id IS NOT NULL THEN b=public.provider_credit_review_basis(c.id,review.inspection_ids);IF b->'eligible'='true'::jsonb AND b->>'sourceStamp'=review.source_stamp THEN RETURN coalesce(p_on,(statement_timestamp() AT TIME ZONE c.time_zone)::date)<(b->>'reconciliationFrom')::date;END IF;END IF;
 SELECT * INTO latest FROM public.checkout_provider_inspections WHERE academy_id=c.academy_id AND start_id=c.start_id ORDER BY received_at DESC,id DESC LIMIT 1;
 RETURN latest.id IS NULL OR latest.object_conflict OR latest.inspection->>'state'<>'captured' OR latest.inspection->>'chargeId' IS DISTINCT FROM c.charge_id
 OR EXISTS(SELECT 1 FROM public.checkout_refund_attention a WHERE a.academy_id=c.academy_id AND a.start_id=c.start_id AND a.charge_id=c.charge_id)
 OR EXISTS(SELECT 1 FROM public.checkout_provider_inspections bad WHERE bad.academy_id=c.academy_id AND bad.start_id=c.start_id AND(bad.object_conflict OR bad.inspection->>'state'='requires_review') AND(bad.object_conflict OR bad.inspection->>'chargeId'=c.charge_id));
END $$;
CREATE FUNCTION public.guard_provider_credit_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE c record;p record;b jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PROVIDER_CREDIT_REVIEW_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM public.provider_collections WHERE academy_id=NEW.academy_id AND id=NEW.collection_id;PERFORM public.lock_customer_credit(NEW.collection_id);PERFORM public.lock_collector_funds(c.collector_id,c.holding_account);PERFORM id FROM public.tuition_invoices WHERE academy_id=c.academy_id AND id=c.invoice_id FOR UPDATE;PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':checkout-provider:'||c.account_id,0));
 b=public.provider_credit_review_basis(NEW.collection_id,NEW.inspection_ids);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b->'eligible' IS DISTINCT FROM 'true'::jsonb OR b IS DISTINCT FROM NEW.source OR b->>'sourceStamp' IS DISTINCT FROM NEW.source_stamp OR p.id IS NULL OR p.action IS DISTINCT FROM 'finance.provider-credit-review.record' OR p.status IS DISTINCT FROM 'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'receipts.edit' OR p.review_context IS DISTINCT FROM jsonb_build_object('source',b)
 OR p.payload IS DISTINCT FROM jsonb_build_object('collectionId',NEW.collection_id,'inspectionIds',to_jsonb(NEW.inspection_ids),'sourceStamp',NEW.source_stamp,'reason',NEW.reason)
 OR p.scope->'recordContext' IS DISTINCT FROM jsonb_build_object('hubId',c.hub_id,'classId',c.class_id,'studentId',c.student_id) OR NOT public.report_comment_human_verified(NEW.created_by) OR NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND status='active') THEN RAISE EXCEPTION 'PROVIDER_CREDIT_REVIEW_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) AND(p.requester_id=NEW.created_by OR c.student_id=NEW.created_by OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=c.student_id AND guardian_id=NEW.created_by) OR EXISTS(SELECT 1 FROM public.finance_collectors WHERE academy_id=NEW.academy_id AND id=c.collector_id AND person_id=NEW.created_by)) THEN RAISE EXCEPTION 'PROVIDER_CREDIT_REVIEW_UPPER_REQUIRED' USING ERRCODE='23514';END IF;
 -- Lock-ordered sequence,not transaction start time,defines the latest review.
 SELECT coalesce(max(review_no),0)+1 INTO NEW.review_no FROM public.provider_credit_reviews WHERE academy_id=NEW.academy_id AND collection_id=NEW.collection_id;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER provider_credit_review_guard BEFORE INSERT OR UPDATE OR DELETE ON public.provider_credit_reviews FOR EACH ROW EXECUTE FUNCTION public.guard_provider_credit_review();
CREATE FUNCTION public.complete_provider_credit_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;BEGIN
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.status IS DISTINCT FROM 'applied' OR p.reviewer_id IS DISTINCT FROM NEW.created_by OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.id AND actor_id=NEW.created_by AND created_at=transaction_timestamp() AND action='finance.provider-credit-review.recorded' AND changes=jsonb_build_object('approvalId',NEW.approval_id,'collectionId',NEW.collection_id,'severity','critical','moneyMovementPerformed',false,'bankSettlementVerified',false)) THEN RAISE EXCEPTION 'PROVIDER_CREDIT_REVIEW_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER provider_credit_review_complete AFTER INSERT ON public.provider_credit_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_provider_credit_review();
CREATE FUNCTION public.provider_credit_review_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND NEW.action='finance.provider-credit-review.record' AND NOT EXISTS(SELECT 1 FROM public.provider_credit_reviews WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PROVIDER_CREDIT_REVIEW_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER provider_credit_review_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.provider_credit_review_effect();
CREATE TRIGGER zz_provider_credit_review_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='finance.provider-credit-review.record') EXECUTE FUNCTION public.provider_refund_privacy();
CREATE FUNCTION public.checkout_notice_current(p_event uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE e record;c uuid;BEGIN
 SELECT * INTO e FROM public.automation_event_sources WHERE event_id=p_event AND source_kind='checkout';IF e.event_id IS NULL THEN RETURN false;END IF;
 IF e.projection->>'severity'<>'critical' OR e.projection#>>'{attributes,phase}' NOT IN('provider','refunds') THEN RETURN true;END IF;
 SELECT id INTO c FROM public.provider_collections WHERE academy_id=e.academy_id AND start_id=e.checkout_start_id;IF c IS NULL THEN RETURN true;END IF;RETURN public.provider_credit_review_required(c);
END $$;
ALTER FUNCTION public.checkout_notice_current(uuid) OWNER TO kavosh_runtime;
CREATE FUNCTION public.lock_checkout_notice_source(p_start uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE account text;BEGIN
 SELECT q.account_id INTO account FROM public.payment_checkout_dispatch_starts s JOIN public.payment_checkout_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id CROSS JOIN LATERAL(SELECT a.draft->>'accountId' account_id) q WHERE s.id=p_start;
 IF account IS NULL THEN RAISE EXCEPTION 'CHECKOUT_NOTICE_SOURCE_MISSING' USING ERRCODE='23514';END IF;PERFORM pg_advisory_xact_lock(hashtextextended(current_setting('app.academy_id')||':checkout-provider:'||account,0));
END $$;
ALTER FUNCTION public.lock_checkout_notice_source(uuid) OWNER TO kavosh_runtime;
CREATE FUNCTION public.checkout_notice_delivery_current() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='automation_runs' THEN IF NEW.outcome<>'processed' OR coalesce((NEW.summary->>'portalNotifications')::integer,0)+coalesce((NEW.summary->>'outboundQueued')::integer,0)=0 THEN RETURN NULL;END IF;
 ELSE IF NEW.status<>'sending' THEN RETURN NULL;END IF;END IF;
 IF EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='checkout') AND NOT public.checkout_notice_current(NEW.event_id) THEN RAISE EXCEPTION 'CHECKOUT_NOTICE_RECONCILED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER checkout_notice_delivery_current AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.checkout_notice_delivery_current();
CREATE CONSTRAINT TRIGGER checkout_notice_handoff_current AFTER UPDATE ON public.notification_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='sending') EXECUTE FUNCTION public.checkout_notice_delivery_current();
DO $$ DECLARE d text;marker text:='''providerReviewRequired'',';a integer;b integer;old text;BEGIN
 d=pg_get_functiondef('public.dated_customer_credit_source(uuid,uuid,timestamp with time zone)'::regprocedure);a=strpos(d,marker);b=strpos(d,' FROM public.provider_collections c');IF a=0 OR b<=a THEN RAISE EXCEPTION 'CREDIT_REVIEW_GATE_BASE_CHANGED';END IF;
 old=substr(d,a,b-a);IF right(rtrim(old,E' \n\r\t'),1)<>')' THEN RAISE EXCEPTION 'CREDIT_REVIEW_GATE_CLOSING_CHANGED';END IF;EXECUTE replace(d,old,marker||'public.provider_credit_review_required(c.id,(coalesce(p_at,statement_timestamp()) AT TIME ZONE cl.time_zone)::date))'||E'\n');
 d=pg_get_functiondef('public.provider_collection_accounting_summary(uuid,date)'::regprocedure);a=strpos(d,marker);b=strpos(d,'''source'',''retained_accounting_events''');IF a=0 OR b<=a THEN RAISE EXCEPTION 'CREDIT_REVIEW_SUMMARY_BASE_CHANGED';END IF;EXECUTE replace(d,substr(d,a,b-a),marker||'public.provider_credit_review_required(t.id,t.on_day),'||E'\n ');
END $$;
DO $$ DECLARE d text;needle text;BEGIN
 d=pg_get_functiondef('public.lock_notification_delivery_source(uuid,uuid)'::regprocedure);needle='IN(''tuition_due'',''expense_due'',''payroll_due'',''counterparty_statement'',''statement_due'') THEN PERFORM public.lock_finance_book();';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'CREDIT_REVIEW_DELIVERY_BOOK_BASE_CHANGED';END IF;d=replace(d,needle,'IN(''tuition_due'',''expense_due'',''payroll_due'',''counterparty_statement'',''statement_due'',''checkout'') THEN PERFORM public.lock_finance_book();');
 needle='IF e.source_kind=''statement_due'' THEN';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'CREDIT_REVIEW_DELIVERY_SOURCE_BASE_CHANGED';END IF;EXECUTE replace(d,needle,'IF e.source_kind=''checkout'' THEN PERFORM public.lock_checkout_notice_source(e.checkout_start_id);ELSIF e.source_kind=''statement_due'' THEN');
END $$;
REVOKE ALL ON FUNCTION public.provider_credit_review_pages(uuid),public.provider_credit_review_basis(uuid,uuid[]),public.provider_credit_review_required(uuid,date),public.guard_provider_credit_review(),public.complete_provider_credit_review(),public.provider_credit_review_effect() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provider_credit_review_pages(uuid),public.provider_credit_review_basis(uuid,uuid[]),public.provider_credit_review_required(uuid,date) TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.checkout_notice_current(uuid),public.lock_checkout_notice_source(uuid),public.checkout_notice_delivery_current() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.checkout_notice_current(uuid) TO kavosh_runtime,kavosh_message_worker,kavosh_message_policy;
GRANT EXECUTE ON FUNCTION public.lock_checkout_notice_source(uuid) TO kavosh_runtime,kavosh_message_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 306 $$;

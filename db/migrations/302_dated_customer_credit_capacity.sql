-- Same dated maximum-exposure rule as expense-payment capacity. Retained
-- events,not current reversal flags,determine how much a new persistent claim
-- can use without overspending on its own day OR any already-booked later day.
CREATE FUNCTION public.customer_credit_reservation_usage(p_academy uuid,p_collection uuid,p_invoice uuid,p_on date) RETURNS TABLE(credit_used numeric,invoice_used numeric)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH credit_events AS MATERIALIZED(
  SELECT a.applied_on on_day,a.amount_minor delta FROM public.customer_credit_applications a WHERE a.academy_id=p_academy AND a.collection_id=p_collection
  UNION ALL SELECT j.posted_on,-a.amount_minor FROM public.customer_credit_applications a JOIN public.tuition_receipts t ON t.academy_id=a.academy_id AND t.id=a.id JOIN public.finance_journals j ON j.academy_id=t.academy_id AND j.id=t.reversal_id WHERE a.academy_id=p_academy AND a.collection_id=p_collection
 ),invoice_events AS MATERIALIZED(
  SELECT t.received_on on_day,t.amount_minor delta FROM public.tuition_receipts t WHERE t.academy_id=p_academy AND t.invoice_id=p_invoice
  UNION ALL SELECT j.posted_on,-t.amount_minor FROM public.tuition_receipts t JOIN public.finance_journals j ON j.academy_id=t.academy_id AND j.id=t.reversal_id WHERE t.academy_id=p_academy AND t.invoice_id=p_invoice
  UNION ALL SELECT a.applied_on,a.amount_minor FROM public.customer_credit_applications a WHERE a.academy_id=p_academy AND a.invoice_id=p_invoice AND NOT EXISTS(SELECT 1 FROM public.tuition_receipts t WHERE t.academy_id=a.academy_id AND t.id=a.id)
 ),credit_running AS(SELECT on_day,sum(sum(delta)) OVER(ORDER BY on_day) used FROM credit_events GROUP BY on_day),invoice_running AS(SELECT on_day,sum(sum(delta)) OVER(ORDER BY on_day) used FROM invoice_events GROUP BY on_day)
 SELECT greatest(0,coalesce((SELECT max(used) FROM credit_running WHERE on_day>=p_on),0),coalesce((SELECT sum(delta) FROM credit_events WHERE on_day<=p_on),0),coalesce((SELECT sum(delta) FROM credit_events),0)),
 greatest(0,coalesce((SELECT max(used) FROM invoice_running WHERE on_day>=p_on),0),coalesce((SELECT sum(delta) FROM invoice_events WHERE on_day<=p_on),0),coalesce((SELECT sum(delta) FROM invoice_events),0)) WHERE p_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
$$;
-- Keep the complete existing source projection and its refund/dispute gates;
-- replace only the two capacity expressions. No parallel ledger or data rewrite.
DO $$ DECLARE body text;changed text;guard text;marker text:='t.reversal_id IS NULL';a integer;b integer;c integer;cutoff text:='(coalesce(p_at,statement_timestamp()) AT TIME ZONE cl.time_zone)::date';BEGIN
 SELECT prosrc INTO body FROM pg_proc WHERE oid='public.customer_credit_source(uuid,uuid)'::regprocedure;
 IF(length(body)-length(replace(body,marker,'')))/length(marker)<>2 OR strpos(body,'''remainingMinor'',')=0 THEN RAISE EXCEPTION 'DATED_CREDIT_SOURCE_MARKER_MISSING';END IF;
 a:=strpos(body,'''remainingMinor'',');b:=strpos(body,'''outstandingMinor'',');c:=strpos(body,'''providerInspectionFingerprint'',');
 IF b<=a OR c<=b OR strpos(body,'WHERE c.id=p_collection')=0 THEN RAISE EXCEPTION 'DATED_CREDIT_CAPACITY_MARKER_MISSING';END IF;
 changed:=substr(body,1,a-1)||'''capacityOn'',('||cutoff||')::text,''effectiveAt'',coalesce(p_at,statement_timestamp()),''futureClaimsReserved'',true,''capacityRevision'',1,''remainingMinor'',(c.amount_minor-reserved.credit_used)::text,''outstandingMinor'',(CASE WHEN i.credit_id IS NULL THEN terms.gross_minor ELSE 0 END-reserved.invoice_used)::text,'||substr(body,c);
 changed:=replace(changed,'WHERE c.id=p_collection','CROSS JOIN LATERAL public.customer_credit_reservation_usage(c.academy_id,c.id,i.id,'||cutoff||') reserved WHERE c.id=p_collection');
 EXECUTE format('CREATE FUNCTION public.dated_customer_credit_source(p_collection uuid,p_invoice uuid,p_at timestamptz DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog SET DateStyle=''ISO,YMD'' AS %L',changed);
 guard:=pg_get_functiondef('public.guard_customer_credit_application()'::regprocedure);
 changed:=replace(guard,'src:=public.customer_credit_source(NEW.collection_id,NEW.invoice_id);',
 'PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||'':checkout-provider:''||(SELECT account_id FROM public.provider_collections WHERE academy_id=NEW.academy_id AND id=NEW.collection_id),0));src:=public.dated_customer_credit_source(NEW.collection_id,NEW.invoice_id,NEW.applied_at);');
 IF changed=guard THEN RAISE EXCEPTION 'DATED_CREDIT_GUARD_MARKER_MISSING';END IF;EXECUTE changed;
END $$;
REVOKE ALL ON FUNCTION public.dated_customer_credit_source(uuid,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_credit_reservation_usage(uuid,uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dated_customer_credit_source(uuid,uuid,timestamptz) TO kavosh_runtime;
GRANT EXECUTE ON FUNCTION public.customer_credit_reservation_usage(uuid,uuid,uuid,date) TO kavosh_runtime;
-- Keep the original two-argument identity/ACL/configuration for existing
-- consumers;without an explicit date it is a current local-day preview.
CREATE OR REPLACE FUNCTION public.customer_credit_source(p_collection uuid,p_invoice uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT public.dated_customer_credit_source(p_collection,p_invoice,NULL) $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 302 $$;

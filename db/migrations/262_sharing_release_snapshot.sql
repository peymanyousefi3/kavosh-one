-- Canonical dated entitlement source. This does NOT issue a payable, infer fee
-- HST from tuition HST, settle collector funds, or move money. Historical rules
-- remain explicit; retiring a payee must not erase their earlier entitlement.
CREATE FUNCTION public.sharing_release_snapshot(p_invoice uuid,p_version integer,p_on date) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE academy uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;
 source record;activity jsonb;activity_count integer;received numeric;credited boolean;cancelled boolean;
 rows jsonb;full_total numeric;released_total numeric;external_full numeric;external_released numeric;collected numeric;result jsonb;
BEGIN
 IF p_on IS NULL OR p_on NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' OR p_version IS NULL OR p_version<1 THEN
  RAISE EXCEPTION 'SHARING_SNAPSHOT_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 SELECT i.id,i.plan_id,i.plan_version,i.student_id,i.class_id,i.hub_id,i.credit_id,
  d.issued_on,cd.issued_on credited_on,p.version current_tuition_version,
  t.net_minor,t.gross_minor,t.currency_id,c.code currency_code,u.unit_scale,
  h.id sharing_plan_id,h.version current_policy_version,r.version policy_version,r.tuition_version,
  r.basis,r.credit_handling,r.active,r.allow_overallocation,r.base_minor,r.full_fee_total,r.line_count
 INTO source FROM public.tuition_invoices i
 JOIN public.billing_documents d ON d.academy_id=i.academy_id AND d.id=i.id
 LEFT JOIN public.billing_documents cd ON cd.academy_id=i.academy_id AND cd.id=i.credit_id
 JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id
 JOIN public.tuition_plan_revisions t ON t.academy_id=i.academy_id AND t.plan_id=i.plan_id AND t.version=i.plan_version
 JOIN public.finance_currencies c ON c.academy_id=t.academy_id AND c.id=t.currency_id
 JOIN public.finance_currency_revisions u ON u.academy_id=t.academy_id AND u.currency_id=t.currency_id AND u.version=t.currency_version
 JOIN public.revenue_share_plans h ON h.academy_id=i.academy_id AND h.tuition_plan_id=i.plan_id
 JOIN public.revenue_share_revisions r ON r.academy_id=h.academy_id AND r.plan_id=h.id AND r.version=p_version
 WHERE i.academy_id=academy AND i.id=p_invoice;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF source.tuition_version<>source.plan_version THEN RAISE EXCEPTION 'SHARING_INVOICE_VERSION_MISMATCH' USING ERRCODE='23514';END IF;
 IF source.issued_on>p_on THEN RETURN NULL;END IF;
 -- Include all retained activity in the stamp, including future/reversed
 -- entries, while summing only postings effective on the requested day.
 -- ponytail: bounded 10000-event invoice history; fail closed, batch it if exceeded.
 WITH events AS(
  SELECT r.id receipt_id,j.id event_id,j.posted_on,r.amount_minor delta_minor
  FROM public.tuition_receipts r JOIN public.finance_journals j ON j.academy_id=r.academy_id AND j.id=r.id
  WHERE r.academy_id=academy AND r.invoice_id=p_invoice
  UNION ALL
  SELECT r.id,j.id,j.posted_on,-r.amount_minor
  FROM public.tuition_receipts r JOIN public.tuition_receipt_reversals v ON v.academy_id=r.academy_id AND v.receipt_id=r.id
  JOIN public.finance_journals j ON j.academy_id=v.academy_id AND j.id=v.id
  WHERE r.academy_id=academy AND r.invoice_id=p_invoice
 ),bounded AS(SELECT * FROM events ORDER BY posted_on,event_id LIMIT 10001)
 SELECT count(*),coalesce(sum(delta_minor) FILTER(WHERE posted_on<=p_on),0),
  coalesce(jsonb_agg(jsonb_build_array(receipt_id,event_id,posted_on,delta_minor::text) ORDER BY posted_on,event_id),'[]'::jsonb)
 INTO activity_count,received,activity FROM bounded;
 IF activity_count>10000 THEN RAISE EXCEPTION 'SHARING_SOURCE_HISTORY_LIMIT' USING ERRCODE='54000';END IF;
 IF received<0 OR received>source.gross_minor THEN RAISE EXCEPTION 'SHARING_COLLECTION_TIMELINE_INVALID' USING ERRCODE='23514';END IF;
 credited:=coalesce(source.credited_on<=p_on,false);
 cancelled:=credited AND source.credit_handling='cancel_on_credit';
 collected:=CASE WHEN cancelled OR source.gross_minor=0 THEN 0 ELSE div(source.base_minor*received,source.gross_minor) END;
 WITH amounts AS(
  SELECT l.payee_id,l.payee_version,p.kind,l.method,l.value,l.release,f.full_minor,
   CASE WHEN cancelled THEN 0 WHEN l.release='on_invoice' THEN f.full_minor
    WHEN l.release='first_collection' THEN CASE WHEN received>0 THEN f.full_minor ELSE 0 END
    WHEN l.release='fully_collected' THEN CASE WHEN source.gross_minor>0 AND received=source.gross_minor THEN f.full_minor ELSE 0 END
    ELSE CASE WHEN source.gross_minor>0 THEN div(f.full_minor*received,source.gross_minor) ELSE 0 END END released_minor
  FROM public.revenue_share_lines l JOIN public.financial_payees p ON p.academy_id=l.academy_id AND p.id=l.payee_id
  JOIN public.revenue_share_full_amounts(academy,source.sharing_plan_id,p_version) f ON f.payee_id=l.payee_id
  WHERE l.academy_id=academy AND l.plan_id=source.sharing_plan_id AND l.version=p_version
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('payeeId',payee_id,'payeeVersion',payee_version,'kind',kind,
   'method',method,'valueMinor',value::text,'release',release,'fullMinor',full_minor::text,'releasedMinor',released_minor::text) ORDER BY payee_id),'[]'::jsonb),
  coalesce(sum(full_minor),0),coalesce(sum(released_minor),0),coalesce(sum(full_minor) FILTER(WHERE kind<>'academy'),0),coalesce(sum(released_minor) FILTER(WHERE kind<>'academy'),0)
 INTO rows,full_total,released_total,external_full,external_released FROM amounts;
 IF jsonb_array_length(rows)<>source.line_count OR full_total<>source.full_fee_total
  OR(source.base_minor<>CASE WHEN source.basis='net_tuition' THEN source.net_minor ELSE source.gross_minor END)
  OR(full_total>source.base_minor AND NOT source.allow_overallocation) THEN
  RAISE EXCEPTION 'SHARING_SNAPSHOT_SOURCE_INVALID' USING ERRCODE='23514';
 END IF;
 result:=jsonb_build_object('invoiceId',source.id,'tuitionPlanId',source.plan_id,'tuitionVersion',source.plan_version,
  'currentTuitionVersion',source.current_tuition_version,'sharingPlanId',source.sharing_plan_id,'policyVersion',p_version,
  'currentPolicyVersion',source.current_policy_version,'policyActive',source.active,
  'studentId',source.student_id,'classId',source.class_id,'hubId',source.hub_id,'asOf',p_on::text,
  'currencyId',source.currency_id,'currencyCode',source.currency_code,'unitScale',source.unit_scale,
  'basis',source.basis,'creditHandling',source.credit_handling,'invoiceCredited',credited,'cancelledByCredit',cancelled,
  'receivedGrossMinor',received::text,'baseMinor',source.base_minor::text,'collectedBaseMinor',collected::text,
  'rows',rows,'fullTotalMinor',full_total::text,'releasedTotalMinor',released_total::text,
  'unassignedFullMinor',(source.base_minor-full_total)::text,'academyFullMinor',(source.base_minor-external_full)::text,
  'academyReleasedMinor',(collected-external_released)::text,'overAllocated',full_total>source.base_minor,
  'cashCoverageShortfallMinor',greatest(external_released-collected,0)::text,'recordedActivityVersion',activity_count,
  'planningOnly',true,'payableRecorded',false,'ledgerPosted',false,'feeTaxCalculated',false,
  'bankSettlementVerified',false,'moneyMovementPerformed',false);
 RETURN result||jsonb_build_object('sourceStamp',encode(sha256(convert_to(jsonb_build_array(result,source.credit_id,source.credited_on,activity)::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION public.sharing_release_snapshot(uuid,integer,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sharing_release_snapshot(uuid,integer,date) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 262 $$;

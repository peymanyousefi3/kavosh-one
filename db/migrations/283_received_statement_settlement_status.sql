-- Recipient status is an allowlisted projection of the SAME net matching and
-- ambiguity assessment,not another debt/payment calculation or finance grant.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('received-statement-settlements.view','Read own released statement live net matching status','Finance',true,ARRAY['hub','person','country','region','city']);
DO $$ DECLARE body text;needle text:='a.status=''active''';BEGIN
 body=pg_get_functiondef('public.statement_reminder_assessment(uuid,integer,text,jsonb)'::regprocedure);
 IF position('FUNCTION public.statement_reminder_assessment(' IN body)=0 OR(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'RECEIVED_STATEMENT_ASSESSMENT_BASE_CHANGED';END IF;
 EXECUTE replace(replace(body,'FUNCTION public.statement_reminder_assessment(','FUNCTION public.received_statement_assessment('),needle,'a.status IN(''active'',''read_only'')');
END $$;
CREATE FUNCTION public.received_statement_settlement_status(p_release uuid,p_actor uuid,p_scope jsonb,p_zone text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH authorized AS MATERIALIZED(
  SELECT a.id,a.statement_id,a.statement_version,a.recipient_content,h.version current_version,r.content,r.state,w.id withdrawal_id,z.name time_zone,(statement_timestamp() AT TIME ZONE z.name)::date today
  FROM public.counterparty_statement_releases a
  JOIN public.people p ON p.academy_id=a.academy_id AND p.id=a.recipient_id
  JOIN public.counterparty_statement_records h ON h.academy_id=a.academy_id AND h.id=a.statement_id
  JOIN public.counterparty_statement_revisions r ON r.academy_id=h.academy_id AND r.statement_id=h.id AND r.version=h.version
  LEFT JOIN public.counterparty_statement_release_withdrawals w ON w.academy_id=a.academy_id AND w.release_id=a.id
  CROSS JOIN(SELECT name FROM pg_catalog.pg_timezone_names WHERE name=p_zone) z
  WHERE a.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND a.id=p_release AND a.recipient_id=p_actor AND p.kind='human' AND p.status='active' AND public.report_comment_human_verified(p.id)
   AND NOT EXISTS(SELECT 1 FROM(VALUES('received-statements.view'),('received-statement-settlements.view')) cap(name)
    WHERE public.approval_scope_nonempty(p_scope->cap.name) IS NOT TRUE OR public.scope_contains(p_scope->cap.name,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p.id,'hubId',p.hub_id)))) IS NOT TRUE)
 ),assessment AS MATERIALIZED(
  SELECT a.id,public.received_statement_assessment(a.statement_id,0,a.time_zone,(SELECT jsonb_object_agg(name,jsonb_build_object('all',true,'hubs','[]'::jsonb)) FROM public.capability_catalog)) data
  FROM authorized a WHERE a.withdrawal_id IS NULL AND a.current_version=a.statement_version AND a.state='issued' AND(a.recipient_content->>'statementOn')::date<=a.today
 ),amounts AS MATERIALIZED(
  SELECT a.id,coalesce(jsonb_agg(jsonb_build_object('code',u->>'currencyCode','scale',c->'scale','signedDueMinor',c->>'signedDueMinor','matchedMinor',c->>'matchedMinor','remainingMinor',c->>'remainingMinor','status',c->>'status') ORDER BY u->>'currencyCode'),'[]'::jsonb) currencies
  FROM authorized a JOIN assessment m ON m.id=a.id CROSS JOIN LATERAL jsonb_array_elements(m.data->'currencies') c
  JOIN LATERAL jsonb_array_elements(a.content#>'{recorded,currencies}') u ON u->>'currency_id'=c->>'currency_id' GROUP BY a.id
 ),disposition AS(
  SELECT a.*,m.data,coalesce(v.currencies,'[]'::jsonb) currencies,
   CASE WHEN a.withdrawal_id IS NOT NULL THEN 'release_withdrawn' WHEN a.current_version<>a.statement_version THEN 'statement_edition_changed' WHEN a.state<>'issued' THEN 'statement_withdrawn' WHEN(a.recipient_content->>'statementOn')::date>a.today THEN 'not_issued_yet'
    WHEN m.data->>'state'='history_limit' THEN 'history_limit' WHEN m.data IS NULL OR m.data->>'state'='review_required' OR jsonb_array_length(coalesce(v.currencies,'[]'::jsonb))<>jsonb_array_length(coalesce(m.data->'currencies','[]'::jsonb)) THEN 'review_required' ELSE 'current' END availability
  FROM authorized a LEFT JOIN assessment m ON m.id=a.id LEFT JOIN amounts v ON v.id=a.id
 )
 SELECT jsonb_build_object('releaseId',id,'statementVersion',statement_version,'on',today::text,'timeZone',time_zone,'availability',availability,'currencies',CASE WHEN availability='current' THEN currencies ELSE '[]'::jsonb END,
  'basis','reviewed_allocations_against_net_statement_balance','remainingIsPaymentDemand',false,'archiveContentChanged',false,'bankSettlementVerified',false,'underlyingGrossClearanceVerified',false,'nettingPerformed',false,'paymentExecuted',false)
 FROM disposition
$$;
REVOKE ALL ON FUNCTION public.received_statement_assessment(uuid,integer,text,jsonb),public.received_statement_settlement_status(uuid,uuid,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.received_statement_assessment(uuid,integer,text,jsonb),public.received_statement_settlement_status(uuid,uuid,jsonb,text) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 283 $$;

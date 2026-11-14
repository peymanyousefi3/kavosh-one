-- Reuse canonical monetary bodies under ONE read snapshot. Existing mutation
-- entrypoints retain their identity,locks,volatility and exact review protocol.
DO $$ DECLARE body text;needle text;signature text;BEGIN
 body=pg_get_functiondef('public.counterparty_statement_snapshot(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)'::regprocedure);
 IF position('LANGUAGE plpgsql' IN body)=0 OR position('FUNCTION public.counterparty_statement_snapshot(' IN body)=0 THEN RAISE EXCEPTION 'STATEMENT_REMINDER_KERNEL_BASE_CHANGED';END IF;
 EXECUTE replace(replace(body,'FUNCTION public.counterparty_statement_snapshot(','FUNCTION public.counterparty_statement_snapshot_read('),'LANGUAGE plpgsql','LANGUAGE plpgsql STABLE');
 body=pg_get_functiondef('public.counterparty_statement_source_allows(jsonb,jsonb)'::regprocedure);
 needle='public.counterparty_statement_rows((frame->>''payeeId'')::uuid,(frame->>''from'')::date,(frame->>''through'')::date,s,NULL,NULL,NULL,NULL,1,ids)';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'STATEMENT_REMINDER_PERMISSION_BASE_CHANGED';END IF;
 body=replace(body,needle,'public.counterparty_statement_snapshot_read((frame->>''payeeId'')::uuid,(frame->>''from'')::date,(frame->>''through'')::date,s,NULL,NULL,NULL,NULL,1,ids,false)');
 EXECUTE replace(replace(body,'FUNCTION public.counterparty_statement_source_allows(','FUNCTION public.counterparty_statement_source_allows_read('),'LANGUAGE plpgsql','LANGUAGE plpgsql STABLE');
 body=pg_get_functiondef('public.statement_settlement_allows(jsonb,jsonb)'::regprocedure);
 needle='public.counterparty_statement_rows(h.payee_id,h.from_on,greatest(h.through_on,p.posted_on),s,NULL,NULL,NULL,NULL,1,h.currency_ids)';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'STATEMENT_REMINDER_MATCH_PERMISSION_BASE_CHANGED';END IF;
 body=replace(replace(body,needle,'public.counterparty_statement_snapshot_read(h.payee_id,h.from_on,greatest(h.through_on,p.posted_on),s,NULL,NULL,NULL,NULL,1,h.currency_ids,false)'),'public.counterparty_statement_source_allows(','public.counterparty_statement_source_allows_read(');
 EXECUTE replace(replace(body,'FUNCTION public.statement_settlement_allows(','FUNCTION public.statement_settlement_allows_read('),'LANGUAGE plpgsql','LANGUAGE plpgsql STABLE');
 body=pg_get_functiondef('public.statement_settlement_status(uuid,integer,date,jsonb)'::regprocedure);
 IF position('public.statement_settlement_allows(' IN body)=0 OR position('public.counterparty_statement_source_allows(' IN body)=0 THEN RAISE EXCEPTION 'STATEMENT_REMINDER_STATUS_BASE_CHANGED';END IF;
 body=replace(replace(body,'public.statement_settlement_allows(','public.statement_settlement_allows_read('),'public.counterparty_statement_source_allows(','public.counterparty_statement_source_allows_read(');
 EXECUTE replace(replace(body,'FUNCTION public.statement_settlement_status(','FUNCTION public.statement_settlement_status_read('),'LANGUAGE plpgsql','LANGUAGE plpgsql STABLE');
 FOREACH signature IN ARRAY ARRAY['counterparty_statement_snapshot_read(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)','counterparty_statement_source_allows_read(jsonb,jsonb)','statement_settlement_allows_read(jsonb,jsonb)','statement_settlement_status_read(uuid,integer,date,jsonb)'] LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION public.'||signature||' FROM PUBLIC';EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||signature||' TO kavosh_runtime';
 END LOOP;
END $$;
-- ponytail: interactive ambiguity/history scans cap at10000 rows;fail closed
-- above that ceiling. Larger sources need the approved chunked report worker.
CREATE FUNCTION public.statement_reminder_assessment(p_statement uuid,p_days integer,p_zone text,p_scopes jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' SET TimeZone='UTC' AS $$
 WITH scopes AS MATERIALIZED(SELECT coalesce(p_scopes,(SELECT jsonb_object_agg(name,jsonb_build_object('all',true,'hubs','[]'::jsonb)) FROM public.capability_catalog)) s),
 zone AS MATERIALIZED(SELECT name,(statement_timestamp() AT TIME ZONE name)::date today FROM pg_catalog.pg_timezone_names WHERE name=p_zone AND p_days BETWEEN -365 AND 3650),
 target AS MATERIALIZED(SELECT h.*,r.state,r.content,r.source_snapshot,z.today,z.name time_zone,(r.content#>>'{definition,dueOn}')::date due_on
  FROM public.counterparty_statement_records h JOIN public.counterparty_statement_revisions r ON r.academy_id=h.academy_id AND r.statement_id=h.id AND r.version=h.version JOIN public.academies a ON a.id=h.academy_id CROSS JOIN zone z
  WHERE h.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND h.id=p_statement AND a.status='active'),
 context AS MATERIALIZED(SELECT h.*,v."sourceScope" scope,v."sourceFingerprint" live_stamp,v.denied,v.unknown
  FROM target h CROSS JOIN scopes CROSS JOIN LATERAL public.counterparty_statement_snapshot_read(h.payee_id,h.from_on,greatest(h.through_on,h.today),scopes.s,NULL,NULL,NULL,NULL,1,h.currency_ids,false) v),
 authorized AS MATERIALIZED(SELECT c.* FROM context c CROSS JOIN scopes WHERE c.denied=0 AND c.unknown=0 AND c.live_stamp IS NOT NULL
  AND public.scope_contains(scopes.s->'counterparty-statements.view',c.scope) IS TRUE AND public.scope_contains(scopes.s->'counterparty-settlements.view',c.scope) IS TRUE),
 matched AS MATERIALIZED(SELECT h.*,public.statement_settlement_status_read(h.id,h.version,h.today,scopes.s) matching FROM authorized h CROSS JOIN scopes),
 payments AS MATERIALIZED(SELECT p.*,public.statement_payment_membership(h.source_snapshot,h.content,p.family,p.journal_id,p.line_number,p.posted_on) membership
  FROM matched h JOIN public.counterparty_settlement_payments p ON p.academy_id=h.academy_id AND p.payee_id=h.payee_id
  WHERE p.posted_on<=h.today AND(p.reversed_on IS NULL OR p.reversed_on>h.today) AND EXISTS(SELECT 1 FROM jsonb_array_elements(h.matching->'currencies') c WHERE c->>'currency_id'=p.currency_id::text AND sign((c->>'signedDueMinor')::numeric)=-sign(p.delta_minor)) LIMIT 10001),
 allocations AS MATERIALIZED(SELECT a.*,p.unit_scale payment_scale,p.delta_minor FROM payments p JOIN public.counterparty_statement_settlements a ON a.academy_id=p.academy_id AND a.source_family=p.family AND a.source_journal=p.journal_id AND a.source_line=p.line_number
  CROSS JOIN zone z LEFT JOIN public.counterparty_settlement_releases x ON x.academy_id=a.academy_id AND x.settlement_id=a.id WHERE a.allocated_on<=z.today AND(x.released_on IS NULL OR x.released_on>z.today) LIMIT 10001),
 units AS(SELECT p.family,p.journal_id,p.line_number,p.unit_scale,p.delta_minor,p.membership,greatest(p.unit_scale,coalesce(max(a.unit_scale),p.unit_scale)) scale FROM payments p LEFT JOIN allocations a ON a.source_family=p.family AND a.source_journal=p.journal_id AND a.source_line=p.line_number GROUP BY p.family,p.journal_id,p.line_number,p.unit_scale,p.delta_minor,p.membership),
 remaining_payments AS(SELECT u.family,u.journal_id,u.line_number,u.membership,abs(u.delta_minor)*power(10::numeric,u.scale-u.unit_scale)-coalesce(sum(a.amount_minor*power(10::numeric,u.scale-a.unit_scale)),0) remaining FROM units u LEFT JOIN allocations a ON a.source_family=u.family AND a.source_journal=u.journal_id AND a.source_line=u.line_number GROUP BY u.family,u.journal_id,u.line_number,u.membership,u.delta_minor,u.scale,u.unit_scale),
 activity AS MATERIALIZED(SELECT a.id,a.source_journal,a.source_family,a.source_line,x.id release_id,x.released_on,p.reversal_id,p.reversed_on FROM matched h JOIN public.counterparty_statement_settlements a ON a.academy_id=h.academy_id AND a.statement_id=h.id LEFT JOIN public.counterparty_settlement_releases x ON x.academy_id=a.academy_id AND x.settlement_id=a.id LEFT JOIN public.counterparty_settlement_payments p ON p.academy_id=a.academy_id AND p.payee_id=h.payee_id AND p.family=a.source_family AND p.journal_id=a.source_journal AND p.line_number=a.source_line LIMIT 10001),
 assessment AS(SELECT h.*,CASE WHEN matching ? 'unavailable' THEN 'review_required' WHEN state<>'issued' THEN 'withdrawn' WHEN(content#>>'{definition,statementOn}')::date>today THEN 'not_issued_yet'
  WHEN(SELECT count(*) FROM payments)>10000 OR(SELECT count(*) FROM allocations)>10000 OR(SELECT count(*) FROM activity)>10000 THEN 'history_limit'
  WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(matching->'currencies') c WHERE c->>'status'='needs_review') OR EXISTS(SELECT 1 FROM remaining_payments WHERE membership='unknown' OR(membership='excluded' AND remaining<>0)) THEN 'review_required'
  WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(matching->'currencies') c WHERE c->>'status' IN('unpaid','partially_paid') AND(c->>'remainingMinor')::numeric>0) THEN 'settled'
  WHEN today-due_on<>p_days THEN 'outside_reminder_day' ELSE 'eligible' END disposition FROM matched h)
 SELECT jsonb_build_object('statementId',id,'statementVersion',version,'payeeId',payee_id,'scope',scope,'hubId',CASE WHEN scope->'all'='false'::jsonb AND jsonb_array_length(scope->'hubs')=1 THEN scope#>>'{hubs,0}' END,'state',disposition,'eligible',disposition='eligible','dueOn',due_on::text,'reminderOn',today::text,'timeZone',time_zone,'daysFromDue',p_days,
 'currencies',CASE WHEN disposition='history_limit' THEN '[]'::jsonb ELSE coalesce(matching->'currencies','[]'::jsonb) END,'sourceComplete',disposition<>'history_limit','historyLimit',10000,'unmatchedPaymentCount',CASE WHEN disposition<>'history_limit' THEN(SELECT count(*) FROM remaining_payments WHERE membership='excluded' AND remaining>0) END,'unknownMembershipCount',CASE WHEN disposition<>'history_limit' THEN(SELECT count(*) FROM remaining_payments WHERE membership='unknown') END,
 'sourceStamp',encode(sha256(convert_to(jsonb_build_array(id,version,state,encode(sha256(convert_to(content::text,'UTF8')),'hex'),scope,live_stamp,matching,today,due_on,time_zone,p_days,
 (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM activity a),(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.family,p.journal_id,p.line_number),'[]'::jsonb) FROM remaining_payments p))::text,'UTF8')),'hex'),
 'basis','reviewed_allocations_against_net_statement_balance','legalOverdueDetermination',false,'bankSettlementVerified',false,'moneyMovementPerformed',false)
 FROM assessment WHERE matching ? 'unavailable' IS NOT TRUE
$$;
CREATE FUNCTION public.statement_reminder_source(p_statement uuid,p_days integer,p_zone text,p_scopes jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT s.source FROM public.statement_reminder_assessment($1,$2,$3,$4) AS s(source) WHERE s.source->'eligible'='true'::jsonb $$;
REVOKE ALL ON FUNCTION public.statement_reminder_assessment(uuid,integer,text,jsonb),public.statement_reminder_source(uuid,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.statement_reminder_assessment(uuid,integer,text,jsonb),public.statement_reminder_source(uuid,integer,text,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 280 $$;

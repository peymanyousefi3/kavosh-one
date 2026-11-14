-- Current + posting-day balances alone can reuse a later restored balance:
-- +113 receipt, -100 transfer, +100 reversal, then a backdated -50 would make
-- the intervening balance negative. Reserve every subsequent dated trough.
-- This same source will govern collector-side noncash offsets.
CREATE FUNCTION public.collector_fund_capacity(p_collector uuid,p_holding uuid,p_on date,p_direction text)
RETURNS TABLE(current_minor numeric,through_minor numeric,available_minor numeric,activity bigint,source_stamp text)
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE r record;sign numeric;
BEGIN
 IF p_collector IS NULL OR p_holding IS NULL OR p_on IS NULL OR p_on NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' OR p_direction IS NULL OR p_direction NOT IN('to_academy','to_collector') THEN
  RAISE EXCEPTION 'COLLECTOR_CAPACITY_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 sign=CASE WHEN p_direction='to_academy' THEN 1 ELSE -1 END;
 -- ponytail: bounded200000 events per collector/account; fail closed and add
 -- indexed period rollups if a retained bucket outgrows this interactive cap.
 WITH events AS MATERIALIZED(
  SELECT e.journal_id,e.posted_on,e.delta_minor FROM public.collector_fund_events e
  WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.collector_id=p_collector AND e.holding_account=p_holding
  ORDER BY e.journal_id LIMIT 200001
 ),daily AS(SELECT e.posted_on,sum(e.delta_minor) delta FROM events e GROUP BY e.posted_on),
 running AS(SELECT d.posted_on,sum(d.delta) OVER(ORDER BY d.posted_on ROWS UNBOUNDED PRECEDING) balance FROM daily d)
 SELECT count(*)::bigint n,coalesce(sum(e.delta_minor),0) current_balance,
  coalesce(sum(e.delta_minor) FILTER(WHERE e.posted_on<=p_on),0) dated_balance,
  (SELECT min(sign*x.balance) FROM running x WHERE x.posted_on>=p_on) future_floor,
  -- Journal IDs pin immutable posting dates and signed source amounts. Hashing
  -- ordered IDs avoids retaining a second full financial history JSON copy.
  encode(sha256(convert_to(jsonb_build_array(nullif(current_setting('app.academy_id',true),'')::uuid,p_collector,p_holding,p_on::text,p_direction,coalesce(string_agg(e.journal_id::text,',' ORDER BY e.journal_id),''))::text,'UTF8')),'hex') stamp
 INTO r FROM events e;
 IF r.n>200000 THEN RAISE EXCEPTION 'COLLECTOR_CAPACITY_HISTORY_LIMIT' USING ERRCODE='54000';END IF;
 RETURN QUERY SELECT r.current_balance,r.dated_balance,
  greatest(0,least(sign*r.current_balance,sign*r.dated_balance,coalesce(r.future_floor,sign*r.dated_balance))),r.n,r.stamp;
END $$;

-- Preserve the live guard's identity, owner, ACL and every unrelated check.
-- VOLATILE source is intentional: direct multirow writes and a statement
-- waiting on the collector lock must observe earlier committed effects.
DO $$ DECLARE body text;old_source text:='SELECT * INTO funds FROM public.collector_fund_balance(NEW.collector_id,NEW.holding_account,NEW.posted_on);';
 old_check text:='IF(NEW.direction=''to_academy'' AND(NEW.amount_minor>funds.current_minor OR NEW.amount_minor>funds.through_minor)) OR(NEW.direction=''to_collector'' AND(NEW.amount_minor> -funds.current_minor OR NEW.amount_minor> -funds.through_minor)) THEN';
BEGIN
 body=pg_get_functiondef('public.guard_collector_remittance()'::regprocedure);
 IF(length(body)-length(replace(body,old_source,'')))/length(old_source)<>1 OR(length(body)-length(replace(body,old_check,'')))/length(old_check)<>1 THEN RAISE EXCEPTION 'COLLECTOR_CAPACITY_GUARD_BASE_CHANGED';END IF;
 body=replace(body,old_source,'SELECT * INTO funds FROM public.collector_fund_capacity(NEW.collector_id,NEW.holding_account,NEW.posted_on,NEW.direction);');
 EXECUTE replace(body,old_check,'IF NEW.amount_minor>funds.available_minor THEN');
END $$;
REVOKE ALL ON FUNCTION public.collector_fund_capacity(uuid,uuid,date,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collector_fund_capacity(uuid,uuid,date,text) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 264 $$;

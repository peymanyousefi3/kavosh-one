-- Reauthorize large retained membership inside PostgreSQL,not by loading up to
--200000private source tuples into the web process. Return a Boolean only.
DO $$ DECLARE body text;needle text;BEGIN
 SELECT prosrc INTO body FROM pg_proc WHERE oid='public.counterparty_report_capture_rows(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)'::regprocedure;
 FOREACH needle IN ARRAY ARRAY[
  'FROM totals t JOIN public.finance_currencies c ON c.id=t.currency_id WHERE(SELECT allowed FROM proof_gate)',
  'FROM windowed w JOIN public.finance_currencies c ON c.id=w.currency_id WHERE(SELECT allowed FROM proof_gate)',
  'FROM day_balances d JOIN totals t ON t.currency_id=d.currency_id JOIN public.finance_currencies c ON c.id=d.currency_id WHERE(SELECT allowed FROM proof_gate)'
 ] LOOP
  IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'REPORT_CAPTURE_ACCESS_BASE_CHANGED';END IF;
  body=replace(body,needle,replace(needle,'WHERE(SELECT','WHERE NOT $11 AND(SELECT'));
 END LOOP;
 EXECUTE 'CREATE OR REPLACE FUNCTION public.counterparty_report_capture_rows(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean) RETURNS TABLE(section smallint,ordinal integer,payload jsonb) LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET DateStyle=''ISO,YMD'' SET TimeZone=''UTC'' AS '||quote_literal(body);
END $$;
CREATE FUNCTION public.counterparty_report_capture_allows(p_job uuid,p_fingerprint text,p_frame jsonb,p_scopes jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH captured AS MATERIALIZED(
  SELECT * FROM public.counterparty_report_captures WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND job_id=p_job
   AND source_metadata->>'sourceFingerprint'=p_fingerprint AND frame=p_frame AND source_metadata->'validRange'='true'::jsonb
 ),live AS MATERIALIZED(
  SELECT r.* FROM captured h CROSS JOIN LATERAL public.counterparty_report_capture_rows((h.frame->>'payeeId')::uuid,(h.frame->>'from')::date,(h.frame->>'through')::date,p_scopes,NULL,NULL,NULL,NULL,1,
   CASE WHEN h.frame ? 'currencyIds' THEN ARRAY(SELECT jsonb_array_elements_text(h.frame->'currencyIds')::uuid) ELSE NULL END,true) r
 )
 SELECT EXISTS(SELECT 1 FROM live WHERE section=0 AND payload->'denied'='0'::jsonb AND payload->'unknown'='0'::jsonb AND payload->>'sourceFingerprint' IS NOT NULL AND payload->'validRange'='true'::jsonb)
 AND NOT EXISTS(
  SELECT r.payload FROM public.counterparty_report_capture_rows r JOIN captured h ON h.academy_id=r.academy_id AND h.job_id=r.job_id WHERE r.section=4
  EXCEPT ALL SELECT payload FROM live WHERE section=4
 );
$$;
GRANT CREATE ON SCHEMA public TO kavosh_report_capture_policy;
ALTER FUNCTION public.counterparty_report_capture_allows(uuid,text,jsonb,jsonb) OWNER TO kavosh_report_capture_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_report_capture_policy;
REVOKE ALL ON FUNCTION public.counterparty_report_capture_allows(uuid,text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.counterparty_report_capture_allows(uuid,text,jsonb,jsonb) TO kavosh_runtime,kavosh_automation_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 285 $$;

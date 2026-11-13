-- Retained learning revisions share the existing owner/MFA/purpose boundary.
-- Byte-bounded prefix paging keeps large attendance histories complete without
-- building an unbounded response or silently skipping oversized editions.
GRANT SELECT(academy_id,session_id,version,definition,recorded_at) ON public.session_report_revisions,public.session_attendance_revisions TO kavosh_platform_policy;
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('platform_private.read_learning_session(uuid,uuid,jsonb)'::regprocedure);
 needle='purpose text;data jsonb;BEGIN';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'LEARNING_HISTORY_DECLARATION_CHANGED';END IF;
 body=replace(body,needle,'purpose text;data jsonb;record_kind text;page_limit integer:=5;after_version integer:=0;next_version integer;has_more boolean;BEGIN');
 needle='p_input-''academyId''-''sessionId''-''purpose''';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'LEARNING_HISTORY_INPUT_CHANGED';END IF;
 body=replace(body,needle,needle||'-''record''-''limit''-''afterVersion''');
 needle=' -- The session and both current records share one native statement snapshot.';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'LEARNING_HISTORY_CONTEXT_CHANGED';END IF;
 EXECUTE replace(body,needle,$history$
 IF p_input?'record' THEN
  IF jsonb_typeof(p_input->'record') IS DISTINCT FROM 'string' OR p_input->>'record' NOT IN('report','attendance') THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  record_kind=p_input->>'record';
  IF p_input?'limit' THEN
   IF jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^[1-5]$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;page_limit=(p_input->>'limit')::integer;
  END IF;
  IF p_input?'afterVersion' THEN
   IF jsonb_typeof(p_input->'afterVersion') IS DISTINCT FROM 'number' OR p_input->>'afterVersion'!~'^(0|[1-9][0-9]{0,9})$' OR(p_input->>'afterVersion')::numeric>2147483647 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;after_version=(p_input->>'afterVersion')::integer;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.class_sessions WHERE academy_id=school AND id=target) THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
  WITH selected AS MATERIALIZED(
   SELECT version,definition,recorded_at FROM public.session_report_revisions WHERE academy_id=school AND session_id=target AND record_kind='report' AND version>after_version
   UNION ALL SELECT version,definition,recorded_at FROM public.session_attendance_revisions WHERE academy_id=school AND session_id=target AND record_kind='attendance' AND version>after_version
   ORDER BY version LIMIT page_limit+1),
  budget AS(SELECT *,row_number() OVER(ORDER BY version) position,sum(octet_length(definition::text)+256) OVER(ORDER BY version) bytes FROM selected)
  SELECT coalesce(jsonb_agg(jsonb_build_object('version',version,'recordedAt',recorded_at,'definition',definition) ORDER BY version) FILTER(WHERE position<=page_limit AND bytes<=1047552),'[]'::jsonb),
   count(*)>count(*) FILTER(WHERE position<=page_limit AND bytes<=1047552) INTO data,has_more FROM budget;
  IF has_more AND jsonb_array_length(data)=0 THEN RAISE EXCEPTION 'PLATFORM_LEARNING_RECORD_TOO_LARGE' USING ERRCODE='54000';END IF;
  IF has_more THEN next_version=(data->(jsonb_array_length(data)-1)->>'version')::integer;END IF;
  IF octet_length(data::text)>1047552 THEN RAISE EXCEPTION 'PLATFORM_LEARNING_RECORD_TOO_LARGE' USING ERRCODE='54000';END IF;
  INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data,reason)
  VALUES(p_user,p_session,'platform.academy.learning-history.read',school,jsonb_build_object('sessionId',target,'record',record_kind,'rows',jsonb_array_length(data),'hasMore',has_more,'scope','platform_owner_read_only'),purpose);
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('academyId',school,'sessionId',target,'record',record_kind,'data',data,'nextVersion',next_version,'scope','platform_owner_read_only','projection','retained_internal_learning_revisions_not_current_clearance'));
 END IF;
 IF p_input?'limit' OR p_input?'afterVersion' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
$history$||needle);
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 needle='IF p_operation=''academies.learning-session'' THEN';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'LEARNING_HISTORY_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,needle,$gateway$
 IF p_operation IN('academies.learning-session','academies.learning-session-history') THEN
  IF(p_operation='academies.learning-session-history') IS DISTINCT FROM(p_input?'record') THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
$gateway$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 405 $$;

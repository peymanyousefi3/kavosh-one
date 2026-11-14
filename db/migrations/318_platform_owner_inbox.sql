CREATE FUNCTION platform_private.owner_inbox(p_user uuid,p_session uuid,p_operation text,p_key uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE target uuid;lim integer;cursor_time timestamptz;cursor_id uuid;unread boolean;data jsonb;next_cursor jsonb;ack integer;fingerprint text;receipt record;result jsonb;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session,true);
 IF p_operation IS NULL OR p_operation NOT IN('notifications.list','notifications.mark-read') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 IF p_operation='notifications.mark-read' THEN
  IF p_key IS NULL OR p_input-ARRAY['notificationId']<>'{}'::jsonb OR jsonb_typeof(p_input->'notificationId') IS DISTINCT FROM 'string' OR p_input->>'notificationId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;target=(p_input->>'notificationId')::uuid;
  fingerprint=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));
  SELECT * INTO receipt FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
  IF FOUND THEN IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN receipt.result;END IF;
  IF NOT EXISTS(SELECT 1 FROM platform_private.owner_notifications WHERE owner_user_id=p_user AND id=target) THEN RAISE EXCEPTION 'PLATFORM_NOTIFICATION_NOT_FOUND' USING ERRCODE='P0002';END IF;
  INSERT INTO platform_private.owner_notification_reads(owner_user_id,notification_id) VALUES(p_user,target) ON CONFLICT DO NOTHING;
  SELECT jsonb_build_object('id',notification_id,'readAt',read_at) INTO data FROM platform_private.owner_notification_reads WHERE owner_user_id=p_user AND notification_id=target;
  IF data IS NULL THEN RAISE EXCEPTION 'PLATFORM_NOTICE_READ_MISSING' USING ERRCODE='XX000';END IF;
  result=jsonb_build_object('status',200,'body',jsonb_build_object('data',data,'cancellationPerformed',false));
  INSERT INTO platform_private.audit_events(actor_user_id,session_id,request_key,action,after_data) VALUES(p_user,p_session,p_key,'platform.notification.marked_read',data) RETURNING 1 INTO ack;
  IF ack IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'PLATFORM_NOTICE_READ_AUDIT_MISSING' USING ERRCODE='XX000';END IF;
  INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,result) RETURNING 1 INTO ack;
  IF ack IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'PLATFORM_NOTICE_READ_RECEIPT_MISSING' USING ERRCODE='XX000';END IF;RETURN result;
 END IF;
 IF p_input-ARRAY['limit','afterCreatedAt','afterId','unread']<>'{}'::jsonb OR(p_input?'limit' AND(jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^([1-9][0-9]?|100)$'))
 OR(p_input?'unread' AND jsonb_typeof(p_input->'unread') IS DISTINCT FROM 'boolean') OR(p_input?'afterCreatedAt')<>(p_input?'afterId') THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 lim=coalesce((p_input->>'limit')::integer,50);unread=(p_input->>'unread')::boolean;
 IF p_input?'afterId' THEN
  IF jsonb_typeof(p_input->'afterId') IS DISTINCT FROM 'string' OR p_input->>'afterId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(p_input->'afterCreatedAt') IS DISTINCT FROM 'string' OR p_input->>'afterCreatedAt'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  BEGIN cursor_time=(p_input->>'afterCreatedAt')::timestamptz;EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END;cursor_id=(p_input->>'afterId')::uuid;
 END IF;
 SELECT coalesce(jsonb_agg(entry ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO data FROM(
  SELECT n.id,n.created_at,jsonb_build_object('id',n.id,'kind',n.kind,'origin','mandatory','messageKey','platform.cancellation.'||n.kind,'createdAt',n.created_at,'eventAt',n.event_at,'readAt',rd.read_at,'cancellation',c.current_data,'academy',jsonb_build_object('id',a.id,'name',a.name),
   'sourceCurrent',CASE WHEN n.kind IN('requested','review_ready') THEN c.current_data->>'status'='pending' ELSE c.current_data->>'status'=n.kind END,
   'actionable',n.kind='review_ready' AND c.current_data->>'status'='pending') entry
  FROM platform_private.owner_notifications n JOIN platform_private.school_cancellation_cases c ON c.id=n.case_id JOIN public.academies a ON a.id=c.academy_id LEFT JOIN platform_private.owner_notification_reads rd ON rd.owner_user_id=n.owner_user_id AND rd.notification_id=n.id
  WHERE n.owner_user_id=p_user AND(unread IS NULL OR unread=(rd.notification_id IS NULL)) AND(cursor_time IS NULL OR(n.created_at,n.id)<(cursor_time,cursor_id)) ORDER BY n.created_at DESC,n.id DESC LIMIT lim+1
 )page;
 IF jsonb_array_length(data)>lim THEN next_cursor=jsonb_build_object('afterCreatedAt',data#>ARRAY[(lim-1)::text,'createdAt'],'afterId',data#>ARRAY[(lim-1)::text,'id']);data=data-lim;END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,after_data) VALUES(p_user,p_session,'platform.notifications.inbox.read',jsonb_build_object('rows',jsonb_array_length(data))) RETURNING 1 INTO ack;
 IF ack IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'PLATFORM_NOTICE_INBOX_AUDIT_MISSING' USING ERRCODE='XX000';END IF;
 RETURN jsonb_build_object('status',200,'body',jsonb_build_object('data',data,'nextCursor',next_cursor,'requiresOwnerConfirmation',true,'externalDeliveryVerified',false,'cancellationPerformed',false));
END $$;
REVOKE ALL ON FUNCTION platform_private.owner_inbox(uuid,uuid,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_private.owner_inbox(uuid,uuid,text,uuid,jsonb) TO kavosh_platform_policy;
DO $$ DECLARE d text;marker text:=' PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 d=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(d)-length(replace(d,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'PLATFORM_GATEWAY_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,marker,marker||E'\n IF p_operation IN(''notifications.list'',''notifications.mark-read'') THEN RETURN platform_private.owner_inbox(p_user,p_session,p_operation,p_key,p_input);END IF;');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 318 $$;

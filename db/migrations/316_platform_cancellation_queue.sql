-- One owner review queue across schools. This is a live bounded read,not an
-- automatic termination timer or permission to skip the original waiting clock.
CREATE INDEX school_cancellation_due_queue ON platform_private.school_cancellation_requests(review_after,id);
CREATE FUNCTION platform_private.cancellation_queue(p_user uuid,p_session uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE at_time timestamptz;school uuid;cursor_time timestamptz;cursor_id uuid;lim integer;readiness text;data jsonb;next_cursor jsonb;ack integer;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session,true);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384 OR p_input-ARRAY['limit','academyId','readiness','afterReviewAfter','afterId']<>'{}'::jsonb
 OR(p_input?'limit' AND(jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^([1-9][0-9]?|100)$'))
 OR(p_input?'readiness' AND(jsonb_typeof(p_input->'readiness') IS DISTINCT FROM 'string' OR p_input->>'readiness' NOT IN('all','waiting','ready')))
 OR(p_input?'afterReviewAfter')<>(p_input?'afterId') THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 lim=coalesce((p_input->>'limit')::integer,50);readiness=coalesce(p_input->>'readiness','all');
 IF p_input?'academyId' THEN
  IF jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;school=(p_input->>'academyId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=school) THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 END IF;
 IF p_input?'afterId' THEN
  IF jsonb_typeof(p_input->'afterId') IS DISTINCT FROM 'string' OR p_input->>'afterId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(p_input->'afterReviewAfter') IS DISTINCT FROM 'string' OR p_input->>'afterReviewAfter'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
  THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  BEGIN cursor_time=(p_input->>'afterReviewAfter')::timestamptz;EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END;cursor_id=(p_input->>'afterId')::uuid;
 END IF;
 at_time=clock_timestamp();
 SELECT coalesce(jsonb_agg(entry ORDER BY review_after,id),'[]'::jsonb) INTO data FROM(
  SELECT r.id,r.review_after,jsonb_build_object('cancellation',c.current_data,'academy',jsonb_build_object('id',a.id,'name',a.name,'operationalStatus',a.status,'effectiveStatus',public.effective_academy_status(a.status,a.subscription_terms),'subscriptionVersion',a.subscription_version),'reviewReady',r.review_after<=at_time) entry
  FROM platform_private.school_cancellation_requests r JOIN public.academies a ON a.id=r.academy_id JOIN platform_private.school_cancellation_cases c ON c.id=r.id
  WHERE NOT EXISTS(SELECT 1 FROM platform_private.school_cancellation_decisions d WHERE d.request_id=r.id)
  AND(school IS NULL OR r.academy_id=school) AND(readiness='all' OR(readiness='ready' AND r.review_after<=at_time) OR(readiness='waiting' AND r.review_after>at_time))
  AND(cursor_time IS NULL OR(r.review_after,r.id)>(cursor_time,cursor_id)) ORDER BY r.review_after,r.id LIMIT lim+1
 )page;
 IF jsonb_array_length(data)>lim THEN next_cursor=jsonb_build_object('afterReviewAfter',data#>ARRAY[(lim-1)::text,'cancellation','reviewAfter'],'afterId',data#>ARRAY[(lim-1)::text,'cancellation','id']);data=data-lim;END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data)
  VALUES(p_user,p_session,'platform.subscription.cancellations.queue.read',school,jsonb_build_object('rows',jsonb_array_length(data),'readiness',readiness)) RETURNING 1 INTO ack;
 IF ack IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_QUEUE_AUDIT_MISSING' USING ERRCODE='XX000';END IF;
 RETURN jsonb_build_object('status',200,'body',jsonb_build_object('data',data,'nextCursor',next_cursor,'asOf',at_time,'liveQueue',true,'requiresOwnerConfirmation',true,'cancellationPerformed',false,'deletionPerformed',false,'chargesPerformed',false));
END $$;
REVOKE ALL ON FUNCTION platform_private.cancellation_queue(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_private.cancellation_queue(uuid,uuid,jsonb) TO kavosh_platform_policy;
DO $$ DECLARE d text;marker text:=' PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 d=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(d)-length(replace(d,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'PLATFORM_GATEWAY_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,marker,marker||E'\n IF p_operation=''cancellations.queue'' THEN RETURN platform_private.cancellation_queue(p_user,p_session,p_input);END IF;');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 316 $$;

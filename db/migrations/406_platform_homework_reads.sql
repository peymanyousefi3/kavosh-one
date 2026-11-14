-- Read-only owner oversight,not family publication or student impersonation.
GRANT SELECT(academy_id,id,session_id,class_id,hub_id,version,session_version,state,document,recipients,due_at,accept_late,context,assignment_id,assignment_version,recorded_by,created_by,changed_by,approval_id,reason,created_at,changed_at) ON public.homeworks TO kavosh_platform_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
CREATE FUNCTION platform_private.read_homework(p_user uuid,p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE school uuid;target uuid;purpose text;detail boolean;page_limit integer:=10;after_id uuid;next_id uuid;data jsonb;BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>4096 OR(p_input-'academyId'-'purpose'-'sessionId'-'homeworkId'-'limit'-'after')<>'{}'::jsonb
 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'purpose') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'purpose')) NOT BETWEEN 1 AND 500 OR(p_input->>'purpose')~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 detail=p_input?'homeworkId';
 IF detail THEN
  IF p_input?'sessionId' OR p_input?'limit' OR p_input?'after' OR jsonb_typeof(p_input->'homeworkId') IS DISTINCT FROM 'string' OR p_input->>'homeworkId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  target=(p_input->>'homeworkId')::uuid;
 ELSE
  IF jsonb_typeof(p_input->'sessionId') IS DISTINCT FROM 'string' OR p_input->>'sessionId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  target=(p_input->>'sessionId')::uuid;
  IF p_input?'limit' THEN
   IF jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^[1-9][0-9]?$' OR(p_input->>'limit')::integer>20 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;page_limit=(p_input->>'limit')::integer;
  END IF;
  IF p_input?'after' THEN
   IF jsonb_typeof(p_input->'after') IS DISTINCT FROM 'string' OR p_input->>'after'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;after_id=(p_input->>'after')::uuid;
  END IF;
 END IF;
 school=(p_input->>'academyId')::uuid;purpose=btrim(p_input->>'purpose');
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=school) THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 PERFORM set_config('app.academy_id',school::text,true);
 IF detail THEN
  SELECT jsonb_build_object('id',h.id,'sessionId',h.session_id,'classId',h.class_id,'hubId',h.hub_id,'version',h.version,'sessionVersion',h.session_version,'state',h.state,
   'document',h.document,'recipients',h.recipients,'dueAt',h.due_at,'acceptLate',h.accept_late,'context',h.context,'assignmentId',h.assignment_id,'assignmentVersion',h.assignment_version,
   'recordedBy',h.recorded_by,'createdBy',h.created_by,'changedBy',h.changed_by,'approvalId',h.approval_id,'reason',h.reason,'createdAt',h.created_at,'changedAt',h.changed_at,
   'currentSession',jsonb_build_object('version',s.version,'status',s.status,'startsAt',s.starts_at,'endsAt',s.ends_at)) INTO data
   FROM public.homeworks h JOIN public.class_sessions s ON s.academy_id=h.academy_id AND s.id=h.session_id WHERE h.academy_id=school AND h.id=target;
  IF data IS NULL THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.class_sessions WHERE academy_id=school AND id=target) THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO data FROM(SELECT id,session_id AS "sessionId",class_id AS "classId",hub_id AS "hubId",version,session_version AS "sessionVersion",state,document->>'title' title,due_at AS "dueAt",accept_late AS "acceptLate" FROM public.homeworks WHERE academy_id=school AND session_id=target AND(after_id IS NULL OR id>after_id) ORDER BY id LIMIT page_limit+1)r;
  IF jsonb_array_length(data)>page_limit THEN next_id=(data->(page_limit-1)->>'id')::uuid;data=data-page_limit;END IF;
 END IF;
 IF octet_length(data::text)>2097152 THEN RAISE EXCEPTION 'PLATFORM_HOMEWORK_RECORD_TOO_LARGE' USING ERRCODE='54000';END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data,reason)
 VALUES(p_user,p_session,CASE WHEN detail THEN 'platform.academy.homework.read' ELSE 'platform.academy.homeworks.read' END,school,jsonb_build_object('targetId',target,'detail',detail,'rows',CASE WHEN detail THEN 1 ELSE jsonb_array_length(data) END,'hasMore',next_id IS NOT NULL,'scope','platform_owner_read_only'),purpose);
 RETURN jsonb_build_object('status',200,'body',jsonb_build_object('academyId',school,'data',data,'nextCursor',next_id,'scope','platform_owner_read_only','projection','current_internal_homework_not_family_publication_or_binary_access'));
END $$;
ALTER FUNCTION platform_private.read_homework(uuid,uuid,jsonb) OWNER TO kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.read_homework(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
DO $$ DECLARE body text;needle text:='PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'HOMEWORK_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF p_operation IN('academies.homeworks','academies.homework') THEN
  IF p_key IS NOT NULL OR(p_operation='academies.homework') IS DISTINCT FROM(p_input?'homeworkId') THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  RETURN platform_private.read_homework(p_user,p_session,p_input);
 END IF;
$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 406 $$;

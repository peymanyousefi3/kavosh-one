-- One bounded internal session review,not family publication or admission/payroll
-- clearance. The ordinary platform service never receives direct table access.
GRANT SELECT(academy_id,session_id,version,session_version,entries,changed_by,changed_at,reason) ON public.session_attendance TO kavosh_platform_policy;
GRANT SELECT(academy_id,session_id,version,session_version,document,changed_by,changed_at,reason) ON public.session_reports TO kavosh_platform_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
CREATE FUNCTION platform_private.read_learning_session(p_user uuid,p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE school uuid;target uuid;purpose text;data jsonb;BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>4096 OR(p_input-'academyId'-'sessionId'-'purpose')<>'{}'::jsonb
 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'sessionId') IS DISTINCT FROM 'string' OR p_input->>'sessionId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'purpose') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'purpose')) NOT BETWEEN 1 AND 500 OR(p_input->>'purpose')~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 school=(p_input->>'academyId')::uuid;target=(p_input->>'sessionId')::uuid;purpose=btrim(p_input->>'purpose');
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=school) THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 PERFORM set_config('app.academy_id',school::text,true);
 -- The session and both current records share one native statement snapshot.
 SELECT jsonb_build_object('session',jsonb_build_object('id',s.id,'classId',s.class_id,'hubId',s.hub_id,'version',s.version,'startsAt',s.starts_at,'endsAt',s.ends_at,'status',s.status,'mode',s.mode,'timeZone',c.time_zone),
 'attendance',(SELECT jsonb_build_object('version',a.version,'sessionVersion',a.session_version,'entries',a.entries,'changedBy',a.changed_by,'changedAt',a.changed_at,'reason',a.reason) FROM public.session_attendance a WHERE a.academy_id=school AND a.session_id=s.id),
 'report',(SELECT jsonb_build_object('version',r.version,'sessionVersion',r.session_version,'document',r.document,'changedBy',r.changed_by,'changedAt',r.changed_at,'reason',r.reason) FROM public.session_reports r WHERE r.academy_id=school AND r.session_id=s.id)) INTO data
 FROM public.class_sessions s JOIN public.classes c ON c.academy_id=s.academy_id AND c.id=s.class_id WHERE s.academy_id=school AND s.id=target;
 IF data IS NULL THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF octet_length(data::text)>1048576 THEN RAISE EXCEPTION 'PLATFORM_LEARNING_RECORD_TOO_LARGE' USING ERRCODE='54000';END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data,reason)
 VALUES(p_user,p_session,'platform.academy.learning-session.read',school,jsonb_build_object('sessionId',target,'attendanceVersion',data#>'{attendance,version}','reportVersion',data#>'{report,version}','scope','platform_owner_read_only'),purpose);
 RETURN jsonb_build_object('status',200,'body',jsonb_build_object('academyId',school,'data',data,'scope','platform_owner_read_only','projection','current_internal_learning_records_not_publication_or_clearance'));
END $$;
ALTER FUNCTION platform_private.read_learning_session(uuid,uuid,jsonb) OWNER TO kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.read_learning_session(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
DO $$ DECLARE body text;needle text:='PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'LEARNING_SESSION_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF p_operation='academies.learning-session' THEN
  IF p_key IS NOT NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  RETURN platform_private.read_learning_session(p_user,p_session,p_input);
 END IF;
$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 404 $$;

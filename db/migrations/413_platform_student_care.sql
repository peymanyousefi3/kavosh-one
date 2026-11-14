-- Owner access is explicit,purpose-audited and read-only. Plaintext is never
-- stored in the platform database,audit trail or request/retry cache.
GRANT SELECT(academy_id,student_id,version) ON public.student_care_heads TO kavosh_platform_policy;
GRANT SELECT(academy_id,student_id,version,state,envelope,commitment,changed_by,approval_id,created_at) ON public.student_care_revisions TO kavosh_platform_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
CREATE FUNCTION platform_private.read_student_care(p_user uuid,p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE school uuid;target uuid;mode text;purpose text;data jsonb;selected_version integer;page_limit integer:=5;after_version integer:=0;next_version integer;has_more boolean:=false;BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>4096 OR(p_input-'academyId'-'studentId'-'mode'-'purpose'-'version'-'limit'-'afterVersion')<>'{}'::jsonb
 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'studentId') IS DISTINCT FROM 'string' OR p_input->>'studentId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'mode') IS DISTINCT FROM 'string' OR p_input->>'mode' NOT IN('current','history','reveal')
 OR jsonb_typeof(p_input->'purpose') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'purpose')) NOT BETWEEN 1 AND 500 OR(p_input->>'purpose')~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 school=(p_input->>'academyId')::uuid;target=(p_input->>'studentId')::uuid;mode=p_input->>'mode';purpose=btrim(p_input->>'purpose');
 IF(mode<>'history' AND(p_input?'limit' OR p_input?'afterVersion')) OR(mode<>'reveal' AND p_input?'version') THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 IF mode='reveal' THEN
  IF jsonb_typeof(p_input->'version') IS DISTINCT FROM 'number' OR p_input->>'version'!~'^[1-9][0-9]{0,9}$' OR(p_input->>'version')::numeric>2147483647 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;selected_version=(p_input->>'version')::integer;
 END IF;
 IF p_input?'limit' THEN
  IF jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^[1-5]$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;page_limit=(p_input->>'limit')::integer;
 END IF;
 IF p_input?'afterVersion' THEN
  IF jsonb_typeof(p_input->'afterVersion') IS DISTINCT FROM 'number' OR p_input->>'afterVersion'!~'^(0|[1-9][0-9]{0,9})$' OR(p_input->>'afterVersion')::numeric>2147483647 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;after_version=(p_input->>'afterVersion')::integer;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=school) THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 PERFORM set_config('app.academy_id',school::text,true);
 IF NOT EXISTS(SELECT 1 FROM public.student_profiles WHERE academy_id=school AND person_id=target) THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF mode='history' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('version',version,'state',state,'changedBy',changed_by,'approvalId',approval_id,'recordedAt',created_at) ORDER BY version),'[]'::jsonb) INTO data FROM(SELECT version,state,changed_by,approval_id,created_at FROM public.student_care_revisions WHERE academy_id=school AND student_id=target AND version>after_version ORDER BY version LIMIT page_limit+1)r;
  IF jsonb_array_length(data)>page_limit THEN has_more=true;next_version=(data->(page_limit-1)->>'version')::integer;data=data-page_limit;END IF;
 ELSE
  SELECT jsonb_build_object('studentId',target,'version',r.version,'state',r.state,'changedBy',r.changed_by,'approvalId',r.approval_id,'recordedAt',r.created_at)
   ||CASE WHEN mode='reveal' THEN jsonb_build_object('sealed',jsonb_build_object('expectedVersion',r.version-1,'state',r.state,'envelope',r.envelope,'commitment',r.commitment)) ELSE '{}'::jsonb END INTO data
  FROM public.student_care_revisions r WHERE r.academy_id=school AND r.student_id=target AND r.version=CASE WHEN mode='reveal' THEN selected_version ELSE(SELECT version FROM public.student_care_heads WHERE academy_id=school AND student_id=target)END;
  IF data IS NULL THEN
   IF mode='reveal' THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
   data=jsonb_build_object('studentId',target,'version',0,'state',NULL);
  END IF;
 END IF;
 IF octet_length(data::text)>65536 THEN RAISE EXCEPTION 'PLATFORM_CARE_RECORD_TOO_LARGE' USING ERRCODE='54000';END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data,reason)
 VALUES(p_user,p_session,'platform.academy.student-care.'||mode,school,jsonb_build_object('studentId',target,'version',CASE WHEN mode='reveal' THEN selected_version ELSE NULL END,'rows',CASE WHEN mode='history' THEN jsonb_array_length(data) ELSE 1 END,'hasMore',has_more,'severity',CASE WHEN mode='reveal' THEN 'critical' ELSE 'info' END,'privateContentRedacted',true,'scope','platform_owner_read_only'),purpose);
 RETURN jsonb_build_object('status',200,'body',jsonb_build_object('academyId',school,'studentId',target,'data',data,'nextVersion',next_version,'scope','platform_owner_read_only','privateFieldsIncluded',mode='reveal'));
END $$;
ALTER FUNCTION platform_private.read_student_care(uuid,uuid,jsonb) OWNER TO kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.read_student_care(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
DO $$ DECLARE body text;needle text:='PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'STUDENT_CARE_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF p_operation='academies.student-care' THEN
  IF p_key IS NOT NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  RETURN platform_private.read_student_care(p_user,p_session,p_input);
 END IF;
$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 413 $$;

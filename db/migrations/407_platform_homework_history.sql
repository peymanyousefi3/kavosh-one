-- Retained original homework editions,not a reconstructed publication history.
GRANT SELECT(academy_id,homework_id,version,definition,recorded_at) ON public.homework_revisions TO kavosh_platform_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
CREATE FUNCTION platform_private.read_homework_history(p_user uuid,p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE school uuid;target uuid;purpose text;page_limit integer:=5;after_version integer:=0;next_version integer;has_more boolean;data jsonb;BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>4096 OR(p_input-'academyId'-'homeworkId'-'purpose'-'limit'-'afterVersion')<>'{}'::jsonb
 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'homeworkId') IS DISTINCT FROM 'string' OR p_input->>'homeworkId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'purpose') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'purpose')) NOT BETWEEN 1 AND 500 OR(p_input->>'purpose')~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 IF p_input?'limit' THEN
  IF jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^[1-5]$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;page_limit=(p_input->>'limit')::integer;
 END IF;
 IF p_input?'afterVersion' THEN
  IF jsonb_typeof(p_input->'afterVersion') IS DISTINCT FROM 'number' OR p_input->>'afterVersion'!~'^(0|[1-9][0-9]{0,9})$' OR(p_input->>'afterVersion')::numeric>2147483647 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;after_version=(p_input->>'afterVersion')::integer;
 END IF;
 school=(p_input->>'academyId')::uuid;target=(p_input->>'homeworkId')::uuid;purpose=btrim(p_input->>'purpose');
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=school) THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 PERFORM set_config('app.academy_id',school::text,true);
 IF NOT EXISTS(SELECT 1 FROM public.homeworks WHERE academy_id=school AND id=target) THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
 WITH selected AS MATERIALIZED(SELECT version,definition,recorded_at FROM public.homework_revisions WHERE academy_id=school AND homework_id=target AND version>after_version ORDER BY version LIMIT page_limit+1),
 budget AS(SELECT *,row_number() OVER(ORDER BY version) position,sum(octet_length(definition::text)+256) OVER(ORDER BY version) bytes FROM selected)
 SELECT coalesce(jsonb_agg(jsonb_build_object('version',version,'recordedAt',recorded_at,'definition',definition) ORDER BY version) FILTER(WHERE position<=page_limit AND bytes<=2096128),'[]'::jsonb),count(*)>count(*) FILTER(WHERE position<=page_limit AND bytes<=2096128) INTO data,has_more FROM budget;
 IF has_more AND jsonb_array_length(data)=0 THEN RAISE EXCEPTION 'PLATFORM_HOMEWORK_RECORD_TOO_LARGE' USING ERRCODE='54000';END IF;
 IF has_more THEN next_version=(data->(jsonb_array_length(data)-1)->>'version')::integer;END IF;
 IF octet_length(data::text)>2096128 THEN RAISE EXCEPTION 'PLATFORM_HOMEWORK_RECORD_TOO_LARGE' USING ERRCODE='54000';END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data,reason)
 VALUES(p_user,p_session,'platform.academy.homework-history.read',school,jsonb_build_object('homeworkId',target,'rows',jsonb_array_length(data),'hasMore',has_more,'scope','platform_owner_read_only'),purpose);
 RETURN jsonb_build_object('status',200,'body',jsonb_build_object('academyId',school,'homeworkId',target,'data',data,'nextVersion',next_version,'scope','platform_owner_read_only','projection','retained_internal_homework_editions_not_current_family_clearance'));
END $$;
ALTER FUNCTION platform_private.read_homework_history(uuid,uuid,jsonb) OWNER TO kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.read_homework_history(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
DO $$ DECLARE body text;needle text:='PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'HOMEWORK_HISTORY_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF p_operation='academies.homework-history' THEN
  IF p_key IS NOT NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  RETURN platform_private.read_homework_history(p_user,p_session,p_input);
 END IF;
$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 407 $$;

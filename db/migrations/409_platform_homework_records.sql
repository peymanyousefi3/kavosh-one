-- Owner oversight of original editions,not publication or file-download grants.
GRANT SELECT(academy_id,id,homework_id,version) ON public.homework_submissions,public.homework_grades,public.homework_solutions TO kavosh_platform_policy;
GRANT SELECT(academy_id,submission_id,version,definition,recorded_at) ON public.homework_submission_revisions TO kavosh_platform_policy;
GRANT SELECT(academy_id,grade_id,version,definition,recorded_at) ON public.homework_grade_revisions TO kavosh_platform_policy;
GRANT SELECT(academy_id,solution_id,version,definition,recorded_at) ON public.homework_solution_revisions TO kavosh_platform_policy;
CREATE INDEX homework_grades_homework ON public.homework_grades(academy_id,homework_id,id);
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
CREATE FUNCTION platform_private.read_homework_records(p_user uuid,p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE school uuid;homework uuid;target uuid;purpose text;kind text;mode text;current_table text;revision_table text;record_column text;
 page_limit integer;after_id uuid;after_version integer:=0;next_id uuid;next_version integer;data jsonb;has_more boolean:=false;found_record boolean;BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>4096
 OR(p_input-'academyId'-'homeworkId'-'collection'-'mode'-'recordId'-'purpose'-'limit'-'after'-'afterVersion')<>'{}'::jsonb
 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'homeworkId') IS DISTINCT FROM 'string' OR p_input->>'homeworkId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'collection') IS DISTINCT FROM 'string' OR p_input->>'collection' NOT IN('submissions','grades','solutions')
 OR jsonb_typeof(p_input->'mode') IS DISTINCT FROM 'string' OR p_input->>'mode' NOT IN('list','detail','history')
 OR jsonb_typeof(p_input->'purpose') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'purpose')) NOT BETWEEN 1 AND 500 OR(p_input->>'purpose')~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 mode=p_input->>'mode';kind=p_input->>'collection';school=(p_input->>'academyId')::uuid;homework=(p_input->>'homeworkId')::uuid;purpose=btrim(p_input->>'purpose');page_limit=CASE WHEN mode='history' THEN 5 ELSE 10 END;
 IF mode='list' THEN
  IF p_input?'recordId' OR p_input?'afterVersion' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 ELSE
  IF jsonb_typeof(p_input->'recordId') IS DISTINCT FROM 'string' OR p_input->>'recordId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR p_input?'after'
  OR(mode='detail' AND(p_input?'limit' OR p_input?'afterVersion')) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;target=(p_input->>'recordId')::uuid;
 END IF;
 IF p_input?'limit' THEN
  IF jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^[1-9][0-9]?$' OR(p_input->>'limit')::integer>(CASE WHEN mode='history' THEN 5 ELSE 20 END) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;page_limit=(p_input->>'limit')::integer;
 END IF;
 IF p_input?'after' THEN
  IF jsonb_typeof(p_input->'after') IS DISTINCT FROM 'string' OR p_input->>'after'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;after_id=(p_input->>'after')::uuid;
 END IF;
 IF p_input?'afterVersion' THEN
  IF jsonb_typeof(p_input->'afterVersion') IS DISTINCT FROM 'number' OR p_input->>'afterVersion'!~'^(0|[1-9][0-9]{0,9})$' OR(p_input->>'afterVersion')::numeric>2147483647 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;after_version=(p_input->>'afterVersion')::integer;
 END IF;
 -- All dynamic identifiers below come ONLY from these fixed native mappings.
 CASE kind WHEN 'submissions' THEN current_table='homework_submissions';revision_table='homework_submission_revisions';record_column='submission_id';
 WHEN 'grades' THEN current_table='homework_grades';revision_table='homework_grade_revisions';record_column='grade_id';
 WHEN 'solutions' THEN current_table='homework_solutions';revision_table='homework_solution_revisions';record_column='solution_id';END CASE;
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=school) THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 PERFORM set_config('app.academy_id',school::text,true);
 IF NOT EXISTS(SELECT 1 FROM public.homeworks WHERE academy_id=school AND id=homework) THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF mode='list' THEN
  EXECUTE format($query$
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',h.id,'version',h.version,'homeworkVersion',r.definition->'homework_version','studentId',r.definition->'student_id','state',r.definition->'state','publishToFamily',r.definition->'publish_to_family','recordedAt',r.recorded_at) ORDER BY h.id),'[]'::jsonb)
   FROM(SELECT id,version FROM public.%I WHERE academy_id=$1 AND homework_id=$2 AND($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4)h
   JOIN public.%I r ON r.academy_id=$1 AND r.%I=h.id AND r.version=h.version
  $query$,current_table,revision_table,record_column) INTO data USING school,homework,after_id,page_limit+1;
  IF jsonb_array_length(data)>page_limit THEN has_more=true;next_id=(data->(page_limit-1)->>'id')::uuid;data=data-page_limit;END IF;
 ELSE
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE academy_id=$1 AND homework_id=$2 AND id=$3)',current_table) INTO found_record USING school,homework,target;
  IF NOT found_record THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
  IF mode='detail' THEN
   EXECUTE format('SELECT jsonb_build_object(''version'',r.version,''recordedAt'',r.recorded_at,''definition'',r.definition) FROM public.%I h JOIN public.%I r ON r.academy_id=h.academy_id AND r.%I=h.id AND r.version=h.version WHERE h.academy_id=$1 AND h.homework_id=$2 AND h.id=$3',current_table,revision_table,record_column) INTO data USING school,homework,target;
   IF data IS NULL THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
  ELSE
   EXECUTE format($query$
    WITH selected AS MATERIALIZED(SELECT version,definition,recorded_at FROM public.%I WHERE academy_id=$1 AND %I=$2 AND version>$3 ORDER BY version LIMIT $4),
    budget AS(SELECT *,row_number() OVER(ORDER BY version) position,sum(octet_length(definition::text)+256) OVER(ORDER BY version) bytes FROM selected)
    SELECT coalesce(jsonb_agg(jsonb_build_object('version',version,'recordedAt',recorded_at,'definition',definition) ORDER BY version) FILTER(WHERE position<=$5 AND bytes<=2096128),'[]'::jsonb),count(*)>count(*) FILTER(WHERE position<=$5 AND bytes<=2096128) FROM budget
   $query$,revision_table,record_column) INTO data,has_more USING school,target,after_version,page_limit+1,page_limit;
   IF has_more AND jsonb_array_length(data)=0 THEN RAISE EXCEPTION 'PLATFORM_HOMEWORK_RECORD_TOO_LARGE' USING ERRCODE='54000';END IF;
   IF has_more THEN next_version=(data->(jsonb_array_length(data)-1)->>'version')::integer;END IF;
  END IF;
 END IF;
 IF octet_length(data::text)>2096128 THEN RAISE EXCEPTION 'PLATFORM_HOMEWORK_RECORD_TOO_LARGE' USING ERRCODE='54000';END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data,reason)
 VALUES(p_user,p_session,'platform.academy.homework-records.read',school,jsonb_build_object('homeworkId',homework,'recordId',target,'collection',kind,'mode',mode,'rows',CASE WHEN mode='detail' THEN 1 ELSE jsonb_array_length(data) END,'hasMore',has_more,'scope','platform_owner_read_only'),purpose);
 RETURN jsonb_build_object('status',200,'body',jsonb_build_object('academyId',school,'homeworkId',homework,'collection',kind,'mode',mode,'data',data,'nextCursor',next_id,'nextVersion',next_version,'scope','platform_owner_read_only','projection','original_internal_editions_not_family_publication_or_binary_access'));
END $$;
ALTER FUNCTION platform_private.read_homework_records(uuid,uuid,jsonb) OWNER TO kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.read_homework_records(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
DO $$ DECLARE body text;needle text:='PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'HOMEWORK_RECORDS_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF p_operation='academies.homework-records' THEN
  IF p_key IS NOT NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  RETURN platform_private.read_homework_records(p_user,p_session,p_input);
 END IF;
$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 409 $$;

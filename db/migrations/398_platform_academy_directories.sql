-- Explicit read projections only. The ordinary platform connection retains no
-- direct business-table access; school identity, memberships and grants stay intact.
GRANT SELECT(academy_id,id,name,city,country_code,version,active) ON public.hubs TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,hub_id,code,name,active,version) ON public.courses TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,hub_id,course_id,course_version,name,code,time_zone,mode,active,version) ON public.classes TO kavosh_platform_policy;
GRANT SELECT(academy_id,person_id,legal_name,preferred_name,date_of_birth,shirt_size,recruiter_kind,recruiter_hub_id,recruiter_person_id,version) ON public.student_profiles TO kavosh_platform_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
CREATE FUNCTION platform_private.read_academy_directory(p_user uuid,p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE school uuid;collection text;purpose text;page_limit integer:=50;after_id uuid;next_id uuid;data jsonb;BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>4096 OR (p_input-'academyId'-'collection'-'purpose'-'limit'-'after')<>'{}'::jsonb
  OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(p_input->'collection') IS DISTINCT FROM 'string' OR p_input->>'collection' NOT IN('hubs','people','courses','classes','students')
  OR jsonb_typeof(p_input->'purpose') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'purpose')) NOT BETWEEN 1 AND 500 OR (p_input->>'purpose')~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 IF p_input?'limit' THEN
  IF jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^[1-9][0-9]{0,2}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  page_limit=(p_input->>'limit')::integer;IF page_limit>100 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 END IF;
 IF p_input?'after' THEN
  IF jsonb_typeof(p_input->'after') IS DISTINCT FROM 'string' OR p_input->>'after'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;after_id=(p_input->>'after')::uuid;
 END IF;
 school=(p_input->>'academyId')::uuid;collection=p_input->>'collection';purpose=btrim(p_input->>'purpose');
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=school) THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 -- Transaction-local RLS context plus an explicit academy predicate on every
 -- projection. No runtime-role impersonation or new permissive RLS policy.
 PERFORM set_config('app.academy_id',school::text,true);
 IF collection='hubs' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(SELECT id,name,city,country_code AS "countryCode",version,active FROM public.hubs WHERE academy_id=school AND(after_id IS NULL OR id>after_id) ORDER BY id LIMIT page_limit+1)r;
 ELSIF collection='people' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(SELECT id,kind,name,email,hub_id AS "hubId",status FROM public.people WHERE academy_id=school AND(after_id IS NULL OR id>after_id) ORDER BY id LIMIT page_limit+1)r;
 ELSIF collection='courses' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(SELECT id,hub_id AS "hubId",code,name,active,version FROM public.courses WHERE academy_id=school AND(after_id IS NULL OR id>after_id) ORDER BY id LIMIT page_limit+1)r;
 ELSIF collection='classes' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(SELECT id,hub_id AS "hubId",course_id AS "courseId",course_version AS "courseVersion",name,code,time_zone AS "timeZone",mode,active,version FROM public.classes WHERE academy_id=school AND(after_id IS NULL OR id>after_id) ORDER BY id LIMIT page_limit+1)r;
 ELSE
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(SELECT s.person_id AS id,p.hub_id AS "hubId",p.status,s.legal_name AS "legalName",s.preferred_name AS "preferredName",s.date_of_birth::text AS "dateOfBirth",s.shirt_size AS "shirtSize",s.recruiter_kind AS "recruiterKind",s.recruiter_hub_id AS "recruiterHubId",s.recruiter_person_id AS "recruiterPersonId",s.version FROM public.student_profiles s JOIN public.people p ON p.academy_id=s.academy_id AND p.id=s.person_id WHERE s.academy_id=school AND(after_id IS NULL OR s.person_id>after_id) ORDER BY s.person_id LIMIT page_limit+1)r;
 END IF;
 IF jsonb_array_length(data)>page_limit THEN next_id=(data->(page_limit-1)->>'id')::uuid;data=data-page_limit;END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data,reason)
  VALUES(p_user,p_session,'platform.academy.directory.read',school,jsonb_build_object('collection',collection,'rows',jsonb_array_length(data),'hasMore',next_id IS NOT NULL,'scope','platform_owner_read_only'),purpose);
 RETURN jsonb_build_object('status',200,'body',jsonb_build_object('academyId',school,'collection',collection,'data',data,'nextCursor',next_id,'scope','platform_owner_read_only','projection','directory_not_complete_business_export'));
END $$;
ALTER FUNCTION platform_private.read_academy_directory(uuid,uuid,jsonb) OWNER TO kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.read_academy_directory(uuid,uuid,jsonb) FROM PUBLIC;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
DO $$ DECLARE body text;needle text:='PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ACADEMY_DIRECTORY_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||$branch$
 IF p_operation='academies.directory' THEN
  IF p_key IS NOT NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  RETURN platform_private.read_academy_directory(p_user,p_session,p_input);
 END IF;
$branch$);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 398 $$;

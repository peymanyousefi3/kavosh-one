-- Extend the existing audited owner reader,not the ordinary service's table
-- authority. Enrollment periods are not attendance or signing eligibility.
GRANT SELECT(academy_id,id,class_id,hub_id,schedule_id,course_id,course_version,starts_at,ends_at,mode,online_url,status,version) ON public.class_sessions TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,class_id,person_id,role,starts_on,ends_on,active,version) ON public.class_staff TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,class_id,hub_id,student_id,student_profile_version,joins_on,leaves_on,enabled,version) ON public.class_enrollments TO kavosh_platform_policy;

DO $$ DECLARE body text;needle text;replacement text;BEGIN
 body=pg_get_functiondef('platform_private.read_academy_directory(uuid,uuid,jsonb)'::regprocedure);
 needle='data jsonb;BEGIN';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CLASS_DIRECTORY_DECLARATION_CHANGED';END IF;
 body=replace(body,needle,'data jsonb;class_filter uuid;BEGIN');
 needle='p_input-''academyId''-''collection''-''purpose''-''limit''-''after''';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CLASS_DIRECTORY_INPUT_CHANGED';END IF;
 body=replace(body,needle,needle||'-''classId''');
 needle='NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CLASS_DIRECTORY_COLLECTION_CHANGED';END IF;
 body=replace(body,needle,'NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'',''sessions'',''class-staff'',''enrollments'')');
 needle=' -- Transaction-local RLS context';
 replacement=$filter$
 IF p_input?'classId' THEN
  IF collection NOT IN('sessions','class-staff','enrollments') OR jsonb_typeof(p_input->'classId') IS DISTINCT FROM 'string'
   OR p_input->>'classId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  class_filter=(p_input->>'classId')::uuid;
 END IF;
$filter$||needle;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CLASS_DIRECTORY_CONTEXT_CHANGED';END IF;
 body=replace(body,needle,replacement);
 needle=' IF collection=''hubs'' THEN';
 replacement=$branch$
 IF class_filter IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.classes WHERE academy_id=school AND id=class_filter) THEN RAISE EXCEPTION 'PLATFORM_RECORD_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF collection='sessions' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(
   SELECT s.id,s.class_id AS "classId",s.hub_id AS "hubId",s.schedule_id AS "scheduleId",s.course_id AS "courseId",s.course_version AS "courseVersion",c.time_zone AS "timeZone",s.starts_at AS "startsAt",s.ends_at AS "endsAt",s.mode,s.online_url AS "onlineUrl",s.status,s.version
   FROM public.class_sessions s JOIN public.classes c ON c.academy_id=s.academy_id AND c.id=s.class_id
   WHERE s.academy_id=school AND(class_filter IS NULL OR s.class_id=class_filter) AND(after_id IS NULL OR s.id>after_id) ORDER BY s.id LIMIT page_limit+1)r;
 ELSIF collection='class-staff' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(
   SELECT s.id,s.class_id AS "classId",c.hub_id AS "hubId",s.person_id AS "personId",s.role,s.starts_on::text AS "startsOn",s.ends_on::text AS "endsOn",s.active,s.version
   FROM public.class_staff s JOIN public.classes c ON c.academy_id=s.academy_id AND c.id=s.class_id
   WHERE s.academy_id=school AND(class_filter IS NULL OR s.class_id=class_filter) AND(after_id IS NULL OR s.id>after_id) ORDER BY s.id LIMIT page_limit+1)r;
 ELSIF collection='enrollments' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO data FROM(
   SELECT e.id,e.class_id AS "classId",e.hub_id AS "hubId",e.student_id AS "studentId",e.student_profile_version AS "studentProfileVersion",e.joins_on::text AS "joinsOn",e.leaves_on::text AS "leavesOn",e.enabled,e.version
   FROM public.class_enrollments e WHERE e.academy_id=school AND(class_filter IS NULL OR e.class_id=class_filter) AND(after_id IS NULL OR e.id>after_id) ORDER BY e.id LIMIT page_limit+1)r;
 ELSIF collection='hubs' THEN$branch$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CLASS_DIRECTORY_PROJECTION_CHANGED';END IF;
 body=replace(body,needle,replacement);
 needle='jsonb_build_object(''collection'',collection,''rows''';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CLASS_DIRECTORY_AUDIT_CHANGED';END IF;
 EXECUTE replace(body,needle,'jsonb_build_object(''classId'',class_filter,''collection'',collection,''rows''');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 402 $$;

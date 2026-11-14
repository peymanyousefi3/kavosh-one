-- Reuse the existing MFA-owner gateway,purpose audit and tenant context.
-- Only the private policy function gains these explicit read columns. The
-- service connection gains no table access,school identity or write rights.
GRANT SELECT(academy_id,id,name,description,version,system_role) ON public.roles TO kavosh_platform_policy;
GRANT SELECT(academy_id,role_id,capability,effect) ON public.role_permissions TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,person_id,role_id,all_hubs) ON public.role_assignments TO kavosh_platform_policy;
GRANT SELECT(academy_id,assignment_id,hub_id) ON public.assignment_hubs TO kavosh_platform_policy;
GRANT SELECT(academy_id,assignment_id,class_id) ON public.assignment_classes TO kavosh_platform_policy;
GRANT SELECT(academy_id,assignment_id,person_id) ON public.assignment_people TO kavosh_platform_policy;
GRANT SELECT(academy_id,assignment_id,country_id) ON public.assignment_countries TO kavosh_platform_policy;
GRANT SELECT(academy_id,assignment_id,region_id) ON public.assignment_regions TO kavosh_platform_policy;
GRANT SELECT(academy_id,assignment_id,city_id) ON public.assignment_cities TO kavosh_platform_policy;

DO $$ DECLARE body text;needle text;replacement text;BEGIN
 body=pg_get_functiondef('platform_private.read_academy_directory(uuid,uuid,jsonb)'::regprocedure);
 needle='data jsonb;class_filter uuid;BEGIN';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ACCESS_DIRECTORY_DECLARATION_CHANGED';END IF;
 body=replace(body,needle,'data jsonb;class_filter uuid;overflow boolean:=false;BEGIN');
 needle='NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'',''sessions'',''class-staff'',''enrollments'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ACCESS_DIRECTORY_COLLECTION_CHANGED';END IF;
 body=replace(body,needle,'NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'',''sessions'',''class-staff'',''enrollments'',''roles'',''role-assignments'')');
 needle=' IF collection=''sessions'' THEN';
 replacement=$branch$
 IF collection='roles' THEN
  WITH page AS MATERIALIZED(
   SELECT r.id,r.name,r.description,r.version,r.system_role FROM public.roles r
   WHERE r.academy_id=school AND(after_id IS NULL OR r.id>after_id) ORDER BY r.id LIMIT page_limit+1
  ),stats AS MATERIALIZED(
   SELECT count(*)>20000 AS overflow FROM public.role_permissions p JOIN page r ON r.id=p.role_id WHERE p.academy_id=school
  ) SELECT stats.overflow,coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'description',r.description,'version',r.version,'systemRole',r.system_role,
   'permissions',coalesce((SELECT jsonb_agg(jsonb_build_object('capability',p.capability,'effect',p.effect) ORDER BY p.capability) FROM public.role_permissions p WHERE p.academy_id=school AND p.role_id=r.id),'[]'::jsonb)) ORDER BY r.id)
   FROM page r WHERE NOT stats.overflow),'[]'::jsonb) INTO overflow,data FROM stats;
 ELSIF collection='role-assignments' THEN
  WITH page AS MATERIALIZED(
   SELECT a.id,a.person_id,a.role_id,a.all_hubs FROM public.role_assignments a
   WHERE a.academy_id=school AND(after_id IS NULL OR a.id>after_id) ORDER BY a.id LIMIT page_limit+1
  ),stats AS MATERIALIZED(
   SELECT coalesce(sum(
    (SELECT count(*) FROM public.assignment_hubs x WHERE x.academy_id=school AND x.assignment_id=a.id)+
    (SELECT count(*) FROM public.assignment_classes x WHERE x.academy_id=school AND x.assignment_id=a.id)+
    (SELECT count(*) FROM public.assignment_people x WHERE x.academy_id=school AND x.assignment_id=a.id)+
    (SELECT count(*) FROM public.assignment_countries x WHERE x.academy_id=school AND x.assignment_id=a.id)+
    (SELECT count(*) FROM public.assignment_regions x WHERE x.academy_id=school AND x.assignment_id=a.id)+
    (SELECT count(*) FROM public.assignment_cities x WHERE x.academy_id=school AND x.assignment_id=a.id)),0)>20000 AS overflow FROM page a
  ) SELECT stats.overflow,coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'personId',a.person_id,'roleId',a.role_id,'allHubs',a.all_hubs,
   'hubIds',ARRAY(SELECT x.hub_id FROM public.assignment_hubs x WHERE x.academy_id=school AND x.assignment_id=a.id ORDER BY x.hub_id),
   'classIds',ARRAY(SELECT x.class_id FROM public.assignment_classes x WHERE x.academy_id=school AND x.assignment_id=a.id ORDER BY x.class_id),
   'personIds',ARRAY(SELECT x.person_id FROM public.assignment_people x WHERE x.academy_id=school AND x.assignment_id=a.id ORDER BY x.person_id),
   'countryIds',ARRAY(SELECT x.country_id FROM public.assignment_countries x WHERE x.academy_id=school AND x.assignment_id=a.id ORDER BY x.country_id),
   'regionIds',ARRAY(SELECT x.region_id FROM public.assignment_regions x WHERE x.academy_id=school AND x.assignment_id=a.id ORDER BY x.region_id),
   'cityIds',ARRAY(SELECT x.city_id FROM public.assignment_cities x WHERE x.academy_id=school AND x.assignment_id=a.id ORDER BY x.city_id)) ORDER BY a.id)
   FROM page a WHERE NOT stats.overflow),'[]'::jsonb) INTO overflow,data FROM stats;
 ELSIF collection='sessions' THEN$branch$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ACCESS_DIRECTORY_PROJECTION_CHANGED';END IF;
 body=replace(body,needle,replacement);
 needle=' IF jsonb_array_length(data)>page_limit THEN';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ACCESS_DIRECTORY_BUDGET_CHANGED';END IF;
 body=replace(body,needle,$budget$
 IF overflow OR octet_length(data::text)>2097152 THEN RAISE EXCEPTION 'PLATFORM_DIRECTORY_OUTPUT_LIMIT' USING ERRCODE='54000';END IF;
$budget$||needle);
 needle=' RETURN jsonb_build_object(''status'',200,''body'',jsonb_build_object(''academyId'',school,''collection'',collection';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ACCESS_DIRECTORY_AUDIT_CHANGED';END IF;
 body=replace(body,needle,$audit$
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_READ_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;
$audit$||needle);
 EXECUTE body;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 421 $$;

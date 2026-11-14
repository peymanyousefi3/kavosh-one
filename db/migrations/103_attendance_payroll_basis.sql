-- Observed presence is not signed-admission clearance. Missing/stale sheets
-- remain unknown, never a zero count. Existing retained preparations are untouched.
CREATE FUNCTION public.payroll_attendance_headcount(p_session uuid,p_session_version integer) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH sheet AS MATERIALIZED(
 SELECT a.version,a.session_version,a.entries,
 a.session_version=p_session_version AND a.context=public.session_attendance_source(p_session) AS is_current
 FROM public.session_attendance a WHERE a.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND a.session_id=p_session
 )
 SELECT coalesce((SELECT jsonb_build_object('version',version,'sessionVersion',session_version,'current',coalesce(is_current,false),
 'present',CASE WHEN is_current THEN(SELECT count(*)::integer FROM jsonb_array_elements(entries) x WHERE x->>'status' IN('present','late')) ELSE NULL END) FROM sheet),
 '{"version":null,"sessionVersion":null,"current":false,"present":null}'::jsonb)
$$;
REVOKE ALL ON FUNCTION public.payroll_attendance_headcount(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_attendance_headcount(uuid,integer) TO kavosh_runtime;

CREATE OR REPLACE FUNCTION public.payroll_preparation_source(p_person uuid,p_from date,p_through date,p_zone text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH bounds AS MATERIALIZED(SELECT p_from::timestamp AT TIME ZONE p_zone first,(p_through+1)::timestamp AT TIME ZONE p_zone last
 WHERE p_from BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' AND p_through BETWEEN p_from AND DATE '9999-12-31' AND p_through-p_from<=365),
 worker AS MATERIALIZED(SELECT id FROM public.people WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_person AND kind='human'),
 work AS MATERIALIZED(SELECT e.id,e.person_id,e.hub_id,e.version FROM public.work_engagements e JOIN worker w ON w.id=e.person_id WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid ORDER BY e.id LIMIT 201),
 terms AS MATERIALIZED(SELECT e.id engagement_id,e.person_id,r.version,r.effective_on::text,r.currency_id,c.code currency_code,r.unit_scale,
 (r.definition->>'active')::boolean active,r.definition->>'startsOn' starts_on,r.definition->>'endsOn' ends_on,r.definition->>'timeZone' time_zone,r.components
 FROM work e JOIN public.work_engagement_revisions r ON r.engagement_id=e.id AND r.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid
 JOIN public.finance_currencies c ON c.academy_id=r.academy_id AND c.id=r.currency_id
 ORDER BY e.id,r.effective_on,r.version LIMIT 1001),
 entries AS MATERIALIZED(SELECT t.id,t.version,t.person_id,t.hub_id,t.class_id,t.session_id,t.assignment_id,t.assignment_version,t.session_version,
 s.version current_session_version,s.status session_status,t.scheduled_start::text,t.scheduled_end::text,t.starts_at::text,t.ends_at::text,
 (t.scheduled_start AT TIME ZONE c.time_zone)::date::text enrollment_on,
 (SELECT count(*)::integer FROM public.class_enrollments e WHERE e.academy_id=t.academy_id AND e.class_id=t.class_id AND e.enabled AND e.joins_on<=(t.scheduled_start AT TIME ZONE c.time_zone)::date AND(e.leaves_on IS NULL OR e.leaves_on>=(t.scheduled_start AT TIME ZONE c.time_zone)::date)) enrolled,
 public.payroll_attendance_headcount(t.session_id,t.session_version) attendance,
 v.version evidence_version,v.decision evidence_decision,
 CASE WHEN v.session_id IS NOT NULL THEN v.source=public.session_evidence_review_source(t.session_id) ELSE false END evidence_current
 FROM public.session_time_entries t JOIN worker w ON w.id=t.person_id CROSS JOIN bounds b
 JOIN public.class_sessions s ON s.academy_id=t.academy_id AND s.id=t.session_id JOIN public.classes c ON c.academy_id=t.academy_id AND c.id=t.class_id
 LEFT JOIN public.session_evidence_reviews v ON v.academy_id=t.academy_id AND v.session_id=t.session_id
 -- Native time constraints cap entries at 24 elapsed hours, so this indexed
 -- lower bound preserves crossing-window work without scanning all history.
 WHERE t.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND t.starts_at>=b.first-interval '24 hours' AND t.starts_at<b.last AND t.ends_at>b.first ORDER BY t.starts_at,t.id LIMIT 201),
 periods AS MATERIALIZED(SELECT p.id,p.engagement_id,p.version,r.work_version,r.definition FROM public.work_pay_periods p JOIN work e ON e.id=p.engagement_id JOIN public.work_pay_period_revisions r ON r.academy_id=p.academy_id AND r.period_id=p.id AND r.version=p.version WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND(r.definition->>'from')::date<=p_through AND(r.definition->>'through')::date>=p_from ORDER BY p.id LIMIT 201),
 result AS(SELECT jsonb_build_object('sourceVersion',1,'personId',p_person,'from',p_from::text,'through',p_through::text,'timeZone',p_zone,
 'windowStartMilliseconds',(extract(epoch FROM bounds.first)*1000)::bigint::text,'windowEndMilliseconds',(extract(epoch FROM bounds.last)*1000)::bigint::text,
 'work',coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM work w),'[]'::jsonb),
 'terms',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY engagement_id,effective_on,version) FROM terms t),'[]'::jsonb),
 'entries',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY starts_at,id) FROM entries t),'[]'::jsonb),
 'periods',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM periods p),'[]'::jsonb),
 'oversized',(SELECT count(*)>200 FROM work) OR(SELECT count(*)>1000 FROM terms) OR(SELECT count(*)>200 FROM entries) OR(SELECT count(*)>200 FROM periods)) source FROM worker CROSS JOIN bounds)
 SELECT CASE WHEN octet_length(source::text)>2097152 THEN jsonb_build_object('oversized',true) ELSE source END FROM result
$$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$SELECT 103$$;


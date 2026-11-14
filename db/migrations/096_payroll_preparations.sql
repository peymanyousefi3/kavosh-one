INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payroll-preparations.view','View retained private payroll preparations','Finance',true,ARRAY['hub','person','country','region','city']),
 ('payroll-preparations.edit','Create retained payroll preparation drafts','Finance',true,ARRAY['hub','person','country','region','city']);
CREATE INDEX session_time_worker_start ON public.session_time_entries(academy_id,person_id,starts_at,id);
-- Observational preparations only: never a wage approval, accounting posting,
-- interval claim, payment or certification of earned/statutory entitlement.
CREATE FUNCTION public.payroll_preparation_source(p_person uuid,p_from date,p_through date,p_zone text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
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
CREATE TABLE public.payroll_preparations(
 academy_id uuid NOT NULL,id uuid NOT NULL,person_id uuid NOT NULL,label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 200),
 from_on date NOT NULL,through_on date NOT NULL,time_zone text NOT NULL,source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=2097152),
 created_by uuid NOT NULL,captured_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),
 CHECK(from_on BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' AND through_on BETWEEN from_on AND DATE '9999-12-31' AND through_on-from_on<=365)
);
CREATE INDEX payroll_preparations_person ON public.payroll_preparations(academy_id,person_id,id);
ALTER TABLE public.payroll_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_preparations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.payroll_preparations USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.payroll_preparations TO kavosh_runtime;
GRANT INSERT(academy_id,id,person_id,label,from_on,through_on,time_zone,source_snapshot,created_by) ON public.payroll_preparations TO kavosh_runtime;
CREATE FUNCTION public.guard_payroll_preparation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;BEGIN
 s=public.payroll_preparation_source(NEW.person_id,NEW.from_on,NEW.through_on,NEW.time_zone);
 IF s IS NULL OR s->'oversized' IS DISTINCT FROM 'false'::jsonb OR jsonb_array_length(s->'work')=0 OR NEW.source_snapshot IS DISTINCT FROM s THEN RAISE EXCEPTION 'PAYROLL_PREPARATION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 NEW.captured_at=statement_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payroll_preparation_source_guard BEFORE INSERT ON public.payroll_preparations FOR EACH ROW EXECUTE FUNCTION public.guard_payroll_preparation();
CREATE TRIGGER payroll_preparation_write BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_preparations FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write();
CREATE FUNCTION public.payroll_preparation_audit_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.id AND e.actor_id=NEW.created_by AND e.action='work.preparation.created' AND e.created_at=transaction_timestamp()
 AND e.changes=jsonb_build_object('severity','critical','sourceVersion',1,'status','prepared_draft','wagesAccrued',false)) THEN RAISE EXCEPTION 'PAYROLL_PREPARATION_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_preparation_audit_required AFTER INSERT ON public.payroll_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_preparation_audit_required();
-- Check both retained and current contexts, including newly added overlapping
-- work/time. A partial viewer must not silently price only the cheaper class.
CREATE FUNCTION public.payroll_preparation_allows(s jsonb,work_scopes jsonb,session_scopes jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH work_contexts AS(SELECT (w->>'hub_id')::uuid hub_id,(s->>'personId')::uuid person_id FROM jsonb_array_elements(s->'work') w
 UNION SELECT hub_id,person_id FROM public.work_engagements WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND person_id=(s->>'personId')::uuid),
 session_contexts AS(SELECT (e->>'class_id')::uuid class_id,(e->>'hub_id')::uuid hub_id FROM jsonb_array_elements(s->'entries') e
 UNION SELECT c.id,c.hub_id FROM public.classes c JOIN jsonb_array_elements(s->'entries') e ON c.id=(e->>'class_id')::uuid WHERE c.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid
 UNION SELECT c.id,c.hub_id FROM public.classes c JOIN public.session_time_entries t ON t.academy_id=c.academy_id AND t.class_id=c.id
 WHERE t.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND t.person_id=(s->>'personId')::uuid AND t.starts_at>=((s->>'from')::date::timestamp AT TIME ZONE(s->>'timeZone'))-interval '24 hours' AND t.starts_at<(((s->>'through')::date+1)::timestamp AT TIME ZONE(s->>'timeZone')) AND t.ends_at>((s->>'from')::date::timestamp AT TIME ZONE(s->>'timeZone')))
 SELECT jsonb_typeof(work_scopes)='array' AND jsonb_array_length(work_scopes)>0 AND jsonb_typeof(session_scopes)='array' AND jsonb_array_length(session_scopes)>0
 AND NOT EXISTS(SELECT 1 FROM work_contexts w CROSS JOIN jsonb_array_elements(work_scopes) p WHERE public.work_scope_allows(p,w.hub_id,w.person_id) IS NOT TRUE)
 AND NOT EXISTS(SELECT 1 FROM session_contexts c CROSS JOIN jsonb_array_elements(session_scopes) p WHERE public.scope_contains(p,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',c.class_id,'hubId',c.hub_id)))) IS NOT TRUE)
$$;
REVOKE ALL ON FUNCTION public.payroll_preparation_source(uuid,date,date,text),public.payroll_preparation_allows(jsonb,jsonb,jsonb),public.guard_payroll_preparation(),public.payroll_preparation_audit_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_preparation_source(uuid,date,date,text),public.payroll_preparation_allows(jsonb,jsonb,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 96 $$;

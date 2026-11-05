-- One native snapshot is shared by private operational reads and immutable
-- review dependencies; no duplicated JavaScript/native eligibility algorithm.
CREATE FUNCTION public.session_evidence_snapshot(p_session uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT to_jsonb(snapshot) FROM(WITH permitted AS MATERIALIZED(
 SELECT s.*,c.time_zone,c.version class_version,c.active class_active FROM public.class_sessions s JOIN public.classes c ON c.academy_id=s.academy_id AND c.id=s.class_id
 WHERE s.id=$1 AND s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid
),basis AS MATERIALIZED(
 SELECT s.*,public.session_attendance_source(s.id) attendance_source,a.version attendance_version,a.context attendance_context,jsonb_array_length(a.entries) attendance_entry_count,
 r.version report_version,r.context report_context,r.document,CASE WHEN r.version IS NOT NULL THEN public.session_report_source(s.id,r.document) END report_source,
 CASE WHEN r.version IS NOT NULL THEN public.session_report_source(s.id,jsonb_set(r.document,'{blocks}',coalesce((SELECT jsonb_agg(b ORDER BY n) FROM jsonb_array_elements(r.document->'blocks') WITH ORDINALITY blocks(b,n) WHERE b->>'kind'='text'),'[]'::jsonb))) END report_text_source
 FROM permitted s LEFT JOIN public.session_attendance a ON a.academy_id=s.academy_id AND a.session_id=s.id LEFT JOIN public.session_reports r ON r.academy_id=s.academy_id AND r.session_id=s.id
),expected AS MATERIALIZED(
 SELECT a.person_id,a.id,a.version,a.role FROM basis s JOIN public.class_staff a ON a.academy_id=s.academy_id AND a.class_id=s.class_id AND a.active
 AND a.starts_on<=(s.attendance_source->>'on')::date AND(a.ends_on IS NULL OR a.ends_on>=(s.attendance_source->>'on')::date)
),recorded AS MATERIALIZED(
 SELECT t.*,a.version current_assignment_version,a.active assignment_active FROM basis s JOIN public.session_time_entries t ON t.academy_id=s.academy_id AND t.session_id=s.id
 JOIN public.class_staff a ON a.academy_id=t.academy_id AND a.id=t.assignment_id
),staff AS MATERIALIZED(
 SELECT coalesce(e.person_id,t.person_id) AS "personId",e.id AS "assignmentId",e.version AS "assignmentVersion",e.role,e.id IS NOT NULL AS expected,t.id AS "entryId",t.version AS "entryVersion",t.session_version AS "sessionVersion",
 CASE WHEN t.id IS NOT NULL THEN t.assignment_version=t.current_assignment_version AND t.assignment_active END AS "assignmentCurrent",t.starts_at::text AS "startsAt",t.ends_at::text AS "endsAt",
 (extract(epoch FROM(t.ends_at-t.starts_at))*1000)::bigint::text AS "recordedMilliseconds",
 (extract(epoch FROM((t.ends_at-t.starts_at)-greatest(interval '0',least(t.ends_at,t.scheduled_end)-greatest(t.starts_at,t.scheduled_start))))*1000)::bigint::text AS "outsideScheduleMilliseconds"
 FROM expected e FULL JOIN recorded t ON t.person_id=e.person_id
)
SELECT s.id AS "sessionId",s.version AS "sessionVersion",s.class_id AS "classId",s.hub_id AS "hubId",s.status,s.class_active AS "classActive",s.starts_at::text AS "startsAt",s.ends_at::text AS "endsAt",s.starts_at<=statement_timestamp() AS "sessionStarted",s.ends_at<=statement_timestamp() AS "sessionEnded",s.attendance_source->>'on' AS on,s.time_zone AS "timeZone",statement_timestamp()::text AS "snapshotAt",
 (s.attendance_source IS NOT NULL AND coalesce(s.attendance_source->>'tooLarge','false')<>'true') AS "sourceValid",coalesce(s.attendance_source->>'tooLarge','false')='true' AS "rosterTooLarge",s.attendance_version AS "attendanceVersion",
 CASE WHEN s.attendance_version IS NOT NULL THEN s.attendance_context IS NOT DISTINCT FROM s.attendance_source END AS "attendanceCurrent",s.attendance_entry_count AS "attendanceEntryCount",s.report_version AS "reportVersion",
 CASE WHEN s.report_version IS NOT NULL THEN s.report_source IS NOT NULL AND s.report_context IS NOT DISTINCT FROM s.report_source END AS "reportCurrent",
 CASE WHEN s.report_version IS NOT NULL THEN s.report_text_source IS NOT NULL AND s.report_context->'session' IS NOT DISTINCT FROM s.report_text_source->'session' END AS "reportTextCurrent",
 EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s.document->'blocks','[]'::jsonb)) b WHERE b->>'kind'='text' AND length(btrim(b->>'text'))>0) AS "hasReportText",
 (SELECT count(*)::integer FROM jsonb_array_elements(coalesce(s.document->'blocks','[]'::jsonb)) b WHERE b->>'kind'='media') AS "mediaReferenceCount",
 jsonb_build_object(
 'session',encode(sha256(convert_to(jsonb_build_object('timeInfo',s.time_info,'classVersion',s.class_version,'classActive',s.class_active,'mode',s.mode,'onlineUrl',s.online_url)::text,'UTF8')),'hex'),
 'attendance',encode(sha256(convert_to(coalesce(s.attendance_source,'null'::jsonb)::text,'UTF8')),'hex'),
 'reportFiles',encode(sha256(convert_to(coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'version',f.version,'archived',f.archived) ORDER BY f.id) FROM jsonb_array_elements(coalesce(s.document->'blocks','[]'::jsonb)) b JOIN public.file_records f ON f.academy_id=s.academy_id AND f.id=(b->>'fileId')::uuid WHERE b->>'kind'='media'),'[]'::jsonb)::text,'UTF8')),'hex')
 ) AS "sourceDigests",
 (SELECT count(*)::integer FROM staff) AS "staffCount",coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY "personId") FROM(SELECT * FROM staff ORDER BY "personId" LIMIT 201) t),'[]'::jsonb) staff FROM basis s) snapshot
$$;
CREATE FUNCTION public.session_evidence_review_source(p_session uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT s-ARRAY['snapshotAt','sessionStarted','sessionEnded'] FROM public.session_evidence_snapshot(p_session) s
 WHERE s IS NOT NULL AND(s->>'staffCount')::integer<=200 AND s->>'rosterTooLarge'='false'
$$;
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('session-evidence.view','View private session evidence decisions and history','Learning',true,ARRAY['hub','class','country','region','city']),
 ('session-evidence.edit','Propose upper-reviewed session evidence decisions','Learning',true,ARRAY['hub','class','country','region','city']),
 ('session-evidence.override','Propose explicit session-only report/media requirement exceptions','Learning',true,ARRAY['hub','class','country','region','city']);
CREATE TABLE public.session_evidence_reviews(
 academy_id uuid NOT NULL,session_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 decision text NOT NULL CHECK(decision IN('accepted','needs_changes','rejected')),waive_report boolean NOT NULL,waive_media boolean NOT NULL,
 source jsonb NOT NULL CHECK(jsonb_typeof(source)='object' AND octet_length(source::text)<=262144),attendance_version integer,report_version integer,
 requested_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,session_id),FOREIGN KEY(academy_id,session_id,class_id,hub_id) REFERENCES public.class_sessions(academy_id,id,class_id,hub_id),
 FOREIGN KEY(academy_id,session_id,attendance_version) REFERENCES public.session_attendance_revisions(academy_id,session_id,version),
 FOREIGN KEY(academy_id,session_id,report_version) REFERENCES public.session_report_revisions(academy_id,session_id,version),
 FOREIGN KEY(academy_id,requested_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.session_evidence_review_revisions(
 academy_id uuid NOT NULL,session_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,session_id,version),FOREIGN KEY(academy_id,session_id) REFERENCES public.session_evidence_reviews(academy_id,session_id)
);
CREATE TABLE public.session_evidence_review_times(
 academy_id uuid NOT NULL,session_id uuid NOT NULL,review_version integer NOT NULL,entry_id uuid NOT NULL,entry_version integer NOT NULL,
 PRIMARY KEY(academy_id,session_id,review_version,entry_id),FOREIGN KEY(academy_id,entry_id,entry_version) REFERENCES public.session_time_revisions(academy_id,entry_id,version),
 FOREIGN KEY(academy_id,session_id,review_version) REFERENCES public.session_evidence_review_revisions(academy_id,session_id,version) DEFERRABLE INITIALLY DEFERRED
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['session_evidence_reviews','session_evidence_review_revisions','session_evidence_review_times'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,session_id,class_id,hub_id,decision,waive_report,waive_media,source,attendance_version,report_version,requested_by,changed_by,approval_id,reason) ON public.session_evidence_reviews TO kavosh_runtime;
GRANT UPDATE(version,decision,waive_report,waive_media,source,attendance_version,report_version,requested_by,changed_by,approval_id,reason) ON public.session_evidence_reviews TO kavosh_runtime;
GRANT INSERT(academy_id,session_id,version,definition) ON public.session_evidence_review_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,session_id,review_version,entry_id,entry_version) ON public.session_evidence_review_times TO kavosh_runtime;
CREATE FUNCTION public.session_evidence_accepts(s jsonb,p_report boolean,p_media boolean) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(s->>'sourceValid'='true' AND s->>'attendanceCurrent'='true'
 AND(p_report OR(s->>'reportTextCurrent'='true' AND s->>'hasReportText'='true'))
 AND(p_media OR(s->>'reportCurrent'='true' AND(s->>'mediaReferenceCount')::integer>0))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'staff') t WHERE t->>'expected'='true' AND t->>'entryId' IS NULL),false)
$$;
CREATE FUNCTION public.session_evidence_beneficiary(p_session uuid,p_person uuid,s jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'staff') t WHERE t->>'personId'=p_person::text)
 OR EXISTS(SELECT 1 FROM public.session_reports r WHERE r.session_id=p_session AND r.changed_by=p_person)
 OR EXISTS(SELECT 1 FROM public.session_attendance a WHERE a.session_id=p_session AND a.changed_by=p_person)
$$;
CREATE FUNCTION public.guard_session_evidence_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s jsonb;p record;previous jsonb;is_master boolean;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.session_id,NEW.class_id,NEW.hub_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.session_id,OLD.class_id,OLD.hub_id,OLD.created_at) THEN RAISE EXCEPTION 'SESSION_EVIDENCE_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;previous=to_jsonb(OLD);
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'SESSION_EVIDENCE_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 s=public.session_evidence_review_source(NEW.session_id);
 IF s IS NULL OR NEW.source IS DISTINCT FROM s OR(s->>'classId')::uuid IS DISTINCT FROM NEW.class_id OR(s->>'hubId')::uuid IS DISTINCT FROM NEW.hub_id
 OR(s->>'attendanceVersion')::integer IS DISTINCT FROM NEW.attendance_version OR(s->>'reportVersion')::integer IS DISTINCT FROM NEW.report_version THEN RAISE EXCEPTION 'SESSION_EVIDENCE_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NEW.decision='accepted' AND NOT public.session_evidence_accepts(s,NEW.waive_report,NEW.waive_media) THEN RAISE EXCEPTION 'SESSION_EVIDENCE_REQUIRED_INPUTS_MISSING' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.action<>'session-evidence.decide' OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.session_id OR p.target_version<>coalesce(OLD.version,0) OR p.privacy_capability IS DISTINCT FROM 'session-evidence.view'
 OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous,'source',s) OR NEW.requested_by IS DISTINCT FROM p.requester_id OR NOT public.report_comment_human_verified(NEW.changed_by)
 OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0) OR(p.payload->>'sessionId')::uuid IS DISTINCT FROM NEW.session_id
 OR p.payload->>'decision' IS DISTINCT FROM NEW.decision OR(p.payload->>'waiveReport')::boolean IS DISTINCT FROM NEW.waive_report OR(p.payload->>'waiveMedia')::boolean IS DISTINCT FROM NEW.waive_media OR p.payload->>'reason' IS DISTINCT FROM NEW.reason THEN RAISE EXCEPTION 'SESSION_EVIDENCE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT master_person_id=NEW.changed_by INTO is_master FROM public.academies WHERE id=NEW.academy_id;
 IF NOT coalesce(is_master,false) AND(NEW.changed_by=NEW.requested_by OR public.session_evidence_beneficiary(NEW.session_id,NEW.changed_by,s)) THEN RAISE EXCEPTION 'SESSION_EVIDENCE_BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.changed_at=clock_timestamp();IF TG_OP='INSERT' THEN NEW.created_at=NEW.changed_at;END IF;RETURN NEW;
END $$;
CREATE TRIGGER session_evidence_review_guard BEFORE INSERT OR UPDATE ON public.session_evidence_reviews FOR EACH ROW EXECUTE FUNCTION public.guard_session_evidence_review();
CREATE FUNCTION public.guard_session_evidence_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.session_evidence_reviews r WHERE r.academy_id=NEW.academy_id AND r.session_id=NEW.session_id AND r.version=NEW.version AND to_jsonb(r)=NEW.definition) THEN RAISE EXCEPTION 'SESSION_EVIDENCE_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER session_evidence_revision_guard BEFORE INSERT ON public.session_evidence_review_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_session_evidence_revision();
CREATE FUNCTION public.guard_session_evidence_time() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.session_evidence_reviews r CROSS JOIN LATERAL jsonb_array_elements(r.source->'staff') t WHERE r.academy_id=NEW.academy_id AND r.session_id=NEW.session_id AND r.version=NEW.review_version AND(t->>'entryId')::uuid=NEW.entry_id AND(t->>'entryVersion')::integer=NEW.entry_version) THEN RAISE EXCEPTION 'SESSION_EVIDENCE_EXACT_TIME_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER session_evidence_time_guard BEFORE INSERT ON public.session_evidence_review_times FOR EACH ROW EXECUTE FUNCTION public.guard_session_evidence_time();
CREATE FUNCTION public.require_session_evidence_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.source IS DISTINCT FROM public.session_evidence_review_source(NEW.session_id) THEN RAISE EXCEPTION 'SESSION_EVIDENCE_SOURCE_CHANGED_AT_COMMIT' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.session_evidence_review_revisions r WHERE r.academy_id=NEW.academy_id AND r.session_id=NEW.session_id AND r.version=NEW.version AND r.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'SESSION_EVIDENCE_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.source->'staff') t WHERE t->>'entryId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.session_evidence_review_times p WHERE p.academy_id=NEW.academy_id AND p.session_id=NEW.session_id AND p.review_version=NEW.version AND p.entry_id=(t->>'entryId')::uuid AND p.entry_version=(t->>'entryVersion')::integer)) THEN RAISE EXCEPTION 'SESSION_EVIDENCE_TIME_PINS_MISSING' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'SESSION_EVIDENCE_REVIEW_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER session_evidence_review_required AFTER INSERT OR UPDATE ON public.session_evidence_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_session_evidence_review();
CREATE FUNCTION public.session_evidence_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s jsonb;t jsonb;cap text;BEGIN
 SELECT jsonb_build_object('classId',class_id,'hubId',hub_id) INTO s FROM public.class_sessions WHERE academy_id=NEW.academy_id AND id=NEW.target_id;
 IF s IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 t=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',s->'classId','hubId',s->'hubId')));
 FOREACH cap IN ARRAY ARRAY['session-reports.view','attendance.view','rosters.view','session-time.view','staff.view','files.view'] LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',t));END LOOP;
 IF NEW.payload->>'waiveReport'='true' OR NEW.payload->>'waiveMedia'='true' OR EXISTS(SELECT 1 FROM public.session_evidence_reviews WHERE academy_id=NEW.academy_id AND session_id=NEW.target_id AND(waive_report OR waive_media)) THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','session-evidence.override','scope',t));END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_session_evidence_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='session-evidence.decide') EXECUTE FUNCTION public.session_evidence_privacy();
REVOKE ALL ON FUNCTION public.session_evidence_snapshot(uuid),public.session_evidence_review_source(uuid),public.session_evidence_accepts(jsonb,boolean,boolean),public.session_evidence_beneficiary(uuid,uuid,jsonb),public.guard_session_evidence_review(),public.guard_session_evidence_revision(),public.guard_session_evidence_time(),public.require_session_evidence_review(),public.session_evidence_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_evidence_snapshot(uuid),public.session_evidence_review_source(uuid),public.session_evidence_accepts(jsonb,boolean,boolean),public.session_evidence_beneficiary(uuid,uuid,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 88 $$;

INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('student-feedback.view','View selected private student session feedback and history','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('student-feedback.record','Propose feedback for own dated staff assignment','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('student-feedback.edit','Propose administrative student-feedback corrections','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('student-feedback.publish','Request or approve explicit family visibility; never peer visibility','Learning',true,ARRAY['hub','class','person','country','region','city']);
ALTER TABLE public.class_enrollments ADD CONSTRAINT feedback_enrollment_identity UNIQUE(academy_id,id,class_id,student_id);
CREATE TABLE public.student_feedback(
 academy_id uuid NOT NULL,id uuid NOT NULL,session_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,student_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),session_version integer NOT NULL CHECK(session_version>0),enrollment_id uuid NOT NULL,enrollment_version integer NOT NULL CHECK(enrollment_version>0),
 rubric_id uuid NOT NULL,rubric_version integer NOT NULL,ratings jsonb NOT NULL CHECK(jsonb_typeof(ratings)='array' AND jsonb_array_length(ratings) BETWEEN 1 AND 30),
 note text NOT NULL CHECK(length(btrim(note))>0 AND length(note)<=10000),publish_to_family boolean NOT NULL DEFAULT false,context jsonb NOT NULL,
 assignment_id uuid,assignment_version integer,recorded_by uuid NOT NULL,created_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,session_id,student_id),
 FOREIGN KEY(academy_id,session_id,class_id,hub_id) REFERENCES public.class_sessions(academy_id,id,class_id,hub_id),
 FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),
 FOREIGN KEY(academy_id,enrollment_id,class_id,student_id) REFERENCES public.class_enrollments(academy_id,id,class_id,student_id),
 FOREIGN KEY(academy_id,rubric_id,rubric_version) REFERENCES public.assessment_rubric_revisions(academy_id,rubric_id,version),
 FOREIGN KEY(academy_id,assignment_id,assignment_version) REFERENCES public.class_staff_revisions(academy_id,assignment_id,version),
 FOREIGN KEY(academy_id,recorded_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),CHECK((assignment_id IS NULL)=(assignment_version IS NULL))
);
CREATE INDEX student_feedback_student ON public.student_feedback(academy_id,student_id,id);
CREATE INDEX student_feedback_class ON public.student_feedback(academy_id,class_id,id);
CREATE TABLE public.student_feedback_revisions(
 academy_id uuid NOT NULL,feedback_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,feedback_id,version),FOREIGN KEY(academy_id,feedback_id) REFERENCES public.student_feedback(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['student_feedback','student_feedback_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,session_id,class_id,hub_id,student_id,session_version,enrollment_id,enrollment_version,rubric_id,rubric_version,ratings,note,publish_to_family,context,assignment_id,assignment_version,recorded_by,created_by,changed_by,approval_id,reason) ON public.student_feedback TO kavosh_runtime;
GRANT UPDATE(version,session_version,enrollment_id,enrollment_version,rubric_id,rubric_version,ratings,note,publish_to_family,context,assignment_id,assignment_version,recorded_by,changed_by,approval_id,reason) ON public.student_feedback TO kavosh_runtime;
GRANT INSERT(academy_id,feedback_id,version,definition) ON public.student_feedback_revisions TO kavosh_runtime;
CREATE FUNCTION public.student_feedback_source(p_session uuid,p_enrollment uuid,p_rubric uuid,p_version integer,p_assignment uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;s record;e record;r record;a record;student record;on_date date;BEGIN
 SELECT x.*,c.version AS class_version,c.active AS class_active,c.time_zone INTO s FROM public.class_sessions x JOIN public.classes c ON c.academy_id=x.academy_id AND c.id=x.class_id WHERE x.academy_id=tenant AND x.id=p_session;
 IF s.id IS NULL OR s.time_info->>'timeZone' IS DISTINCT FROM s.time_zone OR coalesce(s.time_info->>'localStart','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$' OR s.time_info->>'startOffset' IS NULL
 OR((s.time_info->>'localStart')||(s.time_info->>'startOffset'))::timestamptz IS DISTINCT FROM s.starts_at OR(s.time_info->>'start')::timestamptz IS DISTINCT FROM s.starts_at THEN RETURN NULL;END IF;
 on_date=left(s.time_info->>'localStart',10)::date;
 SELECT id,student_id,version,joins_on,leaves_on,enabled INTO e FROM public.class_enrollments WHERE academy_id=tenant AND id=p_enrollment AND class_id=s.class_id AND enabled AND joins_on<=on_date AND(leaves_on IS NULL OR leaves_on>=on_date);
 IF e.id IS NULL THEN RETURN NULL;END IF;
 SELECT id,hub_id,status INTO student FROM public.people WHERE academy_id=tenant AND id=e.student_id AND status='active';IF student.id IS NULL THEN RETURN NULL;END IF;
 SELECT x.id,x.hub_id,p_version AS version,x.version AS current_version,(x.definition->>'active')::boolean AS current_active,v.definition->'definition' AS definition INTO r
 FROM public.assessment_rubrics x JOIN public.assessment_rubric_revisions v ON v.academy_id=x.academy_id AND v.rubric_id=x.id AND v.version=p_version
 WHERE x.academy_id=tenant AND x.id=p_rubric AND(x.hub_id IS NULL OR x.hub_id=s.hub_id);
 IF r.id IS NULL THEN RETURN NULL;END IF;
 SELECT id,version,person_id,role,active,starts_on,ends_on INTO a FROM public.class_staff WHERE academy_id=tenant AND id=p_assignment AND class_id=s.class_id;
 IF p_assignment IS NOT NULL AND(a.id IS NULL OR NOT a.active OR a.starts_on>on_date OR(a.ends_on IS NOT NULL AND a.ends_on<on_date)) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('session',jsonb_build_object('id',s.id,'classId',s.class_id,'hubId',s.hub_id,'version',s.version,'classVersion',s.class_version,'classActive',s.class_active,'status',s.status,'startsAt',s.starts_at,'on',on_date,'timeZone',s.time_zone),
 'enrollment',to_jsonb(e),'student',to_jsonb(student),'rubric',to_jsonb(r),'assignment',CASE WHEN p_assignment IS NULL THEN 'null'::jsonb ELSE to_jsonb(a) END);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN RETURN NULL;
END $$;
CREATE FUNCTION public.feedback_ratings_valid(p_rubric jsonb,p_ratings jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE x jsonb;codes text[]:='{}';expected text[];BEGIN
 IF jsonb_typeof(p_ratings) IS DISTINCT FROM 'array' OR jsonb_typeof(p_rubric->'criteria') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(p_ratings) NOT BETWEEN 1 AND 30 THEN RETURN false;END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p_ratings) LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF(SELECT count(*) FROM jsonb_object_keys(x))<>2 OR jsonb_typeof(x->'code') IS DISTINCT FROM 'string' OR jsonb_typeof(x->'score') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
  IF(x->>'score')::numeric NOT BETWEEN 1 AND 5 OR trunc((x->>'score')::numeric)<>(x->>'score')::numeric OR x->>'code'=ANY(codes) THEN RETURN false;END IF;codes=array_append(codes,x->>'code');
 END LOOP;
 SELECT array_agg(value->>'code' ORDER BY value->>'code') INTO expected FROM jsonb_array_elements(p_rubric->'criteria');
 RETURN expected IS NOT DISTINCT FROM(SELECT array_agg(c ORDER BY c) FROM unnest(codes) c);
END $$;
CREATE FUNCTION public.guard_student_feedback() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;actual jsonb;current_record jsonb;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.session_id,NEW.class_id,NEW.hub_id,NEW.student_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.session_id,OLD.class_id,OLD.hub_id,OLD.student_id,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'FEEDBACK_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;
  current_record=to_jsonb(OLD);
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'FEEDBACK_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>coalesce(OLD.version,0) OR p.privacy_capability IS DISTINCT FROM 'student-feedback.view'
 OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'FEEDBACK_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF p.action='student-feedback.withdraw' THEN
  IF TG_OP<>'UPDATE' OR NOT OLD.publish_to_family OR NEW.publish_to_family OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM OLD.version OR(p.payload->>'feedbackId')::uuid IS DISTINCT FROM NEW.id
  OR ROW(NEW.session_version,NEW.enrollment_id,NEW.enrollment_version,NEW.rubric_id,NEW.rubric_version,NEW.ratings,NEW.note,NEW.context,NEW.assignment_id,NEW.assignment_version,NEW.recorded_by)
  IS DISTINCT FROM ROW(OLD.session_version,OLD.enrollment_id,OLD.enrollment_version,OLD.rubric_id,OLD.rubric_version,OLD.ratings,OLD.note,OLD.context,OLD.assignment_id,OLD.assignment_version,OLD.recorded_by)
  OR p.review_context IS DISTINCT FROM jsonb_build_object('record',current_record) THEN RAISE EXCEPTION 'FEEDBACK_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  IF p.action NOT IN('student-feedback.record','student-feedback.edit') THEN RAISE EXCEPTION 'FEEDBACK_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
  actual=public.student_feedback_source(NEW.session_id,NEW.enrollment_id,NEW.rubric_id,NEW.rubric_version,NEW.assignment_id);
  IF actual IS NULL OR NEW.context IS DISTINCT FROM jsonb_build_object('source',actual) OR p.review_context IS DISTINCT FROM jsonb_build_object('record',current_record,'source',actual)
  OR NEW.recorded_by IS DISTINCT FROM p.requester_id OR(TG_OP='INSERT' AND NEW.created_by IS DISTINCT FROM p.requester_id)
  OR(p.payload->>'sessionId')::uuid IS DISTINCT FROM NEW.session_id OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0)
  OR(p.payload->>'sessionVersion')::integer IS DISTINCT FROM NEW.session_version OR(p.payload->>'enrollmentId')::uuid IS DISTINCT FROM NEW.enrollment_id OR(p.payload->>'enrollmentVersion')::integer IS DISTINCT FROM NEW.enrollment_version
  OR(p.payload->>'rubricId')::uuid IS DISTINCT FROM NEW.rubric_id OR(p.payload->>'rubricVersion')::integer IS DISTINCT FROM NEW.rubric_version OR p.payload->'ratings' IS DISTINCT FROM NEW.ratings OR p.payload->>'note' IS DISTINCT FROM NEW.note OR(p.payload->>'publishToFamily')::boolean IS DISTINCT FROM NEW.publish_to_family
  OR(actual#>>'{session,version}')::integer IS DISTINCT FROM NEW.session_version OR(actual#>>'{enrollment,version}')::integer IS DISTINCT FROM NEW.enrollment_version OR(actual#>>'{enrollment,student_id}')::uuid IS DISTINCT FROM NEW.student_id
  OR(actual#>>'{session,startsAt}')::timestamptz>clock_timestamp() OR NOT public.feedback_ratings_valid(actual#>'{rubric,definition}',NEW.ratings) THEN RAISE EXCEPTION 'FEEDBACK_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF p.action='student-feedback.record' THEN
   IF p.requester_kind<>'human' OR NEW.assignment_id IS NULL OR(p.payload->>'assignmentId')::uuid IS DISTINCT FROM NEW.assignment_id OR(p.payload->>'assignmentVersion')::integer IS DISTINCT FROM NEW.assignment_version
   OR(actual#>>'{assignment,person_id}')::uuid IS DISTINCT FROM p.requester_id OR(actual#>>'{assignment,version}')::integer IS DISTINCT FROM NEW.assignment_version
   OR actual#>>'{session,status}'<>'scheduled' OR actual#>>'{session,classActive}'<>'true' OR actual#>>'{rubric,current_active}'<>'true' OR(actual#>>'{rubric,current_version}')::integer<>NEW.rubric_version THEN RAISE EXCEPTION 'FEEDBACK_STAFF_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  ELSE IF NEW.assignment_id IS NOT NULL OR NEW.assignment_version IS NOT NULL OR p.payload->'assignmentId' IS DISTINCT FROM 'null'::jsonb OR p.payload->'assignmentVersion' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'FEEDBACK_ADMIN_ASSIGNMENT_FORBIDDEN' USING ERRCODE='23514';END IF;END IF;
 END IF;
 NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER student_feedback_guard BEFORE INSERT OR UPDATE ON public.student_feedback FOR EACH ROW EXECUTE FUNCTION public.guard_student_feedback();
CREATE FUNCTION public.guard_feedback_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.student_feedback f WHERE f.academy_id=NEW.academy_id AND f.id=NEW.feedback_id AND f.version=NEW.version AND to_jsonb(f)=NEW.definition) THEN RAISE EXCEPTION 'FEEDBACK_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER feedback_revision_guard BEFORE INSERT ON public.student_feedback_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_feedback_revision();
CREATE FUNCTION public.require_feedback_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.student_feedback_revisions f WHERE f.academy_id=NEW.academy_id AND f.feedback_id=NEW.id AND f.version=NEW.version AND f.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'FEEDBACK_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'FEEDBACK_REVIEW_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER feedback_revision_required AFTER INSERT OR UPDATE ON public.student_feedback DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_feedback_revision();
REVOKE ALL ON FUNCTION public.student_feedback_source(uuid,uuid,uuid,integer,uuid),public.feedback_ratings_valid(jsonb,jsonb),public.guard_student_feedback(),public.guard_feedback_revision(),public.require_feedback_revision() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_feedback_source(uuid,uuid,uuid,integer,uuid),public.feedback_ratings_valid(jsonb,jsonb) TO kavosh_runtime;
CREATE FUNCTION public.student_feedback_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record;BEGIN
 IF NEW.action='student-feedback.withdraw' THEN
  SELECT class_id,hub_id,student_id INTO r FROM public.student_feedback WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND id=(NEW.payload->>'feedbackId')::uuid;
 ELSE
  SELECT s.class_id,s.hub_id,e.student_id INTO r FROM public.class_sessions s JOIN public.class_enrollments e ON e.academy_id=s.academy_id AND e.class_id=s.class_id
  WHERE s.academy_id=NEW.academy_id AND s.id=(NEW.payload->>'sessionId')::uuid AND e.id=(NEW.payload->>'enrollmentId')::uuid;
 END IF;
 IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','student-feedback.view','scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,
 'classes',jsonb_build_array(jsonb_build_object('id',r.class_id,'hubId',r.hub_id)),'people',jsonb_build_array(jsonb_build_object('id',r.student_id,'hubId',r.hub_id)),
 'recordContext',jsonb_build_object('classId',r.class_id,'hubId',r.hub_id,'studentId',r.student_id))));RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_student_feedback_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('student-feedback.record','student-feedback.edit','student-feedback.withdraw')) EXECUTE FUNCTION public.student_feedback_privacy();
REVOKE ALL ON FUNCTION public.student_feedback_privacy() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 76 $$;

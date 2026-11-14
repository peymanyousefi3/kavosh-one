INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('homework-grades.view','View selected private homework assessment records and history','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('homework-grades.record','Assigned human proposes a grade for an exact submitted answer revision','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('homework-grades.edit','Propose administrative initial grades and corrections','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('homework-grades.publish','Request or approve grade visibility to its own student family','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('received-grades.view','Read own or currently linked student published homework grades, not peers or private history','Learning',true,ARRAY['hub','person','country','region','city']);
ALTER TABLE public.homework_submissions ADD CONSTRAINT grade_submission_identity UNIQUE(academy_id,id,student_id,class_id,hub_id);
CREATE TABLE public.homework_grades(
 academy_id uuid NOT NULL,id uuid NOT NULL,submission_id uuid NOT NULL,submission_version integer NOT NULL,homework_id uuid NOT NULL,homework_version integer NOT NULL,
 student_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 score_units bigint NOT NULL CHECK(score_units BETWEEN 0 AND 9999999999),maximum_units bigint NOT NULL CHECK(maximum_units BETWEEN 1 AND 9999999999),CHECK(score_units<=maximum_units),
 note text NOT NULL CHECK(length(note)<=10000),publish_to_family boolean NOT NULL DEFAULT false,context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=65536),
 assignment_id uuid,assignment_version integer,graded_by uuid NOT NULL,created_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,submission_id,submission_version),
 FOREIGN KEY(academy_id,submission_id,student_id,class_id,hub_id) REFERENCES public.homework_submissions(academy_id,id,student_id,class_id,hub_id),
 FOREIGN KEY(academy_id,submission_id,submission_version) REFERENCES public.homework_submission_revisions(academy_id,submission_id,version),
 FOREIGN KEY(academy_id,homework_id,homework_version) REFERENCES public.homework_revisions(academy_id,homework_id,version),
 FOREIGN KEY(academy_id,assignment_id,assignment_version) REFERENCES public.class_staff_revisions(academy_id,assignment_id,version),CHECK((assignment_id IS NULL)=(assignment_version IS NULL)),
 FOREIGN KEY(academy_id,graded_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX homework_grades_student ON public.homework_grades(academy_id,student_id,homework_id,id);
CREATE INDEX homework_grades_class ON public.homework_grades(academy_id,class_id,id);
CREATE TABLE public.homework_grade_revisions(
 academy_id uuid NOT NULL,grade_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,grade_id,version),FOREIGN KEY(academy_id,grade_id) REFERENCES public.homework_grades(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['homework_grades','homework_grade_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,submission_id,submission_version,homework_id,homework_version,student_id,class_id,hub_id,score_units,maximum_units,note,publish_to_family,context,assignment_id,assignment_version,graded_by,created_by,changed_by,approval_id,reason) ON public.homework_grades TO kavosh_runtime;
GRANT UPDATE(version,score_units,maximum_units,note,publish_to_family,context,assignment_id,assignment_version,graded_by,changed_by,approval_id,reason) ON public.homework_grades TO kavosh_runtime;
GRANT INSERT(academy_id,grade_id,version,definition) ON public.homework_grade_revisions TO kavosh_runtime;
-- Source references immutable submitted work; private later drafts and later
-- instruction revisions neither overwrite it nor silently change its meaning.
CREATE FUNCTION public.homework_grade_source(p_submission uuid,p_version integer,p_assignment uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r jsonb;s record;a record;c record;on_date date;BEGIN
 SELECT definition INTO r FROM public.homework_submission_revisions WHERE academy_id=tenant AND submission_id=p_submission AND version=p_version AND state='submitted';IF r IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO s FROM public.homework_submissions WHERE academy_id=tenant AND id=p_submission;IF s.id IS NULL THEN RETURN NULL;END IF;
 SELECT id,version,active INTO c FROM public.classes WHERE academy_id=tenant AND id=s.class_id;IF c.id IS NULL THEN RETURN NULL;END IF;on_date=(r#>>'{context,homework,on}')::date;
 SELECT id,version,person_id,role,active,starts_on,ends_on INTO a FROM public.class_staff WHERE academy_id=tenant AND id=p_assignment AND class_id=s.class_id;
 IF p_assignment IS NOT NULL AND(a.id IS NULL OR NOT a.active OR a.starts_on>on_date OR(a.ends_on IS NOT NULL AND a.ends_on<on_date)) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('submission',jsonb_build_object('id',s.id,'version',p_version,'studentId',s.student_id,'homeworkId',(r->>'homework_id')::uuid,'homeworkVersion',(r->>'homework_version')::integer,'submittedAt',r->'submitted_at','isLate',r->'is_late'),
 'session',jsonb_build_object('id',r#>'{context,homework,sessionId}','classId',s.class_id,'hubId',s.hub_id,'on',on_date,'timeZone',r#>'{context,homework,timeZone}','classActive',c.active,'classVersion',c.version),
 'assignment',CASE WHEN p_assignment IS NULL THEN 'null'::jsonb ELSE to_jsonb(a) END);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
CREATE FUNCTION public.guard_homework_grade() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;actual jsonb;previous jsonb;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.submission_id,NEW.submission_version,NEW.homework_id,NEW.homework_version,NEW.student_id,NEW.class_id,NEW.hub_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.submission_id,OLD.submission_version,OLD.homework_id,OLD.homework_version,OLD.student_id,OLD.class_id,OLD.hub_id,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'GRADE_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;previous=to_jsonb(OLD);
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'GRADE_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>coalesce(OLD.version,0) OR p.privacy_capability IS DISTINCT FROM 'homework-grades.view' OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'GRADE_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF p.action='homework-grade.withdraw' THEN
  IF TG_OP<>'UPDATE' OR NOT OLD.publish_to_family OR NEW.publish_to_family OR(p.payload->>'gradeId')::uuid IS DISTINCT FROM NEW.id OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM OLD.version OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous)
   OR ROW(NEW.score_units,NEW.maximum_units,NEW.note,NEW.context,NEW.assignment_id,NEW.assignment_version,NEW.graded_by) IS DISTINCT FROM ROW(OLD.score_units,OLD.maximum_units,OLD.note,OLD.context,OLD.assignment_id,OLD.assignment_version,OLD.graded_by) THEN RAISE EXCEPTION 'GRADE_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  IF p.action NOT IN('homework-grade.record','homework-grade.edit') THEN RAISE EXCEPTION 'GRADE_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
  actual=public.homework_grade_source(NEW.submission_id,NEW.submission_version,NEW.assignment_id);
  IF actual IS NULL OR NEW.context IS DISTINCT FROM jsonb_build_object('source',actual) OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous,'source',actual)
   OR NEW.graded_by IS DISTINCT FROM p.requester_id OR(TG_OP='INSERT' AND NEW.created_by IS DISTINCT FROM p.requester_id)
   OR(p.payload->>'submissionId')::uuid IS DISTINCT FROM NEW.submission_id OR(p.payload->>'submissionVersion')::integer IS DISTINCT FROM NEW.submission_version OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0)
   OR(p.payload->>'score')::numeric*10000 IS DISTINCT FROM NEW.score_units::numeric OR(p.payload->>'maximum')::numeric*10000 IS DISTINCT FROM NEW.maximum_units::numeric OR p.payload->>'note' IS DISTINCT FROM NEW.note OR(p.payload->>'publishToFamily')::boolean IS DISTINCT FROM NEW.publish_to_family
   OR(actual#>>'{submission,studentId}')::uuid IS DISTINCT FROM NEW.student_id OR(actual#>>'{submission,homeworkId}')::uuid IS DISTINCT FROM NEW.homework_id OR(actual#>>'{submission,homeworkVersion}')::integer IS DISTINCT FROM NEW.homework_version OR(actual#>>'{session,classId}')::uuid IS DISTINCT FROM NEW.class_id OR(actual#>>'{session,hubId}')::uuid IS DISTINCT FROM NEW.hub_id THEN RAISE EXCEPTION 'GRADE_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF p.action='homework-grade.record' THEN
   IF p.requester_kind<>'human' OR NEW.assignment_id IS NULL OR(p.payload->>'assignmentId')::uuid IS DISTINCT FROM NEW.assignment_id OR(p.payload->>'assignmentVersion')::integer IS DISTINCT FROM NEW.assignment_version
    OR(actual#>>'{assignment,person_id}')::uuid IS DISTINCT FROM p.requester_id OR(actual#>>'{assignment,version}')::integer IS DISTINCT FROM NEW.assignment_version OR actual#>>'{session,classActive}' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'GRADE_STAFF_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  ELSE IF NEW.assignment_id IS NOT NULL OR NEW.assignment_version IS NOT NULL OR p.payload->'assignmentId' IS DISTINCT FROM 'null'::jsonb OR p.payload->'assignmentVersion' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'GRADE_ADMIN_ASSIGNMENT_FORBIDDEN' USING ERRCODE='23514';END IF;END IF;
 END IF;NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER homework_grade_guard BEFORE INSERT OR UPDATE ON public.homework_grades FOR EACH ROW EXECUTE FUNCTION public.guard_homework_grade();
CREATE FUNCTION public.guard_homework_grade_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.homework_grades g WHERE g.academy_id=NEW.academy_id AND g.id=NEW.grade_id AND g.version=NEW.version AND to_jsonb(g)=NEW.definition) THEN RAISE EXCEPTION 'GRADE_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER homework_grade_revision_guard BEFORE INSERT ON public.homework_grade_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_homework_grade_revision();
CREATE FUNCTION public.require_homework_grade_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.homework_grade_revisions g WHERE g.academy_id=NEW.academy_id AND g.grade_id=NEW.id AND g.version=NEW.version AND g.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'GRADE_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'GRADE_REVIEW_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER homework_grade_revision_required AFTER INSERT OR UPDATE ON public.homework_grades DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_homework_grade_revision();
CREATE FUNCTION public.homework_grade_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s record;BEGIN
 IF NEW.action='homework-grade.withdraw' THEN
  SELECT class_id,hub_id,student_id INTO s FROM public.homework_grades WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND id=(NEW.payload->>'gradeId')::uuid;
 ELSE SELECT class_id,hub_id,student_id INTO s FROM public.homework_submissions WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'submissionId')::uuid;END IF;
 IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','homework-submissions.view','scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,
 'classes',jsonb_build_array(jsonb_build_object('id',s.class_id,'hubId',s.hub_id)),'people',jsonb_build_array(jsonb_build_object('id',s.student_id,'hubId',s.hub_id)),'recordContext',jsonb_build_object('classId',s.class_id,'hubId',s.hub_id,'studentId',s.student_id))));RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_homework_grade_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('homework-grade.record','homework-grade.edit','homework-grade.withdraw')) EXECUTE FUNCTION public.homework_grade_privacy();
REVOKE ALL ON FUNCTION public.homework_grade_source(uuid,integer,uuid),public.guard_homework_grade(),public.guard_homework_grade_revision(),public.require_homework_grade_revision(),public.homework_grade_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.homework_grade_source(uuid,integer,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 79 $$;

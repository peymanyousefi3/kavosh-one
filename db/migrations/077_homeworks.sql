INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('homeworks.view','View private session homework definitions and history','Learning',true,ARRAY['hub','class','country','region','city']),
 ('homeworks.record','Propose homework for own dated staff assignment','Learning',true,ARRAY['hub','class','country','region','city']),
 ('homeworks.edit','Propose administrative homework changes and withdrawal','Learning',true,ARRAY['hub','class','country','region','city']),
 ('homeworks.publish','Request or approve family-visible homework','Learning',true,ARRAY['hub','class','country','region','city']),
 ('homework-recipients.view','Read selected homework recipient context, not student personal profiles','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('received-homework.view','Read own or currently linked student assigned homework, not solutions or peers','Learning',true,ARRAY['hub','person','country','region','city']);
CREATE FUNCTION public.homework_student_ids(p_context jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(array_agg((r->>'studentId')::uuid ORDER BY r->>'studentId'),'{}'::uuid[]) FROM jsonb_array_elements(p_context#>'{source,recipients}') r
$$;
CREATE TABLE public.homeworks(
 academy_id uuid NOT NULL,id uuid NOT NULL,session_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),session_version integer NOT NULL CHECK(session_version>0),state text NOT NULL CHECK(state IN('draft','published','withdrawn')),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object' AND octet_length(document::text)<=131072),recipients jsonb NOT NULL CHECK(jsonb_typeof(recipients)='array' AND jsonb_array_length(recipients)<=1000),
 due_at timestamptz,accept_late boolean NOT NULL,context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=1048576),
 recipient_ids uuid[] GENERATED ALWAYS AS(public.homework_student_ids(context)) STORED,
 assignment_id uuid,assignment_version integer,recorded_by uuid NOT NULL,created_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),
 FOREIGN KEY(academy_id,session_id,class_id,hub_id) REFERENCES public.class_sessions(academy_id,id,class_id,hub_id),
 FOREIGN KEY(academy_id,assignment_id,assignment_version) REFERENCES public.class_staff_revisions(academy_id,assignment_id,version),CHECK((assignment_id IS NULL)=(assignment_version IS NULL)),
 FOREIGN KEY(academy_id,recorded_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX homeworks_session ON public.homeworks(academy_id,session_id,id);
CREATE INDEX homeworks_class ON public.homeworks(academy_id,class_id,id);
CREATE INDEX homeworks_students ON public.homeworks USING gin(recipient_ids);
CREATE TABLE public.homework_revisions(
 academy_id uuid NOT NULL,homework_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,homework_id,version),FOREIGN KEY(academy_id,homework_id) REFERENCES public.homeworks(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['homeworks','homework_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,session_id,class_id,hub_id,session_version,state,document,recipients,due_at,accept_late,context,assignment_id,assignment_version,recorded_by,created_by,changed_by,approval_id,reason) ON public.homeworks TO kavosh_runtime;
GRANT UPDATE(version,session_version,state,document,recipients,due_at,accept_late,context,assignment_id,assignment_version,recorded_by,changed_by,approval_id,reason) ON public.homeworks TO kavosh_runtime;
GRANT INSERT(academy_id,homework_id,version,definition) ON public.homework_revisions TO kavosh_runtime;
CREATE FUNCTION public.homework_source(p_session uuid,p_document jsonb,p_recipients jsonb,p_assignment uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;s jsonb;x jsonb;e record;a record;members jsonb:='[]';seen uuid[]:='{}';on_date date;BEGIN
 s=public.session_report_source(p_session,p_document);IF s IS NULL OR jsonb_typeof(p_recipients) IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 IF jsonb_array_length(p_recipients)>1000 THEN RETURN NULL;END IF;on_date=(s#>>'{session,on}')::date;
 FOR x IN SELECT value FROM jsonb_array_elements(p_recipients) ORDER BY value->>'enrollmentId' LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' THEN RETURN NULL;END IF;
  IF(SELECT count(*) FROM jsonb_object_keys(x))<>2 OR jsonb_typeof(x->'enrollmentId') IS DISTINCT FROM 'string' OR jsonb_typeof(x->'enrollmentVersion') IS DISTINCT FROM 'number' THEN RETURN NULL;END IF;
  SELECT e0.id,e0.student_id,e0.version,e0.joins_on,e0.leaves_on,p.status INTO e FROM public.class_enrollments e0 JOIN public.people p ON p.academy_id=e0.academy_id AND p.id=e0.student_id
   WHERE e0.academy_id=tenant AND e0.id=(x->>'enrollmentId')::uuid AND e0.class_id=(s#>>'{session,classId}')::uuid AND e0.version=(x->>'enrollmentVersion')::numeric AND e0.enabled AND e0.joins_on<=on_date AND(e0.leaves_on IS NULL OR e0.leaves_on>=on_date) AND p.status='active';
  IF e.id IS NULL OR e.id=ANY(seen) THEN RETURN NULL;END IF;seen=array_append(seen,e.id);
  members=members||jsonb_build_array(jsonb_build_object('enrollmentId',e.id,'enrollmentVersion',e.version,'studentId',e.student_id,'joinsOn',e.joins_on,'leavesOn',e.leaves_on));
 END LOOP;
 SELECT id,version,person_id,role,active,starts_on,ends_on INTO a FROM public.class_staff WHERE academy_id=tenant AND id=p_assignment AND class_id=(s#>>'{session,classId}')::uuid;
 IF p_assignment IS NOT NULL AND(a.id IS NULL OR NOT a.active OR a.starts_on>on_date OR(a.ends_on IS NOT NULL AND a.ends_on<on_date)) THEN RETURN NULL;END IF;
 RETURN s||jsonb_build_object('recipients',members,'assignment',CASE WHEN p_assignment IS NULL THEN 'null'::jsonb ELSE to_jsonb(a) END);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
CREATE FUNCTION public.guard_homework() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;actual jsonb;previous jsonb;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.session_id,NEW.class_id,NEW.hub_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.session_id,OLD.class_id,OLD.hub_id,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'HOMEWORK_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;previous=to_jsonb(OLD);
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'HOMEWORK_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>coalesce(OLD.version,0) OR p.privacy_capability IS DISTINCT FROM 'homeworks.view' OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'HOMEWORK_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF p.action='homework.withdraw' THEN
  IF TG_OP<>'UPDATE' OR OLD.state<>'published' OR NEW.state<>'withdrawn' OR(p.payload->>'homeworkId')::uuid IS DISTINCT FROM NEW.id OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM OLD.version OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous)
   OR ROW(NEW.session_version,NEW.document,NEW.recipients,NEW.due_at,NEW.accept_late,NEW.context,NEW.assignment_id,NEW.assignment_version,NEW.recorded_by) IS DISTINCT FROM ROW(OLD.session_version,OLD.document,OLD.recipients,OLD.due_at,OLD.accept_late,OLD.context,OLD.assignment_id,OLD.assignment_version,OLD.recorded_by) THEN RAISE EXCEPTION 'HOMEWORK_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  IF p.action NOT IN('homework.record','homework.edit') OR NEW.state NOT IN('draft','published') THEN RAISE EXCEPTION 'HOMEWORK_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
  actual=public.homework_source(NEW.session_id,NEW.document,NEW.recipients,NEW.assignment_id);
  IF actual IS NULL OR NEW.context IS DISTINCT FROM jsonb_build_object('source',actual) OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous,'source',actual)
   OR NEW.recorded_by IS DISTINCT FROM p.requester_id OR(TG_OP='INSERT' AND NEW.created_by IS DISTINCT FROM p.requester_id)
   OR(p.payload->>'sessionId')::uuid IS DISTINCT FROM NEW.session_id OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0) OR(p.payload->>'sessionVersion')::integer IS DISTINCT FROM NEW.session_version
   OR p.payload->'document' IS DISTINCT FROM NEW.document OR p.payload->'recipients' IS DISTINCT FROM NEW.recipients OR p.payload->>'state' IS DISTINCT FROM NEW.state OR(p.payload->>'dueAt')::timestamptz IS DISTINCT FROM NEW.due_at OR(p.payload->>'acceptLate')::boolean IS DISTINCT FROM NEW.accept_late
   OR(actual#>>'{session,version}')::integer IS DISTINCT FROM NEW.session_version OR(actual#>>'{session,classId}')::uuid IS DISTINCT FROM NEW.class_id OR(actual#>>'{session,hubId}')::uuid IS DISTINCT FROM NEW.hub_id THEN RAISE EXCEPTION 'HOMEWORK_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF NEW.state='published' AND(jsonb_array_length(NEW.recipients)=0 OR actual#>>'{session,status}'<>'scheduled' OR actual#>>'{session,classActive}'<>'true' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.document->'blocks') b WHERE b->>'kind'='text')) THEN RAISE EXCEPTION 'HOMEWORK_PUBLICATION_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
  IF p.action='homework.record' THEN
   IF p.requester_kind<>'human' OR NEW.assignment_id IS NULL OR(p.payload->>'assignmentId')::uuid IS DISTINCT FROM NEW.assignment_id OR(p.payload->>'assignmentVersion')::integer IS DISTINCT FROM NEW.assignment_version
    OR(actual#>>'{assignment,person_id}')::uuid IS DISTINCT FROM p.requester_id OR(actual#>>'{assignment,version}')::integer IS DISTINCT FROM NEW.assignment_version OR actual#>>'{session,status}'<>'scheduled' OR actual#>>'{session,classActive}'<>'true' THEN RAISE EXCEPTION 'HOMEWORK_STAFF_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  ELSE IF NEW.assignment_id IS NOT NULL OR NEW.assignment_version IS NOT NULL OR p.payload->'assignmentId' IS DISTINCT FROM 'null'::jsonb OR p.payload->'assignmentVersion' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'HOMEWORK_ADMIN_ASSIGNMENT_FORBIDDEN' USING ERRCODE='23514';END IF;END IF;
 END IF;NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER homework_guard BEFORE INSERT OR UPDATE ON public.homeworks FOR EACH ROW EXECUTE FUNCTION public.guard_homework();
CREATE FUNCTION public.guard_homework_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.homeworks h WHERE h.academy_id=NEW.academy_id AND h.id=NEW.homework_id AND h.version=NEW.version AND to_jsonb(h)=NEW.definition) THEN RAISE EXCEPTION 'HOMEWORK_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER homework_revision_guard BEFORE INSERT ON public.homework_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_homework_revision();
CREATE FUNCTION public.require_homework_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.homework_revisions h WHERE h.academy_id=NEW.academy_id AND h.homework_id=NEW.id AND h.version=NEW.version AND h.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'HOMEWORK_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'HOMEWORK_REVIEW_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER homework_revision_required AFTER INSERT OR UPDATE ON public.homeworks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_homework_revision();
CREATE FUNCTION public.homework_private_bindings(p_record jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN count(*)=0 THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('capability','homework-recipients.view','studentRecords',jsonb_build_object('classId',p_record->'class_id','hubId',p_record->'hub_id','studentIds',jsonb_agg(r->'studentId')))) END
 FROM jsonb_array_elements(p_record#>'{context,source,recipients}') r
$$;
-- One bounded native binding retains every selected student without raising
-- the existing 64-binding limit or expanding a class grant to private profiles.
CREATE FUNCTION public.homework_recipients_allow(p_records jsonb,p_scope jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE student jsonb;c uuid;h uuid;sid uuid;BEGIN
 IF NOT public.approval_scope_nonempty(p_scope) THEN RETURN false;END IF;
 IF jsonb_typeof(p_records) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF(SELECT count(*) FROM jsonb_object_keys(p_records))<>3 OR jsonb_typeof(p_records->'studentIds') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(p_records->'studentIds') NOT BETWEEN 1 AND 1000 OR jsonb_typeof(p_records->'classId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_records->'hubId') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
 c=(p_records->>'classId')::uuid;h=(p_records->>'hubId')::uuid;
 FOR student IN SELECT value FROM jsonb_array_elements(p_records->'studentIds') LOOP
  IF jsonb_typeof(student) IS DISTINCT FROM 'string' THEN RETURN false;END IF;sid=(student#>>'{}')::uuid;
  IF public.scope_contains(p_scope,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',c,'hubId',h)),'people',jsonb_build_array(jsonb_build_object('id',sid,'hubId',h)),'recordContext',jsonb_build_object('classId',c,'hubId',h,'studentId',sid))) IS NOT TRUE THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION public.approval_bindings_allow(p_bindings jsonb,p_scopes jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE b jsonb;s jsonb;f record;domain_cap text;BEGIN
 IF jsonb_typeof(p_bindings) IS DISTINCT FROM 'array' OR jsonb_array_length(p_bindings)>64 THEN RETURN false;END IF;
 FOR b IN SELECT * FROM jsonb_array_elements(p_bindings) LOOP
  IF b->'unresolved'='true'::jsonb THEN RETURN false;END IF;
  IF b ? 'fileId' THEN
   SELECT effective_hub_id,class_id,person_id,domain INTO f FROM public.file_catalogue WHERE id=(b->>'fileId')::uuid;
   IF NOT FOUND OR NOT public.approval_file_scope_allows(p_scopes->'files.view',f.effective_hub_id,f.class_id,f.person_id) THEN RETURN false;END IF;
   domain_cap=CASE f.domain WHEN 'student_private' THEN 'students.view' WHEN 'guardian_private' THEN 'guardians.view' WHEN 'agreement_definition' THEN 'agreements.view' WHEN 'finance_private' THEN 'financial-files.view' WHEN 'general' THEN NULL ELSE 'unknown.private-domain' END;
   IF domain_cap IS NOT NULL AND NOT public.approval_file_scope_allows(p_scopes->domain_cap,f.effective_hub_id,f.class_id,f.person_id) THEN RETURN false;END IF;
  ELSIF b ? 'studentRecords' THEN
   IF b->>'capability' IS DISTINCT FROM 'homework-recipients.view' OR NOT public.homework_recipients_allow(b->'studentRecords',p_scopes->'homework-recipients.view') THEN RETURN false;END IF;
  ELSIF b ? 'personId' THEN
   SELECT id,hub_id INTO f FROM public.people WHERE id=(b->>'personId')::uuid;
   s=p_scopes->(b->>'capability');IF NOT FOUND OR NOT public.approval_scope_nonempty(s) OR NOT public.scope_contains(s,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',f.id,'hubId',f.hub_id)))) THEN RETURN false;END IF;
  ELSE
   s=p_scopes->(b->>'capability');IF NOT public.approval_scope_nonempty(s) THEN RETURN false;END IF;
   IF b->'any' IS DISTINCT FROM 'true'::jsonb AND(jsonb_typeof(b->'scope') IS DISTINCT FROM 'object' OR NOT public.approval_scope_nonempty(b->'scope') OR NOT public.scope_contains(s,b->'scope')) THEN RETURN false;END IF;
  END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
CREATE FUNCTION public.homework_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE actual jsonb;old_record jsonb;r jsonb;ref jsonb;BEGIN
 SELECT to_jsonb(h) INTO old_record FROM public.homeworks h WHERE h.academy_id=NEW.academy_id AND h.id=NEW.target_id;
 IF NEW.action<>'homework.withdraw' THEN
  actual=public.homework_source((NEW.payload->>'sessionId')::uuid,NEW.payload->'document',NEW.payload->'recipients',(NEW.payload->>'assignmentId')::uuid);
  IF actual IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
  r=jsonb_build_object('class_id',actual#>'{session,classId}','hub_id',actual#>'{session,hubId}','context',jsonb_build_object('source',actual));
  NEW.privacy_bindings=NEW.privacy_bindings||public.homework_private_bindings(r);
  FOR ref IN SELECT value FROM jsonb_array_elements(NEW.payload#>'{document,blocks}') WHERE value->>'kind'='media' LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('fileId',(ref->>'fileId')::uuid));END LOOP;
 END IF;
 IF old_record IS NOT NULL THEN
  NEW.privacy_bindings=NEW.privacy_bindings||public.homework_private_bindings(old_record);
  FOR ref IN SELECT value FROM jsonb_array_elements(old_record#>'{document,blocks}') WHERE value->>'kind'='media' LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('fileId',(ref->>'fileId')::uuid));END LOOP;
 ELSIF NEW.action='homework.withdraw' THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));END IF;RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_homework_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('homework.record','homework.edit','homework.withdraw')) EXECUTE FUNCTION public.homework_privacy();
REVOKE ALL ON FUNCTION public.homework_student_ids(jsonb),public.homework_source(uuid,jsonb,jsonb,uuid),public.guard_homework(),public.guard_homework_revision(),public.require_homework_revision(),public.homework_private_bindings(jsonb),public.homework_privacy() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.homework_recipients_allow(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.homework_student_ids(jsonb),public.homework_source(uuid,jsonb,jsonb,uuid),public.homework_private_bindings(jsonb),public.homework_recipients_allow(jsonb,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 77 $$;

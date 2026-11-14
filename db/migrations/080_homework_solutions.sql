INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('homework-solutions.view','View private homework solution drafts and history','Learning',true,ARRAY['hub','class','country','region','city']),
 ('homework-solutions.record','Assigned human proposes a homework solution','Learning',true,ARRAY['hub','class','country','region','city']),
 ('homework-solutions.edit','Propose administrative solution changes and withdrawal','Learning',true,ARRAY['hub','class','country','region','city']),
 ('homework-solutions.publish','Request or approve solution release to assigned families','Learning',true,ARRAY['hub','class','country','region','city']),
 ('received-solutions.view','Read own or linked student released solutions, not private drafts or peers','Learning',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.homework_solutions(
 academy_id uuid NOT NULL,id uuid NOT NULL,homework_id uuid NOT NULL,homework_version integer NOT NULL,session_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),state text NOT NULL CHECK(state IN('draft','published','withdrawn')),audience text NOT NULL CHECK(audience IN('all_assigned','selected')),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object' AND octet_length(document::text)<=131072),recipients jsonb NOT NULL CHECK(jsonb_typeof(recipients)='array' AND jsonb_array_length(recipients)<=1000),
 attachments jsonb NOT NULL CHECK(jsonb_typeof(attachments)='array' AND jsonb_array_length(attachments)<=20),context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=1048576),
 recipient_ids uuid[] GENERATED ALWAYS AS(public.homework_student_ids(context)) STORED,
 assignment_id uuid,assignment_version integer,recorded_by uuid NOT NULL,created_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),
 FOREIGN KEY(academy_id,homework_id,homework_version) REFERENCES public.homework_revisions(academy_id,homework_id,version),
 FOREIGN KEY(academy_id,session_id,class_id,hub_id) REFERENCES public.class_sessions(academy_id,id,class_id,hub_id),
 FOREIGN KEY(academy_id,assignment_id,assignment_version) REFERENCES public.class_staff_revisions(academy_id,assignment_id,version),CHECK((assignment_id IS NULL)=(assignment_version IS NULL)),
 FOREIGN KEY(academy_id,recorded_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX homework_solutions_task ON public.homework_solutions(academy_id,homework_id,id);
CREATE INDEX homework_solutions_students ON public.homework_solutions USING gin(recipient_ids);
CREATE TABLE public.homework_solution_revisions(
 academy_id uuid NOT NULL,solution_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,solution_id,version),FOREIGN KEY(academy_id,solution_id) REFERENCES public.homework_solutions(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['homework_solutions','homework_solution_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,homework_id,homework_version,session_id,class_id,hub_id,state,audience,document,recipients,attachments,context,assignment_id,assignment_version,recorded_by,created_by,changed_by,approval_id,reason) ON public.homework_solutions TO kavosh_runtime;
GRANT UPDATE(version,homework_version,state,audience,document,recipients,attachments,context,assignment_id,assignment_version,recorded_by,changed_by,approval_id,reason) ON public.homework_solutions TO kavosh_runtime;
GRANT INSERT(academy_id,solution_id,version,definition) ON public.homework_solution_revisions TO kavosh_runtime;
-- Reuse exact dated enrollment, class-general media and staff checks. Extra
-- attachments may be PDFs/code/etc.; metadata never proves safe binary access.
CREATE FUNCTION public.homework_solution_source(p_homework uuid,p_document jsonb,p_recipients jsonb,p_attachments jsonb,p_assignment uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;h record;s jsonb;x jsonb;f record;files jsonb:='[]';seen uuid[];BEGIN
 SELECT id,version,session_id,session_version,class_id,state,recipient_ids INTO h FROM public.homeworks WHERE academy_id=tenant AND id=p_homework;IF h.id IS NULL THEN RETURN NULL;END IF;
 s=public.homework_source(h.session_id,p_document,p_recipients,p_assignment);IF s IS NULL OR(s#>>'{session,version}')::integer<>h.session_version OR jsonb_typeof(p_attachments) IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 IF NOT public.homework_student_ids(jsonb_build_object('source',s))<@h.recipient_ids OR jsonb_array_length(p_attachments)>20 THEN RETURN NULL;END IF;
 SELECT coalesce(array_agg(DISTINCT(value->>'fileId')::uuid),'{}'::uuid[]) INTO seen FROM jsonb_array_elements(s->'media');
 FOR x IN SELECT value FROM jsonb_array_elements(p_attachments) LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(x))<>3 OR jsonb_typeof(x->'fileId') IS DISTINCT FROM 'string' OR jsonb_typeof(x->'fileVersion') IS DISTINCT FROM 'number' OR jsonb_typeof(x->'caption') IS DISTINCT FROM 'string' OR length(x->>'caption')>2000 THEN RETURN NULL;END IF;
  SELECT id,version,name,claimed_mime_type,expected_bytes,expected_sha256 INTO f FROM public.file_catalogue WHERE academy_id=tenant AND id=(x->>'fileId')::uuid AND version=(x->>'fileVersion')::numeric AND class_id=h.class_id AND domain='general' AND NOT archived;
  IF f.id IS NULL OR f.id=ANY(seen) THEN RETURN NULL;END IF;seen=array_append(seen,f.id);IF cardinality(seen)>20 THEN RETURN NULL;END IF;
  files=files||jsonb_build_array(to_jsonb(f));
 END LOOP;
 RETURN s||jsonb_build_object('homework',jsonb_build_object('id',h.id,'version',h.version,'state',h.state,'fullAudience',public.homework_student_ids(jsonb_build_object('source',s))=ARRAY(SELECT unnest(h.recipient_ids) ORDER BY 1)),'attachments',files);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
CREATE FUNCTION public.guard_homework_solution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;actual jsonb;previous jsonb;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.homework_id,NEW.session_id,NEW.class_id,NEW.hub_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.homework_id,OLD.session_id,OLD.class_id,OLD.hub_id,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'SOLUTION_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;previous=to_jsonb(OLD);
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'SOLUTION_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>coalesce(OLD.version,0) OR p.privacy_capability IS DISTINCT FROM 'homework-solutions.view' OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'SOLUTION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF p.action='homework-solution.withdraw' THEN
  IF TG_OP<>'UPDATE' OR OLD.state<>'published' OR NEW.state<>'withdrawn' OR(p.payload->>'solutionId')::uuid IS DISTINCT FROM NEW.id OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM OLD.version OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous)
   OR ROW(NEW.homework_version,NEW.audience,NEW.document,NEW.recipients,NEW.attachments,NEW.context,NEW.assignment_id,NEW.assignment_version,NEW.recorded_by) IS DISTINCT FROM ROW(OLD.homework_version,OLD.audience,OLD.document,OLD.recipients,OLD.attachments,OLD.context,OLD.assignment_id,OLD.assignment_version,OLD.recorded_by) THEN RAISE EXCEPTION 'SOLUTION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  IF p.action NOT IN('homework-solution.record','homework-solution.edit') OR NEW.state NOT IN('draft','published') THEN RAISE EXCEPTION 'SOLUTION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
  actual=public.homework_solution_source(NEW.homework_id,NEW.document,NEW.recipients,NEW.attachments,NEW.assignment_id);
  IF actual IS NULL OR NEW.context IS DISTINCT FROM jsonb_build_object('source',actual) OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous,'source',actual) OR NEW.recorded_by IS DISTINCT FROM p.requester_id OR(TG_OP='INSERT' AND NEW.created_by IS DISTINCT FROM p.requester_id)
   OR(p.payload->>'homeworkId')::uuid IS DISTINCT FROM NEW.homework_id OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0) OR(p.payload->>'homeworkVersion')::integer IS DISTINCT FROM NEW.homework_version OR(actual#>>'{homework,version}')::integer IS DISTINCT FROM NEW.homework_version
   OR p.payload->'document' IS DISTINCT FROM NEW.document OR p.payload->'recipients' IS DISTINCT FROM NEW.recipients OR p.payload->'attachments' IS DISTINCT FROM NEW.attachments OR p.payload->>'audience' IS DISTINCT FROM NEW.audience OR p.payload->>'state' IS DISTINCT FROM NEW.state OR(actual#>>'{session,id}')::uuid IS DISTINCT FROM NEW.session_id OR(actual#>>'{session,classId}')::uuid IS DISTINCT FROM NEW.class_id OR(actual#>>'{session,hubId}')::uuid IS DISTINCT FROM NEW.hub_id THEN RAISE EXCEPTION 'SOLUTION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF NEW.audience='all_assigned' AND actual#>>'{homework,fullAudience}' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'SOLUTION_FULL_AUDIENCE_REQUIRED' USING ERRCODE='23514';END IF;
  IF NEW.state='published' AND(jsonb_array_length(NEW.recipients)=0 OR actual#>>'{homework,state}'<>'published' OR actual#>>'{session,classActive}'<>'true' OR actual#>>'{session,status}'<>'scheduled' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.document->'blocks') b WHERE b->>'kind'='text') AND jsonb_array_length(NEW.attachments)=0 AND jsonb_array_length(actual->'media')=0) THEN RAISE EXCEPTION 'SOLUTION_PUBLICATION_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
  IF p.action='homework-solution.record' THEN
   IF p.requester_kind<>'human' OR NEW.assignment_id IS NULL OR(p.payload->>'assignmentId')::uuid IS DISTINCT FROM NEW.assignment_id OR(p.payload->>'assignmentVersion')::integer IS DISTINCT FROM NEW.assignment_version OR(actual#>>'{assignment,person_id}')::uuid IS DISTINCT FROM p.requester_id OR(actual#>>'{assignment,version}')::integer IS DISTINCT FROM NEW.assignment_version OR actual#>>'{session,status}'<>'scheduled' OR actual#>>'{session,classActive}'<>'true' THEN RAISE EXCEPTION 'SOLUTION_STAFF_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  ELSE IF NEW.assignment_id IS NOT NULL OR NEW.assignment_version IS NOT NULL OR p.payload->'assignmentId' IS DISTINCT FROM 'null'::jsonb OR p.payload->'assignmentVersion' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'SOLUTION_ADMIN_ASSIGNMENT_FORBIDDEN' USING ERRCODE='23514';END IF;END IF;
 END IF;NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER homework_solution_guard BEFORE INSERT OR UPDATE ON public.homework_solutions FOR EACH ROW EXECUTE FUNCTION public.guard_homework_solution();
CREATE FUNCTION public.guard_homework_solution_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.homework_solutions g WHERE g.academy_id=NEW.academy_id AND g.id=NEW.solution_id AND g.version=NEW.version AND to_jsonb(g)=NEW.definition) THEN RAISE EXCEPTION 'SOLUTION_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER homework_solution_revision_guard BEFORE INSERT ON public.homework_solution_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_homework_solution_revision();
CREATE FUNCTION public.require_homework_solution_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.homework_solution_revisions g WHERE g.academy_id=NEW.academy_id AND g.solution_id=NEW.id AND g.version=NEW.version AND g.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'SOLUTION_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'SOLUTION_REVIEW_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER homework_solution_revision_required AFTER INSERT OR UPDATE ON public.homework_solutions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_homework_solution_revision();
CREATE FUNCTION public.homework_solution_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE actual jsonb;old_record jsonb;r jsonb;ref jsonb;BEGIN
 SELECT to_jsonb(h) INTO old_record FROM public.homework_solutions h WHERE h.academy_id=NEW.academy_id AND h.id=NEW.target_id;
 IF NEW.action<>'homework-solution.withdraw' THEN
  actual=public.homework_solution_source((NEW.payload->>'homeworkId')::uuid,NEW.payload->'document',NEW.payload->'recipients',NEW.payload->'attachments',(NEW.payload->>'assignmentId')::uuid);
  IF actual IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
  r=jsonb_build_object('class_id',actual#>'{session,classId}','hub_id',actual#>'{session,hubId}','context',jsonb_build_object('source',actual));NEW.privacy_bindings=NEW.privacy_bindings||public.homework_private_bindings(r);
  FOR ref IN SELECT value FROM jsonb_array_elements(NEW.payload#>'{document,blocks}') WHERE value->>'kind'='media' UNION SELECT value FROM jsonb_array_elements(NEW.payload->'attachments') LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('fileId',(ref->>'fileId')::uuid));END LOOP;
 END IF;
 IF old_record IS NOT NULL THEN
  NEW.privacy_bindings=NEW.privacy_bindings||public.homework_private_bindings(old_record);
  FOR ref IN SELECT value FROM jsonb_array_elements(old_record#>'{document,blocks}') WHERE value->>'kind'='media' UNION SELECT value FROM jsonb_array_elements(old_record->'attachments') LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('fileId',(ref->>'fileId')::uuid));END LOOP;
 ELSIF NEW.action='homework-solution.withdraw' THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));END IF;RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_homework_solution_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('homework-solution.record','homework-solution.edit','homework-solution.withdraw')) EXECUTE FUNCTION public.homework_solution_privacy();
REVOKE ALL ON FUNCTION public.homework_solution_source(uuid,jsonb,jsonb,jsonb,uuid),public.guard_homework_solution(),public.guard_homework_solution_revision(),public.require_homework_solution_revision(),public.homework_solution_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.homework_solution_source(uuid,jsonb,jsonb,jsonb,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 80 $$;

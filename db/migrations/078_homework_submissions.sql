INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('homework-submissions.view','View selected submitted student homework, not unpublished drafts','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('homework-submissions.drafts','Additionally view selected unsubmitted homework drafts','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('homework-submissions.submit','Verified student saves only their own assigned homework answers','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('received-submissions.view','Read own or linked student submitted answers; students also read their own drafts','Learning',true,ARRAY['hub','person','country','region','city']),
 ('received-submissions.drafts','Additionally allow a current guardian to read selected student drafts','Learning',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.homework_submissions(
 academy_id uuid NOT NULL,id uuid NOT NULL,homework_id uuid NOT NULL,homework_version integer NOT NULL CHECK(homework_version>0),student_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),state text NOT NULL CHECK(state IN('draft','submitted')),answer jsonb NOT NULL CHECK(jsonb_typeof(answer)='object' AND octet_length(answer::text)<=131072),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=262144),changed_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),submitted_at timestamptz,is_late boolean NOT NULL DEFAULT false,
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,homework_id,student_id),FOREIGN KEY(academy_id,homework_id,homework_version) REFERENCES public.homework_revisions(academy_id,homework_id,version),
 FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),FOREIGN KEY(academy_id,class_id,hub_id) REFERENCES public.classes(academy_id,id,hub_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),CHECK(changed_by=student_id)
);
CREATE INDEX homework_submissions_homework ON public.homework_submissions(academy_id,homework_id,id);
CREATE INDEX homework_submissions_student ON public.homework_submissions(academy_id,student_id,id);
CREATE TABLE public.homework_submission_revisions(
 academy_id uuid NOT NULL,submission_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 state text GENERATED ALWAYS AS(definition->>'state') STORED,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,submission_id,version),FOREIGN KEY(academy_id,submission_id) REFERENCES public.homework_submissions(academy_id,id)
);
CREATE INDEX homework_submissions_submitted ON public.homework_submission_revisions(academy_id,submission_id,version DESC) WHERE state='submitted';
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['homework_submissions','homework_submission_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,homework_id,homework_version,student_id,class_id,hub_id,state,answer,context,changed_by) ON public.homework_submissions TO kavosh_runtime;
GRANT UPDATE(version,homework_version,state,answer,context,changed_by) ON public.homework_submissions TO kavosh_runtime;
GRANT INSERT(academy_id,submission_id,version,definition) ON public.homework_submission_revisions TO kavosh_runtime;
-- Individual source only: never copy a whole class audience into an answer.
CREATE FUNCTION public.homework_submission_source(p_homework uuid,p_student uuid,p_answer jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;h record;e record;x jsonb;f record;files jsonb:='[]';seen uuid[]:='{}';on_date date;BEGIN
 SELECT * INTO h FROM public.homeworks WHERE academy_id=tenant AND id=p_homework AND state='published';IF h.id IS NULL OR NOT(h.recipient_ids @> ARRAY[p_student]) THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.homework_revisions r WHERE r.academy_id=tenant AND r.homework_id=h.id AND r.version=h.version AND r.definition=to_jsonb(h))
 OR NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=tenant AND a.id=h.approval_id AND a.status='applied' AND a.target_id=h.id AND a.reviewer_id=h.changed_by AND a.action IN('homework.record','homework.edit')) THEN RETURN NULL;END IF;
 on_date=(h.context#>>'{source,session,on}')::date;
 SELECT e0.id,e0.version,e0.student_id,e0.joins_on,e0.leaves_on INTO e FROM public.class_enrollments e0 JOIN public.people p ON p.academy_id=e0.academy_id AND p.id=e0.student_id
 WHERE e0.academy_id=tenant AND e0.class_id=h.class_id AND e0.student_id=p_student AND e0.enabled AND e0.joins_on<=on_date AND(e0.leaves_on IS NULL OR e0.leaves_on>=on_date) AND p.kind='human' AND p.status='active'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(h.context#>'{source,recipients}') r WHERE(r->>'studentId')::uuid=p_student AND(r->>'enrollmentId')::uuid=e0.id);
 IF e.id IS NULL OR jsonb_typeof(p_answer) IS DISTINCT FROM 'object' THEN RETURN NULL;END IF;
 IF(SELECT count(*) FROM jsonb_object_keys(p_answer))<>2 OR jsonb_typeof(p_answer->'text') IS DISTINCT FROM 'string' OR length(p_answer->>'text')>50000 OR jsonb_typeof(p_answer->'attachments') IS DISTINCT FROM 'array' OR octet_length(p_answer::text)>131072 THEN RETURN NULL;END IF;
 IF jsonb_array_length(p_answer->'attachments')>20 THEN RETURN NULL;END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p_answer->'attachments') LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' THEN RETURN NULL;END IF;
  IF(SELECT count(*) FROM jsonb_object_keys(x))<>3 OR jsonb_typeof(x->'fileId') IS DISTINCT FROM 'string' OR jsonb_typeof(x->'fileVersion') IS DISTINCT FROM 'number' OR jsonb_typeof(x->'caption') IS DISTINCT FROM 'string' OR length(x->>'caption')>2000 THEN RETURN NULL;END IF;
  IF(x->>'fileId')::uuid=ANY(seen) THEN RETURN NULL;END IF;seen=array_append(seen,(x->>'fileId')::uuid);
  SELECT id,version,name,claimed_mime_type,expected_bytes,expected_sha256 INTO f FROM public.file_records WHERE academy_id=tenant AND id=(x->>'fileId')::uuid AND version=(x->>'fileVersion')::numeric AND anchor_kind='person' AND person_id=p_student AND domain='student_private' AND NOT archived;
  IF f.id IS NULL THEN RETURN NULL;END IF;files=files||jsonb_build_array(to_jsonb(f));
 END LOOP;
 RETURN jsonb_build_object('homework',jsonb_build_object('id',h.id,'version',h.version,'classId',h.class_id,'hubId',h.hub_id,'sessionId',h.session_id,'on',on_date,'timeZone',h.context#>>'{source,session,timeZone}','dueAt',h.due_at,'acceptLate',h.accept_late),'enrollment',to_jsonb(e),'attachments',files);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
CREATE FUNCTION public.guard_homework_submission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE actual jsonb;t timestamptz;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.homework_id,NEW.student_id,NEW.class_id,NEW.hub_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.homework_id,OLD.student_id,OLD.class_id,OLD.hub_id,OLD.created_at) THEN RAISE EXCEPTION 'SUBMISSION_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'SUBMISSION_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 actual=public.homework_submission_source(NEW.homework_id,NEW.student_id,NEW.answer);
 IF actual IS NULL OR NEW.changed_by IS DISTINCT FROM NEW.student_id OR NEW.context IS DISTINCT FROM actual OR(actual#>>'{homework,version}')::integer IS DISTINCT FROM NEW.homework_version OR(actual#>>'{homework,classId}')::uuid IS DISTINCT FROM NEW.class_id OR(actual#>>'{homework,hubId}')::uuid IS DISTINCT FROM NEW.hub_id THEN RAISE EXCEPTION 'SUBMISSION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 t=clock_timestamp();IF TG_OP='INSERT' THEN NEW.created_at=t;END IF;NEW.changed_at=t;NEW.submitted_at=NULL;NEW.is_late=false;
 IF NEW.state='submitted' THEN
  IF length(btrim(NEW.answer->>'text',E' \t\r\n\f\v'))=0 AND jsonb_array_length(NEW.answer->'attachments')=0 THEN RAISE EXCEPTION 'SUBMISSION_ANSWER_REQUIRED' USING ERRCODE='23514';END IF;
  NEW.submitted_at=t;NEW.is_late=coalesce(t>(actual#>>'{homework,dueAt}')::timestamptz,false);
  IF NEW.is_late AND actual#>>'{homework,acceptLate}' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'SUBMISSION_DEADLINE_PASSED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER homework_submission_guard BEFORE INSERT OR UPDATE ON public.homework_submissions FOR EACH ROW EXECUTE FUNCTION public.guard_homework_submission();
CREATE FUNCTION public.guard_homework_submission_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.homework_submissions s WHERE s.academy_id=NEW.academy_id AND s.id=NEW.submission_id AND s.version=NEW.version AND to_jsonb(s)=NEW.definition) THEN RAISE EXCEPTION 'SUBMISSION_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER homework_submission_revision_guard BEFORE INSERT ON public.homework_submission_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_homework_submission_revision();
CREATE FUNCTION public.require_homework_submission_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.homework_submission_revisions s WHERE s.academy_id=NEW.academy_id AND s.submission_id=NEW.id AND s.version=NEW.version AND s.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'SUBMISSION_REVISION_MISSING' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER homework_submission_revision_required AFTER INSERT OR UPDATE ON public.homework_submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_homework_submission_revision();
REVOKE ALL ON FUNCTION public.homework_submission_source(uuid,uuid,jsonb),public.guard_homework_submission(),public.guard_homework_submission_revision(),public.require_homework_submission_revision() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.homework_submission_source(uuid,uuid,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 78 $$;

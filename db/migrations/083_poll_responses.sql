INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('received-polls.respond','Verified self or current guardian responds only for an assigned student','Learning',true,ARRAY['hub','person','country','region','city']),
 ('poll-responses.view','Read selected student poll answers and immutable response history','Learning',true,ARRAY['hub','class','person','country','region','city']);
CREATE FUNCTION public.poll_answers_valid(d jsonb,answers jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE a jsonb;q jsonb;choice jsonb;seen uuid[]:='{}';choices uuid[];qid uuid;oid uuid;BEGIN
 IF NOT public.poll_definition_valid(d) OR jsonb_typeof(answers) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(answers)>20 OR octet_length(answers::text)>131072 THEN RETURN false;END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(answers) LOOP
  IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR jsonb_typeof(a->'questionId') IS DISTINCT FROM 'string' OR jsonb_typeof(a->'kind') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  qid=(a->>'questionId')::uuid;IF qid=ANY(seen) THEN RETURN false;END IF;seen=array_append(seen,qid);
  SELECT value INTO q FROM jsonb_array_elements(d->'questions') WHERE(value->>'id')::uuid=qid;
  IF q IS NULL OR a->>'kind' IS DISTINCT FROM q->>'kind' OR(SELECT count(*) FROM jsonb_object_keys(a))<>3 THEN RETURN false;END IF;
  IF a->>'kind'='text' THEN
   IF jsonb_typeof(a->'text') IS DISTINCT FROM 'string' OR length(btrim(a->>'text',E' \t\r\n\f\v'))<1 OR length(a->>'text')>(q->>'maxLength')::integer THEN RETURN false;END IF;
  ELSIF a->>'kind'='single' THEN
   IF jsonb_typeof(a->'optionId') IS DISTINCT FROM 'string' THEN RETURN false;END IF;oid=(a->>'optionId')::uuid;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'options') o WHERE(o->>'id')::uuid=oid) THEN RETURN false;END IF;
  ELSIF a->>'kind'='multiple' THEN
   IF jsonb_typeof(a->'optionIds') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
   IF jsonb_array_length(a->'optionIds') NOT BETWEEN 1 AND(q->>'maxSelections')::integer THEN RETURN false;END IF;choices='{}';
   FOR choice IN SELECT value FROM jsonb_array_elements(a->'optionIds') LOOP
    IF jsonb_typeof(choice) IS DISTINCT FROM 'string' THEN RETURN false;END IF;oid=(choice#>>'{}')::uuid;
    IF oid=ANY(choices) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'options') o WHERE(o->>'id')::uuid=oid) THEN RETURN false;END IF;choices=array_append(choices,oid);
   END LOOP;
  ELSE RETURN false;END IF;
 END LOOP;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'questions') required_question WHERE(required_question->>'required')::boolean AND NOT((required_question->>'id')::uuid=ANY(seen)));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END $$;
CREATE TABLE public.poll_responses(
 academy_id uuid NOT NULL,id uuid NOT NULL,poll_id uuid NOT NULL,form_version integer NOT NULL CHECK(form_version>0),student_id uuid NOT NULL,respondent_key uuid NOT NULL,
 class_id uuid NOT NULL,hub_id uuid NOT NULL,posted_on date NOT NULL,poll_version integer NOT NULL CHECK(poll_version>0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),state text NOT NULL CHECK(state IN('submitted','withdrawn')),answers jsonb NOT NULL CHECK(jsonb_typeof(answers)='array' AND octet_length(answers::text)<=131072),context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=16384),
 created_by uuid NOT NULL,changed_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,poll_id,form_version,student_id,respondent_key),
 FOREIGN KEY(academy_id,poll_id,form_version) REFERENCES public.poll_form_revisions(academy_id,poll_id,form_version),
 FOREIGN KEY(academy_id,poll_id,poll_version) REFERENCES public.poll_revisions(academy_id,poll_id,version),
 FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),FOREIGN KEY(academy_id,class_id,hub_id) REFERENCES public.classes(academy_id,id,hub_id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id)
);
CREATE INDEX poll_responses_poll ON public.poll_responses(academy_id,poll_id,form_version,id);
CREATE INDEX poll_responses_student ON public.poll_responses(academy_id,student_id,poll_id,form_version);
CREATE TABLE public.poll_response_revisions(
 academy_id uuid NOT NULL,response_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,response_id,version),FOREIGN KEY(academy_id,response_id) REFERENCES public.poll_responses(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['poll_responses','poll_response_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,poll_id,form_version,student_id,respondent_key,class_id,hub_id,posted_on,poll_version,state,answers,context,created_by,changed_by) ON public.poll_responses TO kavosh_runtime;
GRANT UPDATE(version,class_id,hub_id,posted_on,poll_version,state,answers,context,changed_by) ON public.poll_responses TO kavosh_runtime;
GRANT INSERT(academy_id,response_id,version,definition) ON public.poll_response_revisions TO kavosh_runtime;
-- One recipient only: a response never copies the school's complete audience.
CREATE FUNCTION public.poll_response_source(p_poll uuid,p_student uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;p record;r jsonb;e record;BEGIN
 SELECT id,version,form_version,state,response_unit,respondent_mode,opens_at,closes_at,approval_id,changed_by,context INTO p FROM public.polls WHERE academy_id=tenant AND id=p_poll AND state IN('published','closed');
 IF p.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=tenant AND a.id=p.approval_id AND a.status='applied' AND a.target_id=p.id AND a.reviewer_id=p.changed_by AND a.action IN('poll.change','poll.close')) THEN RETURN NULL;END IF;
 SELECT value INTO r FROM jsonb_array_elements(p.context#>'{source,recipients}') WHERE(value->>'studentId')::uuid=p_student;IF r IS NULL THEN RETURN NULL;END IF;
 SELECT e0.id,e0.version INTO e FROM public.class_enrollments e0 JOIN public.people student ON student.academy_id=e0.academy_id AND student.id=e0.student_id
 WHERE e0.academy_id=tenant AND e0.id=(r->>'enrollmentId')::uuid AND e0.student_id=p_student AND e0.class_id=(r->>'classId')::uuid AND e0.enabled AND student.kind='human' AND student.status='active'
 AND e0.joins_on<=(r->>'on')::date AND(e0.leaves_on IS NULL OR e0.leaves_on>=(r->>'on')::date);
 IF e.id IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('poll',jsonb_build_object('id',p.id,'version',p.version,'formVersion',p.form_version,'state',p.state,'responseUnit',p.response_unit,'respondentMode',p.respondent_mode,'opensAt',p.opens_at,'closesAt',p.closes_at),
 'recipient',jsonb_build_object('studentId',p_student,'classId',r->'classId','hubId',r->'hubId','on',r->'on','timeZone',r->'timeZone','enrollmentId',e.id,'enrollmentVersion',e.version));
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
CREATE FUNCTION public.guard_poll_response() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s jsonb;f record;t timestamptz;BEGIN
 IF NOT public.report_comment_human_verified(NEW.changed_by) OR NOT public.report_comment_family(NEW.student_id,NEW.changed_by) THEN RAISE EXCEPTION 'POLL_RESPONSE_VERIFIED_FAMILY_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT definition,response_unit,respondent_mode INTO f FROM public.poll_form_revisions WHERE academy_id=NEW.academy_id AND poll_id=NEW.poll_id AND form_version=NEW.form_version;
 IF f.definition IS NULL OR NEW.respondent_key IS DISTINCT FROM(CASE WHEN f.response_unit='student_family' THEN NEW.student_id ELSE NEW.changed_by END)
 OR(NEW.changed_by=NEW.student_id AND f.respondent_mode='guardians') OR(NEW.changed_by<>NEW.student_id AND f.respondent_mode='students') THEN RAISE EXCEPTION 'POLL_RESPONSE_RESPONDENT_FORBIDDEN' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.poll_id,NEW.form_version,NEW.student_id,NEW.respondent_key,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.poll_id,OLD.form_version,OLD.student_id,OLD.respondent_key,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'POLL_RESPONSE_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 ELSE IF NEW.version<>1 OR NEW.state<>'submitted' OR NEW.created_by<>NEW.changed_by THEN RAISE EXCEPTION 'POLL_RESPONSE_OWN_CREATION_REQUIRED' USING ERRCODE='23514';END IF;END IF;
 s=public.poll_response_source(NEW.poll_id,NEW.student_id);IF s IS NULL THEN RAISE EXCEPTION 'POLL_RESPONSE_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NEW.state='withdrawn' THEN
  IF TG_OP<>'UPDATE' OR OLD.state<>'submitted' OR ROW(NEW.answers,NEW.context,NEW.class_id,NEW.hub_id,NEW.posted_on,NEW.poll_version) IS DISTINCT FROM ROW(OLD.answers,OLD.context,OLD.class_id,OLD.hub_id,OLD.posted_on,OLD.poll_version)
  OR NOT EXISTS(SELECT 1 FROM public.class_enrollments e WHERE e.academy_id=NEW.academy_id AND e.id=(NEW.context#>>'{recipient,enrollmentId}')::uuid AND e.class_id=NEW.class_id AND e.student_id=NEW.student_id AND e.enabled AND e.joins_on<=NEW.posted_on AND(e.leaves_on IS NULL OR e.leaves_on>=NEW.posted_on)) THEN RAISE EXCEPTION 'POLL_RESPONSE_EXACT_WITHDRAWAL_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  IF NEW.context IS DISTINCT FROM s OR(s#>>'{poll,formVersion}')::integer IS DISTINCT FROM NEW.form_version OR(s#>>'{poll,version}')::integer IS DISTINCT FROM NEW.poll_version OR(s#>>'{recipient,classId}')::uuid IS DISTINCT FROM NEW.class_id OR(s#>>'{recipient,hubId}')::uuid IS DISTINCT FROM NEW.hub_id OR(s#>>'{recipient,on}')::date IS DISTINCT FROM NEW.posted_on OR NOT public.poll_answers_valid(f.definition,NEW.answers) THEN RAISE EXCEPTION 'POLL_RESPONSE_SOURCE_OR_ANSWERS_CHANGED' USING ERRCODE='23514';END IF;
  t=clock_timestamp();IF s#>>'{poll,state}'<>'published' OR(s#>>'{poll,opensAt}')::timestamptz>t OR(s#>>'{poll,closesAt}')::timestamptz<=t THEN RAISE EXCEPTION 'POLL_RESPONSE_WINDOW_CLOSED' USING ERRCODE='23514';END IF;
 END IF;NEW.changed_at=clock_timestamp();IF TG_OP='INSERT' THEN NEW.created_at=NEW.changed_at;END IF;RETURN NEW;
END $$;
CREATE TRIGGER poll_response_guard BEFORE INSERT OR UPDATE ON public.poll_responses FOR EACH ROW EXECUTE FUNCTION public.guard_poll_response();
CREATE FUNCTION public.guard_poll_response_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.poll_responses r WHERE r.academy_id=NEW.academy_id AND r.id=NEW.response_id AND r.version=NEW.version AND to_jsonb(r)=NEW.definition) THEN RAISE EXCEPTION 'POLL_RESPONSE_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER poll_response_revision_guard BEFORE INSERT ON public.poll_response_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_poll_response_revision();
CREATE FUNCTION public.require_poll_response_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.poll_response_revisions r WHERE r.academy_id=NEW.academy_id AND r.response_id=NEW.id AND r.version=NEW.version AND r.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'POLL_RESPONSE_REVISION_MISSING' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER poll_response_revision_required AFTER INSERT OR UPDATE ON public.poll_responses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_poll_response_revision();
REVOKE ALL ON FUNCTION public.poll_answers_valid(jsonb,jsonb),public.poll_response_source(uuid,uuid),public.guard_poll_response(),public.guard_poll_response_revision(),public.require_poll_response_revision() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.poll_answers_valid(jsonb,jsonb),public.poll_response_source(uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 83 $$;

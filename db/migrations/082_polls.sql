INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('polls.view','View scoped poll configuration and question history','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('polls.edit','Propose school, hub or class poll configuration','Learning',true,ARRAY['hub','class','country','region','city']),
 ('polls.publish','Request or approve poll publication, closing and withdrawal','Learning',true,ARRAY['hub','class','country','region','city']),
 ('poll-recipients.view','View selected dated poll audience records without granting student profiles','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('received-polls.view','Read own or currently linked student assigned polls','Learning',true,ARRAY['hub','person','country','region','city']);
CREATE FUNCTION public.poll_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE q jsonb;o jsonb;ids uuid[]:='{}';option_ids uuid[];qid uuid;oid uuid;k text;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(d))<>4 OR jsonb_typeof(d->'title') IS DISTINCT FROM 'string' OR length(btrim(d->>'title')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(d->'description') IS DISTINCT FROM 'string' OR length(d->>'description')>4000 OR jsonb_typeof(d->'locale') IS DISTINCT FROM 'string' OR d->>'locale' NOT IN('en','fr','zh-CN') OR jsonb_typeof(d->'questions') IS DISTINCT FROM 'array' OR octet_length(d::text)>131072 THEN RETURN false;END IF;
 IF jsonb_array_length(d->'questions') NOT BETWEEN 1 AND 20 THEN RETURN false;END IF;
 FOR q IN SELECT value FROM jsonb_array_elements(d->'questions') LOOP
  IF jsonb_typeof(q) IS DISTINCT FROM 'object' OR jsonb_typeof(q->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(q->'prompt') IS DISTINCT FROM 'string' OR length(btrim(q->>'prompt')) NOT BETWEEN 1 AND 2000 OR jsonb_typeof(q->'required') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  qid=(q->>'id')::uuid;IF qid=ANY(ids) THEN RETURN false;END IF;ids=array_append(ids,qid);k=q->>'kind';
  IF k='text' THEN
   IF(SELECT count(*) FROM jsonb_object_keys(q))<>5 OR jsonb_typeof(q->'maxLength') IS DISTINCT FROM 'number' OR(q->>'maxLength')::numeric NOT BETWEEN 1 AND 4000 OR trunc((q->>'maxLength')::numeric)<>(q->>'maxLength')::numeric THEN RETURN false;END IF;
  ELSIF k IN('single','multiple') THEN
   IF(SELECT count(*) FROM jsonb_object_keys(q))<>(CASE WHEN k='single' THEN 5 ELSE 6 END) OR jsonb_typeof(q->'options') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
   IF jsonb_array_length(q->'options') NOT BETWEEN 2 AND 20 THEN RETURN false;END IF;option_ids='{}';
   FOR o IN SELECT value FROM jsonb_array_elements(q->'options') LOOP
    IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(o))<>2 OR jsonb_typeof(o->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(o->'label') IS DISTINCT FROM 'string' OR length(btrim(o->>'label')) NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;
    oid=(o->>'id')::uuid;IF oid=ANY(option_ids) THEN RETURN false;END IF;option_ids=array_append(option_ids,oid);
   END LOOP;
   IF k='multiple' AND(jsonb_typeof(q->'maxSelections') IS DISTINCT FROM 'number' OR(q->>'maxSelections')::numeric NOT BETWEEN 1 AND cardinality(option_ids) OR trunc((q->>'maxSelections')::numeric)<>(q->>'maxSelections')::numeric) THEN RETURN false;END IF;
  ELSE RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END $$;
CREATE FUNCTION public.poll_student_ids(c jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(array_agg((r->>'studentId')::uuid ORDER BY r->>'studentId'),'{}'::uuid[]) FROM jsonb_array_elements(c#>'{source,recipients}') r
$$;
CREATE TABLE public.polls(
 academy_id uuid NOT NULL,id uuid NOT NULL,anchor jsonb NOT NULL CHECK(jsonb_typeof(anchor)='object'),hub_id uuid,class_id uuid,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),form_version integer NOT NULL DEFAULT 1 CHECK(form_version>0),state text NOT NULL CHECK(state IN('draft','published','closed','withdrawn')),
 definition jsonb NOT NULL CHECK(public.poll_definition_valid(definition)),response_unit text NOT NULL CHECK(response_unit IN('student_family','guardian_per_student')),respondent_mode text NOT NULL CHECK(respondent_mode IN('guardians','students','both')),
 audience_effective_at timestamptz NOT NULL,opens_at timestamptz,closes_at timestamptz,CHECK(opens_at IS NULL OR closes_at IS NULL OR opens_at<closes_at),
 CHECK((opens_at IS NULL OR isfinite(opens_at)) AND(closes_at IS NULL OR isfinite(closes_at))),
 recipients jsonb NOT NULL CHECK(jsonb_typeof(recipients)='array' AND jsonb_array_length(recipients)<=1000),context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=1048576),
 recipient_ids uuid[] GENERATED ALWAYS AS(public.poll_student_ids(context)) STORED,
 recorded_by uuid NOT NULL,created_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),
 FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,class_id) REFERENCES public.classes(academy_id,id),
 FOREIGN KEY(academy_id,recorded_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX polls_owner ON public.polls(academy_id,hub_id,class_id,id);
CREATE INDEX polls_students ON public.polls USING gin(recipient_ids);
CREATE TABLE public.poll_revisions(
 academy_id uuid NOT NULL,poll_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,poll_id,version),FOREIGN KEY(academy_id,poll_id) REFERENCES public.polls(academy_id,id)
);
CREATE TABLE public.poll_form_revisions(
 academy_id uuid NOT NULL,poll_id uuid NOT NULL,form_version integer NOT NULL CHECK(form_version>0),definition jsonb NOT NULL CHECK(public.poll_definition_valid(definition)),response_unit text NOT NULL CHECK(response_unit IN('student_family','guardian_per_student')),respondent_mode text NOT NULL CHECK(respondent_mode IN('guardians','students','both')),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,poll_id,form_version),FOREIGN KEY(academy_id,poll_id) REFERENCES public.polls(academy_id,id)
);
ALTER TABLE public.polls ADD FOREIGN KEY(academy_id,id,form_version) REFERENCES public.poll_form_revisions(academy_id,poll_id,form_version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['polls','poll_revisions','poll_form_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,anchor,hub_id,class_id,state,definition,response_unit,respondent_mode,audience_effective_at,opens_at,closes_at,recipients,context,recorded_by,created_by,changed_by,approval_id,reason) ON public.polls TO kavosh_runtime;
GRANT UPDATE(version,state,definition,response_unit,respondent_mode,audience_effective_at,opens_at,closes_at,recipients,context,recorded_by,changed_by,approval_id,reason) ON public.polls TO kavosh_runtime;
GRANT INSERT(academy_id,poll_id,version,definition) ON public.poll_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,poll_id,form_version,definition,response_unit,respondent_mode) ON public.poll_form_revisions TO kavosh_runtime;
CREATE FUNCTION public.poll_source(p_anchor jsonb,p_effective timestamptz,p_recipients jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;owner jsonb;o record;members jsonb;selected_count integer;unique_count integer;k text;BEGIN
 IF p_effective IS NULL OR NOT isfinite(p_effective) OR jsonb_typeof(p_anchor) IS DISTINCT FROM 'object' OR jsonb_typeof(p_recipients) IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 IF jsonb_array_length(p_recipients)>1000 THEN RETURN NULL;END IF;k=p_anchor->>'kind';
 IF k='academy' THEN
  IF(SELECT count(*) FROM jsonb_object_keys(p_anchor))<>1 THEN RETURN NULL;END IF;SELECT id,status INTO o FROM public.academies WHERE id=tenant;IF NOT FOUND THEN RETURN NULL;END IF;
  owner=jsonb_build_object('kind',k,'id',o.id,'hubId',NULL,'classId',NULL,'active',o.status='active');
 ELSIF k='hub' THEN
  IF(SELECT count(*) FROM jsonb_object_keys(p_anchor))<>2 OR jsonb_typeof(p_anchor->'id') IS DISTINCT FROM 'string' THEN RETURN NULL;END IF;SELECT id,version,active FROM public.hubs WHERE academy_id=tenant AND id=(p_anchor->>'id')::uuid INTO o;IF NOT FOUND THEN RETURN NULL;END IF;
  owner=jsonb_build_object('kind',k,'id',o.id,'hubId',o.id,'classId',NULL,'version',o.version,'active',o.active);
 ELSIF k='class' THEN
  IF(SELECT count(*) FROM jsonb_object_keys(p_anchor))<>2 OR jsonb_typeof(p_anchor->'id') IS DISTINCT FROM 'string' THEN RETURN NULL;END IF;SELECT c.id,c.version,c.hub_id,c.active AND h.active active,h.version hub_version FROM public.classes c JOIN public.hubs h ON h.academy_id=c.academy_id AND h.id=c.hub_id WHERE c.academy_id=tenant AND c.id=(p_anchor->>'id')::uuid INTO o;IF NOT FOUND THEN RETURN NULL;END IF;
  owner=jsonb_build_object('kind',k,'id',o.id,'hubId',o.hub_id,'classId',o.id,'version',o.version,'hubVersion',o.hub_version,'active',o.active);
 ELSE RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_recipients) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(x))<>2 OR jsonb_typeof(x->'enrollmentId') IS DISTINCT FROM 'string' OR jsonb_typeof(x->'enrollmentVersion') IS DISTINCT FROM 'number') THEN RETURN NULL;END IF;
 -- Resolve the bounded audience as one join/aggregate, not one query and an
 -- increasingly large JSON-array copy per student. Counts reject omissions.
 SELECT coalesce(jsonb_agg(jsonb_build_object('enrollmentId',e.id,'enrollmentVersion',e.version,'studentId',e.student_id,'classId',e.class_id,'classVersion',c.version,'hubId',c.hub_id,'hubVersion',h.version,'on',(p_effective AT TIME ZONE c.time_zone)::date,'timeZone',c.time_zone) ORDER BY e.id),'[]'::jsonb),count(*),count(DISTINCT e.student_id)
 INTO members,selected_count,unique_count FROM jsonb_array_elements(p_recipients) x
 JOIN public.class_enrollments e ON e.academy_id=tenant AND e.id=(x->>'enrollmentId')::uuid AND e.version=(x->>'enrollmentVersion')::numeric
 JOIN public.classes c ON c.academy_id=e.academy_id AND c.id=e.class_id JOIN public.hubs h ON h.academy_id=c.academy_id AND h.id=c.hub_id JOIN public.people p ON p.academy_id=e.academy_id AND p.id=e.student_id
 WHERE e.enabled AND c.active AND h.active AND p.kind='human' AND p.status='active' AND c.time_zone IS NOT NULL
 AND(k<>'class' OR e.class_id=(owner->>'classId')::uuid) AND(k<>'hub' OR c.hub_id=(owner->>'hubId')::uuid)
 AND e.joins_on<=(p_effective AT TIME ZONE c.time_zone)::date AND(e.leaves_on IS NULL OR e.leaves_on>=(p_effective AT TIME ZONE c.time_zone)::date);
 IF selected_count<>jsonb_array_length(p_recipients) OR unique_count<>selected_count THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('owner',owner,'effectiveAt',p_effective,'recipients',members);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value OR datetime_field_overflow THEN RETURN NULL;
END $$;
CREATE FUNCTION public.poll_recipient_records_allow(records jsonb,s jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE r jsonb;c uuid;h uuid;p uuid;BEGIN
 IF NOT public.approval_scope_nonempty(s) OR jsonb_typeof(records) IS DISTINCT FROM 'array' THEN RETURN false;END IF;IF jsonb_array_length(records) NOT BETWEEN 1 AND 1000 THEN RETURN false;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(records) LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(r))<>3 OR jsonb_typeof(r->'classId') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'hubId') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'studentId') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  c=(r->>'classId')::uuid;h=(r->>'hubId')::uuid;p=(r->>'studentId')::uuid;
  IF public.scope_contains(s,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',c,'hubId',h)),'people',jsonb_build_array(jsonb_build_object('id',p,'hubId',h)),'recordContext',jsonb_build_object('classId',c,'hubId',h,'studentId',p))) IS NOT TRUE THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
CREATE FUNCTION public.poll_private_bindings(c jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN count(*)=0 THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('capability','poll-recipients.view','pollRecords',jsonb_agg(jsonb_build_object('classId',r->'classId','hubId',r->'hubId','studentId',r->'studentId')))) END FROM jsonb_array_elements(c#>'{source,recipients}') r
$$;
CREATE OR REPLACE FUNCTION public.approval_bindings_allow(p_bindings jsonb,p_scopes jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE b jsonb;s jsonb;f record;domain_cap text;BEGIN
 IF jsonb_typeof(p_bindings) IS DISTINCT FROM 'array' OR jsonb_array_length(p_bindings)>64 THEN RETURN false;END IF;
 FOR b IN SELECT * FROM jsonb_array_elements(p_bindings) LOOP
  IF b->'unresolved'='true'::jsonb THEN RETURN false;END IF;
  IF b ? 'fileId' THEN
   SELECT effective_hub_id,class_id,person_id,domain INTO f FROM public.file_catalogue WHERE id=(b->>'fileId')::uuid;
   IF NOT FOUND OR NOT public.approval_file_scope_allows(p_scopes->'files.view',f.effective_hub_id,f.class_id,f.person_id) THEN RETURN false;END IF;
   domain_cap=CASE f.domain WHEN 'student_private' THEN 'students.view' WHEN 'guardian_private' THEN 'guardians.view' WHEN 'agreement_definition' THEN 'agreements.view' WHEN 'finance_private' THEN 'financial-files.view' WHEN 'general' THEN NULL ELSE 'unknown.private-domain' END;
   IF domain_cap IS NOT NULL AND NOT public.approval_file_scope_allows(p_scopes->domain_cap,f.effective_hub_id,f.class_id,f.person_id) THEN RETURN false;END IF;
  ELSIF b ? 'pollRecords' THEN
   IF b->>'capability' IS DISTINCT FROM 'poll-recipients.view' OR NOT public.poll_recipient_records_allow(b->'pollRecords',p_scopes->'poll-recipients.view') THEN RETURN false;END IF;
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
CREATE FUNCTION public.guard_poll() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;actual jsonb;previous jsonb;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.anchor,NEW.hub_id,NEW.class_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.anchor,OLD.hub_id,OLD.class_id,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'POLL_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;previous=to_jsonb(OLD);
  NEW.form_version=OLD.form_version+CASE WHEN ROW(NEW.definition,NEW.response_unit,NEW.respondent_mode) IS DISTINCT FROM ROW(OLD.definition,OLD.response_unit,OLD.respondent_mode) THEN 1 ELSE 0 END;
 ELSE IF NEW.version<>1 THEN RAISE EXCEPTION 'POLL_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;NEW.form_version=1;END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>coalesce(OLD.version,0) OR p.privacy_capability IS DISTINCT FROM 'polls.view' OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'POLL_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF p.action IN('poll.withdraw','poll.close') THEN
  IF TG_OP<>'UPDATE' OR OLD.state NOT IN('published','closed') OR(p.action='poll.close' AND OLD.state<>'published') OR NEW.state IS DISTINCT FROM(CASE WHEN p.action='poll.close' THEN 'closed' ELSE 'withdrawn' END) OR(p.payload->>'pollId')::uuid IS DISTINCT FROM NEW.id OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM OLD.version OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous)
   OR ROW(NEW.definition,NEW.response_unit,NEW.respondent_mode,NEW.audience_effective_at,NEW.opens_at,NEW.closes_at,NEW.recipients,NEW.context,NEW.recorded_by) IS DISTINCT FROM ROW(OLD.definition,OLD.response_unit,OLD.respondent_mode,OLD.audience_effective_at,OLD.opens_at,OLD.closes_at,OLD.recipients,OLD.context,OLD.recorded_by) THEN RAISE EXCEPTION 'POLL_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  IF p.action<>'poll.change' OR NEW.state NOT IN('draft','published','closed') THEN RAISE EXCEPTION 'POLL_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;actual=public.poll_source(NEW.anchor,NEW.audience_effective_at,NEW.recipients);
  IF actual IS NULL OR NEW.context IS DISTINCT FROM jsonb_build_object('source',actual) OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous,'source',actual) OR NEW.recorded_by IS DISTINCT FROM p.requester_id OR(TG_OP='INSERT' AND NEW.created_by IS DISTINCT FROM p.requester_id)
   OR p.payload->'anchor' IS DISTINCT FROM NEW.anchor OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0) OR p.payload->'definition' IS DISTINCT FROM NEW.definition OR p.payload->>'responseUnit' IS DISTINCT FROM NEW.response_unit OR p.payload->>'respondentMode' IS DISTINCT FROM NEW.respondent_mode OR p.payload->>'state' IS DISTINCT FROM NEW.state OR(p.payload->>'audienceEffectiveAt')::timestamptz IS DISTINCT FROM NEW.audience_effective_at OR(p.payload->>'opensAt')::timestamptz IS DISTINCT FROM NEW.opens_at OR(p.payload->>'closesAt')::timestamptz IS DISTINCT FROM NEW.closes_at OR p.payload->'recipients' IS DISTINCT FROM NEW.recipients
   OR(actual#>>'{owner,hubId}')::uuid IS DISTINCT FROM NEW.hub_id OR(actual#>>'{owner,classId}')::uuid IS DISTINCT FROM NEW.class_id THEN RAISE EXCEPTION 'POLL_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF NEW.state IN('published','closed') AND(jsonb_array_length(NEW.recipients)=0 OR actual#>>'{owner,active}'<>'true' OR NEW.audience_effective_at>clock_timestamp()) THEN RAISE EXCEPTION 'POLL_PUBLICATION_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER poll_guard BEFORE INSERT OR UPDATE ON public.polls FOR EACH ROW EXECUTE FUNCTION public.guard_poll();
CREATE FUNCTION public.guard_poll_form() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.polls p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.poll_id AND p.form_version=NEW.form_version AND p.definition=NEW.definition AND p.response_unit=NEW.response_unit AND p.respondent_mode=NEW.respondent_mode) THEN RAISE EXCEPTION 'POLL_EXACT_FORM_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER poll_form_guard BEFORE INSERT ON public.poll_form_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_poll_form();
CREATE FUNCTION public.guard_poll_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.polls p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.poll_id AND p.version=NEW.version AND to_jsonb(p)=NEW.definition) THEN RAISE EXCEPTION 'POLL_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER poll_revision_guard BEFORE INSERT ON public.poll_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_poll_revision();
CREATE FUNCTION public.require_poll_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.poll_revisions r WHERE r.academy_id=NEW.academy_id AND r.poll_id=NEW.id AND r.version=NEW.version AND r.definition=to_jsonb(NEW)) OR NOT EXISTS(SELECT 1 FROM public.poll_form_revisions r WHERE r.academy_id=NEW.academy_id AND r.poll_id=NEW.id AND r.form_version=NEW.form_version AND r.definition=NEW.definition AND r.response_unit=NEW.response_unit AND r.respondent_mode=NEW.respondent_mode) THEN RAISE EXCEPTION 'POLL_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'POLL_REVIEW_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER poll_revision_required AFTER INSERT OR UPDATE ON public.polls DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_poll_revision();
CREATE FUNCTION public.poll_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;old_context jsonb;BEGIN
 SELECT context INTO old_context FROM public.polls WHERE academy_id=NEW.academy_id AND id=NEW.target_id;
 IF NEW.action='poll.change' THEN s=public.poll_source(NEW.payload->'anchor',(NEW.payload->>'audienceEffectiveAt')::timestamptz,NEW.payload->'recipients');IF s IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));ELSE NEW.privacy_bindings=NEW.privacy_bindings||public.poll_private_bindings(jsonb_build_object('source',s));END IF;END IF;
 IF old_context IS NOT NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||public.poll_private_bindings(old_context);ELSIF NEW.action IN('poll.withdraw','poll.close') THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));END IF;RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_poll_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('poll.change','poll.withdraw','poll.close')) EXECUTE FUNCTION public.poll_privacy();
REVOKE ALL ON FUNCTION public.poll_definition_valid(jsonb),public.poll_student_ids(jsonb),public.poll_source(jsonb,timestamptz,jsonb),public.poll_recipient_records_allow(jsonb,jsonb),public.poll_private_bindings(jsonb),public.guard_poll(),public.guard_poll_form(),public.guard_poll_revision(),public.require_poll_revision(),public.poll_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.poll_definition_valid(jsonb),public.poll_student_ids(jsonb),public.poll_source(jsonb,timestamptz,jsonb),public.poll_recipient_records_allow(jsonb,jsonb),public.poll_private_bindings(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 82 $$;

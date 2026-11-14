INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('report-comments.view','View selected student report discussions, not direct messages','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('report-comments.write','Verified staff replies and own edits in selected report discussions','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('report-comments.moderate','Propose or review comment hiding/restoration and read private revision evidence','Learning',true,ARRAY['hub','class','person','country','region','city']),
 ('received-comments.view','Read own or linked student report discussions','Learning',true,ARRAY['hub','person','country','region','city']),
 ('received-comments.write','Verified self or current guardian writes own replies to available reports','Learning',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.report_comments(
 academy_id uuid NOT NULL,id uuid NOT NULL,source_kind text NOT NULL CHECK(source_kind IN('class_report','student_feedback')),source_id uuid NOT NULL,
 publication_id uuid GENERATED ALWAYS AS(CASE WHEN source_kind='class_report' THEN source_id END) STORED,
 feedback_id uuid GENERATED ALWAYS AS(CASE WHEN source_kind='student_feedback' THEN source_id END) STORED,
 feedback_version integer GENERATED ALWAYS AS(CASE WHEN source_kind='student_feedback' THEN(context#>>'{source,version}')::integer END) STORED,
 student_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,posted_on date NOT NULL,
 author_id uuid NOT NULL,author_side text NOT NULL CHECK(author_side IN('family','staff')),reply_to uuid,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 10000 AND octet_length(body)<=32000),
 state text NOT NULL CHECK(state IN('visible','retracted','hidden')),last_action text NOT NULL CHECK(last_action IN('create','edit','retract','moderate')),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=8192),changed_by uuid NOT NULL,approval_id uuid,reason text CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),
 FOREIGN KEY(academy_id,publication_id) REFERENCES public.report_publications(academy_id,id),FOREIGN KEY(academy_id,feedback_id) REFERENCES public.student_feedback(academy_id,id),
 FOREIGN KEY(academy_id,feedback_id,feedback_version) REFERENCES public.student_feedback_revisions(academy_id,feedback_id,version),
 FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),FOREIGN KEY(academy_id,class_id) REFERENCES public.classes(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,author_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,reply_to) REFERENCES public.report_comments(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK((last_action='moderate')=(approval_id IS NOT NULL)),CHECK((last_action='moderate')=(reason IS NOT NULL))
);
CREATE INDEX report_comments_thread ON public.report_comments(academy_id,source_kind,source_id,student_id,created_at,id);
CREATE INDEX report_comments_author ON public.report_comments(academy_id,author_id,created_at);
CREATE TABLE public.report_comment_revisions(
 academy_id uuid NOT NULL,comment_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,comment_id,version),FOREIGN KEY(academy_id,comment_id) REFERENCES public.report_comments(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['report_comments','report_comment_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,source_kind,source_id,student_id,class_id,hub_id,posted_on,author_id,author_side,reply_to,body,state,last_action,context,changed_by) ON public.report_comments TO kavosh_runtime;
GRANT UPDATE(version,body,state,last_action,changed_by,approval_id,reason) ON public.report_comments TO kavosh_runtime;
GRANT INSERT(academy_id,comment_id,version,definition) ON public.report_comment_revisions TO kavosh_runtime;
-- Only anchor/version/eligibility facts: never copy report text, scores,
-- recipient lists, files or identity contacts into every comment.
CREATE FUNCTION public.report_discussion_source(p_kind text,p_source uuid,p_student uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r record;active boolean;media boolean:=false;on_date date;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.student_profiles WHERE academy_id=tenant AND person_id=p_student) THEN RETURN NULL;END IF;
 IF p_kind='class_report' THEN
  SELECT class_id,hub_id,session_id,report_version AS version,context#>>'{source,session,on}' AS on,EXISTS(SELECT 1 FROM jsonb_array_elements(context#>'{report,document,blocks}') b WHERE b->>'kind'='media') has_media INTO r FROM public.report_publications WHERE academy_id=tenant AND id=p_source;
  IF NOT FOUND THEN RETURN NULL;END IF;active=public.report_publication_active(p_source);media=r.has_media;
 ELSIF p_kind='student_feedback' THEN
  SELECT f.class_id,f.hub_id,f.session_id,f.version,f.context#>>'{source,session,on}' AS on,f.publish_to_family AND a.status='applied' AND a.reviewer_id=f.changed_by AND a.target_id=f.id AND a.action IN('student-feedback.record','student-feedback.edit') released INTO r
   FROM public.student_feedback f JOIN public.approval_requests a ON a.academy_id=f.academy_id AND a.id=f.approval_id WHERE f.academy_id=tenant AND f.id=p_source AND f.student_id=p_student;
  IF NOT FOUND THEN RETURN NULL;END IF;active=r.released;
 ELSE RETURN NULL;END IF;on_date=r.on::date;
 RETURN jsonb_build_object('kind',p_kind,'id',p_source,'version',r.version,'studentId',p_student,'classId',r.class_id,'hubId',r.hub_id,'sessionId',r.session_id,'on',on_date,'active',active,'hasMedia',media,
 'eligible',EXISTS(SELECT 1 FROM public.class_enrollments e JOIN public.people p ON p.academy_id=e.academy_id AND p.id=e.student_id WHERE e.academy_id=tenant AND e.class_id=r.class_id AND e.student_id=p_student AND p.status='active' AND e.enabled AND e.joins_on<=on_date AND(e.leaves_on IS NULL OR e.leaves_on>=on_date)));
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
CREATE FUNCTION public.report_comment_family(p_student uuid,p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT public.report_recipient(p_student,p_actor) AND(p_student=p_actor OR EXISTS(SELECT 1 FROM public.family_relationships f WHERE f.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND f.student_id=p_student AND f.guardian_id=p_actor AND f.relationship IN('parent','legal_guardian') AND f.state='approved' AND f.valid_from<=statement_timestamp() AND(f.valid_until IS NULL OR f.valid_until>statement_timestamp())))
$$;
-- The signer helper intentionally excludes staff. Keep that privacy boundary
-- unchanged; discussion writes need only this tenant-bound boolean, no contact
-- values, fingerprints, identity-table grants or caller-supplied verification.
CREATE FUNCTION public.report_comment_human_verified(p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.people p JOIN identity."user" u ON u.id=p.auth_user_id WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_actor AND p.kind='human' AND p.status='active' AND u."emailVerified" AND coalesce(u."phoneNumberVerified",false))
$$;
CREATE FUNCTION public.guard_report_comment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s jsonb;p record;reply record;BEGIN
 IF NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'COMMENT_VERIFIED_HUMAN_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.source_kind,NEW.source_id,NEW.student_id,NEW.class_id,NEW.hub_id,NEW.posted_on,NEW.author_id,NEW.author_side,NEW.reply_to,NEW.context,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.source_kind,OLD.source_id,OLD.student_id,OLD.class_id,OLD.hub_id,OLD.posted_on,OLD.author_id,OLD.author_side,OLD.reply_to,OLD.context,OLD.created_at) THEN RAISE EXCEPTION 'COMMENT_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 ELSE
  IF NEW.version<>1 OR NEW.state<>'visible' OR NEW.last_action<>'create' OR NEW.author_id<>NEW.changed_by THEN RAISE EXCEPTION 'COMMENT_OWN_CREATION_REQUIRED' USING ERRCODE='23514';END IF;
  -- ponytail: one short author quota lock, indexed recent-count check; replace
  -- with durable quota buckets only if measured comment traffic requires it.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':report-comments:'||NEW.author_id::text,32));
  IF(SELECT count(*) FROM public.report_comments WHERE academy_id=NEW.academy_id AND author_id=NEW.author_id AND created_at>clock_timestamp()-interval '1 minute')>=20 THEN RAISE EXCEPTION 'COMMENT_RATE_LIMITED' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.last_action='moderate' THEN
  SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
  IF TG_OP<>'UPDATE' OR p.id IS NULL OR p.action<>'report-comment.moderate' OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>OLD.version OR p.privacy_capability IS DISTINCT FROM 'report-comments.moderate' OR p.review_context IS DISTINCT FROM jsonb_build_object('record',to_jsonb(OLD))
   OR(p.payload->>'commentId')::uuid IS DISTINCT FROM NEW.id OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM OLD.version OR p.payload->>'state' IS DISTINCT FROM NEW.state OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR NEW.body IS DISTINCT FROM OLD.body
   OR NOT(OLD.state='visible' AND NEW.state='hidden' OR OLD.state='hidden' AND NEW.state='visible') THEN RAISE EXCEPTION 'COMMENT_EXACT_MODERATION_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  IF NEW.approval_id IS NOT NULL OR NEW.reason IS NOT NULL OR NEW.changed_by<>NEW.author_id THEN RAISE EXCEPTION 'COMMENT_OWN_EDIT_REQUIRED' USING ERRCODE='23514';END IF;
  s=public.report_discussion_source(NEW.source_kind,NEW.source_id,NEW.student_id);
  IF s IS NULL OR s->>'active'<>'true' OR s->>'eligible'<>'true' OR(s->>'classId')::uuid IS DISTINCT FROM NEW.class_id OR(s->>'hubId')::uuid IS DISTINCT FROM NEW.hub_id THEN RAISE EXCEPTION 'COMMENT_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF TG_OP='INSERT' AND(NEW.context IS DISTINCT FROM jsonb_build_object('source',s) OR NEW.posted_on IS DISTINCT FROM(s->>'on')::date) THEN RAISE EXCEPTION 'COMMENT_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF NEW.author_side='family' AND(NOT public.report_comment_family(NEW.student_id,NEW.author_id) OR NOT EXISTS(SELECT 1 FROM public.class_enrollments WHERE academy_id=NEW.academy_id AND class_id=NEW.class_id AND student_id=NEW.student_id AND enabled AND joins_on<=NEW.posted_on AND(leaves_on IS NULL OR leaves_on>=NEW.posted_on))) THEN RAISE EXCEPTION 'COMMENT_FAMILY_CHANGED' USING ERRCODE='23514';END IF;
  IF TG_OP='UPDATE' AND(OLD.state<>'visible' OR NOT(NEW.last_action='edit' AND NEW.state='visible' OR NEW.last_action='retract' AND NEW.state='retracted' AND NEW.body=OLD.body)) THEN RAISE EXCEPTION 'COMMENT_VISIBLE_OWN_EDIT_REQUIRED' USING ERRCODE='23514';END IF;
  IF NEW.reply_to IS NOT NULL THEN
   SELECT source_kind,source_id,student_id,posted_on,state INTO reply FROM public.report_comments WHERE academy_id=NEW.academy_id AND id=NEW.reply_to;
   IF reply.source_kind IS NULL OR ROW(reply.source_kind,reply.source_id,reply.student_id) IS DISTINCT FROM ROW(NEW.source_kind,NEW.source_id,NEW.student_id) OR(TG_OP='INSERT' AND reply.state<>'visible') OR(NEW.author_side='family' AND NOT EXISTS(SELECT 1 FROM public.class_enrollments WHERE academy_id=NEW.academy_id AND class_id=NEW.class_id AND student_id=NEW.student_id AND enabled AND joins_on<=reply.posted_on AND(leaves_on IS NULL OR leaves_on>=reply.posted_on))) THEN RAISE EXCEPTION 'COMMENT_REPLY_THREAD_CHANGED' USING ERRCODE='23514';END IF;
  END IF;
 END IF;NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER report_comment_guard BEFORE INSERT OR UPDATE ON public.report_comments FOR EACH ROW EXECUTE FUNCTION public.guard_report_comment();
CREATE FUNCTION public.guard_report_comment_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.report_comments c WHERE c.academy_id=NEW.academy_id AND c.id=NEW.comment_id AND c.version=NEW.version AND to_jsonb(c)=NEW.definition) THEN RAISE EXCEPTION 'COMMENT_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER report_comment_revision_guard BEFORE INSERT ON public.report_comment_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_report_comment_revision();
CREATE FUNCTION public.require_report_comment_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.report_comment_revisions c WHERE c.academy_id=NEW.academy_id AND c.comment_id=NEW.id AND c.version=NEW.version AND c.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'COMMENT_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NEW.last_action='moderate' AND NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'COMMENT_MODERATION_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_comment_revision_required AFTER INSERT OR UPDATE ON public.report_comments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_report_comment_revision();
CREATE FUNCTION public.report_comment_private_bindings(p_kind text,p_source uuid,p_student uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE s jsonb;t jsonb;class_scope jsonb;b jsonb;BEGIN
 s=public.report_discussion_source(p_kind,p_source,p_student);IF s IS NULL THEN RETURN jsonb_build_array(jsonb_build_object('unresolved',true));END IF;
 class_scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',s->'classId','hubId',s->'hubId')));
 t=class_scope||jsonb_build_object('people',jsonb_build_array(jsonb_build_object('id',p_student,'hubId',s->'hubId')),'recordContext',jsonb_build_object('classId',s->'classId','hubId',s->'hubId','studentId',p_student));
 b=jsonb_build_array(jsonb_build_object('capability','report-comments.view','scope',t));
 IF p_kind='class_report' THEN b=b||jsonb_build_array(jsonb_build_object('capability','report-publications.view','scope',class_scope),jsonb_build_object('capability','session-reports.view','scope',class_scope));IF s->>'hasMedia'='true' THEN b=b||jsonb_build_array(jsonb_build_object('capability','files.view','scope',class_scope));END IF;
 ELSE b=b||jsonb_build_array(jsonb_build_object('capability','student-feedback.view','scope',t));END IF;RETURN b;
END $$;
CREATE FUNCTION public.report_comment_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE c record;BEGIN
 SELECT source_kind,source_id,student_id INTO c FROM public.report_comments WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND id=(NEW.payload->>'commentId')::uuid;
 IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));ELSE NEW.privacy_bindings=NEW.privacy_bindings||public.report_comment_private_bindings(c.source_kind,c.source_id,c.student_id);END IF;RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_report_comment_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='report-comment.moderate') EXECUTE FUNCTION public.report_comment_privacy();
REVOKE ALL ON FUNCTION public.report_discussion_source(text,uuid,uuid),public.report_comment_family(uuid,uuid),public.report_comment_human_verified(uuid),public.guard_report_comment(),public.guard_report_comment_revision(),public.require_report_comment_revision(),public.report_comment_private_bindings(text,uuid,uuid),public.report_comment_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_discussion_source(text,uuid,uuid),public.report_comment_family(uuid,uuid),public.report_comment_human_verified(uuid),public.report_comment_private_bindings(text,uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 81 $$;

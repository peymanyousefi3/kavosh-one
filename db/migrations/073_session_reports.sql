INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('session-reports.view','Read private shared session report drafts and history','Learning',true,ARRAY['hub','class','country','region','city']),
 ('session-reports.record','Record shared report drafts for own assigned sessions','Learning',true,ARRAY['hub','class','country','region','city']),
 ('session-reports.edit','Propose upper-reviewed shared report draft corrections','Learning',true,ARRAY['hub','class','country','region','city']);
CREATE TABLE public.session_reports(
 academy_id uuid NOT NULL,session_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),session_version integer NOT NULL CHECK(session_version>0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object' AND octet_length(document::text)<=131072),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'),changed_by uuid NOT NULL,assignment_id uuid,assignment_version integer,approval_id uuid,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,session_id),FOREIGN KEY(academy_id,session_id,class_id,hub_id) REFERENCES public.class_sessions(academy_id,id,class_id,hub_id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,assignment_id,assignment_version) REFERENCES public.class_staff_revisions(academy_id,assignment_id,version),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK((approval_id IS NULL AND assignment_id IS NOT NULL AND assignment_version>0) OR(approval_id IS NOT NULL AND assignment_id IS NULL AND assignment_version IS NULL))
);
CREATE TABLE public.session_report_revisions(
 academy_id uuid NOT NULL,session_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,session_id,version),
 FOREIGN KEY(academy_id,session_id) REFERENCES public.session_reports(academy_id,session_id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['session_reports','session_report_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,session_id,class_id,hub_id,session_version,document,context,changed_by,assignment_id,assignment_version,approval_id,reason) ON public.session_reports TO kavosh_runtime;
GRANT UPDATE(version,session_version,document,context,changed_by,assignment_id,assignment_version,approval_id,reason) ON public.session_reports TO kavosh_runtime;
GRANT INSERT(academy_id,session_id,version,definition) ON public.session_report_revisions TO kavosh_runtime;

-- Draft metadata bindings only. A MIME claim/reference is not scanned media,
-- a physical upload, safe serving, parental publication or payroll evidence.
CREATE FUNCTION public.session_report_source(p_session uuid,p_document jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;s record;b jsonb;f record;media jsonb:='[]';ids uuid[]:='{}';file_ids uuid[]:='{}';block_id uuid;BEGIN
 SELECT x.*,c.time_zone,c.active AS class_active,c.version AS class_version INTO s FROM public.class_sessions x JOIN public.classes c ON c.academy_id=x.academy_id AND c.id=x.class_id WHERE x.academy_id=tenant AND x.id=p_session;
 IF s.id IS NULL OR s.time_info->>'timeZone' IS DISTINCT FROM s.time_zone OR coalesce(s.time_info->>'localStart','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$' OR s.time_info->>'startOffset' IS NULL
 OR((s.time_info->>'localStart')||(s.time_info->>'startOffset'))::timestamptz IS DISTINCT FROM s.starts_at OR(s.time_info->>'start')::timestamptz IS DISTINCT FROM s.starts_at THEN RETURN NULL;END IF;
 IF jsonb_typeof(p_document) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(p_document))<>3 OR jsonb_typeof(p_document->'title') IS DISTINCT FROM 'string'
 OR length(btrim(p_document->>'title')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(p_document->'locale') IS DISTINCT FROM 'string' OR p_document->>'locale' NOT IN('en','fr','zh-CN')
 OR jsonb_typeof(p_document->'blocks') IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 IF jsonb_array_length(p_document->'blocks') NOT BETWEEN 1 AND 100 OR octet_length(p_document::text)>131072 THEN RETURN NULL;END IF;
 FOR b IN SELECT value FROM jsonb_array_elements(p_document->'blocks') LOOP
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR jsonb_typeof(b->'id') IS DISTINCT FROM 'string' THEN RETURN NULL;END IF;
  block_id=(b->>'id')::uuid;IF block_id IS NULL OR block_id=ANY(ids) THEN RETURN NULL;END IF;ids=array_append(ids,block_id);
  IF b->>'kind'='text' THEN
   IF(SELECT count(*) FROM jsonb_object_keys(b))<>3 OR jsonb_typeof(b->'text') IS DISTINCT FROM 'string' OR length(btrim(b->>'text')) NOT BETWEEN 1 AND 10000 THEN RETURN NULL;END IF;
  ELSIF b->>'kind'='media' THEN
   IF(SELECT count(*) FROM jsonb_object_keys(b))<>6 OR jsonb_typeof(b->'fileId') IS DISTINCT FROM 'string' OR jsonb_typeof(b->'fileVersion') IS DISTINCT FROM 'number'
   OR jsonb_typeof(b->'mediaKind') IS DISTINCT FROM 'string' OR b->>'mediaKind' NOT IN('image','video') OR jsonb_typeof(b->'caption') IS DISTINCT FROM 'string' OR length(b->>'caption')>2000 THEN RETURN NULL;END IF;
   IF(b->>'fileId')::uuid=ANY(file_ids) OR cardinality(file_ids)>=20 THEN RETURN NULL;END IF;file_ids=array_append(file_ids,(b->>'fileId')::uuid);
   SELECT * INTO f FROM public.file_records WHERE academy_id=tenant AND id=(b->>'fileId')::uuid AND anchor_kind='class' AND class_id=s.class_id AND domain='general' AND NOT archived AND version=(b->>'fileVersion')::numeric;
   IF f.id IS NULL OR split_part(f.claimed_mime_type,'/',1) IS DISTINCT FROM b->>'mediaKind' THEN RETURN NULL;END IF;
   media=media||jsonb_build_array(jsonb_build_object('fileId',f.id,'fileVersion',f.version,'mediaKind',b->>'mediaKind','claimedMimeType',f.claimed_mime_type,'expectedBytes',f.expected_bytes,'expectedSha256',f.expected_sha256));
  ELSE RETURN NULL;END IF;
 END LOOP;
 RETURN jsonb_build_object('session',jsonb_build_object('id',s.id,'classId',s.class_id,'hubId',s.hub_id,'version',s.version,'classVersion',s.class_version,'classActive',s.class_active,'status',s.status,'startsAt',s.starts_at,'on',left(s.time_info->>'localStart',10)::date,'timeZone',s.time_zone),'media',media);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
CREATE FUNCTION public.guard_session_report() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actual jsonb;p record;a record;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.session_id,NEW.class_id,NEW.hub_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.session_id,OLD.class_id,OLD.hub_id,OLD.created_at) THEN RAISE EXCEPTION 'REPORT_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'REPORT_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 actual=public.session_report_source(NEW.session_id,NEW.document);
 IF actual IS NULL OR actual IS DISTINCT FROM NEW.context OR(actual#>>'{session,version}')::integer IS DISTINCT FROM NEW.session_version OR(actual#>>'{session,startsAt}')::timestamptz>clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'REPORT_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NEW.approval_id IS NULL THEN
  SELECT * INTO a FROM public.class_staff WHERE academy_id=NEW.academy_id AND id=NEW.assignment_id AND person_id=NEW.changed_by AND class_id=NEW.class_id;
  IF a.id IS NULL OR NOT a.active OR a.version IS DISTINCT FROM NEW.assignment_version OR a.starts_on>(actual#>>'{session,on}')::date OR(a.ends_on IS NOT NULL AND a.ends_on<(actual#>>'{session,on}')::date)
  OR actual#>>'{session,status}'<>'scheduled' OR actual#>>'{session,classActive}'<>'true' THEN RAISE EXCEPTION 'REPORT_ACTIVE_ASSIGNMENT_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
  IF p.id IS NULL OR p.action<>'session-report.correct' OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.session_id OR p.target_version<>coalesce(OLD.version,0) OR p.privacy_capability IS DISTINCT FROM 'session-reports.view'
  OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0) OR(p.payload->>'sessionVersion')::integer IS DISTINCT FROM NEW.session_version OR p.payload->'document' IS DISTINCT FROM NEW.document OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
  OR p.review_context IS DISTINCT FROM jsonb_build_object('report',CASE WHEN TG_OP='INSERT' THEN 'null'::jsonb ELSE to_jsonb(OLD) END,'source',actual) THEN RAISE EXCEPTION 'REPORT_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER session_report_guard BEFORE INSERT OR UPDATE ON public.session_reports FOR EACH ROW EXECUTE FUNCTION public.guard_session_report();
CREATE FUNCTION public.guard_report_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.session_reports e WHERE e.academy_id=NEW.academy_id AND e.session_id=NEW.session_id AND e.version=NEW.version AND to_jsonb(e)=NEW.definition) THEN RAISE EXCEPTION 'REPORT_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER report_revision_guard BEFORE INSERT ON public.session_report_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_report_revision();
CREATE FUNCTION public.require_report_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.session_report_revisions r WHERE r.academy_id=NEW.academy_id AND r.session_id=NEW.session_id AND r.version=NEW.version AND r.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'REPORT_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NEW.approval_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'REPORT_REVIEW_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_revision_required AFTER INSERT OR UPDATE ON public.session_reports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_report_revision();
CREATE FUNCTION public.session_report_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE ref jsonb;BEGIN
 FOR ref IN SELECT value FROM jsonb_array_elements(coalesce(NEW.payload#>'{document,blocks}','[]'::jsonb)) WHERE value->>'kind'='media' LOOP
  NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('fileId',(ref->>'fileId')::uuid));
 END LOOP;
 -- Corrections must not reveal removed historical media through their context.
 FOR ref IN SELECT value FROM jsonb_array_elements(coalesce(NEW.review_context#>'{report,document,blocks}','[]'::jsonb)) WHERE value->>'kind'='media' LOOP
  NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('fileId',(ref->>'fileId')::uuid));
 END LOOP;RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_session_report_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='session-report.correct') EXECUTE FUNCTION public.session_report_privacy();
REVOKE ALL ON FUNCTION public.session_report_source(uuid,jsonb),public.guard_session_report(),public.guard_report_revision(),public.require_report_revision(),public.session_report_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_report_source(uuid,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 73 $$;

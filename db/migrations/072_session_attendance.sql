INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('attendance.view','View shared private session attendance and revisions','Learning',true,ARRAY['hub','class','country','region','city']),
 ('attendance.record','Record shared attendance for own assigned sessions','Learning',true,ARRAY['hub','class','country','region','city']),
 ('attendance.edit','Propose upper-reviewed session attendance corrections','Learning',true,ARRAY['hub','class','country','region','city']);

CREATE TABLE public.session_attendance(
 academy_id uuid NOT NULL,session_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),session_version integer NOT NULL CHECK(session_version>0),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'),entries jsonb NOT NULL CHECK(jsonb_typeof(entries)='array' AND jsonb_array_length(entries)<=1000 AND octet_length(entries::text)<=524288),
 changed_by uuid NOT NULL,assignment_id uuid,assignment_version integer,approval_id uuid,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,session_id),
 FOREIGN KEY(academy_id,session_id,class_id,hub_id) REFERENCES public.class_sessions(academy_id,id,class_id,hub_id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,assignment_id,assignment_version) REFERENCES public.class_staff_revisions(academy_id,assignment_id,version),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK((approval_id IS NULL AND assignment_id IS NOT NULL AND assignment_version>0) OR(approval_id IS NOT NULL AND assignment_id IS NULL AND assignment_version IS NULL))
);
CREATE TABLE public.session_attendance_revisions(
 academy_id uuid NOT NULL,session_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,session_id,version),
 FOREIGN KEY(academy_id,session_id) REFERENCES public.session_attendance(academy_id,session_id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['session_attendance','session_attendance_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,session_id,class_id,hub_id,session_version,context,entries,changed_by,assignment_id,assignment_version,approval_id,reason) ON public.session_attendance TO kavosh_runtime;
GRANT UPDATE(version,session_version,context,entries,changed_by,assignment_id,assignment_version,approval_id,reason) ON public.session_attendance TO kavosh_runtime;
GRANT INSERT(academy_id,session_id,version,definition) ON public.session_attendance_revisions TO kavosh_runtime;

-- Current candidate membership, not waiver/admission clearance. Preserve the
-- session's civil-time evidence rather than interpreting its day in UTC.
CREATE FUNCTION public.session_attendance_source(p_session uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;s record;on_date date;members jsonb;BEGIN
 SELECT x.*,c.time_zone,c.active AS class_active,c.version AS class_version INTO s FROM public.class_sessions x JOIN public.classes c ON c.academy_id=x.academy_id AND c.id=x.class_id WHERE x.academy_id=tenant AND x.id=p_session;
 IF s.id IS NULL OR s.time_info->>'timeZone' IS DISTINCT FROM s.time_zone OR coalesce(s.time_info->>'localStart','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$' OR s.time_info->>'startOffset' IS NULL
 OR((s.time_info->>'localStart')||(s.time_info->>'startOffset'))::timestamptz IS DISTINCT FROM s.starts_at OR(s.time_info->>'start')::timestamptz IS DISTINCT FROM s.starts_at THEN RETURN NULL;END IF;
 on_date=left(s.time_info->>'localStart',10)::date;
 IF(SELECT count(*) FROM public.class_enrollments e WHERE e.academy_id=tenant AND e.class_id=s.class_id AND e.enabled AND e.joins_on<=on_date AND(e.leaves_on IS NULL OR e.leaves_on>=on_date))>1000 THEN RETURN jsonb_build_object('tooLarge',true);END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('enrollmentId',e.id,'enrollmentVersion',e.version,'studentId',e.student_id) ORDER BY e.id),'[]'::jsonb) INTO members
 FROM public.class_enrollments e WHERE e.academy_id=tenant AND e.class_id=s.class_id AND e.enabled AND e.joins_on<=on_date AND(e.leaves_on IS NULL OR e.leaves_on>=on_date);
 RETURN jsonb_build_object('sessionId',s.id,'classId',s.class_id,'hubId',s.hub_id,'sessionVersion',s.version,'classVersion',s.class_version,'classActive',s.class_active,'status',s.status,'startsAt',s.starts_at,'on',on_date,'timeZone',s.time_zone,'members',members);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN RETURN NULL;
END $$;
CREATE FUNCTION public.guard_session_attendance() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actual jsonb;p record;a record;x jsonb;ids jsonb;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.session_id,NEW.class_id,NEW.hub_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.session_id,OLD.class_id,OLD.hub_id,OLD.created_at) THEN RAISE EXCEPTION 'ATTENDANCE_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'ATTENDANCE_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 actual=public.session_attendance_source(NEW.session_id);
 IF actual IS NULL OR actual->>'tooLarge'='true' OR actual IS DISTINCT FROM NEW.context OR(actual->>'sessionVersion')::integer IS DISTINCT FROM NEW.session_version OR(actual->>'startsAt')::timestamptz>clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'ATTENDANCE_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(NEW.entries) LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(x))<>4 OR jsonb_typeof(x->'enrollmentId') IS DISTINCT FROM 'string' OR jsonb_typeof(x->'enrollmentVersion') IS DISTINCT FROM 'number'
  OR jsonb_typeof(x->'status') IS DISTINCT FROM 'string' OR x->>'status' NOT IN('present','late','absent','excused') OR jsonb_typeof(x->'note') IS DISTINCT FROM 'string' OR length(x->>'note')>1000 THEN RAISE EXCEPTION 'ATTENDANCE_ENTRIES_INVALID' USING ERRCODE='23514';END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('enrollmentId',v.item->'enrollmentId','enrollmentVersion',v.item->'enrollmentVersion') ORDER BY v.item->>'enrollmentId'),'[]'::jsonb) INTO ids FROM jsonb_array_elements(NEW.entries) AS v(item);
 IF ids IS DISTINCT FROM(SELECT coalesce(jsonb_agg(v.item-'studentId' ORDER BY v.item->>'enrollmentId'),'[]'::jsonb) FROM jsonb_array_elements(actual->'members') AS v(item)) THEN RAISE EXCEPTION 'ATTENDANCE_ROSTER_CHANGED' USING ERRCODE='23514';END IF;
 IF NEW.approval_id IS NULL THEN
  SELECT * INTO a FROM public.class_staff WHERE academy_id=NEW.academy_id AND id=NEW.assignment_id AND person_id=NEW.changed_by AND class_id=NEW.class_id;
  IF a.id IS NULL OR NOT a.active OR a.version IS DISTINCT FROM NEW.assignment_version OR a.starts_on>(actual->>'on')::date OR(a.ends_on IS NOT NULL AND a.ends_on<(actual->>'on')::date)
  OR actual->>'status'<>'scheduled' OR actual->>'classActive'<>'true' THEN RAISE EXCEPTION 'ATTENDANCE_ACTIVE_ASSIGNMENT_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
  IF p.id IS NULL OR p.action<>'attendance.correct' OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.session_id OR p.target_version<>coalesce(OLD.version,0) OR p.privacy_capability IS DISTINCT FROM 'attendance.view'
  OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0) OR(p.payload->>'sessionVersion')::integer IS DISTINCT FROM NEW.session_version OR p.payload->'entries' IS DISTINCT FROM NEW.entries OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
  OR p.review_context IS DISTINCT FROM jsonb_build_object('sheet',CASE WHEN TG_OP='INSERT' THEN 'null'::jsonb ELSE to_jsonb(OLD) END,'source',actual) THEN RAISE EXCEPTION 'ATTENDANCE_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER attendance_guard BEFORE INSERT OR UPDATE ON public.session_attendance FOR EACH ROW EXECUTE FUNCTION public.guard_session_attendance();
CREATE FUNCTION public.guard_attendance_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.session_attendance e WHERE e.academy_id=NEW.academy_id AND e.session_id=NEW.session_id AND e.version=NEW.version AND to_jsonb(e)=NEW.definition) THEN RAISE EXCEPTION 'ATTENDANCE_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER attendance_revision_guard BEFORE INSERT ON public.session_attendance_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_attendance_revision();
CREATE FUNCTION public.require_attendance_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.session_attendance_revisions r WHERE r.academy_id=NEW.academy_id AND r.session_id=NEW.session_id AND r.version=NEW.version AND r.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'ATTENDANCE_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NEW.approval_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'ATTENDANCE_REVIEW_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER attendance_revision_required AFTER INSERT OR UPDATE ON public.session_attendance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_attendance_revision();
CREATE FUNCTION public.attendance_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE c record;BEGIN
 SELECT class_id,hub_id INTO c FROM public.class_sessions WHERE academy_id=NEW.academy_id AND id=NEW.target_id;
 IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','rosters.view','scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',c.class_id,'hubId',c.hub_id)))));END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_attendance_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='attendance.correct') EXECUTE FUNCTION public.attendance_privacy();
REVOKE ALL ON FUNCTION public.session_attendance_source(uuid),public.guard_session_attendance(),public.guard_attendance_revision(),public.require_attendance_revision(),public.attendance_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_attendance_source(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 72 $$;

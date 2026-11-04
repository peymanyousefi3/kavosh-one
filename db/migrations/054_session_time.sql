INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('session-time.record','Read and record own assigned session time; never payroll approval','Learning',true,ARRAY['hub','class','country','region','city']),
 ('session-time.view','Read private session staff time and correction history','Learning',true,ARRAY['hub','class','country','region','city']),
 ('session-time.edit','Propose reviewed corrections to another staff time entry','Learning',true,ARRAY['hub','class','country','region','city']);
ALTER TABLE public.class_sessions ADD CONSTRAINT session_time_identity UNIQUE(academy_id,id,class_id,hub_id);
ALTER TABLE public.class_staff ADD CONSTRAINT staff_time_identity UNIQUE(academy_id,id,class_id,person_id);
CREATE TABLE public.session_time_entries (
 academy_id uuid NOT NULL,id uuid NOT NULL,session_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,person_id uuid NOT NULL,
 assignment_id uuid NOT NULL,assignment_version integer NOT NULL,session_version integer NOT NULL CHECK(session_version>0),
 scheduled_start timestamptz NOT NULL,scheduled_end timestamptz NOT NULL,
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),changed_by uuid NOT NULL,approval_id uuid,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,session_id,person_id),
 FOREIGN KEY(academy_id,session_id,class_id,hub_id) REFERENCES public.class_sessions(academy_id,id,class_id,hub_id),
 FOREIGN KEY(academy_id,assignment_id,class_id,person_id) REFERENCES public.class_staff(academy_id,id,class_id,person_id),
 FOREIGN KEY(academy_id,assignment_id,assignment_version) REFERENCES public.class_staff_revisions(academy_id,assignment_id,version),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK(ends_at>starts_at AND ends_at<=starts_at+interval '24 hours'),
 CHECK(starts_at=date_trunc('milliseconds',starts_at) AND ends_at=date_trunc('milliseconds',ends_at)),
 CHECK(scheduled_end>scheduled_start)
);
CREATE INDEX session_time_person ON public.session_time_entries(academy_id,person_id,session_id);
CREATE TABLE public.session_time_revisions (
 academy_id uuid NOT NULL,entry_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,entry_id,version),
 FOREIGN KEY(academy_id,entry_id) REFERENCES public.session_time_entries(academy_id,id)
);
CREATE FUNCTION public.validate_session_time() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s record;a record;p record;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.session_id,NEW.class_id,NEW.hub_id,NEW.person_id,NEW.assignment_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.session_id,OLD.class_id,OLD.hub_id,OLD.person_id,OLD.assignment_id,OLD.created_at) THEN RAISE EXCEPTION 'TIME_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 ELSE IF NEW.version<>1 OR NEW.approval_id IS NOT NULL THEN RAISE EXCEPTION 'TIME_INITIAL_SELF_RECORD_REQUIRED' USING ERRCODE='23514';END IF;END IF;
 SELECT x.version,x.starts_at,x.ends_at,x.status,c.time_zone INTO s FROM public.class_sessions x JOIN public.classes c ON c.academy_id=x.academy_id AND c.id=x.class_id WHERE x.academy_id=NEW.academy_id AND x.id=NEW.session_id;
 IF NOT FOUND OR s.version<>NEW.session_version OR s.starts_at<>NEW.scheduled_start OR s.ends_at<>NEW.scheduled_end THEN RAISE EXCEPTION 'TIME_SESSION_CHANGED' USING ERRCODE='23514';END IF;
 IF NEW.ends_at>clock_timestamp() THEN RAISE EXCEPTION 'TIME_FUTURE_END_FORBIDDEN' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.people x WHERE x.academy_id=NEW.academy_id AND x.id=NEW.changed_by AND x.kind='human') THEN RAISE EXCEPTION 'TIME_HUMAN_ACTOR_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.approval_id IS NULL THEN
  IF NEW.changed_by<>NEW.person_id OR s.status<>'scheduled' THEN RAISE EXCEPTION 'TIME_SELF_ASSIGNMENT_REQUIRED' USING ERRCODE='23514';END IF;
  SELECT x.* INTO a FROM public.class_staff x WHERE x.academy_id=NEW.academy_id AND x.id=NEW.assignment_id;
  IF NOT FOUND OR NOT a.active OR a.version<>NEW.assignment_version OR a.starts_on>(s.starts_at AT TIME ZONE s.time_zone)::date OR(a.ends_on IS NOT NULL AND a.ends_on<(s.starts_at AT TIME ZONE s.time_zone)::date) THEN RAISE EXCEPTION 'TIME_ACTIVE_ASSIGNMENT_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  IF NEW.assignment_version<>OLD.assignment_version THEN RAISE EXCEPTION 'TIME_ASSIGNMENT_BASIS_CHANGED' USING ERRCODE='23514';END IF;
  SELECT * INTO p FROM public.approval_requests x WHERE x.academy_id=NEW.academy_id AND x.id=NEW.approval_id;
  IF NOT FOUND OR p.action<>'session-time.correct' OR p.status<>'pending' OR p.target_id<>NEW.id OR p.target_version<>OLD.version
   OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM OLD.version OR(p.payload->>'sessionVersion')::integer IS DISTINCT FROM NEW.session_version
   OR(p.payload->>'startsAt')::timestamptz IS DISTINCT FROM NEW.starts_at OR(p.payload->>'endsAt')::timestamptz IS DISTINCT FROM NEW.ends_at
   OR p.payload->>'reason' IS DISTINCT FROM NEW.reason THEN RAISE EXCEPTION 'TIME_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER session_time_guard BEFORE INSERT OR UPDATE ON public.session_time_entries FOR EACH ROW EXECUTE FUNCTION public.validate_session_time();
CREATE FUNCTION public.validate_session_time_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.session_time_entries e WHERE e.academy_id=NEW.academy_id AND e.id=NEW.entry_id AND e.version=NEW.version AND to_jsonb(e)=NEW.definition) THEN RAISE EXCEPTION 'TIME_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER session_time_revision_guard BEFORE INSERT ON public.session_time_revisions FOR EACH ROW EXECUTE FUNCTION public.validate_session_time_revision();
CREATE FUNCTION public.require_session_time_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.session_time_revisions r WHERE r.academy_id=NEW.academy_id AND r.entry_id=NEW.id AND r.version=NEW.version AND r.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'TIME_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NEW.approval_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'TIME_CORRECTION_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER session_time_revision_required AFTER INSERT OR UPDATE ON public.session_time_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_session_time_revision();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['session_time_entries','session_time_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
END LOOP;END $$;
GRANT SELECT ON public.session_time_entries,public.session_time_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,id,session_id,class_id,hub_id,person_id,assignment_id,assignment_version,session_version,scheduled_start,scheduled_end,starts_at,ends_at,changed_by,reason) ON public.session_time_entries TO kavosh_runtime;
GRANT UPDATE(assignment_version,session_version,scheduled_start,scheduled_end,starts_at,ends_at,version,changed_by,approval_id,reason) ON public.session_time_entries TO kavosh_runtime;
GRANT INSERT(academy_id,entry_id,version,definition) ON public.session_time_revisions TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.validate_session_time(),public.validate_session_time_revision(),public.require_session_time_revision() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 54 $$;

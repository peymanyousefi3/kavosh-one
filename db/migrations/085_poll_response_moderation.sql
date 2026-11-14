INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('poll-responses.moderate','Propose upper-reviewed inclusion or exclusion of an exact submitted response revision','Learning',true,ARRAY['hub','class','person','country','region','city']);
CREATE TABLE public.poll_response_moderation(
 academy_id uuid NOT NULL,id uuid NOT NULL,response_id uuid NOT NULL,response_version integer NOT NULL CHECK(response_version>0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),excluded boolean NOT NULL,source jsonb NOT NULL CHECK(jsonb_typeof(source)='object' AND octet_length(source::text)<=4096),
 requested_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,response_id,response_version),
 FOREIGN KEY(academy_id,response_id,response_version) REFERENCES public.poll_response_revisions(academy_id,response_id,version),
 FOREIGN KEY(academy_id,requested_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.poll_response_moderation_revisions(
 academy_id uuid NOT NULL,moderation_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,moderation_id,version),FOREIGN KEY(academy_id,moderation_id) REFERENCES public.poll_response_moderation(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['poll_response_moderation','poll_response_moderation_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,response_id,response_version,excluded,source,requested_by,changed_by,approval_id,reason) ON public.poll_response_moderation TO kavosh_runtime;
GRANT UPDATE(version,excluded,requested_by,changed_by,approval_id,reason) ON public.poll_response_moderation TO kavosh_runtime;
GRANT INSERT(academy_id,moderation_id,version,definition) ON public.poll_response_moderation_revisions TO kavosh_runtime;
-- Minimal source, not a second copy of the private answer or school audience.
CREATE FUNCTION public.poll_moderation_source(p_response uuid,p_version integer) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('responseId',r.id,'responseVersion',r.version,'pollId',r.poll_id,'formVersion',r.form_version,'studentId',r.student_id,'classId',r.class_id,'hubId',r.hub_id,'on',r.posted_on,'createdBy',r.created_by,'lastActor',r.changed_by,'state',r.state)
 FROM public.poll_responses r WHERE r.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND r.id=p_response AND r.version=p_version AND r.state='submitted'
$$;
CREATE FUNCTION public.guard_poll_response_moderation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;s jsonb;previous jsonb;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.response_id,NEW.response_version,NEW.source,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.response_id,OLD.response_version,OLD.source,OLD.created_at) THEN RAISE EXCEPTION 'POLL_MODERATION_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;previous=to_jsonb(OLD);
 ELSE IF NEW.version<>1 OR NOT NEW.excluded THEN RAISE EXCEPTION 'POLL_MODERATION_INITIAL_EXCLUSION_REQUIRED' USING ERRCODE='23514';END IF;END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=public.poll_moderation_source(NEW.response_id,NEW.response_version);
 IF s IS NULL OR NEW.source IS DISTINCT FROM s THEN RAISE EXCEPTION 'POLL_MODERATION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF p.id IS NULL OR p.action<>'poll-response.moderate' OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>coalesce(OLD.version,0) OR p.privacy_capability IS DISTINCT FROM 'poll-responses.moderate'
 OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous,'source',s) OR NEW.requested_by IS DISTINCT FROM p.requester_id OR NOT public.report_comment_human_verified(NEW.changed_by)
 OR(p.payload->>'responseId')::uuid IS DISTINCT FROM NEW.response_id OR(p.payload->>'responseVersion')::integer IS DISTINCT FROM NEW.response_version OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0)
 OR(p.payload->>'excluded')::boolean IS DISTINCT FROM NEW.excluded OR p.payload->>'reason' IS DISTINCT FROM NEW.reason THEN RAISE EXCEPTION 'POLL_MODERATION_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.changed_at=clock_timestamp();IF TG_OP='INSERT' THEN NEW.created_at=NEW.changed_at;END IF;RETURN NEW;
END $$;
CREATE TRIGGER poll_response_moderation_guard BEFORE INSERT OR UPDATE ON public.poll_response_moderation FOR EACH ROW EXECUTE FUNCTION public.guard_poll_response_moderation();
CREATE FUNCTION public.guard_poll_moderation_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.poll_response_moderation m WHERE m.academy_id=NEW.academy_id AND m.id=NEW.moderation_id AND m.version=NEW.version AND to_jsonb(m)=NEW.definition) THEN RAISE EXCEPTION 'POLL_MODERATION_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER poll_moderation_revision_guard BEFORE INSERT ON public.poll_response_moderation_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_poll_moderation_revision();
CREATE FUNCTION public.require_poll_moderation_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.poll_response_moderation_revisions m WHERE m.academy_id=NEW.academy_id AND m.moderation_id=NEW.id AND m.version=NEW.version AND m.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'POLL_MODERATION_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'POLL_MODERATION_REVIEW_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER poll_moderation_revision_required AFTER INSERT OR UPDATE ON public.poll_response_moderation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_poll_moderation_revision();
CREATE FUNCTION public.poll_moderation_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s jsonb;t jsonb;BEGIN
 s=public.poll_moderation_source((NEW.payload->>'responseId')::uuid,(NEW.payload->>'responseVersion')::integer);
 IF s IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 t=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',s->'classId','hubId',s->'hubId')),'people',jsonb_build_array(jsonb_build_object('id',s->'studentId','hubId',s->'hubId')),'recordContext',jsonb_build_object('classId',s->'classId','hubId',s->'hubId','studentId',s->'studentId'));
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','polls.view','scope',t),jsonb_build_object('capability','poll-responses.view','scope',t));RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_poll_moderation_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='poll-response.moderate') EXECUTE FUNCTION public.poll_moderation_privacy();
REVOKE ALL ON FUNCTION public.poll_moderation_source(uuid,integer),public.guard_poll_response_moderation(),public.guard_poll_moderation_revision(),public.require_poll_moderation_revision(),public.poll_moderation_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.poll_moderation_source(uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 85 $$;

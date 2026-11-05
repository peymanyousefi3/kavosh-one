INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('poll-templates.view','View explicitly permitted school, hub or class question templates','Learning',true,ARRAY['hub','class','country','region','city']),
 ('poll-templates.edit','Propose reviewed question-template creation, revision or independent copy','Learning',true,ARRAY['hub','class','country','region','city']);
CREATE TABLE public.poll_templates(
 academy_id uuid NOT NULL,id uuid NOT NULL,anchor jsonb NOT NULL,hub_id uuid,class_id uuid,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 active boolean NOT NULL,definition jsonb NOT NULL CHECK(public.poll_definition_valid(definition)),response_unit text NOT NULL CHECK(response_unit IN('student_family','guardian_per_student')),respondent_mode text NOT NULL CHECK(respondent_mode IN('guardians','students','both')),
 copied_from_id uuid,copied_from_version integer,created_by uuid NOT NULL,recorded_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),
 CHECK((copied_from_id IS NULL)=(copied_from_version IS NULL)),CHECK(copied_from_id IS NULL OR(copied_from_id<>id AND copied_from_version>0)),
 FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,class_id) REFERENCES public.classes(academy_id,id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,recorded_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX poll_templates_owner ON public.poll_templates(academy_id,hub_id,class_id,id);
CREATE TABLE public.poll_template_revisions(
 academy_id uuid NOT NULL,template_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,template_id,version),FOREIGN KEY(academy_id,template_id) REFERENCES public.poll_templates(academy_id,id)
);
ALTER TABLE public.poll_templates ADD FOREIGN KEY(academy_id,copied_from_id,copied_from_version) REFERENCES public.poll_template_revisions(academy_id,template_id,version);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['poll_templates','poll_template_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,anchor,hub_id,class_id,active,definition,response_unit,respondent_mode,copied_from_id,copied_from_version,created_by,recorded_by,changed_by,approval_id,reason) ON public.poll_templates TO kavosh_runtime;
GRANT UPDATE(version,active,definition,response_unit,respondent_mode,recorded_by,changed_by,approval_id,reason) ON public.poll_templates TO kavosh_runtime;
GRANT INSERT(academy_id,template_id,version,definition) ON public.poll_template_revisions TO kavosh_runtime;
CREATE FUNCTION public.poll_template_basis(p_id uuid,p_anchor jsonb,p_copy uuid,p_version integer) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r record;c public.poll_templates%ROWTYPE;owner jsonb;BEGIN
 SELECT * INTO r FROM public.poll_templates WHERE academy_id=tenant AND id=p_id;
 owner=public.poll_source(p_anchor,statement_timestamp(),'[]'::jsonb)->'owner';IF owner IS NULL THEN RETURN NULL;END IF;
 IF r.id IS NULL AND p_copy IS NOT NULL THEN SELECT * INTO c FROM public.poll_templates WHERE academy_id=tenant AND id=p_copy AND version=p_version;IF c.id IS NULL THEN RETURN NULL;END IF;END IF;
 RETURN jsonb_build_object('record',CASE WHEN r.id IS NULL THEN 'null'::jsonb ELSE to_jsonb(r) END,'owner',owner,'copy',CASE WHEN r.id IS NOT NULL OR p_copy IS NULL THEN 'null'::jsonb ELSE to_jsonb(c) END);
END $$;
CREATE FUNCTION public.guard_poll_template() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;b jsonb;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.anchor,NEW.hub_id,NEW.class_id,NEW.copied_from_id,NEW.copied_from_version,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.anchor,OLD.hub_id,OLD.class_id,OLD.copied_from_id,OLD.copied_from_version,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'POLL_TEMPLATE_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 ELSE IF NEW.version<>1 THEN RAISE EXCEPTION 'POLL_TEMPLATE_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;END IF;
 b=public.poll_template_basis(NEW.id,NEW.anchor,NEW.copied_from_id,NEW.copied_from_version);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>coalesce(OLD.version,0) OR p.privacy_capability IS DISTINCT FROM 'poll-templates.view' OR p.review_context IS DISTINCT FROM b
 OR p.payload->'definition' IS DISTINCT FROM NEW.definition OR(p.payload->>'active')::boolean IS DISTINCT FROM NEW.active OR p.payload->>'responseUnit' IS DISTINCT FROM NEW.response_unit OR p.payload->>'respondentMode' IS DISTINCT FROM NEW.respondent_mode OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 OR NEW.recorded_by IS DISTINCT FROM p.requester_id OR NOT public.report_comment_human_verified(NEW.changed_by) OR(b#>>'{owner,hubId}')::uuid IS DISTINCT FROM NEW.hub_id OR(b#>>'{owner,classId}')::uuid IS DISTINCT FROM NEW.class_id
 OR(NEW.active AND b#>>'{owner,active}'<>'true') THEN RAISE EXCEPTION 'POLL_TEMPLATE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF p.action<>'poll-template.create' OR p.payload->'anchor' IS DISTINCT FROM NEW.anchor OR NEW.created_by IS DISTINCT FROM p.requester_id
  OR(p.payload#>>'{copiedFrom,id}')::uuid IS DISTINCT FROM NEW.copied_from_id OR(p.payload#>>'{copiedFrom,version}')::integer IS DISTINCT FROM NEW.copied_from_version
  OR(NEW.copied_from_id IS NOT NULL AND((NEW.definition-'title') IS DISTINCT FROM((b#>'{copy,definition}')-'title') OR NEW.response_unit IS DISTINCT FROM b#>>'{copy,response_unit}' OR NEW.respondent_mode IS DISTINCT FROM b#>>'{copy,respondent_mode}' OR NEW.active IS DISTINCT FROM(b#>>'{copy,active}')::boolean)) THEN RAISE EXCEPTION 'POLL_TEMPLATE_EXACT_COPY_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE IF p.action<>'poll-template.update' OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM OLD.version THEN RAISE EXCEPTION 'POLL_TEMPLATE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;END IF;
 NEW.changed_at=clock_timestamp();IF TG_OP='INSERT' THEN NEW.created_at=NEW.changed_at;END IF;RETURN NEW;
END $$;
CREATE TRIGGER poll_template_guard BEFORE INSERT OR UPDATE ON public.poll_templates FOR EACH ROW EXECUTE FUNCTION public.guard_poll_template();
CREATE FUNCTION public.guard_poll_template_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.poll_templates t WHERE t.academy_id=NEW.academy_id AND t.id=NEW.template_id AND t.version=NEW.version AND to_jsonb(t)=NEW.definition) THEN RAISE EXCEPTION 'POLL_TEMPLATE_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER poll_template_revision_guard BEFORE INSERT ON public.poll_template_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_poll_template_revision();
CREATE FUNCTION public.require_poll_template_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.poll_template_revisions t WHERE t.academy_id=NEW.academy_id AND t.template_id=NEW.id AND t.version=NEW.version AND t.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'POLL_TEMPLATE_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'POLL_TEMPLATE_REVIEW_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER poll_template_revision_required AFTER INSERT OR UPDATE ON public.poll_templates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_poll_template_revision();
CREATE FUNCTION public.poll_template_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t record;s jsonb;BEGIN
 IF NEW.action='poll-template.create' AND NEW.payload->'copiedFrom'<>'null'::jsonb THEN
  SELECT anchor,hub_id,class_id INTO t FROM public.poll_templates WHERE academy_id=NEW.academy_id AND id=(NEW.payload#>>'{copiedFrom,id}')::uuid;
  IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
  s=CASE WHEN t.anchor->>'kind'='academy' THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) WHEN t.class_id IS NOT NULL THEN jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',t.class_id,'hubId',t.hub_id))) ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(t.hub_id)) END;
  NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','poll-templates.view','scope',s));
 END IF;RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_poll_template_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('poll-template.create','poll-template.update')) EXECUTE FUNCTION public.poll_template_privacy();
REVOKE ALL ON FUNCTION public.poll_template_basis(uuid,jsonb,uuid,integer),public.guard_poll_template(),public.guard_poll_template_revision(),public.require_poll_template_revision(),public.poll_template_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.poll_template_basis(uuid,jsonb,uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 86 $$;

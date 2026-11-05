INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('assessment-rubrics.view','View shared and permitted hub assessment criteria','Learning',true,ARRAY['hub','country','region','city']),
 ('assessment-rubrics.edit','Request reviewed assessment-rubric creation, copy or revision','Learning',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.assessment_rubrics(
 academy_id uuid NOT NULL,id uuid NOT NULL,hub_id uuid,version integer NOT NULL DEFAULT 1 CHECK(version>0),definition jsonb NOT NULL,
 copied_from_id uuid,copied_from_version integer,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK((copied_from_id IS NULL)=(copied_from_version IS NULL)),CHECK(copied_from_id IS NULL OR copied_from_id<>id)
);
CREATE INDEX assessment_rubric_hub ON public.assessment_rubrics(academy_id,hub_id,id);
CREATE TABLE public.assessment_rubric_revisions(
 academy_id uuid NOT NULL,rubric_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,rubric_id,version),FOREIGN KEY(academy_id,rubric_id) REFERENCES public.assessment_rubrics(academy_id,id)
);
ALTER TABLE public.assessment_rubrics ADD CONSTRAINT assessment_copy_revision FOREIGN KEY(academy_id,copied_from_id,copied_from_version) REFERENCES public.assessment_rubric_revisions(academy_id,rubric_id,version);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['assessment_rubrics','assessment_rubric_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,hub_id,definition,copied_from_id,copied_from_version,changed_by,approval_id,reason) ON public.assessment_rubrics TO kavosh_runtime;
GRANT UPDATE(version,definition,changed_by,approval_id,reason) ON public.assessment_rubrics TO kavosh_runtime;
GRANT INSERT(academy_id,rubric_id,version,definition) ON public.assessment_rubric_revisions TO kavosh_runtime;
CREATE FUNCTION public.assessment_rubric_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE c jsonb;labels jsonb;codes text[]:='{}';BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF(SELECT count(*) FROM jsonb_object_keys(d))<>4 OR jsonb_typeof(d->'name') IS DISTINCT FROM 'string' OR length(d->>'name') NOT BETWEEN 1 AND 200 OR length(btrim(d->>'name'))=0
 OR jsonb_typeof(d->'description') IS DISTINCT FROM 'string' OR length(d->>'description')>2000 OR jsonb_typeof(d->'active') IS DISTINCT FROM 'boolean' OR jsonb_typeof(d->'criteria') IS DISTINCT FROM 'array' OR octet_length(d::text)>65536 THEN RETURN false;END IF;
 IF jsonb_array_length(d->'criteria') NOT BETWEEN 1 AND 30 THEN RETURN false;END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(d->'criteria') LOOP
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF(SELECT count(*) FROM jsonb_object_keys(c))<>2 OR jsonb_typeof(c->'code') IS DISTINCT FROM 'string' OR c->>'code'!~'^[a-z][a-z0-9_]{0,39}$' OR c->>'code'=ANY(codes) OR jsonb_typeof(c->'labels') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  codes=array_append(codes,c->>'code');labels=c->'labels';
  IF NOT labels?'en' OR(SELECT count(*) FROM jsonb_object_keys(labels)) NOT BETWEEN 1 AND 3 OR EXISTS(SELECT 1 FROM jsonb_each(labels) l WHERE l.key NOT IN('en','fr','zh-CN') OR jsonb_typeof(l.value)<>'string' OR length(l.value#>>'{}') NOT BETWEEN 1 AND 150 OR length(btrim(l.value#>>'{}'))=0) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
ALTER TABLE public.assessment_rubrics ADD CONSTRAINT assessment_definition_valid CHECK(public.assessment_rubric_valid(definition));
CREATE FUNCTION public.assessment_rubric_basis(p_id uuid,p_hub uuid,p_copy uuid,p_copy_version integer) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r record;h record;copied record;BEGIN
 SELECT * INTO r FROM public.assessment_rubrics WHERE academy_id=tenant AND id=p_id;
 SELECT id,version,active INTO h FROM public.hubs WHERE academy_id=tenant AND id=p_hub;
 IF p_hub IS NOT NULL AND h.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO copied FROM public.assessment_rubrics WHERE academy_id=tenant AND id=p_copy AND version=p_copy_version;
 IF r.id IS NULL AND p_copy IS NOT NULL THEN
  IF copied.id IS NULL THEN RETURN NULL;END IF;
 END IF;
 RETURN jsonb_build_object('rubric',CASE WHEN r.id IS NULL THEN 'null'::jsonb ELSE to_jsonb(r) END,'hub',CASE WHEN p_hub IS NULL THEN 'null'::jsonb ELSE to_jsonb(h) END,
 'copy',CASE WHEN r.id IS NOT NULL OR p_copy IS NULL THEN 'null'::jsonb ELSE to_jsonb(copied) END);
END $$;
CREATE FUNCTION public.guard_assessment_rubric() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;actual jsonb;BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.hub_id,NEW.copied_from_id,NEW.copied_from_version,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.hub_id,OLD.copied_from_id,OLD.copied_from_version,OLD.created_at) THEN RAISE EXCEPTION 'RUBRIC_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'RUBRIC_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 actual=public.assessment_rubric_basis(NEW.id,NEW.hub_id,NEW.copied_from_id,NEW.copied_from_version);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF actual IS NULL OR p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.privacy_capability IS DISTINCT FROM 'assessment-rubrics.view'
 OR p.review_context IS DISTINCT FROM actual OR p.payload->'definition' IS DISTINCT FROM NEW.definition OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active')
 OR((NEW.definition->>'active')::boolean AND NEW.hub_id IS NOT NULL AND actual#>>'{hub,active}'<>'true') THEN RAISE EXCEPTION 'RUBRIC_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF p.action<>'assessment-rubric.create' OR p.target_version<>0 OR(p.payload->>'hubId')::uuid IS DISTINCT FROM NEW.hub_id
  OR(p.payload#>>'{copiedFrom,id}')::uuid IS DISTINCT FROM NEW.copied_from_id OR(p.payload#>>'{copiedFrom,version}')::integer IS DISTINCT FROM NEW.copied_from_version
  OR(NEW.copied_from_id IS NOT NULL AND(NEW.definition-'name') IS DISTINCT FROM((actual#>'{copy,definition}')-'name')) THEN RAISE EXCEPTION 'RUBRIC_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE IF p.action<>'assessment-rubric.update' OR p.target_version<>OLD.version OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM OLD.version THEN RAISE EXCEPTION 'RUBRIC_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;END IF;
 NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER assessment_rubric_guard BEFORE INSERT OR UPDATE ON public.assessment_rubrics FOR EACH ROW EXECUTE FUNCTION public.guard_assessment_rubric();
CREATE FUNCTION public.guard_assessment_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.assessment_rubrics r WHERE r.academy_id=NEW.academy_id AND r.id=NEW.rubric_id AND r.version=NEW.version AND to_jsonb(r)=NEW.definition) THEN RAISE EXCEPTION 'RUBRIC_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER assessment_revision_guard BEFORE INSERT ON public.assessment_rubric_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_assessment_revision();
CREATE FUNCTION public.require_assessment_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.assessment_rubric_revisions r WHERE r.academy_id=NEW.academy_id AND r.rubric_id=NEW.id AND r.version=NEW.version AND r.definition=to_jsonb(NEW)) THEN RAISE EXCEPTION 'RUBRIC_REVISION_MISSING' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'RUBRIC_REVIEW_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER assessment_revision_required AFTER INSERT OR UPDATE ON public.assessment_rubrics DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_assessment_revision();
CREATE FUNCTION public.assessment_rubric_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE hub uuid;BEGIN
 IF NEW.action='assessment-rubric.create' AND NEW.payload->'copiedFrom'<>'null'::jsonb THEN
  SELECT hub_id INTO hub FROM public.assessment_rubrics WHERE academy_id=NEW.academy_id AND id=(NEW.payload#>>'{copiedFrom,id}')::uuid;
  IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));
  ELSIF hub IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','assessment-rubrics.view','any',true));
  ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('assessment-rubrics.view',ARRAY[hub]));END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_assessment_rubric_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('assessment-rubric.create','assessment-rubric.update')) EXECUTE FUNCTION public.assessment_rubric_privacy();
REVOKE ALL ON FUNCTION public.assessment_rubric_valid(jsonb),public.assessment_rubric_basis(uuid,uuid,uuid,integer),public.guard_assessment_rubric(),public.guard_assessment_revision(),public.require_assessment_revision(),public.assessment_rubric_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assessment_rubric_valid(jsonb),public.assessment_rubric_basis(uuid,uuid,uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 75 $$;

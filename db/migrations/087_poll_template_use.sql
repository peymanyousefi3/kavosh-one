CREATE TABLE public.poll_template_uses(
 academy_id uuid NOT NULL,poll_id uuid NOT NULL,poll_version integer NOT NULL DEFAULT 1 CHECK(poll_version=1),template_id uuid NOT NULL,template_version integer NOT NULL CHECK(template_version>0),approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,poll_id),FOREIGN KEY(academy_id,poll_id) REFERENCES public.polls(academy_id,id),
 FOREIGN KEY(academy_id,template_id,template_version) REFERENCES public.poll_template_revisions(academy_id,template_id,version),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.poll_template_uses ADD FOREIGN KEY(academy_id,poll_id,poll_version) REFERENCES public.poll_revisions(academy_id,poll_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.poll_template_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poll_template_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.poll_template_uses USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.poll_template_uses TO kavosh_runtime;
GRANT INSERT(academy_id,poll_id,template_id,template_version,approval_id) ON public.poll_template_uses TO kavosh_runtime;
-- Read current active sources with fresh snapshots, including native writes
-- made by another trigger in this transaction. No audience is resolved here.
CREATE FUNCTION public.poll_template_poll_source(p_id uuid,p_version integer) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',t.id,'version',t.version,'definition',t.definition,'responseUnit',t.response_unit,'respondentMode',t.respondent_mode)
 FROM public.poll_templates t WHERE t.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND t.id=p_id AND t.version=p_version AND t.active
 AND public.poll_source(t.anchor,statement_timestamp(),'[]'::jsonb)#>>'{owner,active}'='true'
$$;
CREATE FUNCTION public.poll_template_poll_matches(p_ref jsonb,p_definition jsonb,p_unit text,p_mode text) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE s jsonb;v numeric;BEGIN
 IF jsonb_typeof(p_ref) IS DISTINCT FROM 'object' OR jsonb_typeof(p_definition) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF(SELECT count(*) FROM jsonb_object_keys(p_ref))<>2 OR jsonb_typeof(p_ref->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(p_ref->'version') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
 v=(p_ref->>'version')::numeric;IF v NOT BETWEEN 1 AND 2147483647 OR trunc(v)<>v THEN RETURN false;END IF;
 s=public.poll_template_poll_source((p_ref->>'id')::uuid,v::integer);
 RETURN s IS NOT NULL AND((s->'definition')-'title') IS NOT DISTINCT FROM(p_definition-'title') AND s->>'responseUnit' IS NOT DISTINCT FROM p_unit AND s->>'respondentMode' IS NOT DISTINCT FROM p_mode;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END $$;
CREATE FUNCTION public.guard_templated_poll() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE body jsonb;BEGIN
 SELECT payload INTO body FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF body?'templateSource' THEN
  IF TG_OP<>'INSERT' OR NEW.version<>1 OR NEW.state<>'draft' OR NOT public.poll_template_poll_matches(body->'templateSource',NEW.definition,NEW.response_unit,NEW.respondent_mode) THEN RAISE EXCEPTION 'POLL_TEMPLATE_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER poll_template_source_guard BEFORE INSERT OR UPDATE ON public.polls FOR EACH ROW EXECUTE FUNCTION public.guard_templated_poll();
CREATE FUNCTION public.guard_poll_template_use() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record;BEGIN
 SELECT p.id,p.version,p.state,p.definition,p.response_unit,p.respondent_mode,p.approval_id,a.action,a.status,a.payload,a.target_id INTO r
 FROM public.polls p JOIN public.approval_requests a ON a.academy_id=p.academy_id AND a.id=p.approval_id WHERE p.academy_id=NEW.academy_id AND p.id=NEW.poll_id;
 IF r.id IS NULL OR r.version<>1 OR r.state<>'draft' OR r.action<>'poll.change' OR r.status<>'pending' OR r.target_id IS DISTINCT FROM NEW.poll_id OR r.approval_id IS DISTINCT FROM NEW.approval_id
 OR(r.payload#>>'{templateSource,id}')::uuid IS DISTINCT FROM NEW.template_id OR(r.payload#>>'{templateSource,version}')::integer IS DISTINCT FROM NEW.template_version
 OR NOT public.poll_template_poll_matches(r.payload->'templateSource',r.definition,r.response_unit,r.respondent_mode) THEN RAISE EXCEPTION 'POLL_TEMPLATE_USE_EXACT_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER poll_template_use_guard BEFORE INSERT ON public.poll_template_uses FOR EACH ROW EXECUTE FUNCTION public.guard_poll_template_use();
CREATE FUNCTION public.require_poll_template_use() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE body jsonb;BEGIN
 SELECT payload INTO body FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF body?'templateSource' THEN
  IF NOT public.poll_template_poll_matches(body->'templateSource',NEW.definition,NEW.response_unit,NEW.respondent_mode)
  OR NOT EXISTS(SELECT 1 FROM public.poll_template_uses u WHERE u.academy_id=NEW.academy_id AND u.poll_id=NEW.id AND u.template_id=(body#>>'{templateSource,id}')::uuid AND u.template_version=(body#>>'{templateSource,version}')::integer AND u.approval_id=NEW.approval_id) THEN RAISE EXCEPTION 'POLL_TEMPLATE_USE_MISSING_OR_STALE' USING ERRCODE='23514';END IF;
 END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER poll_template_use_required AFTER INSERT ON public.polls DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_poll_template_use();
CREATE OR REPLACE FUNCTION public.poll_template_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE t record;s jsonb;source_id uuid;BEGIN
 IF NEW.action='poll-template.create' AND NEW.payload->'copiedFrom'<>'null'::jsonb THEN source_id=(NEW.payload#>>'{copiedFrom,id}')::uuid;
 ELSIF NEW.action='poll.change' AND NEW.payload?'templateSource' THEN source_id=(NEW.payload#>>'{templateSource,id}')::uuid;
 ELSE RETURN NEW;END IF;
 SELECT anchor,hub_id,class_id INTO t FROM public.poll_templates WHERE academy_id=NEW.academy_id AND id=source_id;
 IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 s=CASE WHEN t.anchor->>'kind'='academy' THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) WHEN t.class_id IS NOT NULL THEN jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',t.class_id,'hubId',t.hub_id))) ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(t.hub_id)) END;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','poll-templates.view','scope',s));RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_poll_template_use_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='poll.change' AND NEW.payload?'templateSource') EXECUTE FUNCTION public.poll_template_privacy();
REVOKE ALL ON FUNCTION public.poll_template_poll_source(uuid,integer),public.poll_template_poll_matches(jsonb,jsonb,text,text),public.guard_templated_poll(),public.guard_poll_template_use(),public.require_poll_template_use() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.poll_template_poll_source(uuid,integer),public.poll_template_poll_matches(jsonb,jsonb,text,text) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 87 $$;

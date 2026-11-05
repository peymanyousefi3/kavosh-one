-- Reviewed non-secret destinations,not credentials,bucket/IAM certification,
-- automatic copying,download clearance or a claim of malware-free content.
CREATE TABLE public.file_storage_routes(
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id)
);
CREATE TABLE public.file_storage_route_revisions(
 academy_id uuid NOT NULL,route_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL,source_snapshot jsonb NOT NULL,
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,route_id,version),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,route_id) REFERENCES public.file_storage_routes(academy_id,id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.file_storage_routes ADD CONSTRAINT file_storage_route_current_revision FOREIGN KEY(academy_id,id,version)
 REFERENCES public.file_storage_route_revisions(academy_id,route_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER file_storage_route_header BEFORE INSERT OR UPDATE ON public.file_storage_routes FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['file_storage_routes','file_storage_route_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id),UPDATE(version) ON public.file_storage_routes TO kavosh_runtime;
GRANT INSERT(academy_id,route_id,version,definition,source_snapshot,changed_by,approval_id,reason) ON public.file_storage_route_revisions TO kavosh_runtime;
CREATE FUNCTION public.file_storage_route_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE keys text[]:=ARRAY['name','translations','enabled','sourceTargetId','destinationTargetId','maximumBytes'];v jsonb;k text;
BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR octet_length(d::text)>8192 OR NOT(d ?& keys) OR d-keys<>'{}'::jsonb
  OR jsonb_typeof(d->'name') IS DISTINCT FROM 'string' OR length(btrim(d->>'name')) NOT BETWEEN 1 AND 200
  OR jsonb_typeof(d->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(d->'maximumBytes') IS DISTINCT FROM 'number'
  OR d->>'maximumBytes'!~'^[1-9][0-9]{0,7}$' OR(d->>'maximumBytes')::numeric>33554432 THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['sourceTargetId','destinationTargetId'] LOOP
  IF jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR d->>k!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
 END LOOP;
 IF d->'sourceTargetId'=d->'destinationTargetId' OR jsonb_typeof(d->'translations') IS DISTINCT FROM 'object'
  OR(d->'translations')-ARRAY['en','fr','zh-CN']<>'{}'::jsonb THEN RETURN false;END IF;
 FOR v IN SELECT value FROM jsonb_each(d->'translations') LOOP IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(btrim(v#>>'{}')) NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION public.file_storage_route_basis(p_id uuid,p_before integer) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('before',(SELECT jsonb_build_object('version',version,'definition',definition) FROM public.file_storage_route_revisions
 WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND route_id=p_id AND version=p_before))
$$;
CREATE FUNCTION public.file_storage_route_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE h record;p record;s jsonb;keys text[];
BEGIN
 SELECT * INTO h FROM public.file_storage_routes WHERE academy_id=NEW.academy_id AND id=NEW.route_id FOR UPDATE;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=public.file_storage_route_basis(NEW.route_id,NEW.version-1);keys:=ARRAY['definition','reason']||CASE WHEN NEW.version=1 THEN '{}'::text[] ELSE ARRAY['expectedVersion'] END;
 IF h.id IS NULL OR h.version<>NEW.version OR(NEW.version>1 AND s->'before'='null'::jsonb) OR NOT public.file_storage_route_definition_valid(NEW.definition)
  OR p.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'storage.route.create' ELSE 'storage.route.change' END)
  OR p.target_id IS DISTINCT FROM NEW.route_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'storage.view'
  OR p.scope IS DISTINCT FROM '{"all":true,"hubs":[]}'::jsonb OR NOT(p.payload ?& keys) OR p.payload-keys<>'{}'::jsonb
  OR p.payload->'definition' IS DISTINCT FROM NEW.definition OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR jsonb_typeof(p.payload->'reason') IS DISTINCT FROM 'string'
  OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR NOT public.report_comment_human_verified(NEW.changed_by)
  OR octet_length(p.payload::text)>16384 OR(NEW.version>1 AND(jsonb_typeof(p.payload->'expectedVersion') IS DISTINCT FROM 'number' OR(p.payload->>'expectedVersion')::numeric IS DISTINCT FROM(NEW.version-1)::numeric))
 THEN RAISE EXCEPTION 'FILE_STORAGE_ROUTE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER file_storage_route_revision_guard BEFORE INSERT ON public.file_storage_route_revisions FOR EACH ROW EXECUTE FUNCTION public.file_storage_route_revision_guard();
CREATE CONSTRAINT TRIGGER file_storage_route_reviewed AFTER INSERT ON public.file_storage_route_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.file_storage_route_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND NEW.action IN('storage.route.create','storage.route.change') AND NOT EXISTS(SELECT 1 FROM public.file_storage_route_revisions
  WHERE academy_id=NEW.academy_id AND route_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id)
 THEN RAISE EXCEPTION 'FILE_STORAGE_ROUTE_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER file_storage_route_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.file_storage_route_effect_required();
REVOKE ALL ON FUNCTION public.file_storage_route_definition_valid(jsonb),public.file_storage_route_basis(uuid,integer),public.file_storage_route_revision_guard(),public.file_storage_route_effect_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.file_storage_route_definition_valid(jsonb),public.file_storage_route_basis(uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 114 $$;

INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('report-presets.view','View saved report configurations','Reports',true,ARRAY['hub','class','person','country','region','city']),
 ('report-presets.edit','Request saved report configuration changes','Reports',true,ARRAY['hub','class','person','country','region','city']);
CREATE FUNCTION public.report_preset_owner(a jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE hub uuid;class uuid;person uuid;s jsonb;BEGIN
 IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR a->>'kind' IS NULL OR a->>'kind' NOT IN('academy','hub','class','person') OR a-(CASE WHEN a->>'kind'='academy' THEN ARRAY['kind'] ELSE ARRAY['kind','id'] END)<>'{}'::jsonb THEN RETURN NULL;END IF;
 IF a->>'kind'='academy' THEN s='{"all":true,"hubs":[]}'::jsonb;
 ELSIF a->>'kind'='hub' THEN SELECT id INTO hub FROM public.hubs WHERE id=(a->>'id')::uuid;IF NOT FOUND THEN RETURN NULL;END IF;s=jsonb_build_object('all',false,'hubs',jsonb_build_array(hub));
 ELSIF a->>'kind'='class' THEN SELECT id,hub_id INTO class,hub FROM public.classes WHERE id=(a->>'id')::uuid;IF NOT FOUND THEN RETURN NULL;END IF;s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',class,'hubId',hub)));
 ELSE SELECT id,hub_id INTO person,hub FROM public.people WHERE id=(a->>'id')::uuid AND kind='human';IF NOT FOUND THEN RETURN NULL;END IF;s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',person,'hubId',hub)),'workContext',jsonb_build_object('personId',person,'hubId',hub));END IF;
 RETURN jsonb_build_object('anchor',a,'hubId',hub,'classId',class,'personId',person,'scope',s);
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;END $$;
CREATE TABLE public.report_presets(
 academy_id uuid NOT NULL,id uuid NOT NULL,anchor jsonb NOT NULL,owner jsonb NOT NULL,hub_id uuid,class_id uuid,person_id uuid,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 copied_from_id uuid,copied_from_version integer,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,class_id) REFERENCES public.classes(academy_id,id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),CHECK((copied_from_id IS NULL)=(copied_from_version IS NULL))
);
CREATE TABLE public.report_preset_revisions(
 academy_id uuid NOT NULL,preset_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL,source_snapshot jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,preset_id,version),FOREIGN KEY(academy_id,preset_id) REFERENCES public.report_presets(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.report_presets ADD FOREIGN KEY(academy_id,id,version) REFERENCES public.report_preset_revisions(academy_id,preset_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.report_presets ADD FOREIGN KEY(academy_id,copied_from_id,copied_from_version) REFERENCES public.report_preset_revisions(academy_id,preset_id,version);
CREATE INDEX report_presets_owner ON public.report_presets(academy_id,hub_id,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['report_presets','report_preset_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,anchor,copied_from_id,copied_from_version,approval_id),UPDATE(version) ON public.report_presets TO kavosh_runtime;
GRANT INSERT(academy_id,preset_id,version,definition,source_snapshot,changed_by,approval_id,reason) ON public.report_preset_revisions TO kavosh_runtime;
CREATE FUNCTION public.report_preset_basis(p_id uuid,p_anchor jsonb,p_copy uuid,p_version integer) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('owner',coalesce((SELECT owner FROM public.report_presets WHERE id=p_id),public.report_preset_owner(p_anchor)),
 'before',(SELECT jsonb_build_object('version',r.version,'definition',v.definition) FROM public.report_presets r JOIN public.report_preset_revisions v ON v.academy_id=r.academy_id AND v.preset_id=r.id AND v.version=r.version WHERE r.id=p_id),
 'copy',CASE WHEN p_copy IS NULL THEN NULL ELSE(SELECT jsonb_build_object('id',r.id,'version',v.version,'definition',v.definition) FROM public.report_presets r JOIN public.report_preset_revisions v ON v.academy_id=r.academy_id AND v.preset_id=r.id WHERE r.id=p_copy AND v.version=p_version) END)
$$;
CREATE FUNCTION public.report_preset_header_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;BEGIN
 IF TG_OP='DELETE' OR(TG_OP='UPDATE' AND(NEW.version<>OLD.version+1 OR(to_jsonb(NEW)-'version') IS DISTINCT FROM(to_jsonb(OLD)-'version'))) THEN RAISE EXCEPTION 'REPORT_PRESET_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN NEW.owner=public.report_preset_owner(NEW.anchor);NEW.hub_id=(NEW.owner->>'hubId')::uuid;NEW.class_id=(NEW.owner->>'classId')::uuid;NEW.person_id=(NEW.owner->>'personId')::uuid;NEW.created_at=clock_timestamp();
 SELECT * INTO p FROM public.approval_requests WHERE id=NEW.approval_id;
 IF NEW.version<>1 OR NEW.owner IS NULL OR p.id IS NULL OR p.status<>'pending' OR p.action<>'report-preset.create' OR p.target_id<>NEW.id OR p.target_version<>0 OR p.payload->'anchor' IS DISTINCT FROM NEW.anchor OR p.scope IS DISTINCT FROM NEW.owner->'scope'
 OR p.payload->'copiedFrom' IS DISTINCT FROM(CASE WHEN NEW.copied_from_id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',NEW.copied_from_id,'version',NEW.copied_from_version) END) THEN RAISE EXCEPTION 'REPORT_PRESET_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER report_preset_header_guard BEFORE INSERT OR UPDATE OR DELETE ON public.report_presets FOR EACH ROW EXECUTE FUNCTION public.report_preset_header_guard();
CREATE FUNCTION public.report_preset_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE k text;x record;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& ARRAY['name','translations','reportId','queryContractVersion','parameters','pathParameters','active']) OR d-ARRAY['name','translations','reportId','queryContractVersion','parameters','pathParameters','active']<>'{}'::jsonb OR octet_length(d::text)>65536
 OR jsonb_typeof(d->'name') IS DISTINCT FROM 'string' OR length(btrim(d->>'name')) NOT BETWEEN 1 AND 200 OR d->'queryContractVersion' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(d->'active') IS DISTINCT FROM 'boolean'
 OR d->>'reportId' IS NULL OR d->>'reportId' NOT IN('finance.trial-balance','finance.profit-loss','finance.balance-sheet','finance.outlook','finance.receivables-aging','finance.payables-aging','finance.bank-reconciliation','inventory.stock','payroll.scheduled-costs','payroll.recorded-time','payroll.gross-accruals','learning.polls.by-id','learning.sessions.by-id.evidence')
 OR jsonb_typeof(d->'translations') IS DISTINCT FROM 'object' OR(d->'translations')-ARRAY['en','fr','zh-CN']<>'{}'::jsonb THEN RETURN false;END IF;
 FOR x IN SELECT * FROM jsonb_each(d->'translations') LOOP IF jsonb_typeof(x.value) IS DISTINCT FROM 'string' OR length(btrim(x.value#>>'{}')) NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['parameters','pathParameters'] LOOP IF jsonb_typeof(d->k) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_each(d->k))>48 THEN RETURN false;END IF;
 FOR x IN SELECT * FROM jsonb_each(d->k) LOOP IF x.key!~'^[A-Za-z][A-Za-z0-9]{0,63}$' OR x.key IN('constructor','prototype','__proto__') OR jsonb_typeof(x.value) IS DISTINCT FROM 'string' OR length(x.value#>>'{}')>8000 OR(k='parameters' AND x.key~*'^(after|statementAfter|ledgerAfter|snapshot$)') OR(k='pathParameters' AND(x.key<>'id' OR(x.value#>>'{}')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')) THEN RETURN false;END IF;END LOOP;END LOOP;
 RETURN(d->'pathParameters' ? 'id')=(d->>'reportId' IN('learning.polls.by-id','learning.sessions.by-id.evidence'));
END $$;
CREATE FUNCTION public.report_preset_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;s jsonb;copy jsonb;keys text[];BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'REPORT_PRESET_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.report_presets WHERE id=NEW.preset_id FOR UPDATE;SELECT * INTO p FROM public.approval_requests WHERE id=NEW.approval_id;
 s=public.report_preset_basis(h.id,h.anchor,CASE WHEN NEW.version=1 THEN h.copied_from_id END,CASE WHEN NEW.version=1 THEN h.copied_from_version END);
 -- Header has advanced;the reviewed before state is its immediately prior revision.
 s=jsonb_set(s,'{before}',coalesce((SELECT jsonb_build_object('version',v.version,'definition',v.definition) FROM public.report_preset_revisions v WHERE v.preset_id=h.id AND v.version=NEW.version-1),'null'::jsonb));
 keys=ARRAY['definition','reason']||CASE WHEN NEW.version=1 THEN ARRAY['anchor','copiedFrom'] ELSE ARRAY['expectedVersion'] END;
 IF h.id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.report_preset_revisions WHERE preset_id=h.id) OR NOT public.report_preset_definition_valid(NEW.definition)
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'report-preset.create' ELSE 'report-preset.change' END) OR p.target_id IS DISTINCT FROM h.id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'report-presets.view' OR p.scope IS DISTINCT FROM h.owner->'scope'
 OR NOT(p.payload ?& keys) OR p.payload-keys<>'{}'::jsonb OR p.payload->'definition' IS DISTINCT FROM NEW.definition OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR NOT public.report_comment_human_verified(NEW.changed_by)
 OR(NEW.version=1 AND p.payload->'anchor' IS DISTINCT FROM h.anchor) OR(NEW.version>1 AND(p.payload->>'expectedVersion')::numeric IS DISTINCT FROM(NEW.version-1)::numeric)
 THEN RAISE EXCEPTION 'REPORT_PRESET_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.version=1 AND h.copied_from_id IS NOT NULL THEN copy=s#>'{copy,definition}';IF copy IS NULL OR(NEW.definition-ARRAY['name','translations','active']) IS DISTINCT FROM(copy-ARRAY['name','translations','active']) OR NEW.definition->'active' IS DISTINCT FROM 'false'::jsonb OR NEW.definition#>>'{translations,en}' IS DISTINCT FROM NEW.definition->>'name' OR((NEW.definition->'translations')-'en') IS DISTINCT FROM((copy->'translations')-'en') THEN RAISE EXCEPTION 'REPORT_PRESET_COPY_CHANGED' USING ERRCODE='23514';END IF;END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER report_preset_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.report_preset_revisions FOR EACH ROW EXECUTE FUNCTION public.report_preset_revision_guard();
CREATE CONSTRAINT TRIGGER report_preset_reviewed AFTER INSERT ON public.report_preset_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.report_preset_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND NEW.action IN('report-preset.create','report-preset.change') AND NOT EXISTS(SELECT 1 FROM public.report_preset_revisions WHERE preset_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'REPORT_PRESET_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER report_preset_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.report_preset_effect_required();
CREATE FUNCTION public.report_preset_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE owner jsonb;BEGIN
 IF NEW.action='report-preset.create' THEN owner=public.report_preset_owner(NEW.payload->'anchor');ELSE SELECT p.owner INTO owner FROM public.report_presets p WHERE id=NEW.target_id;END IF;
 IF owner IS NULL OR NEW.scope IS DISTINCT FROM owner->'scope' THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','report-presets.view','scope',owner->'scope'));END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_report_preset_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('report-preset.create','report-preset.change')) EXECUTE FUNCTION public.report_preset_privacy();
REVOKE ALL ON FUNCTION public.report_preset_owner(jsonb),public.report_preset_basis(uuid,jsonb,uuid,integer),public.report_preset_definition_valid(jsonb),public.report_preset_header_guard(),public.report_preset_revision_guard(),public.report_preset_effect_required(),public.report_preset_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_preset_owner(jsonb),public.report_preset_basis(uuid,jsonb,uuid,integer),public.report_preset_definition_valid(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 129 $$;

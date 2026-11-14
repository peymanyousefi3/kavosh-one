INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('calendar-events.view','View permitted academy calendar events','Learning',true,ARRAY['hub','class','country','region','city']),
 ('calendar-events.edit','Request reviewed academy calendar event changes','Learning',true,ARRAY['hub','class','country','region','city']);
CREATE TABLE public.calendar_events(
 academy_id uuid NOT NULL,id uuid NOT NULL,owner_kind text NOT NULL CHECK(owner_kind IN('academy','hub','class')),hub_id uuid,class_id uuid,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 definition jsonb NOT NULL,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,source_snapshot jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,class_id,hub_id) REFERENCES public.classes(academy_id,id,hub_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK((owner_kind='academy' AND hub_id IS NULL AND class_id IS NULL) OR(owner_kind='hub' AND hub_id IS NOT NULL AND class_id IS NULL) OR(owner_kind='class' AND hub_id IS NOT NULL AND class_id IS NOT NULL)),CHECK(ends_at>starts_at)
);
CREATE INDEX calendar_event_range ON public.calendar_events(academy_id,starts_at,id);
CREATE INDEX calendar_event_hub ON public.calendar_events(academy_id,hub_id,starts_at,id);
CREATE TABLE public.calendar_event_revisions(
 academy_id uuid NOT NULL,event_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,event_id,version),FOREIGN KEY(academy_id,event_id) REFERENCES public.calendar_events(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['calendar_events','calendar_event_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,owner_kind,hub_id,class_id,definition,starts_at,ends_at,source_snapshot,changed_by,approval_id,reason),UPDATE(version,definition,starts_at,ends_at,source_snapshot,changed_by,approval_id,reason) ON public.calendar_events TO kavosh_runtime;
GRANT INSERT(academy_id,event_id,version,definition) ON public.calendar_event_revisions TO kavosh_runtime;
CREATE FUNCTION public.calendar_event_scope(kind text,hub uuid,klass uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE kind WHEN 'academy' THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) WHEN 'hub' THEN jsonb_build_object('all',false,'hubs',jsonb_build_array(hub)) WHEN 'class' THEN jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',klass,'hubId',hub))) ELSE NULL END
$$;
CREATE FUNCTION public.calendar_event_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$ DECLARE part jsonb;first timestamptz;last timestamptz;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& ARRAY['kind','status','content','startsAt','endsAt','timeZone','allDay','countryId','website']) OR d-ARRAY['kind','status','content','startsAt','endsAt','timeZone','allDay','countryId','website']<>'{}'::jsonb OR octet_length(d::text)>20000
 OR d->>'kind' IS NULL OR d->>'kind' NOT IN('competition','holiday','milestone','event') OR d->>'status' IS NULL OR d->>'status' NOT IN('scheduled','cancelled','archived') OR jsonb_typeof(d->'allDay') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(d->'timeZone') IS DISTINCT FROM 'string' OR length(d->>'timeZone')>100 OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=d->>'timeZone')
 OR jsonb_typeof(d->'content') IS DISTINCT FROM 'object' OR NOT(d->'content' ? 'en') OR(d->'content')-ARRAY['en','fr','zh-CN']<>'{}'::jsonb THEN RETURN false;END IF;
 FOR part IN SELECT value FROM jsonb_each(d->'content') LOOP
  IF jsonb_typeof(part) IS DISTINCT FROM 'object' OR NOT(part ?& ARRAY['title','description']) OR part-ARRAY['title','description']<>'{}'::jsonb OR jsonb_typeof(part->'title') IS DISTINCT FROM 'string' OR length(btrim(part->>'title')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(part->'description') IS DISTINCT FROM 'string' OR length(part->>'description')>4000 THEN RETURN false;END IF;
 END LOOP;
 IF jsonb_typeof(d->'startsAt') IS DISTINCT FROM 'string' OR jsonb_typeof(d->'endsAt') IS DISTINCT FROM 'string' OR(d->>'startsAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$' OR(d->>'endsAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$' THEN RETURN false;END IF;
 first=(d->>'startsAt')::timestamptz;last=(d->>'endsAt')::timestamptz;
 IF NOT isfinite(first) OR NOT isfinite(last) OR first<date '1900-01-01' OR last>=date '10000-01-01' OR last<=first OR last-first>interval '367 days'
 OR(d->'allDay'='true'::jsonb AND((first AT TIME ZONE(d->>'timeZone'))::time<>time '00:00' OR(last AT TIME ZONE(d->>'timeZone'))::time<>time '00:00')) THEN RETURN false;END IF;
 IF d->'countryId'<>'null'::jsonb AND(jsonb_typeof(d->'countryId')<>'string' OR(d->>'countryId')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN RETURN false;END IF;
 IF d->'website'<>'null'::jsonb AND(jsonb_typeof(d->'website')<>'string' OR length(d->>'website')>2048 OR(d->>'website')!~'^https://[^/@[:space:]]+([/?#]|$)' OR(d->>'website')~'[[:cntrl:]]') THEN RETURN false;END IF;
 RETURN d->>'kind'<>'competition' OR(d->'countryId'<>'null'::jsonb AND d->'website'<>'null'::jsonb);
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN RETURN false;
END $$;
CREATE FUNCTION public.calendar_event_basis(p_id uuid,p_kind text,p_owner uuid,p_country uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;e record;h record;c record;country record;o jsonb;BEGIN
 SELECT * INTO e FROM public.calendar_events WHERE academy_id=tenant AND id=p_id;
 IF p_kind='academy' THEN IF p_owner<>tenant OR NOT EXISTS(SELECT 1 FROM public.academies WHERE id=tenant AND status='active') THEN RETURN NULL;END IF;o=jsonb_build_object('kind','academy','id',tenant,'hubId',NULL,'classId',NULL,'active',true);
 ELSIF p_kind='hub' THEN SELECT id,version,active INTO h FROM public.hubs WHERE academy_id=tenant AND id=p_owner;IF h.id IS NULL THEN RETURN NULL;END IF;o=jsonb_build_object('kind','hub','id',h.id,'hubId',h.id,'classId',NULL,'version',h.version,'active',h.active);
 ELSIF p_kind='class' THEN SELECT id,hub_id,version,active INTO c FROM public.classes WHERE academy_id=tenant AND id=p_owner;IF c.id IS NULL THEN RETURN NULL;END IF;SELECT id,version,active INTO h FROM public.hubs WHERE academy_id=tenant AND id=c.hub_id;o=jsonb_build_object('kind','class','id',c.id,'hubId',c.hub_id,'classId',c.id,'version',c.version,'hubVersion',h.version,'active',c.active AND h.active);
 ELSE RETURN NULL;END IF;
 SELECT id,code,name,version INTO country FROM public.countries WHERE academy_id=tenant AND id=p_country;IF p_country IS NOT NULL AND country.id IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('before',CASE WHEN e.id IS NULL THEN NULL ELSE to_jsonb(e) END,'owner',o,'country',CASE WHEN country.id IS NULL THEN NULL ELSE to_jsonb(country) END,'scope',public.calendar_event_scope(p_kind,(o->>'hubId')::uuid,(o->>'classId')::uuid));
END $$;
CREATE FUNCTION public.calendar_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;b jsonb;owner uuid;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CALENDAR_EVENT_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND(NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.owner_kind,NEW.hub_id,NEW.class_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.owner_kind,OLD.hub_id,OLD.class_id,OLD.created_at)) OR TG_OP='INSERT' AND NEW.version<>1 THEN RAISE EXCEPTION 'CALENDAR_EVENT_IDENTITY_CHANGED' USING ERRCODE='23514';END IF;
 IF NOT public.calendar_event_valid(NEW.definition) THEN RAISE EXCEPTION 'CALENDAR_EVENT_DEFINITION_INVALID' USING ERRCODE='23514';END IF;
 owner=CASE NEW.owner_kind WHEN 'academy' THEN NEW.academy_id WHEN 'hub' THEN NEW.hub_id ELSE NEW.class_id END;b=public.calendar_event_basis(NEW.id,NEW.owner_kind,owner,(NEW.definition->>'countryId')::uuid);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.privacy_capability IS DISTINCT FROM 'calendar-events.view' OR p.scope IS DISTINCT FROM b->'scope' OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b-'before'
 OR p.action IS DISTINCT FROM(CASE WHEN TG_OP='INSERT' THEN 'calendar-event.create' ELSE 'calendar-event.change' END) OR p.target_version<>NEW.version-1 OR p.payload->'definition' IS DISTINCT FROM NEW.definition OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 OR NEW.starts_at IS DISTINCT FROM(NEW.definition->>'startsAt')::timestamptz OR NEW.ends_at IS DISTINCT FROM(NEW.definition->>'endsAt')::timestamptz
 OR(NEW.definition->>'status'='scheduled' AND b#>'{owner,active}' IS DISTINCT FROM 'true'::jsonb) OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'CALENDAR_EVENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' AND(p.payload#>>'{owner,kind}' IS DISTINCT FROM NEW.owner_kind OR coalesce((p.payload#>>'{owner,id}')::uuid,NEW.academy_id) IS DISTINCT FROM owner) OR TG_OP='UPDATE' AND(p.payload->>'expectedVersion')::integer IS DISTINCT FROM OLD.version THEN RAISE EXCEPTION 'CALENDAR_EVENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER calendar_event_guard BEFORE INSERT OR UPDATE OR DELETE ON public.calendar_events FOR EACH ROW EXECUTE FUNCTION public.calendar_event_guard();
CREATE FUNCTION public.calendar_event_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM public.calendar_events WHERE academy_id=NEW.academy_id AND id=NEW.event_id AND version=NEW.version AND to_jsonb(calendar_events)=NEW.definition) THEN RAISE EXCEPTION 'CALENDAR_EVENT_EXACT_REVISION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER calendar_event_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.calendar_event_revisions FOR EACH ROW EXECUTE FUNCTION public.calendar_event_revision_guard();
CREATE FUNCTION public.calendar_event_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.calendar_event_revisions WHERE academy_id=NEW.academy_id AND event_id=NEW.id AND version=NEW.version AND definition=to_jsonb(NEW)) OR NOT EXISTS(SELECT 1 FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id AND status='applied' AND reviewer_id=NEW.changed_by)
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.id AND actor_id=NEW.changed_by AND action=CASE WHEN NEW.version=1 THEN 'calendar-event.create' ELSE 'calendar-event.change' END AND created_at=transaction_timestamp() AND changes->>'version'=NEW.version::text AND changes->'severity'='"critical"'::jsonb AND changes->'scheduleChangesApplied'='false'::jsonb)
 THEN RAISE EXCEPTION 'CALENDAR_EVENT_COMPLETE_REVIEW_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER calendar_event_complete AFTER INSERT OR UPDATE ON public.calendar_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.calendar_event_complete();
REVOKE ALL ON FUNCTION public.calendar_event_scope(text,uuid,uuid),public.calendar_event_valid(jsonb),public.calendar_event_basis(uuid,text,uuid,uuid),public.calendar_event_guard(),public.calendar_event_revision_guard(),public.calendar_event_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calendar_event_scope(text,uuid,uuid),public.calendar_event_valid(jsonb),public.calendar_event_basis(uuid,text,uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 216 $$;

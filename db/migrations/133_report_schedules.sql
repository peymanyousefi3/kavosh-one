INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('report-schedules.view','View recurring report schedules','Reports',true,ARRAY['hub','class','person','country','region','city']),
 ('report-schedules.edit','Request recurring report schedule changes','Reports',true,ARRAY['hub','class','person','country','region','city']);
CREATE FUNCTION public.report_timing_valid(t jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE c jsonb;keys text[];BEGIN
 IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR NOT(t ?& ARRAY['timeZone','localTime','startsOn','endsOn','cycle','gapPolicy','overlapPolicy','maxDelayMinutes']) OR t-ARRAY['timeZone','localTime','startsOn','endsOn','cycle','gapPolicy','overlapPolicy','maxDelayMinutes']<>'{}'::jsonb
 OR jsonb_typeof(t->'timeZone') IS DISTINCT FROM 'string' OR length(t->>'timeZone') NOT BETWEEN 1 AND 100 OR(t->>'timeZone')~'^[+-]' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE lower(name)=lower(t->>'timeZone'))
 OR jsonb_typeof(t->'localTime') IS DISTINCT FROM 'string' OR length(t->>'localTime')<>5 OR(t->>'localTime')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
 OR jsonb_typeof(t->'startsOn') IS DISTINCT FROM 'string' OR(t->>'startsOn')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR(t->>'startsOn')::date NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'
 OR(t->'endsOn'<>'null'::jsonb AND(jsonb_typeof(t->'endsOn') IS DISTINCT FROM 'string' OR(t->>'endsOn')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR(t->>'endsOn')::date<(t->>'startsOn')::date OR(t->>'endsOn')::date>DATE '9999-12-31'))
 OR jsonb_typeof(t->'gapPolicy') IS DISTINCT FROM 'string' OR t->>'gapPolicy' NOT IN('shift_forward','skip') OR jsonb_typeof(t->'overlapPolicy') IS DISTINCT FROM 'string' OR t->>'overlapPolicy' NOT IN('earlier','later')
 OR jsonb_typeof(t->'maxDelayMinutes') IS DISTINCT FROM 'number' OR(t->>'maxDelayMinutes')!~'^[0-9]{1,5}$' THEN RETURN false;END IF;
 IF(t->>'maxDelayMinutes')::integer NOT BETWEEN 1 AND 10080 THEN RETURN false;END IF;
 c=t->'cycle';IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c->>'kind' IS NULL OR c->>'kind' NOT IN('daily','monthly','semimonthly','weekly','biweekly','custom') THEN RETURN false;END IF;
 keys=CASE c->>'kind' WHEN 'daily' THEN ARRAY['kind'] WHEN 'monthly' THEN ARRAY['kind','day','shortMonth'] WHEN 'semimonthly' THEN ARRAY['kind','days','shortMonth'] WHEN 'weekly' THEN ARRAY['kind','weekday'] WHEN 'biweekly' THEN ARRAY['kind','anchorOn'] ELSE ARRAY['kind','label','dates'] END;
 IF NOT(c ?& keys) OR c-keys<>'{}'::jsonb THEN RETURN false;END IF;
 IF c->>'kind'='monthly' AND(jsonb_typeof(c->'day') IS DISTINCT FROM 'number' OR(c->>'day')!~'^([1-9]|[12][0-9]|3[01])$' OR c->>'shortMonth' IS DISTINCT FROM 'last_day') THEN RETURN false;END IF;
 IF c->>'kind'='semimonthly' THEN IF jsonb_typeof(c->'days') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'days')<>2 OR c->>'shortMonth' IS DISTINCT FROM 'last_day' THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'days') v WHERE jsonb_typeof(v) IS DISTINCT FROM 'number' OR(v#>>'{}')!~'^([1-9]|[12][0-9]|3[01])$') OR(c#>>'{days,0}')::integer>=(c#>>'{days,1}')::integer THEN RETURN false;END IF;END IF;
 IF c->>'kind'='weekly' AND(jsonb_typeof(c->'weekday') IS DISTINCT FROM 'number' OR(c->>'weekday')!~'^[1-7]$') THEN RETURN false;END IF;
 IF c->>'kind'='biweekly' AND(jsonb_typeof(c->'anchorOn') IS DISTINCT FROM 'string' OR(c->>'anchorOn')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR(c->>'anchorOn')::date NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31') THEN RETURN false;END IF;
 IF c->>'kind'='custom' THEN IF jsonb_typeof(c->'label') IS DISTINCT FROM 'string' OR length(btrim(c->>'label')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(c->'dates') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'dates') NOT BETWEEN 1 AND 100 THEN RETURN false;END IF;
 IF(SELECT count(DISTINCT v) FROM jsonb_array_elements(c->'dates') v)<>jsonb_array_length(c->'dates') OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'dates') v WHERE jsonb_typeof(v) IS DISTINCT FROM 'string' OR(v#>>'{}')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR(v#>>'{}')::date NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31') THEN RETURN false;END IF;END IF;RETURN true;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.report_schedule_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& ARRAY['name','translations','enabled','presetVersion','timing']) OR d-ARRAY['name','translations','enabled','presetVersion','timing']<>'{}'::jsonb OR octet_length(d::text)>16384
 OR jsonb_typeof(d->'name') IS DISTINCT FROM 'string' OR length(btrim(d->>'name')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(d->'enabled') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(d->'presetVersion') IS DISTINCT FROM 'number' OR(d->>'presetVersion')!~'^[0-9]{1,10}$' OR(d->>'presetVersion')::numeric NOT BETWEEN 1 AND 2147483647
 OR jsonb_typeof(d->'translations') IS DISTINCT FROM 'object' OR(d->'translations')-ARRAY['en','fr','zh-CN']<>'{}'::jsonb OR EXISTS(SELECT 1 FROM jsonb_each(d->'translations') v WHERE jsonb_typeof(v.value) IS DISTINCT FROM 'string' OR length(btrim(v.value#>>'{}')) NOT BETWEEN 1 AND 200)
 THEN RETURN false;END IF;RETURN public.report_timing_valid(d->'timing');
 EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE TABLE public.report_schedules(
 academy_id uuid NOT NULL,id uuid NOT NULL,preset_id uuid NOT NULL,owner_scope jsonb NOT NULL,owner_id uuid NOT NULL,owner_kind text NOT NULL CHECK(owner_kind IN('human','bot')),credential_id uuid NOT NULL,user_id uuid,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),control_version integer NOT NULL DEFAULT 1 CHECK(control_version>0),approval_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','stopped')),next_due_at timestamptz,created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),stopped_at timestamptz,
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,preset_id) REFERENCES public.report_presets(academy_id,id),FOREIGN KEY(academy_id,owner_id,owner_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK((owner_kind='human')=(user_id IS NOT NULL)),CHECK((status='active')=(next_due_at IS NOT NULL)),CHECK((status='stopped')=(stopped_at IS NOT NULL))
);
CREATE TABLE public.report_schedule_revisions(
 academy_id uuid NOT NULL,schedule_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),preset_id uuid NOT NULL,preset_version integer NOT NULL,definition jsonb NOT NULL,first_due_at timestamptz,
 source_snapshot jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(academy_id,schedule_id,version),FOREIGN KEY(academy_id,schedule_id) REFERENCES public.report_schedules(academy_id,id),FOREIGN KEY(academy_id,preset_id,preset_version) REFERENCES public.report_preset_revisions(academy_id,preset_id,version),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.report_schedules ADD FOREIGN KEY(academy_id,id,version) REFERENCES public.report_schedule_revisions(academy_id,schedule_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX report_schedules_preset ON public.report_schedules(academy_id,preset_id,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['report_schedules','report_schedule_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,preset_id,owner_id,owner_kind,credential_id,user_id,approval_id,status,next_due_at),UPDATE(version,status,next_due_at) ON public.report_schedules TO kavosh_runtime;
GRANT INSERT(academy_id,schedule_id,version,preset_id,preset_version,definition,first_due_at,source_snapshot,changed_by,approval_id,reason) ON public.report_schedule_revisions TO kavosh_runtime;
CREATE FUNCTION public.report_schedule_basis(p_id uuid,p_preset uuid,p_version integer) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('owner',p.owner->'scope','presetId',p.id,'presetVersion',p_version,'presetDefinition',v.definition-ARRAY['name','translations'],
 'before',(SELECT jsonb_build_object('version',s.version,'controlVersion',s.control_version,'definition',r.definition) FROM public.report_schedules s JOIN public.report_schedule_revisions r ON r.academy_id=s.academy_id AND r.schedule_id=s.id AND r.version=s.version WHERE s.id=p_id))
 FROM public.report_presets p JOIN public.report_preset_revisions v ON v.academy_id=p.academy_id AND v.preset_id=p.id AND v.version=p_version WHERE p.id=coalesce((SELECT preset_id FROM public.report_schedules WHERE id=p_id),p_preset)
$$;
CREATE FUNCTION public.report_schedule_header_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'REPORT_SCHEDULE_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,133));SELECT * INTO p FROM public.approval_requests WHERE id=NEW.approval_id;
  SELECT owner->'scope' INTO NEW.owner_scope FROM public.report_presets WHERE id=NEW.preset_id;
  IF p.id IS NULL OR p.status<>'pending' OR p.action<>'report.schedule.create' OR p.target_id<>NEW.id OR p.target_version<>0 OR p.requester_id<>NEW.owner_id OR p.requester_kind<>NEW.owner_kind OR p.credential_snapshot->>'token_id' IS DISTINCT FROM NEW.credential_id::text OR p.scope IS DISTINCT FROM NEW.owner_scope
   OR p.payload->>'presetId' IS DISTINCT FROM NEW.preset_id::text OR NOT EXISTS(SELECT 1 FROM public.people WHERE id=NEW.owner_id AND status='active' AND auth_user_id IS NOT DISTINCT FROM NEW.user_id) OR(NEW.status='active' AND(SELECT count(*) FROM public.report_schedules WHERE status='active')>=200) THEN RAISE EXCEPTION 'REPORT_SCHEDULE_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
  NEW.version=1;NEW.control_version=1;NEW.created_at=transaction_timestamp();
 ELSE
  IF NEW.version=OLD.version THEN
   IF NEW.status<>'stopped' OR(to_jsonb(NEW)-'status') IS DISTINCT FROM(to_jsonb(OLD)-'status') OR NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.action='report.schedule.stopped' AND a.entity_id=NEW.id AND a.created_at=transaction_timestamp() AND(a.actor_id=OLD.owner_id OR(a.actor_kind='human' AND(EXISTS(SELECT 1 FROM public.academies WHERE master_person_id=a.actor_id) OR public.is_supervisor(a.actor_id,OLD.owner_id))))) THEN RAISE EXCEPTION 'REPORT_SCHEDULE_STOP_AUTHORITY_REQUIRED' USING ERRCODE='23514';END IF;
   NEW.control_version=OLD.control_version+1;NEW.next_due_at=NULL;
  ELSE
   IF NEW.status='active' AND OLD.status<>'active' THEN PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,133));IF(SELECT count(*) FROM public.report_schedules WHERE status='active')>=200 THEN RAISE EXCEPTION 'REPORT_SCHEDULE_LIMIT' USING ERRCODE='23514';END IF;END IF;
   IF NEW.version<>OLD.version+1 OR(to_jsonb(NEW)-ARRAY['version','status','next_due_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['version','status','next_due_at']) THEN RAISE EXCEPTION 'REPORT_SCHEDULE_IMMUTABLE' USING ERRCODE='23514';END IF;NEW.control_version=OLD.control_version+1;
  END IF;
 END IF;
 NEW.stopped_at=CASE WHEN NEW.status='stopped' THEN clock_timestamp() END;RETURN NEW;
END $$;
CREATE TRIGGER report_schedule_header_guard BEFORE INSERT OR UPDATE OR DELETE ON public.report_schedules FOR EACH ROW EXECUTE FUNCTION public.report_schedule_header_guard();
CREATE FUNCTION public.report_schedule_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;s jsonb;keys text[];BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'REPORT_SCHEDULE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.report_schedules WHERE id=NEW.schedule_id FOR UPDATE;SELECT * INTO p FROM public.approval_requests WHERE id=NEW.approval_id;
 s=public.report_schedule_basis(h.id,h.preset_id,NEW.preset_version);s=jsonb_set(s,'{before}',coalesce((SELECT jsonb_build_object('version',v.version,'controlVersion',h.control_version-1,'definition',v.definition) FROM public.report_schedule_revisions v WHERE v.schedule_id=h.id AND v.version=NEW.version-1),'null'::jsonb));
 keys=ARRAY['definition','reason']||CASE WHEN NEW.version=1 THEN ARRAY['presetId'] ELSE ARRAY['expectedVersion'] END;
 IF h.id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.report_schedule_revisions WHERE schedule_id=h.id) OR NEW.preset_id IS DISTINCT FROM h.preset_id OR NOT public.report_schedule_definition_valid(NEW.definition)
 OR NEW.preset_version IS DISTINCT FROM(NEW.definition->>'presetVersion')::integer OR(NEW.definition->'enabled'='true'::jsonb AND NOT public.report_job_preset_current(h.preset_id,NEW.preset_version))
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'report.schedule.create' ELSE 'report.schedule.change' END) OR p.target_id IS DISTINCT FROM h.id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.scope IS DISTINCT FROM h.owner_scope OR p.privacy_capability IS DISTINCT FROM 'report-schedules.view'
 OR NOT(p.payload ?& keys) OR p.payload-keys<>'{}'::jsonb OR p.payload->'definition' IS DISTINCT FROM NEW.definition OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR NOT public.report_comment_human_verified(NEW.changed_by)
 OR(NEW.version=1 AND p.payload->>'presetId' IS DISTINCT FROM h.preset_id::text) OR(NEW.version>1 AND(p.payload->>'expectedVersion')::numeric IS DISTINCT FROM(NEW.version-1)::numeric)
 OR(h.status='active') IS DISTINCT FROM(NEW.definition->'enabled'='true'::jsonb) OR h.next_due_at IS DISTINCT FROM NEW.first_due_at OR(NEW.first_due_at IS NOT NULL AND NEW.first_due_at<transaction_timestamp())
 THEN RAISE EXCEPTION 'REPORT_SCHEDULE_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER report_schedule_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.report_schedule_revisions FOR EACH ROW EXECUTE FUNCTION public.report_schedule_revision_guard();
CREATE CONSTRAINT TRIGGER report_schedule_reviewed AFTER INSERT ON public.report_schedule_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.report_schedule_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND NEW.action IN('report.schedule.create','report.schedule.change') AND NOT EXISTS(SELECT 1 FROM public.report_schedule_revisions WHERE schedule_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'REPORT_SCHEDULE_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER report_schedule_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.report_schedule_effect_required();
CREATE FUNCTION public.report_schedule_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p_id uuid;s jsonb;BEGIN
 IF NEW.action='report.schedule.create' THEN p_id=(NEW.payload->>'presetId')::uuid;ELSE SELECT preset_id INTO p_id FROM public.report_schedules WHERE id=NEW.target_id;END IF;
 SELECT owner->'scope' INTO s FROM public.report_presets WHERE id=p_id;
 IF s IS NULL OR NEW.scope IS DISTINCT FROM s THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','report-presets.view','scope',s));END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_report_schedule_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('report.schedule.create','report.schedule.change')) EXECUTE FUNCTION public.report_schedule_privacy();
REVOKE ALL ON FUNCTION public.report_timing_valid(jsonb),public.report_schedule_definition_valid(jsonb),public.report_schedule_basis(uuid,uuid,integer),public.report_schedule_header_guard(),public.report_schedule_revision_guard(),public.report_schedule_effect_required(),public.report_schedule_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_timing_valid(jsonb),public.report_schedule_definition_valid(jsonb),public.report_schedule_basis(uuid,uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 133 $$;

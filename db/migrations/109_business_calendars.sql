-- Explicit reviewed calendar coverage, not inferred statutory holidays.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('business-calendars.view','View configured business-day calendars and date projections','Finance',true,ARRAY['hub','country','region','city']),
 ('business-calendars.edit','Request reviewed business-calendar changes','Finance',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.business_calendars(
 academy_id uuid NOT NULL,id uuid NOT NULL,hub_id uuid,code text NOT NULL CHECK(code~'^[A-Z0-9][A-Z0-9._-]{0,63}$'),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,code),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id)
);
CREATE TABLE public.business_calendar_revisions(
 academy_id uuid NOT NULL,calendar_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL,source_snapshot jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,calendar_id,version),FOREIGN KEY(academy_id,calendar_id) REFERENCES public.business_calendars(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.business_calendars ADD CONSTRAINT business_calendar_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.business_calendar_revisions(academy_id,calendar_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER business_calendar_header BEFORE INSERT OR UPDATE ON public.business_calendars FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['business_calendars','business_calendar_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER business_calendar_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,hub_id,code),UPDATE(version) ON public.business_calendars TO kavosh_runtime;
GRANT INSERT(academy_id,calendar_id,version,definition,source_snapshot,changed_by,approval_id,reason) ON public.business_calendar_revisions TO kavosh_runtime;

CREATE FUNCTION public.business_calendar_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE k text;v jsonb;f date;t date;on_date date;keys text[]:=ARRAY['name','translations','countryCode','region','timeZone','from','through','closedWeekdays','holidays','coverageReviewed','coverageReview','active'];BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& keys) OR d-keys<>'{}'::jsonb OR octet_length(d::text)>65536 OR d->'coverageReviewed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(d->'active') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['name','region','coverageReview'] LOOP IF jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR length(btrim(d->>k)) NOT BETWEEN 1 AND(CASE WHEN k='coverageReview' THEN 2000 ELSE 200 END) THEN RETURN false;END IF;END LOOP;
 IF jsonb_typeof(d->'countryCode') IS DISTINCT FROM 'string' OR d->>'countryCode'!~'^[A-Z]{2}$' OR jsonb_typeof(d->'timeZone') IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=d->>'timeZone') OR jsonb_typeof(d->'translations') IS DISTINCT FROM 'object' OR(d->'translations')-ARRAY['en','fr','zh-CN']<>'{}'::jsonb THEN RETURN false;END IF;
 FOR v IN SELECT value FROM jsonb_each(d->'translations') LOOP IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(btrim(v#>>'{}')) NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['from','through'] LOOP IF jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR d->>k!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;END LOOP;
 f=(d->>'from')::date;t=(d->>'through')::date;IF f<DATE '1900-01-01' OR t>DATE '9999-12-31' OR t<f OR t-f>3660 THEN RETURN false;END IF;
 IF jsonb_typeof(d->'closedWeekdays') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'closedWeekdays')>6 OR jsonb_typeof(d->'holidays') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'holidays')>1000 THEN RETURN false;END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(d->'closedWeekdays') LOOP IF jsonb_typeof(v) IS DISTINCT FROM 'number' OR(v#>>'{}')::numeric NOT BETWEEN 1 AND 7 OR(v#>>'{}')::numeric<>trunc((v#>>'{}')::numeric) THEN RETURN false;END IF;END LOOP;
 FOR v IN SELECT value FROM jsonb_array_elements(d->'holidays') LOOP IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR v#>>'{}'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;on_date=(v#>>'{}')::date;IF on_date NOT BETWEEN f AND t THEN RETURN false;END IF;END LOOP;
 RETURN jsonb_array_length(d->'closedWeekdays')=(SELECT count(DISTINCT value) FROM jsonb_array_elements(d->'closedWeekdays')) AND jsonb_array_length(d->'holidays')=(SELECT count(DISTINCT value) FROM jsonb_array_elements(d->'holidays'));
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.business_calendar_basis(p_id uuid,p_before integer) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('before',(SELECT jsonb_build_object('version',version,'definition',definition) FROM public.business_calendar_revisions WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND calendar_id=p_id AND version=p_before))
$$;
CREATE FUNCTION public.business_calendar_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;s jsonb;scope jsonb;keys text[];BEGIN
 SELECT * INTO h FROM public.business_calendars WHERE academy_id=NEW.academy_id AND id=NEW.calendar_id FOR UPDATE;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=public.business_calendar_basis(NEW.calendar_id,NEW.version-1);scope=CASE WHEN h.hub_id IS NULL THEN '{"all":true,"hubs":[]}'::jsonb ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(h.hub_id)) END;
 keys=ARRAY['definition','reason']||CASE WHEN NEW.version=1 THEN ARRAY['hubId','code'] ELSE ARRAY['expectedVersion'] END;
 IF h.id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.business_calendar_revisions WHERE academy_id=NEW.academy_id AND calendar_id=NEW.calendar_id) OR NOT public.business_calendar_definition_valid(NEW.definition) OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'finance.business-calendar.create' ELSE 'finance.business-calendar.change' END) OR p.target_id IS DISTINCT FROM NEW.calendar_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'business-calendars.edit' OR p.scope IS DISTINCT FROM scope OR NOT(p.payload ?& keys) OR p.payload-keys<>'{}'::jsonb OR p.payload->'definition' IS DISTINCT FROM NEW.definition OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR NOT public.report_comment_human_verified(NEW.changed_by)
 OR jsonb_typeof(p.payload->'reason') IS DISTINCT FROM 'string' OR octet_length(p.payload::text)>131072
 OR(NEW.version=1 AND(jsonb_typeof(p.payload->'hubId') NOT IN('string','null') OR jsonb_typeof(p.payload->'code') IS DISTINCT FROM 'string' OR p.payload->>'hubId' IS DISTINCT FROM h.hub_id::text OR p.payload->>'code' IS DISTINCT FROM h.code)) OR(NEW.version>1 AND(jsonb_typeof(p.payload->'expectedVersion') IS DISTINCT FROM 'number' OR(p.payload->>'expectedVersion')::numeric IS DISTINCT FROM(NEW.version-1)::numeric)) THEN RAISE EXCEPTION 'BUSINESS_CALENDAR_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER business_calendar_revision_guard BEFORE INSERT ON public.business_calendar_revisions FOR EACH ROW EXECUTE FUNCTION public.business_calendar_revision_guard();
CREATE CONSTRAINT TRIGGER business_calendar_reviewed AFTER INSERT ON public.business_calendar_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.business_calendar_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND NEW.action IN('finance.business-calendar.create','finance.business-calendar.change') AND NOT EXISTS(SELECT 1 FROM public.business_calendar_revisions WHERE academy_id=NEW.academy_id AND calendar_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'BUSINESS_CALENDAR_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER business_calendar_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.business_calendar_effect_required();
CREATE FUNCTION public.business_calendar_approval_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE hub uuid;scope jsonb;BEGIN
 IF NEW.action='finance.business-calendar.create' THEN hub=(NEW.payload->>'hubId')::uuid;
 ELSE SELECT hub_id INTO hub FROM public.business_calendars WHERE academy_id=NEW.academy_id AND id=NEW.target_id;IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;END IF;
 scope=CASE WHEN hub IS NULL THEN '{"all":true,"hubs":[]}'::jsonb ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(hub)) END;
 IF NEW.scope IS DISTINCT FROM scope THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','business-calendars.view','scope',scope));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;
END $$;
CREATE TRIGGER zz_business_calendar_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.business-calendar.create','finance.business-calendar.change')) EXECUTE FUNCTION public.business_calendar_approval_privacy();
CREATE FUNCTION public.business_calendar_project(d jsonb,p_on date,p_offset integer) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE current_day date:=p_on;first_day date;last_day date;direction integer;remaining integer;walked integer:=0;closed integer:=0;weekdays integer[];holidays jsonb;is_open boolean;anchor_open boolean;BEGIN
 IF NOT public.business_calendar_definition_valid(d) THEN RETURN jsonb_build_object('unavailable','INVALID_BUSINESS_CALENDAR');END IF;
 IF p_on IS NULL OR p_offset IS NULL OR p_offset NOT BETWEEN -366 AND 366 THEN RETURN jsonb_build_object('unavailable','BUSINESS_DAY_OFFSET_INVALID');END IF;
 first_day=(d->>'from')::date;last_day=(d->>'through')::date;IF p_on NOT BETWEEN first_day AND last_day THEN RETURN jsonb_build_object('unavailable','BUSINESS_CALENDAR_COVERAGE_REQUIRED');END IF;
 SELECT coalesce(array_agg(v::numeric::integer),'{}'::integer[]) INTO weekdays FROM jsonb_array_elements_text(d->'closedWeekdays') v;
 SELECT coalesce(jsonb_object_agg(v,true),'{}'::jsonb) INTO holidays FROM jsonb_array_elements_text(d->'holidays') v;
 anchor_open=NOT(extract(isodow FROM p_on)::integer=ANY(weekdays)) AND NOT(holidays ? p_on::text);direction=CASE WHEN p_offset<0 THEN -1 ELSE 1 END;remaining=abs(p_offset);
 WHILE remaining>0 LOOP
  current_day=current_day+direction;walked=walked+1;IF current_day NOT BETWEEN first_day AND last_day THEN RETURN jsonb_build_object('unavailable','BUSINESS_CALENDAR_COVERAGE_REQUIRED');END IF;
  is_open=NOT(extract(isodow FROM current_day)::integer=ANY(weekdays)) AND NOT(holidays ? current_day::text);IF is_open THEN remaining=remaining-1;ELSE closed=closed+1;END IF;
 END LOOP;
 RETURN jsonb_build_object('from',p_on::text,'businessDays',p_offset,'resultOn',current_day::text,'anchorOpen',anchor_open,'calendarDaysTraversed',walked,'closedDatesCrossed',closed,'counting','exclude_anchor_except_zero_offset','coverageBasis','operator_reviewed_calendar_not_legal_verification');
END $$;
REVOKE ALL ON FUNCTION public.business_calendar_definition_valid(jsonb),public.business_calendar_basis(uuid,integer),public.business_calendar_revision_guard(),public.business_calendar_effect_required(),public.business_calendar_approval_privacy(),public.business_calendar_project(jsonb,date,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.business_calendar_definition_valid(jsonb),public.business_calendar_basis(uuid,integer),public.business_calendar_project(jsonb,date,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 109 $$;

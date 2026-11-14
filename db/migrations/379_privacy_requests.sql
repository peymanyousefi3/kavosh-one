-- Private request management,not automatic disclosure,erasure,consent or
-- certification of a legal deadline. Original receipt and history survive.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('privacy-requests.view','View scoped private access/correction requests','Administration',true,ARRAY['hub','person','country','region','city']),
 ('privacy-requests.edit','Propose reviewed privacy-request responses','Administration',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.privacy_requests(
 academy_id uuid NOT NULL,id uuid NOT NULL,subject_id uuid NOT NULL,requested_by uuid NOT NULL,origin text NOT NULL CHECK(origin IN('self','admin')),intake jsonb NOT NULL CHECK(octet_length(intake::text)<=32768),source_basis jsonb NOT NULL,
 session_id uuid NOT NULL,api_request_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),received_at timestamptz NOT NULL DEFAULT clock_timestamp(),time_zone text NOT NULL DEFAULT 'UTC',baseline_review_on date NOT NULL DEFAULT current_date,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,session_id,api_request_id),FOREIGN KEY(academy_id,subject_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,requested_by) REFERENCES public.people(academy_id,id)
);
CREATE TABLE public.privacy_request_revisions(
 academy_id uuid NOT NULL,request_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('received','under_review','needs_information','responded','closed','withdrawn')),
 definition jsonb NOT NULL CHECK(octet_length(definition::text)<=32768),source_basis jsonb NOT NULL,changed_by uuid NOT NULL,session_id uuid NOT NULL,api_request_id uuid NOT NULL,approval_id uuid,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,request_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,request_id) REFERENCES public.privacy_requests(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.privacy_requests ADD CONSTRAINT privacy_request_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.privacy_request_revisions(academy_id,request_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX privacy_requests_author ON public.privacy_requests(academy_id,requested_by,id);
CREATE INDEX privacy_requests_subject ON public.privacy_requests(academy_id,subject_id,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['privacy_requests','privacy_request_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,subject_id,requested_by,origin,intake,source_basis,session_id,api_request_id),UPDATE(version) ON public.privacy_requests TO kavosh_runtime;
GRANT INSERT(academy_id,request_id,version,state,definition,source_basis,changed_by,session_id,api_request_id,approval_id,reason) ON public.privacy_request_revisions TO kavosh_runtime;
CREATE FUNCTION public.privacy_request_intake_valid(d jsonb,mode text) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR octet_length(d::text)>32768 OR mode IS NULL OR mode NOT IN('self','admin') OR NOT(d?&ARRAY['category','details','locale']) OR d-ARRAY['category','details','locale']-(CASE WHEN mode='admin' THEN ARRAY['receivedAt','timeZone'] ELSE ARRAY[]::text[] END)<>'{}'::jsonb
 OR jsonb_typeof(d->'category') IS DISTINCT FROM 'string' OR d->>'category' NOT IN('access','correction','deletion','consent_question','complaint') OR jsonb_typeof(d->'locale') IS DISTINCT FROM 'string' OR d->>'locale' NOT IN('en','fr','zh-CN') OR jsonb_typeof(d->'details') IS DISTINCT FROM 'string' OR length(btrim(d->>'details')) NOT BETWEEN 1 AND 8000 OR translate(d->>'details',E'\n\r\t','')~'[[:cntrl:]]' THEN RETURN false;END IF;
 IF d?'timeZone' AND d->'timeZone'<>'null'::jsonb AND(jsonb_typeof(d->'timeZone') IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=d->>'timeZone')) THEN RETURN false;END IF;
 IF d?'receivedAt' AND d->'receivedAt'<>'null'::jsonb THEN IF jsonb_typeof(d->'receivedAt') IS DISTINCT FROM 'string' OR(d->>'receivedAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' OR NOT isfinite((d->>'receivedAt')::timestamptz) OR extract(year FROM(d->>'receivedAt')::timestamptz) NOT BETWEEN 1900 AND 9999 OR(d->>'receivedAt')::timestamptz>clock_timestamp() THEN RETURN false;END IF;END IF;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.privacy_response_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE k text;v jsonb;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR octet_length(d::text)>32768 OR NOT(d?&ARRAY['state','message','privateNote','reviewReference','targetResponseOn','delivery']) OR d-ARRAY['state','message','privateNote','reviewReference','targetResponseOn','delivery']<>'{}'::jsonb OR jsonb_typeof(d->'state') IS DISTINCT FROM 'string' OR d->>'state' NOT IN('under_review','needs_information','responded','closed') THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['message','privateNote','reviewReference'] LOOP IF jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR length(d->>k)>(CASE WHEN k='reviewReference' THEN 2000 ELSE 8000 END) OR translate(d->>k,E'\n\r\t','')~'[[:cntrl:]]' THEN RETURN false;END IF;END LOOP;
 IF length(btrim(d->>'reviewReference'))=0 OR(d->>'state' IN('needs_information','responded','closed') AND length(btrim(d->>'message'))=0) OR jsonb_typeof(d->'targetResponseOn') IS DISTINCT FROM 'string' OR d->>'targetResponseOn'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR(d->>'targetResponseOn')::date NOT BETWEEN date'1900-01-01' AND date'9999-12-31' THEN RETURN false;END IF;
 v=d->'delivery';IF d->>'state' IN('responded','closed') THEN
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v?&ARRAY['method','reference']) OR jsonb_typeof(v->'reference') IS DISTINCT FROM 'string' OR length(btrim(v->>'reference')) NOT BETWEEN 1 AND 2000 OR jsonb_typeof(v->'method') IS DISTINCT FROM 'string' OR v->>'method' NOT IN('portal','offline') OR translate(v->>'reference',E'\n\r\t','')~'[[:cntrl:]]' THEN RETURN false;END IF;
  IF v->>'method'='portal' THEN IF v-ARRAY['method','reference']<>'{}'::jsonb THEN RETURN false;END IF;
  ELSE IF NOT(v?'deliveredAt') OR v-ARRAY['method','reference','deliveredAt']<>'{}'::jsonb OR jsonb_typeof(v->'deliveredAt') IS DISTINCT FROM 'string' OR v->>'deliveredAt'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' OR NOT isfinite((v->>'deliveredAt')::timestamptz) THEN RETURN false;END IF;END IF;
 ELSIF v<>'null'::jsonb THEN RETURN false;END IF;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.privacy_request_intake_basis(subject uuid,actor uuid,mode text,zone text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE subject_row record;actor_row record;family jsonb;BEGIN
 SELECT p.id,p.hub_id,p.kind,h.time_zone INTO subject_row FROM public.people p LEFT JOIN public.hubs h ON h.academy_id=p.academy_id AND h.id=p.hub_id WHERE p.id=subject AND p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid;
 SELECT id,hub_id INTO actor_row FROM public.people WHERE id=actor AND kind='human' AND public.report_comment_human_verified(id);
 IF subject_row.id IS NULL OR subject_row.kind<>'human' OR actor_row.id IS NULL OR mode NOT IN('self','admin') THEN RETURN NULL;END IF;
 IF mode='self' THEN family=public.profile_consent_actor_basis(subject,actor);IF family IS NULL OR zone IS NOT NULL THEN RETURN NULL;END IF;END IF;
 IF zone IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=zone) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('subjectId',subject,'requestedBy',actor,'origin',mode,'subjectHubId',subject_row.hub_id,'requesterHubId',actor_row.hub_id,'family',family,'timeZone',coalesce(zone,subject_row.time_zone,'UTC'),'timeZoneBasis',CASE WHEN zone IS NOT NULL THEN 'explicit_admin' WHEN subject_row.time_zone IS NOT NULL THEN 'subject_hub' ELSE 'UTC_fallback' END);
END $$;
CREATE FUNCTION public.privacy_request_basis(case_id uuid,before_version integer) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
 SELECT jsonb_build_object('requestId',h.id,'subjectId',h.subject_id,'requestedBy',h.requested_by,'origin',h.origin,'requesterAuthorityCurrent',CASE WHEN h.origin='self' THEN public.profile_consent_actor_basis(h.subject_id,h.requested_by) IS NOT NULL ELSE false END,'version',r.version,'before',jsonb_build_object('state',r.state,'definition',r.definition),'receivedAt',to_char(h.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'receivedOn',(h.received_at AT TIME ZONE h.time_zone)::date::text,'baselineReviewOn',h.baseline_review_on::text,'timeZone',h.time_zone,'scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',(SELECT jsonb_agg(jsonb_build_object('id',id,'hubId',hub_id) ORDER BY id) FROM public.people WHERE id=h.subject_id OR h.origin='self' AND id=h.requested_by)))
 FROM public.privacy_requests h JOIN public.privacy_request_revisions r ON r.academy_id=h.academy_id AND r.request_id=h.id AND r.version=before_version WHERE h.id=case_id
$$;
CREATE FUNCTION public.guard_privacy_request_header() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog SET TimeZone='UTC' AS $$ DECLARE b jsonb;u uuid;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PRIVACY_REQUEST_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN IF NEW.version<>OLD.version+1 OR(to_jsonb(NEW)-'version') IS DISTINCT FROM(to_jsonb(OLD)-'version') THEN RAISE EXCEPTION 'PRIVACY_REQUEST_VERSION_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 SELECT auth_user_id INTO u FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.requested_by AND kind='human';
 IF u IS NULL OR public.lock_human(NEW.session_id,u) IS NOT TRUE OR public.privacy_request_intake_valid(NEW.intake,NEW.origin) IS NOT TRUE THEN RAISE EXCEPTION 'PRIVACY_REQUEST_VERIFIED_INTAKE_REQUIRED' USING ERRCODE='23514';END IF;
 b=public.privacy_request_intake_basis(NEW.subject_id,NEW.requested_by,NEW.origin,NEW.intake->>'timeZone');IF b IS NULL OR b IS DISTINCT FROM NEW.source_basis OR NEW.version<>1 THEN RAISE EXCEPTION 'PRIVACY_REQUEST_CURRENT_AUTHORITY_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.received_at=coalesce((NEW.intake->>'receivedAt')::timestamptz,clock_timestamp());NEW.time_zone=b->>'timeZone';NEW.baseline_review_on=(NEW.received_at AT TIME ZONE NEW.time_zone)::date+30;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER privacy_request_header BEFORE INSERT OR UPDATE OR DELETE ON public.privacy_requests FOR EACH ROW EXECUTE FUNCTION public.guard_privacy_request_header();
CREATE FUNCTION public.guard_privacy_request_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog SET TimeZone='UTC' AS $$ DECLARE h record;p record;b jsonb;u uuid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PRIVACY_REQUEST_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.privacy_requests WHERE academy_id=NEW.academy_id AND id=NEW.request_id FOR UPDATE;
 SELECT auth_user_id INTO u FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human';
 IF h.id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.privacy_request_revisions WHERE academy_id=NEW.academy_id AND request_id=NEW.request_id) OR u IS NULL OR public.lock_human(NEW.session_id,u) IS NOT TRUE THEN RAISE EXCEPTION 'PRIVACY_REQUEST_CURRENT_HUMAN_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.version=1 THEN IF NEW.changed_by<>h.requested_by OR NEW.session_id<>h.session_id OR NEW.api_request_id<>h.api_request_id OR NEW.state<>'received' OR NEW.definition<>'null'::jsonb OR NEW.approval_id IS NOT NULL OR NEW.source_basis IS DISTINCT FROM h.source_basis OR NEW.reason<>'Request received' THEN RAISE EXCEPTION 'PRIVACY_REQUEST_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  b=public.privacy_request_basis(h.id,NEW.version-1);
  IF NEW.source_basis IS DISTINCT FROM b THEN RAISE EXCEPTION 'PRIVACY_REQUEST_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF NEW.definition='null'::jsonb OR NEW.definition?'clarification' THEN
   IF NEW.approval_id IS NOT NULL OR h.origin<>'self' OR NEW.changed_by<>h.requested_by OR public.profile_consent_actor_basis(h.subject_id,NEW.changed_by) IS NULL OR b#>>'{before,state}' IN('responded','closed','withdrawn') THEN RAISE EXCEPTION 'PRIVACY_REQUEST_OWN_WITHDRAWAL_REQUIRED' USING ERRCODE='23514';END IF;
   IF NEW.definition='null'::jsonb THEN IF NEW.state<>'withdrawn' THEN RAISE EXCEPTION 'PRIVACY_REQUEST_OWN_WITHDRAWAL_REQUIRED' USING ERRCODE='23514';END IF;
   ELSIF jsonb_typeof(NEW.definition) IS DISTINCT FROM 'object' OR NEW.definition-'clarification'<>'{}'::jsonb OR jsonb_typeof(NEW.definition->'clarification') IS DISTINCT FROM 'string' OR length(btrim(NEW.definition->>'clarification')) NOT BETWEEN 1 AND 8000 OR translate(NEW.definition->>'clarification',E'\n\r\t','')~'[[:cntrl:]]' OR NEW.state IS DISTINCT FROM b#>>'{before,state}' THEN RAISE EXCEPTION 'PRIVACY_REQUEST_CLARIFICATION_INVALID' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
   IF public.privacy_response_valid(NEW.definition) IS NOT TRUE OR NEW.state IS DISTINCT FROM NEW.definition->>'state' OR(NEW.definition->>'targetResponseOn')::date<(h.received_at AT TIME ZONE h.time_zone)::date OR(NEW.definition#>>'{delivery,deliveredAt}')::timestamptz NOT BETWEEN h.received_at AND clock_timestamp()
    OR(NEW.definition#>>'{delivery,method}'='portal' AND b->'requesterAuthorityCurrent' IS DISTINCT FROM 'true'::jsonb) OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'privacy.request.review' OR p.target_id IS DISTINCT FROM h.id OR p.target_version<>NEW.version-1 OR p.scope IS DISTINCT FROM b->'scope' OR p.privacy_capability IS DISTINCT FROM 'privacy-requests.view' OR p.review_context IS DISTINCT FROM b OR p.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'definition',NEW.definition,'reason',NEW.reason) THEN RAISE EXCEPTION 'PRIVACY_REQUEST_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
   IF (NEW.changed_by=h.subject_id OR h.origin='self' AND NEW.changed_by=h.requested_by) AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
  END IF;
 END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER privacy_request_revision BEFORE INSERT OR UPDATE OR DELETE ON public.privacy_request_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_privacy_request_revision();
CREATE CONSTRAINT TRIGGER privacy_request_reviewed AFTER INSERT ON public.privacy_request_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.approval_id IS NOT NULL) EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.privacy_request_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE action_name text:=CASE WHEN NEW.version=1 THEN 'privacy.request.created' WHEN NEW.definition='null'::jsonb THEN 'privacy.request.withdrawn' WHEN NEW.definition?'clarification' THEN 'privacy.request.clarified' ELSE 'privacy.request.reviewed' END;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.request_id AND a.actor_id=NEW.changed_by AND a.actor_kind='human' AND a.session_id=NEW.session_id AND a.request_id=NEW.api_request_id AND a.action=action_name AND a.created_at=transaction_timestamp() AND a.changes=jsonb_build_object('version',NEW.version,'state',NEW.state,'approvalId',NEW.approval_id,'severity','critical','privateContentRedacted',true)
 AND EXISTS(SELECT 1 FROM public.outbox_events e WHERE e.academy_id=a.academy_id AND e.entity_id=a.entity_id AND e.request_id=a.request_id AND e.event_type=a.action AND e.created_at=transaction_timestamp())) THEN RAISE EXCEPTION 'PRIVACY_REQUEST_AUDIT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER privacy_request_complete AFTER INSERT ON public.privacy_request_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.privacy_request_complete();
CREATE FUNCTION public.privacy_request_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='privacy.request.review' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.privacy_request_revisions WHERE academy_id=NEW.academy_id AND request_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PRIVACY_REQUEST_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER privacy_request_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.privacy_request_effect_required();
CREATE FUNCTION public.privacy_request_approval_bindings() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;BEGIN
 SELECT subject_id,requested_by,origin INTO h FROM public.privacy_requests WHERE academy_id=NEW.academy_id AND id=NEW.target_id;
 NEW.privacy_bindings=NEW.privacy_bindings||CASE WHEN h.subject_id IS NULL THEN '[{"unresolved":true}]'::jsonb ELSE jsonb_build_array(jsonb_build_object('capability','privacy-requests.view','personId',h.subject_id) )||CASE WHEN h.origin='self' THEN jsonb_build_array(jsonb_build_object('capability','privacy-requests.view','personId',h.requested_by)) ELSE '[]'::jsonb END END;RETURN NEW;
END $$;
CREATE TRIGGER zz_privacy_request_bindings BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='privacy.request.review') EXECUTE FUNCTION public.privacy_request_approval_bindings();
GRANT CREATE ON SCHEMA public TO kavosh_event_policy;
ALTER FUNCTION public.privacy_request_complete() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy;
REVOKE ALL ON FUNCTION public.privacy_request_intake_valid(jsonb,text),public.privacy_response_valid(jsonb),public.privacy_request_intake_basis(uuid,uuid,text,text),public.privacy_request_basis(uuid,integer),public.guard_privacy_request_header(),public.guard_privacy_request_revision(),public.privacy_request_complete(),public.privacy_request_effect_required(),public.privacy_request_approval_bindings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_request_intake_valid(jsonb,text),public.privacy_response_valid(jsonb),public.privacy_request_intake_basis(uuid,uuid,text,text),public.privacy_request_basis(uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 379 $$;

INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('tuition-sessions.view','View reviewed tuition-to-session allocations','Finance',true,ARRAY['hub','class','person','country','region','city']),
 ('tuition-sessions.edit','Request reviewed tuition-to-session allocations','Finance',true,ARRAY['hub','class','person','country','region','city']);
CREATE TABLE public.tuition_session_allocations(
 academy_id uuid NOT NULL,plan_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,plan_id),FOREIGN KEY(academy_id,plan_id) REFERENCES public.tuition_plans(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE TABLE public.tuition_session_allocation_revisions(
 academy_id uuid NOT NULL,plan_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),input jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=262144),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,plan_id,version),FOREIGN KEY(academy_id,plan_id) REFERENCES public.tuition_session_allocations(academy_id,plan_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.tuition_session_allocations ADD CONSTRAINT tuition_sessions_current FOREIGN KEY(academy_id,plan_id,version) REFERENCES public.tuition_session_allocation_revisions(academy_id,plan_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['tuition_session_allocations','tuition_session_allocation_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER tuition_sessions_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,plan_id,version,created_by) ON public.tuition_session_allocations TO kavosh_runtime;
GRANT UPDATE(version) ON public.tuition_session_allocations TO kavosh_runtime;
GRANT INSERT(academy_id,plan_id,version,input,source_snapshot,changed_by,approval_id) ON public.tuition_session_allocation_revisions TO kavosh_runtime;
CREATE TRIGGER tuition_sessions_header BEFORE INSERT OR UPDATE ON public.tuition_session_allocations FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();

CREATE FUNCTION public.tuition_sessions_input_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE x jsonb;keys text[]:=ARRAY['invoiceId','expectedVersion','sessions','reason'];BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& keys) OR i-keys<>'{}'::jsonb OR octet_length(i::text)>65536 OR jsonb_typeof(i->'invoiceId') IS DISTINCT FROM 'string' OR(i->>'invoiceId')::uuid::text IS DISTINCT FROM i->>'invoiceId'
 OR jsonb_typeof(i->'expectedVersion') IS DISTINCT FROM 'number' OR(i->>'expectedVersion')::numeric NOT BETWEEN 0 AND 2147483646 OR(i->>'expectedVersion')::numeric<>trunc((i->>'expectedVersion')::numeric)
 OR jsonb_typeof(i->'reason') IS DISTINCT FROM 'string' OR length(btrim(i->>'reason')) NOT BETWEEN 1 AND 2000 OR jsonb_typeof(i->'sessions') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(i->'sessions') NOT BETWEEN 1 AND 200 OR(SELECT count(DISTINCT v->>'sessionId') FROM jsonb_array_elements(i->'sessions') v)<>jsonb_array_length(i->'sessions') THEN RETURN false;END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(i->'sessions') LOOP
 IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR NOT(x ?& ARRAY['sessionId','sessionVersion','weight']) OR x-ARRAY['sessionId','sessionVersion','weight']<>'{}'::jsonb OR jsonb_typeof(x->'sessionId') IS DISTINCT FROM 'string' OR(x->>'sessionId')::uuid::text IS DISTINCT FROM x->>'sessionId'
 OR jsonb_typeof(x->'sessionVersion') IS DISTINCT FROM 'number' OR(x->>'sessionVersion')::numeric NOT BETWEEN 1 AND 2147483647 OR(x->>'sessionVersion')::numeric<>trunc((x->>'sessionVersion')::numeric)
 OR jsonb_typeof(x->'weight') IS DISTINCT FROM 'number' OR(x->>'weight')::numeric NOT BETWEEN 1 AND 1000000 OR(x->>'weight')::numeric<>trunc((x->>'weight')::numeric) THEN RETURN false;END IF;END LOOP;RETURN true;
 EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
CREATE FUNCTION public.tuition_session_allocation_source(i jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;t record;c record;e record;s record;v integer;total numeric;before_weight numeric:=0;next_net numeric;next_tax numeric;prior_net numeric:=0;prior_tax numeric:=0;rows jsonb:='[]';BEGIN
 IF NOT public.tuition_sessions_input_valid(i) THEN RETURN jsonb_build_object('unavailable','TUITION_SESSIONS_INPUT_INVALID');END IF;
 SELECT x.id,x.plan_id,x.plan_version,x.class_id,x.hub_id,x.student_id,x.credit_id,p.enrollment_id,p.currency_id,p.unit_scale,r.net_minor,r.tax_minor,r.gross_minor INTO t FROM public.tuition_invoices x JOIN public.tuition_plans p ON p.academy_id=x.academy_id AND p.id=x.plan_id JOIN public.tuition_plan_revisions r ON r.academy_id=x.academy_id AND r.plan_id=x.plan_id AND r.version=x.plan_version WHERE x.academy_id=tenant AND x.id=(i->>'invoiceId')::uuid;
 IF t.id IS NULL THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':'||t.plan_id::text,32));
 -- Re-read after the per-plan gate; concurrent first configurations must not
 -- both see version zero. No academy-wide exclusive lock is introduced.
 SELECT version INTO v FROM public.tuition_session_allocations WHERE academy_id=tenant AND plan_id=t.plan_id;
 IF t.credit_id IS NOT NULL THEN RETURN jsonb_build_object('unavailable','CREDITED_TUITION_SOURCE_REQUIRES_REVIEW');END IF;
 SELECT id,version,joins_on,leaves_on,enabled INTO e FROM public.class_enrollments WHERE academy_id=tenant AND id=t.enrollment_id;
 SELECT id,version,time_zone,active INTO c FROM public.classes WHERE academy_id=tenant AND id=t.class_id;
 IF NOT e.enabled OR NOT c.active THEN RETURN jsonb_build_object('unavailable','ACTIVE_TUITION_MEMBERSHIP_REQUIRED');END IF;
 SELECT sum((x->>'weight')::numeric) INTO total FROM jsonb_array_elements(i->'sessions') x;
 FOR s IN SELECT x.id,x.version,x.class_id,x.status,x.starts_at,x.ends_at,x.time_info,(x.starts_at AT TIME ZONE c.time_zone)::date AS on_date,(j->>'sessionVersion')::integer expected_version,(j->>'weight')::numeric weight FROM jsonb_array_elements(i->'sessions') j JOIN public.class_sessions x ON x.academy_id=tenant AND x.id=(j->>'sessionId')::uuid ORDER BY x.starts_at,x.id LOOP
  IF s.class_id<>t.class_id OR s.version<>s.expected_version OR s.status<>'scheduled' OR s.time_info->>'timeZone' IS DISTINCT FROM c.time_zone OR s.on_date<e.joins_on OR(e.leaves_on IS NOT NULL AND s.on_date>e.leaves_on) THEN RETURN jsonb_build_object('unavailable','TUITION_SESSION_SOURCE_CHANGED');END IF;
  before_weight=before_weight+s.weight;next_net=floor(t.net_minor*before_weight/total);next_tax=floor(t.tax_minor*before_weight/total);
  rows=rows||jsonb_build_array(jsonb_build_object('sessionId',s.id,'sessionVersion',s.version,'startsAt',s.starts_at,'endsAt',s.ends_at,'on',s.on_date::text,'weight',s.weight,'netBefore',prior_net::text,'grossBefore',(prior_net+prior_tax)::text,'netMinor',(next_net-prior_net)::text,'taxMinor',(next_tax-prior_tax)::text,'grossMinor',(next_net+next_tax-prior_net-prior_tax)::text));prior_net=next_net;prior_tax=next_tax;
 END LOOP;
 IF jsonb_array_length(rows)<>jsonb_array_length(i->'sessions') THEN RETURN jsonb_build_object('unavailable','TUITION_SESSION_SOURCE_CHANGED');END IF;
 RETURN jsonb_build_object('before',jsonb_build_object('version',coalesce(v,0)),'invoice',jsonb_build_object('id',t.id,'planId',t.plan_id,'planVersion',t.plan_version,'hubId',t.hub_id,'classId',t.class_id,'studentId',t.student_id,'currencyId',t.currency_id,'unitScale',t.unit_scale,'netMinor',t.net_minor::text,'taxMinor',t.tax_minor::text,'grossMinor',t.gross_minor::text),'enrollment',jsonb_build_object('id',e.id,'version',e.version,'joinsOn',e.joins_on::text,'leavesOn',e.leaves_on::text),'class',jsonb_build_object('id',c.id,'version',c.version,'timeZone',c.time_zone),'allocationPolicy','cumulative_floor_net_and_tax_in_session_start_id_order','sessions',rows);
END $$;
CREATE FUNCTION public.tuition_sessions_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;h record;s jsonb;context jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'TUITION_SESSIONS_REVISION_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT public.tuition_sessions_input_valid(NEW.input) THEN RAISE EXCEPTION 'TUITION_SESSIONS_INPUT_INVALID' USING ERRCODE='23514';END IF;
 s=public.tuition_session_allocation_source(NEW.input);SELECT * INTO h FROM public.tuition_session_allocations WHERE academy_id=NEW.academy_id AND plan_id=NEW.plan_id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 context=jsonb_build_object('hubId',s#>>'{invoice,hubId}','classId',s#>>'{invoice,classId}','studentId',s#>>'{invoice,studentId}');
 IF h.plan_id IS NULL OR h.version<>NEW.version OR(NEW.version=1 AND h.created_by<>NEW.changed_by) OR NEW.version<>(NEW.input->>'expectedVersion')::integer+1 OR NEW.version<>(SELECT count(*)+1 FROM public.tuition_session_allocation_revisions WHERE academy_id=NEW.academy_id AND plan_id=NEW.plan_id)
 OR s IS NULL OR s ? 'unavailable' OR s#>>'{invoice,planId}' IS DISTINCT FROM NEW.plan_id::text OR NEW.source_snapshot-'before' IS DISTINCT FROM s-'before' OR NEW.source_snapshot#>>'{before,version}' IS DISTINCT FROM NEW.input->>'expectedVersion'
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'finance.tuition-sessions.replace' OR p.target_id IS DISTINCT FROM NEW.plan_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'tuition-sessions.view' OR p.scope->'recordContext' IS DISTINCT FROM context OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM NEW.source_snapshot OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'TUITION_SESSIONS_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER tuition_sessions_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tuition_session_allocation_revisions FOR EACH ROW EXECUTE FUNCTION public.tuition_sessions_revision_guard();
CREATE CONSTRAINT TRIGGER tuition_sessions_reviewed AFTER INSERT ON public.tuition_session_allocation_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.tuition_sessions_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;BEGIN
 s=public.tuition_session_allocation_source(NEW.input);
 IF s IS NULL OR s-'before' IS DISTINCT FROM NEW.source_snapshot-'before' THEN RAISE EXCEPTION 'TUITION_SESSIONS_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.plan_id AND e.actor_id=NEW.changed_by AND e.action='finance.tuition-sessions.replaced' AND e.created_at=transaction_timestamp() AND e.changes=jsonb_build_object('severity','critical','approvalId',NEW.approval_id,'afterVersion',NEW.version,'accountingPosted',false)) THEN RAISE EXCEPTION 'TUITION_SESSIONS_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tuition_sessions_complete AFTER INSERT ON public.tuition_session_allocation_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tuition_sessions_complete();
CREATE FUNCTION public.tuition_sessions_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.tuition-sessions.replace' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.tuition_session_allocation_revisions r WHERE r.academy_id=NEW.academy_id AND r.plan_id=NEW.target_id AND r.version=NEW.target_version+1 AND r.approval_id=NEW.id AND r.changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'TUITION_SESSIONS_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tuition_sessions_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tuition_sessions_effect_required();
CREATE FUNCTION public.tuition_sessions_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE x record;s jsonb;BEGIN
 SELECT id,hub_id,class_id,student_id INTO x FROM public.tuition_invoices WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'invoiceId')::uuid;
 IF x.id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',x.class_id,'hubId',x.hub_id)),'recordContext',jsonb_build_object('hubId',x.hub_id,'classId',x.class_id,'studentId',x.student_id));NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','invoices.view','scope',s),jsonb_build_object('capability','classes.view','scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',x.class_id,'hubId',x.hub_id)))));RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_tuition_sessions_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='finance.tuition-sessions.replace') EXECUTE FUNCTION public.tuition_sessions_privacy();
REVOKE ALL ON FUNCTION public.tuition_sessions_input_valid(jsonb),public.tuition_session_allocation_source(jsonb),public.tuition_sessions_revision_guard(),public.tuition_sessions_complete(),public.tuition_sessions_effect_required(),public.tuition_sessions_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tuition_sessions_input_valid(jsonb),public.tuition_session_allocation_source(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 105 $$;

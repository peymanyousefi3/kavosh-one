-- Operational rechecks only: never resend,replace the historical provider
-- document,approve evidence,backdate signing or clear admission/earned pay.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('signature-completions.retry','Request upper-approved enrollment agreement rechecks','People',true,ARRAY['hub','class','person','country','region','city']),
 ('work-signature-completions.retry','Request upper-approved worker agreement rechecks','Finance',true,ARRAY['hub','person','country','region','city']);
ALTER TABLE public.signature_completion_jobs ADD COLUMN retry_version integer NOT NULL DEFAULT 0 CHECK(retry_version>=0);
GRANT SELECT(retry_version) ON public.signature_completion_jobs TO kavosh_runtime;
GRANT SELECT(hub_id) ON public.work_agreement_preparations TO kavosh_signature_completion_policy;
GRANT SELECT(hub_id,class_id,student_id) ON public.agreement_packages TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,hub_id) ON public.people TO kavosh_signature_completion_policy;
CREATE POLICY completion_retry_person_read ON public.people FOR SELECT TO kavosh_signature_completion_policy USING(true);
GRANT SELECT(academy_id,id,action,target_id,target_version,status,requester_id,payload,review_context,scope,privacy_capability,reviewer_id) ON public.approval_requests TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,request_id,entity_id,actor_id,action,created_at,changes) ON public.audit_events TO kavosh_signature_completion_policy;
GRANT SELECT(id,master_person_id) ON public.academies TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,request_id,entity_id,event_type) ON public.outbox_events TO kavosh_signature_completion_policy;
CREATE POLICY completion_retry_approval_read ON public.approval_requests FOR SELECT TO kavosh_signature_completion_policy USING(true);
CREATE POLICY completion_retry_audit_read ON public.audit_events FOR SELECT TO kavosh_signature_completion_policy USING(true);
CREATE POLICY completion_retry_event_read ON public.outbox_events FOR SELECT TO kavosh_signature_completion_policy USING(true);
GRANT EXECUTE ON FUNCTION public.report_comment_human_verified(uuid),public.is_supervisor(uuid,uuid) TO kavosh_signature_completion_policy;
GRANT CREATE ON SCHEMA public TO kavosh_signature_completion_policy;

CREATE FUNCTION public.signature_completion_retry_source(p_purpose text,p_start uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;q public.signature_completion_jobs;s jsonb;scope jsonb;request_id uuid;hub uuid;BEGIN
 SELECT * INTO q FROM public.signature_completion_jobs WHERE academy_id=tenant AND purpose=p_purpose AND start_id=p_start;
 IF NOT FOUND OR q.state NOT IN('queued','blocked') OR NOT EXISTS(SELECT 1 FROM public.academies WHERE id=tenant AND status='active')
 OR NOT EXISTS(SELECT 1 FROM public.signature_connections WHERE academy_id=tenant AND id=q.connection_id AND enabled) THEN RETURN NULL;END IF;
 s=public.signature_completion_job_source(tenant,p_purpose,p_start);
 IF s IS NULL OR s->>'sourceFingerprint' IS DISTINCT FROM q.source_fingerprint THEN RETURN NULL;END IF;
 IF p_purpose='worker_services' THEN
  request_id=(s->>'requestId')::uuid;
  SELECT w.hub_id,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',w.worker_id,'hubId',w.hub_id)),'workContext',jsonb_build_object('personId',w.worker_id,'hubId',w.hub_id)) INTO hub,scope
  FROM public.work_agreement_preparations w WHERE w.academy_id=tenant AND w.id=(s->>'preparationId')::uuid;
 ELSE
  SELECT a.request_id INTO request_id FROM public.signature_dispatch_starts d JOIN public.signature_send_attempts a ON a.academy_id=d.academy_id AND a.id=d.attempt_id WHERE d.academy_id=tenant AND d.id=p_start;
  SELECT p.hub_id,jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',p.class_id,'hubId',p.hub_id)),'people',(SELECT jsonb_agg(jsonb_build_object('id',x.id,'hubId',x.hub_id) ORDER BY x.id) FROM public.people x WHERE x.academy_id=tenant AND x.id=ANY(ARRAY[p.student_id,p.signer_id]))) INTO hub,scope
  FROM public.agreement_packages p WHERE p.academy_id=tenant AND p.id=(s->>'packageId')::uuid;
 END IF;
 IF request_id IS NULL OR scope IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('purpose',p_purpose,'startId',p_start,'requestId',request_id,'hubId',hub,'scope',scope,'retryVersion',q.retry_version,'state',q.state,'attemptCount',q.attempt_no,'lastFinishedAt',q.last_finished_at,'retryNotBefore',q.available_at,'checkWindowEndsAt',q.poll_until,'sourceFingerprint',q.source_fingerprint);
END $$;
ALTER FUNCTION public.signature_completion_retry_source(text,uuid) OWNER TO kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.signature_completion_retry_source(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_completion_retry_source(text,uuid) TO kavosh_runtime;

CREATE TABLE public.signature_completion_retries(
 academy_id uuid NOT NULL,purpose text NOT NULL,start_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 approval_id uuid NOT NULL,input jsonb NOT NULL,source jsonb NOT NULL,requested_by uuid NOT NULL,changed_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,purpose,start_id,version),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,purpose,start_id) REFERENCES public.signature_completion_jobs(academy_id,purpose,start_id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 FOREIGN KEY(academy_id,requested_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id)
);
ALTER TABLE public.signature_completion_retries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_completion_retries FORCE ROW LEVEL SECURITY;
CREATE POLICY completion_retry_tenant ON public.signature_completion_retries TO kavosh_runtime USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY completion_retry_executor ON public.signature_completion_retries TO kavosh_signature_completion_policy USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON public.signature_completion_retries TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,purpose,start_id,version,approval_id,input,requested_by,changed_by,created_at) ON public.signature_completion_retries TO kavosh_runtime;
GRANT INSERT(academy_id,purpose,start_id,version,approval_id,input,source,requested_by,changed_by) ON public.signature_completion_retries TO kavosh_runtime;

CREATE FUNCTION public.guard_signature_completion_retry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p record;q public.signature_completion_jobs;s jsonb;is_master boolean;action text;privacy text;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_RETRY_IMMUTABLE';END IF;
 IF NEW.academy_id IS DISTINCT FROM nullif(current_setting('app.academy_id',true),'')::uuid THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_RETRY_TENANT_REQUIRED';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||CASE WHEN NEW.purpose='worker_services' THEN ':work-signature-transport:' ELSE ':signature-transport:' END||NEW.start_id::text,0));
 SELECT * INTO q FROM public.signature_completion_jobs WHERE academy_id=NEW.academy_id AND purpose=NEW.purpose AND start_id=NEW.start_id FOR UPDATE;
 s=public.signature_completion_retry_source(NEW.purpose,NEW.start_id);
 action=CASE WHEN NEW.purpose='worker_services' THEN 'work.signature.completion.retry' ELSE 'signature.completion.retry' END;
 privacy=CASE WHEN NEW.purpose='worker_services' THEN 'work-signature-completions.view' ELSE 'signature-completions.view' END;
 SELECT a.id,a.action,a.target_id,a.target_version,a.status,a.requester_id,a.payload,a.review_context,a.scope,a.privacy_capability INTO p FROM public.approval_requests a WHERE a.academy_id=NEW.academy_id AND a.id=NEW.approval_id;
 -- Compare the actually locked row, not just a pre-wait approval snapshot.
 -- A background claim/finish may have committed while this insert waited.
 IF q.start_id IS NULL OR q.state NOT IN('queued','blocked') OR s IS NULL OR NEW.source IS DISTINCT FROM s OR NEW.version IS DISTINCT FROM q.retry_version+1
 OR s->'state' IS DISTINCT FROM to_jsonb(q.state) OR s->'attemptCount' IS DISTINCT FROM to_jsonb(q.attempt_no)
 OR s->'retryNotBefore' IS DISTINCT FROM to_jsonb(q.available_at) OR s->'lastFinishedAt' IS DISTINCT FROM coalesce(to_jsonb(q.last_finished_at),'null'::jsonb)
 OR s->'checkWindowEndsAt' IS DISTINCT FROM to_jsonb(q.poll_until)
 OR jsonb_typeof(NEW.input) IS DISTINCT FROM 'object' OR NOT(NEW.input ?& ARRAY['expectedVersion','checkWindowDays','reason','requestId','purpose','startId'])
 OR NEW.input-ARRAY['expectedVersion','checkWindowDays','reason','requestId','purpose','startId']<>'{}'::jsonb
 OR NEW.input->'expectedVersion' IS DISTINCT FROM to_jsonb(q.retry_version) OR NEW.input->'purpose' IS DISTINCT FROM to_jsonb(NEW.purpose)
 OR NEW.input->'startId' IS DISTINCT FROM to_jsonb(NEW.start_id) OR NEW.input->'requestId' IS DISTINCT FROM s->'requestId'
 OR jsonb_typeof(NEW.input->'checkWindowDays') IS DISTINCT FROM 'number' OR NEW.input->>'checkWindowDays'!~'^[1-9][0-9]?$' OR (NEW.input->>'checkWindowDays')::integer>30
 OR jsonb_typeof(NEW.input->'reason') IS DISTINCT FROM 'string' OR length(btrim(NEW.input->>'reason')) NOT BETWEEN 1 AND 2000
 OR p.id IS NULL OR p.action IS DISTINCT FROM action OR p.target_id IS DISTINCT FROM NEW.start_id OR p.target_version IS DISTINCT FROM q.retry_version OR p.status IS DISTINCT FROM 'pending'
 OR p.requester_id IS DISTINCT FROM NEW.requested_by OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM jsonb_build_object('source',s)
 OR p.scope IS DISTINCT FROM s->'scope' OR p.privacy_capability IS DISTINCT FROM privacy
 OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_RETRY_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT master_person_id=NEW.changed_by INTO is_master FROM public.academies WHERE id=NEW.academy_id;
 IF NOT coalesce(is_master,false) AND(NEW.changed_by=NEW.requested_by OR NOT public.is_supervisor(NEW.changed_by,NEW.requested_by)) THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_RETRY_UPPER_REQUIRED' USING ERRCODE='23514';END IF;
 UPDATE public.signature_completion_jobs SET state='queued',failures=0,priority=100,retry_version=NEW.version,available_at=clock_timestamp(),poll_until=greatest(poll_until,clock_timestamp()+(NEW.input->>'checkWindowDays')::integer*interval '1 day') WHERE academy_id=NEW.academy_id AND purpose=NEW.purpose AND start_id=NEW.start_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_RETRY_QUEUE_REQUIRED';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
ALTER FUNCTION public.guard_signature_completion_retry() OWNER TO kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.guard_signature_completion_retry() FROM PUBLIC;
CREATE TRIGGER signature_completion_retry_guard BEFORE INSERT OR UPDATE OR DELETE ON public.signature_completion_retries FOR EACH ROW EXECUTE FUNCTION public.guard_signature_completion_retry();

CREATE FUNCTION public.require_signature_completion_retry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE event_action text:=CASE WHEN NEW.purpose='worker_services' THEN 'work.signature.completion.retry' ELSE 'signature.completion.retry' END;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id AND status='applied' AND reviewer_id=NEW.changed_by)
 OR NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events o ON o.academy_id=a.academy_id AND o.request_id=a.request_id AND o.entity_id=a.entity_id AND o.event_type=a.action WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.start_id AND a.actor_id=NEW.changed_by AND a.action=event_action AND a.created_at=transaction_timestamp() AND a.changes->>'retryVersion'=NEW.version::text AND a.changes->>'approvalId'=NEW.approval_id::text AND a.changes->>'severity'='critical') THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_RETRY_INCOMPLETE_AT_COMMIT' USING ERRCODE='55000';END IF;
 RETURN NULL;
END $$;
ALTER FUNCTION public.require_signature_completion_retry() OWNER TO kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.require_signature_completion_retry() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER signature_completion_retry_complete AFTER INSERT ON public.signature_completion_retries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_signature_completion_retry();
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_completion_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 392 $$;

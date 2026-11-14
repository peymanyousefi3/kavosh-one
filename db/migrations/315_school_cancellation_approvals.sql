INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('academy-subscription.request','Request or withdraw own academy cancellation','Administration',true,ARRAY['academy']);
-- Independent case serialization avoids upgrading the web transaction's shared
-- subscription lock. Platform writers still take310 exclusively before315.
CREATE OR REPLACE FUNCTION platform_private.guard_open_school_cancellation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,315));
 IF EXISTS(SELECT 1 FROM platform_private.school_cancellation_requests r WHERE r.academy_id=NEW.academy_id AND NOT EXISTS(SELECT 1 FROM platform_private.school_cancellation_decisions d WHERE d.request_id=r.id)) THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_ALREADY_PENDING' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TABLE public.school_cancellation_approvals(
 academy_id uuid NOT NULL,approval_id uuid NOT NULL,case_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN('academy.subscription.cancel-request','academy.subscription.cancel-withdraw')),
 requester_id uuid NOT NULL,reviewer_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,approval_id),UNIQUE(academy_id,case_id,action),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 FOREIGN KEY(academy_id,case_id) REFERENCES platform_private.school_cancellation_requests(academy_id,id),
 FOREIGN KEY(academy_id,requester_id) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,reviewer_id) REFERENCES public.people(academy_id,id)
);
ALTER TABLE public.school_cancellation_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_cancellation_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.school_cancellation_approvals USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE TRIGGER school_cancellation_approval_immutable BEFORE UPDATE OR DELETE ON public.school_cancellation_approvals FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
REVOKE ALL ON public.school_cancellation_approvals FROM PUBLIC;
GRANT SELECT ON public.school_cancellation_approvals TO kavosh_runtime;
GRANT SELECT,INSERT ON public.school_cancellation_approvals TO kavosh_platform_policy;
GRANT SELECT ON public.approval_requests TO kavosh_platform_policy;
GRANT EXECUTE ON FUNCTION public.lock_human(uuid,uuid) TO kavosh_platform_policy;
CREATE FUNCTION public.guard_school_cancellation_approval_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF OLD.action IN('academy.subscription.cancel-request','academy.subscription.cancel-withdraw') OR NEW.action IN('academy.subscription.cancel-request','academy.subscription.cancel-withdraw') THEN
  IF ROW(NEW.academy_id,NEW.id,NEW.requester_id,NEW.requester_kind,NEW.credential_snapshot,NEW.grants_hash,NEW.action,NEW.target_id,NEW.target_version,NEW.payload,NEW.scope,NEW.dependency_hash,NEW.review_context,NEW.privacy_capability,NEW.privacy_bindings,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.requester_id,OLD.requester_kind,OLD.credential_snapshot,OLD.grants_hash,OLD.action,OLD.target_id,OLD.target_version,OLD.payload,OLD.scope,OLD.dependency_hash,OLD.review_context,OLD.privacy_capability,OLD.privacy_bindings,OLD.created_at)
   OR(OLD.status<>'pending' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'SCHOOL_CANCELLATION_APPROVAL_SOURCE_IMMUTABLE' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_school_cancellation_approval_source() FROM PUBLIC;
CREATE TRIGGER school_cancellation_approval_source BEFORE UPDATE ON public.approval_requests FOR EACH ROW WHEN(OLD.action IN('academy.subscription.cancel-request','academy.subscription.cancel-withdraw') OR NEW.action IN('academy.subscription.cancel-request','academy.subscription.cancel-withdraw')) EXECUTE FUNCTION public.guard_school_cancellation_approval_source();
CREATE FUNCTION public.apply_school_cancellation(p_approval uuid,p_reviewer uuid,p_session uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;p public.approval_requests;u uuid;v integer;data jsonb;result jsonb;aid uuid:=gen_random_uuid();at_time timestamptz;inserted uuid;action_name text;ack integer;
BEGIN
 IF tenant IS NULL THEN RAISE EXCEPTION 'SCHOOL_MASTER_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,310));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text,315));
 SELECT h.auth_user_id,a.subscription_version INTO u,v FROM public.academies a JOIN public.people h ON h.academy_id=a.id AND h.id=a.master_person_id
 WHERE a.id=tenant AND h.id=p_reviewer AND h.kind='human' AND h.status='active' AND a.status IN('active','read_only');
 IF u IS NULL OR NOT public.lock_human(p_session,u) THEN RAISE EXCEPTION 'SCHOOL_MASTER_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=tenant AND id=p_approval;
 IF NOT FOUND OR p.status<>'pending' OR p.action NOT IN('academy.subscription.cancel-request','academy.subscription.cancel-withdraw')
 OR p.privacy_capability IS DISTINCT FROM 'academy-subscription.view' OR p.scope IS DISTINCT FROM '{"all":true,"hubs":[]}'::jsonb
 OR jsonb_typeof(p.payload) IS DISTINCT FROM 'object' OR p.payload-ARRAY['expectedVersion','reason']<>'{}'::jsonb
 OR jsonb_typeof(p.payload->'reason') IS DISTINCT FROM 'string' OR length(btrim(p.payload->>'reason')) NOT BETWEEN 1 AND 2000
 THEN RAISE EXCEPTION 'SCHOOL_CANCELLATION_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM platform_private.request_receipts WHERE user_id=u AND request_key=p.id) THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;
 IF p.action='academy.subscription.cancel-request' THEN
  IF p.target_version<>0 OR p.payload->'expectedVersion' IS DISTINCT FROM to_jsonb(v) THEN RAISE EXCEPTION 'PLATFORM_SUBSCRIPTION_VERSION_CHANGED' USING ERRCODE='23514';END IF;
  at_time=clock_timestamp();
  INSERT INTO platform_private.school_cancellation_requests(id,academy_id,source_version,requested_at,review_after,actor_user_id,session_id,request_key,audit_id)
   VALUES(p.target_id,tenant,v,at_time,at_time+interval '720 hours',u,p_session,p.id,aid) RETURNING id INTO inserted;
  IF inserted IS DISTINCT FROM p.target_id THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_EFFECTS_MISSING' USING ERRCODE='XX000';END IF;
  SELECT original_data INTO data FROM platform_private.school_cancellation_cases WHERE academy_id=tenant AND id=p.target_id;action_name='platform.subscription.cancellation.requested';
 ELSE
  IF p.target_version<>1 OR p.payload->'expectedVersion' IS DISTINCT FROM '1'::jsonb THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_ALREADY_DECIDED' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM platform_private.school_cancellation_requests WHERE academy_id=tenant AND id=p.target_id) OR EXISTS(SELECT 1 FROM platform_private.school_cancellation_decisions WHERE request_id=p.target_id) THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_ALREADY_DECIDED' USING ERRCODE='23514';END IF;
  INSERT INTO platform_private.school_cancellation_decisions(request_id,academy_id,decision,actor_user_id,session_id,request_key,audit_id)
   VALUES(p.target_id,tenant,'withdrawn',u,p_session,p.id,aid) RETURNING request_id INTO inserted;
  IF inserted IS DISTINCT FROM p.target_id THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_EFFECTS_MISSING' USING ERRCODE='XX000';END IF;
  SELECT current_data INTO data FROM platform_private.school_cancellation_cases WHERE academy_id=tenant AND id=p.target_id;action_name='platform.subscription.cancellation.withdrawn';
 END IF;
 result=jsonb_build_object('status',200,'body',jsonb_build_object('data',data,'schoolAccessChanged',false,'cancellationPerformed',false,'deletionPerformed',false,'chargesPerformed',false));
 INSERT INTO platform_private.audit_events(id,actor_user_id,session_id,request_key,action,academy_id,after_data,reason) VALUES(aid,u,p_session,p.id,action_name,tenant,data,p.payload->>'reason') RETURNING 1 INTO ack;
 IF ack IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'SCHOOL_CANCELLATION_AUDIT_MISSING' USING ERRCODE='XX000';END IF;
 INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(u,p.id,encode(sha256(convert_to(jsonb_build_object('operation',p.action,'approvalId',p.id,'input',p.payload)::text,'UTF8')),'hex'),result) RETURNING 1 INTO ack;
 IF ack IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'SCHOOL_CANCELLATION_RECEIPT_MISSING' USING ERRCODE='XX000';END IF;
 INSERT INTO public.school_cancellation_approvals(academy_id,approval_id,case_id,action,requester_id,reviewer_id) VALUES(tenant,p.id,p.target_id,p.action,p.requester_id,p_reviewer) RETURNING approval_id INTO inserted;
 IF inserted IS DISTINCT FROM p.id THEN RAISE EXCEPTION 'SCHOOL_CANCELLATION_APPROVAL_EFFECTS_MISSING' USING ERRCODE='XX000';END IF;
 RETURN result->'body';
END $$;
-- Both directions are checked at commit: a forged applied approval cannot omit
-- its case, nor can a case escape while its school approval remains pending.
CREATE FUNCTION public.verify_school_cancellation_approval() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public.approval_requests;l public.school_cancellation_approvals;r record;u uuid;why text;fingerprint text;BEGIN
 IF TG_TABLE_NAME='approval_requests' THEN
  IF NEW.status<>'applied' OR NEW.action NOT IN('academy.subscription.cancel-request','academy.subscription.cancel-withdraw') THEN RETURN NULL;END IF;
  SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.id;
 ELSE SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;END IF;
 SELECT * INTO l FROM public.school_cancellation_approvals WHERE academy_id=p.academy_id AND approval_id=p.id;
 SELECT h.auth_user_id INTO u FROM public.academies a JOIN public.people h ON h.academy_id=a.id AND h.id=a.master_person_id WHERE a.id=p.academy_id AND h.id=l.reviewer_id;
 IF l.action='academy.subscription.cancel-request' THEN SELECT actor_user_id,request_key,audit_id,source_version AS source INTO r FROM platform_private.school_cancellation_requests WHERE academy_id=l.academy_id AND id=l.case_id;
 ELSE SELECT actor_user_id,request_key,audit_id,1 AS source FROM platform_private.school_cancellation_decisions WHERE academy_id=l.academy_id AND request_id=l.case_id AND decision='withdrawn' INTO r;END IF;
 SELECT reason INTO why FROM platform_private.audit_events WHERE id=r.audit_id;
 SELECT q.fingerprint INTO fingerprint FROM platform_private.request_receipts q WHERE q.user_id=r.actor_user_id AND q.request_key=r.request_key;
 IF p.id IS NULL OR p.status IS DISTINCT FROM 'applied' OR l.approval_id IS NULL OR l.action IS DISTINCT FROM p.action OR l.case_id IS DISTINCT FROM p.target_id
 OR l.requester_id IS DISTINCT FROM p.requester_id OR l.reviewer_id IS DISTINCT FROM p.reviewer_id OR u IS NULL OR r.actor_user_id IS DISTINCT FROM u OR r.request_key IS DISTINCT FROM p.id
 OR p.payload->'expectedVersion' IS DISTINCT FROM to_jsonb(r.source) OR p.scope IS DISTINCT FROM '{"all":true,"hubs":[]}'::jsonb OR p.privacy_capability IS DISTINCT FROM 'academy-subscription.view'
 OR why IS DISTINCT FROM p.payload->>'reason' OR fingerprint IS DISTINCT FROM encode(sha256(convert_to(jsonb_build_object('operation',p.action,'approvalId',p.id,'input',p.payload)::text,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'SCHOOL_CANCELLATION_APPROVAL_EFFECTS_MISSING' USING ERRCODE='XX000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER school_cancellation_link_complete AFTER INSERT ON public.school_cancellation_approvals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.verify_school_cancellation_approval();
CREATE CONSTRAINT TRIGGER school_cancellation_applied_complete AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='applied' AND NEW.action IN('academy.subscription.cancel-request','academy.subscription.cancel-withdraw')) EXECUTE FUNCTION public.verify_school_cancellation_approval();
REVOKE ALL ON FUNCTION public.apply_school_cancellation(uuid,uuid,uuid),public.verify_school_cancellation_approval() FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO kavosh_platform_policy;
ALTER FUNCTION public.apply_school_cancellation(uuid,uuid,uuid) OWNER TO kavosh_platform_policy;
ALTER FUNCTION public.verify_school_cancellation_approval() OWNER TO kavosh_platform_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_platform_policy;
GRANT EXECUTE ON FUNCTION public.apply_school_cancellation(uuid,uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 315 $$;

-- Recorded cancellation intent is not cancellation,termination or deletion.
-- The native clock starts the30-day review window;clients cannot backdate it.
CREATE TABLE platform_private.school_cancellation_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),academy_id uuid NOT NULL REFERENCES public.academies(id),
 source_version integer NOT NULL CHECK(source_version>=0),linked_source_version integer GENERATED ALWAYS AS(nullif(source_version,0)) STORED,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),review_after timestamptz NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES identity."user"(id),session_id uuid NOT NULL,request_key uuid NOT NULL,audit_id uuid NOT NULL UNIQUE,
 UNIQUE(academy_id,id),CHECK(review_after=requested_at+interval '720 hours'),
 FOREIGN KEY(academy_id,linked_source_version) REFERENCES platform_private.school_subscription_editions(academy_id,version),
 FOREIGN KEY(audit_id) REFERENCES platform_private.audit_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(actor_user_id,request_key) REFERENCES platform_private.request_receipts(user_id,request_key) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX school_cancellations_directory ON platform_private.school_cancellation_requests(academy_id,id);
CREATE TABLE platform_private.school_cancellation_decisions(
 request_id uuid PRIMARY KEY,academy_id uuid NOT NULL,decision text NOT NULL CHECK(decision='withdrawn'),decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_user_id uuid NOT NULL REFERENCES identity."user"(id),session_id uuid NOT NULL,request_key uuid NOT NULL,audit_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(academy_id,request_id) REFERENCES platform_private.school_cancellation_requests(academy_id,id),
 FOREIGN KEY(audit_id) REFERENCES platform_private.audit_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(actor_user_id,request_key) REFERENCES platform_private.request_receipts(user_id,request_key) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER cancellation_request_immutable BEFORE UPDATE OR DELETE ON platform_private.school_cancellation_requests FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER cancellation_decision_immutable BEFORE UPDATE OR DELETE ON platform_private.school_cancellation_decisions FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE VIEW platform_private.school_cancellation_cases AS
 SELECT r.id,r.academy_id,
 jsonb_build_object('id',r.id,'academyId',r.academy_id,'version',1,'status','pending','requestedSubscriptionVersion',r.source_version,'requestedAt',r.requested_at,'reviewAfter',r.review_after,'withdrawnAt',NULL) AS original_data,
 jsonb_build_object('id',r.id,'academyId',r.academy_id,'version',CASE WHEN d.request_id IS NULL THEN 1 ELSE 2 END,'status',coalesce(d.decision,'pending'),'requestedSubscriptionVersion',r.source_version,'requestedAt',r.requested_at,'reviewAfter',r.review_after,'withdrawnAt',d.decided_at) AS current_data
 FROM platform_private.school_cancellation_requests r LEFT JOIN platform_private.school_cancellation_decisions d ON d.request_id=r.id;
CREATE FUNCTION platform_private.guard_open_school_cancellation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,310));
 IF EXISTS(SELECT 1 FROM platform_private.school_cancellation_requests r WHERE r.academy_id=NEW.academy_id AND NOT EXISTS(SELECT 1 FROM platform_private.school_cancellation_decisions d WHERE d.request_id=r.id)) THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_ALREADY_PENDING' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER one_open_cancellation BEFORE INSERT ON platform_private.school_cancellation_requests FOR EACH ROW EXECUTE FUNCTION platform_private.guard_open_school_cancellation();
CREATE FUNCTION platform_private.verify_school_cancellation_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE data jsonb;a record;r record;action_name text;BEGIN
 IF TG_TABLE_NAME='school_cancellation_requests' THEN
  SELECT original_data INTO data FROM platform_private.school_cancellation_cases WHERE id=NEW.id;action_name='platform.subscription.cancellation.requested';
 ELSE
  SELECT current_data INTO data FROM platform_private.school_cancellation_cases WHERE id=NEW.request_id;action_name='platform.subscription.cancellation.withdrawn';
 END IF;
 SELECT * INTO a FROM platform_private.audit_events WHERE id=NEW.audit_id;
 SELECT * INTO r FROM platform_private.request_receipts WHERE user_id=NEW.actor_user_id AND request_key=NEW.request_key;
 IF data IS NULL OR a.actor_user_id IS DISTINCT FROM NEW.actor_user_id OR a.session_id IS DISTINCT FROM NEW.session_id OR a.request_key IS DISTINCT FROM NEW.request_key OR a.academy_id IS DISTINCT FROM NEW.academy_id
 OR a.action IS DISTINCT FROM action_name OR a.after_data IS DISTINCT FROM data OR r.result->'body'->'data' IS DISTINCT FROM data THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_EFFECTS_MISSING' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cancellation_request_complete AFTER INSERT ON platform_private.school_cancellation_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.verify_school_cancellation_record();
CREATE CONSTRAINT TRIGGER cancellation_decision_complete AFTER INSERT ON platform_private.school_cancellation_decisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.verify_school_cancellation_record();
CREATE FUNCTION platform_private.cancellation_request(p_user uuid,p_session uuid,p_operation text,p_key uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE school uuid;target uuid;v integer;why text;data jsonb;response jsonb;receipt record;fingerprint text;audit_id uuid:=gen_random_uuid();at_time timestamptz;lim integer;cursor uuid;next_id uuid;status integer:=200;action_name text;inserted uuid;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF p_operation IS NULL OR p_operation NOT IN('cancellations.list','cancellations.get','cancellations.request','cancellations.withdraw') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384
 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;school=(p_input->>'academyId')::uuid;
 IF p_operation IN('cancellations.request','cancellations.withdraw') THEN PERFORM pg_advisory_xact_lock(hashtextextended(school::text,310));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,8));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,9));END IF;
 PERFORM platform_private.authorize_owner(p_user,p_session,true);
 IF p_operation IN('cancellations.request','cancellations.withdraw') THEN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  fingerprint=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));
  SELECT * INTO receipt FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
  IF FOUND THEN IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN receipt.result;END IF;
  why=p_input->>'reason';IF jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR length(btrim(why)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 END IF;
 SELECT subscription_version INTO v FROM public.academies WHERE id=school;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF p_operation IN('cancellations.get','cancellations.withdraw') THEN
  IF jsonb_typeof(p_input->'cancellationId') IS DISTINCT FROM 'string' OR p_input->>'cancellationId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;target=(p_input->>'cancellationId')::uuid;
 END IF;
 IF p_operation='cancellations.list' THEN
  IF p_input-ARRAY['academyId','limit','after']<>'{}'::jsonb OR(p_input?'limit' AND(jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^([1-9][0-9]?|100)$')) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;lim=coalesce((p_input->>'limit')::integer,50);
  IF p_input?'after' THEN IF jsonb_typeof(p_input->'after') IS DISTINCT FROM 'string' OR p_input->>'after'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;cursor=(p_input->>'after')::uuid;END IF;
  SELECT coalesce(jsonb_agg(current_data ORDER BY id),'[]'::jsonb) INTO data FROM(SELECT id,current_data FROM platform_private.school_cancellation_cases WHERE academy_id=school AND(cursor IS NULL OR id>cursor) ORDER BY id LIMIT lim+1)c;
  IF jsonb_array_length(data)>lim THEN next_id=(data->(lim-1)->>'id')::uuid;data=data-lim;END IF;
  response=jsonb_build_object('data',data,'nextCursor',next_id);action_name='platform.subscription.cancellations.read';
 ELSIF p_operation='cancellations.get' THEN
  IF p_input-ARRAY['academyId','cancellationId']<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  SELECT current_data INTO data FROM platform_private.school_cancellation_cases WHERE academy_id=school AND id=target;
  IF data IS NULL THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_NOT_FOUND' USING ERRCODE='P0002';END IF;response=jsonb_build_object('data',data);action_name='platform.subscription.cancellation.read';
 ELSE
  IF p_operation='cancellations.request' THEN
   IF p_input-ARRAY['academyId','expectedVersion','reason']<>'{}'::jsonb OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion'!~'^(0|[1-9][0-9]{0,9})$' OR(p_input->>'expectedVersion')::numeric>2147483647 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
   IF v<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'PLATFORM_SUBSCRIPTION_VERSION_CHANGED' USING ERRCODE='23514';END IF;
   target=gen_random_uuid();at_time=clock_timestamp();status=201;action_name='platform.subscription.cancellation.requested';
   INSERT INTO platform_private.school_cancellation_requests(id,academy_id,source_version,requested_at,review_after,actor_user_id,session_id,request_key,audit_id) VALUES(target,school,v,at_time,at_time+interval '720 hours',p_user,p_session,p_key,audit_id) RETURNING id INTO inserted;
   IF inserted IS DISTINCT FROM target THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
   SELECT original_data INTO data FROM platform_private.school_cancellation_cases WHERE id=target;
  ELSE
   IF p_input-ARRAY['academyId','cancellationId','expectedVersion','reason']<>'{}'::jsonb OR p_input->'expectedVersion' IS DISTINCT FROM '1'::jsonb THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
   IF NOT EXISTS(SELECT 1 FROM platform_private.school_cancellation_requests WHERE academy_id=school AND id=target) THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_NOT_FOUND' USING ERRCODE='P0002';END IF;
   IF EXISTS(SELECT 1 FROM platform_private.school_cancellation_decisions WHERE request_id=target) THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_ALREADY_DECIDED' USING ERRCODE='23514';END IF;
   action_name='platform.subscription.cancellation.withdrawn';INSERT INTO platform_private.school_cancellation_decisions(request_id,academy_id,decision,actor_user_id,session_id,request_key,audit_id) VALUES(target,school,'withdrawn',p_user,p_session,p_key,audit_id) RETURNING request_id INTO inserted;
   IF inserted IS DISTINCT FROM target THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
   SELECT current_data INTO data FROM platform_private.school_cancellation_cases WHERE id=target;
  END IF;
  response=jsonb_build_object('status',status,'body',jsonb_build_object('data',data,'schoolAccessChanged',false,'cancellationPerformed',false,'deletionPerformed',false,'chargesPerformed',false));
  INSERT INTO platform_private.audit_events(id,actor_user_id,session_id,request_key,action,academy_id,after_data,reason) VALUES(audit_id,p_user,p_session,p_key,action_name,school,data,why);
  INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,response);RETURN response;
 END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data) VALUES(p_user,p_session,action_name,school,jsonb_build_object('academyId',school));RETURN jsonb_build_object('status',200,'body',response);
END $$;
DO $$ DECLARE d text;marker text:=' PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 d=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(d)-length(replace(d,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'PLATFORM_GATEWAY_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,marker,marker||E'\n IF p_operation IN(''cancellations.list'',''cancellations.get'',''cancellations.request'',''cancellations.withdraw'') THEN RETURN platform_private.cancellation_request(p_user,p_session,p_operation,p_key,p_input);END IF;');
END $$;
REVOKE ALL ON FUNCTION platform_private.guard_open_school_cancellation(),platform_private.verify_school_cancellation_record(),platform_private.cancellation_request(uuid,uuid,text,uuid,jsonb) FROM PUBLIC;
GRANT SELECT,INSERT ON platform_private.school_cancellation_requests,platform_private.school_cancellation_decisions TO kavosh_platform_policy;
GRANT SELECT ON platform_private.school_cancellation_cases TO kavosh_platform_policy;
GRANT EXECUTE ON FUNCTION platform_private.cancellation_request(uuid,uuid,text,uuid,jsonb) TO kavosh_platform_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
ALTER FUNCTION platform_private.verify_school_cancellation_record() OWNER TO kavosh_platform_policy;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 312 $$;

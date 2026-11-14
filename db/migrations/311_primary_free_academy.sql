-- Explicit identity binding for Kavosh's permanent free licence. Never infer
-- an exemption from a mutable school name,domain,logo or a supplied free flag.
CREATE TABLE platform_private.primary_free_academy(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),academy_id uuid NOT NULL UNIQUE,
 subscription_version integer NOT NULL CHECK(subscription_version>0),
 actor_user_id uuid NOT NULL REFERENCES identity."user"(id),session_id uuid NOT NULL,request_key uuid NOT NULL,
 audit_id uuid NOT NULL UNIQUE REFERENCES platform_private.audit_events(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(academy_id,subscription_version) REFERENCES platform_private.school_subscription_editions(academy_id,version),
 FOREIGN KEY(actor_user_id,request_key) REFERENCES platform_private.request_receipts(user_id,request_key) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER primary_free_immutable BEFORE UPDATE OR DELETE ON platform_private.primary_free_academy FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE FUNCTION platform_private.protect_primary_free_academy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.subscription_terms IS NOT DISTINCT FROM OLD.subscription_terms THEN RETURN NEW;END IF;
 IF EXISTS(SELECT 1 FROM platform_private.primary_free_academy WHERE academy_id=NEW.id)
 AND(NEW.subscription_terms->>'free' IS DISTINCT FROM 'true' OR NEW.subscription_terms->>'expiresAt' IS NOT NULL
 OR NEW.subscription_terms->>'startsAt' IS NULL OR(NEW.subscription_terms->>'startsAt')::timestamptz>clock_timestamp()) THEN
  RAISE EXCEPTION 'PLATFORM_FREE_ACADEMY_PROTECTED' USING ERRCODE='23514';
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER primary_free_protection BEFORE UPDATE ON public.academies FOR EACH ROW EXECUTE FUNCTION platform_private.protect_primary_free_academy();
CREATE FUNCTION platform_private.verify_primary_free_academy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE e record;a record;r record;data jsonb;BEGIN
 SELECT * INTO e FROM platform_private.school_subscription_editions WHERE academy_id=NEW.academy_id AND version=NEW.subscription_version;
 SELECT * INTO a FROM platform_private.audit_events WHERE id=NEW.audit_id;
 SELECT * INTO r FROM platform_private.request_receipts WHERE user_id=NEW.actor_user_id AND request_key=NEW.request_key;
 data=jsonb_build_object('academyId',NEW.academy_id,'subscriptionVersion',NEW.subscription_version,'permanent',true,'paidAssignmentBlocked',true);
 IF e.terms->>'free' IS DISTINCT FROM 'true' OR e.terms->>'expiresAt' IS NOT NULL OR e.terms->>'startsAt' IS NULL OR(e.terms->>'startsAt')::timestamptz>NEW.created_at
 OR a.actor_user_id IS DISTINCT FROM NEW.actor_user_id OR a.session_id IS DISTINCT FROM NEW.session_id OR a.request_key IS DISTINCT FROM NEW.request_key OR a.academy_id IS DISTINCT FROM NEW.academy_id OR a.action IS DISTINCT FROM 'platform.subscription.free-exemption.bound'
 OR a.after_data IS DISTINCT FROM data OR r.result->'body'->'data' IS DISTINCT FROM data THEN RAISE EXCEPTION 'PLATFORM_FREE_ACADEMY_EFFECTS_MISSING' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER primary_free_complete AFTER INSERT ON platform_private.primary_free_academy DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.verify_primary_free_academy();
CREATE FUNCTION platform_private.free_academy_request(p_user uuid,p_session uuid,p_operation text,p_key uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE school uuid;v integer;terms jsonb;data jsonb;response jsonb;receipt record;fingerprint text;why text;audit_id uuid:=gen_random_uuid();inserted uuid;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF p_operation IS NULL OR p_operation NOT IN('subscriptions.free-exemption.get','subscriptions.free-exemption.bind') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384
 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 school=(p_input->>'academyId')::uuid;
 IF p_operation='subscriptions.free-exemption.bind' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-primary-free-academy',311));
  PERFORM pg_advisory_xact_lock(hashtextextended(school::text,310));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,8));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,9));
 END IF;
 PERFORM platform_private.authorize_owner(p_user,p_session,true);
 IF p_operation='subscriptions.free-exemption.get' THEN
  IF p_input-ARRAY['academyId']<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=school) THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
  SELECT jsonb_build_object('academyId',academy_id,'subscriptionVersion',subscription_version,'permanent',true,'paidAssignmentBlocked',true,'registeredAt',created_at) INTO data FROM platform_private.primary_free_academy WHERE academy_id=school;
  IF data IS NULL THEN data=jsonb_build_object('academyId',school,'permanent',false,'paidAssignmentBlocked',false);END IF;
  INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data) VALUES(p_user,p_session,'platform.subscription.free-exemption.read',school,jsonb_build_object('academyId',school));RETURN jsonb_build_object('status',200,'body',jsonb_build_object('data',data));
 END IF;
 IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 fingerprint=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));
 SELECT * INTO receipt FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
 IF FOUND THEN IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN receipt.result;END IF;
 IF p_input-ARRAY['academyId','expectedVersion','confirmAcademyId','permanent','reason']<>'{}'::jsonb OR NOT(p_input?&ARRAY['expectedVersion','confirmAcademyId','permanent','reason'])
 OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion'!~'^[1-9][0-9]{0,9}$' OR(p_input->>'expectedVersion')::numeric>2147483647
 OR p_input->'confirmAcademyId' IS DISTINCT FROM p_input->'academyId' OR p_input->'permanent' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'reason')) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 SELECT subscription_version,subscription_terms INTO v,terms FROM public.academies WHERE id=school FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF v<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'PLATFORM_SUBSCRIPTION_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM platform_private.primary_free_academy) THEN RAISE EXCEPTION 'PLATFORM_FREE_ACADEMY_ALREADY_BOUND' USING ERRCODE='23514';END IF;
 IF terms->>'free' IS DISTINCT FROM 'true' OR terms->>'expiresAt' IS NOT NULL OR terms->>'startsAt' IS NULL OR(terms->>'startsAt')::timestamptz>clock_timestamp() THEN RAISE EXCEPTION 'PLATFORM_FREE_ACADEMY_ACTIVE_FREE_REQUIRED' USING ERRCODE='23514';END IF;
 why=p_input->>'reason';data=jsonb_build_object('academyId',school,'subscriptionVersion',v,'permanent',true,'paidAssignmentBlocked',true);response=jsonb_build_object('status',200,'body',jsonb_build_object('data',data,'chargesPerformed',false,'operationalStatusChanged',false));
 INSERT INTO platform_private.audit_events(id,actor_user_id,session_id,request_key,action,academy_id,after_data,reason) VALUES(audit_id,p_user,p_session,p_key,'platform.subscription.free-exemption.bound',school,data,why);
 INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,response);
 INSERT INTO platform_private.primary_free_academy(academy_id,subscription_version,actor_user_id,session_id,request_key,audit_id) VALUES(school,v,p_user,p_session,p_key,audit_id) RETURNING academy_id INTO inserted;
 IF inserted IS DISTINCT FROM school THEN RAISE EXCEPTION 'PLATFORM_FREE_ACADEMY_EFFECTS_MISSING' USING ERRCODE='23514';END IF;RETURN response;
END $$;
DO $$ DECLARE d text;marker text:=' PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 d=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(d)-length(replace(d,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'PLATFORM_GATEWAY_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,marker,marker||E'\n IF p_operation IN(''subscriptions.free-exemption.get'',''subscriptions.free-exemption.bind'') THEN RETURN platform_private.free_academy_request(p_user,p_session,p_operation,p_key,p_input);END IF;');
END $$;
DO $$ DECLARE d text;needle text;BEGIN
 d=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);needle='subscription_version AS "subscriptionVersion",';
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'PLATFORM_FREE_DIRECTORY_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,needle,needle||'coalesce(id=(SELECT academy_id FROM platform_private.primary_free_academy WHERE singleton),false) AS "permanentFree",');
 d=pg_get_functiondef('platform_private.subscription_request(uuid,uuid,text,uuid,jsonb)'::regprocedure);needle='''subscriptionState'',public.subscription_access_state(subscription_terms)) INTO data';
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'PLATFORM_FREE_SUBSCRIPTION_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,needle,'''subscriptionState'',public.subscription_access_state(subscription_terms),''permanentFree'',EXISTS(SELECT 1 FROM platform_private.primary_free_academy f WHERE f.academy_id=public.academies.id)) INTO data');
END $$;
REVOKE ALL ON FUNCTION platform_private.free_academy_request(uuid,uuid,text,uuid,jsonb),platform_private.protect_primary_free_academy(),platform_private.verify_primary_free_academy() FROM PUBLIC;
GRANT SELECT,INSERT ON platform_private.primary_free_academy TO kavosh_platform_policy;
GRANT EXECUTE ON FUNCTION platform_private.free_academy_request(uuid,uuid,text,uuid,jsonb) TO kavosh_platform_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
ALTER FUNCTION platform_private.protect_primary_free_academy() OWNER TO kavosh_platform_policy;
ALTER FUNCTION platform_private.verify_primary_free_academy() OWNER TO kavosh_platform_policy;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 311 $$;

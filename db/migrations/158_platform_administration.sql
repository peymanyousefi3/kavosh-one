-- Separate,operator-enrolled platform authority;never an academy role grant.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_platform_service') THEN CREATE ROLE kavosh_platform_service NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_platform_policy') THEN CREATE ROLE kavosh_platform_policy NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
END $$;
CREATE SCHEMA platform_private;REVOKE ALL ON SCHEMA platform_private FROM PUBLIC;
CREATE TABLE platform_private.owner_registration(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),user_id uuid NOT NULL UNIQUE REFERENCES identity."user"(id),registered_by text NOT NULL DEFAULT current_user,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),registered_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE platform_private.audit_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_user_id uuid NOT NULL REFERENCES identity."user"(id),session_id uuid,request_key uuid,action text NOT NULL,academy_id uuid,before_data jsonb,after_data jsonb,reason text,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX platform_audit_school ON platform_private.audit_events(academy_id,id);
CREATE TABLE platform_private.request_receipts(user_id uuid NOT NULL REFERENCES identity."user"(id),request_key uuid NOT NULL,fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'),result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(user_id,request_key));
CREATE TABLE platform_private.rate_windows(user_id uuid PRIMARY KEY REFERENCES identity."user"(id),started_at timestamptz NOT NULL,requests integer NOT NULL CHECK(requests>0));
CREATE FUNCTION platform_private.immutable_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'PLATFORM_HISTORY_IMMUTABLE' USING ERRCODE='23514';END $$;
CREATE TRIGGER platform_owner_immutable BEFORE UPDATE OR DELETE ON platform_private.owner_registration FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER platform_audit_immutable BEFORE UPDATE OR DELETE ON platform_private.audit_events FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER platform_receipt_immutable BEFORE UPDATE OR DELETE ON platform_private.request_receipts FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
ALTER TABLE public.academies ADD COLUMN platform_version integer NOT NULL DEFAULT 1 CHECK(platform_version>0);
CREATE FUNCTION public.guard_academy_platform_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.platform_version<>OLD.platform_version THEN RAISE EXCEPTION 'PLATFORM_VERSION_SERVER_OWNED' USING ERRCODE='23514';END IF;
 IF ROW(NEW.name,NEW.status) IS DISTINCT FROM ROW(OLD.name,OLD.status) THEN NEW.platform_version=OLD.platform_version+1;END IF;RETURN NEW;
END $$;
CREATE TRIGGER academy_platform_version BEFORE UPDATE ON public.academies FOR EACH ROW EXECUTE FUNCTION public.guard_academy_platform_version();
CREATE FUNCTION platform_private.register_owner(p_user uuid,p_reason text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE actual uuid;BEGIN
 IF length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 OR NOT EXISTS(SELECT 1 FROM identity."user" u WHERE u.id=p_user AND u."emailVerified" AND u."phoneNumberVerified" AND length(u."phoneNumber")>0 AND u."mfaRequired" AND u."twoFactorEnabled") THEN RAISE EXCEPTION 'VERIFIED_MFA_OWNER_REQUIRED' USING ERRCODE='23514';END IF;
 INSERT INTO platform_private.owner_registration(user_id,reason) VALUES(p_user,p_reason) ON CONFLICT(singleton) DO NOTHING;
 SELECT user_id INTO actual FROM platform_private.owner_registration WHERE singleton FOR SHARE;
 IF actual IS DISTINCT FROM p_user THEN RAISE EXCEPTION 'PLATFORM_OWNER_ALREADY_REGISTERED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM platform_private.audit_events WHERE action='platform.owner.registered') THEN INSERT INTO platform_private.audit_events(actor_user_id,action,after_data,reason) VALUES(p_user,'platform.owner.registered',jsonb_build_object('registeredBy',current_user),p_reason);END IF;
END $$;
CREATE FUNCTION platform_private.authorize_owner(p_user uuid,p_session uuid,p_lock boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF p_lock THEN
  PERFORM 1 FROM platform_private.owner_registration o JOIN identity."user" u ON u.id=o.user_id JOIN identity.session s ON s."userId"=u.id WHERE u.id=p_user AND s.id=p_session AND s."expiresAt">clock_timestamp() AND u."emailVerified" AND u."phoneNumberVerified" AND length(u."phoneNumber")>0 AND u."mfaRequired" AND u."twoFactorEnabled" AND s."mfaVerified" FOR SHARE OF o,u,s;
 ELSE
  PERFORM 1 FROM platform_private.owner_registration o JOIN identity."user" u ON u.id=o.user_id JOIN identity.session s ON s."userId"=u.id WHERE u.id=p_user AND s.id=p_session AND s."expiresAt">clock_timestamp() AND u."emailVerified" AND u."phoneNumberVerified" AND length(u."phoneNumber")>0 AND u."mfaRequired" AND u."twoFactorEnabled" AND s."mfaVerified";
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_OWNER_REQUIRED' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION platform_private.consume_request_budget(p_user uuid,p_session uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE used integer;w timestamptz:=date_trunc('minute',clock_timestamp());BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 INSERT INTO platform_private.rate_windows AS r VALUES(p_user,w,1) ON CONFLICT(user_id) DO UPDATE SET started_at=w,requests=CASE WHEN r.started_at=w THEN r.requests+1 ELSE 1 END RETURNING requests INTO used;RETURN used<=60;
END $$;
CREATE FUNCTION platform_private.request(p_user uuid,p_session uuid,p_operation text,p_key uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE school uuid;master_id uuid;before_value jsonb;after_value jsonb;data jsonb;response jsonb;old_receipt record;fingerprint text;page_limit integer;after_id uuid;next_id uuid;result_status integer:=200;target_status text;new_name text;why text;action_name text;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384 OR p_operation NOT IN('academies.list','academies.get','academies.provision','academies.change','audit.list') THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 IF p_operation IN('academies.get','academies.change') THEN
  IF jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;school=(p_input->>'academyId')::uuid;
  -- Same policy/topology order as existing academy writers,before owner locks.
  IF p_operation='academies.change' THEN PERFORM pg_advisory_xact_lock(hashtextextended(school::text,8));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,9));END IF;
 END IF;
 PERFORM platform_private.authorize_owner(p_user,p_session,true);
 IF p_operation IN('academies.provision','academies.change') THEN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  fingerprint=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));
  SELECT * INTO old_receipt FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
  IF FOUND THEN IF old_receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN old_receipt.result;END IF;
  why=p_input->>'reason';IF jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR length(btrim(why)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 END IF;
 IF p_operation IN('academies.list','audit.list') THEN
  IF p_input-ARRAY['limit','after']<>'{}'::jsonb OR(p_input?'limit' AND(jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^[1-9][0-9]{0,2}$')) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  page_limit=coalesce((p_input->>'limit')::integer,50);IF page_limit>100 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  IF p_input?'after' THEN IF jsonb_typeof(p_input->'after') IS DISTINCT FROM 'string' OR p_input->>'after'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;after_id=(p_input->>'after')::uuid;END IF;
  IF p_operation='academies.list' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) INTO data FROM(SELECT id,name,status,platform_version AS version,created_at FROM public.academies WHERE after_id IS NULL OR id>after_id ORDER BY id LIMIT page_limit+1) a;
  ELSE
   SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) INTO data FROM(SELECT id,actor_user_id,request_key,action,academy_id,before_data,after_data,reason,created_at FROM platform_private.audit_events WHERE after_id IS NULL OR id>after_id ORDER BY id LIMIT page_limit+1) a;
  END IF;
  IF jsonb_array_length(data)>page_limit THEN next_id=(data->(page_limit-1)->>'id')::uuid;data=data-(page_limit);END IF;
  response=jsonb_build_object('data',data,'nextCursor',next_id,'scope','platform_owner','businessDataIncluded',false);after_value=jsonb_build_object('rows',jsonb_array_length(data),'hasMore',next_id IS NOT NULL);action_name='platform.'||p_operation;
 ELSIF p_operation='academies.get' THEN
  IF p_input-ARRAY['academyId']<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  SELECT jsonb_build_object('id',a.id,'name',a.name,'status',a.status,'version',a.platform_version,'createdAt',a.created_at,'master',jsonb_build_object('personId',p.id,'name',p.name,'email',p.email,'status',p.status,'identityBound',p.auth_user_id IS NOT NULL)) INTO data FROM public.academies a JOIN public.people p ON p.academy_id=a.id AND p.id=a.master_person_id WHERE a.id=school;
  IF data IS NULL THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;response=jsonb_build_object('data',data);after_value=jsonb_build_object('academyId',school);action_name='platform.academies.get';
 ELSIF p_operation='academies.provision' THEN
  IF p_input-ARRAY['name','masterName','masterEmail','reason']<>'{}'::jsonb OR NOT(p_input?&ARRAY['name','masterName','masterEmail','reason']) OR jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(p_input->'masterName') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'masterName')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(p_input->'masterEmail') IS DISTINCT FROM 'string' OR length(p_input->>'masterEmail')>254 OR p_input->>'masterEmail'!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  school=gen_random_uuid();master_id=gen_random_uuid();PERFORM set_config('app.academy_id',school::text,true);
  INSERT INTO public.academies(id,name,master_person_id) VALUES(school,btrim(p_input->>'name'),master_id);
  INSERT INTO public.people(academy_id,id,kind,name,email,status) VALUES(school,master_id,'human',btrim(p_input->>'masterName'),lower(btrim(p_input->>'masterEmail')),'pending');
  data=jsonb_build_object('id',school,'name',btrim(p_input->>'name'),'status','provisioning','version',1,'masterPersonId',master_id,'masterInvitationRequired',true,'masterVerified',false,'externalDeliveryPerformed',false);response=jsonb_build_object('data',data);after_value=data;action_name='platform.academies.provisioned';result_status=201;
 ELSE
  IF p_input-ARRAY['academyId','expectedVersion','name','status','reason']<>'{}'::jsonb OR NOT(p_input?&ARRAY['academyId','expectedVersion','reason']) OR NOT(p_input?|ARRAY['name','status']) OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion'!~'^[1-9][0-9]{0,9}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  SELECT jsonb_build_object('id',id,'name',name,'status',status,'version',platform_version,'masterPersonId',master_person_id) INTO before_value FROM public.academies WHERE id=school FOR UPDATE;
  IF before_value IS NULL THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
  IF(p_input->>'expectedVersion')::numeric<>(before_value->>'version')::integer THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_VERSION_CHANGED' USING ERRCODE='23514';END IF;
  new_name=coalesce(p_input->>'name',before_value->>'name');target_status=coalesce(p_input->>'status',before_value->>'status');
  IF(p_input?'name' AND jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string') OR length(btrim(new_name)) NOT BETWEEN 1 AND 200 OR(p_input?'status' AND jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string') OR target_status NOT IN('provisioning','active','read_only','suspended') THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  IF target_status IN('active','read_only') AND NOT EXISTS(SELECT 1 FROM public.people p JOIN identity."user" u ON u.id=p.auth_user_id WHERE p.academy_id=school AND p.id=(before_value->>'masterPersonId')::uuid AND p.kind='human' AND p.status='active' AND u."emailVerified" AND u."phoneNumberVerified" AND u."mfaRequired" AND u."twoFactorEnabled") THEN RAISE EXCEPTION 'PLATFORM_MASTER_VERIFICATION_REQUIRED' USING ERRCODE='23514';END IF;
  IF target_status='provisioning' AND before_value->>'status'<>'provisioning' AND EXISTS(SELECT 1 FROM public.people p WHERE p.academy_id=school AND p.id=(before_value->>'masterPersonId')::uuid AND(p.auth_user_id IS NOT NULL OR p.status<>'pending')) THEN RAISE EXCEPTION 'PLATFORM_PROVISIONING_REENTRY_FORBIDDEN' USING ERRCODE='23514';END IF;
  UPDATE public.academies SET name=btrim(new_name),status=target_status WHERE id=school RETURNING jsonb_build_object('id',id,'name',name,'status',status,'version',platform_version,'masterPersonId',master_person_id) INTO after_value;
  response=jsonb_build_object('data',after_value);action_name='platform.academies.changed';
 END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,request_key,action,academy_id,before_data,after_data,reason) VALUES(p_user,p_session,p_key,action_name,school,before_value,after_value,why);
 response=jsonb_build_object('status',result_status,'body',response);
 IF p_operation IN('academies.provision','academies.change') THEN INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,response);END IF;
 RETURN response;
END $$;
GRANT kavosh_platform_policy TO CURRENT_USER;
GRANT USAGE,CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
GRANT USAGE ON SCHEMA public,identity TO kavosh_platform_policy;
GRANT SELECT ON platform_private.owner_registration,platform_private.audit_events,platform_private.request_receipts,platform_private.rate_windows,identity."user",identity.session,public.academies,public.people TO kavosh_platform_policy;
GRANT UPDATE(user_id) ON platform_private.owner_registration TO kavosh_platform_policy;
GRANT UPDATE(id) ON identity."user",identity.session TO kavosh_platform_policy;
GRANT INSERT ON platform_private.audit_events,platform_private.request_receipts,platform_private.rate_windows,public.academies,public.people TO kavosh_platform_policy;
GRANT UPDATE ON platform_private.rate_windows TO kavosh_platform_policy;
GRANT UPDATE(name,status) ON public.academies TO kavosh_platform_policy;
CREATE POLICY platform_policy_executor ON public.academies TO kavosh_platform_policy USING(true) WITH CHECK(true);
CREATE POLICY platform_policy_executor ON public.people TO kavosh_platform_policy USING(true) WITH CHECK(true);
ALTER FUNCTION platform_private.consume_request_budget(uuid,uuid) OWNER TO kavosh_platform_policy;
ALTER FUNCTION platform_private.request(uuid,uuid,text,uuid,jsonb) OWNER TO kavosh_platform_policy;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA platform_private FROM PUBLIC;
GRANT USAGE ON SCHEMA platform_private TO kavosh_platform_service;
GRANT EXECUTE ON FUNCTION platform_private.consume_request_budget(uuid,uuid),platform_private.request(uuid,uuid,text,uuid,jsonb) TO kavosh_platform_service;
GRANT EXECUTE ON FUNCTION platform_private.authorize_owner(uuid,uuid,boolean) TO kavosh_platform_policy;
REVOKE ALL ON FUNCTION public.guard_academy_platform_version() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 158 $$;
GRANT EXECUTE ON FUNCTION public.schema_revision() TO kavosh_platform_service;

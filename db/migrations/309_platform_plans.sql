-- Platform reference prices are not tuition, tax decisions, invoices or charges.
-- Editions are immutable so later school subscriptions can pin their agreed terms.
CREATE FUNCTION platform_private.valid_plan_definition(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(jsonb_typeof(v)='object' AND v-ARRAY['name','description','currencyCode','unitScale','amountMinor','periodMonths','graceDays','active']='{}'::jsonb
 AND v?&ARRAY['name','description','currencyCode','unitScale','amountMinor','periodMonths','graceDays','active']
 AND jsonb_typeof(v->'name')='string' AND length(btrim(v->>'name')) BETWEEN 1 AND 200 AND v->>'name'=btrim(v->>'name')
 AND jsonb_typeof(v->'description')='string' AND length(v->>'description')<=2000
 AND jsonb_typeof(v->'currencyCode')='string' AND v->>'currencyCode'~'^[A-Z]{3}$'
 AND jsonb_typeof(v->'unitScale')='number' AND v->>'unitScale'~'^([0-9]|1[0-8])$'
 AND jsonb_typeof(v->'amountMinor')='string' AND v->>'amountMinor'~'^(0|[1-9][0-9]{0,37})$'
 AND jsonb_typeof(v->'periodMonths')='number' AND v->>'periodMonths'~'^([1-9]|[12][0-9]|3[0-6])$'
 AND jsonb_typeof(v->'graceDays')='number' AND v->>'graceDays'~'^(0|[1-9][0-9]?|[12][0-9]{2}|3[0-5][0-9]|36[0-5])$'
 AND jsonb_typeof(v->'active')='boolean',false)
$$;
CREATE TABLE platform_private.subscription_plans(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL CHECK(platform_private.valid_plan_definition(definition)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE platform_private.subscription_plan_editions(
 plan_id uuid NOT NULL REFERENCES platform_private.subscription_plans(id),version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL CHECK(platform_private.valid_plan_definition(definition)),
 actor_user_id uuid NOT NULL REFERENCES identity."user"(id),session_id uuid NOT NULL,request_key uuid NOT NULL,
 audit_id uuid NOT NULL UNIQUE REFERENCES platform_private.audit_events(id),
 source_plan_id uuid,source_version integer,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(plan_id,version),
 FOREIGN KEY(actor_user_id,request_key) REFERENCES platform_private.request_receipts(user_id,request_key) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(source_plan_id,source_version) REFERENCES platform_private.subscription_plan_editions(plan_id,version),
 CHECK((source_plan_id IS NULL)=(source_version IS NULL))
);
CREATE TRIGGER plan_edition_immutable BEFORE UPDATE OR DELETE ON platform_private.subscription_plan_editions FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE FUNCTION platform_private.guard_plan_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PLATFORM_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN IF NEW.version<>1 THEN RAISE EXCEPTION 'PLATFORM_PLAN_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 ELSE IF NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1 OR NEW.definition=OLD.definition THEN RAISE EXCEPTION 'PLATFORM_PLAN_VERSION_CHANGED' USING ERRCODE='23514';END IF;END IF;
 NEW.updated_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER plan_head_guard BEFORE INSERT OR UPDATE OR DELETE ON platform_private.subscription_plans FOR EACH ROW EXECUTE FUNCTION platform_private.guard_plan_head();
CREATE FUNCTION platform_private.verify_plan_effects() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE e record;a record;r record;BEGIN
 SELECT * INTO e FROM platform_private.subscription_plan_editions WHERE plan_id=NEW.id AND version=NEW.version;
 IF NOT FOUND OR e.definition IS DISTINCT FROM NEW.definition THEN RAISE EXCEPTION 'PLATFORM_PLAN_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
 SELECT * INTO a FROM platform_private.audit_events WHERE id=e.audit_id;
 SELECT * INTO r FROM platform_private.request_receipts WHERE user_id=e.actor_user_id AND request_key=e.request_key;
 IF a.actor_user_id IS DISTINCT FROM e.actor_user_id OR a.session_id IS DISTINCT FROM e.session_id OR a.request_key IS DISTINCT FROM e.request_key
 OR a.action IS DISTINCT FROM (CASE WHEN e.source_plan_id IS NOT NULL THEN 'platform.plans.duplicated' WHEN e.version=1 THEN 'platform.plans.created' ELSE 'platform.plans.changed' END)
 OR a.after_data IS DISTINCT FROM jsonb_build_object('id',NEW.id,'version',NEW.version,'definition',NEW.definition,'sourcePlanId',e.source_plan_id,'sourceVersion',e.source_version)
 OR r.result->'body'->'data' IS DISTINCT FROM a.after_data THEN RAISE EXCEPTION 'PLATFORM_PLAN_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER plan_effects_complete AFTER INSERT OR UPDATE ON platform_private.subscription_plans DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.verify_plan_effects();
CREATE FUNCTION platform_private.plan_request(p_user uuid,p_session uuid,p_operation text,p_key uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE plan uuid;source uuid;v integer;source_v integer;terms jsonb;before_value jsonb;after_value jsonb;data jsonb;response jsonb;receipt record;fingerprint text;why text;audit_id uuid:=gen_random_uuid();action_name text;lim integer;cursor uuid;next_id uuid;status integer:=200;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session,true);
 IF p_operation IS NULL OR p_operation NOT IN('plans.list','plans.get','plans.history','plans.create','plans.change','plans.duplicate') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 IF p_operation IN('plans.create','plans.change','plans.duplicate') THEN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  fingerprint=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));
  SELECT * INTO receipt FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
  IF FOUND THEN IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN receipt.result;END IF;
  why=p_input->>'reason';IF jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR length(btrim(why)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 END IF;
 IF p_operation<>'plans.create' AND p_operation<>'plans.list' THEN
  IF jsonb_typeof(p_input->'planId') IS DISTINCT FROM 'string' OR p_input->>'planId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;plan=(p_input->>'planId')::uuid;
 END IF;
 IF p_operation='plans.list' THEN
  IF p_input-ARRAY['limit','after']<>'{}'::jsonb OR(p_input?'limit' AND(jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^([1-9][0-9]?|100)$')) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  lim=coalesce((p_input->>'limit')::integer,50);
  IF p_input?'after' THEN IF jsonb_typeof(p_input->'after') IS DISTINCT FROM 'string' OR p_input->>'after'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;cursor=(p_input->>'after')::uuid;END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) INTO data FROM(SELECT id,version,definition,created_at,updated_at FROM platform_private.subscription_plans WHERE cursor IS NULL OR id>cursor ORDER BY id LIMIT lim+1)p;
  IF jsonb_array_length(data)>lim THEN next_id=(data->(lim-1)->>'id')::uuid;data=data-lim;END IF;
  response=jsonb_build_object('data',data,'nextCursor',next_id);after_value=jsonb_build_object('rows',jsonb_array_length(data));action_name='platform.plans.list';
 ELSIF p_operation IN('plans.get','plans.history') THEN
  IF p_input-(CASE WHEN p_operation='plans.get' THEN ARRAY['planId'] ELSE ARRAY['planId','beforeVersion','limit'] END)<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  SELECT jsonb_build_object('id',id,'version',version,'definition',definition) INTO data FROM platform_private.subscription_plans WHERE id=plan;
  IF data IS NULL THEN RAISE EXCEPTION 'PLATFORM_PLAN_NOT_FOUND' USING ERRCODE='P0002';END IF;
  IF p_operation='plans.history' THEN
   IF(p_input?'limit' AND(jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^([1-9][0-9]?|100)$')) OR(p_input?'beforeVersion' AND(jsonb_typeof(p_input->'beforeVersion') IS DISTINCT FROM 'number' OR p_input->>'beforeVersion'!~'^[1-9][0-9]{0,9}$' OR(p_input->>'beforeVersion')::numeric>2147483647)) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
   lim=coalesce((p_input->>'limit')::integer,50);v=(p_input->>'beforeVersion')::integer;
   SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY version DESC),'[]'::jsonb) INTO data FROM(SELECT plan_id,version,definition,source_plan_id,source_version,actor_user_id,created_at FROM platform_private.subscription_plan_editions WHERE plan_id=plan AND(v IS NULL OR version<v) ORDER BY version DESC LIMIT lim+1)e;
   IF jsonb_array_length(data)>lim THEN source_v=(data->(lim-1)->>'version')::integer;data=data-lim;END IF;
   response=jsonb_build_object('data',data,'nextBeforeVersion',source_v);
  ELSE response=jsonb_build_object('data',data);END IF;
  after_value=jsonb_build_object('planId',plan);action_name='platform.'||p_operation;
 ELSE
  IF p_operation='plans.create' THEN
   IF p_input-ARRAY['definition','reason']<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;plan=gen_random_uuid();v=1;terms=p_input->'definition';status=201;action_name='platform.plans.created';
  ELSE
   IF p_input-(CASE WHEN p_operation='plans.change' THEN ARRAY['planId','expectedVersion','definition','reason'] ELSE ARRAY['planId','expectedVersion','name','reason'] END)<>'{}'::jsonb OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion'!~'^[1-9][0-9]{0,9}$' OR(p_input->>'expectedVersion')::numeric>2147483647 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
   SELECT version,p.definition INTO v,terms FROM platform_private.subscription_plans p WHERE id=plan FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_PLAN_NOT_FOUND' USING ERRCODE='P0002';END IF;
   IF v<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'PLATFORM_PLAN_VERSION_CHANGED' USING ERRCODE='23514';END IF;
   before_value=jsonb_build_object('id',plan,'version',v,'definition',terms);
   IF p_operation='plans.duplicate' THEN
    source=plan;source_v=v;plan=gen_random_uuid();v=1;status=201;action_name='platform.plans.duplicated';
    IF jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
    terms=jsonb_set(terms,'{name}',to_jsonb(btrim(p_input->>'name')));
   ELSE v=v+1;terms=p_input->'definition';action_name='platform.plans.changed';END IF;
  END IF;
  IF NOT platform_private.valid_plan_definition(terms) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  after_value=jsonb_build_object('id',plan,'version',v,'definition',terms,'sourcePlanId',source,'sourceVersion',source_v);
  response=jsonb_build_object('status',status,'body',jsonb_build_object('data',after_value,'chargesPerformed',false,'schoolAccessChanged',false));
  INSERT INTO platform_private.audit_events(id,actor_user_id,session_id,request_key,action,before_data,after_data,reason) VALUES(audit_id,p_user,p_session,p_key,action_name,before_value,after_value,why);
  INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,response);
  IF v=1 THEN INSERT INTO platform_private.subscription_plans(id,version,definition) VALUES(plan,v,terms);
  ELSE UPDATE platform_private.subscription_plans SET version=v,definition=terms WHERE id=plan;END IF;
  INSERT INTO platform_private.subscription_plan_editions(plan_id,version,definition,actor_user_id,session_id,request_key,audit_id,source_plan_id,source_version) VALUES(plan,v,terms,p_user,p_session,p_key,audit_id,source,source_v);
  RETURN response;
 END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,after_data) VALUES(p_user,p_session,action_name,after_value);
 RETURN jsonb_build_object('status',200,'body',response);
END $$;
-- Keep the existing sole definer gateway and its identity/ACL; extend its closed dispatch.
DO $$ DECLARE d text;marker text:=' PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 d=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF (length(d)-length(replace(d,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'PLATFORM_GATEWAY_SHAPE_CHANGED';END IF;
 d=replace(d,marker,marker||E'\n IF p_operation IN(''plans.list'',''plans.get'',''plans.history'',''plans.create'',''plans.change'',''plans.duplicate'') THEN RETURN platform_private.plan_request(p_user,p_session,p_operation,p_key,p_input);END IF;');EXECUTE d;
END $$;
REVOKE ALL ON FUNCTION platform_private.valid_plan_definition(jsonb),platform_private.guard_plan_head(),platform_private.verify_plan_effects(),platform_private.plan_request(uuid,uuid,text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_private.valid_plan_definition(jsonb),platform_private.plan_request(uuid,uuid,text,uuid,jsonb) TO kavosh_platform_policy;
GRANT SELECT,INSERT ON platform_private.subscription_plans,platform_private.subscription_plan_editions TO kavosh_platform_policy;
GRANT UPDATE(version,definition,updated_at) ON platform_private.subscription_plans TO kavosh_platform_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
ALTER FUNCTION platform_private.verify_plan_effects() OWNER TO kavosh_platform_policy;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 309 $$;

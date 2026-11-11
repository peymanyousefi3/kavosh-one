-- Owner-reviewed preservation is independent of cancellation or subscription
-- access. Holds never expire silently;release is a separate immutable act.
CREATE TABLE platform_private.academy_legal_holds(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),academy_id uuid NOT NULL REFERENCES public.academies(id),
 case_reference text NOT NULL CHECK(length(btrim(case_reference)) BETWEEN 1 AND 200 AND case_reference!~'[[:cntrl:]]'),
 basis text NOT NULL CHECK(length(btrim(basis)) BETWEEN 1 AND 2000 AND basis!~'[[:cntrl:]]'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),actor_user_id uuid NOT NULL REFERENCES identity."user"(id),session_id uuid NOT NULL,request_key uuid NOT NULL,audit_id uuid NOT NULL UNIQUE,
 UNIQUE(academy_id,id),FOREIGN KEY(audit_id) REFERENCES platform_private.audit_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(actor_user_id,request_key) REFERENCES platform_private.request_receipts(user_id,request_key) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX academy_hold_directory ON platform_private.academy_legal_holds(academy_id,id);
CREATE TABLE platform_private.academy_legal_hold_releases(
 hold_id uuid PRIMARY KEY,academy_id uuid NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_user_id uuid NOT NULL REFERENCES identity."user"(id),session_id uuid NOT NULL,request_key uuid NOT NULL,audit_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(academy_id,hold_id) REFERENCES platform_private.academy_legal_holds(academy_id,id),
 FOREIGN KEY(audit_id) REFERENCES platform_private.audit_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(actor_user_id,request_key) REFERENCES platform_private.request_receipts(user_id,request_key) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER legal_hold_immutable BEFORE UPDATE OR DELETE ON platform_private.academy_legal_holds FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE TRIGGER legal_hold_release_immutable BEFORE UPDATE OR DELETE ON platform_private.academy_legal_hold_releases FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE VIEW platform_private.academy_legal_hold_cases AS
 SELECT h.id,h.academy_id,jsonb_build_object('id',h.id,'academyId',h.academy_id,'scope','entire_academy','caseReference',h.case_reference,'basis',h.basis,'recordedAt',h.recorded_at,'version',1,'status','active','releasedAt',NULL) original_data,
 jsonb_build_object('id',h.id,'academyId',h.academy_id,'scope','entire_academy','caseReference',h.case_reference,'basis',h.basis,'recordedAt',h.recorded_at,'version',CASE WHEN r.hold_id IS NULL THEN 1 ELSE 2 END,'status',CASE WHEN r.hold_id IS NULL THEN 'active' ELSE 'released' END,'releasedAt',r.recorded_at) current_data
 FROM platform_private.academy_legal_holds h LEFT JOIN platform_private.academy_legal_hold_releases r ON r.hold_id=h.id;
CREATE FUNCTION platform_private.guard_legal_hold_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM platform_private.authorize_owner(NEW.actor_user_id,NEW.session_id);PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,374));NEW.recorded_at=clock_timestamp();
 IF TG_TABLE_NAME='academy_legal_holds' THEN IF EXISTS(SELECT 1 FROM platform_private.academy_legal_hold_cases WHERE academy_id=NEW.academy_id AND current_data->>'status'='active' AND current_data->>'caseReference'=NEW.case_reference) THEN RAISE EXCEPTION 'PLATFORM_HOLD_ALREADY_ACTIVE' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legal_hold_entry BEFORE INSERT ON platform_private.academy_legal_holds FOR EACH ROW EXECUTE FUNCTION platform_private.guard_legal_hold_entry();
CREATE TRIGGER legal_hold_release_entry BEFORE INSERT ON platform_private.academy_legal_hold_releases FOR EACH ROW EXECUTE FUNCTION platform_private.guard_legal_hold_entry();
CREATE FUNCTION platform_private.verify_legal_hold_effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE data jsonb;previous_data jsonb;expected_input jsonb;a record;r record;action_name text;operation text;expected_status integer;
BEGIN
 PERFORM platform_private.authorize_owner(NEW.actor_user_id,NEW.session_id);
 IF TG_TABLE_NAME='academy_legal_holds' THEN SELECT original_data INTO data FROM platform_private.academy_legal_hold_cases WHERE id=NEW.id;action_name='platform.retention.hold.created';
 ELSE SELECT current_data INTO data FROM platform_private.academy_legal_hold_cases WHERE id=NEW.hold_id;action_name='platform.retention.hold.released';END IF;
 SELECT * INTO a FROM platform_private.audit_events WHERE id=NEW.audit_id;SELECT * INTO r FROM platform_private.request_receipts WHERE user_id=NEW.actor_user_id AND request_key=NEW.request_key;
 IF TG_TABLE_NAME='academy_legal_holds' THEN operation='holds.create';expected_status=201;expected_input=jsonb_build_object('academyId',NEW.academy_id,'caseReference',NEW.case_reference,'reason',NEW.basis);IF a.reason IS DISTINCT FROM NEW.basis THEN RAISE EXCEPTION 'PLATFORM_HOLD_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
 ELSE operation='holds.release';expected_status=200;SELECT original_data INTO previous_data FROM platform_private.academy_legal_hold_cases WHERE id=NEW.hold_id;expected_input=jsonb_build_object('academyId',NEW.academy_id,'holdId',NEW.hold_id,'confirmAcademyId',NEW.academy_id,'expectedVersion',1,'reason',a.reason);END IF;
 IF data IS NULL OR a.actor_user_id IS DISTINCT FROM NEW.actor_user_id OR a.session_id IS DISTINCT FROM NEW.session_id OR a.request_key IS DISTINCT FROM NEW.request_key OR a.academy_id IS DISTINCT FROM NEW.academy_id OR a.action IS DISTINCT FROM action_name OR a.before_data IS DISTINCT FROM previous_data OR a.after_data IS DISTINCT FROM data OR r.result IS DISTINCT FROM jsonb_build_object('status',expected_status,'body',jsonb_build_object('data',data,'deletionPerformed',false,'deletionAuthorized',false,'externalStorageHoldVerified',false)) OR r.fingerprint IS DISTINCT FROM encode(sha256(convert_to(jsonb_build_object('operation',operation,'input',expected_input)::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'PLATFORM_HOLD_EFFECTS_MISSING' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER legal_hold_complete AFTER INSERT ON platform_private.academy_legal_holds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.verify_legal_hold_effect();
CREATE CONSTRAINT TRIGGER legal_hold_release_complete AFTER INSERT ON platform_private.academy_legal_hold_releases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.verify_legal_hold_effect();
CREATE FUNCTION platform_private.legal_hold_request(p_user uuid,p_session uuid,p_operation text,p_key uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE school uuid;target uuid;why text;data jsonb;before_value jsonb;response jsonb;receipt record;fingerprint text;audit_id uuid:=gen_random_uuid();lim integer;cursor uuid;next_id uuid;action_name text;status integer:=200;inserted uuid;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF p_operation IS NULL OR p_operation NOT IN('holds.list','holds.get','holds.create','holds.release','retention.get') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;school=(p_input->>'academyId')::uuid;
 IF p_operation IN('holds.create','holds.release') THEN PERFORM pg_advisory_xact_lock(hashtextextended(school::text,374));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,8));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,9));END IF;
 PERFORM platform_private.authorize_owner(p_user,p_session,true);
 IF p_operation IN('holds.create','holds.release') THEN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  fingerprint=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));SELECT * INTO receipt FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
  IF FOUND THEN IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN receipt.result;END IF;
  why=p_input->>'reason';IF jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR length(btrim(why)) NOT BETWEEN 1 AND 2000 OR why~'[[:cntrl:]]' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=school) THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF p_operation IN('holds.get','holds.release') THEN
  IF jsonb_typeof(p_input->'holdId') IS DISTINCT FROM 'string' OR p_input->>'holdId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;target=(p_input->>'holdId')::uuid;
 END IF;
 IF p_operation='holds.list' THEN
  IF p_input-ARRAY['academyId','limit','after']<>'{}'::jsonb OR(p_input?'limit' AND(jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^([1-9][0-9]?|100)$')) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;lim=coalesce((p_input->>'limit')::integer,50);
  IF p_input?'after' THEN IF jsonb_typeof(p_input->'after') IS DISTINCT FROM 'string' OR p_input->>'after'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;cursor=(p_input->>'after')::uuid;END IF;
  SELECT coalesce(jsonb_agg(current_data ORDER BY id),'[]'::jsonb) INTO data FROM(SELECT id,current_data FROM platform_private.academy_legal_hold_cases WHERE academy_id=school AND(cursor IS NULL OR id>cursor) ORDER BY id LIMIT lim+1)selected;
  IF jsonb_array_length(data)>lim THEN next_id=(data->(lim-1)->>'id')::uuid;data=data-lim;END IF;response=jsonb_build_object('data',data,'nextCursor',next_id);action_name='platform.retention.holds.read';
 ELSIF p_operation='retention.get' THEN
  IF p_input-ARRAY['academyId']<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  SELECT jsonb_build_object('academyId',school,'activeHoldCount',count(*),'preservationRequired',count(*)>0,'deletionAuthorized',false,'statutoryRetentionEvaluated',false,'externalStorageHoldVerified',false) INTO data FROM platform_private.academy_legal_holds h WHERE h.academy_id=school AND NOT EXISTS(SELECT 1 FROM platform_private.academy_legal_hold_releases r WHERE r.hold_id=h.id);response=jsonb_build_object('data',data);action_name='platform.retention.policy.read';
 ELSIF p_operation='holds.get' THEN
  IF p_input-ARRAY['academyId','holdId']<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  SELECT current_data INTO data FROM platform_private.academy_legal_hold_cases WHERE academy_id=school AND id=target;IF data IS NULL THEN RAISE EXCEPTION 'PLATFORM_HOLD_NOT_FOUND' USING ERRCODE='P0002';END IF;response=jsonb_build_object('data',data);action_name='platform.retention.hold.read';
 ELSE
  IF p_operation='holds.create' THEN
   IF p_input-ARRAY['academyId','caseReference','reason']<>'{}'::jsonb OR jsonb_typeof(p_input->'caseReference') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'caseReference')) NOT BETWEEN 1 AND 200 OR p_input->>'caseReference'~'[[:cntrl:]]' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
   IF EXISTS(SELECT 1 FROM platform_private.academy_legal_hold_cases WHERE academy_id=school AND current_data->>'status'='active' AND current_data->>'caseReference'=p_input->>'caseReference') THEN RAISE EXCEPTION 'PLATFORM_HOLD_ALREADY_ACTIVE' USING ERRCODE='23514';END IF;
   target=gen_random_uuid();status=201;action_name='platform.retention.hold.created';INSERT INTO platform_private.academy_legal_holds(id,academy_id,case_reference,basis,actor_user_id,session_id,request_key,audit_id) VALUES(target,school,p_input->>'caseReference',why,p_user,p_session,p_key,audit_id) RETURNING id INTO inserted;
   SELECT original_data INTO data FROM platform_private.academy_legal_hold_cases WHERE id=target;
  ELSE
   IF p_input-ARRAY['academyId','holdId','confirmAcademyId','expectedVersion','reason']<>'{}'::jsonb OR p_input->'expectedVersion' IS DISTINCT FROM '1'::jsonb OR p_input->>'confirmAcademyId' IS DISTINCT FROM school::text THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
   SELECT current_data INTO before_value FROM platform_private.academy_legal_hold_cases WHERE academy_id=school AND id=target;IF before_value IS NULL THEN RAISE EXCEPTION 'PLATFORM_HOLD_NOT_FOUND' USING ERRCODE='P0002';END IF;IF before_value->>'status'<>'active' THEN RAISE EXCEPTION 'PLATFORM_HOLD_ALREADY_RELEASED' USING ERRCODE='23514';END IF;
   action_name='platform.retention.hold.released';INSERT INTO platform_private.academy_legal_hold_releases(hold_id,academy_id,actor_user_id,session_id,request_key,audit_id) VALUES(target,school,p_user,p_session,p_key,audit_id) RETURNING hold_id INTO inserted;
   SELECT current_data INTO data FROM platform_private.academy_legal_hold_cases WHERE id=target;
  END IF;
  IF inserted IS DISTINCT FROM target THEN RAISE EXCEPTION 'PLATFORM_HOLD_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
  response=jsonb_build_object('status',status,'body',jsonb_build_object('data',data,'deletionPerformed',false,'deletionAuthorized',false,'externalStorageHoldVerified',false));
  INSERT INTO platform_private.audit_events(id,actor_user_id,session_id,request_key,action,academy_id,before_data,after_data,reason) VALUES(audit_id,p_user,p_session,p_key,action_name,school,before_value,data,why);
  INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,response);RETURN response;
 END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data) VALUES(p_user,p_session,action_name,school,jsonb_build_object('academyId',school));RETURN jsonb_build_object('status',200,'body',response);
END $$;
CREATE FUNCTION platform_private.prevent_held_record_deletion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE school uuid;BEGIN
 IF TG_TABLE_NAME='academies' THEN school=OLD.id;ELSE school=OLD.academy_id;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(school::text,374));
 IF EXISTS(SELECT 1 FROM platform_private.academy_legal_holds h WHERE h.academy_id=school AND NOT EXISTS(SELECT 1 FROM platform_private.academy_legal_hold_releases r WHERE r.hold_id=h.id)) THEN RAISE EXCEPTION 'ACADEMY_LEGAL_HOLD_ACTIVE' USING ERRCODE='23514';END IF;RETURN OLD;
END $$;
CREATE TRIGGER academy_legal_preservation BEFORE DELETE ON public.academies FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion();
CREATE TRIGGER file_legal_preservation BEFORE DELETE ON public.file_records FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion();
CREATE TRIGGER file_history_legal_preservation BEFORE DELETE ON public.file_record_revisions FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion();
DO $$ DECLARE body text;needle text:=' PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'LEGAL_HOLD_PLATFORM_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||E'\n IF p_operation IN(''holds.list'',''holds.get'',''holds.create'',''holds.release'',''retention.get'') THEN RETURN platform_private.legal_hold_request(p_user,p_session,p_operation,p_key,p_input);END IF;');
END $$;
REVOKE ALL ON FUNCTION platform_private.guard_legal_hold_entry(),platform_private.verify_legal_hold_effect(),platform_private.legal_hold_request(uuid,uuid,text,uuid,jsonb),platform_private.prevent_held_record_deletion() FROM PUBLIC;
GRANT SELECT,INSERT ON platform_private.academy_legal_holds,platform_private.academy_legal_hold_releases TO kavosh_platform_policy;
GRANT SELECT ON platform_private.academy_legal_hold_cases TO kavosh_platform_policy;
GRANT EXECUTE ON FUNCTION platform_private.legal_hold_request(uuid,uuid,text,uuid,jsonb) TO kavosh_platform_policy;
GRANT EXECUTE ON FUNCTION platform_private.guard_legal_hold_entry() TO kavosh_platform_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
ALTER FUNCTION platform_private.verify_legal_hold_effect() OWNER TO kavosh_platform_policy;
ALTER FUNCTION platform_private.prevent_held_record_deletion() OWNER TO kavosh_platform_policy;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 374 $$;

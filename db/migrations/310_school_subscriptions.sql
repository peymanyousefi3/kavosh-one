-- Operational licences only: no inferred payment,invoice,tax or bank transaction.
-- NULL preserves pre-subscription operation until the owner explicitly assigns terms.
ALTER TABLE public.academies ADD COLUMN subscription_version integer NOT NULL DEFAULT 0 CHECK(subscription_version>=0),ADD COLUMN subscription_terms jsonb;
CREATE FUNCTION public.subscription_access_state(p_terms jsonb) RETURNS text LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_terms IS NULL THEN 'unassigned'
 WHEN clock_timestamp()<(p_terms->>'startsAt')::timestamptz THEN 'scheduled'
 WHEN p_terms->>'expiresAt' IS NULL THEN 'free'
 WHEN clock_timestamp()<(p_terms->>'expiresAt')::timestamptz THEN 'active'
 WHEN clock_timestamp()<(p_terms->>'expiresAt')::timestamptz+(p_terms->>'graceDays')::integer*interval '24 hours' THEN 'grace'
 ELSE 'expired' END
$$;
CREATE FUNCTION public.effective_academy_status(p_status text,p_terms jsonb) RETURNS text LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_status='active' AND public.subscription_access_state(p_terms) IN('scheduled','grace','expired') THEN 'read_only' ELSE p_status END
$$;
CREATE TABLE platform_private.school_subscription_editions(
 academy_id uuid NOT NULL REFERENCES public.academies(id),version integer NOT NULL CHECK(version>0),
 plan_id uuid NOT NULL,plan_version integer NOT NULL,terms jsonb NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES identity."user"(id),session_id uuid NOT NULL,request_key uuid NOT NULL,
 audit_id uuid NOT NULL UNIQUE REFERENCES platform_private.audit_events(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,version),FOREIGN KEY(plan_id,plan_version) REFERENCES platform_private.subscription_plan_editions(plan_id,version),
 FOREIGN KEY(actor_user_id,request_key) REFERENCES platform_private.request_receipts(user_id,request_key) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER school_subscription_immutable BEFORE UPDATE OR DELETE ON platform_private.school_subscription_editions FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE FUNCTION platform_private.guard_school_subscription() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.subscription_version=OLD.subscription_version AND NEW.subscription_terms IS NOT DISTINCT FROM OLD.subscription_terms THEN RETURN NEW;END IF;
 IF NEW.subscription_version<>OLD.subscription_version+1 OR NEW.subscription_terms IS NULL OR NEW.subscription_terms IS NOT DISTINCT FROM OLD.subscription_terms THEN RAISE EXCEPTION 'PLATFORM_SUBSCRIPTION_VERSION_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER school_subscription_guard BEFORE UPDATE ON public.academies FOR EACH ROW EXECUTE FUNCTION platform_private.guard_school_subscription();
CREATE FUNCTION platform_private.verify_school_subscription() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE e record;p record;a record;r record;BEGIN
 IF NEW.subscription_version=0 AND NEW.subscription_terms IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO e FROM platform_private.school_subscription_editions WHERE academy_id=NEW.id AND version=NEW.subscription_version;
 IF NOT FOUND OR e.terms IS DISTINCT FROM NEW.subscription_terms THEN RAISE EXCEPTION 'PLATFORM_SUBSCRIPTION_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM platform_private.subscription_plan_editions WHERE plan_id=e.plan_id AND version=e.plan_version;
 SELECT * INTO a FROM platform_private.audit_events WHERE id=e.audit_id;
 SELECT * INTO r FROM platform_private.request_receipts WHERE user_id=e.actor_user_id AND request_key=e.request_key;
 IF e.terms->>'planId' IS DISTINCT FROM e.plan_id::text OR e.terms->>'planVersion' IS DISTINCT FROM e.plan_version::text
 OR e.terms->>'graceDays' IS DISTINCT FROM p.definition->>'graceDays' OR e.terms->>'free' IS DISTINCT FROM (p.definition->>'amountMinor'='0')::text
 OR a.actor_user_id IS DISTINCT FROM e.actor_user_id OR a.session_id IS DISTINCT FROM e.session_id OR a.request_key IS DISTINCT FROM e.request_key OR a.academy_id IS DISTINCT FROM NEW.id OR a.action IS DISTINCT FROM 'platform.subscription.assigned'
 OR a.after_data IS DISTINCT FROM jsonb_build_object('academyId',NEW.id,'version',NEW.subscription_version,'terms',NEW.subscription_terms)
 OR r.result->'body'->'data' IS DISTINCT FROM a.after_data THEN RAISE EXCEPTION 'PLATFORM_SUBSCRIPTION_EFFECTS_MISSING' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER school_subscription_complete AFTER INSERT OR UPDATE ON public.academies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.verify_school_subscription();
CREATE FUNCTION platform_private.subscription_request(p_user uuid,p_session uuid,p_operation text,p_key uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE school uuid;plan uuid;plan_v integer;v integer;prior jsonb;terms jsonb;edition jsonb;data jsonb;response jsonb;receipt record;fingerprint text;why text;audit_id uuid:=gen_random_uuid();starts timestamptz;ends timestamptz;lim integer;before_v integer;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF p_operation IS NULL OR p_operation NOT IN('subscriptions.get','subscriptions.history','subscriptions.assign') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384
 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 school=(p_input->>'academyId')::uuid;
 IF p_operation='subscriptions.assign' THEN PERFORM pg_advisory_xact_lock(hashtextextended(school::text,310));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,8));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,9));END IF;
 PERFORM platform_private.authorize_owner(p_user,p_session,true);
 IF p_operation='subscriptions.assign' THEN
  IF p_key IS NULL THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  fingerprint=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));
  SELECT * INTO receipt FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
  IF FOUND THEN IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN receipt.result;END IF;
  IF p_input-ARRAY['academyId','expectedVersion','planId','planVersion','startsAt','expiresAt','reason']<>'{}'::jsonb OR NOT(p_input?&ARRAY['expectedVersion','planId','planVersion','startsAt','expiresAt','reason'])
  OR jsonb_typeof(p_input->'expectedVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedVersion'!~'^(0|[1-9][0-9]{0,9})$' OR(p_input->>'expectedVersion')::numeric>2147483647
  OR jsonb_typeof(p_input->'planId') IS DISTINCT FROM 'string' OR p_input->>'planId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(p_input->'planVersion') IS DISTINCT FROM 'number' OR p_input->>'planVersion'!~'^[1-9][0-9]{0,9}$' OR(p_input->>'planVersion')::numeric>2147483647
  OR jsonb_typeof(p_input->'startsAt') IS DISTINCT FROM 'string' OR p_input->>'startsAt'!~'^[12][0-9]{3}-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
  OR (p_input->'expiresAt'<>'null'::jsonb AND(jsonb_typeof(p_input->'expiresAt') IS DISTINCT FROM 'string' OR p_input->>'expiresAt'!~'^[12][0-9]{3}-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'))
  OR jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'reason')) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  plan=(p_input->>'planId')::uuid;plan_v=(p_input->>'planVersion')::integer;why=p_input->>'reason';
  BEGIN starts=(p_input->>'startsAt')::timestamptz;ends=(p_input->>'expiresAt')::timestamptz;EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END;
  SELECT subscription_version,subscription_terms INTO v,prior FROM public.academies WHERE id=school FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
  IF v<>(p_input->>'expectedVersion')::integer THEN RAISE EXCEPTION 'PLATFORM_SUBSCRIPTION_VERSION_CHANGED' USING ERRCODE='23514';END IF;
  -- Lock the catalogue head against a simultaneous archive or repricing.
  PERFORM 1 FROM platform_private.subscription_plans p WHERE p.id=plan AND p.version=plan_v AND p.definition->'active'='true'::jsonb FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_PLAN_NOT_CURRENT' USING ERRCODE='23514';END IF;
  SELECT definition INTO edition FROM platform_private.subscription_plan_editions WHERE plan_id=plan AND version=plan_v;
  IF edition IS NULL OR(ends IS NULL AND edition->>'amountMinor'<>'0') OR(ends IS NOT NULL AND ends<=starts) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  terms=jsonb_build_object('planId',plan,'planVersion',plan_v,'startsAt',p_input->>'startsAt','expiresAt',p_input->>'expiresAt','graceDays',(edition->>'graceDays')::integer,'free',edition->>'amountMinor'='0');
  IF terms IS NOT DISTINCT FROM prior THEN RAISE EXCEPTION 'PLATFORM_SUBSCRIPTION_UNCHANGED' USING ERRCODE='23514';END IF;
  data=jsonb_build_object('academyId',school,'version',v+1,'terms',terms);response=jsonb_build_object('status',200,'body',jsonb_build_object('data',data,'chargesPerformed',false,'paymentVerified',false,'operationalStatusChanged',false));
  INSERT INTO platform_private.audit_events(id,actor_user_id,session_id,request_key,action,academy_id,before_data,after_data,reason) VALUES(audit_id,p_user,p_session,p_key,'platform.subscription.assigned',school,jsonb_build_object('academyId',school,'version',v,'terms',prior),data,why);
  INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,response);
  UPDATE public.academies SET subscription_version=v+1,subscription_terms=terms WHERE id=school;
  INSERT INTO platform_private.school_subscription_editions(academy_id,version,plan_id,plan_version,terms,actor_user_id,session_id,request_key,audit_id) VALUES(school,v+1,plan,plan_v,terms,p_user,p_session,p_key,audit_id);
  RETURN response;
 END IF;
 IF p_input-(CASE WHEN p_operation='subscriptions.get' THEN ARRAY['academyId'] ELSE ARRAY['academyId','limit','beforeVersion'] END)<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 SELECT jsonb_build_object('academyId',id,'version',subscription_version,'terms',subscription_terms,'operationalStatus',status,'effectiveStatus',public.effective_academy_status(status,subscription_terms),'subscriptionState',public.subscription_access_state(subscription_terms)) INTO data FROM public.academies WHERE id=school;
 IF data IS NULL THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF p_operation='subscriptions.history' THEN
  IF(p_input?'limit' AND(jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR p_input->>'limit'!~'^([1-9][0-9]?|100)$')) OR(p_input?'beforeVersion' AND(jsonb_typeof(p_input->'beforeVersion') IS DISTINCT FROM 'number' OR p_input->>'beforeVersion'!~'^[1-9][0-9]{0,9}$' OR(p_input->>'beforeVersion')::numeric>2147483647)) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  lim=coalesce((p_input->>'limit')::integer,50);before_v=(p_input->>'beforeVersion')::integer;
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY version DESC),'[]'::jsonb) INTO data FROM(SELECT q.academy_id,q.version,q.plan_id,q.plan_version,q.terms,q.created_at FROM platform_private.school_subscription_editions q WHERE q.academy_id=school AND(before_v IS NULL OR q.version<before_v) ORDER BY q.version DESC LIMIT lim+1)e;
  before_v=NULL;IF jsonb_array_length(data)>lim THEN before_v=(data->(lim-1)->>'version')::integer;data=data-lim;END IF;response=jsonb_build_object('data',data,'nextBeforeVersion',before_v);
 ELSE response=jsonb_build_object('data',data);END IF;
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data) VALUES(p_user,p_session,'platform.'||p_operation,school,jsonb_build_object('academyId',school));RETURN jsonb_build_object('status',200,'body',response);
END $$;
DO $$ DECLARE d text;marker text:=' PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 d=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(d)-length(replace(d,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'PLATFORM_GATEWAY_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,marker,marker||E'\n IF p_operation IN(''subscriptions.get'',''subscriptions.history'',''subscriptions.assign'') THEN RETURN platform_private.subscription_request(p_user,p_session,p_operation,p_key,p_input);END IF;');
END $$;
DO $$ DECLARE d text;needle text:='SELECT id,name,status,platform_version AS version,created_at FROM public.academies';BEGIN
 d=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'PLATFORM_DIRECTORY_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,needle,'SELECT id,name,status,platform_version AS version,subscription_version AS "subscriptionVersion",public.subscription_access_state(subscription_terms) AS "subscriptionState",public.effective_academy_status(status,subscription_terms) AS "effectiveStatus",created_at FROM public.academies');
END $$;
REVOKE ALL ON FUNCTION public.subscription_access_state(jsonb),public.effective_academy_status(text,jsonb),platform_private.guard_school_subscription(),platform_private.verify_school_subscription(),platform_private.subscription_request(uuid,uuid,text,uuid,jsonb) FROM PUBLIC;
GRANT SELECT,INSERT ON platform_private.school_subscription_editions TO kavosh_platform_policy;
GRANT UPDATE(subscription_version,subscription_terms) ON public.academies TO kavosh_platform_policy;
GRANT EXECUTE ON FUNCTION platform_private.subscription_request(uuid,uuid,text,uuid,jsonb) TO kavosh_platform_policy;
-- Pure status helpers reveal no rows. Explicit existing callers only: never
-- grant future/custom backup logins executable application functions by prefix.
GRANT EXECUTE ON FUNCTION public.subscription_access_state(jsonb),public.effective_academy_status(text,jsonb) TO
 kavosh_runtime,kavosh_identity_policy,kavosh_platform_policy,kavosh_automation_policy,kavosh_automation_worker,
 kavosh_message_policy,kavosh_message_worker,kavosh_bot_policy,kavosh_file_policy,kavosh_signature_policy,kavosh_payment_policy,
 kavosh_report_capture_policy,kavosh_checkout_result_policy,kavosh_signature_completion_policy,kavosh_signature_evidence_policy,kavosh_signature_result_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
ALTER FUNCTION platform_private.verify_school_subscription() OWNER TO kavosh_platform_policy;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
-- Original function identities,owners and grants remain. Change only the
-- reviewed school alias,not record variables named a in unrelated guards.
DO $$ DECLARE sig text;d text;alias_name text;needle text;BEGIN
 FOREACH sig IN ARRAY ARRAY[
 'public.automation_subscription_source(uuid)','public.bot_credential_basis(uuid,uuid)','public.bot_registration_basis(uuid,uuid)',
 'public.human_invitation_basis(uuid)','identity.accept_invite(text,uuid,uuid)','identity.inspect_invite(text,text)','identity.memberships(uuid)',
 'public.notification_delivery_preference(uuid)','public.payment_checkout_live_source(uuid)','public.expense_reminder_source(uuid,integer,text)',
 'public.payroll_reminder_source_read(uuid,integer,text)','public.statement_reminder_assessment(uuid,integer,text,jsonb)',
 'public.received_statement_assessment(uuid,integer,text,jsonb)','public.tuition_reminder_sources(uuid,integer)'] LOOP
  alias_name=CASE WHEN sig='public.tuition_reminder_sources(uuid,integer)' THEN 'school' ELSE 'a' END;
  d=pg_get_functiondef(sig::regprocedure);needle=alias_name||'.status';
  IF position('public.academies '||alias_name IN d)=0 OR position(needle IN d)=0 THEN RAISE EXCEPTION 'SUBSCRIPTION_STATUS_SOURCE_CHANGED:%',sig;END IF;
  EXECUTE replace(d,needle,'public.effective_academy_status('||needle||','||alias_name||'.subscription_terms)');
 END LOOP;
 FOREACH sig IN ARRAY ARRAY['public.calendar_event_basis(uuid,text,uuid,uuid)','public.session_follow_up_guard()','public.session_reminder_guard()'] LOOP
  d=pg_get_functiondef(sig::regprocedure);needle=CASE WHEN sig='public.calendar_event_basis(uuid,text,uuid,uuid)' THEN 'FROM public.academies WHERE id=tenant AND status=''active''' ELSE 'FROM public.academies WHERE id=NEW.academy_id AND status=''active''' END;
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'SUBSCRIPTION_STATUS_SOURCE_CHANGED:%',sig;END IF;
  EXECUTE replace(d,needle,replace(needle,'status=''active''','public.effective_academy_status(status,subscription_terms)=''active'''));
 END LOOP;
 d=pg_get_functiondef('public.require_notification_preference_receipt()'::regprocedure);
 needle='FROM public.academies WHERE id=NEW.academy_id AND(status=''active'' OR(status=''read_only'' AND NOT NEW.email_enabled AND NOT NEW.sms_enabled))';
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'SUBSCRIPTION_PREFERENCE_SOURCE_CHANGED';END IF;
 EXECUTE replace(d,needle,replace(replace(needle,'status=''active''','public.effective_academy_status(status,subscription_terms)=''active'''),'status=''read_only''','public.effective_academy_status(status,subscription_terms)=''read_only'''));
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 310 $$;

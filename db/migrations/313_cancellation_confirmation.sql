-- Owner confirmation restricts operation but never purges records,cancels a
-- provider payment,issues a refund or asserts that legal retention is cleared.
ALTER TABLE platform_private.school_cancellation_decisions DROP CONSTRAINT school_cancellation_decisions_decision_check;
ALTER TABLE platform_private.school_cancellation_decisions ADD CHECK(decision IN('withdrawn','confirmed')),
 ADD COLUMN reviewed_subscription_version integer,
 ADD COLUMN operational_before text,ADD COLUMN operational_after text,
 ADD COLUMN academy_version_before integer,ADD COLUMN academy_version_after integer,
 ADD CHECK((decision='withdrawn' AND reviewed_subscription_version IS NULL AND operational_before IS NULL AND operational_after IS NULL AND academy_version_before IS NULL AND academy_version_after IS NULL)
 OR(decision='confirmed' AND reviewed_subscription_version>=0 AND operational_before IN('provisioning','active','read_only','suspended')
 AND operational_after=CASE WHEN operational_before IN('active','provisioning') THEN 'read_only' ELSE operational_before END
 AND academy_version_before>0 AND academy_version_after=academy_version_before+CASE WHEN operational_before IS DISTINCT FROM operational_after THEN 1 ELSE 0 END
 AND reviewed_subscription_version IS NOT NULL AND operational_before IS NOT NULL AND operational_after IS NOT NULL AND academy_version_before IS NOT NULL AND academy_version_after IS NOT NULL));
CREATE OR REPLACE VIEW platform_private.school_cancellation_cases AS
 SELECT r.id,r.academy_id,
 jsonb_build_object('id',r.id,'academyId',r.academy_id,'version',1,'status','pending','requestedSubscriptionVersion',r.source_version,'requestedAt',r.requested_at,'reviewAfter',r.review_after,'withdrawnAt',NULL) AS original_data,
 CASE WHEN d.decision='confirmed' THEN jsonb_build_object('id',r.id,'academyId',r.academy_id,'version',2,'status','confirmed','requestedSubscriptionVersion',r.source_version,'requestedAt',r.requested_at,'reviewAfter',r.review_after,'withdrawnAt',NULL,'confirmedAt',d.decided_at,'reviewedSubscriptionVersion',d.reviewed_subscription_version,'operationalStatus',d.operational_after)
 ELSE jsonb_build_object('id',r.id,'academyId',r.academy_id,'version',CASE WHEN d.request_id IS NULL THEN 1 ELSE 2 END,'status',coalesce(d.decision,'pending'),'requestedSubscriptionVersion',r.source_version,'requestedAt',r.requested_at,'reviewAfter',r.review_after,'withdrawnAt',d.decided_at) END AS current_data
 FROM platform_private.school_cancellation_requests r LEFT JOIN platform_private.school_cancellation_decisions d ON d.request_id=r.id;
-- Keep the original verifier OID,owner and ACL while extending its exact action
-- and checking actual access effects,not just a caller's confirmation flag.
DO $$ DECLARE d text;needle text;BEGIN
 d=pg_get_functiondef('platform_private.verify_school_cancellation_record()'::regprocedure);
 needle='action_name=''platform.subscription.cancellation.withdrawn'';';
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'CANCELLATION_VERIFIER_SHAPE_CHANGED';END IF;
 d=replace(d,needle,'action_name=CASE WHEN NEW.decision=''confirmed'' THEN ''platform.subscription.cancellation.confirmed'' ELSE ''platform.subscription.cancellation.withdrawn'' END;');
 needle=' SELECT * INTO a FROM platform_private.audit_events WHERE id=NEW.audit_id;';
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'CANCELLATION_VERIFIER_SHAPE_CHANGED';END IF;
 d=replace(d,needle,E' IF TG_TABLE_NAME=''school_cancellation_decisions'' THEN\n  IF NEW.decision=''confirmed'' THEN\n   IF NOT EXISTS(SELECT 1 FROM platform_private.school_cancellation_requests q JOIN public.academies s ON s.id=q.academy_id WHERE q.id=NEW.request_id AND NEW.decided_at>=q.review_after AND NEW.decided_at<=clock_timestamp() AND s.subscription_version=NEW.reviewed_subscription_version AND s.status=NEW.operational_after AND s.platform_version=NEW.academy_version_after) THEN RAISE EXCEPTION ''PLATFORM_CANCELLATION_EFFECTS_MISSING'' USING ERRCODE=''23514'';END IF;\n  END IF;\n END IF;\n'||needle);
 needle=' IF data IS NULL OR';
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'CANCELLATION_VERIFIER_SHAPE_CHANGED';END IF;
 d=replace(d,needle,E' IF TG_TABLE_NAME=''school_cancellation_decisions'' THEN\n  IF NEW.decision=''confirmed'' THEN\n   IF a.before_data IS DISTINCT FROM jsonb_build_object(''academyId'',NEW.academy_id,''version'',NEW.academy_version_before,''operationalStatus'',NEW.operational_before,''subscriptionVersion'',NEW.reviewed_subscription_version) OR a.created_at<NEW.decided_at THEN RAISE EXCEPTION ''PLATFORM_CANCELLATION_EFFECTS_MISSING'' USING ERRCODE=''23514'';END IF;\n  END IF;\n END IF;\n'||needle);
 EXECUTE d;
END $$;
CREATE FUNCTION platform_private.confirm_school_cancellation(p_user uuid,p_session uuid,p_key uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE school uuid;target uuid;v integer;platform_v integer;before_status text;after_status text;after_v integer;q record;why text;data jsonb;response jsonb;receipt record;fingerprint text;audit_id uuid:=gen_random_uuid();at_time timestamptz;inserted uuid;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF p_key IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384 OR p_input-ARRAY['academyId','cancellationId','expectedVersion','expectedSubscriptionVersion','confirmAcademyId','reason']<>'{}'::jsonb
 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'cancellationId') IS DISTINCT FROM 'string' OR p_input->>'cancellationId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR p_input->'expectedVersion' IS DISTINCT FROM '1'::jsonb OR p_input->'confirmAcademyId' IS DISTINCT FROM p_input->'academyId'
 OR jsonb_typeof(p_input->'expectedSubscriptionVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedSubscriptionVersion'!~'^(0|[1-9][0-9]{0,9})$' OR(p_input->>'expectedSubscriptionVersion')::numeric>2147483647
 OR jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'reason')) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 school=(p_input->>'academyId')::uuid;target=(p_input->>'cancellationId')::uuid;why=p_input->>'reason';
 PERFORM pg_advisory_xact_lock(hashtextextended(school::text,310));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,8));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,9));
 PERFORM platform_private.authorize_owner(p_user,p_session,true);
 fingerprint=encode(sha256(convert_to(jsonb_build_object('operation','cancellations.confirm','input',p_input)::text,'UTF8')),'hex');PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));
 SELECT * INTO receipt FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
 IF FOUND THEN IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN receipt.result;END IF;
 SELECT * INTO q FROM platform_private.school_cancellation_requests WHERE academy_id=school AND id=target;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF EXISTS(SELECT 1 FROM platform_private.school_cancellation_decisions WHERE request_id=target) THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_ALREADY_DECIDED' USING ERRCODE='23514';END IF;
 at_time=clock_timestamp();IF at_time<q.review_after THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_WAITING_PERIOD' USING ERRCODE='23514';END IF;
 SELECT subscription_version,status,platform_version INTO v,before_status,platform_v FROM public.academies WHERE id=school FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF v<>(p_input->>'expectedSubscriptionVersion')::integer THEN RAISE EXCEPTION 'PLATFORM_SUBSCRIPTION_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 -- The original waiting clock survives a renewal;the owner explicitly reviews
 -- the CURRENT licence version instead of silently cancelling an unseen one.
 after_status=CASE WHEN before_status IN('active','provisioning') THEN 'read_only' ELSE before_status END;
 UPDATE public.academies SET status=after_status WHERE id=school RETURNING status,platform_version INTO after_status,after_v;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
 INSERT INTO platform_private.school_cancellation_decisions(request_id,academy_id,decision,decided_at,actor_user_id,session_id,request_key,audit_id,reviewed_subscription_version,operational_before,operational_after,academy_version_before,academy_version_after)
 VALUES(target,school,'confirmed',at_time,p_user,p_session,p_key,audit_id,v,before_status,after_status,platform_v,after_v) RETURNING request_id INTO inserted;
 IF inserted IS DISTINCT FROM target THEN RAISE EXCEPTION 'PLATFORM_CANCELLATION_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
 SELECT current_data INTO data FROM platform_private.school_cancellation_cases WHERE id=target;
 response=jsonb_build_object('status',200,'body',jsonb_build_object('data',data,'schoolAccessChanged',before_status IS DISTINCT FROM after_status,'cancellationPerformed',true,'deletionPerformed',false,'chargesPerformed',false,'paymentCancellationPerformed',false,'retentionReviewRequired',true));
 INSERT INTO platform_private.audit_events(id,actor_user_id,session_id,request_key,action,academy_id,before_data,after_data,reason) VALUES(audit_id,p_user,p_session,p_key,'platform.subscription.cancellation.confirmed',school,jsonb_build_object('academyId',school,'version',platform_v,'operationalStatus',before_status,'subscriptionVersion',v),data,why);
 INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,response);RETURN response;
END $$;
DO $$ DECLARE d text;marker text:=' PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 d=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF(length(d)-length(replace(d,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'PLATFORM_GATEWAY_SHAPE_CHANGED';END IF;
 EXECUTE replace(d,marker,marker||E'\n IF p_operation=''cancellations.confirm'' THEN RETURN platform_private.confirm_school_cancellation(p_user,p_session,p_key,p_input);END IF;');
END $$;
REVOKE ALL ON FUNCTION platform_private.confirm_school_cancellation(uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_private.confirm_school_cancellation(uuid,uuid,uuid,jsonb) TO kavosh_platform_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 313 $$;

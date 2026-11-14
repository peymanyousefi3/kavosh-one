-- Owner confirmation is a durable intent,not deletion. The offline operator
-- must verify backup inclusion and recheck this source before any destructive
-- transaction. Reuse immutable audit/receipt storage;no new runtime authority.
CREATE FUNCTION platform_private.confirm_disposition(p_user uuid,p_session uuid,p_key uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE school uuid;cancellation uuid;target uuid;review record;v integer;sv integer;state text;fingerprint text;receipt record;retained jsonb;fresh jsonb;data jsonb;result jsonb;at_time timestamptz;why text;confirmation_id uuid:=gen_random_uuid();inserted uuid;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF p_key IS NULL OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16384
 OR p_input-ARRAY['academyId','cancellationId','reviewId','confirmAcademyId','expectedSourceFingerprint','confirmScope','reason']<>'{}'::jsonb
 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'cancellationId') IS DISTINCT FROM 'string' OR p_input->>'cancellationId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'reviewId') IS DISTINCT FROM 'string' OR p_input->>'reviewId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR p_input->'confirmAcademyId' IS DISTINCT FROM p_input->'academyId' OR p_input->'confirmScope' IS DISTINCT FROM '"delete_reviewed_candidates"'::jsonb
 OR jsonb_typeof(p_input->'expectedSourceFingerprint') IS DISTINCT FROM 'string' OR p_input->>'expectedSourceFingerprint'!~'^[a-f0-9]{64}$'
 OR jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'reason')) NOT BETWEEN 1 AND 2000 OR p_input->>'reason'~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 school=(p_input->>'academyId')::uuid;cancellation=(p_input->>'cancellationId')::uuid;target=(p_input->>'reviewId')::uuid;why=p_input->>'reason';
 PERFORM pg_advisory_xact_lock(hashtextextended(school::text,310));PERFORM pg_advisory_xact_lock_shared(hashtextextended(school::text,374));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,8));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,9));PERFORM platform_private.authorize_owner(p_user,p_session,true);
 fingerprint=encode(sha256(convert_to(jsonb_build_object('operation','disposition.confirm','input',p_input)::text,'UTF8')),'hex');PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));SELECT * INTO receipt FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
 IF FOUND THEN IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN receipt.result;END IF;
 SELECT * INTO review FROM platform_private.disposition_reviews WHERE id=target AND academy_id=school AND cancellation_id=cancellation;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF review.source_fingerprint<>p_input->>'expectedSourceFingerprint' THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 SELECT platform_version,subscription_version,status INTO v,sv,state FROM public.academies WHERE id=school FOR SHARE;
 IF v IS DISTINCT FROM review.academy_version OR sv IS DISTINCT FROM review.subscription_version THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF state NOT IN('read_only','suspended') OR NOT EXISTS(SELECT 1 FROM platform_private.school_cancellation_requests r JOIN platform_private.school_cancellation_decisions d ON d.request_id=r.id AND d.academy_id=r.academy_id WHERE r.id=cancellation AND r.academy_id=school AND d.decision='confirmed' AND r.review_after<=clock_timestamp() AND d.reviewed_subscription_version=sv) THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_CANCELLATION_REQUIRED' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(review.decisions) item WHERE item->>'decision'='eligible' AND(item->>'eligibleOn')::date>(clock_timestamp() AT TIME ZONE review.review_time_zone)::date) THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_RETENTION_PENDING' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM platform_private.audit_events a WHERE a.action='platform.disposition.confirmed' AND a.academy_id=school AND a.after_data->>'reviewId'=target::text AND(a.after_data->>'expiresAt')::timestamptz>clock_timestamp()) THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_ALREADY_QUEUED' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(value->>'relation' ORDER BY value->>'relation' COLLATE "C"),'[]'::jsonb) INTO retained FROM jsonb_array_elements(review.decisions) WHERE value->>'decision'='retain';
 fresh=platform_private.inspect_disposition_manifest(p_user,p_session,school,jsonb_build_object('records','[]'::jsonb,'relations',retained),100000,100000,why);
 IF fresh->>'sourceFingerprint' IS DISTINCT FROM review.source_fingerprint OR fresh->'snapshot'->'cross_tenant_reference' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 PERFORM platform_private.authorize_owner(p_user,p_session,true);at_time=clock_timestamp();
 data=jsonb_build_object('id',confirmation_id,'academyId',school,'cancellationId',cancellation,'reviewId',target,'sourceFingerprint',review.source_fingerprint,'sourceAuditId',fresh->'auditId','confirmedAt',at_time,'expiresAt',at_time+interval '24 hours','creationTransaction',pg_current_xact_id()::text,'confirmScope','delete_reviewed_candidates','status','queued','backupInclusionRequired',true,'executionPerformed',false,'deletionPerformed',false);
 result=jsonb_build_object('status',202,'body',jsonb_build_object('data',data,'deletionPerformed',false));
 INSERT INTO platform_private.audit_events(id,actor_user_id,session_id,request_key,action,academy_id,after_data,reason) VALUES(confirmation_id,p_user,p_session,p_key,'platform.disposition.confirmed',school,data,why) RETURNING id INTO inserted;
 IF inserted IS DISTINCT FROM confirmation_id THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
 INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,result) RETURNING user_id INTO inserted;
 IF inserted IS DISTINCT FROM p_user THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
 RETURN result;
END $$;
DO $$ DECLARE body text;marker text:=' PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);IF(length(body)-length(replace(body,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'DISPOSITION_CONFIRMATION_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,marker,marker||E'\n IF p_operation=''disposition.confirm'' THEN RETURN platform_private.confirm_disposition(p_user,p_session,p_key,p_input);END IF;');
END $$;
REVOKE ALL ON FUNCTION platform_private.confirm_disposition(uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_private.confirm_disposition(uuid,uuid,uuid,jsonb) TO kavosh_platform_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 430 $$;

-- A reviewed source is not an execution grant. Keep the review, native source
-- receipt and original cancellation immutable; later execution must recheck all.
CREATE TABLE platform_private.disposition_reviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),academy_id uuid NOT NULL REFERENCES public.academies(id),
 cancellation_id uuid NOT NULL,academy_version integer NOT NULL CHECK(academy_version>0),subscription_version integer NOT NULL CHECK(subscription_version>=0),
 source_audit_id uuid NOT NULL UNIQUE REFERENCES platform_private.audit_events(id),source_fingerprint text NOT NULL CHECK(source_fingerprint~'^[a-f0-9]{64}$'),
 decisions jsonb NOT NULL CHECK(jsonb_typeof(decisions)='array' AND jsonb_array_length(decisions) BETWEEN 1 AND 2000),
 review_reference text NOT NULL CHECK(length(btrim(review_reference)) BETWEEN 1 AND 500),review_time_zone text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),actor_user_id uuid NOT NULL REFERENCES identity."user"(id),session_id uuid NOT NULL,request_key uuid NOT NULL,audit_id uuid NOT NULL UNIQUE,
 FOREIGN KEY(academy_id,cancellation_id) REFERENCES platform_private.school_cancellation_requests(academy_id,id),
 FOREIGN KEY(audit_id) REFERENCES platform_private.audit_events(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(actor_user_id,request_key) REFERENCES platform_private.request_receipts(user_id,request_key) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX disposition_review_case ON platform_private.disposition_reviews(academy_id,cancellation_id,id);
CREATE TRIGGER disposition_review_immutable BEFORE UPDATE OR DELETE ON platform_private.disposition_reviews FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE VIEW platform_private.disposition_review_cases AS
 SELECT r.id,r.academy_id,r.cancellation_id,jsonb_build_object(
  'id',r.id,'academyId',r.academy_id,'cancellationId',r.cancellation_id,'academyVersion',r.academy_version,'subscriptionVersion',r.subscription_version,
  'sourceAuditId',r.source_audit_id,'sourceFingerprint',r.source_fingerprint,'recordedAt',r.recorded_at,
  'retentionDecisions',r.decisions,'reviewReference',r.review_reference,'reviewTimeZone',r.review_time_zone,
  'sourceRows',s.after_data->'manifest'->'snapshot'->'source_manifest'->'totalRows',
  'retainedRows',s.after_data->'manifest'->'snapshot'->'retained_count',
  'candidateRows',s.after_data->'manifest'->'snapshot'->'source_manifest'->'candidateRows',
  'status','awaiting_confirmation','retentionDecisionSource','explicit_owner_review','statutoryComplianceCertified',false,'executionAuthorized',false,'dataDeleted',false) data
 FROM platform_private.disposition_reviews r JOIN platform_private.audit_events s ON s.id=r.source_audit_id;
CREATE FUNCTION platform_private.verify_disposition_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE source record;a record;receipt record;data jsonb;input jsonb;
BEGIN
 PERFORM platform_private.authorize_owner(NEW.actor_user_id,NEW.session_id);
 SELECT * INTO source FROM platform_private.audit_events WHERE id=NEW.source_audit_id;
 SELECT c.data INTO data FROM platform_private.disposition_review_cases c WHERE c.id=NEW.id;
 SELECT * INTO a FROM platform_private.audit_events WHERE id=NEW.audit_id;
 SELECT * INTO receipt FROM platform_private.request_receipts WHERE user_id=NEW.actor_user_id AND request_key=NEW.request_key;
 input=jsonb_build_object('academyId',NEW.academy_id,'cancellationId',NEW.cancellation_id,'expectedAcademyVersion',NEW.academy_version,'expectedSubscriptionVersion',NEW.subscription_version,'retentionDecisions',NEW.decisions,'reviewReference',NEW.review_reference,'reviewTimeZone',NEW.review_time_zone,'reason',a.reason);
 IF data IS NULL OR source.action IS DISTINCT FROM 'platform.disposition.snapshot.read' OR source.academy_id IS DISTINCT FROM NEW.academy_id OR source.actor_user_id IS DISTINCT FROM NEW.actor_user_id OR source.session_id IS DISTINCT FROM NEW.session_id
 OR source.after_data->'manifest'->>'sourceFingerprint' IS DISTINCT FROM NEW.source_fingerprint OR source.after_data->'manifest'->>'auditId' IS DISTINCT FROM NEW.source_audit_id::text
 OR source.after_data->'manifest'->'executionAuthorized' IS DISTINCT FROM 'false'::jsonb OR source.after_data->'manifest'->'dataDeleted' IS DISTINCT FROM 'false'::jsonb
 OR a.actor_user_id IS DISTINCT FROM NEW.actor_user_id OR a.session_id IS DISTINCT FROM NEW.session_id OR a.request_key IS DISTINCT FROM NEW.request_key OR a.academy_id IS DISTINCT FROM NEW.academy_id OR a.action IS DISTINCT FROM 'platform.disposition.review.prepared' OR a.after_data IS DISTINCT FROM data
 OR receipt.result IS DISTINCT FROM jsonb_build_object('status',201,'body',jsonb_build_object('data',data,'deletionPerformed',false))
 OR receipt.fingerprint IS DISTINCT FROM encode(sha256(convert_to(jsonb_build_object('operation','disposition.prepare','input',input)::text,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_EFFECTS_MISSING' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER disposition_review_complete AFTER INSERT ON platform_private.disposition_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION platform_private.verify_disposition_review();
CREATE FUNCTION platform_private.disposition_review_request(p_user uuid,p_session uuid,p_operation text,p_key uuid,p_input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE school uuid;cancellation uuid;target uuid;v integer;sv integer;state text;why text;fingerprint text;receipt record;decision jsonb;relations jsonb;retained jsonb;source jsonb;data jsonb;response jsonb;audit_id uuid:=gen_random_uuid();review_id uuid:=gen_random_uuid();zone text;today date;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF p_operation IS NULL OR p_operation NOT IN('disposition.prepare','disposition.get') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>1048576
 OR jsonb_typeof(p_input->'academyId') IS DISTINCT FROM 'string' OR p_input->>'academyId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR jsonb_typeof(p_input->'cancellationId') IS DISTINCT FROM 'string' OR p_input->>'cancellationId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 school=(p_input->>'academyId')::uuid;cancellation=(p_input->>'cancellationId')::uuid;
 IF p_operation='disposition.get' THEN
  IF p_input-ARRAY['academyId','cancellationId','reviewId']<>'{}'::jsonb OR jsonb_typeof(p_input->'reviewId') IS DISTINCT FROM 'string' OR p_input->>'reviewId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  target=(p_input->>'reviewId')::uuid;SELECT c.data INTO data FROM platform_private.disposition_review_cases c WHERE c.id=target AND c.academy_id=school AND c.cancellation_id=cancellation;
  IF data IS NULL THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_NOT_FOUND' USING ERRCODE='P0002';END IF;
  INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,academy_id,after_data) VALUES(p_user,p_session,'platform.disposition.review.read',school,jsonb_build_object('reviewId',target));
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('data',data,'sourceFreshness','not_rechecked','deletionPerformed',false));
 END IF;
 IF p_key IS NULL OR p_input-ARRAY['academyId','cancellationId','expectedAcademyVersion','expectedSubscriptionVersion','retentionDecisions','reviewReference','reviewTimeZone','reason']<>'{}'::jsonb
 OR jsonb_typeof(p_input->'expectedAcademyVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedAcademyVersion'!~'^[1-9][0-9]{0,9}$' OR(p_input->>'expectedAcademyVersion')::numeric>2147483647
 OR jsonb_typeof(p_input->'expectedSubscriptionVersion') IS DISTINCT FROM 'number' OR p_input->>'expectedSubscriptionVersion'!~'^(0|[1-9][0-9]{0,9})$' OR(p_input->>'expectedSubscriptionVersion')::numeric>2147483647
 OR jsonb_typeof(p_input->'retentionDecisions') IS DISTINCT FROM 'array' OR jsonb_typeof(p_input->'reviewReference') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'reviewReference')) NOT BETWEEN 1 AND 500 OR p_input->>'reviewReference'~'[[:cntrl:]]'
 OR jsonb_typeof(p_input->'reviewTimeZone') IS DISTINCT FROM 'string' OR length(p_input->>'reviewTimeZone') NOT BETWEEN 1 AND 100
 OR jsonb_typeof(p_input->'reason') IS DISTINCT FROM 'string' OR length(btrim(p_input->>'reason')) NOT BETWEEN 1 AND 2000 OR p_input->>'reason'~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 zone=p_input->>'reviewTimeZone';IF(zone<>'UTC' AND position('/' in zone)=0) OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=zone) THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;today=(clock_timestamp() AT TIME ZONE zone)::date;
 IF jsonb_array_length(p_input->'retentionDecisions') NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 FOR decision IN SELECT value FROM jsonb_array_elements(p_input->'retentionDecisions') LOOP
  IF jsonb_typeof(decision)<>'object' OR decision-ARRAY['relation','decision','basis','eligibleOn']<>'{}'::jsonb OR NOT(decision?&ARRAY['relation','decision','basis','eligibleOn'])
  OR jsonb_typeof(decision->'relation') IS DISTINCT FROM 'string' OR decision->>'relation'!~'^public[.][A-Za-z_][A-Za-z0-9_$]{0,62}$'
  OR jsonb_typeof(decision->'decision') IS DISTINCT FROM 'string' OR decision->>'decision' NOT IN('retain','eligible')
  OR jsonb_typeof(decision->'basis') IS DISTINCT FROM 'string' OR length(btrim(decision->>'basis')) NOT BETWEEN 1 AND 500 OR decision->>'basis'~'[[:cntrl:]]'
  THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  IF decision->>'decision'='retain' THEN IF decision->'eligibleOn'<>'null'::jsonb THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  ELSE
   IF jsonb_typeof(decision->'eligibleOn') IS DISTINCT FROM 'string' OR decision->>'eligibleOn'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
   BEGIN IF(decision->>'eligibleOn')::date>today THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_RETENTION_PENDING' USING ERRCODE='23514';END IF;EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END;
  END IF;
 END LOOP;
 SELECT jsonb_agg(name ORDER BY name COLLATE "C") INTO relations FROM(SELECT 'public.'||c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND NOT a.attisdropped AND a.attname=CASE WHEN c.relname='academies' THEN 'id' ELSE 'academy_id' END)) names;
 IF relations IS DISTINCT FROM(SELECT jsonb_agg(value->>'relation' ORDER BY value->>'relation' COLLATE "C") FROM jsonb_array_elements(p_input->'retentionDecisions')) THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_CLASSIFICATION_INCOMPLETE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(school::text,310));PERFORM pg_advisory_xact_lock_shared(hashtextextended(school::text,374));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,8));PERFORM pg_advisory_xact_lock(hashtextextended(school::text,9));PERFORM platform_private.authorize_owner(p_user,p_session,true);
 fingerprint=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,'input',p_input)::text,'UTF8')),'hex');PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));SELECT * INTO receipt FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
 IF FOUND THEN IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN receipt.result;END IF;
 SELECT platform_version,subscription_version,status INTO v,sv,state FROM public.academies WHERE id=school FOR SHARE;IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF v<>(p_input->>'expectedAcademyVersion')::integer THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 IF sv<>(p_input->>'expectedSubscriptionVersion')::integer THEN RAISE EXCEPTION 'PLATFORM_SUBSCRIPTION_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 IF state NOT IN('read_only','suspended') OR NOT EXISTS(SELECT 1 FROM platform_private.school_cancellation_requests r JOIN platform_private.school_cancellation_decisions d ON d.request_id=r.id AND d.academy_id=r.academy_id WHERE r.id=cancellation AND r.academy_id=school AND d.decision='confirmed' AND r.review_after<=clock_timestamp() AND d.reviewed_subscription_version=sv) THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_CANCELLATION_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(value->>'relation' ORDER BY value->>'relation' COLLATE "C"),'[]'::jsonb) INTO retained FROM jsonb_array_elements(p_input->'retentionDecisions') WHERE value->>'decision'='retain';
 why=p_input->>'reason';source=platform_private.inspect_disposition_manifest(p_user,p_session,school,jsonb_build_object('records','[]'::jsonb,'relations',retained),100000,100000,why);
 INSERT INTO platform_private.disposition_reviews(id,academy_id,cancellation_id,academy_version,subscription_version,source_audit_id,source_fingerprint,decisions,review_reference,review_time_zone,actor_user_id,session_id,request_key,audit_id)
 VALUES(review_id,school,cancellation,v,sv,(source->>'auditId')::uuid,source->>'sourceFingerprint',p_input->'retentionDecisions',p_input->>'reviewReference',zone,p_user,p_session,p_key,audit_id);
 SELECT c.data INTO data FROM platform_private.disposition_review_cases c WHERE c.id=review_id;IF data IS NULL THEN RAISE EXCEPTION 'PLATFORM_DISPOSITION_EFFECTS_MISSING' USING ERRCODE='23514';END IF;
 response=jsonb_build_object('status',201,'body',jsonb_build_object('data',data,'deletionPerformed',false));
 INSERT INTO platform_private.audit_events(id,actor_user_id,session_id,request_key,action,academy_id,after_data,reason) VALUES(audit_id,p_user,p_session,p_key,'platform.disposition.review.prepared',school,data,why);
 INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,response);RETURN response;
END $$;
DO $$ DECLARE body text;marker text:=' PERFORM platform_private.authorize_owner(p_user,p_session);';BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);IF(length(body)-length(replace(body,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'DISPOSITION_REVIEW_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,marker,marker||E'\n IF p_operation IN(''disposition.prepare'',''disposition.get'') THEN RETURN platform_private.disposition_review_request(p_user,p_session,p_operation,p_key,p_input);END IF;');
END $$;
REVOKE ALL ON FUNCTION platform_private.verify_disposition_review(),platform_private.disposition_review_request(uuid,uuid,text,uuid,jsonb) FROM PUBLIC;
GRANT SELECT,INSERT ON platform_private.disposition_reviews TO kavosh_platform_policy;
GRANT SELECT ON platform_private.disposition_review_cases TO kavosh_platform_policy;
GRANT EXECUTE ON FUNCTION platform_private.disposition_review_request(uuid,uuid,text,uuid,jsonb) TO kavosh_platform_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 429 $$;

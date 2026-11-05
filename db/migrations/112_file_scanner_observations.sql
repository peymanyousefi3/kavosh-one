-- Retain what the isolated worker observed, NOT authenticated signature files,
-- exact scan-engine pinning, current freshness, safe serving or legal clearance.
CREATE FUNCTION public.valid_file_scanner_observation(j jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE keys text[]:=ARRAY['formatVersion','engineVersion','databaseVersion','databaseCreatedAt','observedAt','observedBeforeAt','timeZone','maximumAgeSeconds'];k text;b timestamptz;a timestamptz;d timestamptz;n numeric;
BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR NOT(j ?& keys) OR j-keys<>'{}'::jsonb OR octet_length(j::text)>4096 OR j->'formatVersion' IS DISTINCT FROM '1'::jsonb THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['engineVersion','databaseCreatedAt','observedAt','observedBeforeAt','timeZone'] LOOP IF jsonb_typeof(j->k) IS DISTINCT FROM 'string' THEN RETURN false;END IF;END LOOP;
 IF length(j->>'engineVersion') NOT BETWEEN 5 AND 80 OR j->>'engineVersion'!~'^[0-9]+\.[0-9]+\.[0-9]+([-+_][A-Za-z0-9._+-]+)?$' OR j->>'engineVersion'~'[^A-Za-z0-9._+-]' THEN RETURN false;END IF;
 IF length(j->>'timeZone') NOT BETWEEN 1 AND 100 OR j->>'timeZone'~'^[+-]' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE lower(name)=lower(j->>'timeZone')) THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['databaseVersion','maximumAgeSeconds'] LOOP
  IF jsonb_typeof(j->k) IS DISTINCT FROM 'number' OR j->>k!~'^[1-9][0-9]{0,9}$' THEN RETURN false;END IF;
  n=(j->>k)::numeric;IF n>(CASE WHEN k='databaseVersion' THEN 4294967295 ELSE 604800 END) THEN RETURN false;END IF;
 END LOOP;
 IF j->>'databaseCreatedAt'!~'^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$' THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['observedAt','observedBeforeAt'] LOOP IF j->>k!~'^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' THEN RETURN false;END IF;END LOOP;
 d=(j->>'databaseCreatedAt')::timestamptz;b=(j->>'observedBeforeAt')::timestamptz;a=(j->>'observedAt')::timestamptz;
 RETURN d<=b AND b<=a AND a-b<=interval '10 minutes' AND extract(epoch FROM a-d)<=(j->>'maximumAgeSeconds')::numeric;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.valid_file_scanner_observation(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_file_scanner_observation(jsonb) TO kavosh_file_policy;

CREATE TABLE public.file_scanner_observations(
 academy_id uuid NOT NULL,inspection_id uuid NOT NULL,attempt_no integer NOT NULL,
 input_bytes bigint NOT NULL,input_sha256 text NOT NULL,result jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,inspection_id,attempt_no),
 FOREIGN KEY(academy_id,inspection_id,attempt_no,input_bytes,input_sha256)
  REFERENCES public.file_inspection_attempts(academy_id,inspection_id,attempt_no,measured_bytes,sha256),
 CHECK(public.valid_file_scanner_observation(result))
);
ALTER TABLE public.file_scanner_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_scanner_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.file_scanner_observations
 USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid)
 WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY file_policy_executor ON public.file_scanner_observations TO kavosh_file_policy USING(true) WITH CHECK(true);
GRANT SELECT ON public.file_scanner_observations TO kavosh_runtime;
GRANT SELECT,INSERT ON public.file_scanner_observations TO kavosh_file_policy;

ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb) RENAME TO finish_file_inspection_image_evidence;
REVOKE EXECUTE ON FUNCTION public.finish_file_inspection_image_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb) FROM kavosh_file_worker;
GRANT CREATE ON SCHEMA public TO kavosh_file_policy;
CREATE FUNCTION public.finish_file_inspection(p_academy uuid,p_inspection uuid,p_lease uuid,p_outcome text,p_reason text,p_bytes bigint,p_sha256 text,p_etag text,p_content_type text,p_signature jsonb,p_image jsonb DEFAULT NULL,p_database jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE recorded boolean;a public.file_inspection_attempts;file_id uuid;first_seen timestamptz;last_seen timestamptz;
BEGIN
 recorded:=public.finish_file_inspection_image_evidence(p_academy,p_inspection,p_lease,p_outcome,p_reason,p_bytes,p_sha256,p_etag,p_content_type,p_signature,p_image);
 IF recorded IS FALSE THEN RETURN false;END IF;
 IF recorded IS DISTINCT FROM true THEN RAISE EXCEPTION 'MISSING_FILE_INSPECTION_RECEIPT';END IF;
 IF p_database IS NULL THEN RETURN true;END IF;
 IF p_outcome IS DISTINCT FROM 'no_detection' OR NOT public.valid_file_scanner_observation(p_database) THEN RAISE EXCEPTION 'INVALID_FILE_SCANNER_OBSERVATION';END IF;
 SELECT x.* INTO STRICT a FROM public.file_inspection_attempts x JOIN public.file_inspection_jobs q
  ON q.academy_id=x.academy_id AND q.inspection_id=x.inspection_id AND q.attempt_no=x.attempt_no
  WHERE q.academy_id=p_academy AND q.inspection_id=p_inspection;
 first_seen=(p_database->>'observedBeforeAt')::timestamptz;last_seen=(p_database->>'observedAt')::timestamptz;
 IF a.outcome IS DISTINCT FROM 'no_detection' OR a.measured_bytes IS DISTINCT FROM p_bytes OR a.sha256 IS DISTINCT FROM p_sha256
  OR first_seen<a.started_at-interval '5 seconds' OR last_seen>a.finished_at+interval '5 seconds'
  OR last_seen<clock_timestamp()-interval '5 minutes' OR last_seen>clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'INVALID_FILE_SCANNER_OBSERVATION';END IF;
 INSERT INTO public.file_scanner_observations(academy_id,inspection_id,attempt_no,input_bytes,input_sha256,result)
 VALUES(p_academy,p_inspection,a.attempt_no,p_bytes,p_sha256,p_database);
 SELECT r.file_id INTO STRICT file_id FROM public.file_inspection_requests r WHERE r.academy_id=p_academy AND r.id=p_inspection;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id)
 VALUES(p_academy,gen_random_uuid(),'file.scanner.database.observed',file_id,p_inspection);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb) FROM PUBLIC;
ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb,jsonb,jsonb) TO kavosh_file_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_file_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 112 $$;

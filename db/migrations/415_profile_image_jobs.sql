-- Durable generation is separate from reviewed sharing authority. No worker
-- can publish,change consent,read arbitrary private rows or delete originals.
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_profile_image_worker') THEN CREATE ROLE kavosh_profile_image_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;END IF;END $$;
GRANT USAGE ON SCHEMA public TO kavosh_profile_image_worker;
GRANT EXECUTE ON FUNCTION public.schema_revision() TO kavosh_profile_image_worker;
CREATE TABLE public.profile_image_jobs(
 academy_id uuid NOT NULL,profile_id uuid NOT NULL,release_version integer NOT NULL,image_no integer NOT NULL CHECK(image_no BETWEEN 1 AND 100),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','retained','blocked')),available_at timestamptz NOT NULL DEFAULT clock_timestamp(),attempt_no integer NOT NULL DEFAULT 0 CHECK(attempt_no BETWEEN 0 AND 5),
 worker_id uuid,lease_token uuid,started_at timestamptz,lease_until timestamptz,last_outcome text,receipt jsonb,
 PRIMARY KEY(academy_id,profile_id,release_version,image_no),FOREIGN KEY(academy_id,profile_id,release_version) REFERENCES public.profile_image_releases(academy_id,profile_id,version),
 CHECK((state='running')=(worker_id IS NOT NULL AND lease_token IS NOT NULL AND started_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until>started_at)),
 CHECK(state='running' OR(worker_id IS NULL AND lease_token IS NULL AND started_at IS NULL AND lease_until IS NULL)),CHECK((state='retained')=(receipt IS NOT NULL))
);
CREATE INDEX profile_image_jobs_ready ON public.profile_image_jobs(available_at,academy_id,profile_id,release_version,image_no) WHERE state IN('queued','running');
CREATE TABLE public.profile_image_job_attempts(
 academy_id uuid NOT NULL,profile_id uuid NOT NULL,release_version integer NOT NULL,image_no integer NOT NULL,attempt_no integer NOT NULL CHECK(attempt_no BETWEEN 1 AND 5),
 worker_id uuid NOT NULL,lease_token uuid NOT NULL,started_at timestamptz NOT NULL,finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome text NOT NULL CHECK(outcome IN('retained','unavailable','rejected','stored_bytes_mismatch','outcome_unknown','source_changed','lease_expired')),receipt jsonb,
 PRIMARY KEY(academy_id,profile_id,release_version,image_no,attempt_no),FOREIGN KEY(academy_id,profile_id,release_version,image_no) REFERENCES public.profile_image_jobs(academy_id,profile_id,release_version,image_no),CHECK(finished_at>=started_at),CHECK((outcome='retained')=(receipt IS NOT NULL))
);
CREATE TRIGGER profile_image_attempt_immutable BEFORE UPDATE OR DELETE ON public.profile_image_job_attempts FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['profile_image_jobs','profile_image_job_attempts'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY image_job_policy ON public.%I TO kavosh_signature_evidence_policy USING(true) WITH CHECK(true)',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate()',t);
END LOOP;END $$;
GRANT SELECT,INSERT,UPDATE ON public.profile_image_jobs TO kavosh_signature_evidence_policy;
GRANT SELECT,INSERT ON public.profile_image_job_attempts TO kavosh_signature_evidence_policy;
GRANT SELECT ON public.profile_image_releases,public.achievement_asset_revisions TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,id,version,archived,domain,anchor_kind,person_id,hub_id,claimed_mime_type) ON public.file_records,public.file_catalogue TO kavosh_signature_evidence_policy;
GRANT EXECUTE ON FUNCTION public.profile_image_source(uuid,text,jsonb),public.profile_image_selection_valid(jsonb),public.profile_publication_basis(uuid),public.profile_publication_basis(uuid,text),public.achievement_asset_release_binding(uuid),public.achievement_asset_source(uuid,integer,jsonb),public.achievement_assets_valid(jsonb),public.file_download_source(uuid,integer,uuid) TO kavosh_signature_evidence_policy;
GRANT EXECUTE ON FUNCTION public.community_profile_owner(text,uuid,boolean),public.profile_moderation_state(uuid) TO kavosh_signature_evidence_policy;

CREATE FUNCTION public.profile_image_job_source(p_academy uuid,p_profile uuid,p_version integer,p_image integer) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record;s jsonb;x jsonb;f jsonb;BEGIN
 IF p_academy IS NULL OR p_profile IS NULL OR p_version IS NULL OR p_image IS NULL OR p_image NOT BETWEEN 1 AND 100 THEN RETURN NULL;END IF;
 PERFORM set_config('app.academy_id',p_academy::text,true);
 SELECT * INTO r FROM public.profile_image_releases WHERE academy_id=p_academy AND profile_id=p_profile ORDER BY version DESC LIMIT 1;
 IF r.version IS DISTINCT FROM p_version OR r.state<>'published' OR NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=p_academy AND a.id=r.approval_id AND a.status='applied' AND a.action='profile-images.publish' AND a.target_id=p_profile AND a.target_version=p_version-1 AND a.reviewer_id=r.changed_by) THEN RETURN NULL;END IF;
 s=public.profile_image_source(p_profile,r.state,r.selection);IF s IS NULL OR s IS DISTINCT FROM r.source THEN RETURN NULL;END IF;
 x=(s->'images')->(p_image-1);IF x IS NULL THEN RETURN NULL;END IF;f=x->'file';
 RETURN jsonb_build_object('academyId',p_academy,'profileId',p_profile,'profileVersion',s#>'{profile,profileVersion}','releaseVersion',p_version,'releaseFingerprint',encode(sha256(convert_to(s::text,'UTF8')),'hex'),'imageNo',p_image,'purpose',x#>'{choice,kind}','fileId',f->'fileId','fileVersion',f->'fileVersion','copyId',f->'copyId','destinationTargetId',f->'destinationTargetId','destinationEtag',f->'destinationEtag','bytes',f->'bytes','sha256',f->'sha256','mime',f->'mime');
END $$;
CREATE FUNCTION public.enqueue_profile_image_jobs() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME<>'profile_image_releases' THEN RAISE EXCEPTION 'PROFILE_IMAGE_QUEUE_SCOPE_INVALID';END IF;
 IF NEW.state='published' THEN INSERT INTO public.profile_image_jobs(academy_id,profile_id,release_version,image_no) SELECT NEW.academy_id,NEW.profile_id,NEW.version,n FROM generate_series(1,jsonb_array_length(NEW.selection)) n;END IF;RETURN NEW;
END $$;
CREATE TRIGGER profile_image_enqueue AFTER INSERT ON public.profile_image_releases FOR EACH ROW EXECUTE FUNCTION public.enqueue_profile_image_jobs();
-- Preserve old approvals and enqueue only their exact current selection. No
-- provider IO,worker activation,permission backfill or history rewrite.
INSERT INTO public.profile_image_jobs(academy_id,profile_id,release_version,image_no)
SELECT r.academy_id,r.profile_id,r.version,n FROM public.profile_image_releases r CROSS JOIN LATERAL generate_series(1,jsonb_array_length(r.selection)) n WHERE r.state='published' AND NOT EXISTS(SELECT 1 FROM public.profile_image_releases later WHERE later.academy_id=r.academy_id AND later.profile_id=r.profile_id AND later.version>r.version);

CREATE FUNCTION public.claim_profile_image_job(p_academies uuid[],p_worker uuid,p_seconds integer) RETURNS TABLE(source jsonb,lease_token uuid,attempt_no integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q public.profile_image_jobs;s jsonb;token uuid;BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'PROFILE_IMAGE_READ_COMMITTED_REQUIRED' USING ERRCODE='25000';END IF;
 IF p_academies IS NULL OR cardinality(p_academies) NOT BETWEEN 1 AND 1000 OR array_position(p_academies,NULL) IS NOT NULL OR p_worker IS NULL OR p_seconds IS NULL OR p_seconds NOT BETWEEN 60 AND 600 THEN RAISE EXCEPTION 'INVALID_PROFILE_IMAGE_CLAIM' USING ERRCODE='22023';END IF;
 FOR q IN SELECT j.* FROM public.profile_image_jobs j WHERE j.academy_id=ANY(p_academies) AND((j.state='queued' AND j.available_at<=clock_timestamp()) OR(j.state='running' AND j.lease_until<=clock_timestamp())) ORDER BY j.available_at,j.academy_id,j.profile_id,j.release_version,j.image_no LIMIT 8 FOR UPDATE SKIP LOCKED LOOP
  IF q.state='running' THEN INSERT INTO public.profile_image_job_attempts(academy_id,profile_id,release_version,image_no,attempt_no,worker_id,lease_token,started_at,outcome) VALUES(q.academy_id,q.profile_id,q.release_version,q.image_no,q.attempt_no,q.worker_id,q.lease_token,q.started_at,'lease_expired');END IF;
  s=public.profile_image_job_source(q.academy_id,q.profile_id,q.release_version,q.image_no);
  IF s IS NULL OR q.attempt_no>=5 THEN UPDATE public.profile_image_jobs j SET state='blocked',worker_id=NULL,lease_token=NULL,started_at=NULL,lease_until=NULL,last_outcome=CASE WHEN s IS NULL THEN 'source_changed' ELSE 'lease_expired' END WHERE(j.academy_id,j.profile_id,j.release_version,j.image_no)=(q.academy_id,q.profile_id,q.release_version,q.image_no);CONTINUE;END IF;
  token=gen_random_uuid();UPDATE public.profile_image_jobs j SET state='running',attempt_no=q.attempt_no+1,worker_id=p_worker,lease_token=token,started_at=clock_timestamp(),lease_until=clock_timestamp()+p_seconds*interval '1 second' WHERE(j.academy_id,j.profile_id,j.release_version,j.image_no)=(q.academy_id,q.profile_id,q.release_version,q.image_no);
  RETURN QUERY SELECT s,token,q.attempt_no+1;RETURN;
 END LOOP;
END $$;
CREATE FUNCTION public.profile_image_object_id(s jsonb,p_sha text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE h text;BEGIN
 h=encode(sha256(convert_to(replace(jsonb_build_array('kavosh-profile-image-v1',s->>'academyId',s->>'profileId',(s->>'releaseVersion')::integer,s->>'releaseFingerprint',(s->>'imageNo')::integer,s->>'purpose',s->>'fileId',(s->>'fileVersion')::integer,s->>'copyId',s->>'sha256',p_sha)::text,', ',','),'UTF8')),'hex');
 h=overlay(h placing '8' from 13 for 1);h=overlay(h placing substr('89ab',(strpos('0123456789abcdef',substr(h,17,1))-1)%4+1,1) from 17 for 1);RETURN substr(h,1,32)::uuid;
END $$;
CREATE FUNCTION public.profile_image_receipt_valid(s jsonb,r jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE cap integer;BEGIN
 IF s IS NULL OR jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT(r?&ARRAY['objectId','storageTargetId','etag','bytes','sha256','mime','width','height','purpose','releaseVersion','releaseFingerprint','imageNo','bytesReadBackVerified','published','originalModified']) OR r-ARRAY['objectId','storageTargetId','etag','bytes','sha256','mime','width','height','purpose','releaseVersion','releaseFingerprint','imageNo','bytesReadBackVerified','published','originalModified']<>'{}'::jsonb OR octet_length(r::text)>4096 THEN RETURN false;END IF;
 IF r->'bytesReadBackVerified' IS DISTINCT FROM 'true'::jsonb OR r->'published' IS DISTINCT FROM 'false'::jsonb OR r->'originalModified' IS DISTINCT FROM 'false'::jsonb OR r->>'mime' IS DISTINCT FROM 'image/webp' OR r->'purpose' IS DISTINCT FROM s->'purpose' OR r->'releaseVersion' IS DISTINCT FROM s->'releaseVersion' OR r->'releaseFingerprint' IS DISTINCT FROM s->'releaseFingerprint' OR r->'imageNo' IS DISTINCT FROM s->'imageNo' THEN RETURN false;END IF;
 IF r->>'sha256'!~'^[a-f0-9]{64}$' OR r->>'storageTargetId'!~'^[a-f0-9]{64}$' OR r->>'etag'!~'^"[!#-~]{1,200}"$' OR jsonb_typeof(r->'sha256') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'storageTargetId') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'etag') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
 IF jsonb_typeof(r->'bytes') IS DISTINCT FROM 'number' OR r->>'bytes'!~'^[1-9][0-9]{0,6}$' OR jsonb_typeof(r->'width') IS DISTINCT FROM 'number' OR r->>'width'!~'^[1-9][0-9]{0,3}$' OR jsonb_typeof(r->'height') IS DISTINCT FROM 'number' OR r->>'height'!~'^[1-9][0-9]{0,3}$' THEN RETURN false;END IF;
 cap=CASE WHEN s->>'purpose'='avatar' THEN 512 ELSE 2048 END;
 RETURN(r->>'width')::integer<=cap AND(r->>'height')::integer<=cap AND(r->>'bytes')::integer<=CASE WHEN cap=512 THEN 1048576 ELSE 4194304 END AND jsonb_typeof(r->'objectId')='string' AND(r->>'objectId')::uuid::text=r->>'objectId' AND(r->>'objectId')::uuid=public.profile_image_object_id(s,r->>'sha256') AND r->>'objectId'<>s->>'fileId';
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.finish_profile_image_job(p_academy uuid,p_profile uuid,p_version integer,p_image integer,p_token uuid,p_result jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q public.profile_image_jobs;s jsonb;kind text;r jsonb;BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'PROFILE_IMAGE_READ_COMMITTED_REQUIRED' USING ERRCODE='25000';END IF;
 IF p_academy IS NULL OR p_profile IS NULL OR p_version IS NULL OR p_image IS NULL OR p_token IS NULL OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR octet_length(p_result::text)>8192 OR p_result-ARRAY['outcome','receipt']<>'{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PROFILE_IMAGE_RESULT' USING ERRCODE='22023';END IF;
 kind=p_result->>'outcome';IF kind IS NULL OR kind NOT IN('retained','unavailable','rejected','stored_bytes_mismatch','outcome_unknown') OR(kind='retained') IS DISTINCT FROM(p_result?'receipt') THEN RAISE EXCEPTION 'INVALID_PROFILE_IMAGE_RESULT' USING ERRCODE='22023';END IF;
 SELECT * INTO q FROM public.profile_image_jobs j WHERE(j.academy_id,j.profile_id,j.release_version,j.image_no)=(p_academy,p_profile,p_version,p_image) FOR UPDATE;
 IF q.state IS DISTINCT FROM 'running' OR q.lease_token IS DISTINCT FROM p_token OR q.lease_until<=clock_timestamp() THEN RETURN false;END IF;
 s=public.profile_image_job_source(p_academy,p_profile,p_version,p_image);r=p_result->'receipt';
 IF s IS NULL THEN kind='source_changed';r=NULL;ELSIF kind='retained' AND NOT public.profile_image_receipt_valid(s,r) THEN RAISE EXCEPTION 'INVALID_PROFILE_IMAGE_RECEIPT' USING ERRCODE='22023';END IF;
 INSERT INTO public.profile_image_job_attempts(academy_id,profile_id,release_version,image_no,attempt_no,worker_id,lease_token,started_at,outcome,receipt) VALUES(p_academy,p_profile,p_version,p_image,q.attempt_no,q.worker_id,q.lease_token,q.started_at,kind,r);
 UPDATE public.profile_image_jobs j SET state=CASE WHEN kind='retained' THEN 'retained' WHEN kind IN('rejected','stored_bytes_mismatch','source_changed') OR q.attempt_no>=5 THEN 'blocked' ELSE 'queued' END,available_at=clock_timestamp()+q.attempt_no*interval '1 minute',worker_id=NULL,lease_token=NULL,started_at=NULL,lease_until=NULL,last_outcome=kind,receipt=r WHERE(j.academy_id,j.profile_id,j.release_version,j.image_no)=(p_academy,p_profile,p_version,p_image);RETURN true;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.enqueue_profile_image_jobs() OWNER TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.claim_profile_image_job(uuid[],uuid,integer) OWNER TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.finish_profile_image_job(uuid,uuid,integer,integer,uuid,jsonb) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.profile_image_job_source(uuid,uuid,integer,integer),public.enqueue_profile_image_jobs(),public.claim_profile_image_job(uuid[],uuid,integer),public.profile_image_object_id(jsonb,text),public.profile_image_receipt_valid(jsonb,jsonb),public.finish_profile_image_job(uuid,uuid,integer,integer,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_image_job_source(uuid,uuid,integer,integer),public.profile_image_object_id(jsonb,text),public.profile_image_receipt_valid(jsonb,jsonb) TO kavosh_signature_evidence_policy;
GRANT EXECUTE ON FUNCTION public.claim_profile_image_job(uuid[],uuid,integer),public.finish_profile_image_job(uuid,uuid,integer,integer,uuid,jsonb) TO kavosh_profile_image_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 415 $$;

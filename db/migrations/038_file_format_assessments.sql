-- Persist a reproducible format screen, not structural validation or malware
-- clearance. Old attempts remain unassessed; never invent historical decisions.
CREATE TABLE public.file_format_assessments(
 academy_id uuid NOT NULL,inspection_id uuid NOT NULL,attempt_no integer NOT NULL,
 rule_version integer NOT NULL CHECK(rule_version=1),state text NOT NULL CHECK(state IN ('matched','rejected','unassessed')),
 reason_code text NOT NULL,assessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,inspection_id,attempt_no),
 FOREIGN KEY(academy_id,inspection_id,attempt_no) REFERENCES public.file_inspection_attempts(academy_id,inspection_id,attempt_no),
 CHECK((state='matched' AND reason_code='SIGNATURE_CLAIM_MATCH')
  OR(state='rejected' AND reason_code IN ('MALWARE_DETECTED','CLAIM_NOT_ALLOWED','SIGNATURE_NOT_ALLOWED','SIGNATURE_CLAIM_MISMATCH'))
  OR(state='unassessed' AND reason_code IN ('INSPECTION_NOT_USABLE','CLAIM_UNAVAILABLE','SIGNATURE_MISSING','INSUFFICIENT_SIGNATURE_SAMPLE','SIGNATURE_UNKNOWN','POLICY_UNRECORDED','POLICY_INVALID')))
);
ALTER TABLE public.file_format_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_format_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.file_format_assessments
 USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid)
 WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
CREATE POLICY file_policy_executor ON public.file_format_assessments TO kavosh_file_policy USING(true) WITH CHECK(true);
CREATE POLICY file_policy_executor ON public.file_upload_grants FOR SELECT TO kavosh_file_policy USING(true);
GRANT SELECT ON public.file_format_assessments TO kavosh_runtime;
GRANT SELECT,INSERT ON public.file_format_assessments TO kavosh_file_policy;
GRANT SELECT ON public.file_upload_grants,public.file_content_signatures TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.valid_upload_mime_list(text[]) TO kavosh_file_policy;

ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) RENAME TO finish_file_inspection_signature_evidence;
REVOKE EXECUTE ON FUNCTION public.finish_file_inspection_signature_evidence(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) FROM kavosh_file_worker;
GRANT CREATE ON SCHEMA public TO kavosh_file_policy;
CREATE FUNCTION public.finish_file_inspection(p_academy uuid,p_inspection uuid,p_lease uuid,p_outcome text,p_reason text,p_bytes bigint,p_sha256 text,p_etag text,p_content_type text,p_signature jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE recorded boolean; request public.file_inspection_requests; g public.file_upload_grants;
 s public.file_content_signatures; attempt integer; claimed text; allowed text[];
 result_state text:='unassessed'; result_reason text:='INSPECTION_NOT_USABLE';
BEGIN
 recorded:=public.finish_file_inspection_signature_evidence(p_academy,p_inspection,p_lease,p_outcome,p_reason,p_bytes,p_sha256,p_etag,p_content_type,p_signature);
 IF recorded IS FALSE THEN RETURN false; END IF;
 IF recorded IS DISTINCT FROM true THEN RAISE EXCEPTION 'MISSING_FILE_INSPECTION_RECEIPT'; END IF;
 SELECT q.attempt_no INTO STRICT attempt FROM public.file_inspection_jobs q WHERE q.academy_id=p_academy AND q.inspection_id=p_inspection;
 SELECT r.* INTO STRICT request FROM public.file_inspection_requests r WHERE r.academy_id=p_academy AND r.id=p_inspection;
 SELECT grant_record.* INTO STRICT g FROM public.file_upload_grants grant_record WHERE grant_record.academy_id=p_academy AND grant_record.id=request.grant_id;
 SELECT revision.definition->>'claimed_mime_type' INTO STRICT claimed FROM public.file_record_revisions revision
  WHERE revision.academy_id=p_academy AND revision.file_id=request.file_id AND revision.version=request.metadata_version;
 SELECT signature.* INTO s FROM public.file_content_signatures signature WHERE signature.academy_id=p_academy AND signature.inspection_id=p_inspection AND signature.attempt_no=attempt;
 IF p_outcome='detected' THEN result_state:='rejected';result_reason:='MALWARE_DETECTED';
 ELSIF p_outcome='no_detection' THEN
  IF claimed IS NULL OR claimed !~ '^[a-z0-9][a-z0-9.+-]{0,99}/[a-z0-9][a-z0-9.+-]{0,99}$' THEN result_reason:='CLAIM_UNAVAILABLE';
  ELSIF s.inspection_id IS NULL THEN result_reason:='SIGNATURE_MISSING';
  ELSIF s.sample_bytes<>least(p_bytes,16384) THEN result_reason:='INSUFFICIENT_SIGNATURE_SAMPLE';
  ELSIF s.mime IS NULL THEN result_reason:='SIGNATURE_UNKNOWN';
  ELSIF g.format_policy_version IS NULL OR g.format_policy_snapshot IS NULL THEN result_reason:='POLICY_UNRECORDED';
  ELSIF g.format_policy_snapshot->'snapshotVersion' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(g.format_policy_snapshot->'allowedMimeTypes') IS DISTINCT FROM 'array' THEN result_reason:='POLICY_INVALID';
  ELSE
   allowed:=ARRAY(SELECT jsonb_array_elements_text(g.format_policy_snapshot->'allowedMimeTypes'));
   IF NOT public.valid_upload_mime_list(allowed) THEN result_reason:='POLICY_INVALID';
   ELSIF NOT(claimed=ANY(allowed)) THEN result_state:='rejected';result_reason:='CLAIM_NOT_ALLOWED';
   ELSIF NOT(s.mime=ANY(allowed)) THEN result_state:='rejected';result_reason:='SIGNATURE_NOT_ALLOWED';
   ELSIF s.mime<>claimed THEN result_state:='rejected';result_reason:='SIGNATURE_CLAIM_MISMATCH';
   ELSE result_state:='matched';result_reason:='SIGNATURE_CLAIM_MATCH';END IF;
  END IF;
 END IF;
 INSERT INTO public.file_format_assessments(academy_id,inspection_id,attempt_no,rule_version,state,reason_code)
 VALUES(p_academy,p_inspection,attempt,1,result_state,result_reason);
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id)
 VALUES(p_academy,gen_random_uuid(),CASE result_state WHEN 'rejected' THEN 'file.format.rejected.critical' WHEN 'matched' THEN 'file.format.screened' ELSE 'file.format.validation.required' END,request.file_id,p_inspection);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) FROM PUBLIC;
ALTER FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) OWNER TO kavosh_file_policy;
GRANT EXECUTE ON FUNCTION public.finish_file_inspection(uuid,uuid,uuid,text,text,bigint,text,text,text,jsonb) TO kavosh_file_worker;
REVOKE CREATE ON SCHEMA public FROM kavosh_file_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 38 $$;

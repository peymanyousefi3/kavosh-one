-- Private operational metadata only. Web receives no provider object,receipt,
-- worker identity,token or source. Its existing exact profile/file rights still
-- gate the API;this fixed function cannot cross the transaction's tenant.
CREATE FUNCTION public.profile_image_processing(p_profile uuid,p_version integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('jobs',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'number',j.image_no,'state',j.state,'attempts',j.attempt_no,'lastOutcome',j.last_outcome,
  'leaseExpired',j.state='running' AND j.lease_until<=statement_timestamp(),
  'retryDue',j.state='queued' AND j.available_at<=statement_timestamp()) ORDER BY j.image_no)
 FROM public.profile_image_jobs j WHERE j.academy_id=r.academy_id AND j.profile_id=r.profile_id AND j.release_version=r.version),'[]'::jsonb))
 FROM public.profile_image_releases r WHERE r.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND r.profile_id=p_profile AND r.version=p_version
$$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.profile_image_processing(uuid,integer) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.profile_image_processing(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_image_processing(uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 417 $$;

-- A sender must verify its isolated result sink addresses the same committed
-- original-bound start,not merely a healthy but unrelated database.
GRANT SELECT(original_source_fingerprint) ON public.signature_dispatch_starts TO kavosh_signature_result_policy;
GRANT CREATE ON SCHEMA public TO kavosh_signature_result_policy;
CREATE FUNCTION public.signature_transport_target_ready(p_academy uuid,p_start uuid,p_fingerprint text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.signature_dispatch_starts WHERE academy_id=p_academy AND id=p_start
  AND original_copy_id IS NOT NULL AND original_source_fingerprint=p_fingerprint)
$$;
ALTER FUNCTION public.signature_transport_target_ready(uuid,uuid,text) OWNER TO kavosh_signature_result_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_result_policy;
REVOKE ALL ON FUNCTION public.signature_transport_target_ready(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_transport_target_ready(uuid,uuid,text) TO kavosh_signature_result_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 123 $$;

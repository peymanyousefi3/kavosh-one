INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('work-signature-completions.view','View private worker signing evidence metadata','Finance',true,ARRAY['hub','person','country','region','city']);
-- Metadata only. No original source,signer provider identity,archive manifest,
-- storage account,artifact hash,ETag or worker-login identity for web runtime.
GRANT SELECT(academy_id,id,start_id,state,review_reasons,recorded_at) ON public.work_signature_completion_evidence TO kavosh_runtime;
CREATE INDEX work_completion_chronological ON public.work_signature_completion_evidence(academy_id,start_id,recorded_at DESC,id DESC);
CREATE FUNCTION public.work_signature_completion_source_current(p_evidence uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;e record;s jsonb;BEGIN
 SELECT start_id,source_fingerprint INTO e FROM public.work_signature_completion_evidence WHERE academy_id=tenant AND id=p_evidence;
 IF NOT FOUND THEN RETURN NULL;END IF;s=public.work_signature_completion_source(tenant,e.start_id);
 RETURN coalesce(s->>'sourceFingerprint'=e.source_fingerprint,false);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_completion_policy;
ALTER FUNCTION public.work_signature_completion_source_current(uuid) OWNER TO kavosh_signature_completion_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.work_signature_completion_source_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_completion_source_current(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 226 $$;

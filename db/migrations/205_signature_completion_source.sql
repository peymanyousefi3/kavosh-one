-- Reconciliation reads historical authority,not today's mutable contacts or
-- expired send window. Only an original-bound start plus an uncontradicted
-- isolated transport receipt identifies a provider document for this worker.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_signature_completion_worker') THEN CREATE ROLE kavosh_signature_completion_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='kavosh_signature_completion_policy') THEN CREATE ROLE kavosh_signature_completion_policy NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
END $$;
GRANT kavosh_signature_completion_policy TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO kavosh_signature_completion_worker,kavosh_signature_completion_policy;
CREATE FUNCTION identity.signature_signer_recorded(p_academy uuid,p_start uuid,p_request uuid,p_package uuid,p_signer uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM identity.signature_signer_history WHERE academy_id=p_academy AND start_id=p_start AND request_id=p_request AND package_id=p_package AND signer_id=p_signer)
$$;
GRANT CREATE ON SCHEMA identity TO kavosh_identity_policy;
ALTER FUNCTION identity.signature_signer_recorded(uuid,uuid,uuid,uuid,uuid) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA identity FROM kavosh_identity_policy;
REVOKE ALL ON FUNCTION identity.signature_signer_recorded(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO kavosh_signature_completion_policy;
GRANT EXECUTE ON FUNCTION identity.signature_signer_recorded(uuid,uuid,uuid,uuid,uuid) TO kavosh_signature_completion_policy;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['signature_dispatch_starts','signature_send_attempts','signature_send_requests','agreement_package_contents','agreement_content_bindings','agreement_packages','signature_transport_receipts','signature_transport_conflicts','signature_dispatch_outcomes'] LOOP
 EXECUTE format('CREATE POLICY signature_completion_source_read ON public.%I FOR SELECT TO kavosh_signature_completion_policy USING(true)',t);
END LOOP;END $$;
GRANT SELECT(academy_id,id,attempt_id,original_copy_id,original_source,original_source_fingerprint) ON public.signature_dispatch_starts TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,request_id,document_sha256) ON public.signature_send_attempts TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,package_id,attachment_id,context) ON public.signature_send_requests TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,package_id,binding_id) ON public.agreement_package_contents TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,source,routing) ON public.agreement_content_bindings TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,signer_id) ON public.agreement_packages TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,start_id,state,document_id) ON public.signature_transport_receipts TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,start_id) ON public.signature_transport_conflicts TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,start_id,state,document_id) ON public.signature_dispatch_outcomes TO kavosh_signature_completion_policy;
CREATE FUNCTION public.signature_completion_source(p_academy uuid,p_start uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH selected AS(
 SELECT jsonb_build_object('academyId',s.academy_id,'startId',s.id,'signerId',p.signer_id,'documentId',t.document_id,
 'packageId',p.id,'attachmentId',l.id,'bindingId',b.id,'documentSha256',a.document_sha256,'region',b.source#>>'{provider,region}',
 'signatureFields',(SELECT jsonb_agg(jsonb_build_object('id',f->>'id','pageNumber',f->'pageNumber','bounds',f->'bounds') ORDER BY f->>'id') FROM jsonb_array_elements(b.routing->'fields') f WHERE lower(f->>'fieldType')='signature')) source
 FROM public.signature_dispatch_starts s
 JOIN public.signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id
 JOIN public.signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id
 JOIN public.agreement_package_contents l ON l.academy_id=r.academy_id AND l.id=r.attachment_id AND l.package_id=r.package_id
 JOIN public.agreement_content_bindings b ON b.academy_id=l.academy_id AND b.id=l.binding_id
 JOIN public.agreement_packages p ON p.academy_id=r.academy_id AND p.id=r.package_id
 JOIN public.signature_transport_receipts t ON t.academy_id=s.academy_id AND t.start_id=s.id AND t.state='accepted_for_processing' AND t.document_id IS NOT NULL
 WHERE s.academy_id=p_academy AND s.id=p_start AND s.original_copy_id IS NOT NULL AND s.original_source IS NOT NULL AND s.original_source_fingerprint IS NOT NULL
 AND s.original_source->>'sha256'=a.document_sha256 AND b.source->>'sha256'=a.document_sha256
 AND b.source=r.context#>'{source,packageContent,content,source}' AND b.routing=r.context#>'{source,packageContent,content,routing}'
 AND identity.signature_signer_recorded(s.academy_id,s.id,r.id,p.id,p.signer_id)
 AND NOT EXISTS(SELECT 1 FROM public.signature_transport_conflicts c WHERE c.academy_id=s.academy_id AND c.start_id=s.id)
 AND NOT EXISTS(SELECT 1 FROM public.signature_dispatch_outcomes o WHERE o.academy_id=s.academy_id AND o.start_id=s.id AND(o.state IS DISTINCT FROM t.state OR o.document_id IS DISTINCT FROM t.document_id))
 ) SELECT source||jsonb_build_object('sourceFingerprint',encode(sha256(convert_to(source::text,'UTF8')),'hex')) FROM selected
$$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_completion_policy;
ALTER FUNCTION public.signature_completion_source(uuid,uuid) OWNER TO kavosh_signature_completion_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.signature_completion_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_completion_source(uuid,uuid) TO kavosh_signature_completion_worker,kavosh_identity_policy;
-- No raw identity access or arbitrary historical comparison for the service.
-- Exact source fingerprint also prevents replay after a transport conflict.
CREATE FUNCTION public.signature_completion_signer_matches(p_academy uuid,p_start uuid,p_fingerprint text,p_name text,p_email text,p_phone text)
RETURNS TABLE(name_matches boolean,email_matches boolean,phone_matches boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE s jsonb;BEGIN
 s=public.signature_completion_source(p_academy,p_start);
 IF s IS NULL OR p_fingerprint IS NULL OR s->>'sourceFingerprint' IS DISTINCT FROM p_fingerprint THEN RETURN;END IF;
 RETURN QUERY SELECT * FROM identity.signature_signer_matches(p_academy,p_start,(s->>'signerId')::uuid,p_name,p_email,p_phone);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_identity_policy;
ALTER FUNCTION public.signature_completion_signer_matches(uuid,uuid,text,text,text,text) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_identity_policy;
REVOKE ALL ON FUNCTION public.signature_completion_signer_matches(uuid,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_completion_signer_matches(uuid,uuid,text,text,text,text),public.schema_revision() TO kavosh_signature_completion_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 205 $$;

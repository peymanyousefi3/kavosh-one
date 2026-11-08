-- Historical two-party authority only. No current contact lookup,provider IO,
-- signing assertion,admission/payment clearance or inferred evidence rows.
CREATE FUNCTION identity.work_signature_signers_recorded(p_academy uuid,p_start uuid,p_request uuid,p_worker uuid,p_representative uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p_worker<>p_representative AND count(*)=2 AND count(*) FILTER(WHERE party_role='worker' AND signer_id=p_worker)=1
 AND count(*) FILTER(WHERE party_role='academy_representative' AND signer_id=p_representative)=1
 FROM identity.work_signature_signer_history WHERE academy_id=p_academy AND start_id=p_start AND request_id=p_request
$$;
GRANT CREATE ON SCHEMA identity TO kavosh_identity_policy;
ALTER FUNCTION identity.work_signature_signers_recorded(uuid,uuid,uuid,uuid,uuid) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA identity FROM kavosh_identity_policy;
REVOKE ALL ON FUNCTION identity.work_signature_signers_recorded(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.work_signature_signers_recorded(uuid,uuid,uuid,uuid,uuid) TO kavosh_signature_completion_policy;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['work_signature_dispatch_starts','work_signature_send_attempts','work_signature_send_requests','work_agreement_contents','work_agreement_preparations','work_signature_transport_receipts','work_signature_transport_conflicts','work_signature_dispatch_outcomes'] LOOP
 EXECUTE format('CREATE POLICY work_completion_source_read ON public.%I FOR SELECT TO kavosh_signature_completion_policy USING(true)',t);
END LOOP;END $$;
GRANT SELECT(academy_id,id,attempt_id,original_copy_id,original_source,original_source_fingerprint) ON public.work_signature_dispatch_starts TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,request_id,document_sha256) ON public.work_signature_send_attempts TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,preparation_id,binding_id,context) ON public.work_signature_send_requests TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,preparation_id,source_snapshot) ON public.work_agreement_contents TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,id,worker_id,academy_signer_id,source_snapshot) ON public.work_agreement_preparations TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,start_id,state,document_id) ON public.work_signature_transport_receipts TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,start_id) ON public.work_signature_transport_conflicts TO kavosh_signature_completion_policy;
GRANT SELECT(academy_id,start_id,state,document_id) ON public.work_signature_dispatch_outcomes TO kavosh_signature_completion_policy;
CREATE FUNCTION public.work_signature_completion_source(p_academy uuid,p_start uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH selected AS(
 SELECT jsonb_build_object('purpose','worker_services','academyId',s.academy_id,'startId',s.id,'requestId',r.id,'preparationId',w.id,'bindingId',b.id,
 'documentId',t.document_id,'documentSha256',a.document_sha256,'connectionId',w.source_snapshot#>>'{connection,id}',
 'connectionTargetId',encode(sha256(convert_to(format('[1,%s,%s,%s,%s,%s]',to_json(w.source_snapshot#>>'{connection,id}'),to_json(s.academy_id::text),to_json(w.source_snapshot#>>'{connection,region}'),to_json(w.source_snapshot#>>'{connection,environment}'),coalesce(to_json(w.source_snapshot#>>'{connection,clientId}')::text,'null')),'UTF8')),'hex'),
 'region',w.source_snapshot#>>'{connection,region}','originalSourceFingerprint',s.original_source_fingerprint,
 'parties',(SELECT jsonb_agg(jsonb_build_object('role',party->>'role','signerId',CASE WHEN party->>'role'='worker' THEN w.worker_id ELSE w.academy_signer_id END,
 'signatureFields',(SELECT jsonb_agg(jsonb_build_object('id',f->>'id','pageNumber',f->'pageNumber','bounds',f->'bounds') ORDER BY f->>'id') FROM jsonb_array_elements(party->'fields') f WHERE lower(f->>'fieldType')='signature')) ORDER BY party->>'role') FROM jsonb_array_elements(b.source_snapshot#>'{routing,parties}') party)) source
 FROM public.work_signature_dispatch_starts s
 JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id
 JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id
 JOIN public.work_agreement_contents b ON b.academy_id=r.academy_id AND b.id=r.binding_id AND b.preparation_id=r.preparation_id
 JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id
 JOIN public.work_signature_transport_receipts t ON t.academy_id=s.academy_id AND t.start_id=s.id AND t.state='accepted_for_processing' AND t.document_id IS NOT NULL
 WHERE s.academy_id=p_academy AND s.id=p_start
 AND s.original_source->>'sha256'=a.document_sha256 AND b.source_snapshot#>>'{document,sha256}'=a.document_sha256
 AND s.original_source->'bytes'=b.source_snapshot#>'{document,sizeBytes}'
 AND b.source_snapshot=r.context#>'{source,content,content}' AND w.source_snapshot=b.source_snapshot->'framework'
 AND identity.work_signature_signers_recorded(s.academy_id,s.id,r.id,w.worker_id,w.academy_signer_id)
 AND NOT EXISTS(SELECT 1 FROM public.work_signature_transport_conflicts c WHERE c.academy_id=s.academy_id AND c.start_id=s.id)
 AND NOT EXISTS(SELECT 1 FROM public.work_signature_dispatch_outcomes o WHERE o.academy_id=s.academy_id AND o.start_id=s.id AND(o.state IS DISTINCT FROM t.state OR o.document_id IS DISTINCT FROM t.document_id))
 ) SELECT source||jsonb_build_object('sourceFingerprint',encode(sha256(convert_to(source::text,'UTF8')),'hex')) FROM selected
$$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_completion_policy;
ALTER FUNCTION public.work_signature_completion_source(uuid,uuid) OWNER TO kavosh_signature_completion_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.work_signature_completion_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_completion_source(uuid,uuid) TO kavosh_signature_completion_worker,kavosh_identity_policy;
-- Role and person are chosen from original source,not caller-supplied IDs.
CREATE FUNCTION public.work_signature_completion_signer_matches(p_academy uuid,p_start uuid,p_fingerprint text,p_role text,p_name text,p_email text,p_phone text)
RETURNS TABLE(name_matches boolean,email_matches boolean,phone_matches boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE s jsonb;signer uuid;BEGIN
 s=public.work_signature_completion_source(p_academy,p_start);
 IF s IS NULL OR p_fingerprint IS NULL OR s->>'sourceFingerprint' IS DISTINCT FROM p_fingerprint OR p_role IS NULL OR p_role<>ALL(ARRAY['worker','academy_representative']) THEN RETURN;END IF;
 SELECT(p->>'signerId')::uuid INTO signer FROM jsonb_array_elements(s->'parties') p WHERE p->>'role'=p_role;
 IF signer IS NULL THEN RETURN;END IF;
 RETURN QUERY SELECT * FROM identity.work_signature_signer_matches(p_academy,p_start,p_role,signer,p_name,p_email,p_phone);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_identity_policy;
ALTER FUNCTION public.work_signature_completion_signer_matches(uuid,uuid,text,text,text,text,text) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_identity_policy;
REVOKE ALL ON FUNCTION public.work_signature_completion_signer_matches(uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_completion_signer_matches(uuid,uuid,text,text,text,text,text) TO kavosh_signature_completion_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 224 $$;

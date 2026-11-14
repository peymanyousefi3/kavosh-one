-- No identity-table access for runtime/bots. Only the verified signer of an
-- unexpired, applied signing intention may be hydrated by this narrow helper.
-- Application source/capability checks remain mandatory; this is not clearance.
GRANT SELECT(academy_id,id,package_id,approval_id,created_by,authorization_until,prior_id) ON public.signature_send_requests TO kavosh_identity_policy;
GRANT SELECT(academy_id,request_id) ON public.signature_send_cancellations TO kavosh_identity_policy;
GRANT SELECT(academy_id,id,signer_id,student_id,student_profile_version,guardian_profile_version,contact_fingerprint) ON public.agreement_packages TO kavosh_identity_policy;
GRANT SELECT(academy_id,id,status,action,target_id,reviewer_id) ON public.approval_requests TO kavosh_identity_policy;
GRANT SELECT(academy_id,person_id,version,legal_name) ON public.student_profiles,public.guardian_profiles TO kavosh_identity_policy;
GRANT CREATE ON SCHEMA public TO kavosh_identity_policy;
CREATE FUNCTION public.signature_dispatch_contact(p_request uuid)
RETURNS TABLE(person_id uuid,legal_name text,email text,phone_e164 text,contact_fingerprint text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT p.signer_id,CASE WHEN p.guardian_profile_version IS NOT NULL THEN g.legal_name ELSE s.legal_name END,
 u.email,u."phoneNumber",p.contact_fingerprint
 FROM public.signature_send_requests r
 JOIN public.agreement_packages p ON p.academy_id=r.academy_id AND p.id=r.package_id
 JOIN public.approval_requests a ON a.academy_id=r.academy_id AND a.id=r.approval_id AND a.status='applied'
  AND a.action='signature.send.request' AND a.target_id=r.id AND a.reviewer_id=r.created_by
 JOIN public.people person ON person.academy_id=p.academy_id AND person.id=p.signer_id AND person.kind='human' AND person.status='active'
 JOIN identity."user" u ON u.id=person.auth_user_id AND u."emailVerified" AND u."phoneNumberVerified" AND u."phoneNumber"~'^[+][1-9][0-9]{7,14}$'
 LEFT JOIN public.guardian_profiles g ON g.academy_id=p.academy_id AND g.person_id=p.signer_id AND g.version=p.guardian_profile_version
 LEFT JOIN public.student_profiles s ON s.academy_id=p.academy_id AND s.person_id=p.signer_id AND p.signer_id=p.student_id AND s.version=p.student_profile_version
 WHERE r.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND r.id=p_request AND r.authorization_until>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM public.signature_send_cancellations c WHERE c.academy_id=r.academy_id AND c.request_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM public.signature_send_requests next WHERE next.academy_id=r.academy_id AND next.prior_id=r.id)
 AND CASE WHEN p.guardian_profile_version IS NOT NULL THEN g.legal_name ELSE s.legal_name END IS NOT NULL
 AND p.contact_fingerprint=encode(sha256(convert_to(jsonb_build_array(1,p.academy_id,person.id,u.id,u.email,u."phoneNumber",u."emailVerified",u."phoneNumberVerified")::text,'UTF8')),'hex')
$$;
ALTER FUNCTION public.signature_dispatch_contact(uuid) OWNER TO kavosh_identity_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_identity_policy;
REVOKE ALL ON FUNCTION public.signature_dispatch_contact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_dispatch_contact(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 120 $$;

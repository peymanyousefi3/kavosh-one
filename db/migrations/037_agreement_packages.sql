INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('signatures.view','View private prepared enrollment agreement packages','People',true,ARRAY['hub','class','person','country','region','city']),
 ('signatures.edit','Request enrollment agreement packages for verified legal signers','People',true,ARRAY['hub','class','person','country','region','city']);

-- A preparation receipt is not a sent document, signature or admission waiver.
-- Existing immutable revisions remain the source of legal names and content.
ALTER TABLE public.class_enrollments ADD CONSTRAINT enrollment_package_identity UNIQUE(academy_id,id,class_id,hub_id,student_id);
ALTER TABLE public.family_relationships ADD CONSTRAINT family_package_identity UNIQUE(academy_id,id,student_id,guardian_id);
ALTER TABLE public.agreement_template_revisions ADD CONSTRAINT agreement_package_content UNIQUE(academy_id,template_id,version,definition_hash);
CREATE TABLE public.agreement_packages (
 academy_id uuid NOT NULL,id uuid NOT NULL,hub_id uuid NOT NULL,class_id uuid NOT NULL,
 enrollment_id uuid NOT NULL,enrollment_version integer NOT NULL,
 student_id uuid NOT NULL,student_profile_version integer NOT NULL,
 template_id uuid NOT NULL,template_version integer NOT NULL,template_hash text NOT NULL CHECK(template_hash ~ '^[a-f0-9]{64}$'),
 locale text NOT NULL CHECK(locale IN ('en','fr','zh-CN')),
 signer_id uuid NOT NULL,guardian_profile_version integer,relationship_id uuid,relationship_version integer,
 connection_id uuid NOT NULL,connection_target text NOT NULL CHECK(connection_target ~ '^[a-f0-9]{64}$'),
 contact_fingerprint text NOT NULL CHECK(contact_fingerprint ~ '^[a-f0-9]{64}$'),
 prepared_on date NOT NULL,prepared_at timestamptz NOT NULL,
 created_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 PRIMARY KEY(academy_id,id),
 FOREIGN KEY(academy_id,class_id,hub_id) REFERENCES public.classes(academy_id,id,hub_id),
 FOREIGN KEY(academy_id,enrollment_id,class_id,hub_id,student_id) REFERENCES public.class_enrollments(academy_id,id,class_id,hub_id,student_id),
 FOREIGN KEY(academy_id,enrollment_id,enrollment_version) REFERENCES public.class_enrollment_revisions(academy_id,enrollment_id,version),
 FOREIGN KEY(academy_id,student_id,student_profile_version) REFERENCES public.student_profile_revisions(academy_id,person_id,version),
 FOREIGN KEY(academy_id,template_id,template_version,template_hash) REFERENCES public.agreement_template_revisions(academy_id,template_id,version,definition_hash),
 FOREIGN KEY(academy_id,signer_id) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,signer_id,guardian_profile_version) REFERENCES public.guardian_profile_revisions(academy_id,person_id,version),
 FOREIGN KEY(academy_id,relationship_id,relationship_version) REFERENCES public.family_relationship_revisions(academy_id,relationship_id,version),
 FOREIGN KEY(academy_id,relationship_id,student_id,signer_id) REFERENCES public.family_relationships(academy_id,id,student_id,guardian_id),
 FOREIGN KEY(academy_id,connection_id) REFERENCES public.signature_connections(academy_id,id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK((signer_id=student_id AND guardian_profile_version IS NULL AND relationship_id IS NULL AND relationship_version IS NULL)
  OR (signer_id<>student_id AND guardian_profile_version IS NOT NULL AND relationship_id IS NOT NULL AND relationship_version IS NOT NULL))
);
CREATE INDEX agreement_packages_enrollment ON public.agreement_packages(academy_id,enrollment_id,id);
ALTER TABLE public.agreement_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agreement_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.agreement_packages
 USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid)
 WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT,INSERT ON public.agreement_packages TO kavosh_runtime;

-- Never expose identity tables or contact details to a new service. This
-- narrow tenant-bound function exposes only verification facts and a digest;
-- application source permissions must still be checked before calling it.
CREATE FUNCTION public.signer_verification_status(p_person uuid)
RETURNS TABLE(contact_fingerprint text,email_verified boolean,phone_verified boolean,account_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(1,p.academy_id,p.id,u.id,u.email,u."phoneNumber",u."emailVerified",u."phoneNumberVerified")::text,'UTF8')),'hex'),
  coalesce(u."emailVerified",false),coalesce(u."phoneNumberVerified" AND u."phoneNumber" ~ '^[+][1-9][0-9]{7,14}$',false),
  p.status='active' AND u.id IS NOT NULL
 FROM public.people p LEFT JOIN identity."user" u ON u.id=p.auth_user_id
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_person AND p.kind='human'
 AND (EXISTS(SELECT 1 FROM public.student_profiles s WHERE s.academy_id=p.academy_id AND s.person_id=p.id)
  OR EXISTS(SELECT 1 FROM public.guardian_profiles g WHERE g.academy_id=p.academy_id AND g.person_id=p.id))
$$;
REVOKE ALL ON FUNCTION public.signer_verification_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signer_verification_status(uuid) TO kavosh_runtime;

CREATE FUNCTION public.signature_connection_status(p_connection uuid)
RETURNS TABLE(id uuid,academy_id uuid,region text,environment text,client_id uuid,enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT c.id,c.academy_id,c.region,c.environment,c.client_id,c.enabled FROM public.signature_connections c
 WHERE c.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND c.id=p_connection
$$;
REVOKE ALL ON FUNCTION public.signature_connection_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_connection_status(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 37 $$;

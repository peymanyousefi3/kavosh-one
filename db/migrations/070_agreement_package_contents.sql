-- Old prepared packages deliberately stay unbound. No historical PDF, reviewed
-- layout, financial rendering or signature is invented by this migration.
CREATE TABLE public.agreement_package_contents(
 academy_id uuid NOT NULL,id uuid NOT NULL,package_id uuid NOT NULL,binding_id uuid NOT NULL,
 approval_id uuid NOT NULL,created_by uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,package_id),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,package_id) REFERENCES public.agreement_packages(academy_id,id),
 FOREIGN KEY(academy_id,binding_id) REFERENCES public.agreement_content_bindings(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
ALTER TABLE public.agreement_package_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agreement_package_contents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.agreement_package_contents USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.agreement_package_contents TO kavosh_runtime;
GRANT INSERT(academy_id,id,package_id,binding_id,approval_id,created_by,reason) ON public.agreement_package_contents TO kavosh_runtime;

-- One native, tenant-bound source comparison, shared by persistence and the
-- historical current-state marker. Unavailability returns NULL, not a raised
-- SQL error that would abort an otherwise valid stale-approval decision.
CREATE FUNCTION public.agreement_package_content_basis(p_package uuid,p_binding uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;p record;b record;q record;e record;c record;s record;g record;contact record;connection record;birth date;on_day date;minor boolean;target text;BEGIN
 SELECT * INTO p FROM public.agreement_packages WHERE academy_id=tenant AND id=p_package;
 SELECT * INTO b FROM public.agreement_content_bindings WHERE academy_id=tenant AND id=p_binding;
 IF p.id IS NULL OR b.id IS NULL OR(p.template_id,p.template_version,p.locale,p.template_hash) IS DISTINCT FROM(b.template_id,b.template_version,b.locale,b.source->>'templateHash') THEN RETURN NULL;END IF;
 SELECT * INTO q FROM public.approval_requests WHERE academy_id=tenant AND id=p.approval_id AND status='applied';
 IF q.id IS NULL OR q.action<>'agreement.prepare' OR q.target_id IS DISTINCT FROM p.id OR q.reviewer_id IS DISTINCT FROM p.created_by
 OR q.payload->>'reason' IS DISTINCT FROM p.reason
 OR(jsonb_build_object('enrollmentId',p.enrollment_id,'enrollmentVersion',p.enrollment_version,'classId',p.class_id,'hubId',p.hub_id,
 'studentId',p.student_id,'studentProfileVersion',p.student_profile_version,'templateId',p.template_id,'templateVersion',p.template_version,'templateHash',p.template_hash,
 'locale',p.locale,'signerId',p.signer_id,'guardianProfileVersion',p.guardian_profile_version,'connectionId',p.connection_id,'connectionTarget',p.connection_target,
 'contactFingerprint',p.contact_fingerprint,'preparedOn',p.prepared_on::text)<@q.review_context) IS DISTINCT FROM true
 OR(p.relationship_id IS NULL AND q.review_context->'relationship' IS DISTINCT FROM 'null'::jsonb)
 OR(p.relationship_id IS NOT NULL AND(jsonb_build_object('id',p.relationship_id,'version',p.relationship_version)<@(q.review_context->'relationship')) IS DISTINCT FROM true)
 OR NOT EXISTS(SELECT 1 FROM public.approval_requests WHERE academy_id=tenant AND id=b.approval_id AND status='applied')
 OR public.agreement_content_source(b.template_id,b.template_version,b.file_id,b.file_version,b.inspection_id,b.attempt_no,b.locale) IS DISTINCT FROM b.source THEN RETURN NULL;END IF;
 SELECT * INTO e FROM public.class_enrollments WHERE academy_id=tenant AND id=p.enrollment_id;
 SELECT * INTO c FROM public.classes WHERE academy_id=tenant AND id=p.class_id;
 SELECT * INTO s FROM public.people WHERE academy_id=tenant AND id=p.student_id;
 SELECT * INTO g FROM public.people WHERE academy_id=tenant AND id=p.signer_id;
 SELECT date_of_birth INTO birth FROM public.student_profiles WHERE academy_id=tenant AND person_id=p.student_id AND version=p.student_profile_version;
 IF e.id IS NULL OR NOT e.enabled OR e.version<>p.enrollment_version OR c.id IS NULL OR NOT c.active OR c.version IS DISTINCT FROM(q.review_context->>'classVersion')::integer
 OR s.id IS NULL OR s.status<>'active' OR g.id IS NULL OR g.status<>'active' OR birth IS NULL
 OR s.hub_id IS DISTINCT FROM(q.review_context->>'studentHubId')::uuid OR g.hub_id IS DISTINCT FROM(q.review_context->>'signerHubId')::uuid
 OR NOT EXISTS(SELECT 1 FROM public.hubs WHERE academy_id=tenant AND id=p.hub_id AND active) THEN RETURN NULL;END IF;
 on_day=(clock_timestamp() AT TIME ZONE c.time_zone)::date;
 IF on_day<birth OR(e.leaves_on IS NOT NULL AND e.leaves_on<on_day) THEN RETURN NULL;END IF;
 minor=extract(year FROM on_day)-extract(year FROM birth)-CASE WHEN to_char(on_day,'MM-DD')<to_char(birth,'MM-DD') THEN 1 ELSE 0 END<18;
 IF minor<>(p.signer_id<>p.student_id) THEN RETURN NULL;END IF;
 IF minor AND(NOT EXISTS(SELECT 1 FROM public.guardian_profiles WHERE academy_id=tenant AND person_id=p.signer_id AND version=p.guardian_profile_version)
 OR NOT EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=tenant AND id=p.relationship_id AND version=p.relationship_version AND student_id=p.student_id AND guardian_id=p.signer_id
 AND state='approved' AND relationship IN('parent','legal_guardian') AND valid_from<=clock_timestamp() AND(valid_until IS NULL OR valid_until>clock_timestamp()))) THEN RETURN NULL;END IF;
 SELECT * INTO contact FROM public.signer_verification_status(p.signer_id);
 SELECT * INTO connection FROM public.signature_connection_status(p.connection_id);
 IF NOT coalesce(contact.account_active AND contact.email_verified AND contact.phone_verified,false) OR contact.contact_fingerprint IS DISTINCT FROM p.contact_fingerprint
 OR NOT coalesce(connection.enabled,false) OR connection.region IS DISTINCT FROM b.source#>>'{provider,region}' THEN RETURN NULL;END IF;
 target=encode(sha256(convert_to(format('[1,%s,%s,%s,%s,%s]',to_json(connection.id::text),to_json(connection.academy_id::text),to_json(connection.region),to_json(connection.environment),coalesce(to_json(connection.client_id::text)::text,'null')),'UTF8')),'hex');
 IF target IS DISTINCT FROM p.connection_target THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('package',jsonb_build_object('id',p.id,'approvalId',p.approval_id,'basis',q.review_context-'preparedOn'),
 'content',jsonb_build_object('id',b.id,'approvalId',b.approval_id,'source',b.source,'routing',b.routing));
END $$;
CREATE FUNCTION public.guard_agreement_package_content() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;b record;actual jsonb;BEGIN
 -- Prepared packages are runtime-immutable; do not grant UPDATE merely to
 -- acquire a row lock. Mutable template/file sources are locked below.
 SELECT * INTO b FROM public.agreement_content_bindings WHERE academy_id=NEW.academy_id AND id=NEW.binding_id;
 IF b.id IS NOT NULL THEN
  PERFORM 1 FROM public.agreement_templates WHERE academy_id=NEW.academy_id AND id=b.template_id FOR SHARE;
  PERFORM 1 FROM public.file_records WHERE academy_id=NEW.academy_id AND id=b.file_id FOR SHARE;
 END IF;
 actual=public.agreement_package_content_basis(NEW.package_id,NEW.binding_id);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF actual IS NULL OR p.id IS NULL OR p.status<>'pending' OR p.action<>'agreement.content.attach' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'signatures.view'
 OR(p.payload->>'packageId')::uuid IS DISTINCT FROM NEW.package_id OR(p.payload->>'bindingId')::uuid IS DISTINCT FROM NEW.binding_id OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 OR p.review_context IS DISTINCT FROM actual OR NOT EXISTS(SELECT 1 FROM public.people person WHERE person.academy_id=NEW.academy_id AND person.id=NEW.created_by AND person.kind='human' AND person.status='active')
 THEN RAISE EXCEPTION 'PACKAGE_CONTENT_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER agreement_package_content_guard BEFORE INSERT ON public.agreement_package_contents FOR EACH ROW EXECUTE FUNCTION public.guard_agreement_package_content();
CREATE CONSTRAINT TRIGGER agreement_package_content_reviewed AFTER INSERT ON public.agreement_package_contents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.agreement_package_content_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;b record;t record;class_scope jsonb;BEGIN
 SELECT * INTO p FROM public.agreement_packages WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'packageId')::uuid;
 SELECT * INTO b FROM public.agreement_content_bindings WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'bindingId')::uuid;
 SELECT * INTO t FROM public.agreement_templates WHERE academy_id=NEW.academy_id AND id=p.template_id;
 IF p.id IS NULL OR b.id IS NULL OR t.id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 class_scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',p.class_id,'hubId',p.hub_id)));
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(
  jsonb_build_object('capability','enrollments.view','scope',class_scope),jsonb_build_object('capability','signatures.view','scope',class_scope),
  jsonb_build_object('capability','students.view','personId',p.student_id),jsonb_build_object('capability','signatures.view','personId',p.student_id),
  public.approval_hub_binding('agreements.view',ARRAY[t.hub_id]),jsonb_build_object('fileId',b.file_id));
 IF p.signer_id<>p.student_id THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','guardians.view','personId',p.signer_id),jsonb_build_object('capability','families.view','personId',p.student_id),jsonb_build_object('capability','signatures.view','personId',p.signer_id));END IF;
 RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_agreement_package_content_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='agreement.content.attach') EXECUTE FUNCTION public.agreement_package_content_privacy();
REVOKE ALL ON FUNCTION public.agreement_package_content_basis(uuid,uuid),public.guard_agreement_package_content(),public.agreement_package_content_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agreement_package_content_basis(uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 70 $$;

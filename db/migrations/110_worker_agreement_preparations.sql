-- Separate two-party work preparations from student/guardian admission. No send,
-- signature, legal classification, payment clearance or terms acceptance implied.
UPDATE public.capability_catalog SET label=CASE name WHEN 'agreements.view' THEN 'View versioned enrollment and worker agreement definitions' ELSE 'Request versioned agreement definition changes' END WHERE name IN('agreements.view','agreements.edit');
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('work-signatures.view','View private two-party worker agreement preparations','Finance',true,ARRAY['hub','person','country','region','city']),
 ('work-signatures.edit','Request two-party worker agreement preparations','Finance',true,ARRAY['hub','person','country','region','city']);
CREATE FUNCTION public.agreement_kind_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE kind text;prior text;p record;BEGIN
 kind=NEW.definition->>'kind';IF kind IS NULL OR kind NOT IN('unified_enrollment','worker_services') THEN RAISE EXCEPTION 'AGREEMENT_KIND_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.version>1 THEN SELECT definition->>'kind' INTO prior FROM public.agreement_template_revisions WHERE academy_id=NEW.academy_id AND template_id=NEW.template_id AND version=NEW.version-1;IF prior IS DISTINCT FROM kind THEN RAISE EXCEPTION 'AGREEMENT_KIND_IMMUTABLE' USING ERRCODE='23514';END IF;
 ELSE SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
  IF coalesce(p.payload->>'kind','unified_enrollment') IS DISTINCT FROM kind THEN RAISE EXCEPTION 'AGREEMENT_KIND_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
  IF p.payload ? 'source' THEN SELECT definition->>'kind' INTO prior FROM public.agreement_template_revisions WHERE academy_id=NEW.academy_id AND template_id=(p.payload#>>'{source,templateId}')::uuid AND version=(p.payload#>>'{source,version}')::integer;IF prior IS DISTINCT FROM kind THEN RAISE EXCEPTION 'AGREEMENT_COPY_KIND_REQUIRED' USING ERRCODE='23514';END IF;END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER agreement_kind_guard BEFORE INSERT ON public.agreement_template_revisions FOR EACH ROW EXECUTE FUNCTION public.agreement_kind_guard();
CREATE FUNCTION public.enrollment_agreement_kind_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.agreement_template_revisions WHERE academy_id=NEW.academy_id AND template_id=NEW.template_id AND version=NEW.template_version AND definition->>'kind' IS DISTINCT FROM 'unified_enrollment') THEN RAISE EXCEPTION 'ENROLLMENT_AGREEMENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER enrollment_agreement_kind_guard BEFORE INSERT ON public.agreement_packages FOR EACH ROW EXECUTE FUNCTION public.enrollment_agreement_kind_guard();
-- The existing content binding has one legal_signer, not a worker plus academy
-- counter-signature. Never silently drop the second required party.
CREATE TRIGGER aa_enrollment_content_kind_guard BEFORE INSERT ON public.agreement_content_bindings FOR EACH ROW EXECUTE FUNCTION public.enrollment_agreement_kind_guard();

CREATE FUNCTION public.work_signer_verification(p_person uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('personId',p.id,'contactFingerprint',encode(sha256(convert_to(jsonb_build_array(1,p.academy_id,p.id,u.id,u.email,u."phoneNumber",u."emailVerified",u."phoneNumberVerified")::text,'UTF8')),'hex'))
 FROM public.people p JOIN identity."user" u ON u.id=p.auth_user_id
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_person AND p.kind='human' AND p.status='active' AND u."emailVerified" AND u."phoneNumberVerified" AND u."phoneNumber"~'^[+][1-9][0-9]{7,14}$'
$$;
CREATE TABLE public.work_agreement_preparations(
 academy_id uuid NOT NULL,id uuid NOT NULL,engagement_id uuid NOT NULL,engagement_version integer NOT NULL,
 template_id uuid NOT NULL,template_version integer NOT NULL,worker_id uuid NOT NULL,hub_id uuid,academy_signer_id uuid NOT NULL,connection_id uuid NOT NULL,
 input jsonb NOT NULL,source_snapshot jsonb NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,engagement_id,engagement_version) REFERENCES public.work_engagement_revisions(academy_id,engagement_id,version),
 FOREIGN KEY(academy_id,template_id,template_version) REFERENCES public.agreement_template_revisions(academy_id,template_id,version),
 FOREIGN KEY(academy_id,worker_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,academy_signer_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,connection_id) REFERENCES public.signature_connections(academy_id,id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),CHECK(worker_id<>academy_signer_id)
);
CREATE INDEX work_agreement_worker ON public.work_agreement_preparations(academy_id,worker_id,id);
CREATE INDEX work_agreement_engagement ON public.work_agreement_preparations(academy_id,engagement_id,id);
ALTER TABLE public.work_agreement_preparations ENABLE ROW LEVEL SECURITY;ALTER TABLE public.work_agreement_preparations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.work_agreement_preparations USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.work_agreement_preparations TO kavosh_runtime;
GRANT INSERT(academy_id,id,input,source_snapshot,approval_id,created_by) ON public.work_agreement_preparations TO kavosh_runtime;
CREATE TRIGGER work_agreement_write BEFORE INSERT OR UPDATE OR DELETE ON public.work_agreement_preparations FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write();

CREATE FUNCTION public.work_agreement_input_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE k text;keys text[]:=ARRAY['engagementId','engagementVersion','templateId','templateVersion','academySignerId','connectionId','locale','signerAuthorityReview','reason'];BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& keys) OR i-keys<>'{}'::jsonb OR octet_length(i::text)>16384 THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['engagementId','templateId','academySignerId','connectionId'] LOOP IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR(i->>k)::uuid::text IS DISTINCT FROM i->>k THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['engagementVersion','templateVersion'] LOOP IF jsonb_typeof(i->k) IS DISTINCT FROM 'number' OR(i->>k)::numeric NOT BETWEEN 1 AND 2147483647 OR(i->>k)::numeric<>trunc((i->>k)::numeric) THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['signerAuthorityReview','reason'] LOOP IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR length(btrim(i->>k)) NOT BETWEEN 1 AND 2000 THEN RETURN false;END IF;END LOOP;
 RETURN jsonb_typeof(i->'locale')='string' AND i->>'locale' IN('en','fr','zh-CN');EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.work_agreement_source(i jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE e record;t record;c record;worker jsonb;representative jsonb;tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;BEGIN
 IF NOT public.work_agreement_input_valid(i) THEN RETURN NULL;END IF;
 SELECT h.id,h.person_id,h.hub_id,h.version,r.effective_on,r.definition,r.employer_id,r.employer_version,r.payee_id,r.payee_version,r.source_snapshot INTO e FROM public.work_engagements h JOIN public.work_engagement_revisions r ON r.academy_id=h.academy_id AND r.engagement_id=h.id AND r.version=h.version WHERE h.academy_id=tenant AND h.id=(i->>'engagementId')::uuid AND h.version=(i->>'engagementVersion')::numeric::integer;
 SELECT h.id,h.hub_id,h.version,h.available,r.definition,r.definition_hash INTO t FROM public.agreement_templates h JOIN public.agreement_template_revisions r ON r.academy_id=h.academy_id AND r.template_id=h.id AND r.version=h.version WHERE h.academy_id=tenant AND h.id=(i->>'templateId')::uuid AND h.version=(i->>'templateVersion')::numeric::integer;
 IF e.id IS NULL OR t.id IS NULL OR NOT t.available OR e.definition->'active' IS DISTINCT FROM 'true'::jsonb OR t.definition->>'kind' IS DISTINCT FROM 'worker_services' OR(t.hub_id IS NOT NULL AND t.hub_id IS DISTINCT FROM e.hub_id)
 OR t.definition->'provider' IS NULL OR t.definition->'provider'='null'::jsonb OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t.definition->'languages') l WHERE l->>'locale'=i->>'locale')
 OR t.definition->>'legalEntityName' IS DISTINCT FROM e.source_snapshot#>>'{employer,legalName}'
 OR NOT EXISTS(SELECT 1 FROM public.financial_payees h JOIN public.financial_payee_revisions r ON r.academy_id=h.academy_id AND r.payee_id=h.id AND r.version=h.version WHERE h.academy_id=tenant AND h.id=e.employer_id AND h.version=e.employer_version AND r.active)
 OR NOT EXISTS(SELECT 1 FROM public.financial_payees h JOIN public.financial_payee_revisions r ON r.academy_id=h.academy_id AND r.payee_id=h.id AND r.version=h.version WHERE h.academy_id=tenant AND h.id=e.payee_id AND h.version=e.payee_version AND r.active)
 OR(e.hub_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.hubs WHERE academy_id=tenant AND id=e.hub_id AND active)) THEN RETURN NULL;END IF;
 worker=public.work_signer_verification(e.person_id);representative=public.work_signer_verification((i->>'academySignerId')::uuid);
 SELECT * INTO c FROM public.signature_connection_status((i->>'connectionId')::uuid);
 IF worker IS NULL OR representative IS NULL OR e.person_id=(i->>'academySignerId')::uuid OR c.id IS NULL OR NOT c.enabled OR c.region IS DISTINCT FROM t.definition#>>'{provider,region}' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('engagement',jsonb_build_object('id',e.id,'version',e.version,'personId',e.person_id,'hubId',e.hub_id,'effectiveOn',e.effective_on::text,'classification',e.definition->>'classification','legalWorkerName',e.definition->>'legalWorkerName','countryCode',e.definition->>'countryCode','region',e.definition->>'region','timeZone',e.definition->>'timeZone','startsOn',e.definition->>'startsOn','endsOn',e.definition->'endsOn','employerId',e.employer_id,'employerVersion',e.employer_version,'payeeId',e.payee_id,'payeeVersion',e.payee_version),
 'template',jsonb_build_object('id',t.id,'version',t.version,'hash',t.definition_hash,'hubId',t.hub_id,'kind',t.definition->>'kind','provider',t.definition->'provider','legalEntityName',t.definition->>'legalEntityName','countryCode',t.definition->>'countryCode','jurisdiction',t.definition->>'jurisdiction'),
 'workerSigner',worker,'academySigner',representative,'locale',i->>'locale','connection',jsonb_build_object('id',c.id,'region',c.region,'environment',c.environment,'clientId',c.client_id));
END $$;
CREATE FUNCTION public.work_agreement_scope(p_engagement uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',person_id,'hubId',hub_id)),'workContext',jsonb_build_object('personId',person_id,'hubId',hub_id)) FROM public.work_engagements WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_engagement
$$;
CREATE FUNCTION public.work_agreement_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;p record;BEGIN
 s=public.work_agreement_source(NEW.input);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s IS NULL OR s IS DISTINCT FROM NEW.source_snapshot OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.agreement.prepare' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM jsonb_build_object('source',s) OR p.scope IS DISTINCT FROM public.work_agreement_scope((NEW.input->>'engagementId')::uuid) OR p.privacy_capability IS DISTINCT FROM 'work-signatures.edit' OR NOT public.report_comment_human_verified(NEW.created_by) THEN RAISE EXCEPTION 'WORK_AGREEMENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.engagement_id=(NEW.input->>'engagementId')::uuid;NEW.engagement_version=(NEW.input->>'engagementVersion')::numeric::integer;NEW.template_id=(NEW.input->>'templateId')::uuid;NEW.template_version=(NEW.input->>'templateVersion')::numeric::integer;NEW.worker_id=(s#>>'{engagement,personId}')::uuid;NEW.hub_id=(s#>>'{engagement,hubId}')::uuid;NEW.academy_signer_id=(NEW.input->>'academySignerId')::uuid;NEW.connection_id=(NEW.input->>'connectionId')::uuid;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER work_agreement_guard BEFORE INSERT ON public.work_agreement_preparations FOR EACH ROW EXECUTE FUNCTION public.work_agreement_guard();
CREATE CONSTRAINT TRIGGER work_agreement_reviewed AFTER INSERT ON public.work_agreement_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.work_agreement_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.agreement.prepare' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.work_agreement_preparations WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'WORK_AGREEMENT_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER work_agreement_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_agreement_effect();
CREATE FUNCTION public.work_agreement_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;hub uuid;BEGIN
 s=public.work_agreement_scope((NEW.payload->>'engagementId')::uuid);SELECT hub_id INTO hub FROM public.agreement_templates WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'templateId')::uuid;
 IF NOT FOUND OR s IS NULL OR s IS DISTINCT FROM NEW.scope THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','work-signatures.view','scope',s),jsonb_build_object('capability','work-pay.view','scope',s),public.approval_hub_binding('agreements.view',ARRAY[hub]));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;
END $$;
CREATE TRIGGER zz_work_agreement_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.agreement.prepare') EXECUTE FUNCTION public.work_agreement_privacy();
REVOKE ALL ON FUNCTION public.agreement_kind_guard(),public.enrollment_agreement_kind_guard(),public.work_signer_verification(uuid),public.work_agreement_input_valid(jsonb),public.work_agreement_source(jsonb),public.work_agreement_scope(uuid),public.work_agreement_guard(),public.work_agreement_effect(),public.work_agreement_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signer_verification(uuid),public.work_agreement_input_valid(jsonb),public.work_agreement_source(jsonb),public.work_agreement_scope(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 110 $$;

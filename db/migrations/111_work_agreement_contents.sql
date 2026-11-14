-- Exact inspected PDF plus distinct two-party geometry, not safe serving,
-- provider delivery, two completed signatures or an automatically effective contract.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('work-files.view','View private worker documents','Files',true,ARRAY['hub','person','country','region','city']),
 ('work-files.edit','Reserve and maintain private worker documents','Files',true,ARRAY['hub','person','country','region','city']),
 ('work-files.upload','Upload private worker documents','Files',true,ARRAY['hub','person','country','region','city']);
ALTER TABLE public.file_records ADD COLUMN work_engagement_id uuid;
ALTER TABLE public.file_records ADD CONSTRAINT file_work_owner FOREIGN KEY(academy_id,work_engagement_id) REFERENCES public.work_engagements(academy_id,id);
ALTER TABLE public.file_records DROP CONSTRAINT file_records_domain_check;
ALTER TABLE public.file_records DROP CONSTRAINT file_records_domain_anchor;
ALTER TABLE public.file_records ADD CONSTRAINT file_records_domain_check CHECK(domain IN('general','student_private','guardian_private','agreement_definition','finance_private','work_private'));
ALTER TABLE public.file_records ADD CONSTRAINT file_records_domain_anchor CHECK(domain IN('general','finance_private') OR(domain IN('student_private','guardian_private') AND anchor_kind='person') OR(domain IN('agreement_definition','work_private') AND anchor_kind IN('academy','hub')));
ALTER TABLE public.file_records ADD CONSTRAINT file_work_owner_required CHECK((domain='work_private')=(work_engagement_id IS NOT NULL));
CREATE INDEX file_records_work ON public.file_records(academy_id,work_engagement_id,id) WHERE domain='work_private';
CREATE FUNCTION public.work_file_owner_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE w record;BEGIN
 IF TG_OP='UPDATE' AND(OLD.domain='work_private' OR NEW.domain='work_private') AND(OLD.academy_id,OLD.id,OLD.domain,OLD.work_engagement_id,OLD.anchor_kind,OLD.hub_id,OLD.class_id,OLD.person_id) IS DISTINCT FROM(NEW.academy_id,NEW.id,NEW.domain,NEW.work_engagement_id,NEW.anchor_kind,NEW.hub_id,NEW.class_id,NEW.person_id) THEN RAISE EXCEPTION 'WORK_FILE_OWNER_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NEW.domain='work_private' THEN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
  SELECT * INTO w FROM public.work_engagements WHERE academy_id=NEW.academy_id AND id=NEW.work_engagement_id;
  IF w.id IS NULL OR NEW.hub_id IS DISTINCT FROM w.hub_id OR NEW.class_id IS NOT NULL OR NEW.person_id IS NOT NULL OR NEW.anchor_kind IS DISTINCT FROM(CASE WHEN w.hub_id IS NULL THEN 'academy' ELSE 'hub' END) THEN RAISE EXCEPTION 'WORK_FILE_OWNER_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER work_file_owner_guard BEFORE INSERT OR UPDATE ON public.file_records FOR EACH ROW EXECUTE FUNCTION public.work_file_owner_guard();
CREATE FUNCTION public.work_file_context(p_file uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('engagementId',w.id,'personId',w.person_id,'hubId',w.hub_id) FROM public.file_records f JOIN public.work_engagements w ON w.academy_id=f.academy_id AND w.id=f.work_engagement_id WHERE f.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND f.id=p_file AND f.domain='work_private'
$$;
CREATE FUNCTION public.work_file_allows(p_file uuid,p_scopes jsonb,p_edit boolean DEFAULT false,p_upload boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT NOT EXISTS(SELECT 1 FROM unnest(ARRAY['work-files.view','work-pay.view']||CASE WHEN p_edit THEN ARRAY['work-files.edit'] ELSE '{}'::text[] END||CASE WHEN p_upload THEN ARRAY['work-files.upload'] ELSE '{}'::text[] END) cap WHERE public.work_scope_allows(p_scopes->cap,(c->>'hubId')::uuid,(c->>'personId')::uuid) IS NOT TRUE) FROM(SELECT public.work_file_context(p_file) c) x WHERE c IS NOT NULL),false)
$$;
-- Shared byte/format/inspection identity; callers still enforce their OWN
-- private domain/anchor/context. Exact legacy output is preserved below.
CREATE FUNCTION public.inspected_pdf_source(p_file uuid,p_version integer,p_inspection uuid,p_attempt integer) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE f record;e record;tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;BEGIN
 SELECT * INTO f FROM public.file_records WHERE academy_id=tenant AND id=p_file AND version=p_version AND NOT archived AND claimed_mime_type='application/pdf';IF f.id IS NULL THEN RETURN NULL;END IF;
 SELECT a.*,r.file_id,r.storage_target_id INTO e FROM public.file_inspection_attempts a JOIN public.file_inspection_requests r ON r.academy_id=a.academy_id AND r.id=a.inspection_id
 JOIN public.file_inspection_jobs j ON j.academy_id=a.academy_id AND j.inspection_id=a.inspection_id AND j.attempt_no=a.attempt_no AND j.state='evidence_recorded'
 JOIN public.file_format_assessments s ON s.academy_id=a.academy_id AND s.inspection_id=a.inspection_id AND s.attempt_no=a.attempt_no AND s.state='matched'
 JOIN public.file_content_signatures c ON c.academy_id=a.academy_id AND c.inspection_id=a.inspection_id AND c.attempt_no=a.attempt_no AND c.mime='application/pdf'
 WHERE a.academy_id=tenant AND a.inspection_id=p_inspection AND a.attempt_no=p_attempt AND r.file_id=p_file AND a.outcome='no_detection';
 IF e.inspection_id IS NULL OR e.measured_bytes NOT BETWEEN 1 AND 10485760 OR e.measured_bytes<>f.expected_bytes OR(f.expected_sha256 IS NOT NULL AND f.expected_sha256<>e.sha256) OR EXISTS(SELECT 1 FROM public.file_upload_grants WHERE academy_id=tenant AND file_id=p_file AND expires_at>clock_timestamp()) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('fileId',f.id,'fileVersion',f.version,'inspectionId',e.inspection_id,'attemptNo',e.attempt_no,'sha256',e.sha256,'sizeBytes',e.measured_bytes,'storageTargetId',e.storage_target_id);
END $$;
CREATE OR REPLACE FUNCTION public.agreement_content_source(p_template uuid,p_version integer,p_file uuid,p_file_version integer,p_inspection uuid,p_attempt integer,p_locale text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE t record;f record;pdf jsonb;tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;BEGIN
 SELECT a.*,r.definition,r.definition_hash INTO t FROM public.agreement_templates a JOIN public.agreement_template_revisions r ON r.academy_id=a.academy_id AND r.template_id=a.id AND r.version=a.version WHERE a.academy_id=tenant AND a.id=p_template AND a.version=p_version AND a.available;
 SELECT * INTO f FROM public.file_records WHERE academy_id=tenant AND id=p_file;
 IF t.id IS NULL OR f.id IS NULL OR t.definition->'provider' IS NULL OR t.definition->'provider'='null'::jsonb OR f.domain<>'agreement_definition' OR f.hub_id IS DISTINCT FROM t.hub_id OR f.anchor_kind IS DISTINCT FROM(CASE WHEN t.hub_id IS NULL THEN 'academy' ELSE 'hub' END) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t.definition->'languages') l WHERE l->>'locale'=p_locale) THEN RETURN NULL;END IF;
 pdf=public.inspected_pdf_source(p_file,p_file_version,p_inspection,p_attempt);IF pdf IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('templateId',t.id,'templateVersion',t.version,'templateHash',t.definition_hash,'hubId',t.hub_id,'provider',t.definition->'provider','locale',p_locale)||pdf;
END $$;
REVOKE ALL ON FUNCTION public.work_file_owner_guard(),public.work_file_context(uuid),public.work_file_allows(uuid,jsonb,boolean,boolean),public.inspected_pdf_source(uuid,integer,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_file_context(uuid),public.work_file_allows(uuid,jsonb,boolean,boolean),public.inspected_pdf_source(uuid,integer,uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.approval_bindings_allow(p_bindings jsonb,p_scopes jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE b jsonb;s jsonb;f record;domain_cap text;BEGIN
 IF jsonb_typeof(p_bindings) IS DISTINCT FROM 'array' OR jsonb_array_length(p_bindings)>64 THEN RETURN false;END IF;
 FOR b IN SELECT * FROM jsonb_array_elements(p_bindings) LOOP
  IF b->'unresolved'='true'::jsonb THEN RETURN false;END IF;
  IF b ? 'fileId' THEN
   SELECT effective_hub_id,class_id,person_id,domain INTO f FROM public.file_catalogue WHERE id=(b->>'fileId')::uuid;
   IF NOT FOUND THEN RETURN false;END IF;
   IF f.domain='work_private' THEN IF NOT public.work_file_allows((b->>'fileId')::uuid,p_scopes) THEN RETURN false;END IF;
   ELSE
   IF NOT public.approval_file_scope_allows(p_scopes->'files.view',f.effective_hub_id,f.class_id,f.person_id) THEN RETURN false;END IF;
   domain_cap=CASE f.domain WHEN 'student_private' THEN 'students.view' WHEN 'guardian_private' THEN 'guardians.view' WHEN 'agreement_definition' THEN 'agreements.view' WHEN 'finance_private' THEN 'financial-files.view' WHEN 'general' THEN NULL ELSE 'unknown.private-domain' END;
   IF domain_cap IS NOT NULL AND NOT public.approval_file_scope_allows(p_scopes->domain_cap,f.effective_hub_id,f.class_id,f.person_id) THEN RETURN false;END IF;
   END IF;
  ELSIF b ? 'commitmentBillLinks' THEN
   IF b->>'capability' IS DISTINCT FROM 'expense-commitment-links.view' OR public.commitment_bill_related_allow((b->>'commitmentBillLinks')::uuid,p_scopes) IS NOT TRUE THEN RETURN false;END IF;
  ELSIF b ? 'pollRecords' THEN
   IF b->>'capability' IS DISTINCT FROM 'poll-recipients.view' OR NOT public.poll_recipient_records_allow(b->'pollRecords',p_scopes->'poll-recipients.view') THEN RETURN false;END IF;
  ELSIF b ? 'studentRecords' THEN
   IF b->>'capability' IS DISTINCT FROM 'homework-recipients.view' OR NOT public.homework_recipients_allow(b->'studentRecords',p_scopes->'homework-recipients.view') THEN RETURN false;END IF;
  ELSIF b ? 'personId' THEN
   SELECT id,hub_id INTO f FROM public.people WHERE id=(b->>'personId')::uuid;
   s=p_scopes->(b->>'capability');IF NOT FOUND OR NOT public.approval_scope_nonempty(s) OR NOT public.scope_contains(s,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',f.id,'hubId',f.hub_id)))) THEN RETURN false;END IF;
  ELSE
   s=p_scopes->(b->>'capability');IF NOT public.approval_scope_nonempty(s) THEN RETURN false;END IF;
   IF b->'any' IS DISTINCT FROM 'true'::jsonb AND(jsonb_typeof(b->'scope') IS DISTINCT FROM 'object' OR NOT public.approval_scope_nonempty(b->'scope') OR NOT public.scope_contains(s,b->'scope')) THEN RETURN false;END IF;
  END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
CREATE FUNCTION public.work_agreement_routing_valid(r jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE party jsonb;x jsonb;b jsonb;k text;ids text[]:='{}';counted integer:=0;has_signature boolean;BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['version','parties']<>'{}'::jsonb OR r->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(r->'parties') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'parties')<>2 OR r#>>'{parties,0,role}' IS DISTINCT FROM 'worker' OR r#>>'{parties,1,role}' IS DISTINCT FROM 'academy_representative' THEN RETURN false;END IF;
 FOR party IN SELECT value FROM jsonb_array_elements(r->'parties') LOOP
  IF jsonb_typeof(party) IS DISTINCT FROM 'object' OR party-ARRAY['role','fields']<>'{}'::jsonb OR NOT(party ?& ARRAY['role','fields']) OR jsonb_typeof(party->'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(party->'fields') NOT BETWEEN 1 AND 100 THEN RETURN false;END IF;has_signature=false;
  FOR x IN SELECT value FROM jsonb_array_elements(party->'fields') LOOP
   counted=counted+1;IF counted>100 OR jsonb_typeof(x) IS DISTINCT FROM 'object' OR x-ARRAY['id','fieldType','isRequired','pageNumber','bounds']<>'{}'::jsonb OR NOT(x ?& ARRAY['id','fieldType','isRequired','pageNumber','bounds']) OR x->'isRequired' IS DISTINCT FROM 'true'::jsonb THEN RETURN false;END IF;
   FOREACH k IN ARRAY ARRAY['id','fieldType'] LOOP IF jsonb_typeof(x->k) IS DISTINCT FROM 'string' OR length(x->>k) NOT BETWEEN 1 AND(CASE WHEN k='id' THEN 200 ELSE 80 END) THEN RETURN false;END IF;END LOOP;
   IF x->>'id'=ANY(ids) OR jsonb_typeof(x->'pageNumber') IS DISTINCT FROM 'number' OR(x->>'pageNumber')::numeric NOT BETWEEN 1 AND 1000 OR(x->>'pageNumber')::numeric<>trunc((x->>'pageNumber')::numeric) THEN RETURN false;END IF;ids=array_append(ids,x->>'id');
   IF lower(x->>'fieldType')='signature' THEN has_signature=true;END IF;b=x->'bounds';
   IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR b-ARRAY['x','y','width','height']<>'{}'::jsonb OR NOT(b ?& ARRAY['x','y','width','height']) THEN RETURN false;END IF;
   FOR k IN SELECT jsonb_object_keys(b) LOOP IF jsonb_typeof(b->k) IS DISTINCT FROM 'number' OR(b->>k)::numeric NOT BETWEEN 0 AND 20000 OR(k IN('width','height') AND(b->>k)::numeric=0) THEN RETURN false;END IF;END LOOP;
  END LOOP;IF NOT has_signature THEN RETURN false;END IF;
 END LOOP;RETURN true;EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.work_agreement_content_input_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE k text;keys text[]:=ARRAY['preparationId','fileId','fileVersion','inspectionId','attemptNo','routing','contentReviewed','routingReviewed','contentAttestation','reason'];BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& keys) OR i-keys<>'{}'::jsonb OR octet_length(i::text)>65536 OR i->'contentReviewed' IS DISTINCT FROM 'true'::jsonb OR i->'routingReviewed' IS DISTINCT FROM 'true'::jsonb OR NOT public.work_agreement_routing_valid(i->'routing') THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['preparationId','fileId','inspectionId'] LOOP IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR(i->>k)::uuid::text IS DISTINCT FROM i->>k THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['fileVersion','attemptNo'] LOOP IF jsonb_typeof(i->k) IS DISTINCT FROM 'number' OR(i->>k)::numeric NOT BETWEEN 1 AND(CASE WHEN k='attemptNo' THEN 5 ELSE 2147483647 END) OR(i->>k)::numeric<>trunc((i->>k)::numeric) THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['contentAttestation','reason'] LOOP IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR length(btrim(i->>k)) NOT BETWEEN 1 AND 2000 THEN RETURN false;END IF;END LOOP;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE TABLE public.work_agreement_contents(
 academy_id uuid NOT NULL,id uuid NOT NULL,preparation_id uuid NOT NULL,file_id uuid NOT NULL,file_version integer NOT NULL,inspection_id uuid NOT NULL,attempt_no integer NOT NULL,
 input jsonb NOT NULL,source_snapshot jsonb NOT NULL,created_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,preparation_id),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,preparation_id) REFERENCES public.work_agreement_preparations(academy_id,id),FOREIGN KEY(academy_id,file_id,file_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),
 FOREIGN KEY(academy_id,inspection_id,attempt_no) REFERENCES public.file_inspection_attempts(academy_id,inspection_id,attempt_no),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.work_agreement_contents ENABLE ROW LEVEL SECURITY;ALTER TABLE public.work_agreement_contents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.work_agreement_contents USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.work_agreement_contents TO kavosh_runtime;GRANT INSERT(academy_id,id,input,source_snapshot,created_by,approval_id) ON public.work_agreement_contents TO kavosh_runtime;
CREATE TRIGGER work_agreement_content_write BEFORE INSERT OR UPDATE OR DELETE ON public.work_agreement_contents FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write();
CREATE FUNCTION public.work_agreement_content_source(i jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE w record;p record;file_source jsonb;tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;BEGIN
 IF NOT public.work_agreement_content_input_valid(i) THEN RETURN NULL;END IF;
 SELECT * INTO w FROM public.work_agreement_preparations WHERE academy_id=tenant AND id=(i->>'preparationId')::uuid;
 IF w.id IS NULL THEN RETURN NULL;END IF;SELECT * INTO p FROM public.approval_requests WHERE academy_id=tenant AND id=w.approval_id;
 IF p.id IS NULL OR p.status<>'applied' OR p.action IS DISTINCT FROM 'work.agreement.prepare' OR p.target_id IS DISTINCT FROM w.id OR p.reviewer_id IS DISTINCT FROM w.created_by OR p.payload IS DISTINCT FROM w.input OR p.review_context IS DISTINCT FROM jsonb_build_object('source',w.source_snapshot) OR public.work_agreement_source(w.input) IS DISTINCT FROM w.source_snapshot THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.file_records WHERE academy_id=tenant AND id=(i->>'fileId')::uuid AND domain='work_private' AND work_engagement_id=w.engagement_id) THEN RETURN NULL;END IF;
 file_source=public.inspected_pdf_source((i->>'fileId')::uuid,(i->>'fileVersion')::numeric::integer,(i->>'inspectionId')::uuid,(i->>'attemptNo')::numeric::integer);
 IF file_source IS NULL THEN RETURN NULL;END IF;
 file_source=file_source||jsonb_build_object('hubId',w.hub_id,'engagementId',w.engagement_id,'templateId',w.template_id,'templateVersion',w.template_version,'templateHash',w.source_snapshot#>>'{template,hash}','locale',w.input->>'locale');
 RETURN jsonb_build_object('preparationId',w.id,'preparationApprovalId',w.approval_id,'framework',w.source_snapshot,'document',file_source,'routing',i->'routing');
END $$;
CREATE FUNCTION public.work_agreement_content_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;p record;BEGIN
 s=public.work_agreement_content_source(NEW.input);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s IS NULL OR s IS DISTINCT FROM NEW.source_snapshot OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.agreement.content' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM jsonb_build_object('source',s) OR p.privacy_capability IS DISTINCT FROM 'work-signatures.edit' OR p.scope IS DISTINCT FROM public.work_agreement_scope((s#>>'{framework,engagement,id}')::uuid) OR NOT public.report_comment_human_verified(NEW.created_by) THEN RAISE EXCEPTION 'WORK_AGREEMENT_CONTENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.preparation_id=(NEW.input->>'preparationId')::uuid;NEW.file_id=(NEW.input->>'fileId')::uuid;NEW.file_version=(NEW.input->>'fileVersion')::numeric::integer;NEW.inspection_id=(NEW.input->>'inspectionId')::uuid;NEW.attempt_no=(NEW.input->>'attemptNo')::numeric::integer;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER work_agreement_content_guard BEFORE INSERT ON public.work_agreement_contents FOR EACH ROW EXECUTE FUNCTION public.work_agreement_content_guard();
CREATE CONSTRAINT TRIGGER work_agreement_content_reviewed AFTER INSERT ON public.work_agreement_contents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.work_agreement_content_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.agreement.content' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.work_agreement_contents WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'WORK_AGREEMENT_CONTENT_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER work_agreement_content_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_agreement_content_effect();
CREATE FUNCTION public.work_agreement_content_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE w record;t record;s jsonb;BEGIN
 SELECT * INTO w FROM public.work_agreement_preparations WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'preparationId')::uuid;SELECT * INTO t FROM public.agreement_templates WHERE academy_id=NEW.academy_id AND id=w.template_id;s=public.work_agreement_scope(w.engagement_id);
 IF w.id IS NULL OR t.id IS NULL OR s IS NULL OR NEW.scope IS DISTINCT FROM s OR NOT EXISTS(SELECT 1 FROM public.file_records WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'fileId')::uuid) THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','work-signatures.view','scope',s),jsonb_build_object('capability','work-pay.view','scope',s),public.approval_hub_binding('agreements.view',ARRAY[t.hub_id]),jsonb_build_object('fileId',(NEW.payload->>'fileId')::uuid));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;
END $$;
CREATE TRIGGER zz_work_agreement_content_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.agreement.content') EXECUTE FUNCTION public.work_agreement_content_privacy();
REVOKE ALL ON FUNCTION public.work_agreement_routing_valid(jsonb),public.work_agreement_content_input_valid(jsonb),public.work_agreement_content_source(jsonb),public.work_agreement_content_guard(),public.work_agreement_content_effect(),public.work_agreement_content_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_agreement_routing_valid(jsonb),public.work_agreement_content_input_valid(jsonb),public.work_agreement_content_source(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 111 $$;

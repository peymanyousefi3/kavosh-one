-- Human-reviewed source identities, not signed admission, safe downloads or
-- proof that a mutable provider template will send these exact bytes.
CREATE FUNCTION public.agreement_content_source(p_template uuid,p_version integer,p_file uuid,p_file_version integer,p_inspection uuid,p_attempt integer,p_locale text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;t record;f record;e record;BEGIN
 SELECT a.*,r.definition,r.definition_hash INTO t FROM public.agreement_templates a
 JOIN public.agreement_template_revisions r ON r.academy_id=a.academy_id AND r.template_id=a.id AND r.version=a.version
 WHERE a.academy_id=tenant AND a.id=p_template AND a.version=p_version AND a.available;
 SELECT * INTO f FROM public.file_records WHERE academy_id=tenant AND id=p_file AND version=p_file_version AND NOT archived;
 IF t.id IS NULL OR f.id IS NULL OR t.definition->'provider' IS NULL OR t.definition->'provider'='null'::jsonb
 OR f.domain<>'agreement_definition' OR f.claimed_mime_type<>'application/pdf' OR f.hub_id IS DISTINCT FROM t.hub_id
 OR(t.hub_id IS NULL AND f.anchor_kind<>'academy') OR(t.hub_id IS NOT NULL AND f.anchor_kind<>'hub')
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t.definition->'languages') l WHERE l->>'locale'=p_locale)
 THEN RETURN NULL;END IF;
 SELECT a.*,r.file_id,r.storage_target_id INTO e FROM public.file_inspection_attempts a
 JOIN public.file_inspection_requests r ON r.academy_id=a.academy_id AND r.id=a.inspection_id
 JOIN public.file_inspection_jobs j ON j.academy_id=a.academy_id AND j.inspection_id=a.inspection_id AND j.attempt_no=a.attempt_no AND j.state='evidence_recorded'
 JOIN public.file_format_assessments s ON s.academy_id=a.academy_id AND s.inspection_id=a.inspection_id AND s.attempt_no=a.attempt_no AND s.state='matched'
 JOIN public.file_content_signatures c ON c.academy_id=a.academy_id AND c.inspection_id=a.inspection_id AND c.attempt_no=a.attempt_no AND c.mime='application/pdf'
 WHERE a.academy_id=tenant AND a.inspection_id=p_inspection AND a.attempt_no=p_attempt AND r.file_id=p_file AND a.outcome='no_detection';
 IF e.inspection_id IS NULL OR e.measured_bytes NOT BETWEEN 1 AND 10485760 OR e.measured_bytes<>f.expected_bytes
 OR(f.expected_sha256 IS NOT NULL AND f.expected_sha256<>e.sha256)
 OR EXISTS(SELECT 1 FROM public.file_upload_grants g WHERE g.academy_id=tenant AND g.file_id=p_file AND g.expires_at>clock_timestamp())
 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('templateId',t.id,'templateVersion',t.version,'templateHash',t.definition_hash,'hubId',t.hub_id,'provider',t.definition->'provider',
 'locale',p_locale,'fileId',f.id,'fileVersion',f.version,'inspectionId',e.inspection_id,'attemptNo',e.attempt_no,'sha256',e.sha256,'sizeBytes',e.measured_bytes,'storageTargetId',e.storage_target_id);
END $$;
CREATE TABLE public.agreement_content_bindings(
 academy_id uuid NOT NULL,id uuid NOT NULL,template_id uuid NOT NULL,template_version integer NOT NULL,
 file_id uuid NOT NULL,file_version integer NOT NULL,inspection_id uuid NOT NULL,attempt_no integer NOT NULL,
 locale text NOT NULL CHECK(locale IN('en','fr','zh-CN')),source jsonb NOT NULL,routing jsonb NOT NULL,
 content_attestation text NOT NULL CHECK(length(content_attestation) BETWEEN 1 AND 2000),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_by uuid NOT NULL,approval_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,template_id,template_version) REFERENCES public.agreement_template_revisions(academy_id,template_id,version),
 FOREIGN KEY(academy_id,file_id,file_version) REFERENCES public.file_record_revisions(academy_id,file_id,version),
 FOREIGN KEY(academy_id,inspection_id,attempt_no) REFERENCES public.file_inspection_attempts(academy_id,inspection_id,attempt_no),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX agreement_content_template ON public.agreement_content_bindings(academy_id,template_id,id);
ALTER TABLE public.agreement_content_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agreement_content_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.agreement_content_bindings USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.agreement_content_bindings TO kavosh_runtime;
GRANT INSERT(academy_id,id,template_id,template_version,file_id,file_version,inspection_id,attempt_no,locale,source,routing,content_attestation,reason,created_by,approval_id) ON public.agreement_content_bindings TO kavosh_runtime;
CREATE FUNCTION public.guard_agreement_content_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;actual jsonb;x jsonb;b jsonb;BEGIN
 PERFORM 1 FROM public.agreement_templates WHERE academy_id=NEW.academy_id AND id=NEW.template_id FOR SHARE;
 PERFORM 1 FROM public.file_records WHERE academy_id=NEW.academy_id AND id=NEW.file_id FOR SHARE;
 actual=public.agreement_content_source(NEW.template_id,NEW.template_version,NEW.file_id,NEW.file_version,NEW.inspection_id,NEW.attempt_no,NEW.locale);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF NEW.source IS DISTINCT FROM actual OR p.id IS NULL OR p.status<>'pending' OR p.action<>'agreement.content.bind' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0
 OR NOT EXISTS(SELECT 1 FROM public.people person WHERE person.academy_id=NEW.academy_id AND person.id=NEW.created_by AND person.kind='human' AND person.status='active')
 OR p.privacy_capability IS DISTINCT FROM 'agreements.view' OR p.review_context->'source' IS DISTINCT FROM actual
 OR(p.payload->>'templateId')::uuid IS DISTINCT FROM NEW.template_id OR(p.payload->>'templateVersion')::integer IS DISTINCT FROM NEW.template_version
 OR(p.payload->>'fileId')::uuid IS DISTINCT FROM NEW.file_id OR(p.payload->>'fileVersion')::integer IS DISTINCT FROM NEW.file_version
 OR(p.payload->>'inspectionId')::uuid IS DISTINCT FROM NEW.inspection_id OR(p.payload->>'attemptNo')::integer IS DISTINCT FROM NEW.attempt_no
 OR p.payload->>'locale' IS DISTINCT FROM NEW.locale OR p.payload->'routing' IS DISTINCT FROM NEW.routing
 OR p.payload->>'contentAttestation' IS DISTINCT FROM NEW.content_attestation OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 OR p.payload->'contentReviewed' IS DISTINCT FROM 'true'::jsonb OR p.payload->'routingReviewed' IS DISTINCT FROM 'true'::jsonb
 THEN RAISE EXCEPTION 'AGREEMENT_CONTENT_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(NEW.routing) IS DISTINCT FROM 'object' OR NEW.routing->'version' IS DISTINCT FROM '1'::jsonb OR NEW.routing->>'role' IS DISTINCT FROM 'legal_signer'
 OR jsonb_typeof(NEW.routing->'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.routing->'fields') NOT BETWEEN 1 AND 100
 OR(SELECT count(*) FROM jsonb_object_keys(NEW.routing))<>3
 THEN RAISE EXCEPTION 'AGREEMENT_ROUTING_INVALID' USING ERRCODE='23514';END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(NEW.routing->'fields') LOOP
  b=x->'bounds';
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(x))<>5
  OR jsonb_typeof(x->'id') IS DISTINCT FROM 'string' OR length(x->>'id') NOT BETWEEN 1 AND 200
  OR jsonb_typeof(x->'fieldType') IS DISTINCT FROM 'string' OR length(x->>'fieldType') NOT BETWEEN 1 AND 80
  OR x->'isRequired' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(x->'pageNumber') IS DISTINCT FROM 'number'
  OR(x->>'pageNumber')::numeric NOT BETWEEN 1 AND 1000 OR trunc((x->>'pageNumber')::numeric)<>(x->>'pageNumber')::numeric
  OR jsonb_typeof(b) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(b))<>4
  THEN RAISE EXCEPTION 'AGREEMENT_ROUTING_INVALID' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(b) v WHERE v.key NOT IN('x','y','width','height') OR jsonb_typeof(v.value)<>'number' OR(v.value::text)::numeric<0 OR(v.value::text)::numeric>20000 OR(v.key IN('width','height') AND(v.value::text)::numeric=0)) THEN RAISE EXCEPTION 'AGREEMENT_ROUTING_INVALID' USING ERRCODE='23514';END IF;
 END LOOP;
 IF(SELECT count(DISTINCT item.value->>'id') FROM jsonb_array_elements(NEW.routing->'fields') item(value))<>jsonb_array_length(NEW.routing->'fields')
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.routing->'fields') item(value) WHERE lower(item.value->>'fieldType')='signature') THEN RAISE EXCEPTION 'AGREEMENT_ROUTING_INVALID' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agreement_content_guard BEFORE INSERT ON public.agreement_content_bindings FOR EACH ROW EXECUTE FUNCTION public.guard_agreement_content_binding();
CREATE CONSTRAINT TRIGGER agreement_content_reviewed AFTER INSERT ON public.agreement_content_bindings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.agreement_content_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE hub uuid;BEGIN
 SELECT hub_id INTO hub FROM public.agreement_templates WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'templateId')::uuid;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.file_records WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'fileId')::uuid) THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('agreements.view',ARRAY[hub]),jsonb_build_object('fileId',(NEW.payload->>'fileId')::uuid));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
-- Sorted after the common source binder so it cannot overwrite these bindings.
CREATE TRIGGER zz_agreement_content_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='agreement.content.bind') EXECUTE FUNCTION public.agreement_content_privacy();
REVOKE ALL ON FUNCTION public.agreement_content_source(uuid,integer,uuid,integer,uuid,integer,text),public.guard_agreement_content_binding(),public.agreement_content_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agreement_content_source(uuid,integer,uuid,integer,uuid,integer,text) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 69 $$;

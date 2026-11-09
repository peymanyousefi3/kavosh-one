INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('work-signature-completions.review','Request upper-reviewed worker signing-evidence decisions','Finance',true,ARRAY['hub','person','country','region','city']);
-- Reuse the strict original review shape,with TWO explicitly attested times.
-- Neither time is inferred from a webhook,work date or administrative override.
CREATE FUNCTION public.work_signature_completion_review_input_valid(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR j ? 'signedAt' OR NOT(j ?& ARRAY['workerSignedAt','academySignedAt'])
 OR NOT coalesce(public.signature_completion_review_input_valid((j-ARRAY['workerSignedAt','academySignedAt'])||jsonb_build_object('signedAt',j->'workerSignedAt')),false) THEN RETURN false;END IF;
 IF j->>'decision'='accepted' THEN RETURN jsonb_typeof(j->'academySignedAt')='string' AND length(j->>'academySignedAt')<=30 AND j->>'academySignedAt'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$';END IF;
 RETURN j->'academySignedAt'='null'::jsonb;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
REVOKE ALL ON FUNCTION public.work_signature_completion_review_input_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_completion_review_input_valid(jsonb) TO kavosh_runtime,kavosh_signature_evidence_policy;
GRANT SELECT ON public.work_signature_evidence_download_grants,public.work_agreement_preparations,public.work_signature_dispatch_starts,public.work_signature_send_attempts TO kavosh_signature_evidence_policy;
GRANT SELECT(start_id,state,source_fingerprint,source) ON public.work_signature_completion_evidence TO kavosh_signature_evidence_policy;
GRANT EXECUTE ON FUNCTION public.work_signature_completion_source_current(uuid) TO kavosh_signature_evidence_policy;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['work_signature_evidence_download_grants','work_agreement_preparations','work_signature_dispatch_starts','work_signature_send_attempts'] LOOP
 EXECUTE format('CREATE POLICY work_signature_review_source_read ON public.%I FOR SELECT TO kavosh_signature_evidence_policy USING(true)',t);
END LOOP;END $$;
CREATE FUNCTION public.work_signature_evidence_reviewable_source(p_evidence uuid,p_kind text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;task jsonb;i record;BEGIN
 task=public.work_signature_evidence_inspection_source(tenant,p_evidence,p_kind);IF task IS NULL THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text||':signature-evidence-artifact:'||(task->>'storageTargetId')||':'||(task->>'artifactId'),48));
 SELECT * INTO i FROM public.work_signature_evidence_inspections WHERE academy_id=tenant AND evidence_id=p_evidence AND kind=p_kind ORDER BY recorded_at DESC,id DESC LIMIT 1;
 IF i.id IS NULL OR i.result->>'outcome' IS DISTINCT FROM 'screened' OR i.source IS DISTINCT FROM task
 OR EXISTS(SELECT 1 FROM public.work_signature_evidence_inspections x WHERE x.academy_id=tenant AND x.source->>'storageTargetId'=task->>'storageTargetId' AND x.source->>'artifactId'=task->>'artifactId' AND x.result->>'outcome'='detected') THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('task',task,'signatureCount',i.result#>'{pdfValidation,signatureCount}','completeSignatureCoverage',EXISTS(SELECT 1 FROM jsonb_array_elements(i.result#>'{pdfValidation,signatures}') signature WHERE signature->'coversWholeFile'='true'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.work_signature_evidence_reviewable_source(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_evidence_reviewable_source(uuid,text) TO kavosh_signature_evidence_policy;
CREATE FUNCTION public.work_signature_completion_review_source(p_evidence uuid,p_requester uuid,j jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;e record;p record;start record;scope jsonb;s jsonb;doc record;audit record;d jsonb;a jsonb;worker_signed timestamptz;academy_signed timestamptz;BEGIN
 IF NOT coalesce(public.work_signature_completion_review_input_valid(j),false) OR j->>'evidenceId' IS DISTINCT FROM p_evidence::text OR j->>'requestedBy' IS DISTINCT FROM p_requester::text THEN RETURN NULL;END IF;
 SELECT id,start_id,state,source_fingerprint,source,recorded_at INTO e FROM public.work_signature_completion_evidence WHERE academy_id=tenant AND id=p_evidence;IF e.id IS NULL THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text||':work-signature-transport:'||e.start_id::text,0));
 SELECT x.*,attempt.request_id INTO start FROM public.work_signature_dispatch_starts x JOIN public.work_signature_send_attempts attempt ON attempt.academy_id=x.academy_id AND attempt.id=x.attempt_id WHERE x.academy_id=tenant AND x.id=e.start_id;
 SELECT * INTO p FROM public.work_agreement_preparations WHERE academy_id=tenant AND id=(e.source->>'preparationId')::uuid;
 IF p.id IS NULL OR start.id IS NULL OR j->>'requestId' IS DISTINCT FROM start.request_id::text THEN RETURN NULL;END IF;
 scope=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p.worker_id,'hubId',p.hub_id)),'workContext',jsonb_build_object('personId',p.worker_id,'hubId',p.hub_id));
 s=jsonb_build_object('evidenceId',e.id,'requestId',start.request_id,'preparationId',p.id,'engagementId',p.engagement_id,'templateId',p.template_id,'workerId',p.worker_id,'academySignerId',p.academy_signer_id,'hubId',p.hub_id,'scope',scope,'evidenceState',e.state,'sourceFingerprint',e.source_fingerprint,'historicalSourceCurrent',public.work_signature_completion_source_current(e.id));
 IF j->>'decision'<>'accepted' THEN RETURN s;END IF;
 IF e.state<>'evidence_recorded' OR s->'historicalSourceCurrent' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL;END IF;
 SELECT * INTO doc FROM public.work_signature_evidence_download_grants WHERE academy_id=tenant AND id=(j->>'documentGrantId')::uuid AND evidence_id=e.id AND kind='document' AND created_by=p_requester;
 SELECT * INTO audit FROM public.work_signature_evidence_download_grants WHERE academy_id=tenant AND id=(j->>'auditGrantId')::uuid AND evidence_id=e.id AND kind='audit' AND created_by=p_requester;
 IF doc.id IS NULL OR audit.id IS NULL THEN RETURN NULL;END IF;
 d=public.work_signature_evidence_reviewable_source(e.id,'document');a=public.work_signature_evidence_reviewable_source(e.id,'audit');
 IF d IS NULL OR a IS NULL OR doc.source-ARRAY['inspectionId','inspectionFingerprint','routeId','routeVersion','routeApprovalId','maximumLinkSeconds'] IS DISTINCT FROM d->'task'
 OR audit.source-ARRAY['inspectionId','inspectionFingerprint','routeId','routeVersion','routeApprovalId','maximumLinkSeconds'] IS DISTINCT FROM a->'task'
 OR coalesce((d->>'signatureCount')::integer,0)<1 OR d->'completeSignatureCoverage' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL;END IF;
 worker_signed=(j->>'workerSignedAt')::timestamptz;academy_signed=(j->>'academySignedAt')::timestamptz;
 IF worker_signed<start.created_at OR worker_signed>e.recorded_at OR worker_signed>clock_timestamp()
 OR academy_signed<start.created_at OR academy_signed>e.recorded_at OR academy_signed>clock_timestamp() THEN RETURN NULL;END IF;
 RETURN s||jsonb_build_object('attestedWorkerSignedAt',j->'workerSignedAt','attestedAcademySignedAt',j->'academySignedAt',
 'documentGrantId',doc.id,'documentSourceFingerprint',doc.source_fingerprint,'auditGrantId',audit.id,'auditSourceFingerprint',audit.source_fingerprint);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.work_signature_completion_review_source(uuid,uuid,jsonb) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.work_signature_completion_review_source(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_completion_review_source(uuid,uuid,jsonb) TO kavosh_runtime;
CREATE TABLE public.work_signature_completion_reviews(
 academy_id uuid NOT NULL,evidence_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 input jsonb NOT NULL CHECK(public.work_signature_completion_review_input_valid(input)),source jsonb NOT NULL,
 requested_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,evidence_id),FOREIGN KEY(academy_id,evidence_id) REFERENCES public.work_signature_completion_evidence(academy_id,id),
 FOREIGN KEY(academy_id,requested_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id));
CREATE TABLE public.work_signature_completion_review_revisions(
 academy_id uuid NOT NULL,evidence_id uuid NOT NULL,version integer NOT NULL,definition jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,evidence_id,version),FOREIGN KEY(academy_id,evidence_id) REFERENCES public.work_signature_completion_reviews(academy_id,evidence_id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['work_signature_completion_reviews','work_signature_completion_review_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,evidence_id,input,source,requested_by,changed_by,approval_id) ON public.work_signature_completion_reviews TO kavosh_runtime;
GRANT UPDATE(version,input,source,requested_by,changed_by,approval_id) ON public.work_signature_completion_reviews TO kavosh_runtime;
GRANT INSERT(academy_id,evidence_id,version,definition) ON public.work_signature_completion_review_revisions TO kavosh_runtime;
CREATE FUNCTION public.guard_work_signature_completion_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;s jsonb;previous jsonb;is_master boolean;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_IMMUTABLE_IDENTITY' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 IF TG_OP='UPDATE' THEN IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.evidence_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.evidence_id,OLD.created_at) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_IMMUTABLE_IDENTITY' USING ERRCODE='23514';END IF;previous=to_jsonb(OLD);
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 s=public.work_signature_completion_review_source(NEW.evidence_id,NEW.requested_by,NEW.input);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s IS NULL OR NEW.source IS DISTINCT FROM s OR p.id IS NULL OR p.action IS DISTINCT FROM 'work.signature.completion.review' OR p.target_id IS DISTINCT FROM NEW.evidence_id OR p.target_version IS DISTINCT FROM coalesce(OLD.version,0) OR p.status IS DISTINCT FROM 'pending'
 OR p.requester_kind IS DISTINCT FROM 'human' OR p.requester_id IS DISTINCT FROM NEW.requested_by OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous,'source',s)
 OR p.scope IS DISTINCT FROM s->'scope' OR p.privacy_capability IS DISTINCT FROM 'work-signature-completions.view' OR(NEW.input->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0)
 OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT master_person_id=NEW.changed_by INTO is_master FROM public.academies WHERE id=NEW.academy_id;
 IF NOT coalesce(is_master,false) AND(NEW.changed_by=NEW.requested_by OR NOT public.is_supervisor(NEW.changed_by,NEW.requested_by) OR NEW.changed_by=(s->>'workerId')::uuid OR NEW.changed_by=(s->>'academySignerId')::uuid) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_BENEFICIARY_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.changed_at=clock_timestamp();IF TG_OP='INSERT' THEN NEW.created_at=NEW.changed_at;END IF;RETURN NEW;
END $$;
CREATE TRIGGER work_signature_completion_review_guard BEFORE INSERT OR UPDATE OR DELETE ON public.work_signature_completion_reviews FOR EACH ROW EXECUTE FUNCTION public.guard_work_signature_completion_review();
CREATE FUNCTION public.guard_work_signature_completion_review_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM public.work_signature_completion_reviews WHERE academy_id=NEW.academy_id AND evidence_id=NEW.evidence_id AND version=NEW.version AND to_jsonb(work_signature_completion_reviews)=NEW.definition) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_REVISION_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER work_signature_completion_review_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.work_signature_completion_review_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_work_signature_completion_review_revision();
CREATE FUNCTION public.require_work_signature_completion_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.source IS DISTINCT FROM public.work_signature_completion_review_source(NEW.evidence_id,NEW.requested_by,NEW.input)
 OR NOT EXISTS(SELECT 1 FROM public.work_signature_completion_review_revisions WHERE academy_id=NEW.academy_id AND evidence_id=NEW.evidence_id AND version=NEW.version AND definition=to_jsonb(NEW))
 OR NOT EXISTS(SELECT 1 FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id AND status='applied' AND reviewer_id=NEW.changed_by)
 OR NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events o ON o.academy_id=a.academy_id AND o.request_id=a.request_id AND o.entity_id=a.entity_id AND o.event_type=a.action WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.evidence_id AND a.actor_id=NEW.changed_by AND a.action='work.signature.completion.review' AND a.created_at=transaction_timestamp() AND a.changes->>'version'=NEW.version::text AND a.changes->'severity'='"critical"'::jsonb) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_INCOMPLETE_AT_COMMIT' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER work_signature_completion_review_complete AFTER INSERT OR UPDATE ON public.work_signature_completion_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_work_signature_completion_review();
-- Existing audit_entity_history/audit_event_binding cover the audit side.
-- Keep the new exact event-receipt lookup bounded as the queue grows.
CREATE INDEX work_signature_review_event_receipt ON public.outbox_events(academy_id,request_id,entity_id) WHERE event_type='work.signature.completion.review';
-- Queue receipts stay unreadable to the web role. Only this non-callable
-- deferred trigger gets the native provenance reads it actually needs.
GRANT SELECT ON public.work_signature_completion_reviews,public.work_signature_completion_review_revisions,public.audit_events,public.outbox_events TO kavosh_signature_evidence_policy;
CREATE POLICY work_signature_review_receipt_read ON public.work_signature_completion_reviews FOR SELECT TO kavosh_signature_evidence_policy USING(true);
CREATE POLICY work_signature_review_receipt_read ON public.work_signature_completion_review_revisions FOR SELECT TO kavosh_signature_evidence_policy USING(true);
CREATE POLICY work_signature_review_receipt_read ON public.audit_events FOR SELECT TO kavosh_signature_evidence_policy USING(true);
CREATE POLICY work_signature_review_receipt_read ON public.outbox_events FOR SELECT TO kavosh_signature_evidence_policy USING(true);
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.require_work_signature_completion_review() OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.guard_work_signature_completion_review(),public.guard_work_signature_completion_review_revision(),public.require_work_signature_completion_review() FROM PUBLIC;
CREATE FUNCTION public.work_signature_completion_review_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE refs jsonb;cap text;BEGIN
 SELECT a.privacy_bindings INTO refs FROM public.work_signature_send_requests r JOIN public.approval_requests a ON a.academy_id=r.academy_id AND a.id=r.approval_id WHERE r.academy_id=NEW.academy_id AND r.id=(NEW.payload->>'requestId')::uuid;
 NEW.privacy_bindings=NEW.privacy_bindings||coalesce(refs,jsonb_build_array(jsonb_build_object('unresolved',true)));
 FOREACH cap IN ARRAY ARRAY['work-signatures.view','work-signature-completions.view','work-signature-completions.inspect'] LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',NEW.scope));END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER zz_work_signature_completion_review_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.signature.completion.review') EXECUTE FUNCTION public.work_signature_completion_review_privacy();
CREATE FUNCTION public.require_work_signature_review_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.work_signature_completion_reviews WHERE academy_id=NEW.academy_id AND evidence_id=NEW.target_id AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_EFFECT_MISSING' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER work_signature_completion_review_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.action='work.signature.completion.review') EXECUTE FUNCTION public.require_work_signature_review_effect();
REVOKE ALL ON FUNCTION public.work_signature_completion_review_privacy(),public.require_work_signature_review_effect() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 229 $$;

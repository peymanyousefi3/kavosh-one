INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('signature-completions.review','Request upper-reviewed signing-evidence decisions','People',true,ARRAY['hub','class','person','country','region','city']);
CREATE FUNCTION public.signature_completion_review_input_valid(j jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR NOT(j ?& ARRAY['expectedVersion','decision','documentGrantId','auditGrantId','signedAt','identityAndAuthenticationReviewed','contentAndConsentReviewed','reason','requestId','evidenceId','requestedBy'])
 OR j-ARRAY['expectedVersion','decision','documentGrantId','auditGrantId','signedAt','identityAndAuthenticationReviewed','contentAndConsentReviewed','reason','requestId','evidenceId','requestedBy']<>'{}'::jsonb
 OR jsonb_typeof(j->'expectedVersion') IS DISTINCT FROM 'number' OR j->>'expectedVersion'!~'^[0-9]{1,10}$' OR(j->>'expectedVersion')::bigint>2147483646
 OR jsonb_typeof(j->'reason') IS DISTINCT FROM 'string' OR length(btrim(j->>'reason')) NOT BETWEEN 1 AND 2000
 OR jsonb_typeof(j->'decision') IS DISTINCT FROM 'string' OR jsonb_typeof(j->'requestId') IS DISTINCT FROM 'string' OR jsonb_typeof(j->'evidenceId') IS DISTINCT FROM 'string'
 OR jsonb_typeof(j->'requestedBy') IS DISTINCT FROM 'string' OR j->>'requestedBy'!~'^[0-9a-f-]{36}$'
 OR j->>'requestId'!~'^[0-9a-f-]{36}$' OR j->>'evidenceId'!~'^[0-9a-f-]{36}$' THEN RETURN false;END IF;
 IF j->>'decision'='accepted' THEN RETURN j->'identityAndAuthenticationReviewed'='true'::jsonb AND j->'contentAndConsentReviewed'='true'::jsonb
 AND jsonb_typeof(j->'signedAt')='string' AND length(j->>'signedAt')<=30 AND j->>'signedAt'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$'
 AND jsonb_typeof(j->'documentGrantId')='string' AND j->>'documentGrantId'~'^[0-9a-f-]{36}$' AND jsonb_typeof(j->'auditGrantId')='string' AND j->>'auditGrantId'~'^[0-9a-f-]{36}$';
 END IF;
 RETURN j->>'decision'=ANY(ARRAY['needs_changes','rejected']) AND j->'documentGrantId'='null'::jsonb AND j->'auditGrantId'='null'::jsonb AND j->'signedAt'='null'::jsonb
 AND j->'identityAndAuthenticationReviewed'='false'::jsonb AND j->'contentAndConsentReviewed'='false'::jsonb;
EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
REVOKE ALL ON FUNCTION public.signature_completion_review_input_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_completion_review_input_valid(jsonb) TO kavosh_runtime,kavosh_signature_evidence_policy;
GRANT SELECT ON public.signature_evidence_download_grants,public.agreement_packages,public.student_profile_revisions,public.family_relationship_revisions,public.classes,public.people,public.signature_dispatch_starts,public.signature_send_attempts TO kavosh_signature_evidence_policy;
GRANT SELECT(start_id,state,source_fingerprint,source) ON public.signature_completion_evidence TO kavosh_signature_evidence_policy;
GRANT EXECUTE ON FUNCTION public.signature_completion_source_current(uuid) TO kavosh_signature_evidence_policy;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['signature_evidence_download_grants','agreement_packages','student_profile_revisions','family_relationship_revisions','classes','people','signature_dispatch_starts','signature_send_attempts'] LOOP
 EXECUTE format('CREATE POLICY signature_review_source_read ON public.%I FOR SELECT TO kavosh_signature_evidence_policy USING(true)',t);
END LOOP;END $$;
-- Original immutable civil identity and relationship at the ATTESTED signing
-- instant. Never infer signing time from webhook delivery or review time.
CREATE FUNCTION public.signature_signing_requires_guardian(birth date,signed timestamptz,zone text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT CASE WHEN on_day<birth THEN NULL ELSE extract(year FROM on_day)-extract(year FROM birth)-CASE WHEN to_char(on_day,'MM-DD')<to_char(birth,'MM-DD') THEN 1 ELSE 0 END<18 END FROM(SELECT(signed AT TIME ZONE zone)::date on_day) civil
$$;
REVOKE ALL ON FUNCTION public.signature_signing_requires_guardian(date,timestamptz,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_signing_requires_guardian(date,timestamptz,text) TO kavosh_signature_evidence_policy;
-- Review the retained content,not whether a NEW download link can be issued.
-- A serving-policy change or equivalent clean re-scan must not pretend that
-- an already signed,already inspected agreement expired or lost its contents.
CREATE FUNCTION public.signature_evidence_reviewable_source(p_evidence uuid,p_kind text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;task jsonb;i record;BEGIN
 task=public.signature_evidence_inspection_source(tenant,p_evidence,p_kind);IF task IS NULL THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text||':signature-evidence-artifact:'||(task->>'storageTargetId')||':'||(task->>'artifactId'),48));
 SELECT * INTO i FROM public.signature_evidence_inspections WHERE academy_id=tenant AND evidence_id=p_evidence AND kind=p_kind ORDER BY recorded_at DESC,id DESC LIMIT 1;
 IF i.id IS NULL OR i.result->>'outcome' IS DISTINCT FROM 'screened' OR i.source IS DISTINCT FROM task
 OR EXISTS(SELECT 1 FROM public.signature_evidence_inspections x WHERE x.academy_id=tenant AND x.source->>'storageTargetId'=task->>'storageTargetId' AND x.source->>'artifactId'=task->>'artifactId' AND x.result->>'outcome'='detected') THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('task',task,'signatureCount',i.result#>'{pdfValidation,signatureCount}','completeSignatureCoverage',EXISTS(SELECT 1 FROM jsonb_array_elements(i.result#>'{pdfValidation,signatures}') signature WHERE signature->'coversWholeFile'='true'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.signature_evidence_reviewable_source(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_evidence_reviewable_source(uuid,text) TO kavosh_signature_evidence_policy;
CREATE FUNCTION public.signature_completion_review_source(p_evidence uuid,p_requester uuid,j jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;e record;p record;start record;student record;relation jsonb;scope jsonb;s jsonb;doc record;audit record;d jsonb;a jsonb;signed timestamptz;birth date;on_day date;zone text;minor boolean;BEGIN
 IF NOT coalesce(public.signature_completion_review_input_valid(j),false) OR j->>'evidenceId' IS DISTINCT FROM p_evidence::text OR j->>'requestedBy' IS DISTINCT FROM p_requester::text THEN RETURN NULL;END IF;
 SELECT id,start_id,state,source_fingerprint,source,recorded_at INTO e FROM public.signature_completion_evidence WHERE academy_id=tenant AND id=p_evidence;IF e.id IS NULL THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text||':signature-transport:'||e.start_id::text,0));
 SELECT x.*,a.request_id INTO start FROM public.signature_dispatch_starts x JOIN public.signature_send_attempts a ON a.academy_id=x.academy_id AND a.id=x.attempt_id WHERE x.academy_id=tenant AND x.id=e.start_id;
 SELECT * INTO p FROM public.agreement_packages WHERE academy_id=tenant AND id=(e.source->>'packageId')::uuid;
 IF p.id IS NULL OR start.id IS NULL OR j->>'requestId' IS DISTINCT FROM start.request_id::text THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',p.class_id,'hubId',p.hub_id)),'people',jsonb_agg(jsonb_build_object('id',id,'hubId',hub_id) ORDER BY id)) INTO scope FROM public.people WHERE academy_id=tenant AND id=ANY(ARRAY[p.student_id,p.signer_id]);
 s=jsonb_build_object('evidenceId',e.id,'requestId',start.request_id,'packageId',p.id,'enrollmentId',p.enrollment_id,'studentId',p.student_id,'signerId',p.signer_id,'classId',p.class_id,'hubId',p.hub_id,'scope',scope,'evidenceState',e.state,'sourceFingerprint',e.source_fingerprint,'historicalSourceCurrent',public.signature_completion_source_current(e.id));
 IF j->>'decision'<>'accepted' THEN RETURN s;END IF;
 IF e.state<>'evidence_recorded' OR s->'historicalSourceCurrent' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL;END IF;
 SELECT * INTO doc FROM public.signature_evidence_download_grants WHERE academy_id=tenant AND id=(j->>'documentGrantId')::uuid AND evidence_id=e.id AND kind='document' AND created_by=p_requester;
 SELECT * INTO audit FROM public.signature_evidence_download_grants WHERE academy_id=tenant AND id=(j->>'auditGrantId')::uuid AND evidence_id=e.id AND kind='audit' AND created_by=p_requester;
 IF doc.id IS NULL OR audit.id IS NULL THEN RETURN NULL;END IF;
 d=public.signature_evidence_reviewable_source(e.id,'document');a=public.signature_evidence_reviewable_source(e.id,'audit');
 IF d IS NULL OR a IS NULL OR doc.source-ARRAY['inspectionId','inspectionFingerprint','routeId','routeVersion','routeApprovalId','maximumLinkSeconds'] IS DISTINCT FROM d->'task'
 OR audit.source-ARRAY['inspectionId','inspectionFingerprint','routeId','routeVersion','routeApprovalId','maximumLinkSeconds'] IS DISTINCT FROM a->'task'
 OR coalesce((d->>'signatureCount')::integer,0)<1 OR d->'completeSignatureCoverage' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL;END IF;
 signed=(j->>'signedAt')::timestamptz;
 IF signed<start.created_at OR signed>e.recorded_at OR signed>clock_timestamp() THEN RETURN NULL;END IF;
 SELECT definition INTO student FROM public.student_profile_revisions WHERE academy_id=tenant AND person_id=p.student_id AND version=p.student_profile_version;
 birth=(student.definition->>'date_of_birth')::date;SELECT time_zone INTO zone FROM public.classes WHERE academy_id=tenant AND id=p.class_id;on_day=(signed AT TIME ZONE zone)::date;
 IF birth IS NULL OR on_day IS NULL OR on_day<birth THEN RETURN NULL;END IF;
 minor=public.signature_signing_requires_guardian(birth,signed,zone);
 IF minor THEN
  SELECT definition INTO relation FROM public.family_relationship_revisions WHERE academy_id=tenant AND relationship_id=p.relationship_id AND version=p.relationship_version;
  IF p.signer_id=p.student_id OR relation IS NULL OR relation->>'state'<>'approved' OR relation->>'relationship'<>ALL(ARRAY['parent','legal_guardian'])
  OR(relation->>'valid_from')::timestamptz>signed OR(relation->>'valid_until' IS NOT NULL AND(relation->>'valid_until')::timestamptz<=signed) THEN RETURN NULL;END IF;
 ELSIF p.signer_id<>p.student_id OR p.relationship_id IS NOT NULL THEN RETURN NULL;END IF;
 RETURN s||jsonb_build_object('attestedSignedAt',j->'signedAt','signingLocalDate',on_day,'timeZone',zone,'requiresGuardianAtSigning',minor,'studentProfileVersion',p.student_profile_version,'relationshipId',p.relationship_id,'relationshipVersion',p.relationship_version,
 'documentGrantId',doc.id,'documentSourceFingerprint',doc.source_fingerprint,'auditGrantId',audit.id,'auditSourceFingerprint',audit.source_fingerprint);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.signature_completion_review_source(uuid,uuid,jsonb) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.signature_completion_review_source(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_completion_review_source(uuid,uuid,jsonb) TO kavosh_runtime;
CREATE TABLE public.signature_completion_reviews(
 academy_id uuid NOT NULL,evidence_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 input jsonb NOT NULL CHECK(public.signature_completion_review_input_valid(input)),source jsonb NOT NULL,
 requested_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,evidence_id),FOREIGN KEY(academy_id,evidence_id) REFERENCES public.signature_completion_evidence(academy_id,id),
 FOREIGN KEY(academy_id,requested_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id));
CREATE TABLE public.signature_completion_review_revisions(
 academy_id uuid NOT NULL,evidence_id uuid NOT NULL,version integer NOT NULL,definition jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,evidence_id,version),FOREIGN KEY(academy_id,evidence_id) REFERENCES public.signature_completion_reviews(academy_id,evidence_id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['signature_completion_reviews','signature_completion_review_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,evidence_id,input,source,requested_by,changed_by,approval_id) ON public.signature_completion_reviews TO kavosh_runtime;
GRANT UPDATE(version,input,source,requested_by,changed_by,approval_id) ON public.signature_completion_reviews TO kavosh_runtime;
GRANT INSERT(academy_id,evidence_id,version,definition) ON public.signature_completion_review_revisions TO kavosh_runtime;
CREATE FUNCTION public.guard_signature_completion_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;s jsonb;previous jsonb;is_master boolean;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_IMMUTABLE_IDENTITY' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 IF TG_OP='UPDATE' THEN IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.evidence_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.evidence_id,OLD.created_at) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_IMMUTABLE_IDENTITY' USING ERRCODE='23514';END IF;previous=to_jsonb(OLD);
 ELSIF NEW.version<>1 THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 s=public.signature_completion_review_source(NEW.evidence_id,NEW.requested_by,NEW.input);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s IS NULL OR NEW.source IS DISTINCT FROM s OR p.id IS NULL OR p.action IS DISTINCT FROM 'signature.completion.review' OR p.target_id IS DISTINCT FROM NEW.evidence_id OR p.target_version IS DISTINCT FROM coalesce(OLD.version,0) OR p.status IS DISTINCT FROM 'pending'
 OR p.requester_kind IS DISTINCT FROM 'human' OR p.requester_id IS DISTINCT FROM NEW.requested_by OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM jsonb_build_object('record',previous,'source',s)
 OR p.scope IS DISTINCT FROM s->'scope' OR p.privacy_capability IS DISTINCT FROM 'signature-completions.view' OR(NEW.input->>'expectedVersion')::integer IS DISTINCT FROM coalesce(OLD.version,0)
 OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT master_person_id=NEW.changed_by INTO is_master FROM public.academies WHERE id=NEW.academy_id;
 IF NOT coalesce(is_master,false) AND(NEW.changed_by=NEW.requested_by OR NOT public.is_supervisor(NEW.changed_by,NEW.requested_by) OR NEW.changed_by=(s->>'studentId')::uuid OR NEW.changed_by=(s->>'signerId')::uuid
 OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=(s->>'studentId')::uuid AND guardian_id=NEW.changed_by)) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_BENEFICIARY_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.changed_at=clock_timestamp();IF TG_OP='INSERT' THEN NEW.created_at=NEW.changed_at;END IF;RETURN NEW;
END $$;
CREATE TRIGGER signature_completion_review_guard BEFORE INSERT OR UPDATE OR DELETE ON public.signature_completion_reviews FOR EACH ROW EXECUTE FUNCTION public.guard_signature_completion_review();
CREATE FUNCTION public.guard_signature_completion_review_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM public.signature_completion_reviews WHERE academy_id=NEW.academy_id AND evidence_id=NEW.evidence_id AND version=NEW.version AND to_jsonb(signature_completion_reviews)=NEW.definition) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_REVISION_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER signature_completion_review_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.signature_completion_review_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_signature_completion_review_revision();
CREATE FUNCTION public.require_signature_completion_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.source IS DISTINCT FROM public.signature_completion_review_source(NEW.evidence_id,NEW.requested_by,NEW.input)
 OR NOT EXISTS(SELECT 1 FROM public.signature_completion_review_revisions WHERE academy_id=NEW.academy_id AND evidence_id=NEW.evidence_id AND version=NEW.version AND definition=to_jsonb(NEW))
 OR NOT EXISTS(SELECT 1 FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id AND status='applied' AND reviewer_id=NEW.changed_by)
 OR NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events o ON o.academy_id=a.academy_id AND o.request_id=a.request_id AND o.entity_id=a.entity_id AND o.event_type=a.action WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.evidence_id AND a.actor_id=NEW.changed_by AND a.action='signature.completion.review' AND a.created_at=transaction_timestamp() AND a.changes->>'version'=NEW.version::text AND a.changes->'severity'='"critical"'::jsonb) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_INCOMPLETE_AT_COMMIT' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signature_completion_review_complete AFTER INSERT OR UPDATE ON public.signature_completion_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_signature_completion_review();
-- Existing audit_entity_history/audit_event_binding cover the audit side.
-- Keep the new exact event-receipt lookup bounded as the queue grows.
CREATE INDEX signature_review_event_receipt ON public.outbox_events(academy_id,request_id,entity_id) WHERE event_type='signature.completion.review';
-- Queue receipts stay unreadable to the web role. Only this non-callable
-- deferred trigger gets the native provenance reads it actually needs.
GRANT SELECT ON public.signature_completion_reviews,public.signature_completion_review_revisions,public.audit_events,public.outbox_events TO kavosh_signature_evidence_policy;
CREATE POLICY signature_review_receipt_read ON public.signature_completion_reviews FOR SELECT TO kavosh_signature_evidence_policy USING(true);
CREATE POLICY signature_review_receipt_read ON public.signature_completion_review_revisions FOR SELECT TO kavosh_signature_evidence_policy USING(true);
CREATE POLICY signature_review_receipt_read ON public.audit_events FOR SELECT TO kavosh_signature_evidence_policy USING(true);
CREATE POLICY signature_review_receipt_read ON public.outbox_events FOR SELECT TO kavosh_signature_evidence_policy USING(true);
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.require_signature_completion_review() OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.guard_signature_completion_review(),public.guard_signature_completion_review_revision(),public.require_signature_completion_review() FROM PUBLIC;
CREATE FUNCTION public.signature_completion_review_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE refs jsonb;cap text;BEGIN
 SELECT a.privacy_bindings INTO refs FROM public.signature_send_requests r JOIN public.approval_requests a ON a.academy_id=r.academy_id AND a.id=r.approval_id WHERE r.academy_id=NEW.academy_id AND r.id=(NEW.payload->>'requestId')::uuid;
 NEW.privacy_bindings=NEW.privacy_bindings||coalesce(refs,jsonb_build_array(jsonb_build_object('unresolved',true)));
 FOREACH cap IN ARRAY ARRAY['signature-sends.view','signature-completions.view','signature-completions.inspect'] LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',NEW.scope));END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER zz_signature_completion_review_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='signature.completion.review') EXECUTE FUNCTION public.signature_completion_review_privacy();
CREATE FUNCTION public.require_signature_review_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.signature_completion_reviews WHERE academy_id=NEW.academy_id AND evidence_id=NEW.target_id AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'SIGNATURE_REVIEW_EFFECT_MISSING' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER signature_completion_review_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.action='signature.completion.review') EXECUTE FUNCTION public.require_signature_review_effect();
REVOKE ALL ON FUNCTION public.signature_completion_review_privacy(),public.require_signature_review_effect() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 210 $$;

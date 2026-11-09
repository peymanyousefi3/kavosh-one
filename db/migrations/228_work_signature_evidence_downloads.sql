INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('work-signature-completions.inspect','Inspect private worker contract and audit attachments','Finance',true,ARRAY['hub','person','country','region','city']);
-- A prior enrollment signedEvidence policy NEVER authorizes worker documents.
-- Preserve all historical reviewed definitions;absence remains disabled.
DO $$ DECLARE d text;updated text;needle text:='s-ARRAY[''enabled'',''allowedMimeTypes'',''maximumLinkSeconds'',''signedEvidence'']';BEGIN
 d=pg_get_functiondef('public.file_storage_route_definition_valid(jsonb)'::regprocedure);
 IF position(needle IN d)=0 OR position('FOR m IN SELECT' IN d)=0 THEN RAISE EXCEPTION 'WORK_EVIDENCE_SERVING_POLICY_CHANGED';END IF;
 updated=replace(d,needle,'s-ARRAY[''enabled'',''allowedMimeTypes'',''maximumLinkSeconds'',''signedEvidence'',''workSignedEvidence'']');
 updated=replace(updated,'FOR m IN SELECT',E'IF s ? ''workSignedEvidence'' AND jsonb_typeof(s->''workSignedEvidence'') IS DISTINCT FROM ''boolean'' THEN RETURN false;END IF;\n FOR m IN SELECT');EXECUTE updated;
END $$;
CREATE FUNCTION public.work_signature_evidence_download_source(p_evidence uuid,p_kind text,p_route uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;task jsonb;i record;r record;BEGIN
 task=public.work_signature_evidence_inspection_source(tenant,p_evidence,p_kind);IF task IS NULL THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text||':signature-evidence-artifact:'||(task->>'storageTargetId')||':'||(task->>'artifactId'),48));
 SELECT * INTO i FROM public.work_signature_evidence_inspections WHERE academy_id=tenant AND evidence_id=p_evidence AND kind=p_kind ORDER BY recorded_at DESC,id DESC LIMIT 1;
 IF i.id IS NULL OR i.result->>'outcome' IS DISTINCT FROM 'screened' OR i.source IS DISTINCT FROM task
 OR EXISTS(SELECT 1 FROM public.work_signature_evidence_inspections x WHERE x.academy_id=tenant AND x.source->>'storageTargetId'=task->>'storageTargetId' AND x.source->>'artifactId'=task->>'artifactId' AND x.result->>'outcome'='detected') THEN RETURN NULL;END IF;
 SELECT h.version,v.approval_id,v.definition INTO r FROM public.file_storage_routes h JOIN public.file_storage_route_revisions v ON v.academy_id=h.academy_id AND v.route_id=h.id AND v.version=h.version
 JOIN public.approval_requests a ON a.academy_id=v.academy_id AND a.id=v.approval_id AND a.status='applied' AND a.reviewer_id=v.changed_by
 WHERE h.academy_id=tenant AND h.id=p_route AND v.definition->'enabled'='true'::jsonb AND v.definition#>'{serving,enabled}'='true'::jsonb
 AND v.definition#>'{serving,workSignedEvidence}'='true'::jsonb AND v.definition#>'{serving,allowedMimeTypes}' ? 'application/pdf'
 AND v.definition->>'destinationTargetId'=task->>'storageTargetId' AND(v.definition->>'maximumBytes')::bigint>=(task->>'bytes')::bigint;
 IF r.version IS NULL THEN RETURN NULL;END IF;
 RETURN task||jsonb_build_object('inspectionId',i.id,'inspectionFingerprint',i.fingerprint,'routeId',p_route,'routeVersion',r.version,'routeApprovalId',r.approval_id,'maximumLinkSeconds',(r.definition#>>'{serving,maximumLinkSeconds}')::integer);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.work_signature_evidence_download_source(uuid,text,uuid) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.work_signature_evidence_download_source(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_evidence_download_source(uuid,text,uuid) TO kavosh_runtime;
CREATE TABLE public.work_signature_evidence_download_grants(
 academy_id uuid NOT NULL,id uuid NOT NULL,evidence_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('document','audit')),route_id uuid NOT NULL,
 source jsonb NOT NULL,source_fingerprint text NOT NULL CHECK(source_fingerprint=encode(sha256(convert_to(source::text,'UTF8')),'hex')),
 created_by uuid NOT NULL,audit_id uuid NOT NULL,issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,audit_id),
 FOREIGN KEY(academy_id,evidence_id) REFERENCES public.work_signature_completion_evidence(academy_id,id),FOREIGN KEY(academy_id,route_id) REFERENCES public.file_storage_routes(academy_id,id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id),
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '60 seconds'));
ALTER TABLE public.work_signature_evidence_download_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_signature_evidence_download_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.work_signature_evidence_download_grants USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.work_signature_evidence_download_grants TO kavosh_runtime;
GRANT INSERT(academy_id,id,evidence_id,kind,route_id,created_by,audit_id) ON public.work_signature_evidence_download_grants TO kavosh_runtime;
CREATE FUNCTION public.guard_work_signature_evidence_download_grant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actual jsonb;a record;request uuid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'WORK_EVIDENCE_DOWNLOAD_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 PERFORM 1 FROM public.file_storage_routes WHERE academy_id=NEW.academy_id AND id=NEW.route_id FOR SHARE;
 actual=public.work_signature_evidence_download_source(NEW.evidence_id,NEW.kind,NEW.route_id);SELECT * INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id;
 SELECT attempt.request_id INTO request FROM public.work_signature_completion_evidence e JOIN public.work_signature_dispatch_starts s ON s.academy_id=e.academy_id AND s.id=e.start_id JOIN public.work_signature_send_attempts attempt ON attempt.academy_id=s.academy_id AND attempt.id=s.attempt_id WHERE e.academy_id=NEW.academy_id AND e.id=NEW.evidence_id;
 IF actual IS NULL OR actual->>'academyId' IS DISTINCT FROM NEW.academy_id::text OR a.id IS NULL OR a.actor_id IS DISTINCT FROM NEW.created_by OR a.action IS DISTINCT FROM 'work.signature.evidence.download.issued' OR a.entity_id IS DISTINCT FROM NEW.id OR a.created_at IS DISTINCT FROM transaction_timestamp()
 OR request IS NULL OR a.changes->>'requestId' IS DISTINCT FROM request::text OR a.changes->>'evidenceId' IS DISTINCT FROM NEW.evidence_id::text OR a.changes->>'kind' IS DISTINCT FROM NEW.kind OR a.changes->'privateAttachment' IS DISTINCT FROM 'true'::jsonb
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.created_by AND status='active' AND kind='human') THEN RAISE EXCEPTION 'WORK_EVIDENCE_DOWNLOAD_NOT_READY' USING ERRCODE='23514';END IF;
 NEW.source=actual;NEW.source_fingerprint=encode(sha256(convert_to(actual::text,'UTF8')),'hex');NEW.issued_at=date_trunc('second',clock_timestamp());NEW.expires_at=NEW.issued_at+(actual->>'maximumLinkSeconds')::integer*interval '1 second';RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_work_signature_evidence_download_grant() FROM PUBLIC;
CREATE TRIGGER work_evidence_download_guard BEFORE INSERT OR UPDATE OR DELETE ON public.work_signature_evidence_download_grants FOR EACH ROW EXECUTE FUNCTION public.guard_work_signature_evidence_download_grant();
-- Both attachment domains use the same audit+outbox completeness boundary.
-- A link must not survive silent suppression of its traceable source event.
CREATE FUNCTION public.signature_evidence_download_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE expected text;BEGIN
 IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME<>ALL(ARRAY['signature_evidence_download_grants','work_signature_evidence_download_grants']) THEN RAISE EXCEPTION 'SIGNATURE_EVIDENCE_GRANT_TABLE_REQUIRED' USING ERRCODE='55000';END IF;
 expected=CASE WHEN TG_TABLE_NAME='work_signature_evidence_download_grants' THEN 'work.signature.evidence.download.issued' ELSE 'signature.evidence.download.issued' END;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events o ON o.academy_id=a.academy_id AND o.request_id=a.request_id AND o.entity_id=a.entity_id AND o.event_type=a.action AND o.created_at=transaction_timestamp() WHERE a.academy_id=NEW.academy_id AND a.id=NEW.audit_id AND a.entity_id=NEW.id AND a.actor_id=NEW.created_by AND a.action=expected AND a.created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'SIGNATURE_EVIDENCE_GRANT_EVENT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.signature_evidence_download_complete() OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.signature_evidence_download_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER signature_evidence_download_complete AFTER INSERT ON public.signature_evidence_download_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.signature_evidence_download_complete();
CREATE CONSTRAINT TRIGGER work_evidence_download_complete AFTER INSERT ON public.work_signature_evidence_download_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.signature_evidence_download_complete();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 228 $$;

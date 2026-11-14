-- Administrative attachment inspection only. This is NOT signature approval,
-- legal/cryptographic certification,admission or public/family file access.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('signature-completions.inspect','Inspect private retained signature documents and audit files','People',true,ARRAY['hub','class','person','country','region','city']);
-- Absence preserves every historical reviewed policy byte-for-byte and NEVER
-- authorizes the previously inaccessible signature-evidence namespace.
DO $$ DECLARE d text;updated text;BEGIN
 d=pg_get_functiondef('public.file_storage_route_definition_valid(jsonb)'::regprocedure);
 updated=replace(d,'s-ARRAY[''enabled'',''allowedMimeTypes'',''maximumLinkSeconds'']','s-ARRAY[''enabled'',''allowedMimeTypes'',''maximumLinkSeconds'',''signedEvidence'']');
 updated=replace(updated,'FOR m IN SELECT',E'IF s ? ''signedEvidence'' AND jsonb_typeof(s->''signedEvidence'') IS DISTINCT FROM ''boolean'' THEN RETURN false;END IF;\n FOR m IN SELECT');
 IF updated=d OR position('jsonb_typeof(s->''signedEvidence'')' IN updated)=0 THEN RAISE EXCEPTION 'SIGNATURE_SERVING_POLICY_DEFINITION_CHANGED';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.record_signature_evidence_inspection(uuid,uuid,uuid,text,text,jsonb)'::regprocedure);
 updated=replace(d,'IF jsonb_typeof(p_result)',E'PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||'':signature-evidence-artifact:''||(source->>''storageTargetId'')||'':''||(source->>''artifactId''),48));\n IF jsonb_typeof(p_result)');
 IF updated=d THEN RAISE EXCEPTION 'SIGNATURE_INSPECTION_DEFINITION_CHANGED';END IF;EXECUTE updated;
END $$;
GRANT SELECT ON public.file_storage_routes,public.file_storage_route_revisions,public.approval_requests TO kavosh_signature_evidence_policy;
CREATE POLICY signature_evidence_route_read ON public.file_storage_routes FOR SELECT TO kavosh_signature_evidence_policy USING(true);
CREATE POLICY signature_evidence_route_revision_read ON public.file_storage_route_revisions FOR SELECT TO kavosh_signature_evidence_policy USING(true);
CREATE POLICY signature_evidence_route_approval_read ON public.approval_requests FOR SELECT TO kavosh_signature_evidence_policy USING(true);
CREATE INDEX signature_evidence_detected_artifact ON public.signature_evidence_inspections(academy_id,(source->>'storageTargetId'),(source->>'artifactId')) WHERE result->>'outcome'='detected';
CREATE FUNCTION public.signature_evidence_download_source(p_evidence uuid,p_kind text,p_route uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;task jsonb;i record;r record;BEGIN
 task=public.signature_evidence_inspection_source(tenant,p_evidence,p_kind);IF task IS NULL THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text||':signature-evidence-artifact:'||(task->>'storageTargetId')||':'||(task->>'artifactId'),48));
 SELECT * INTO i FROM public.signature_evidence_inspections WHERE academy_id=tenant AND evidence_id=p_evidence AND kind=p_kind ORDER BY recorded_at DESC,id DESC LIMIT 1;
 IF i.id IS NULL OR i.result->>'outcome' IS DISTINCT FROM 'screened' OR i.source IS DISTINCT FROM task
 OR EXISTS(SELECT 1 FROM public.signature_evidence_inspections x WHERE x.academy_id=tenant AND x.source->>'storageTargetId'=task->>'storageTargetId' AND x.source->>'artifactId'=task->>'artifactId' AND x.result->>'outcome'='detected') THEN RETURN NULL;END IF;
 SELECT h.version,v.approval_id,v.definition INTO r FROM public.file_storage_routes h JOIN public.file_storage_route_revisions v ON v.academy_id=h.academy_id AND v.route_id=h.id AND v.version=h.version
 JOIN public.approval_requests a ON a.academy_id=v.academy_id AND a.id=v.approval_id AND a.status='applied' AND a.reviewer_id=v.changed_by
 WHERE h.academy_id=tenant AND h.id=p_route AND v.definition->'enabled'='true'::jsonb AND v.definition#>'{serving,enabled}'='true'::jsonb
 AND v.definition#>'{serving,signedEvidence}'='true'::jsonb AND v.definition#>'{serving,allowedMimeTypes}' ? 'application/pdf'
 AND v.definition->>'destinationTargetId'=task->>'storageTargetId' AND(v.definition->>'maximumBytes')::bigint>=(task->>'bytes')::bigint;
 IF r.version IS NULL THEN RETURN NULL;END IF;
 -- Permanent immutable same-byte measurements,not a claim of a fresh scan,
 -- freshly checked provider status or verified cryptographic signatures.
 RETURN task||jsonb_build_object('inspectionId',i.id,'inspectionFingerprint',i.fingerprint,'routeId',p_route,'routeVersion',r.version,'routeApprovalId',r.approval_id,'maximumLinkSeconds',(r.definition#>>'{serving,maximumLinkSeconds}')::integer);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.signature_evidence_download_source(uuid,text,uuid) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.signature_evidence_download_source(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_evidence_download_source(uuid,text,uuid) TO kavosh_runtime;
CREATE TABLE public.signature_evidence_download_grants(
 academy_id uuid NOT NULL,id uuid NOT NULL,evidence_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('document','audit')),route_id uuid NOT NULL,
 source jsonb NOT NULL,source_fingerprint text NOT NULL CHECK(source_fingerprint=encode(sha256(convert_to(source::text,'UTF8')),'hex')),
 created_by uuid NOT NULL,audit_id uuid NOT NULL,issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,audit_id),
 FOREIGN KEY(academy_id,evidence_id) REFERENCES public.signature_completion_evidence(academy_id,id),
 FOREIGN KEY(academy_id,route_id) REFERENCES public.file_storage_routes(academy_id,id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id),
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '60 seconds'));
ALTER TABLE public.signature_evidence_download_grants ENABLE ROW LEVEL SECURITY;ALTER TABLE public.signature_evidence_download_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.signature_evidence_download_grants USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.signature_evidence_download_grants TO kavosh_runtime;
GRANT INSERT(academy_id,id,evidence_id,kind,route_id,created_by,audit_id) ON public.signature_evidence_download_grants TO kavosh_runtime;
CREATE FUNCTION public.guard_signature_evidence_download_grant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actual jsonb;a record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SIGNATURE_EVIDENCE_DOWNLOAD_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 PERFORM 1 FROM public.file_storage_routes WHERE academy_id=NEW.academy_id AND id=NEW.route_id FOR SHARE;
 actual=public.signature_evidence_download_source(NEW.evidence_id,NEW.kind,NEW.route_id);SELECT * INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id;
 IF actual IS NULL OR actual->>'academyId' IS DISTINCT FROM NEW.academy_id::text OR a.id IS NULL OR a.actor_id IS DISTINCT FROM NEW.created_by OR a.action IS DISTINCT FROM 'signature.evidence.download.issued'
 OR a.entity_id IS DISTINCT FROM NEW.id OR a.created_at IS DISTINCT FROM transaction_timestamp()
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.created_by AND status='active' AND kind='human') THEN RAISE EXCEPTION 'SIGNATURE_EVIDENCE_DOWNLOAD_NOT_READY' USING ERRCODE='23514';END IF;
 NEW.source=actual;NEW.source_fingerprint=encode(sha256(convert_to(actual::text,'UTF8')),'hex');NEW.issued_at=date_trunc('second',clock_timestamp());NEW.expires_at=NEW.issued_at+(actual->>'maximumLinkSeconds')::integer*interval '1 second';RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_signature_evidence_download_grant() FROM PUBLIC;
CREATE TRIGGER signature_evidence_download_guard BEFORE INSERT OR UPDATE OR DELETE ON public.signature_evidence_download_grants FOR EACH ROW EXECUTE FUNCTION public.guard_signature_evidence_download_grant();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 209 $$;

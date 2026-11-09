-- Link only at creation. Never infer organizations from names or reassign
-- existing custody history. Amounts remain in the original journal sources.
ALTER TABLE public.finance_collectors ADD COLUMN organization_payee_id uuid,ADD COLUMN organization_payee_version integer,
 ADD CONSTRAINT collector_organization_pair CHECK((organization_payee_id IS NULL)=(organization_payee_version IS NULL)),
 ADD CONSTRAINT collector_organization_kind CHECK(organization_payee_id IS NULL OR(kind='other' AND custody='third_party')),
 ADD FOREIGN KEY(academy_id,organization_payee_id,organization_payee_version) REFERENCES public.financial_payee_revisions(academy_id,payee_id,version);
CREATE INDEX collector_organization_identity ON public.finance_collectors(academy_id,organization_payee_id,id) WHERE organization_payee_id IS NOT NULL;
GRANT INSERT(organization_payee_id,organization_payee_version) ON public.finance_collectors TO kavosh_runtime;

CREATE FUNCTION public.guard_collector_organization_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='UPDATE' AND(NEW.organization_payee_id IS DISTINCT FROM OLD.organization_payee_id OR NEW.organization_payee_version IS DISTINCT FROM OLD.organization_payee_version) THEN RAISE EXCEPTION 'COLLECTOR_ORGANIZATION_IMMUTABLE' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER collector_organization_identity BEFORE UPDATE ON public.finance_collectors FOR EACH ROW EXECUTE FUNCTION public.guard_collector_organization_identity();

CREATE FUNCTION public.guard_collector_organization_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE h record;p record;o record;r record;expected jsonb;
BEGIN
 SELECT * INTO h FROM public.finance_collectors WHERE academy_id=NEW.academy_id AND id=NEW.collector_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF NEW.version<>1 THEN RETURN NEW;END IF;
 IF h.organization_payee_id IS NULL AND NOT(p.payload ? 'organizationPayee') THEN RETURN NEW;END IF;
 PERFORM 1 FROM public.financial_payees WHERE academy_id=NEW.academy_id AND id=h.organization_payee_id FOR SHARE;
 SELECT * INTO o FROM public.financial_payees WHERE academy_id=NEW.academy_id AND id=h.organization_payee_id;
 SELECT * INTO r FROM public.financial_payee_revisions WHERE academy_id=NEW.academy_id AND payee_id=h.organization_payee_id AND version=h.organization_payee_version;
 expected=jsonb_build_object('id',h.organization_payee_id,'version',h.organization_payee_version);
 IF h.id IS NULL OR h.created_at<>transaction_timestamp() OR h.kind<>'other' OR h.custody<>'third_party'
  OR o.id IS NULL OR o.kind<>'organization' OR o.version IS DISTINCT FROM h.organization_payee_version OR r.active IS DISTINCT FROM true OR(o.hub_id IS NOT NULL AND o.hub_id IS DISTINCT FROM h.hub_id)
  OR p.status IS DISTINCT FROM 'pending' OR p.action IS DISTINCT FROM 'finance.collector.create' OR p.privacy_capability IS DISTINCT FROM 'collectors.edit' OR p.target_id IS DISTINCT FROM h.id OR p.target_version<>0
  OR p.payload->>'hubId' IS DISTINCT FROM h.hub_id::text OR p.payload->>'personId' IS DISTINCT FROM h.person_id::text OR p.payload->>'kind' IS DISTINCT FROM h.kind OR p.payload->>'custody' IS DISTINCT FROM h.custody OR p.payload->>'code' IS DISTINCT FROM h.code
  OR p.payload->'organizationPayee' IS DISTINCT FROM expected
  OR p.review_context->'organization' IS DISTINCT FROM jsonb_build_object('id',o.id,'version',o.version,'active',r.active,'kind',o.kind,'hubId',o.hub_id)
  OR NEW.changed_by IS DISTINCT FROM h.created_by OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'COLLECTOR_ORGANIZATION_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER collector_organization_revision BEFORE INSERT ON public.finance_collector_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_collector_organization_revision();

CREATE FUNCTION public.complete_collector_organization_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE h record;p record;
BEGIN
 SELECT * INTO h FROM public.finance_collectors WHERE academy_id=NEW.academy_id AND id=NEW.collector_id;
 IF NEW.version<>1 OR h.organization_payee_id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.status IS DISTINCT FROM 'applied' OR p.reviewer_id IS DISTINCT FROM NEW.changed_by OR NOT public.report_comment_human_verified(NEW.changed_by)
  OR NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=h.id AND e.actor_id=NEW.changed_by AND e.action='finance.collector.created' AND e.created_at=transaction_timestamp() AND e.changes=jsonb_build_object('beforeVersion',NULL,'afterVersion',1,'approvalId',NEW.approval_id,'severity','critical','hasReason',true))
 THEN RAISE EXCEPTION 'COLLECTOR_ORGANIZATION_APPLIED_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER collector_organization_complete AFTER INSERT ON public.finance_collector_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_collector_organization_identity();
CREATE FUNCTION public.collector_organization_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.collector.create' AND NEW.status='applied' AND NEW.payload ? 'organizationPayee' AND NOT EXISTS(
  SELECT 1 FROM public.finance_collectors c JOIN public.finance_collector_revisions r ON r.academy_id=c.academy_id AND r.collector_id=c.id AND r.version=1
  WHERE c.academy_id=NEW.academy_id AND c.id=NEW.target_id AND c.created_by=NEW.reviewer_id AND r.approval_id=NEW.id AND jsonb_build_object('id',c.organization_payee_id,'version',c.organization_payee_version)=NEW.payload->'organizationPayee')
 THEN RAISE EXCEPTION 'COLLECTOR_ORGANIZATION_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER collector_organization_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.collector_organization_effect_required();

CREATE FUNCTION public.collector_organization_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE bound_payee uuid;o record;
BEGIN
 IF NEW.action='finance.collector.create' THEN IF NOT(NEW.payload ? 'organizationPayee') THEN RETURN NEW;END IF;bound_payee=(NEW.payload#>>'{organizationPayee,id}')::uuid;
 ELSE SELECT organization_payee_id INTO bound_payee FROM public.finance_collectors WHERE academy_id=NEW.academy_id AND id=NEW.target_id;IF bound_payee IS NULL THEN RETURN NEW;END IF;END IF;
 SELECT * INTO o FROM public.financial_payees WHERE academy_id=NEW.academy_id AND id=bound_payee;
 IF o.id IS NULL OR o.kind<>'organization' THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;
 ELSIF o.hub_id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','payees.view','any',true));
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('payees.view',ARRAY[o.hub_id]));END IF;
 RETURN NEW;
 EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;
END $$;
CREATE TRIGGER zz_collector_organization_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.collector.create','finance.collector.replace')) EXECUTE FUNCTION public.collector_organization_privacy();
REVOKE ALL ON FUNCTION public.guard_collector_organization_identity(),public.guard_collector_organization_revision(),public.complete_collector_organization_identity(),public.collector_organization_effect_required(),public.collector_organization_privacy() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 272 $$;

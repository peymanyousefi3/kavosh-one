-- Private canonical worker identity for people who are not students. Do not
-- create dummy student enrollments or copy DOB into authored public content.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('work-identity.view','View private worker legal identity and review history','People',true,ARRAY['hub','person','country','region','city']),
 ('work-identity.edit','Propose reviewed worker legal identity corrections','People',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.work_identity_revisions(
 academy_id uuid NOT NULL,person_id uuid NOT NULL,person_kind text NOT NULL DEFAULT 'human' CHECK(person_kind='human'),version integer NOT NULL CHECK(version>0),
 state text NOT NULL CHECK(state IN('recorded','withdrawn')),legal_name text,date_of_birth date,source_basis jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,person_id,version),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,person_id,person_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK((state='withdrawn' AND legal_name IS NULL AND date_of_birth IS NULL) OR(state='recorded' AND legal_name IS NOT NULL AND length(btrim(legal_name)) BETWEEN 1 AND 200 AND legal_name!~'[[:cntrl:]]' AND date_of_birth IS NOT NULL AND date_of_birth BETWEEN DATE '1900-01-01' AND DATE '9999-12-31'))
);
ALTER TABLE public.work_identity_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_identity_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.work_identity_revisions USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.work_identity_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,person_id,version,state,legal_name,date_of_birth,source_basis,changed_by,approval_id,reason) ON public.work_identity_revisions TO kavosh_runtime;
CREATE FUNCTION public.work_identity_basis(p_person uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('personId',p.id,'hubId',p.hub_id,'status',p.status,'studentIdentityPresent',EXISTS(SELECT 1 FROM public.student_profiles s WHERE s.academy_id=p.academy_id AND s.person_id=p.id),'version',coalesce(r.version,0),
 'before',CASE WHEN r.version IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('version',r.version,'state',r.state,'legalName',r.legal_name,'dateOfBirth',to_char(r.date_of_birth,'YYYY-MM-DD'),'approvalId',r.approval_id) END,
 'scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p.id,'hubId',p.hub_id)),'workContext',jsonb_build_object('personId',p.id,'hubId',p.hub_id)))
 FROM public.people p LEFT JOIN LATERAL(SELECT * FROM public.work_identity_revisions r WHERE r.academy_id=p.academy_id AND r.person_id=p.id ORDER BY r.version DESC LIMIT 1) r ON true
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_person AND p.kind='human'
$$;
CREATE FUNCTION public.guard_work_identity_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;a record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'WORK_IDENTITY_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 -- The existing policy barrier also protects future publication readers from
 -- racing legal identity edits. A small identity edit is not a payroll run.
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 b=public.work_identity_basis(NEW.person_id);SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR NEW.version<>(b->>'version')::integer+1 OR NEW.source_basis IS DISTINCT FROM b OR a.id IS NULL OR a.status<>'pending' OR a.action IS DISTINCT FROM 'work.identity.change' OR a.target_id IS DISTINCT FROM NEW.person_id OR a.target_version<>NEW.version-1 OR a.privacy_capability IS DISTINCT FROM 'work-identity.view' OR a.scope IS DISTINCT FROM b->'scope' OR a.review_context IS DISTINCT FROM b
 OR a.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'state',NEW.state,'legalName',NEW.legal_name,'dateOfBirth',to_char(NEW.date_of_birth,'YYYY-MM-DD'),'reason',NEW.reason) OR NOT public.report_comment_human_verified(NEW.changed_by)
 OR(NEW.state='recorded' AND(b->'studentIdentityPresent'='true'::jsonb OR NEW.date_of_birth>(clock_timestamp() AT TIME ZONE 'Pacific/Kiritimati')::date))
 OR(NEW.state='withdrawn' AND b#>>'{before,state}' IS DISTINCT FROM 'recorded')
 THEN RAISE EXCEPTION 'WORK_IDENTITY_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;NEW.recorded_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER work_identity_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.work_identity_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_work_identity_revision();
CREATE TRIGGER work_identity_write BEFORE INSERT ON public.work_identity_revisions FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write();
CREATE CONSTRAINT TRIGGER work_identity_reviewed AFTER INSERT ON public.work_identity_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.work_identity_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;event uuid;BEGIN
 IF NEW.action<>'work.identity.change' THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF a.status='applied' AND NOT EXISTS(SELECT 1 FROM public.work_identity_revisions WHERE academy_id=a.academy_id AND person_id=a.target_id AND approval_id=a.id AND changed_by=a.reviewer_id AND version=a.target_version+1) THEN RAISE EXCEPTION 'WORK_IDENTITY_EFFECT_REQUIRED' USING ERRCODE='55000';END IF;
 -- Reuse the central approval source/publisher for every state,including
 -- pending proposals. A silently dropped source or recipient is not success.
 SELECT e.event_id INTO event FROM public.automation_event_sources e JOIN public.audit_events audit ON audit.academy_id=e.academy_id AND audit.id=e.audit_id
 WHERE e.academy_id=a.academy_id AND e.approval_id=a.id AND e.source_kind='approval' AND e.source_version=a.version AND e.event_type='approval.'||CASE WHEN a.status='pending' THEN 'requested' ELSE a.status END
 AND e.projection->>'severity'='critical' AND e.origin_transaction=pg_current_xact_id() AND audit.action=e.event_type AND audit.entity_id=a.id AND audit.created_at=transaction_timestamp();
 IF event IS NULL OR EXISTS(SELECT 1 FROM(SELECT chain.person_id FROM public.supervisor_chain(a.requester_id) chain UNION SELECT a.requester_id WHERE a.status<>'pending' UNION SELECT master_person_id FROM public.academies WHERE id=a.academy_id) audience
 JOIN public.people p ON p.academy_id=a.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL
 WHERE NOT EXISTS(SELECT 1 FROM public.portal_notifications n WHERE n.academy_id=a.academy_id AND n.event_id=event AND n.person_id=p.id AND n.origin='mandatory')) THEN RAISE EXCEPTION 'WORK_IDENTITY_NOTICE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER work_identity_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_identity_effect_required();
CREATE FUNCTION public.work_identity_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.person_id AND a.actor_id=NEW.changed_by AND a.actor_kind='human' AND a.action='work.identity.change' AND a.created_at=transaction_timestamp() AND a.hub_id IS NOT DISTINCT FROM(NEW.source_basis->>'hubId')::uuid
 AND a.changes=jsonb_build_object('version',NEW.version,'state',NEW.state,'approvalId',NEW.approval_id,'severity','critical','privateContentRedacted',true,'identityCertified',false)
 AND EXISTS(SELECT 1 FROM public.outbox_events e WHERE e.academy_id=a.academy_id AND e.entity_id=a.entity_id AND e.request_id=a.request_id AND e.event_type=a.action AND e.created_at=transaction_timestamp())) THEN RAISE EXCEPTION 'WORK_IDENTITY_AUDIT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER work_identity_complete AFTER INSERT ON public.work_identity_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_identity_complete();
-- Use the existing private audit verifier instead of granting runtime raw
-- outbox/audit access. No service receives worker DOB or legal-name reads.
GRANT CREATE ON SCHEMA public TO kavosh_event_policy;
GRANT SELECT(academy_id,person_id,version,changed_by,approval_id) ON public.work_identity_revisions TO kavosh_event_policy;
ALTER FUNCTION public.work_identity_effect_required() SECURITY DEFINER;
ALTER FUNCTION public.work_identity_effect_required() OWNER TO kavosh_event_policy;
ALTER FUNCTION public.work_identity_complete() SECURITY DEFINER;
ALTER FUNCTION public.work_identity_complete() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy;
REVOKE ALL ON FUNCTION public.work_identity_basis(uuid),public.guard_work_identity_revision(),public.work_identity_effect_required(),public.work_identity_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_identity_basis(uuid) TO kavosh_runtime;
-- No positive consent or public profile is created by recording identity.
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 344 $$;

-- Private worker guardianship assertions, not student enrollment, a signature,
-- legal certification, publication consent or a grant of portal access.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('worker-guardians.view','View private worker guardian associations','People',true,ARRAY['hub','person','country','region','city']),
 ('worker-guardians.edit','Propose reviewed worker guardian associations','People',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.work_guardian_revisions(
 academy_id uuid NOT NULL,worker_id uuid NOT NULL,guardian_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 state text NOT NULL CHECK(state IN('approved','suspended')),relationship text NOT NULL CHECK(relationship IN('parent','legal_guardian')),
 valid_from timestamptz(3) NOT NULL,valid_until timestamptz(3),authority_reviewed boolean NOT NULL,source_basis jsonb NOT NULL,
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,worker_id,guardian_id,version),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,worker_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,guardian_id) REFERENCES public.guardian_profiles(academy_id,person_id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK(worker_id<>guardian_id),CHECK(valid_until IS NULL OR valid_until>valid_from),CHECK(state<>'approved' OR authority_reviewed)
);
ALTER TABLE public.work_guardian_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_guardian_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.work_guardian_revisions USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.work_guardian_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,worker_id,guardian_id,version,state,relationship,valid_from,valid_until,authority_reviewed,source_basis,changed_by,approval_id,reason) ON public.work_guardian_revisions TO kavosh_runtime;
CREATE FUNCTION public.work_guardian_basis(p_worker uuid,p_guardian uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('workerId',w.id,'guardianId',g.id,'hubId',w.hub_id,'guardianHubId',g.hub_id,'workerStatus',w.status,'guardianStatus',g.status,
 'studentIdentityPresent',EXISTS(SELECT 1 FROM public.student_profiles s WHERE s.academy_id=w.academy_id AND s.person_id=w.id),'identityVersion',coalesce(i.version,0),'identityRecorded',coalesce(i.state='recorded',false),
 'guardianProfileVersion',gp.version,'guardianVerified',coalesce(c.account_active AND c.email_verified AND c.phone_verified,false),'version',coalesce(r.version,0),
 'before',CASE WHEN r.version IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('version',r.version,'state',r.state,'relationship',r.relationship,'validFrom',to_char(r.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'validUntil',to_char(r.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'authorityReviewed',r.authority_reviewed,'approvalId',r.approval_id) END,
 'scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',w.id,'hubId',w.hub_id)),'workContext',jsonb_build_object('personId',w.id,'hubId',w.hub_id)))
 FROM public.people w JOIN public.people g ON g.academy_id=w.academy_id AND g.id=p_guardian AND g.kind='human'
 JOIN public.guardian_profiles gp ON gp.academy_id=g.academy_id AND gp.person_id=g.id
 LEFT JOIN LATERAL public.guardian_contact_status(g.id) c ON true
 LEFT JOIN LATERAL(SELECT version,state FROM public.work_identity_revisions i WHERE i.academy_id=w.academy_id AND i.person_id=w.id ORDER BY version DESC LIMIT 1) i ON true
 LEFT JOIN LATERAL(SELECT * FROM public.work_guardian_revisions r WHERE r.academy_id=w.academy_id AND r.worker_id=w.id AND r.guardian_id=g.id ORDER BY version DESC LIMIT 1) r ON true
 WHERE w.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND w.id=p_worker AND w.kind='human' AND w.id<>g.id
$$;
CREATE FUNCTION public.guard_work_guardian_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;a record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'WORK_GUARDIAN_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 b=public.work_guardian_basis(NEW.worker_id,NEW.guardian_id);SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR NEW.version<>(b->>'version')::integer+1 OR NEW.source_basis IS DISTINCT FROM b OR a.id IS NULL OR a.status<>'pending' OR a.action IS DISTINCT FROM 'work.guardian.change' OR a.target_id IS DISTINCT FROM NEW.worker_id OR a.target_version<>NEW.version-1
 OR a.privacy_capability IS DISTINCT FROM 'worker-guardians.view' OR a.scope IS DISTINCT FROM b->'scope' OR a.review_context IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by)
 OR a.payload IS DISTINCT FROM jsonb_build_object('guardianId',NEW.guardian_id,'expectedVersion',NEW.version-1,'state',NEW.state,'relationship',NEW.relationship,'validFrom',to_char(NEW.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'validUntil',to_char(NEW.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'authorityReviewed',NEW.authority_reviewed,'reason',NEW.reason)
 OR(NEW.state='approved' AND(b->'studentIdentityPresent' IS DISTINCT FROM 'false'::jsonb OR b->>'workerStatus'<>'active' OR b->>'guardianStatus'<>'active' OR b->'identityRecorded' IS DISTINCT FROM 'true'::jsonb OR b->'guardianVerified' IS DISTINCT FROM 'true'::jsonb))
 OR(NEW.state='suspended' AND b#>>'{before,state}' IS DISTINCT FROM 'approved') THEN RAISE EXCEPTION 'WORK_GUARDIAN_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.recorded_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER work_guardian_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.work_guardian_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_work_guardian_revision();
CREATE TRIGGER work_guardian_write BEFORE INSERT ON public.work_guardian_revisions FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write();
CREATE CONSTRAINT TRIGGER work_guardian_reviewed AFTER INSERT ON public.work_guardian_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.work_guardian_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;event uuid;BEGIN
 IF NEW.action<>'work.guardian.change' THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF a.status='applied' AND NOT EXISTS(SELECT 1 FROM public.work_guardian_revisions WHERE academy_id=a.academy_id AND worker_id=a.target_id AND guardian_id=(a.payload->>'guardianId')::uuid AND approval_id=a.id AND changed_by=a.reviewer_id AND version=a.target_version+1) THEN RAISE EXCEPTION 'WORK_GUARDIAN_EFFECT_REQUIRED' USING ERRCODE='55000';END IF;
 SELECT e.event_id INTO event FROM public.automation_event_sources e JOIN public.audit_events audit ON audit.academy_id=e.academy_id AND audit.id=e.audit_id
 WHERE e.academy_id=a.academy_id AND e.approval_id=a.id AND e.source_kind='approval' AND e.source_version=a.version AND e.event_type='approval.'||CASE WHEN a.status='pending' THEN 'requested' ELSE a.status END AND e.projection->>'severity'='critical' AND e.origin_transaction=pg_current_xact_id() AND audit.action=e.event_type AND audit.entity_id=a.id AND audit.created_at=transaction_timestamp();
 IF event IS NULL OR EXISTS(SELECT 1 FROM(SELECT chain.person_id FROM public.supervisor_chain(a.requester_id) chain UNION SELECT a.requester_id WHERE a.status<>'pending' UNION SELECT master_person_id FROM public.academies WHERE id=a.academy_id) audience JOIN public.people p ON p.academy_id=a.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL
 WHERE NOT EXISTS(SELECT 1 FROM public.portal_notifications n WHERE n.academy_id=a.academy_id AND n.event_id=event AND n.person_id=p.id AND n.origin='mandatory')) THEN RAISE EXCEPTION 'WORK_GUARDIAN_NOTICE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER work_guardian_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_guardian_effect_required();
CREATE FUNCTION public.work_guardian_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.worker_id AND a.actor_id=NEW.changed_by AND a.actor_kind='human' AND a.action='work.guardian.change' AND a.created_at=transaction_timestamp() AND a.hub_id IS NOT DISTINCT FROM(NEW.source_basis->>'hubId')::uuid
 AND a.changes=jsonb_build_object('guardianId',NEW.guardian_id,'version',NEW.version,'state',NEW.state,'approvalId',NEW.approval_id,'severity','critical','privateContentRedacted',true,'authorityCertified',false)
 AND EXISTS(SELECT 1 FROM public.outbox_events e WHERE e.academy_id=a.academy_id AND e.entity_id=a.entity_id AND e.request_id=a.request_id AND e.event_type=a.action AND e.created_at=transaction_timestamp())) THEN RAISE EXCEPTION 'WORK_GUARDIAN_AUDIT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER work_guardian_complete AFTER INSERT ON public.work_guardian_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_guardian_complete();
GRANT CREATE ON SCHEMA public TO kavosh_event_policy;
GRANT SELECT(academy_id,worker_id,guardian_id,version,changed_by,approval_id) ON public.work_guardian_revisions TO kavosh_event_policy;
ALTER FUNCTION public.work_guardian_effect_required() SECURITY DEFINER;
ALTER FUNCTION public.work_guardian_effect_required() OWNER TO kavosh_event_policy;
ALTER FUNCTION public.work_guardian_complete() SECURITY DEFINER;
ALTER FUNCTION public.work_guardian_complete() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy;
REVOKE ALL ON FUNCTION public.work_guardian_basis(uuid,uuid),public.guard_work_guardian_revision(),public.work_guardian_effect_required(),public.work_guardian_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_guardian_basis(uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 347 $$;

-- Append cancellation history; never rewrite approvals,issue receipts or people.
-- NULL on old receipts means historical consumption tracking is not certified.
ALTER TABLE identity.human_invitation_issues ADD COLUMN consumption_tracked boolean CHECK(consumption_tracked IS NULL OR consumption_tracked);
ALTER TABLE identity.human_invitation_issues ALTER COLUMN consumption_tracked SET DEFAULT true;
CREATE INDEX human_invitation_issue_hash ON identity.human_invitation_issues(academy_id,token_hash);
CREATE INDEX invites_unconsumed_person ON identity.invites(academy_id,person_id) WHERE consumed_at IS NULL;
CREATE TABLE identity.human_invitation_consumptions(academy_id uuid NOT NULL,preparation_id uuid NOT NULL,consumed_at timestamptz NOT NULL,PRIMARY KEY(academy_id,preparation_id),FOREIGN KEY(academy_id,preparation_id) REFERENCES identity.human_invitation_issues(academy_id,preparation_id));
GRANT SELECT,INSERT ON identity.human_invitation_consumptions TO kavosh_identity_policy;
INSERT INTO identity.human_invitation_consumptions SELECT c.academy_id,c.preparation_id,i.consumed_at FROM identity.human_invitation_issues c JOIN identity.invites i ON i.token_hash=c.token_hash AND i.academy_id=c.academy_id WHERE i.consumed_at IS NOT NULL;
CREATE TRIGGER human_invitation_consumption_immutable BEFORE UPDATE OR DELETE ON identity.human_invitation_consumptions FOR EACH ROW EXECUTE FUNCTION identity.immutable_human_invitation_issue();
CREATE FUNCTION identity.capture_human_invitation_consumption() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO identity.human_invitation_consumptions(academy_id,preparation_id,consumed_at) SELECT c.academy_id,c.preparation_id,NEW.consumed_at FROM identity.human_invitation_issues c WHERE c.academy_id=NEW.academy_id AND c.token_hash=NEW.token_hash ON CONFLICT(academy_id,preparation_id) DO NOTHING;RETURN NULL;
END $$;
ALTER FUNCTION identity.capture_human_invitation_consumption() OWNER TO kavosh_identity_policy;
REVOKE ALL ON FUNCTION identity.capture_human_invitation_consumption() FROM PUBLIC;
CREATE TRIGGER human_invitation_capture_consumption AFTER UPDATE OF consumed_at ON identity.invites FOR EACH ROW WHEN(OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL) EXECUTE FUNCTION identity.capture_human_invitation_consumption();
CREATE TABLE public.human_invitation_revocations(
 academy_id uuid NOT NULL,id uuid NOT NULL,preparation_id uuid NOT NULL,person_id uuid NOT NULL,hub_id uuid,source_basis jsonb NOT NULL,
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,preparation_id),FOREIGN KEY(academy_id,preparation_id) REFERENCES public.human_invitation_preparations(academy_id,id),
 FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.human_invitation_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.human_invitation_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.human_invitation_revocations USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.human_invitation_revocations TO kavosh_runtime,kavosh_identity_policy;
GRANT INSERT(academy_id,id,preparation_id,person_id,hub_id,source_basis,changed_by,approval_id,reason) ON public.human_invitation_revocations TO kavosh_runtime;
CREATE FUNCTION public.human_invitation_revocation_basis(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('preparation',to_jsonb(p),'currentPerson',jsonb_build_object('id',person.id,'hubId',person.hub_id,'kind',person.kind,'identityBound',person.auth_user_id IS NOT NULL),
 'issue',jsonb_build_object('issuedAt',s.issue->'issuedAt','expiresAt',s.issue->'expiresAt','consumed',s.issue->>'status'='consumed','consumptionUnknown',s.issue->>'status'='consumption_unknown'),'revocationId',r.id)
 FROM public.human_invitation_preparations p JOIN public.people person ON person.academy_id=p.academy_id AND person.id=p.person_id LEFT JOIN public.human_invitation_revocations r ON r.academy_id=p.academy_id AND r.preparation_id=p.id CROSS JOIN LATERAL(SELECT public.human_invitation_issue_status(p.id) AS issue)s
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_id
$$;
CREATE FUNCTION public.guard_human_invitation_revocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;actual jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INVITATION_REVOCATION_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,9));
 actual=public.human_invitation_revocation_basis(NEW.preparation_id);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF actual IS NULL OR actual IS DISTINCT FROM NEW.source_basis OR actual->>'revocationId' IS NOT NULL OR actual#>>'{issue,consumed}' IS DISTINCT FROM 'false' OR actual#>>'{issue,consumptionUnknown}' IS DISTINCT FROM 'false'
 OR(actual#>>'{preparation,person_id}')::uuid IS DISTINCT FROM NEW.person_id OR(actual#>>'{preparation,hub_id}')::uuid IS DISTINCT FROM NEW.hub_id
 OR p.id IS NULL OR p.action<>'human-invitation.revoke' OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'invitations.view' OR p.review_context IS DISTINCT FROM actual
 OR(p.payload->>'invitationId')::uuid IS DISTINCT FROM NEW.preparation_id OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'INVITATION_REVOCATION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER human_invitation_revocation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.human_invitation_revocations FOR EACH ROW EXECUTE FUNCTION public.guard_human_invitation_revocation();
CREATE FUNCTION public.apply_human_invitation_revocation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 -- Only the selected preparation's unconsumed token; a newer replacement and
 -- every existing account/session/role remain untouched.
 UPDATE identity.invites i SET expires_at=clock_timestamp() FROM identity.human_invitation_issues c
 WHERE c.academy_id=NEW.academy_id AND c.preparation_id=NEW.preparation_id AND i.token_hash=c.token_hash AND i.academy_id=NEW.academy_id AND i.person_id=NEW.person_id AND i.consumed_at IS NULL AND i.expires_at>clock_timestamp();RETURN NULL;
END $$;
ALTER FUNCTION public.apply_human_invitation_revocation() OWNER TO kavosh_identity_policy;
CREATE TRIGGER human_invitation_revoke_token AFTER INSERT ON public.human_invitation_revocations FOR EACH ROW EXECUTE FUNCTION public.apply_human_invitation_revocation();
CREATE FUNCTION public.require_human_invitation_revocation_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id AND status='applied' AND reviewer_id=NEW.changed_by)
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.id AND actor_id=NEW.changed_by AND action='human-invitation.revoke' AND created_at=transaction_timestamp() AND changes->>'approvalId'=NEW.approval_id::text AND changes->>'invitationId'=NEW.preparation_id::text)
 THEN RAISE EXCEPTION 'INVITATION_REVOCATION_APPROVAL_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER human_invitation_revocation_audit_required AFTER INSERT ON public.human_invitation_revocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_human_invitation_revocation_audit();
REVOKE ALL ON FUNCTION public.human_invitation_revocation_basis(uuid),public.guard_human_invitation_revocation(),public.apply_human_invitation_revocation(),public.require_human_invitation_revocation_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.human_invitation_revocation_basis(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.issue_human_invitation(p_id uuid,p_actor uuid,p_session uuid,p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;item public.human_invitation_preparations;actor public.people;prior identity.human_invitation_issues;actual jsonb;expiry timestamptz;BEGIN
 IF tenant IS NULL OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_INVITATION_INPUT' USING ERRCODE='22023';END IF;
 -- Caller freezes policy/topology before this native helper; acquiring the same
 -- ordered gates also makes direct trusted-service calls coherent with acceptance.
 -- ponytail: handoffs serialize per school; introduce a shared per-recipient
 -- protocol across acceptance and issuance if measured onboarding contention
 -- warrants it,without weakening current policy/topology fencing.
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text,8));PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text,9));
 SELECT * INTO actor FROM public.people WHERE academy_id=tenant AND id=p_actor AND kind='human' AND status='active';
 IF NOT FOUND OR actor.auth_user_id IS NULL OR NOT public.lock_human(p_session,actor.auth_user_id) THEN RAISE EXCEPTION 'INVITATION_HUMAN_SESSION_REQUIRED' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=tenant AND status='active') THEN RAISE EXCEPTION 'INVITATION_SCHOOL_UNAVAILABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO item FROM public.human_invitation_preparations WHERE academy_id=tenant AND id=p_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INVITATION_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=tenant AND p.id=item.approval_id AND p.status='applied' AND p.reviewer_id=item.changed_by) THEN RAISE EXCEPTION 'INVITATION_APPROVAL_NOT_APPLIED' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.human_invitation_revocations r WHERE r.academy_id=tenant AND r.preparation_id=p_id) THEN RAISE EXCEPTION 'INVITATION_REVOKED' USING ERRCODE='23514';END IF;
 actual=public.human_invitation_basis(item.person_id);
 IF actual IS DISTINCT FROM item.source_basis THEN RAISE EXCEPTION 'INVITATION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 SELECT * INTO prior FROM identity.human_invitation_issues WHERE academy_id=tenant AND preparation_id=p_id;
 IF FOUND THEN
  IF prior.token_hash<>p_hash THEN RAISE EXCEPTION 'INVITATION_TOKEN_KEY_CHANGED' USING ERRCODE='23514';END IF;
  IF NOT EXISTS(SELECT 1 FROM identity.invites WHERE token_hash=p_hash AND academy_id=tenant AND person_id=item.person_id AND email=actual#>>'{person,email}' AND NOT master AND consumed_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'INVITATION_NO_LONGER_CURRENT' USING ERRCODE='23514';END IF;expiry=prior.expires_at;
 ELSE
  UPDATE identity.invites SET expires_at=clock_timestamp() WHERE academy_id=tenant AND person_id=item.person_id AND consumed_at IS NULL AND expires_at>clock_timestamp();
  expiry=clock_timestamp()+interval '48 hours';
  INSERT INTO identity.invites(token_hash,academy_id,person_id,email,master,expires_at) VALUES(p_hash,tenant,item.person_id,actual#>>'{person,email}',false,expiry);
  INSERT INTO identity.human_invitation_issues(academy_id,preparation_id,token_hash,expires_at,issued_by) VALUES(tenant,p_id,p_hash,expiry,p_actor);
 END IF;
 RETURN jsonb_build_object('preparationId',p_id,'personId',item.person_id,'email',actual#>>'{person,email}','expiresAt',expiry,'activationPerformed',false,'externalDeliveryPerformed',false);
END $$;
CREATE OR REPLACE FUNCTION public.human_invitation_issue_status(p_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('status',CASE WHEN k.preparation_id IS NOT NULL OR i.consumed_at IS NOT NULL THEN 'consumed' WHEN r.id IS NOT NULL THEN 'revoked' WHEN c.preparation_id IS NULL THEN 'unissued' WHEN c.consumption_tracked IS DISTINCT FROM true AND i.token_hash IS NULL THEN 'consumption_unknown' WHEN c.expires_at<=clock_timestamp() THEN 'expired' WHEN i.token_hash IS NULL THEN 'unavailable' WHEN i.expires_at<c.expires_at THEN 'superseded' ELSE 'active' END,'expiresAt',c.expires_at,'issuedAt',c.issued_at,'revocationId',r.id)
 FROM public.human_invitation_preparations p LEFT JOIN public.human_invitation_revocations r ON r.academy_id=p.academy_id AND r.preparation_id=p.id LEFT JOIN identity.human_invitation_issues c ON c.academy_id=p.academy_id AND c.preparation_id=p.id LEFT JOIN identity.human_invitation_consumptions k ON k.academy_id=p.academy_id AND k.preparation_id=p.id LEFT JOIN identity.invites i ON i.token_hash=c.token_hash AND i.academy_id=p.academy_id
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_id
$$;
-- New invitation security requests use the existing mandatory supervisor floor.
CREATE OR REPLACE FUNCTION public.capture_automation_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a record;p record;hub uuid;bound_hubs uuid[];severity text;at timestamptz:=clock_timestamp();
BEGIN
 IF NEW.event_type NOT IN('approval.requested','approval.applied','approval.rejected','approval.withdrawn','approval.stale') THEN RETURN NULL;END IF;
 IF(SELECT count(*) FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.request_id=NEW.request_id AND e.action=NEW.event_type AND e.entity_id=NEW.entity_id AND e.created_at=transaction_timestamp())<>1 THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.request_id=NEW.request_id AND e.action=NEW.event_type AND e.entity_id=NEW.entity_id AND e.created_at=transaction_timestamp();
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.entity_id;
 IF p.id IS NULL OR a.actor_kind NOT IN('human','bot') OR EXISTS(SELECT 1 FROM public.automation_event_sources s WHERE s.academy_id=NEW.academy_id AND s.audit_id=a.id) THEN RETURN NULL;END IF;
 IF(NEW.event_type='approval.requested' AND p.status<>'pending') OR(NEW.event_type<>'approval.requested' AND p.status IS DISTINCT FROM substring(NEW.event_type FROM 10)) THEN RETURN NULL;END IF;
 -- A branch is asserted only when EVERY explicit facet agrees on one hub.
 -- Global/mixed or unresolved cases remain school-wide, never guessed.
 IF p.scope->'all'='false'::jsonb AND NOT(p.scope ? 'areas') THEN
  BEGIN
   SELECT array_agg(DISTINCT value) INTO bound_hubs FROM(
    SELECT x::uuid AS value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.scope->'hubs')='array' THEN p.scope->'hubs' ELSE '[]'::jsonb END) x
    UNION ALL SELECT(x->>'hubId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.scope->'classes')='array' THEN p.scope->'classes' ELSE '[]'::jsonb END) x
    UNION ALL SELECT(x->>'hubId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.scope->'people')='array' THEN p.scope->'people' ELSE '[]'::jsonb END) x
   ) all_hubs;
   IF cardinality(bound_hubs)=1 AND bound_hubs[1] IS NOT NULL AND EXISTS(SELECT 1 FROM public.hubs WHERE academy_id=NEW.academy_id AND id=bound_hubs[1]) THEN hub=bound_hubs[1];END IF;
  EXCEPTION WHEN invalid_text_representation THEN hub=NULL;END;
 END IF;
 severity=CASE WHEN a.changes->>'severity'='critical' OR p.action LIKE 'finance.%' OR p.action LIKE 'work.%' OR p.action LIKE 'automation.%' OR p.action LIKE 'storage.%' OR p.action LIKE 'role.%' OR p.action LIKE 'human-invitation.%' OR p.action IN('access.replace','supervisor.set') OR p.action LIKE 'inventory.%' OR p.action='session-time.correct' OR EXISTS(SELECT 1 FROM public.audit_events domain_event WHERE domain_event.academy_id=NEW.academy_id AND domain_event.request_id=NEW.request_id AND domain_event.entity_id=p.target_id AND domain_event.action=p.action AND domain_event.created_at=transaction_timestamp() AND domain_event.changes->>'severity'='critical') THEN 'critical' ELSE 'normal' END;
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection)
 VALUES(NEW.academy_id,NEW.id,a.id,p.id,'approval',p.version,NEW.event_type,hub,at,
 jsonb_build_object('eventType',NEW.event_type,'entityId',p.id,'hubId',hub,'actorId',a.actor_id,'actorKind',a.actor_kind,'severity',severity,'occurredAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'attributes',jsonb_build_object('approvalId',p.id,'approvalVersion',p.version,'approvalStatus',p.status,'action',p.action)));
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 162 $$;

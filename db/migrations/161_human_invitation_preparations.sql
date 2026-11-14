INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('invitations.view','View permitted private onboarding requests','People',true,ARRAY['hub','person','country','region','city']),
 ('invitations.edit','Request approved invitations and retrieve private onboarding tokens','People',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.human_invitation_preparations(
 academy_id uuid NOT NULL,id uuid NOT NULL,person_id uuid NOT NULL,hub_id uuid,source_basis jsonb NOT NULL,
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX human_invitation_person ON public.human_invitation_preparations(academy_id,person_id,id);
ALTER TABLE public.human_invitation_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.human_invitation_preparations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.human_invitation_preparations USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.human_invitation_preparations TO kavosh_runtime;
GRANT INSERT(academy_id,id,person_id,hub_id,source_basis,changed_by,approval_id,reason) ON public.human_invitation_preparations TO kavosh_runtime;
CREATE TABLE identity.human_invitation_issues(academy_id uuid NOT NULL,preparation_id uuid NOT NULL,token_hash text NOT NULL CHECK(token_hash~'^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,issued_by uuid NOT NULL,issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,preparation_id),FOREIGN KEY(academy_id,preparation_id) REFERENCES public.human_invitation_preparations(academy_id,id),FOREIGN KEY(academy_id,issued_by) REFERENCES public.people(academy_id,id));
-- No token FK: normal expired-auth cleanup may remove an old identity.invites row.
CREATE FUNCTION public.human_invitation_basis(p_person uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('schoolStatus',a.status,'person',jsonb_build_object('id',p.id,'hubId',p.hub_id,'name',p.name,'email',lower(btrim(p.email)),'kind',p.kind,'status',p.status,'version',p.access_version,'identityBound',p.auth_user_id IS NOT NULL,'isMaster',p.id=a.master_person_id),
 'hub',CASE WHEN h.id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',h.id,'version',h.version,'active',h.active) END,
 'accessFingerprint',encode(sha256(convert_to(coalesce((SELECT jsonb_agg(jsonb_build_object('assignment',to_jsonb(x),'roleVersion',r.version,
 'permissions',(SELECT jsonb_agg(to_jsonb(rp) ORDER BY capability) FROM public.role_permissions rp WHERE rp.academy_id=x.academy_id AND rp.role_id=x.role_id),
 'hubs',(SELECT jsonb_agg(to_jsonb(s) ORDER BY hub_id) FROM public.assignment_hubs s WHERE s.academy_id=x.academy_id AND s.assignment_id=x.id),
 'classes',(SELECT jsonb_agg(to_jsonb(s) ORDER BY class_id) FROM public.assignment_classes s WHERE s.academy_id=x.academy_id AND s.assignment_id=x.id),
 'people',(SELECT jsonb_agg(to_jsonb(s) ORDER BY person_id) FROM public.assignment_people s WHERE s.academy_id=x.academy_id AND s.assignment_id=x.id),
 'geography',(SELECT jsonb_agg(to_jsonb(s) ORDER BY kind,id) FROM public.assignment_geography s WHERE s.academy_id=x.academy_id AND s.assignment_id=x.id)) ORDER BY x.id)
 FROM public.role_assignments x JOIN public.roles r ON r.academy_id=x.academy_id AND r.id=x.role_id WHERE x.academy_id=p.academy_id AND x.person_id=p.id),'[]'::jsonb)::text,'UTF8')),'hex'))
 FROM public.people p JOIN public.academies a ON a.id=p.academy_id LEFT JOIN public.hubs h ON h.academy_id=p.academy_id AND h.id=p.hub_id
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_person
$$;
CREATE FUNCTION public.guard_human_invitation_preparation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;actual jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'INVITATION_PREPARATION_IMMUTABLE' USING ERRCODE='23514';END IF;
 actual=public.human_invitation_basis(NEW.person_id);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF actual IS NULL OR actual IS DISTINCT FROM NEW.source_basis OR actual->>'schoolStatus'<>'active' OR actual#>>'{person,kind}'<>'human' OR actual#>>'{person,status}'<>'pending' OR actual#>>'{person,identityBound}'<>'false' OR actual#>>'{person,isMaster}'<>'false'
 OR actual#>>'{person,email}' IS NULL OR actual#>>'{person,email}'!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' OR(NEW.hub_id IS NOT NULL AND actual#>>'{hub,active}'<>'true') OR( actual#>>'{person,hubId}')::uuid IS DISTINCT FROM NEW.hub_id
 OR p.id IS NULL OR p.action<>'human-invitation.prepare' OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'invitations.view' OR p.review_context IS DISTINCT FROM actual
 OR(p.payload->>'personId')::uuid IS DISTINCT FROM NEW.person_id OR(p.payload->>'expectedPersonVersion')::integer IS DISTINCT FROM(actual#>>'{person,version}')::integer OR p.payload->>'reason' IS DISTINCT FROM NEW.reason
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'INVITATION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER human_invitation_preparation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.human_invitation_preparations FOR EACH ROW EXECUTE FUNCTION public.guard_human_invitation_preparation();
CREATE FUNCTION public.require_human_invitation_approval() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id AND status='applied' AND reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'INVITATION_APPROVAL_NOT_APPLIED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.id AND actor_id=NEW.changed_by AND action='human-invitation.prepare' AND created_at=transaction_timestamp() AND changes->>'approvalId'=NEW.approval_id::text AND changes->>'personId'=NEW.person_id::text) THEN RAISE EXCEPTION 'INVITATION_PREPARATION_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER human_invitation_approval_required AFTER INSERT ON public.human_invitation_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_human_invitation_approval();
CREATE FUNCTION public.require_human_invitation_token_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.human_invitation_preparations p ON p.academy_id=a.academy_id AND p.id=a.entity_id WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.preparation_id AND a.actor_id=NEW.issued_by AND a.action='human-invitation.token.issued' AND a.created_at=transaction_timestamp() AND a.changes->>'personId'=p.person_id::text) THEN RAISE EXCEPTION 'INVITATION_TOKEN_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER human_invitation_token_audit_required AFTER INSERT ON identity.human_invitation_issues DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_human_invitation_token_audit();
CREATE FUNCTION identity.immutable_human_invitation_issue() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'INVITATION_ISSUE_IMMUTABLE' USING ERRCODE='23514';END $$;
CREATE TRIGGER human_invitation_issue_immutable BEFORE UPDATE OR DELETE ON identity.human_invitation_issues FOR EACH ROW EXECUTE FUNCTION identity.immutable_human_invitation_issue();
CREATE FUNCTION public.issue_human_invitation(p_id uuid,p_actor uuid,p_session uuid,p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
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
CREATE FUNCTION public.human_invitation_issue_status(p_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('status',CASE WHEN c.preparation_id IS NULL THEN 'unissued' WHEN i.consumed_at IS NOT NULL THEN 'consumed' WHEN c.expires_at<=clock_timestamp() THEN 'expired' WHEN i.token_hash IS NULL THEN 'unavailable' WHEN i.expires_at<c.expires_at THEN 'superseded' ELSE 'active' END,'expiresAt',c.expires_at,'issuedAt',c.issued_at)
 FROM public.human_invitation_preparations p LEFT JOIN identity.human_invitation_issues c ON c.academy_id=p.academy_id AND c.preparation_id=p.id LEFT JOIN identity.invites i ON i.token_hash=c.token_hash AND i.academy_id=p.academy_id
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_id
$$;
GRANT SELECT ON public.human_invitation_preparations,public.approval_requests,public.role_assignments,public.roles,public.role_permissions,public.assignment_hubs,public.assignment_classes,public.assignment_people,public.assignment_geography,public.hubs TO kavosh_identity_policy;
GRANT SELECT ON public.geographic_areas,public.assignment_countries,public.assignment_regions,public.assignment_cities,public.countries,public.regions,public.cities TO kavosh_identity_policy;
GRANT SELECT ON public.audit_events TO kavosh_identity_policy;
GRANT SELECT,INSERT ON identity.human_invitation_issues TO kavosh_identity_policy;
GRANT INSERT ON identity.invites TO kavosh_identity_policy;
-- PostgreSQL requires an UPDATE column privilege for FOR SHARE; immutable
-- preparation triggers still forbid actual changes to approved records.
GRANT UPDATE(id) ON public.human_invitation_preparations TO kavosh_identity_policy;
ALTER FUNCTION public.issue_human_invitation(uuid,uuid,uuid,text) OWNER TO kavosh_identity_policy;
ALTER FUNCTION public.human_invitation_issue_status(uuid) OWNER TO kavosh_identity_policy;
REVOKE ALL ON FUNCTION public.human_invitation_basis(uuid),public.guard_human_invitation_preparation(),public.require_human_invitation_approval(),public.issue_human_invitation(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.human_invitation_basis(uuid) TO kavosh_runtime,kavosh_identity_policy;
GRANT EXECUTE ON FUNCTION public.issue_human_invitation(uuid,uuid,uuid,text) TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.human_invitation_issue_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.human_invitation_issue_status(uuid) TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.require_human_invitation_token_audit(),identity.immutable_human_invitation_issue() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 161 $$;

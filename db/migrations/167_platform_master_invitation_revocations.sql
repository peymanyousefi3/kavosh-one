-- Keep the original immutable issue receipt as the source,not a second token
-- catalogue. Its digest binds the derived token hash,original reason/version
-- and exact school. Older receipts lack that version and require reissuance.
CREATE INDEX platform_master_invitation_issue_key ON platform_private.audit_events(actor_user_id,request_key) WHERE action='platform.master.invitation.issued';
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('platform_private.issue_master_invitation(uuid,uuid,uuid,uuid,integer,text,text)'::regprocedure);
 needle='''email'',lower(btrim(person.email)),''expiresAt'',expires,''externalDeliveryPerformed'',false,''activationPerformed'',false';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PLATFORM_INVITATION_ISSUE_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,needle||',''invitationRequestKey'',p_key,''issuedAcademyVersion'',p_version');
END $$;
CREATE FUNCTION platform_private.revoke_master_invitation(p_user uuid,p_session uuid,p_key uuid,p_school uuid,p_version integer,p_issue_key uuid,p_hash text,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE academy public.academies;person public.people;prior record;issued record;issue_audit record;token identity.invites;fingerprint text;expected text;response jsonb;at timestamptz;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF p_key IS NULL OR p_school IS NULL OR p_version IS NULL OR p_version<1 OR p_issue_key IS NULL OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' OR p_reason IS NULL OR octet_length(p_reason)>8000 OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_school::text,8));PERFORM pg_advisory_xact_lock(hashtextextended(p_school::text,9));
 PERFORM platform_private.authorize_owner(p_user,p_session,true);
 fingerprint=encode(sha256(convert_to(jsonb_build_object('operation','academies.master-invitation.revoke','academyId',p_school,'expectedVersion',p_version,'invitationRequestKey',p_issue_key,'tokenHash',p_hash,'reason',p_reason)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));
 SELECT * INTO prior FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
 IF FOUND THEN IF prior.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;RETURN prior.result;END IF;
 SELECT * INTO academy FROM public.academies WHERE id=p_school FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF academy.platform_version<>p_version THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 SELECT * INTO person FROM public.people WHERE academy_id=p_school AND id=academy.master_person_id FOR UPDATE;
 IF NOT FOUND OR person.kind<>'human' OR person.status<>'pending' OR person.auth_user_id IS NOT NULL THEN RAISE EXCEPTION 'PLATFORM_MASTER_INVITATION_UNAVAILABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO issued FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_issue_key;
 IF NOT FOUND OR issued.result#>>'{body,data,academyId}' IS DISTINCT FROM p_school::text OR issued.result#>>'{body,data,masterPersonId}' IS DISTINCT FROM person.id::text THEN RAISE EXCEPTION 'PLATFORM_INVITATION_NO_LONGER_CURRENT' USING ERRCODE='23514';END IF;
 IF issued.result#>>'{body,data,invitationRequestKey}' IS DISTINCT FROM p_issue_key::text OR issued.result#>>'{body,data,issuedAcademyVersion}' IS NULL THEN RAISE EXCEPTION 'PLATFORM_INVITATION_REISSUE_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO issue_audit FROM platform_private.audit_events WHERE actor_user_id=p_user AND request_key=p_issue_key AND academy_id=p_school AND action='platform.master.invitation.issued';
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_INVITATION_NO_LONGER_CURRENT' USING ERRCODE='23514';END IF;
 expected=encode(sha256(convert_to(jsonb_build_object('operation','academies.master-invitation','academyId',p_school,'expectedVersion',(issued.result#>>'{body,data,issuedAcademyVersion}')::integer,'reason',issue_audit.reason,'tokenHash',p_hash)::text,'UTF8')),'hex');
 IF expected<>issued.fingerprint THEN RAISE EXCEPTION 'PLATFORM_INVITATION_NO_LONGER_CURRENT' USING ERRCODE='23514';END IF;
 SELECT * INTO token FROM identity.invites WHERE token_hash=p_hash AND academy_id=p_school AND person_id=person.id AND master FOR UPDATE;
 IF NOT FOUND OR token.consumed_at IS NOT NULL OR token.expires_at<=clock_timestamp() OR token.expires_at IS DISTINCT FROM(issued.result#>>'{body,data,expiresAt}')::timestamptz THEN RAISE EXCEPTION 'PLATFORM_INVITATION_NO_LONGER_CURRENT' USING ERRCODE='23514';END IF;
 at=clock_timestamp();UPDATE identity.invites SET expires_at=at WHERE token_hash=p_hash;
 response=jsonb_build_object('status',200,'body',jsonb_build_object('data',jsonb_build_object('academyId',p_school,'masterPersonId',person.id,'invitationRequestKey',p_issue_key,'revoked',true,'revokedAt',at,'accountsChanged',false,'externalDeliveryPerformed',false,'currentStateIncluded',false)));
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,request_key,action,academy_id,before_data,after_data,reason) VALUES(p_user,p_session,p_key,'platform.master.invitation.revoked',p_school,jsonb_build_object('invitationRequestKey',p_issue_key,'expiresAt',token.expires_at),response#>'{body,data}',p_reason);
 INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,response);RETURN response;
END $$;
GRANT USAGE,CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
ALTER FUNCTION platform_private.revoke_master_invitation(uuid,uuid,uuid,uuid,integer,uuid,text,text) OWNER TO kavosh_platform_policy;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.revoke_master_invitation(uuid,uuid,uuid,uuid,integer,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_private.revoke_master_invitation(uuid,uuid,uuid,uuid,integer,uuid,text,text) TO kavosh_platform_service;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 167 $$;

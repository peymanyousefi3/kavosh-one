-- Invitation secrets are derived in the trusted web process; only their HMAC
-- reaches PostgreSQL. Reuse the existing identity invitation/verification flow.
CREATE FUNCTION platform_private.issue_master_invitation(p_user uuid,p_session uuid,p_key uuid,p_school uuid,p_version integer,p_reason text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE academy public.academies;person public.people;old_receipt record;fingerprint text;response jsonb;expires timestamptz;replaced integer;
BEGIN
 PERFORM platform_private.authorize_owner(p_user,p_session);
 IF p_key IS NULL OR p_school IS NULL OR p_version IS NULL OR p_version<1 OR p_reason IS NULL OR octet_length(p_reason)>8000 OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 OR p_hash IS NULL OR p_hash!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_school::text,8));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_school::text,9));
 PERFORM platform_private.authorize_owner(p_user,p_session,true);
 fingerprint=encode(sha256(convert_to(jsonb_build_object('operation','academies.master-invitation','academyId',p_school,'expectedVersion',p_version,'reason',p_reason,'tokenHash',p_hash)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('platform-request:'||p_user::text||'/'||p_key::text,0));
 SELECT * INTO old_receipt FROM platform_private.request_receipts WHERE user_id=p_user AND request_key=p_key;
 IF FOUND AND old_receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'PLATFORM_IDEMPOTENCY_CONFLICT' USING ERRCODE='23514';END IF;
 SELECT * INTO academy FROM public.academies WHERE id=p_school FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF academy.status<>'provisioning' THEN RAISE EXCEPTION 'PLATFORM_MASTER_INVITATION_UNAVAILABLE' USING ERRCODE='23514';END IF;
 IF academy.platform_version<>p_version THEN RAISE EXCEPTION 'PLATFORM_ACADEMY_VERSION_CHANGED' USING ERRCODE='23514';END IF;
 SELECT * INTO person FROM public.people WHERE academy_id=p_school AND id=academy.master_person_id FOR UPDATE;
 IF NOT FOUND OR person.kind<>'human' OR person.status<>'pending' OR person.auth_user_id IS NOT NULL OR person.email IS NULL OR length(person.email)>254 OR person.email!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN RAISE EXCEPTION 'PLATFORM_MASTER_INVITATION_UNAVAILABLE' USING ERRCODE='23514';END IF;
 IF old_receipt.request_key IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM identity.invites WHERE token_hash=p_hash AND academy_id=p_school AND person_id=person.id AND email=lower(btrim(person.email)) AND master AND consumed_at IS NULL AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'PLATFORM_INVITATION_NO_LONGER_CURRENT' USING ERRCODE='23514';END IF;
  RETURN old_receipt.result;
 END IF;
 UPDATE identity.invites SET expires_at=clock_timestamp() WHERE academy_id=p_school AND person_id=person.id AND consumed_at IS NULL AND expires_at>clock_timestamp();GET DIAGNOSTICS replaced=ROW_COUNT;
 expires=clock_timestamp()+interval '48 hours';
 INSERT INTO identity.invites(token_hash,academy_id,person_id,email,master,expires_at) VALUES(p_hash,p_school,person.id,lower(btrim(person.email)),true,expires);
 response=jsonb_build_object('status',201,'body',jsonb_build_object('data',jsonb_build_object('academyId',p_school,'masterPersonId',person.id,'email',lower(btrim(person.email)),'expiresAt',expires,'externalDeliveryPerformed',false,'activationPerformed',false)));
 INSERT INTO platform_private.audit_events(actor_user_id,session_id,request_key,action,academy_id,before_data,after_data,reason) VALUES(p_user,p_session,p_key,'platform.master.invitation.issued',p_school,jsonb_build_object('replacedUnconsumedInvites',replaced),jsonb_build_object('masterPersonId',person.id,'expiresAt',expires,'activationPerformed',false),p_reason);
 INSERT INTO platform_private.request_receipts(user_id,request_key,fingerprint,result) VALUES(p_user,p_key,fingerprint,response);
 RETURN response;
END $$;
GRANT SELECT,INSERT ON identity.invites TO kavosh_platform_policy;
GRANT UPDATE(expires_at) ON identity.invites TO kavosh_platform_policy;
GRANT UPDATE(id) ON public.people TO kavosh_platform_policy;
GRANT USAGE,CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
ALTER FUNCTION platform_private.issue_master_invitation(uuid,uuid,uuid,uuid,integer,text,text) OWNER TO kavosh_platform_policy;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
REVOKE ALL ON FUNCTION platform_private.issue_master_invitation(uuid,uuid,uuid,uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_private.issue_master_invitation(uuid,uuid,uuid,uuid,integer,text,text) TO kavosh_platform_service;
CREATE OR REPLACE FUNCTION identity.accept_invite(p_hash text,p_user uuid,p_session uuid)
RETURNS TABLE(academy_id uuid,code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i identity.invites; u identity."user"; role_id uuid; person public.people; BEGIN
  -- Serialize identity activation with platform status and invite replacement.
  SELECT * INTO u FROM identity."user" WHERE id=p_user;
  IF NOT FOUND OR NOT u."emailVerified" OR NOT coalesce(u."phoneNumberVerified",false) THEN RETURN QUERY SELECT NULL::uuid,'VERIFICATION_REQUIRED'::text; RETURN; END IF;
  SELECT * INTO i FROM identity.invites v WHERE v.token_hash=p_hash AND v.email=lower(u.email) AND v.consumed_at IS NULL AND v.expires_at>clock_timestamp();
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid,'INVALID_INVITATION'::text; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(i.academy_id::text,8));
  PERFORM pg_advisory_xact_lock(hashtextextended(i.academy_id::text,9));
  SELECT * INTO u FROM identity."user" WHERE id=p_user FOR UPDATE;
  IF NOT FOUND OR NOT u."emailVerified" OR NOT coalesce(u."phoneNumberVerified",false) THEN RETURN QUERY SELECT NULL::uuid,'VERIFICATION_REQUIRED'::text; RETURN; END IF;
  SELECT * INTO i FROM identity.invites WHERE token_hash=p_hash AND email=lower(u.email)
    AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid,'INVALID_INVITATION'::text; RETURN; END IF;
  PERFORM 1 FROM public.academies a WHERE a.id=i.academy_id AND (a.status='active' OR (a.status='provisioning' AND i.master)) FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid,'ACADEMY_UNAVAILABLE'::text; RETURN; END IF;
  IF i.master AND NOT u."mfaRequired" THEN
    UPDATE identity."user" SET "mfaRequired"=true WHERE id=p_user;
    RETURN QUERY SELECT NULL::uuid,'MFA_REQUIRED'::text; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM identity.session s WHERE s.id=p_session AND s."userId"=p_user AND (NOT coalesce(u."twoFactorEnabled",false) OR s."mfaVerified") AND s."expiresAt">clock_timestamp()) THEN
    RETURN QUERY SELECT NULL::uuid,'MFA_REQUIRED'::text; RETURN;
  END IF;
  SELECT * INTO person FROM public.people WHERE public.people.academy_id=i.academy_id AND id=i.person_id FOR UPDATE;
  IF person.status='disabled' OR (person.auth_user_id IS NOT NULL AND person.auth_user_id<>p_user) THEN RETURN QUERY SELECT NULL::uuid,'INVALID_INVITATION'::text; RETURN; END IF;
  UPDATE public.people SET auth_user_id=p_user,status='active' WHERE public.people.academy_id=i.academy_id AND id=i.person_id;
  UPDATE identity.invites SET consumed_at=clock_timestamp() WHERE token_hash=p_hash;
  IF i.master THEN
    IF NOT EXISTS(SELECT 1 FROM public.academies a WHERE a.id=i.academy_id AND a.master_person_id=i.person_id) THEN RAISE EXCEPTION 'Invalid master invitation'; END IF;
    SELECT id INTO role_id FROM public.roles r WHERE r.academy_id=i.academy_id AND name='Academy master';
    IF role_id IS NULL THEN
      role_id:=gen_random_uuid(); INSERT INTO public.roles VALUES(i.academy_id,role_id,'Academy master');
      INSERT INTO public.role_permissions SELECT i.academy_id,role_id,c,'allow' FROM unnest(ARRAY['hubs.view','hubs.edit','people.view','people.edit','audit.view','credentials.revoke']) c;
    END IF;
    INSERT INTO public.role_assignments VALUES(i.academy_id,gen_random_uuid(),i.person_id,role_id,true) ON CONFLICT DO NOTHING;
    UPDATE public.academies SET status='active' WHERE id=i.academy_id AND status='provisioning';
  END IF;
  INSERT INTO identity.security_events(user_id,event) VALUES(p_user,'invitation.accepted');
  INSERT INTO public.audit_events(academy_id,id,actor_id,session_id,actor_kind,request_id,action,entity_id,changes)
    VALUES(i.academy_id,gen_random_uuid(),person.id,p_session,'human',gen_random_uuid(),'invitation.accepted',person.id,
      jsonb_build_object('status',jsonb_build_object('before',person.status,'after','active'),'identityBound',true));
  INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id)
    VALUES(i.academy_id,gen_random_uuid(),'invitation.accepted',person.id,gen_random_uuid());
  RETURN QUERY SELECT i.academy_id,'ACCEPTED'::text;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 159 $$;

-- Share verified identity state instead of blocking ordinary signed-in work.
-- An invitation never transfers/rebinds an existing school identity.
CREATE OR REPLACE FUNCTION identity.accept_invite(p_hash text,p_user uuid,p_session uuid)
RETURNS TABLE(academy_id uuid,code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i identity.invites; u identity."user"; role_id uuid; person public.people; BEGIN
  -- Serialize identity activation with platform status and invite replacement.
  SELECT * INTO u FROM identity."user" WHERE id=p_user;
  IF NOT FOUND OR NOT u."emailVerified" OR NOT coalesce(u."phoneNumberVerified",false) THEN RETURN QUERY SELECT NULL::uuid,'VERIFICATION_REQUIRED'::text; RETURN; END IF;
  SELECT * INTO i FROM identity.invites v WHERE v.token_hash=p_hash AND v.email=lower(u.email) AND v.consumed_at IS NULL AND v.expires_at>clock_timestamp();
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid,'INVALID_INVITATION'::text; RETURN; END IF;
  PERFORM 1 FROM public.academies a JOIN public.people p ON p.academy_id=a.id AND p.id=i.person_id
  WHERE a.id=i.academy_id AND (a.master_person_id=i.person_id)=i.master AND p.kind='human' AND p.status<>'disabled' AND lower(btrim(p.email))=i.email;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid,'INVALID_INVITATION'::text; RETURN; END IF;
  PERFORM 1 FROM public.academies a WHERE a.id=i.academy_id AND(a.status='active' OR(a.status='provisioning' AND i.master));
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid,'ACADEMY_UNAVAILABLE'::text; RETURN; END IF;
  IF EXISTS(SELECT 1 FROM public.people p WHERE p.academy_id=i.academy_id AND ((p.id=i.person_id AND p.auth_user_id IS NOT NULL) OR(p.auth_user_id=p_user AND p.id<>i.person_id))) THEN RETURN QUERY SELECT NULL::uuid,'INVALID_INVITATION'::text; RETURN; END IF;
  -- Enabling mandatory MFA revokes sessions. Do that identity-only transition
  -- before academy gates; never upgrade a shared user lock while holding them.
  IF i.master AND NOT u."mfaRequired" THEN
    UPDATE identity."user" SET "mfaRequired"=true WHERE id=p_user AND "emailVerified" AND coalesce("phoneNumberVerified",false) AND NOT "mfaRequired";
    RETURN QUERY SELECT NULL::uuid,'MFA_REQUIRED'::text; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(i.academy_id::text,8));
  PERFORM pg_advisory_xact_lock(hashtextextended(i.academy_id::text,9));
  IF EXISTS(SELECT 1 FROM public.people p WHERE p.academy_id=i.academy_id AND ((p.id=i.person_id AND p.auth_user_id IS NOT NULL) OR(p.auth_user_id=p_user AND p.id<>i.person_id))) THEN RETURN QUERY SELECT NULL::uuid,'INVALID_INVITATION'::text; RETURN; END IF;
  SELECT * INTO u FROM identity."user" WHERE id=p_user FOR SHARE;
  IF NOT FOUND OR NOT u."emailVerified" OR NOT coalesce(u."phoneNumberVerified",false) THEN RETURN QUERY SELECT NULL::uuid,'VERIFICATION_REQUIRED'::text; RETURN; END IF;
  SELECT * INTO i FROM identity.invites WHERE token_hash=p_hash AND email=lower(u.email)
    AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid,'INVALID_INVITATION'::text; RETURN; END IF;
  PERFORM 1 FROM public.academies a WHERE a.id=i.academy_id AND (a.status='active' OR (a.status='provisioning' AND i.master)) FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid,'ACADEMY_UNAVAILABLE'::text; RETURN; END IF;
  IF i.master AND NOT u."mfaRequired" THEN
    RETURN QUERY SELECT NULL::uuid,'MFA_REQUIRED'::text; RETURN;
  END IF;
  PERFORM 1 FROM identity.session s WHERE s.id=p_session AND s."userId"=p_user AND (NOT coalesce(u."twoFactorEnabled",false) OR s."mfaVerified") AND s."expiresAt">clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid,'MFA_REQUIRED'::text; RETURN;
  END IF;
  SELECT * INTO person FROM public.people WHERE public.people.academy_id=i.academy_id AND id=i.person_id FOR UPDATE;
  IF NOT FOUND OR person.status='disabled' OR person.auth_user_id IS NOT NULL OR lower(btrim(person.email)) IS DISTINCT FROM i.email THEN RETURN QUERY SELECT NULL::uuid,'INVALID_INVITATION'::text; RETURN; END IF;
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
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 160 $$;

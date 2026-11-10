-- Reuse the bounded verification fingerprint,not a raw contact read,when
-- evaluating private guardian authority. Keep existing basis bytes unchanged.
DO $$ DECLARE d text;updated text;BEGIN
 d=pg_get_functiondef('public.work_guardian_basis(uuid,uuid)'::regprocedure);
 updated=replace(d,'coalesce(c.account_active AND c.email_verified AND c.phone_verified,false)','public.work_signer_verification(g.id) IS NOT NULL');
 updated=replace(updated,'LEFT JOIN LATERAL public.guardian_contact_status(g.id) c ON true','');
 IF updated=d THEN RAISE EXCEPTION 'GUARDIAN_CONTACT_VERIFICATION_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.work_guardian_signer_source(uuid,uuid,integer,text,text)'::regprocedure);
 updated=replace(d,'signer jsonb;BEGIN','signer jsonb;checked_at timestamptz;BEGIN');
 updated=replace(updated,$q$ SELECT * INTO r FROM public.work_guardian_revisions$q$,$r$ PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));checked_at=clock_timestamp();
 SELECT * INTO r FROM public.work_guardian_revisions$r$);
 updated=replace(updated,'statement_timestamp()','checked_at');
 updated=replace(updated,'SELECT * INTO g FROM public.guardian_profiles','SELECT person_id,legal_name,version INTO g FROM public.guardian_profiles');
 updated=replace(updated,$q$OR b-ARRAY['before','version']$q$,$r$OR b->>'version' IS DISTINCT FROM r.version::text OR b#>>'{before,approvalId}' IS DISTINCT FROM r.approval_id::text OR b#>>'{before,state}' IS DISTINCT FROM 'approved'
 OR b-ARRAY['before','version']$r$);
 IF updated=d OR strpos(updated,'checked_at=clock_timestamp()')=0 THEN RAISE EXCEPTION 'GUARDIAN_CONTACT_CURRENT_PROOF_UPGRADE_MISMATCH';END IF;EXECUTE updated;
END $$;
-- The existing consent policy already holds worker DOB;the contact policy
-- receives only EXECUTE on the narrow current guardian projection,not DOB or
-- private association/review tables. No service login receives new reads.
GRANT SELECT ON public.work_guardian_revisions TO kavosh_signature_evidence_policy;
GRANT SELECT(academy_id,person_id,version,legal_name) ON public.guardian_profiles TO kavosh_signature_evidence_policy;
GRANT EXECUTE ON FUNCTION public.work_signer_verification(uuid),public.work_guardian_basis(uuid,uuid) TO kavosh_signature_evidence_policy;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.work_guardian_signer_source(uuid,uuid,integer,text,text) SECURITY DEFINER;
ALTER FUNCTION public.work_guardian_signer_source(uuid,uuid,integer,text,text) VOLATILE;
ALTER FUNCTION public.work_guardian_signer_source(uuid,uuid,integer,text,text) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
GRANT EXECUTE ON FUNCTION public.work_guardian_signer_source(uuid,uuid,integer,text,text) TO kavosh_identity_policy;
CREATE OR REPLACE FUNCTION public.work_signature_dispatch_contacts(p_request uuid)
RETURNS TABLE(party_role text,person_id uuid,legal_name text,email text,phone_e164 text,contact_fingerprint text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH selected_request AS MATERIALIZED(
  SELECT r.academy_id,r.id,r.academy_signer_legal_name,w.worker_id,w.academy_signer_id,w.source_snapshot
  FROM public.work_signature_send_requests r JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id
  JOIN public.approval_requests a ON a.academy_id=r.academy_id AND a.id=r.approval_id AND a.status='applied' AND a.action='work.signature.send.request' AND a.target_id=r.id AND a.reviewer_id=r.created_by
  WHERE r.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND r.id=p_request AND r.authorization_until>statement_timestamp()
   AND NOT EXISTS(SELECT 1 FROM public.work_signature_send_cancellations c WHERE c.academy_id=r.academy_id AND c.request_id=r.id)
   AND NOT EXISTS(SELECT 1 FROM public.work_signature_send_requests next WHERE next.academy_id=r.academy_id AND next.prior_id=r.id)
   AND(NOT(w.source_snapshot ? 'guardianSigner') OR public.work_guardian_signer_source(w.worker_id,(w.source_snapshot#>>'{guardianSigner,personId}')::uuid,(w.source_snapshot#>>'{guardianSigner,authority,version}')::integer,w.source_snapshot#>>'{engagement,legalWorkerName}',w.source_snapshot#>>'{engagement,timeZone}') IS NOT DISTINCT FROM w.source_snapshot->'guardianSigner')
 ),contacts AS MATERIALIZED(
  SELECT party.role,party.person_id,party.legal_name,u.email,u."phoneNumber" phone,party.fingerprint,CASE WHEN r.source_snapshot ? 'guardianSigner' THEN 3 ELSE 2 END required_count
  FROM selected_request r
  CROSS JOIN LATERAL(VALUES('worker'::text,r.worker_id,r.source_snapshot#>>'{engagement,legalWorkerName}',r.source_snapshot#>>'{workerSigner,contactFingerprint}'),('academy_representative'::text,r.academy_signer_id,r.academy_signer_legal_name,r.source_snapshot#>>'{academySigner,contactFingerprint}'),('legal_guardian'::text,(r.source_snapshot#>>'{guardianSigner,personId}')::uuid,r.source_snapshot#>>'{guardianSigner,legalName}',r.source_snapshot#>>'{guardianSigner,contactFingerprint}')) party(role,person_id,legal_name,fingerprint)
  JOIN public.people p ON p.academy_id=r.academy_id AND p.id=party.person_id AND p.kind='human' AND p.status='active'
  JOIN identity."user" u ON u.id=p.auth_user_id AND u."emailVerified" AND u."phoneNumberVerified" AND u."phoneNumber"~'^[+][1-9][0-9]{7,14}$'
  WHERE party.legal_name IS NOT NULL AND length(btrim(party.legal_name)) BETWEEN 1 AND 200
   AND party.fingerprint=encode(sha256(convert_to(jsonb_build_array(1,r.academy_id,p.id,u.id,u.email,u."phoneNumber",u."emailVerified",u."phoneNumberVerified")::text,'UTF8')),'hex')
 ) SELECT role,person_id,legal_name,email,phone,fingerprint FROM contacts WHERE(SELECT count(*) FROM contacts)=required_count
 AND(required_count=2 OR((SELECT count(DISTINCT lower(email)) FROM contacts)=3 AND(SELECT count(DISTINCT phone) FROM contacts)=3 AND(SELECT count(DISTINCT person_id) FROM contacts)=3)) ORDER BY role
$$;
DO $$ DECLARE d text;updated text;BEGIN
 -- Reviewed intentions and private previews may now contain three parties.
 -- Actual starts remain blocked independently below until completion support.
 d=pg_get_functiondef('public.work_signature_send_source(uuid,uuid,uuid)'::regprocedure);
 updated=replace(d,$q$IF s IS NULL OR s#>>'{content,routing,version}'='3' THEN RETURN NULL;END IF;$q$,'IF s IS NULL THEN RETURN NULL;END IF;');
 IF updated=d THEN RAISE EXCEPTION 'GUARDIAN_CONTACT_INTENTION_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.work_signature_send_privacy()'::regprocedure);
 updated=replace(d,'END IF;RETURN NEW;',$r$END IF;
 IF w.source_snapshot ? 'guardianSigner' THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','worker-guardians.view','personId',w.worker_id),jsonb_build_object('capability','guardians.view','personId',w.source_snapshot#>>'{guardianSigner,personId}'));END IF;
 RETURN NEW;$r$);
 IF updated=d THEN RAISE EXCEPTION 'GUARDIAN_CONTACT_INTENTION_PRIVACY_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.work_signature_dispatch_guard()'::regprocedure);
 updated=replace(d,$q$IF a.id IS NULL OR r.id IS NULL THEN$q$,$r$IF TG_TABLE_NAME='work_signature_dispatch_starts' AND r.context#>>'{source,content,content,routing,version}'='3' THEN RAISE EXCEPTION 'WORK_GUARDIAN_DISPATCH_NOT_ENABLED' USING ERRCODE='23514';END IF;
 IF a.id IS NULL OR r.id IS NULL THEN$r$);
 IF updated=d THEN RAISE EXCEPTION 'GUARDIAN_CONTACT_START_GATE_UPGRADE_MISMATCH';END IF;EXECUTE updated;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 350 $$;

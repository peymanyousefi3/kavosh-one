-- Pin genuine reviewed guardian authority into the SAME worker framework.
-- This is preparation,not a third signature or positive profile consent.
CREATE FUNCTION public.work_guardian_signer_source(p_worker uuid,p_guardian uuid,p_version integer,p_name text,p_zone text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r record;i record;g record;b jsonb;signer jsonb;BEGIN
 IF tenant IS NULL OR p_worker IS NULL OR p_guardian IS NULL OR p_worker=p_guardian OR p_version IS NULL OR p_name IS NULL OR p_zone IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO r FROM public.work_guardian_revisions WHERE academy_id=tenant AND worker_id=p_worker AND guardian_id=p_guardian ORDER BY version DESC LIMIT 1;
 SELECT * INTO i FROM public.work_identity_revisions WHERE academy_id=tenant AND person_id=p_worker ORDER BY version DESC LIMIT 1;
 SELECT * INTO g FROM public.guardian_profiles WHERE academy_id=tenant AND person_id=p_guardian;
 b=public.work_guardian_basis(p_worker,p_guardian);signer=public.work_signer_verification(p_guardian);
 IF r.version IS NULL OR r.version<>p_version OR r.state<>'approved' OR NOT r.authority_reviewed OR r.valid_from>statement_timestamp() OR(r.valid_until IS NOT NULL AND r.valid_until<=statement_timestamp())
 OR i.state IS DISTINCT FROM 'recorded' OR i.legal_name IS DISTINCT FROM p_name OR public.signature_signing_requires_guardian(i.date_of_birth,statement_timestamp(),p_zone) IS DISTINCT FROM true
 OR g.person_id IS NULL OR signer IS NULL OR b IS NULL OR b->'studentIdentityPresent' IS DISTINCT FROM 'false'::jsonb OR b->>'workerStatus' IS DISTINCT FROM 'active'
 OR b-ARRAY['before','version'] IS DISTINCT FROM r.source_basis-ARRAY['before','version']
 OR NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=tenant AND a.id=i.approval_id AND a.status='applied' AND a.action='work.identity.change' AND a.target_id=p_worker AND a.target_version=i.version-1 AND a.reviewer_id=i.changed_by AND a.privacy_capability='work-identity.view' AND a.review_context=i.source_basis AND a.scope=i.source_basis->'scope'
 AND a.payload=jsonb_build_object('expectedVersion',i.version-1,'state',i.state,'legalName',i.legal_name,'dateOfBirth',to_char(i.date_of_birth,'YYYY-MM-DD'),'reason',i.reason))
 OR NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=tenant AND a.id=r.approval_id AND a.status='applied' AND a.action='work.guardian.change' AND a.target_id=p_worker AND a.target_version=r.version-1 AND a.reviewer_id=r.changed_by AND a.privacy_capability='worker-guardians.view' AND a.scope=r.source_basis->'scope' AND a.review_context=r.source_basis
 AND a.payload=jsonb_build_object('guardianId',r.guardian_id,'expectedVersion',r.version-1,'state',r.state,'relationship',r.relationship,'validFrom',to_char(r.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'validUntil',to_char(r.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'authorityReviewed',r.authority_reviewed,'reason',r.reason)) THEN RETURN NULL;END IF;
 RETURN signer||jsonb_build_object('legalName',g.legal_name,'profileVersion',g.version,'authority',jsonb_build_object('version',r.version,'approvalId',r.approval_id,'relationship',r.relationship,'validFrom',to_char(r.valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'validUntil',to_char(r.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'workerIdentityVersion',i.version,'workerIdentityApprovalId',i.approval_id));
END $$;
REVOKE ALL ON FUNCTION public.work_guardian_signer_source(uuid,uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_guardian_signer_source(uuid,uuid,integer,text,text) TO kavosh_runtime;
DO $$ DECLARE d text;updated text;BEGIN
 d=pg_get_functiondef('public.work_agreement_input_valid(jsonb)'::regprocedure);
 updated=replace(d,$q$BEGIN
 IF jsonb_typeof(i)$q$,$r$BEGIN
 IF i ? 'guardianId' THEN
  keys=keys||ARRAY['guardianId','guardianAuthorityVersion','guardianAuthorityReview'];
  IF jsonb_typeof(i->'guardianId') IS DISTINCT FROM 'string' OR(i->>'guardianId')::uuid::text IS DISTINCT FROM i->>'guardianId' OR jsonb_typeof(i->'guardianAuthorityVersion') IS DISTINCT FROM 'number' OR(i->>'guardianAuthorityVersion')::numeric NOT BETWEEN 1 AND 2147483647 OR(i->>'guardianAuthorityVersion')::numeric<>trunc((i->>'guardianAuthorityVersion')::numeric) OR jsonb_typeof(i->'guardianAuthorityReview') IS DISTINCT FROM 'string' OR length(btrim(i->>'guardianAuthorityReview')) NOT BETWEEN 1 AND 2000 THEN RETURN false;END IF;
 END IF;
 IF jsonb_typeof(i)$r$);
 IF updated=d THEN RAISE EXCEPTION 'GUARDIAN_WORK_INPUT_UPGRADE_MISMATCH';END IF;
 updated=replace(updated,'octet_length(i::text)>16384', 'octet_length(i::text)>(CASE WHEN i ? ''guardianId'' THEN 32768 ELSE 16384 END)');EXECUTE updated;
 d=pg_get_functiondef('public.work_agreement_source(jsonb)'::regprocedure);
 updated=replace(d,'worker jsonb;representative jsonb;','worker jsonb;representative jsonb;guardian jsonb;');
 updated=replace(updated,$q$ RETURN jsonb_build_object('engagement',$q$,$r$ IF i ? 'guardianId' THEN
  IF (i->>'guardianId')::uuid=(i->>'academySignerId')::uuid THEN RETURN NULL;END IF;
  guardian=public.work_guardian_signer_source(e.person_id,(i->>'guardianId')::uuid,(i->>'guardianAuthorityVersion')::integer,e.definition->>'legalWorkerName',e.definition->>'timeZone');IF guardian IS NULL THEN RETURN NULL;END IF;
 ELSIF(SELECT public.signature_signing_requires_guardian(coalesce(s.date_of_birth,identity.date_of_birth),statement_timestamp(),e.definition->>'timeZone') FROM public.people person
 LEFT JOIN public.student_profiles s ON s.academy_id=person.academy_id AND s.person_id=person.id
 LEFT JOIN LATERAL(SELECT CASE WHEN state='recorded' THEN date_of_birth END date_of_birth FROM public.work_identity_revisions WHERE academy_id=person.academy_id AND person_id=person.id ORDER BY version DESC LIMIT 1) identity ON true
 WHERE person.academy_id=tenant AND person.id=e.person_id) IS TRUE THEN
  -- Do not bypass a known minor by omitting the guardian selector or by using
  -- an older worker DOB when a canonical student identity exists.
  RETURN NULL;
 END IF;
 RETURN jsonb_build_object('engagement',$r$);
 updated=replace(updated,$q$'clientId',c.client_id));$q$,$r$'clientId',c.client_id))||CASE WHEN guardian IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('guardianSigner',guardian) END;$r$);
 IF updated=d OR strpos(updated,'guardian=public.work_guardian_signer_source')=0 OR strpos(updated,$q$jsonb_build_object('guardianSigner',guardian)$q$)=0 THEN RAISE EXCEPTION 'GUARDIAN_WORK_SOURCE_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.work_agreement_privacy()'::regprocedure);
 updated=replace(d,'END IF;RETURN NEW;',$r$END IF;
 IF NEW.payload ? 'guardianId' THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','worker-guardians.view','personId',s#>>'{people,0,id}'),jsonb_build_object('capability','guardians.view','personId',NEW.payload->>'guardianId'));END IF;
 RETURN NEW;$r$);
 IF updated=d THEN RAISE EXCEPTION 'GUARDIAN_WORK_PRIVACY_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 -- The next routing/dispatch extension must require all THREE original
 -- signers. Never attach a two-party PDF or send using the old two contacts.
 d=pg_get_functiondef('public.work_agreement_content_source(jsonb)'::regprocedure);
 updated=replace(d,'IF w.id IS NULL THEN RETURN NULL;END IF;',$r$IF w.id IS NULL OR w.source_snapshot ? 'guardianSigner' THEN RETURN NULL;END IF;$r$);
 IF updated=d THEN RAISE EXCEPTION 'GUARDIAN_WORK_CONTENT_GATE_UPGRADE_MISMATCH';END IF;EXECUTE updated;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 348 $$;

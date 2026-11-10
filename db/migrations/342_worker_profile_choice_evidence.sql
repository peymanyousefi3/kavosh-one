-- Observe only the original worker's optional fields,after the existing
-- recorder has independently matched BOTH original dispatch-time signers.
-- A completed work signature or observed checkbox is NOT a publication grant.
CREATE FUNCTION public.observe_work_profile_consent_choices(s jsonb,p jsonb,signers jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE routing jsonb;fields jsonb;worker uuid;properties jsonb;BEGIN
 SELECT source_snapshot->'routing' INTO routing FROM public.work_agreement_contents WHERE academy_id=(s->>'academyId')::uuid AND id=(s->>'bindingId')::uuid AND preparation_id=(s->>'preparationId')::uuid;
 IF routing IS NULL OR routing->'version' IS DISTINCT FROM '2'::jsonb THEN RETURN '[]'::jsonb;END IF;
 SELECT jsonb_agg(jsonb_build_object('id',f->'id','pageNumber',f->'pageNumber','bounds',f->'bounds','purpose',f->'consentPurpose') ORDER BY f->>'id') INTO fields FROM jsonb_array_elements(routing->'parties') party CROSS JOIN LATERAL jsonb_array_elements(party->'fields') f WHERE party->>'role'='worker' AND f->'isRequired'='false'::jsonb;
 IF fields IS NULL OR jsonb_array_length(fields) NOT BETWEEN 1 AND 2 OR(SELECT count(*) FROM jsonb_array_elements(signers) x WHERE x->>'role'='worker')<>1 THEN RAISE EXCEPTION 'WORK_PROFILE_CONSENT_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 SELECT(x->>'providerSignerId')::uuid INTO worker FROM jsonb_array_elements(signers) x WHERE x->>'role'='worker';
 IF(SELECT count(*) FROM jsonb_array_elements(p->'signerDetails') x WHERE(x->>'id')::uuid=worker)<>1 THEN RAISE EXCEPTION 'WORK_PROFILE_CONSENT_SIGNER_INVALID' USING ERRCODE='23514';END IF;
 SELECT x INTO properties FROM jsonb_array_elements(p->'signerDetails') x WHERE(x->>'id')::uuid=worker;
 RETURN public.observe_profile_consent_choices(jsonb_build_object('consentFields',fields),jsonb_build_object('signerDetails',jsonb_build_array(properties)));
END $$;
REVOKE ALL ON FUNCTION public.observe_work_profile_consent_choices(jsonb,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.observe_work_profile_consent_choices(jsonb,jsonb,jsonb) TO kavosh_signature_completion_policy;
ALTER TABLE public.work_signature_completion_evidence ADD COLUMN profile_consent_observations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(profile_consent_observations)='array' AND jsonb_array_length(profile_consent_observations)<=2);
DO $$ DECLARE constraint_name text;d text;needle text;BEGIN
 SELECT conname INTO constraint_name FROM pg_constraint WHERE conrelid='public.work_signature_completion_evidence'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%evidence_fingerprint%encode%';IF constraint_name IS NULL THEN RAISE EXCEPTION 'WORK_PROFILE_FINGERPRINT_CHECK_CHANGED';END IF;
 EXECUTE format('ALTER TABLE public.work_signature_completion_evidence DROP CONSTRAINT %I',constraint_name);
 d=pg_get_functiondef('public.record_work_signature_completion_evidence(uuid,uuid,text,text,jsonb)'::regprocedure);
 needle='fp text;signer_id uuid;';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'WORK_PROFILE_EVIDENCE_DECLARATION_CHANGED';END IF;d=replace(d,needle,'observations jsonb;fp text;signer_id uuid;');
 needle=$q$fp=encode(sha256(convert_to(jsonb_build_array(s,p_manifest,provider_signers,to_jsonb(reasons))::text,'UTF8')),'hex');$q$;IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'WORK_PROFILE_EVIDENCE_HASH_CHANGED';END IF;
 d=replace(d,needle,$r$observations=public.observe_work_profile_consent_choices(s,p,provider_signers);fp=encode(sha256(convert_to((jsonb_build_array(s,p_manifest,provider_signers,to_jsonb(reasons))||CASE WHEN observations='[]'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(observations) END)::text,'UTF8')),'hex');$r$);
 needle='review_reasons,state,evidence_fingerprint)';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'WORK_PROFILE_EVIDENCE_COLUMNS_CHANGED';END IF;d=replace(d,needle,'review_reasons,state,evidence_fingerprint,profile_consent_observations)');
 needle='p_manifest,provider_signers,reasons,new_state,fp) ON CONFLICT';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'WORK_PROFILE_EVIDENCE_VALUES_CHANGED';END IF;EXECUTE replace(d,needle,'p_manifest,provider_signers,reasons,new_state,fp,observations) ON CONFLICT');
END $$;
ALTER TABLE public.work_signature_completion_evidence ADD CONSTRAINT work_profile_consent_fingerprint CHECK(evidence_fingerprint=encode(sha256(convert_to((jsonb_build_array(source,manifest,provider_signers,to_jsonb(review_reasons))||CASE WHEN profile_consent_observations='[]'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(profile_consent_observations) END)::text,'UTF8')),'hex'));
-- Existing rows deliberately remain [],not inferred positives. Version1
-- fingerprints/source bytes are unchanged. Old version2 evidence can receive
-- a NEW independently observed row;never rewrite its old contract evidence.
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 342 $$;

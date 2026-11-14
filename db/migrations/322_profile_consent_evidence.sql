-- Bind optional questions to the original reviewed geometry and retained
-- provider-properties bytes. A selection is NOT consent or publication access.
DO $$ DECLARE d text;updated text;BEGIN
 d=pg_get_functiondef('public.signature_completion_source(uuid,uuid)'::regprocedure);
 updated=replace(d,$old$WHERE lower(f->>'fieldType')='signature')) source$old$,$new$WHERE lower(f->>'fieldType')='signature'))
 ||CASE WHEN b.routing->'version'='2'::jsonb THEN jsonb_build_object('consentFields',(SELECT jsonb_agg(jsonb_build_object('id',f->>'id','pageNumber',f->'pageNumber','bounds',f->'bounds','purpose',f->>'consentPurpose') ORDER BY f->>'id') FROM jsonb_array_elements(b.routing->'fields') f WHERE f->'isRequired'='false'::jsonb)) ELSE '{}'::jsonb END source$new$);
 IF updated=d THEN RAISE EXCEPTION 'PROFILE_CONSENT_SOURCE_UPGRADE_MISMATCH';END IF;EXECUTE updated;
END $$;
CREATE FUNCTION public.observe_profile_consent_choices(s jsonb,p jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE o jsonb;f jsonb;fields jsonb;matches integer;choice text;observations jsonb:='[]'::jsonb;BEGIN
 IF NOT(s?'consentFields') THEN RETURN observations;END IF;
 IF jsonb_typeof(s->'consentFields') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'consentFields') NOT BETWEEN 1 AND 2 THEN RAISE EXCEPTION 'PROFILE_CONSENT_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 fields=CASE WHEN jsonb_typeof(p#>'{signerDetails,0,formFields}')='array' THEN p#>'{signerDetails,0,formFields}' ELSE '[]'::jsonb END;
 FOR o IN SELECT * FROM jsonb_array_elements(s->'consentFields') LOOP
  choice='unverified';SELECT count(*) INTO matches FROM jsonb_array_elements(fields) x WHERE x->'id'=o->'id';
  IF matches=1 THEN
   SELECT x INTO f FROM jsonb_array_elements(fields) x WHERE x->'id'=o->'id';
   IF lower(f->>'type')='checkbox' AND f->'pageNumber'=o->'pageNumber' AND f->'bounds'=o->'bounds' AND f->'isRequired'='false'::jsonb AND f->'isReadOnly'='false'::jsonb THEN
    choice=CASE WHEN f->'value'='"on"'::jsonb THEN 'selected' WHEN f->'value'='"off"'::jsonb THEN 'declined' ELSE 'unverified' END;
   END IF;
  END IF;
  observations=observations||jsonb_build_array(jsonb_build_object('purpose',o->>'purpose','fieldId',o->>'id','choice',choice));
 END LOOP;
 RETURN observations;
END $$;
REVOKE ALL ON FUNCTION public.observe_profile_consent_choices(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.observe_profile_consent_choices(jsonb,jsonb) TO kavosh_signature_completion_policy;
ALTER TABLE public.signature_completion_evidence ADD COLUMN profile_consent_observations jsonb NOT NULL DEFAULT '[]'::jsonb
 CHECK(jsonb_typeof(profile_consent_observations)='array' AND jsonb_array_length(profile_consent_observations)<=2);
DO $$ DECLARE d text;updated text;BEGIN
 d=pg_get_functiondef('public.record_signature_completion_evidence(uuid,uuid,text,text,jsonb)'::regprocedure);
 updated=replace(d,'review_reasons,state,evidence_fingerprint)','review_reasons,state,evidence_fingerprint,profile_consent_observations)');
 updated=replace(updated,'p_manifest,signer_id,reasons,new_state,fp) ON CONFLICT','p_manifest,signer_id,reasons,new_state,fp,public.observe_profile_consent_choices(s,p)) ON CONFLICT');
 IF updated=d OR strpos(updated,'public.observe_profile_consent_choices(s,p)')=0 THEN RAISE EXCEPTION 'PROFILE_CONSENT_EVIDENCE_UPGRADE_MISMATCH';END IF;EXECUTE updated;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 322 $$;

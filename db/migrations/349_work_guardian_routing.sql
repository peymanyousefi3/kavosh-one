-- Three distinct original signers on one PDF. Optional guardian choices are
-- neither worker/academy answers nor a signature/consent/publication grant.
CREATE OR REPLACE FUNCTION public.work_agreement_routing_valid(r jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE party jsonb;f jsonb;ids text[]:=ARRAY[]::text[];counted integer:=0;party_version integer;BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['version','parties']<>'{}'::jsonb OR r->'version' IS NULL OR r->'version' NOT IN('1'::jsonb,'2'::jsonb,'3'::jsonb) OR jsonb_typeof(r->'parties') IS DISTINCT FROM 'array'
 OR jsonb_array_length(r->'parties')<>(CASE WHEN r->'version'='3'::jsonb THEN 3 ELSE 2 END)
 OR r#>>'{parties,0,role}' IS DISTINCT FROM 'worker' OR r#>>'{parties,1,role}' IS DISTINCT FROM 'academy_representative'
 OR(r->'version'='3'::jsonb AND r#>>'{parties,2,role}' IS DISTINCT FROM 'legal_guardian') THEN RETURN false;END IF;
 FOR party IN SELECT value FROM jsonb_array_elements(r->'parties') LOOP
  IF jsonb_typeof(party) IS DISTINCT FROM 'object' OR party-ARRAY['role','fields']<>'{}'::jsonb OR NOT(party ?& ARRAY['role','fields']) THEN RETURN false;END IF;
  party_version=1;
  IF(r->'version'='2'::jsonb AND party->>'role'='worker') OR(r->'version'='3'::jsonb AND party->>'role'='legal_guardian' AND EXISTS(SELECT 1 FROM jsonb_array_elements(party->'fields') choice(value) WHERE choice.value->'isRequired'='false'::jsonb)) THEN party_version=2;END IF;
  IF public.agreement_routing_valid(jsonb_build_object('version',party_version,'role','legal_signer','fields',party->'fields')) IS DISTINCT FROM true THEN RETURN false;END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(party->'fields') LOOP
   counted=counted+1;IF counted>100 OR f->>'id'=ANY(ids) THEN RETURN false;END IF;ids=array_append(ids,f->>'id');
  END LOOP;
 END LOOP;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END $$;
DO $$ DECLARE d text;updated text;BEGIN
 d=pg_get_functiondef('public.work_agreement_content_source(jsonb)'::regprocedure);
 updated=replace(d,$q$IF w.id IS NULL OR w.source_snapshot ? 'guardianSigner' THEN RETURN NULL;END IF;$q$,$r$IF w.id IS NULL OR((w.source_snapshot ? 'guardianSigner') IS DISTINCT FROM(i#>'{routing,version}'='3'::jsonb)) THEN RETURN NULL;END IF;$r$);
 IF updated=d THEN RAISE EXCEPTION 'GUARDIAN_ROUTING_FRAMEWORK_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.work_agreement_content_privacy()'::regprocedure);
 updated=replace(d,'END IF;RETURN NEW;',$r$END IF;
 IF w.input ? 'guardianId' THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','worker-guardians.view','personId',w.worker_id),jsonb_build_object('capability','guardians.view','personId',w.input->>'guardianId'));END IF;
 RETURN NEW;$r$);
 IF updated=d THEN RAISE EXCEPTION 'GUARDIAN_ROUTING_PRIVACY_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 d=pg_get_functiondef('public.work_signature_content_basis(uuid,uuid)'::regprocedure);
 updated=replace(d,$q$'protocolVersion',1,'preparationId'$q$,$r$'protocolVersion',(CASE WHEN s#>'{routing,version}'='3'::jsonb THEN 2 ELSE 1 END),'preparationId'$r$);
 IF updated=d THEN RAISE EXCEPTION 'GUARDIAN_ROUTING_PROTOCOL_UPGRADE_MISMATCH';END IF;EXECUTE updated;
 -- Contact hydration,manifest,original completion and review still need all
 -- three parties. A two-contact sender must NEVER execute this new routing.
 d=pg_get_functiondef('public.work_signature_send_source(uuid,uuid,uuid)'::regprocedure);
 updated=replace(d,'IF s IS NULL THEN RETURN NULL;END IF;',$r$IF s IS NULL OR s#>>'{content,routing,version}'='3' THEN RETURN NULL;END IF;$r$);
 IF updated=d THEN RAISE EXCEPTION 'GUARDIAN_ROUTING_SEND_GATE_UPGRADE_MISMATCH';END IF;EXECUTE updated;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 349 $$;

-- Optional worker disclosure questions stay inside the SAME two-party work
-- document. Recording or signing this route grants no profile publication.
-- Reuse the already bounded field/geometry/purpose validator,not a new parser.
CREATE OR REPLACE FUNCTION public.work_agreement_routing_valid(r jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE party jsonb;f jsonb;ids text[]:=ARRAY[]::text[];counted integer:=0;BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['version','parties']<>'{}'::jsonb OR r->'version' IS NULL OR r->'version' NOT IN('1'::jsonb,'2'::jsonb) OR jsonb_typeof(r->'parties') IS DISTINCT FROM 'array' OR jsonb_array_length(r->'parties')<>2 OR r#>>'{parties,0,role}' IS DISTINCT FROM 'worker' OR r#>>'{parties,1,role}' IS DISTINCT FROM 'academy_representative' THEN RETURN false;END IF;
 FOR party IN SELECT value FROM jsonb_array_elements(r->'parties') LOOP
  IF jsonb_typeof(party) IS DISTINCT FROM 'object' OR party-ARRAY['role','fields']<>'{}'::jsonb OR NOT(party ?& ARRAY['role','fields']) THEN RETURN false;END IF;
  IF public.agreement_routing_valid(jsonb_build_object('version',CASE WHEN party->>'role'='worker' THEN r->'version' ELSE '1'::jsonb END,'role','legal_signer','fields',party->'fields')) IS DISTINCT FROM true THEN RETURN false;END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(party->'fields') LOOP
   counted=counted+1;IF counted>100 OR f->>'id'=ANY(ids) THEN RETURN false;END IF;ids=array_append(ids,f->>'id');
  END LOOP;
 END LOOP;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN false;
END $$;
-- Existing OID,owner,ACL,immutability,source/audit checks and all version1
-- rows/manifests remain intact. No new table,role grant or authority.
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 341 $$;

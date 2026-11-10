-- Version 1 remains byte-for-byte compatible. Version 2 adds only optional,
-- unchecked, editable purpose-bound choices in the same enrollment document.
-- Routing records a question, NOT a grant of consent or publication authority.
CREATE FUNCTION public.agreement_routing_valid(r jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE f jsonb;b jsonb;choices integer:=0;purposes text[]:=ARRAY[]::text[];ids text[]:=ARRAY[]::text[];has_signature boolean:=false;BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(r))<>3 OR r->'version' NOT IN('1'::jsonb,'2'::jsonb) OR r->>'role' IS DISTINCT FROM 'legal_signer' OR jsonb_typeof(r->'fields') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF r->'version' IS NULL OR jsonb_array_length(r->'fields') NOT BETWEEN 1 AND 100 THEN RETURN false;END IF;
 FOR f IN SELECT * FROM jsonb_array_elements(r->'fields') LOOP
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  b=f->'bounds';
  IF jsonb_typeof(f->'id') IS DISTINCT FROM 'string' OR length(f->>'id') NOT BETWEEN 1 AND 200 OR f->>'id'=ANY(ids)
   OR jsonb_typeof(f->'fieldType') IS DISTINCT FROM 'string' OR length(f->>'fieldType') NOT BETWEEN 1 AND 80 OR jsonb_typeof(f->'isRequired') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(f->'pageNumber') IS DISTINCT FROM 'number' OR jsonb_typeof(b) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF (f->>'pageNumber')::numeric NOT BETWEEN 1 AND 1000 OR trunc((f->>'pageNumber')::numeric)<>(f->>'pageNumber')::numeric OR (SELECT count(*) FROM jsonb_object_keys(b))<>4 THEN RETURN false;END IF;
  FOR b IN SELECT jsonb_build_object('key',key,'value',value) FROM jsonb_each(f->'bounds') LOOP
   IF b->>'key' NOT IN('x','y','width','height') OR jsonb_typeof(b->'value') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
   IF (b->>'value')::numeric<0 OR (b->>'value')::numeric>20000 OR(b->>'key' IN('width','height') AND (b->>'value')::numeric=0) THEN RETURN false;END IF;
  END LOOP;
  IF f->'isRequired'='true'::jsonb THEN
   IF (SELECT count(*) FROM jsonb_object_keys(f))<>5 THEN RETURN false;END IF;
   has_signature=has_signature OR lower(f->>'fieldType')='signature';
  ELSE
   IF r->'version'<>'2'::jsonb OR (SELECT count(*) FROM jsonb_object_keys(f))<>6 OR f->>'fieldType' IS DISTINCT FROM 'CheckBox' OR f->>'consentPurpose' IS NULL
    OR f->>'consentPurpose' NOT IN('public_profile','verified_member_profile') OR f->>'consentPurpose'=ANY(purposes) THEN RETURN false;END IF;
   choices=choices+1;purposes=array_append(purposes,f->>'consentPurpose');
  END IF;
  ids=array_append(ids,f->>'id');
 END LOOP;
 RETURN has_signature AND (r->'version'='1'::jsonb OR choices>0);
END $$;
REVOKE ALL ON FUNCTION public.agreement_routing_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agreement_routing_valid(jsonb) TO kavosh_runtime;
-- Keep all original exact-approval/source guards and their function privileges.
DO $$ DECLARE original text;start_at integer;end_at integer;BEGIN
 original=pg_get_functiondef('public.guard_agreement_content_binding()'::regprocedure);
 start_at=strpos(original,' IF jsonb_typeof(NEW.routing)');end_at=strpos(original,' RETURN NEW;');
 IF start_at=0 OR end_at<=start_at OR strpos(original,'AGREEMENT_CONTENT_EXACT_APPROVAL_REQUIRED')=0 THEN RAISE EXCEPTION 'AGREEMENT_ROUTING_UPGRADE_SOURCE_MISMATCH';END IF;
 EXECUTE substr(original,1,start_at-1)||' IF NOT public.agreement_routing_valid(NEW.routing) THEN RAISE EXCEPTION ''AGREEMENT_ROUTING_INVALID'' USING ERRCODE=''23514'';END IF;'||chr(10)||substr(original,end_at);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 321 $$;

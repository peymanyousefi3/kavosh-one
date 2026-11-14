-- Register the combined statement in the existing library;no old financial,
-- preset,approval,grant or source-proof row is rewritten.
DO $$ DECLARE body text;needle text;r record;BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('public.report_preset_static_definition_valid(jsonb)','''finance.collector-custody'')','''finance.collector-custody'',''finance.counterparty-statement'')'),
 ('public.report_preset_definition_valid(jsonb)','WHEN ''finance.collector-custody'' THEN ARRAY[''from'',''through'']','WHEN ''finance.collector-custody'' THEN ARRAY[''from'',''through''] WHEN ''finance.counterparty-statement'' THEN ARRAY[''from'',''through'']')
 ) changes(signature,old_text,new_text) LOOP
  body=pg_get_functiondef(r.signature::regprocedure);needle=r.old_text;
  IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'COUNTERPARTY_STATEMENT_PRESET_BASE_CHANGED:%',r.signature;END IF;
  EXECUTE replace(body,needle,r.new_text);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 268 $$;

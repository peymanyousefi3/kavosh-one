-- Extend BOTH native preset validators without rewriting any saved report,
-- posted money, role, approval, history or source proof. Background binary
-- generation/classified formal cash-flow statements are separate work.
DO $$ DECLARE body text;needle text;r record;BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('public.report_preset_static_definition_valid(jsonb)','''finance.asset-valuation'')','''finance.asset-valuation'',''finance.cash-movements'')'),
 ('public.report_preset_definition_valid(jsonb)','WHEN ''finance.asset-valuation'' THEN ARRAY[''through'']','WHEN ''finance.asset-valuation'' THEN ARRAY[''through''] WHEN ''finance.cash-movements'' THEN ARRAY[''from'',''through'']')
 ) changes(signature,old_text,new_text) LOOP
  body=pg_get_functiondef(r.signature::regprocedure);needle=r.old_text;
  IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'CASH_MOVEMENT_PRESET_BASE_CHANGED:%',r.signature;END IF;
  EXECUTE replace(body,needle,r.new_text);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 362 $$;

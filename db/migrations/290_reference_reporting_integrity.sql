-- Register the new report in BOTH native preset validators. Preserve their
-- identity,owner,ACL and the validation of every previously saved report.
DO $$ DECLARE body text;needle text;r record;BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('public.report_preset_static_definition_valid(jsonb)','''finance.counterparty-statement'')','''finance.counterparty-statement'',''finance.asset-valuation'')'),
 ('public.report_preset_definition_valid(jsonb)','WHEN ''finance.counterparty-statement'' THEN ARRAY[''from'',''through'']','WHEN ''finance.counterparty-statement'' THEN ARRAY[''from'',''through''] WHEN ''finance.asset-valuation'' THEN ARRAY[''through'']'),
 ('public.build_approval_privacy_bindings(uuid,text,jsonb,jsonb,jsonb,text)','IF p_action NOT LIKE ''finance.%'' THEN RETURN result;END IF;','IF p_action=''finance.exchange-rate.record'' THEN result=result||jsonb_build_array(jsonb_build_object(''capability'',''currencies.view'',''scope'',jsonb_build_object(''all'',true,''hubs'',''[]''::jsonb)));END IF; IF p_action NOT LIKE ''finance.%'' THEN RETURN result;END IF;')
 ) changes(signature,old_text,new_text) LOOP
  body=pg_get_functiondef(r.signature::regprocedure);needle=r.old_text;
  IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'REFERENCE_REPORTING_BASE_CHANGED:%',r.signature;END IF;
  EXECUTE replace(body,needle,r.new_text);
 END LOOP;
END $$;
-- Tighten retained reference approvals too;never rewrite their payload,
-- decision,source snapshot,audit or actual quote. Old authority is not granted.
UPDATE public.approval_requests SET privacy_bindings=privacy_bindings||'[{"capability":"currencies.view","scope":{"all":true,"hubs":[]}}]'::jsonb
 WHERE action='finance.exchange-rate.record' AND NOT privacy_bindings @> '[{"capability":"currencies.view","scope":{"all":true,"hubs":[]}}]'::jsonb;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 290 $$;

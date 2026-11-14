-- Reuse the current preset library and civil-window validator. No new stored
-- results or disclosure permissions;execution still checks current case scope.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.report_preset_static_definition_valid(jsonb)'::regprocedure);needle='''payroll.t4a-consolidated-working-paper'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PRIVACY_REPORT_PRESET_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'''payroll.t4a-consolidated-working-paper'',''administration.privacy-requests'')');
 body=pg_get_functiondef('public.report_preset_definition_valid(jsonb)'::regprocedure);needle='fields=CASE d->>''reportId'' WHEN ''finance.trial-balance''';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PRIVACY_REPORT_WINDOW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'fields=CASE d->>''reportId'' WHEN ''administration.privacy-requests'' THEN ARRAY[''from'',''through'',''timeZone''] WHEN ''finance.trial-balance''');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 387 $$;

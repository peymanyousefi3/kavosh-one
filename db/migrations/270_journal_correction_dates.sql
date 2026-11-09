-- An inverse cannot take effect before its original. Otherwise a future
-- principal transaction could acquire an earlier artificial credit and free
-- a payment reference before the original ever entered the books.
-- Preserve historical rows and the original guard identity/owner/ACL/config.
DO $$ DECLARE body text;needle text:='IF original.id IS NULL OR original.reverses_id IS NOT NULL OR original.line_count<>NEW.line_count THEN';BEGIN
 body=pg_get_functiondef('public.guard_finance_journal()'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'JOURNAL_CORRECTION_DATE_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'IF NEW.posted_on<original.posted_on THEN RAISE EXCEPTION ''FINANCE_CORRECTION_PRECEDES_JOURNAL'' USING ERRCODE=''23514'';END IF; '||needle);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 270 $$;

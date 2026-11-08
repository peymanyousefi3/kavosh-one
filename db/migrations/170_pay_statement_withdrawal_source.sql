-- A fresh connection can withdraw a retained release before ever previewing a
-- statement. Untyped records have no fields until assigned; SQL CASE still
-- resolves their field types while planning its unused branch. Give those
-- two optional rows their existing table types,without a new read or privilege.
DO $$ DECLARE body text;needle text:='DECLARE p record;g record;h record;r record;';BEGIN
 body=pg_get_functiondef('public.pay_statement_release_source(uuid,integer,integer)'::regprocedure);
 IF (length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PAY_STATEMENT_WITHDRAWAL_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'DECLARE p record;g record;h public.payrun_statement_records%ROWTYPE;r public.payrun_statement_revisions%ROWTYPE;');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 170 $$;

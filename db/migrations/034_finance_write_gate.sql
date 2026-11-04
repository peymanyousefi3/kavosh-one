-- Ordinary financial writers share one transaction gate per school. A future
-- reviewed closing writer takes the exclusive form before reading/rechecking
-- its source and before any financial row locks. No session locks are used.
CREATE FUNCTION public.lock_finance_book() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE academy uuid; BEGIN
 academy:=nullif(current_setting('app.academy_id',true),'')::uuid;
 IF academy IS NULL THEN RAISE EXCEPTION 'FINANCE_CONTEXT_REQUIRED' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(academy::text,10));
END $$;
REVOKE ALL ON FUNCTION public.lock_finance_book() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_finance_book() TO kavosh_runtime;
CREATE FUNCTION public.guard_finance_book_write() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 -- Trusted migration/test owners can seed multiple schools without an app
 -- context. Runtime DML without a context is already denied by FORCE RLS.
 IF nullif(current_setting('app.academy_id',true),'') IS NOT NULL THEN PERFORM public.lock_finance_book(); END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.guard_finance_book_write() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_currencies','finance_currency_revisions','finance_accounts','finance_account_revisions','finance_periods','finance_period_revisions','finance_journals','finance_journal_lines'] LOOP
  -- Statement triggers run before automatic row locks, including zero-row DML.
  EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 34 $$;

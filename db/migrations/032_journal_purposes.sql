-- Existing immutable journals have no reliable purpose evidence. Do not infer
-- their purpose from descriptions, account kinds or current report results.
ALTER TABLE public.finance_journals ADD COLUMN purpose text NOT NULL DEFAULT 'legacy_unclassified'
 CHECK(purpose IN ('activity','opening','closing','legacy_unclassified'));
ALTER TABLE public.finance_journals ALTER COLUMN purpose SET DEFAULT 'activity';
GRANT INSERT(purpose) ON public.finance_journals TO kavosh_runtime;
CREATE FUNCTION public.guard_finance_journal_purpose() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE original_purpose text;p record; BEGIN
 IF NEW.reverses_id IS NOT NULL THEN
  SELECT purpose INTO original_purpose FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.reverses_id;
  IF NEW.purpose IS DISTINCT FROM original_purpose THEN RAISE EXCEPTION 'FINANCE_REVERSAL_PURPOSE_INVALID' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.purpose='legacy_unclassified' THEN RAISE EXCEPTION 'FINANCE_LEGACY_PURPOSE_RESERVED' USING ERRCODE='23514'; END IF;
  SELECT starts_on,ends_on INTO p FROM public.finance_periods WHERE academy_id=NEW.academy_id AND id=NEW.period_id;
  IF(NEW.purpose='opening' AND NEW.posted_on IS DISTINCT FROM p.starts_on) OR(NEW.purpose='closing' AND NEW.posted_on IS DISTINCT FROM p.ends_on) THEN RAISE EXCEPTION 'FINANCE_PURPOSE_DATE_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_finance_journal_purpose() FROM PUBLIC;
CREATE TRIGGER finance_journal_purpose BEFORE INSERT ON public.finance_journals FOR EACH ROW EXECUTE FUNCTION public.guard_finance_journal_purpose();
CREATE FUNCTION public.validate_finance_journal_purpose() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.finance_journal_lines l JOIN public.finance_account_revisions r
  ON r.academy_id=l.academy_id AND r.account_id=l.account_id AND r.version=l.account_version
  WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.id AND
   ((NEW.purpose='opening' AND r.kind NOT IN ('asset','liability','equity')) OR(NEW.purpose='closing' AND r.kind NOT IN ('income','expense','equity'))))
 THEN RAISE EXCEPTION 'FINANCE_PURPOSE_ACCOUNT_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.validate_finance_journal_purpose() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER finance_journal_purpose_complete AFTER INSERT ON public.finance_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_finance_journal_purpose();
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 32 $$;

INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('journals.view','View permitted posted journals','Finance',true,ARRAY['hub','country','region','city']),
 ('journals.edit','Request permitted journal postings and reversals','Finance',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.finance_journals (
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,
 period_id uuid NOT NULL,period_version integer NOT NULL,period_state text NOT NULL DEFAULT 'open' CHECK(period_state='open'),
 posted_on date NOT NULL CHECK(posted_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 description text NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),reference text NOT NULL DEFAULT '' CHECK(length(reference)<=200),
 line_count smallint NOT NULL CHECK(line_count BETWEEN 2 AND 200),reverses_id uuid,
 posted_by uuid NOT NULL,posted_kind text NOT NULL DEFAULT 'human' CHECK(posted_kind='human'),approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,reverses_id),CHECK(reverses_id IS DISTINCT FROM id),
 FOREIGN KEY(academy_id,period_id,period_version,period_state) REFERENCES public.finance_period_revisions(academy_id,period_id,version,state),
 FOREIGN KEY(academy_id,reverses_id) REFERENCES public.finance_journals(academy_id,id),
 FOREIGN KEY(academy_id,posted_by,posted_kind) REFERENCES public.people(academy_id,id,kind),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX finance_journals_period_date ON public.finance_journals(academy_id,period_id,posted_on,id);
CREATE TABLE public.finance_journal_lines (
 academy_id uuid NOT NULL,journal_id uuid NOT NULL,line_number smallint NOT NULL CHECK(line_number BETWEEN 1 AND 200),
 account_id uuid NOT NULL,account_version integer NOT NULL,side text NOT NULL CHECK(side IN ('debit','credit')),
 -- Unconstrained numeric plus an integer check rejects fractions rather than
 -- numeric(38,0)'s coercion rounding them before CHECK sees the input.
 amount_minor numeric NOT NULL CHECK(amount_minor>0 AND amount_minor=trunc(amount_minor) AND amount_minor<1e38),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=500),
 PRIMARY KEY(academy_id,journal_id,line_number),
 FOREIGN KEY(academy_id,journal_id) REFERENCES public.finance_journals(academy_id,id),
 FOREIGN KEY(academy_id,account_id,account_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version)
);
CREATE INDEX finance_journal_lines_account ON public.finance_journal_lines(academy_id,account_id,journal_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['finance_journals','finance_journal_lines'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE FUNCTION public.guard_finance_journal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;original record; BEGIN
 SELECT * INTO p FROM public.finance_periods WHERE academy_id=NEW.academy_id AND id=NEW.period_id FOR SHARE;
 IF p.id IS NULL OR p.state<>'open' OR p.version<>NEW.period_version OR NEW.posted_on NOT BETWEEN p.starts_on AND p.ends_on THEN RAISE EXCEPTION 'FINANCE_OPEN_PERIOD_REQUIRED' USING ERRCODE='23514'; END IF;
 IF NEW.reverses_id IS NOT NULL THEN
  -- Original rows are immutable; the tenant FK and unique reversal reference
  -- give the necessary integrity without granting UPDATE just to take a lock.
  SELECT * INTO original FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.reverses_id;
  IF original.id IS NULL OR original.reverses_id IS NOT NULL OR original.line_count<>NEW.line_count THEN RAISE EXCEPTION 'FINANCE_REVERSAL_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_finance_journal() FROM PUBLIC;
CREATE TRIGGER finance_journal_header BEFORE INSERT ON public.finance_journals FOR EACH ROW EXECUTE FUNCTION public.guard_finance_journal();
CREATE FUNCTION public.guard_finance_journal_line() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE j record;a record;is_active boolean; BEGIN
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.journal_id;
 IF j.id IS NULL OR NEW.line_number>j.line_count THEN RAISE EXCEPTION 'FINANCE_LINE_NUMBER_INVALID' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=NEW.account_id FOR SHARE;
 IF j.reverses_id IS NULL THEN
  SELECT active INTO is_active FROM public.finance_account_revisions WHERE academy_id=NEW.academy_id AND account_id=NEW.account_id AND version=a.version;
  IF a.id IS NULL OR a.version<>NEW.account_version OR is_active IS DISTINCT FROM true THEN RAISE EXCEPTION 'FINANCE_ACTIVE_ACCOUNT_REQUIRED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_finance_journal_line() FROM PUBLIC;
CREATE TRIGGER finance_journal_line BEFORE INSERT ON public.finance_journal_lines FOR EACH ROW EXECUTE FUNCTION public.guard_finance_journal_line();
CREATE FUNCTION public.validate_finance_journal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF(SELECT count(*) FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id)<>NEW.line_count THEN RAISE EXCEPTION 'FINANCE_JOURNAL_INCOMPLETE' USING ERRCODE='23514'; END IF;
 -- Normalize explicitly pinned precisions with exact powers of ten, never
 -- floating point or FX guesses. Metadata-only currency revisions remain
 -- interoperable, while separate currency identities never cancel each other.
 IF EXISTS(SELECT 1 FROM public.finance_journal_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id
   JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version
   WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.id GROUP BY a.currency_id
   HAVING sum((CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END)*('1'||repeat('0',18-u.unit_scale))::numeric)<>0) THEN RAISE EXCEPTION 'FINANCE_JOURNAL_UNBALANCED' USING ERRCODE='23514'; END IF;
 IF NEW.reverses_id IS NOT NULL AND EXISTS(
  SELECT line_number,account_id,account_version,side,amount_minor,note FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id
  EXCEPT SELECT line_number,account_id,account_version,CASE WHEN side='debit' THEN 'credit' ELSE 'debit' END,amount_minor,note FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.reverses_id
 ) THEN RAISE EXCEPTION 'FINANCE_REVERSAL_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.validate_finance_journal() FROM PUBLIC;
-- Run once per header, after all lines exist. A posted journal already occupies
-- every allowed line number; immutable rows and the bound prevent later append.
CREATE CONSTRAINT TRIGGER finance_journal_complete AFTER INSERT ON public.finance_journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_finance_journal();
CREATE FUNCTION public.guard_finance_period_postings() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.state='void' AND EXISTS(SELECT 1 FROM public.finance_journals WHERE academy_id=NEW.academy_id AND period_id=NEW.id) THEN RAISE EXCEPTION 'FINANCE_PERIOD_HAS_POSTINGS' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_finance_period_postings() FROM PUBLIC;
CREATE TRIGGER finance_period_postings BEFORE UPDATE ON public.finance_periods FOR EACH ROW EXECUTE FUNCTION public.guard_finance_period_postings();
GRANT SELECT ON public.finance_journals,public.finance_journal_lines TO kavosh_runtime;
GRANT INSERT(academy_id,id,period_id,period_version,posted_on,description,reference,line_count,reverses_id,posted_by,approval_id) ON public.finance_journals TO kavosh_runtime;
GRANT INSERT ON public.finance_journal_lines TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 29 $$;

INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('bank-matches.view','View reviewed statement-to-ledger links','Finance',true,ARRAY['hub','country','region','city']),
 ('bank-matches.edit','Request reviewed statement matches and releases','Finance',true,ARRAY['hub','country','region','city']);
CREATE INDEX statement_candidate_amount ON public.finance_journal_lines(academy_id,account_id,side,amount_minor,journal_id,line_number);
CREATE TABLE public.finance_statement_matches(
 academy_id uuid NOT NULL,id uuid NOT NULL,account_id uuid NOT NULL,account_version integer NOT NULL,currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),
 statement_count integer NOT NULL CHECK(statement_count BETWEEN 1 AND 200),ledger_count integer NOT NULL CHECK(ledger_count BETWEEN 1 AND 200),total_minor numeric NOT NULL CHECK(total_minor=trunc(total_minor) AND abs(total_minor)<2e40),
 approval_id uuid NOT NULL,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,id,account_id),FOREIGN KEY(academy_id,account_id,account_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE INDEX statement_match_account ON public.finance_statement_matches(academy_id,account_id,id);
CREATE TABLE public.finance_statement_match_rows(
 academy_id uuid NOT NULL,match_id uuid NOT NULL,account_id uuid NOT NULL,import_id uuid NOT NULL,line integer NOT NULL,
 PRIMARY KEY(academy_id,match_id,import_id,line),FOREIGN KEY(academy_id,match_id,account_id) REFERENCES public.finance_statement_matches(academy_id,id,account_id),FOREIGN KEY(academy_id,import_id,line) REFERENCES public.finance_statement_rows(academy_id,import_id,line)
);
CREATE INDEX statement_row_match ON public.finance_statement_match_rows(academy_id,import_id,line,match_id);
CREATE TABLE public.finance_statement_match_lines(
 academy_id uuid NOT NULL,match_id uuid NOT NULL,account_id uuid NOT NULL,journal_id uuid NOT NULL,line_number smallint NOT NULL,
 PRIMARY KEY(academy_id,match_id,journal_id,line_number),FOREIGN KEY(academy_id,match_id,account_id) REFERENCES public.finance_statement_matches(academy_id,id,account_id),FOREIGN KEY(academy_id,journal_id,line_number) REFERENCES public.finance_journal_lines(academy_id,journal_id,line_number)
);
CREATE INDEX statement_ledger_match ON public.finance_statement_match_lines(academy_id,journal_id,line_number,match_id);
CREATE TABLE public.finance_statement_match_releases(
 academy_id uuid NOT NULL,id uuid NOT NULL,match_id uuid NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,match_id),FOREIGN KEY(academy_id,match_id) REFERENCES public.finance_statement_matches(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['finance_statement_matches','finance_statement_match_rows','finance_statement_match_lines','finance_statement_match_releases'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
 EXECUTE format('GRANT SELECT,INSERT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
-- Add source-derived private boundaries after the existing base binder. Never
-- trust a caller-supplied review-context account or just a copied hub scope.
CREATE FUNCTION public.statement_match_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE account_id uuid;hub uuid;BEGIN
 IF NEW.action='finance.statement-match.record' THEN account_id=(NEW.payload->>'accountId')::uuid;
 ELSE SELECT m.account_id INTO account_id FROM public.finance_statement_matches m WHERE m.academy_id=NEW.academy_id AND m.id=(NEW.payload->>'matchId')::uuid;END IF;
 SELECT a.hub_id INTO hub FROM public.finance_accounts a WHERE a.academy_id=NEW.academy_id AND a.id=account_id;
 IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('accounts.view',ARRAY[hub]),public.approval_hub_binding('bank-matches.view',ARRAY[hub]),public.approval_hub_binding('ledger.view',ARRAY[hub]),public.approval_hub_binding('bank-statements.view',ARRAY[hub]));END IF;
 RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER statement_match_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.statement-match.record','finance.statement-match.release')) EXECUTE FUNCTION public.statement_match_privacy();
CREATE FUNCTION public.guard_statement_match() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;p record;m record;BEGIN
 IF TG_TABLE_NAME='finance_statement_matches' THEN
  PERFORM 1 FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=NEW.account_id FOR UPDATE;
  SELECT * INTO a FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.account_id;
  SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
  IF a.id IS NULL OR a.version IS DISTINCT FROM NEW.account_version OR a.currency_id IS DISTINCT FROM NEW.currency_id OR a.unit_scale IS DISTINCT FROM NEW.unit_scale THEN RAISE EXCEPTION 'STATEMENT_MATCH_ACCOUNT_INVALID' USING ERRCODE='23514';END IF;
  IF p.id IS NULL OR p.status<>'pending' OR p.action<>'finance.statement-match.record' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'bank-matches.edit'
   OR(p.payload->>'accountId')::uuid IS DISTINCT FROM NEW.account_id OR(p.payload->>'accountVersion')::integer IS DISTINCT FROM NEW.account_version
   OR jsonb_typeof(p.payload->'statementRows') IS DISTINCT FROM 'array' OR jsonb_typeof(p.payload->'ledgerLines') IS DISTINCT FROM 'array'
   OR jsonb_array_length(p.payload->'statementRows') IS DISTINCT FROM NEW.statement_count OR jsonb_array_length(p.payload->'ledgerLines') IS DISTINCT FROM NEW.ledger_count THEN RAISE EXCEPTION 'STATEMENT_MATCH_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO m FROM public.finance_statement_matches WHERE academy_id=NEW.academy_id AND id=NEW.match_id;
  IF m.id IS NULL THEN RAISE EXCEPTION 'STATEMENT_MATCH_REQUIRED' USING ERRCODE='23514';END IF;
  PERFORM 1 FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=m.account_id FOR UPDATE;
  SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
  IF p.id IS NULL OR p.status<>'pending' OR p.action<>'finance.statement-match.release' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'bank-matches.edit' OR(p.payload->>'matchId')::uuid IS DISTINCT FROM NEW.match_id THEN RAISE EXCEPTION 'STATEMENT_MATCH_RELEASE_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER statement_match_guard BEFORE INSERT ON public.finance_statement_matches FOR EACH ROW EXECUTE FUNCTION public.guard_statement_match();
CREATE TRIGGER statement_match_release_guard BEFORE INSERT ON public.finance_statement_match_releases FOR EACH ROW EXECUTE FUNCTION public.guard_statement_match();
CREATE FUNCTION public.guard_statement_match_member() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE m record;p record;source_account uuid;BEGIN
 SELECT * INTO m FROM public.finance_statement_matches WHERE academy_id=NEW.academy_id AND id=NEW.match_id;
 IF m.id IS NULL THEN RAISE EXCEPTION 'STATEMENT_MATCH_REQUIRED' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=m.account_id FOR UPDATE;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=m.approval_id;
 IF p.status IS DISTINCT FROM 'pending' THEN RAISE EXCEPTION 'STATEMENT_MATCH_MEMBERS_FROZEN' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='finance_statement_match_rows' THEN
  SELECT r.account_id INTO source_account FROM public.finance_statement_rows r JOIN public.finance_statement_imports i ON i.academy_id=r.academy_id AND i.id=r.import_id WHERE r.academy_id=NEW.academy_id AND r.import_id=NEW.import_id AND r.line=NEW.line AND i.currency_id=m.currency_id AND i.unit_scale=m.unit_scale AND NOT EXISTS(SELECT 1 FROM public.finance_statement_voids v WHERE v.academy_id=i.academy_id AND v.import_id=i.id);
  IF source_account IS DISTINCT FROM m.account_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.payload->'statementRows') x WHERE(x->>'importId')::uuid=NEW.import_id AND(x->>'line')::integer=NEW.line) THEN RAISE EXCEPTION 'STATEMENT_MATCH_ROW_INVALID' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM public.finance_statement_match_rows r WHERE r.academy_id=NEW.academy_id AND r.import_id=NEW.import_id AND r.line=NEW.line AND NOT EXISTS(SELECT 1 FROM public.finance_statement_match_releases v WHERE v.academy_id=r.academy_id AND v.match_id=r.match_id)) THEN RAISE EXCEPTION 'STATEMENT_ROW_ALREADY_MATCHED' USING ERRCODE='23514';END IF;
 ELSE
  SELECT l.account_id INTO source_account FROM public.finance_journal_lines l WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.journal_id AND l.line_number=NEW.line_number;
  IF source_account IS DISTINCT FROM m.account_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.payload->'ledgerLines') x WHERE(x->>'journalId')::uuid=NEW.journal_id AND(x->>'lineNumber')::integer=NEW.line_number) THEN RAISE EXCEPTION 'STATEMENT_MATCH_LEDGER_INVALID' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM public.finance_statement_match_lines l WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.journal_id AND l.line_number=NEW.line_number AND NOT EXISTS(SELECT 1 FROM public.finance_statement_match_releases v WHERE v.academy_id=l.academy_id AND v.match_id=l.match_id)) THEN RAISE EXCEPTION 'STATEMENT_LEDGER_ALREADY_MATCHED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER statement_match_row_guard BEFORE INSERT ON public.finance_statement_match_rows FOR EACH ROW EXECUTE FUNCTION public.guard_statement_match_member();
CREATE TRIGGER statement_match_line_guard BEFORE INSERT ON public.finance_statement_match_lines FOR EACH ROW EXECUTE FUNCTION public.guard_statement_match_member();
CREATE FUNCTION public.statement_match_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE rows integer;lines integer;s numeric;l numeric;BEGIN
 SELECT count(*)::integer,sum(r.debit_net_minor) INTO rows,s FROM public.finance_statement_match_rows x JOIN public.finance_statement_rows r ON r.academy_id=x.academy_id AND r.import_id=x.import_id AND r.line=x.line WHERE x.academy_id=NEW.academy_id AND x.match_id=NEW.id;
 SELECT count(*)::integer,sum(CASE WHEN r.side='debit' THEN r.amount_minor ELSE -r.amount_minor END) INTO lines,l FROM public.finance_statement_match_lines x JOIN public.finance_journal_lines r ON r.academy_id=x.academy_id AND r.journal_id=x.journal_id AND r.line_number=x.line_number WHERE x.academy_id=NEW.academy_id AND x.match_id=NEW.id;
 IF rows<>NEW.statement_count OR lines<>NEW.ledger_count OR s IS DISTINCT FROM l OR s IS DISTINCT FROM NEW.total_minor THEN RAISE EXCEPTION 'STATEMENT_MATCH_INCOMPLETE_OR_UNBALANCED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER statement_match_complete AFTER INSERT ON public.finance_statement_matches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.statement_match_complete();
CREATE CONSTRAINT TRIGGER statement_match_reviewed AFTER INSERT ON public.finance_statement_matches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE CONSTRAINT TRIGGER statement_match_release_reviewed AFTER INSERT ON public.finance_statement_match_releases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.statement_void_matches_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE account_id uuid;BEGIN
 SELECT i.account_id INTO account_id FROM public.finance_statement_imports i WHERE i.academy_id=NEW.academy_id AND i.id=NEW.import_id;
 PERFORM 1 FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=account_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.finance_statement_match_rows r WHERE r.academy_id=NEW.academy_id AND r.import_id=NEW.import_id AND NOT EXISTS(SELECT 1 FROM public.finance_statement_match_releases v WHERE v.academy_id=r.academy_id AND v.match_id=r.match_id)) THEN RAISE EXCEPTION 'STATEMENT_HAS_ACTIVE_MATCHES' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER statement_void_matches_guard BEFORE INSERT ON public.finance_statement_voids FOR EACH ROW EXECUTE FUNCTION public.statement_void_matches_guard();
REVOKE ALL ON FUNCTION public.statement_match_privacy(),public.guard_statement_match(),public.guard_statement_match_member(),public.statement_match_complete(),public.statement_void_matches_guard() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 67 $$;

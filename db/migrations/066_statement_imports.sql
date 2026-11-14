INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('bank-statements.view','View private imported bank statement rows','Finance',true,ARRAY['hub','country','region','city']),
 ('bank-statements.edit','Request reviewed statement imports and retained voids','Finance',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.finance_statement_imports(
 academy_id uuid NOT NULL,id uuid NOT NULL,account_id uuid NOT NULL,account_version integer NOT NULL,currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),
 source_name text NOT NULL CHECK(length(source_name) BETWEEN 1 AND 200),source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),import_hash text NOT NULL CHECK(import_hash~'^[a-f0-9]{64}$'),mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='object'),
 row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 500),approval_id uuid NOT NULL,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,id,account_id),FOREIGN KEY(academy_id,account_id,account_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE INDEX statement_account_hash ON public.finance_statement_imports(academy_id,account_id,import_hash);
CREATE TABLE public.finance_statement_rows(
 academy_id uuid NOT NULL,import_id uuid NOT NULL,account_id uuid NOT NULL,line integer NOT NULL CHECK(line BETWEEN 1 AND 500),posted_on date NOT NULL CHECK(posted_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),debit_net_minor numeric NOT NULL CHECK(debit_net_minor=trunc(debit_net_minor) AND debit_net_minor<>0 AND abs(debit_net_minor)<1e38),
 description text NOT NULL CHECK(length(description)<=2000),reference text NOT NULL CHECK(length(reference)<=200),spreadsheet_unsafe_text boolean NOT NULL,
 PRIMARY KEY(academy_id,import_id,line),FOREIGN KEY(academy_id,import_id,account_id) REFERENCES public.finance_statement_imports(academy_id,id,account_id)
);
CREATE INDEX statement_duplicate_candidates ON public.finance_statement_rows(academy_id,account_id,posted_on,debit_net_minor);
CREATE TABLE public.finance_statement_voids(
 academy_id uuid NOT NULL,id uuid NOT NULL,import_id uuid NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,created_kind text NOT NULL DEFAULT 'human' CHECK(created_kind='human'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,import_id),FOREIGN KEY(academy_id,import_id) REFERENCES public.finance_statement_imports(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by,created_kind) REFERENCES public.people(academy_id,id,kind)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['finance_statement_imports','finance_statement_rows','finance_statement_voids'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
 EXECUTE format('GRANT SELECT,INSERT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
CREATE FUNCTION public.guard_statement_import() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;p record;b record;BEGIN
 IF TG_TABLE_NAME='finance_statement_imports' THEN
  PERFORM 1 FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=NEW.account_id FOR UPDATE;
  SELECT * INTO a FROM public.finance_account_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.account_id;
  SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
  IF a.id IS NULL OR NOT a.active OR a.operational_role NOT IN('bank','cash','credit_card') OR a.version IS DISTINCT FROM NEW.account_version OR a.currency_id IS DISTINCT FROM NEW.currency_id OR a.unit_scale IS DISTINCT FROM NEW.unit_scale THEN RAISE EXCEPTION 'STATEMENT_ACCOUNT_INVALID' USING ERRCODE='23514';END IF;
  IF p.id IS NULL OR p.status<>'pending' OR p.action<>'finance.statement.import' OR p.privacy_capability IS DISTINCT FROM 'bank-statements.edit' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0
   OR(p.payload->>'accountId')::uuid IS DISTINCT FROM NEW.account_id OR(p.payload->>'accountVersion')::integer IS DISTINCT FROM NEW.account_version OR p.payload->>'sourceName' IS DISTINCT FROM NEW.source_name OR p.payload->'mapping' IS DISTINCT FROM NEW.mapping
   OR jsonb_typeof(p.payload->'csv') IS DISTINCT FROM 'string' OR octet_length(p.payload->>'csv') NOT BETWEEN 1 AND 262144
   OR encode(sha256(convert_to(p.payload->>'csv','UTF8')),'hex') IS DISTINCT FROM NEW.source_hash OR p.payload#>>'{normalized,sourceHash}' IS DISTINCT FROM NEW.source_hash OR p.payload#>>'{normalized,importHash}' IS DISTINCT FROM NEW.import_hash
   OR jsonb_typeof(p.payload#>'{normalized,rows}') IS DISTINCT FROM 'array' OR jsonb_array_length(p.payload#>'{normalized,rows}') IS DISTINCT FROM NEW.row_count THEN RAISE EXCEPTION 'STATEMENT_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM public.finance_statement_imports i WHERE i.academy_id=NEW.academy_id AND i.account_id=NEW.account_id AND i.import_hash=NEW.import_hash AND NOT EXISTS(SELECT 1 FROM public.finance_statement_voids v WHERE v.academy_id=i.academy_id AND v.import_id=i.id)) THEN RAISE EXCEPTION 'STATEMENT_ALREADY_IMPORTED' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO b FROM public.finance_statement_imports WHERE academy_id=NEW.academy_id AND id=NEW.import_id;
  IF b.id IS NULL THEN RAISE EXCEPTION 'STATEMENT_IMPORT_REQUIRED' USING ERRCODE='23514';END IF;
  PERFORM 1 FROM public.finance_accounts WHERE academy_id=NEW.academy_id AND id=b.account_id FOR UPDATE;
  SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
  IF p.id IS NULL OR p.status<>'pending' OR p.action<>'finance.statement.void' OR p.privacy_capability IS DISTINCT FROM 'bank-statements.edit' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR(p.payload->>'importId')::uuid IS DISTINCT FROM NEW.import_id THEN RAISE EXCEPTION 'STATEMENT_VOID_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER statement_import_guard BEFORE INSERT ON public.finance_statement_imports FOR EACH ROW EXECUTE FUNCTION public.guard_statement_import();
CREATE TRIGGER statement_void_guard BEFORE INSERT ON public.finance_statement_voids FOR EACH ROW EXECUTE FUNCTION public.guard_statement_import();
CREATE FUNCTION public.guard_statement_row() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;b record;expected jsonb;BEGIN
 SELECT * INTO b FROM public.finance_statement_imports WHERE academy_id=NEW.academy_id AND id=NEW.import_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=b.approval_id;
 expected=jsonb_build_object('line',NEW.line,'postedOn',NEW.posted_on::text,'debitNetMinor',NEW.debit_net_minor::text,'description',NEW.description,'reference',NEW.reference,'spreadsheetUnsafeText',NEW.spreadsheet_unsafe_text);
 IF b.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR NEW.line>b.row_count OR p.payload#>'{normalized,rows}'->(NEW.line-1) IS DISTINCT FROM expected OR NEW.posted_on>(clock_timestamp() AT TIME ZONE 'UTC'+interval '14 hours')::date THEN RAISE EXCEPTION 'STATEMENT_EXACT_ROW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER statement_row_guard BEFORE INSERT ON public.finance_statement_rows FOR EACH ROW EXECUTE FUNCTION public.guard_statement_row();
CREATE FUNCTION public.statement_rows_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF(SELECT count(*) FROM public.finance_statement_rows r WHERE r.academy_id=NEW.academy_id AND r.import_id=NEW.id)<>NEW.row_count THEN RAISE EXCEPTION 'STATEMENT_ROWS_INCOMPLETE' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER statement_rows_complete AFTER INSERT ON public.finance_statement_imports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.statement_rows_complete();
CREATE CONSTRAINT TRIGGER statement_import_reviewed AFTER INSERT ON public.finance_statement_imports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE CONSTRAINT TRIGGER statement_void_reviewed AFTER INSERT ON public.finance_statement_voids DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
REVOKE ALL ON FUNCTION public.guard_statement_import(),public.guard_statement_row(),public.statement_rows_complete() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 66 $$;

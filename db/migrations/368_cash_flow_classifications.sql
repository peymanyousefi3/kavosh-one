-- Reviewed analytical metadata,not a second journal or money movement.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('cash-flow.view','View reviewed cash-flow classifications','Finance',true,ARRAY['hub','country','region','city']),
 ('cash-flow.edit','Request reviewed cash-flow classifications without posting money','Finance',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.cash_flow_classifications(
 academy_id uuid NOT NULL,journal_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,journal_id),FOREIGN KEY(academy_id,journal_id) REFERENCES public.finance_journals(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE TABLE public.cash_flow_classification_revisions(
 academy_id uuid NOT NULL,journal_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),input jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=262144),changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,journal_id,version),FOREIGN KEY(academy_id,journal_id) REFERENCES public.cash_flow_classifications(academy_id,journal_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.cash_flow_classifications ADD CONSTRAINT cash_flow_current FOREIGN KEY(academy_id,journal_id,version) REFERENCES public.cash_flow_classification_revisions(academy_id,journal_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['cash_flow_classifications','cash_flow_classification_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER cash_flow_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,journal_id,version,created_by),UPDATE(version) ON public.cash_flow_classifications TO kavosh_runtime;
GRANT INSERT(academy_id,journal_id,version,input,source_snapshot,changed_by,approval_id) ON public.cash_flow_classification_revisions TO kavosh_runtime;
CREATE TRIGGER cash_flow_version BEFORE INSERT OR UPDATE ON public.cash_flow_classifications FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();

CREATE FUNCTION public.cash_flow_input_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE l jsonb;p jsonb;BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& ARRAY['journalId','expectedVersion','lines','reason']) OR i-ARRAY['journalId','expectedVersion','lines','reason']<>'{}'::jsonb OR octet_length(i::text)>65536
 OR jsonb_typeof(i->'journalId') IS DISTINCT FROM 'string' OR(i->>'journalId')::uuid::text IS DISTINCT FROM i->>'journalId'
 OR jsonb_typeof(i->'expectedVersion') IS DISTINCT FROM 'number' OR(i->>'expectedVersion')::numeric NOT BETWEEN 0 AND 2147483646 OR(i->>'expectedVersion')::numeric<>trunc((i->>'expectedVersion')::numeric)
 OR jsonb_typeof(i->'reason') IS DISTINCT FROM 'string' OR length(btrim(i->>'reason')) NOT BETWEEN 1 AND 2000 OR jsonb_typeof(i->'lines') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(i->'lines')>200 OR(SELECT count(DISTINCT (value->>'lineNumber')::numeric) FROM jsonb_array_elements(i->'lines'))<>jsonb_array_length(i->'lines') THEN RETURN false;END IF;
 FOR l IN SELECT value FROM jsonb_array_elements(i->'lines') LOOP
  IF jsonb_typeof(l) IS DISTINCT FROM 'object' OR NOT(l ?& ARRAY['lineNumber','parts']) OR l-ARRAY['lineNumber','parts']<>'{}'::jsonb OR jsonb_typeof(l->'lineNumber') IS DISTINCT FROM 'number' OR(l->>'lineNumber')::numeric NOT BETWEEN 1 AND 200 OR(l->>'lineNumber')::numeric<>trunc((l->>'lineNumber')::numeric) OR jsonb_typeof(l->'parts') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(l->'parts') NOT BETWEEN 1 AND 3 OR(SELECT count(DISTINCT value->>'category') FROM jsonb_array_elements(l->'parts'))<>jsonb_array_length(l->'parts') THEN RETURN false;END IF;
  FOR p IN SELECT value FROM jsonb_array_elements(l->'parts') LOOP
   IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& ARRAY['category','amountMinor']) OR p-ARRAY['category','amountMinor']<>'{}'::jsonb OR jsonb_typeof(p->'category') IS DISTINCT FROM 'string' OR p->>'category' NOT IN('operating','investing','financing') OR jsonb_typeof(p->'amountMinor') IS DISTINCT FROM 'string' OR(p->>'amountMinor')!~'^[1-9][0-9]{0,77}$' THEN RETURN false;END IF;
  END LOOP;
 END LOOP;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.cash_flow_classification_source(i jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;j record;l record;parts jsonb;rows jsonb:='[]';v integer;n integer:=0;BEGIN
 IF NOT public.cash_flow_input_valid(i) THEN RETURN jsonb_build_object('unavailable','CASH_FLOW_INPUT_INVALID');END IF;
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=tenant AND id=(i->>'journalId')::uuid;IF j.id IS NULL THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':'||j.id::text,368));
 IF j.reverses_id IS NOT NULL THEN RETURN jsonb_build_object('unavailable','CLASSIFY_ORIGINAL_JOURNAL');END IF;
 IF j.purpose<>'activity' THEN RETURN jsonb_build_object('unavailable','CASH_FLOW_ACTIVITY_REQUIRED');END IF;
 SELECT version INTO v FROM public.cash_flow_classifications WHERE academy_id=tenant AND journal_id=j.id;
 FOR l IN SELECT o.line_number,o.account_id,o.account_version,o.side,o.amount_minor,a.hub_id,a.currency_id,u.unit_scale FROM public.finance_journal_lines o JOIN public.finance_account_revisions r ON r.academy_id=o.academy_id AND r.account_id=o.account_id AND r.version=o.account_version JOIN public.finance_accounts a ON a.academy_id=o.academy_id AND a.id=o.account_id JOIN public.finance_currency_revisions u ON u.academy_id=a.academy_id AND u.currency_id=a.currency_id AND u.version=a.currency_version WHERE o.academy_id=tenant AND o.journal_id=j.id AND r.kind='asset' AND r.operational_role IN('cash','bank') ORDER BY o.line_number LOOP
  SELECT x->'parts' INTO parts FROM jsonb_array_elements(i->'lines') x WHERE(x->>'lineNumber')::integer=l.line_number;
  IF parts IS NOT NULL THEN
   n=n+1;IF(SELECT sum((p->>'amountMinor')::numeric) FROM jsonb_array_elements(parts) p)<>l.amount_minor THEN RETURN jsonb_build_object('unavailable','CASH_FLOW_SPLIT_MUST_MATCH_LINE');END IF;
   SELECT jsonb_agg(p ORDER BY p->>'category') INTO parts FROM jsonb_array_elements(parts) p;
  ELSE parts=jsonb_build_array(jsonb_build_object('category','unclassified','amountMinor',l.amount_minor::text));END IF;
  rows=rows||jsonb_build_array(jsonb_build_object('lineNumber',l.line_number,'accountId',l.account_id,'accountVersion',l.account_version,'hubId',l.hub_id,'currencyId',l.currency_id,'unitScale',l.unit_scale,'side',l.side,'amountMinor',l.amount_minor::text,'parts',parts));
 END LOOP;
 IF n<>jsonb_array_length(i->'lines') THEN RETURN jsonb_build_object('unavailable','CASH_FLOW_CASH_LINE_REQUIRED');END IF;
 IF jsonb_array_length(rows)=0 THEN RETURN jsonb_build_object('unavailable','CASH_FLOW_CASH_LINE_REQUIRED');END IF;
 RETURN jsonb_build_object('before',jsonb_build_object('version',coalesce(v,0)),'journalId',j.id,'postedOn',j.posted_on,'classificationBasis','explicit_reviewed_original_cash_lines','reversalPolicy','original_classification_inherited_with_inverse_side','lines',rows);
END $$;
CREATE FUNCTION public.cash_flow_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;h record;s jsonb;expected_scope jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CASH_FLOW_REVISION_IMMUTABLE' USING ERRCODE='23514';END IF;
 s=public.cash_flow_classification_source(NEW.input);SELECT * INTO h FROM public.cash_flow_classifications WHERE academy_id=NEW.academy_id AND journal_id=NEW.journal_id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 SELECT CASE WHEN bool_or(hub_id IS NULL) THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) ELSE jsonb_build_object('all',false,'hubs',jsonb_agg(hub_id ORDER BY hub_id)) END INTO expected_scope FROM(SELECT DISTINCT a.hub_id FROM public.finance_journal_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.journal_id) hubs;
 IF h.journal_id IS NULL OR h.version<>NEW.version OR(NEW.version=1 AND h.created_by<>NEW.changed_by) OR NEW.version<>(NEW.input->>'expectedVersion')::integer+1 OR NEW.version<>(SELECT count(*)+1 FROM public.cash_flow_classification_revisions WHERE academy_id=NEW.academy_id AND journal_id=NEW.journal_id)
 OR s IS NULL OR s ? 'unavailable' OR s->>'journalId' IS DISTINCT FROM NEW.journal_id::text OR NEW.source_snapshot-'before' IS DISTINCT FROM s-'before' OR NEW.source_snapshot#>>'{before,version}' IS DISTINCT FROM NEW.input->>'expectedVersion'
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'finance.cash-flow.replace' OR p.target_id IS DISTINCT FROM NEW.journal_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'cash-flow.view' OR p.scope IS DISTINCT FROM expected_scope OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM NEW.source_snapshot OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'CASH_FLOW_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER cash_flow_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cash_flow_classification_revisions FOR EACH ROW EXECUTE FUNCTION public.cash_flow_revision_guard();
CREATE CONSTRAINT TRIGGER cash_flow_reviewed AFTER INSERT ON public.cash_flow_classification_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.cash_flow_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.journal_id AND e.actor_id=NEW.changed_by AND e.action='finance.cash-flow.replaced' AND e.created_at=transaction_timestamp() AND e.changes=jsonb_build_object('severity','critical','approvalId',NEW.approval_id,'afterVersion',NEW.version,'accountingPosted',false)) THEN RAISE EXCEPTION 'CASH_FLOW_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_flow_complete AFTER INSERT ON public.cash_flow_classification_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.cash_flow_complete();
CREATE FUNCTION public.cash_flow_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.cash-flow.replace' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.cash_flow_classification_revisions r WHERE r.academy_id=NEW.academy_id AND r.journal_id=NEW.target_id AND r.version=NEW.target_version+1 AND r.approval_id=NEW.id AND r.changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'CASH_FLOW_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_flow_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.cash_flow_effect_required();
CREATE FUNCTION public.cash_flow_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE hubs uuid[];BEGIN
 SELECT array_agg(DISTINCT a.hub_id) INTO hubs FROM public.finance_journal_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.target_id;
 IF hubs IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('cash-flow.view',hubs),public.approval_hub_binding('journals.view',hubs),public.approval_hub_binding('accounts.view',hubs),public.approval_hub_binding('ledger.view',hubs));END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_cash_flow_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='finance.cash-flow.replace') EXECUTE FUNCTION public.cash_flow_privacy();
REVOKE ALL ON FUNCTION public.cash_flow_input_valid(jsonb),public.cash_flow_classification_source(jsonb),public.cash_flow_revision_guard(),public.cash_flow_complete(),public.cash_flow_effect_required(),public.cash_flow_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cash_flow_input_valid(jsonb),public.cash_flow_classification_source(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 368 $$;

-- Analytical tags for explicitly reviewed standalone operating journals only.
-- Automated/private operational sources keep their own workflows and rights.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('journal-attribution.view','View reviewed manual journal analytical assignments','Finance',true,ARRAY['hub','country','region','city']),
 ('journal-attribution.edit','Request reviewed manual journal analytical assignments without reposting money','Finance',true,ARRAY['hub','country','region','city']);
-- Numeric JSON1 and1.0 identify the same line;do not allow ambiguous overrides.
DO $$ DECLARE body text;needle text:='count(DISTINCT value->>''lineNumber'')';BEGIN
 body=pg_get_functiondef('public.expense_cost_input_valid(jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'ATTRIBUTION_LINE_VALIDATOR_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'count(DISTINCT value->''lineNumber'')');
END $$;
CREATE TABLE public.manual_journal_attributions(
 academy_id uuid NOT NULL,journal_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,journal_id),FOREIGN KEY(academy_id,journal_id) REFERENCES public.finance_journals(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE TABLE public.manual_journal_attribution_revisions(
 academy_id uuid NOT NULL,journal_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),input jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=262144),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,journal_id,version),FOREIGN KEY(academy_id,journal_id) REFERENCES public.manual_journal_attributions(academy_id,journal_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.manual_journal_attributions ADD CONSTRAINT journal_attribution_current FOREIGN KEY(academy_id,journal_id,version) REFERENCES public.manual_journal_attribution_revisions(academy_id,journal_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['manual_journal_attributions','manual_journal_attribution_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER journal_attribution_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,journal_id,version,created_by),UPDATE(version) ON public.manual_journal_attributions TO kavosh_runtime;
GRANT INSERT(academy_id,journal_id,version,input,source_snapshot,changed_by,approval_id) ON public.manual_journal_attribution_revisions TO kavosh_runtime;
CREATE TRIGGER journal_attribution_header BEFORE INSERT OR UPDATE ON public.manual_journal_attributions FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.manual_journal_attribution_input_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE l jsonb;n integer:=0;BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& ARRAY['journalId','expectedVersion','lines','reason']) OR i-ARRAY['journalId','expectedVersion','lines','reason']<>'{}'::jsonb OR octet_length(i::text)>65536 OR jsonb_typeof(i->'lines') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 -- Reuse the strict existing target/weight/reason/version validator. Only the
 -- source ID name and journal's real200line bound differ from expense bills.
 IF NOT public.expense_cost_input_valid((i-ARRAY['journalId','lines'])||jsonb_build_object('billId',i->'journalId','lines','[]'::jsonb)) OR jsonb_array_length(i->'lines')>200 OR(SELECT count(DISTINCT value->'lineNumber') FROM jsonb_array_elements(i->'lines'))<>jsonb_array_length(i->'lines') THEN RETURN false;END IF;
 FOR l IN SELECT value FROM jsonb_array_elements(i->'lines') LOOP
  IF jsonb_typeof(l) IS DISTINCT FROM 'object' OR jsonb_typeof(l->'lineNumber') IS DISTINCT FROM 'number' OR(l->>'lineNumber')::numeric NOT BETWEEN 1 AND 200 OR(l->>'lineNumber')::numeric<>trunc((l->>'lineNumber')::numeric) THEN RETURN false;END IF;
  IF NOT public.expense_cost_input_valid((i-ARRAY['journalId','lines'])||jsonb_build_object('billId',i->'journalId','lines',jsonb_build_array(l||jsonb_build_object('lineNumber',1)))) THEN RETURN false;END IF;
  n=n+jsonb_array_length(l->'targets');IF n>200 THEN RETURN false;END IF;
 END LOOP;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.manual_journal_attribution_source(i jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;j record;l record;v integer;accounts jsonb;targets jsonb;parts jsonb;rows jsonb:='[]';polarity integer;BEGIN
 IF NOT public.manual_journal_attribution_input_valid(i) THEN RETURN jsonb_build_object('unavailable','JOURNAL_ATTRIBUTION_INPUT_INVALID');END IF;
 SELECT h.*,p.action,p.status INTO j FROM public.finance_journals h JOIN public.approval_requests p ON p.academy_id=h.academy_id AND p.id=h.approval_id WHERE h.academy_id=tenant AND h.id=(i->>'journalId')::uuid;
 IF j.id IS NULL THEN RETURN NULL;END IF;
 IF j.reverses_id IS NOT NULL OR j.purpose<>'activity' OR j.action<>'finance.journal.post' OR j.status<>'applied' THEN RETURN jsonb_build_object('unavailable','MANUAL_ACTIVITY_JOURNAL_REQUIRED');END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':'||j.id::text,34));
 SELECT version INTO v FROM public.manual_journal_attributions WHERE academy_id=tenant AND journal_id=j.id;
 IF EXISTS(SELECT 1 FROM public.finance_journals r WHERE r.academy_id=tenant AND r.reverses_id=j.id) THEN RETURN jsonb_build_object('unavailable','REVERSED_JOURNAL_ATTRIBUTION_SOURCE');END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(i->'lines') x WHERE NOT EXISTS(SELECT 1 FROM public.finance_journal_lines o JOIN public.finance_account_revisions r ON r.academy_id=o.academy_id AND r.account_id=o.account_id AND r.version=o.account_version WHERE o.academy_id=tenant AND o.journal_id=j.id AND o.line_number=(x->>'lineNumber')::integer AND r.kind IN('income','expense'))) THEN RETURN jsonb_build_object('unavailable','JOURNAL_ATTRIBUTION_LINE_NOT_OPERATING');END IF;
 SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id,a.version) INTO accounts FROM(
  SELECT DISTINCT h.id,r.version,h.hub_id AS "hubId",r.kind,h.currency_id AS "currencyId",h.currency_version AS "currencyVersion",u.unit_scale AS "unitScale" FROM public.finance_journal_lines o JOIN public.finance_accounts h ON h.academy_id=o.academy_id AND h.id=o.account_id JOIN public.finance_account_revisions r ON r.academy_id=o.academy_id AND r.account_id=o.account_id AND r.version=o.account_version JOIN public.finance_currency_revisions u ON u.academy_id=h.academy_id AND u.currency_id=h.currency_id AND u.version=h.currency_version WHERE o.academy_id=tenant AND o.journal_id=j.id) a;
 FOR l IN SELECT o.*,r.kind,h.hub_id,h.currency_id,h.currency_version,u.unit_scale FROM public.finance_journal_lines o JOIN public.finance_accounts h ON h.academy_id=o.academy_id AND h.id=o.account_id JOIN public.finance_account_revisions r ON r.academy_id=o.academy_id AND r.account_id=o.account_id AND r.version=o.account_version JOIN public.finance_currency_revisions u ON u.academy_id=h.academy_id AND u.currency_id=h.currency_id AND u.version=h.currency_version WHERE o.academy_id=tenant AND o.journal_id=j.id AND r.kind IN('income','expense') ORDER BY o.line_number LOOP
  SELECT x->'targets' INTO targets FROM jsonb_array_elements(i->'lines') x WHERE(x->>'lineNumber')::integer=l.line_number;
  targets=coalesce(targets,jsonb_build_array(jsonb_build_object('hubId',l.hub_id,'classId',NULL,'studentId',NULL,'weight',1)));
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(targets) t WHERE(t->>'hubId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.hubs h WHERE h.academy_id=tenant AND h.id=(t->>'hubId')::uuid)) OR(t->>'classId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.classes c WHERE c.academy_id=tenant AND c.id=(t->>'classId')::uuid AND c.hub_id=(t->>'hubId')::uuid)) OR(t->>'studentId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.student_profiles p WHERE p.academy_id=tenant AND p.person_id=(t->>'studentId')::uuid))) THEN RETURN jsonb_build_object('unavailable','JOURNAL_ATTRIBUTION_TARGET_CHANGED');END IF;
  polarity=CASE WHEN(l.kind='income' AND l.side='credit') OR(l.kind='expense' AND l.side='debit') THEN 1 ELSE -1 END;
  WITH picks AS(SELECT t,jsonb_build_array(t->>'hubId',t->>'classId',t->>'studentId')::text k,(t->>'weight')::numeric w FROM jsonb_array_elements(targets) t),
  shares AS(SELECT *,floor(l.amount_minor*w/sum(w) OVER()) base,mod(l.amount_minor*w,sum(w) OVER()) rem FROM picks),
  ranked AS(SELECT *,row_number() OVER(ORDER BY rem DESC,k COLLATE "C") rn,l.amount_minor-sum(base) OVER() residual FROM shares),
  exact AS(SELECT *,base+CASE WHEN rn<=residual THEN 1 ELSE 0 END amount FROM ranked)
  SELECT jsonb_agg(t||jsonb_build_object('amountMinor',amount::text,'signedMinor',(amount*polarity)::text) ORDER BY k COLLATE "C") INTO parts FROM exact;
  rows=rows||jsonb_build_array(jsonb_build_object('lineNumber',l.line_number,'accountId',l.account_id,'accountVersion',l.account_version,'originalHubId',l.hub_id,'currencyId',l.currency_id,'currencyVersion',l.currency_version,'unitScale',l.unit_scale,'kind',l.kind,'side',l.side,'amountMinor',l.amount_minor::text,'signedMinor',(l.amount_minor*polarity)::text,'targets',parts));
 END LOOP;
 IF jsonb_array_length(rows)=0 THEN RETURN jsonb_build_object('unavailable','JOURNAL_HAS_NO_OPERATING_LINES');END IF;
 RETURN jsonb_build_object('before',jsonb_build_object('version',coalesce(v,0)),'journalId',j.id,'postedOn',j.posted_on::text,'sourceAction',j.action,'allocationPolicy','largest_remainder_original_minor_units_stable_context_key','accounts',accounts,'lines',rows);
END $$;
CREATE FUNCTION public.manual_journal_attribution_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;h record;s jsonb;expected_scope jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'JOURNAL_ATTRIBUTION_REVISION_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT public.manual_journal_attribution_input_valid(NEW.input) THEN RAISE EXCEPTION 'JOURNAL_ATTRIBUTION_INPUT_INVALID' USING ERRCODE='23514';END IF;
 s=public.manual_journal_attribution_source(NEW.input);SELECT * INTO h FROM public.manual_journal_attributions WHERE academy_id=NEW.academy_id AND journal_id=NEW.journal_id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 SELECT CASE WHEN bool_or(hub_id IS NULL) THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) ELSE jsonb_build_object('all',false,'hubs',jsonb_agg(hub_id ORDER BY hub_id)) END INTO expected_scope FROM(
 SELECT(a->>'hubId')::uuid hub_id FROM jsonb_array_elements(s->'accounts') a
 UNION SELECT(t->>'hubId')::uuid FROM jsonb_array_elements(s->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'targets') t
 UNION SELECT(t->>'hubId')::uuid FROM public.manual_journal_attribution_revisions r CROSS JOIN LATERAL jsonb_array_elements(r.source_snapshot->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'targets') t WHERE r.academy_id=NEW.academy_id AND r.journal_id=NEW.journal_id AND r.version=NEW.version-1) hubs;
 IF h.journal_id IS NULL OR h.version<>NEW.version OR(NEW.version=1 AND h.created_by<>NEW.changed_by) OR NEW.version<>(NEW.input->>'expectedVersion')::integer+1 OR NEW.version<>(SELECT count(*)+1 FROM public.manual_journal_attribution_revisions WHERE academy_id=NEW.academy_id AND journal_id=NEW.journal_id)
 OR s IS NULL OR s ? 'unavailable' OR s->>'journalId' IS DISTINCT FROM NEW.journal_id::text OR NEW.source_snapshot-'before' IS DISTINCT FROM s-'before' OR NEW.source_snapshot#>>'{before,version}' IS DISTINCT FROM NEW.input->>'expectedVersion'
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'finance.journal-attribution.replace' OR p.target_id IS DISTINCT FROM NEW.journal_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'journal-attribution.view' OR p.scope IS DISTINCT FROM expected_scope OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM NEW.source_snapshot OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'JOURNAL_ATTRIBUTION_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER journal_attribution_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.manual_journal_attribution_revisions FOR EACH ROW EXECUTE FUNCTION public.manual_journal_attribution_guard();
CREATE CONSTRAINT TRIGGER journal_attribution_reviewed AFTER INSERT ON public.manual_journal_attribution_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.manual_journal_attribution_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;BEGIN
 s=public.manual_journal_attribution_source(NEW.input);
 IF s IS NULL OR s-'before' IS DISTINCT FROM NEW.source_snapshot-'before' THEN RAISE EXCEPTION 'JOURNAL_ATTRIBUTION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.journal_id AND e.actor_id=NEW.changed_by AND e.action='finance.journal-attribution.replaced' AND e.created_at=transaction_timestamp() AND e.changes=jsonb_build_object('severity','critical','approvalId',NEW.approval_id,'afterVersion',NEW.version,'accountingPosted',false)) THEN RAISE EXCEPTION 'JOURNAL_ATTRIBUTION_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_attribution_complete AFTER INSERT ON public.manual_journal_attribution_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manual_journal_attribution_complete();
CREATE FUNCTION public.manual_journal_attribution_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.journal-attribution.replace' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.manual_journal_attribution_revisions r WHERE r.academy_id=NEW.academy_id AND r.journal_id=NEW.target_id AND r.version=NEW.target_version+1 AND r.approval_id=NEW.id AND r.changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'JOURNAL_ATTRIBUTION_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_attribution_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manual_journal_attribution_effect();
CREATE FUNCTION public.manual_journal_attribution_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE t jsonb;original_hubs uuid[];target_hubs uuid[];classes jsonb:='[]';people jsonb:='[]';cap text;BEGIN
 SELECT array_agg(DISTINCT a.hub_id) INTO original_hubs FROM public.finance_journal_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id WHERE l.academy_id=NEW.academy_id AND l.journal_id=NEW.target_id;
 IF original_hubs IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;END IF;
 FOREACH cap IN ARRAY ARRAY['journal-attribution.view','journals.view','accounts.view','ledger.view'] LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding(cap,original_hubs));END LOOP;
 FOR t IN SELECT target FROM jsonb_array_elements(NEW.payload->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'targets') target
 UNION SELECT target FROM public.manual_journal_attributions a JOIN public.manual_journal_attribution_revisions r ON r.academy_id=a.academy_id AND r.journal_id=a.journal_id AND r.version=a.version CROSS JOIN LATERAL jsonb_array_elements(r.source_snapshot->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'targets') target WHERE a.academy_id=NEW.academy_id AND a.journal_id=NEW.target_id LOOP
  target_hubs=array_append(target_hubs,(t->>'hubId')::uuid);IF t->>'classId' IS NOT NULL THEN classes=classes||jsonb_build_array(jsonb_build_object('id',t->>'classId','hubId',t->>'hubId'));END IF;IF t->>'studentId' IS NOT NULL THEN people=people||jsonb_build_array(t->'studentId');END IF;
 END LOOP;
 IF target_hubs IS NOT NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('journal-attribution.view',target_hubs));END IF;
 IF jsonb_array_length(classes)>0 THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','classes.view','scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',(SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(classes)))));END IF;
 IF jsonb_array_length(people)>0 THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','students.view','expenseCostPeople',(SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(people))));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_journal_attribution_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='finance.journal-attribution.replace') EXECUTE FUNCTION public.manual_journal_attribution_privacy();
REVOKE ALL ON FUNCTION public.manual_journal_attribution_input_valid(jsonb),public.manual_journal_attribution_source(jsonb),public.manual_journal_attribution_guard(),public.manual_journal_attribution_complete(),public.manual_journal_attribution_effect(),public.manual_journal_attribution_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manual_journal_attribution_input_valid(jsonb),public.manual_journal_attribution_source(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 251 $$;

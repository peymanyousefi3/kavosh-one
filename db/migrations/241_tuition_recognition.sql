-- Explicit reviewed releases of deferred NET tuition. No cash/tax posting,
-- automatic service certification,old-invoice reinterpretation or backfill.
CREATE TABLE public.tuition_recognitions(
 academy_id uuid NOT NULL,id uuid NOT NULL,invoice_id uuid NOT NULL,student_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,
 amount_minor numeric NOT NULL CHECK(amount_minor>0 AND amount_minor=trunc(amount_minor) AND amount_minor<1e38),
 currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),
 deferred_account uuid NOT NULL,deferred_version integer NOT NULL,revenue_account uuid NOT NULL,revenue_version integer NOT NULL,
 earned_on date NOT NULL,posted_on date NOT NULL,reference text NOT NULL CHECK(reference~'^[A-Z0-9][A-Z0-9._-]{0,99}$'),
 input jsonb NOT NULL,source_snapshot jsonb NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,void_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,invoice_id,student_id,class_id,hub_id) REFERENCES public.tuition_invoices(academy_id,id,student_id,class_id,hub_id),
 FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),
 FOREIGN KEY(academy_id,deferred_account,deferred_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,revenue_account,revenue_version) REFERENCES public.finance_account_revisions(academy_id,account_id,version),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX tuition_recognition_invoice ON public.tuition_recognitions(academy_id,invoice_id,id);
CREATE UNIQUE INDEX tuition_recognition_reference ON public.tuition_recognitions(academy_id,invoice_id,reference) WHERE void_id IS NULL;
CREATE TABLE public.tuition_recognition_voids(
 academy_id uuid NOT NULL,id uuid NOT NULL,recognition_id uuid NOT NULL,posted_on date NOT NULL,input jsonb NOT NULL,source_snapshot jsonb NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,recognition_id),UNIQUE(academy_id,id,recognition_id),
 FOREIGN KEY(academy_id,recognition_id) REFERENCES public.tuition_recognitions(academy_id,id),
 FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),
 FOREIGN KEY(academy_id,id) REFERENCES public.finance_journals(academy_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.tuition_recognitions ADD CONSTRAINT tuition_recognition_void_identity FOREIGN KEY(academy_id,void_id,id) REFERENCES public.tuition_recognition_voids(academy_id,id,recognition_id) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['tuition_recognitions','tuition_recognition_voids'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
 EXECUTE format('CREATE CONSTRAINT TRIGGER recognition_reviewed AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete()',t);
END LOOP;END $$;
CREATE FUNCTION public.tuition_recognition_input_valid(i jsonb,rev boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$ DECLARE k text;r jsonb;d date;keys text[];BEGIN
 keys=CASE WHEN rev THEN ARRAY['recognitionId','period','postedOn','reason'] ELSE ARRAY['invoiceId','amount','deferredAccount','revenueAccount','earnedOn','postedOn','period','reference','earningReview','reason'] END;
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR octet_length(i::text)>16384 OR NOT(i ?& keys) OR i-keys<>'{}'::jsonb THEN RETURN false;END IF;
 k=CASE WHEN rev THEN 'recognitionId' ELSE 'invoiceId' END;IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR(i->>k)::uuid::text IS DISTINCT FROM i->>k THEN RETURN false;END IF;
 FOREACH k IN ARRAY CASE WHEN rev THEN ARRAY['reason'] ELSE ARRAY['reason','earningReview'] END LOOP IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR length(btrim(i->>k)) NOT BETWEEN 1 AND 2000 THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY CASE WHEN rev THEN ARRAY['period'] ELSE ARRAY['period','deferredAccount','revenueAccount'] END LOOP r=i->k;IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT(r ?& ARRAY['id','version']) OR r-ARRAY['id','version']<>'{}'::jsonb OR jsonb_typeof(r->'id') IS DISTINCT FROM 'string' OR(r->>'id')::uuid::text IS DISTINCT FROM r->>'id' OR jsonb_typeof(r->'version') IS DISTINCT FROM 'number' OR(r->>'version')::numeric NOT BETWEEN 1 AND 2147483647 OR(r->>'version')::numeric<>trunc((r->>'version')::numeric) THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY CASE WHEN rev THEN ARRAY['postedOn'] ELSE ARRAY['postedOn','earnedOn'] END LOOP IF jsonb_typeof(i->k) IS DISTINCT FROM 'string' OR i->>k!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;d=(i->>k)::date;IF d NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN RETURN false;END IF;END LOOP;
 IF NOT rev AND(jsonb_typeof(i->'amount') IS DISTINCT FROM 'string' OR length(i->>'amount')>80 OR i->>'amount'!~'^[0-9]+([.][0-9]+)?$' OR jsonb_typeof(i->'reference') IS DISTINCT FROM 'string' OR i->>'reference'!~'^[A-Z0-9][A-Z0-9._-]{0,99}$') THEN RETURN false;END IF;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.tuition_recognition_source(i jsonb,rev boolean,p_exclude uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;x record;b public.tuition_recognitions%ROWTYPE;p record;ids uuid[];accounts jsonb;used numeric;latest date;BEGIN
 IF NOT public.tuition_recognition_input_valid(i,rev) THEN RETURN NULL;END IF;
 IF rev THEN SELECT * INTO b FROM public.tuition_recognitions WHERE academy_id=tenant AND id=(i->>'recognitionId')::uuid;IF NOT FOUND THEN RETURN NULL;END IF;END IF;
 SELECT h.*,d.issued_on,t.net_minor,u.currency_id,u.unit_scale INTO x FROM public.tuition_invoices h JOIN public.billing_documents d ON d.academy_id=h.academy_id AND d.id=h.id JOIN public.tuition_plans u ON u.academy_id=h.academy_id AND u.id=h.plan_id JOIN public.tuition_plan_revisions t ON t.academy_id=h.academy_id AND t.plan_id=h.plan_id AND t.version=h.plan_version
 WHERE h.academy_id=tenant AND h.id=CASE WHEN rev THEN b.invoice_id ELSE(i->>'invoiceId')::uuid END FOR UPDATE OF h;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF rev THEN SELECT * INTO b FROM public.tuition_recognitions WHERE academy_id=tenant AND id=(i->>'recognitionId')::uuid FOR UPDATE;ids=ARRAY[b.deferred_account,b.revenue_account];ELSE ids=ARRAY[(i#>>'{deferredAccount,id}')::uuid,(i#>>'{revenueAccount,id}')::uuid];END IF;
 SELECT * INTO p FROM public.finance_periods WHERE academy_id=tenant AND id=(i#>>'{period,id}')::uuid FOR SHARE;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM id FROM public.finance_accounts WHERE academy_id=tenant AND id=ANY(ids) ORDER BY id FOR SHARE;
 SELECT jsonb_agg(jsonb_build_object('id',a.id,'version',a.version,'active',a.active,'hubId',a.hub_id,'kind',a.kind,'role',a.operational_role,'currencyId',a.currency_id,'unitScale',a.unit_scale) ORDER BY a.id) INTO accounts FROM public.finance_account_catalogue a WHERE a.academy_id=tenant AND a.id=ANY(ids);
 IF accounts IS NULL OR jsonb_array_length(accounts)<>2 THEN RETURN NULL;END IF;
 SELECT coalesce(sum(amount_minor) FILTER(WHERE void_id IS NULL OR void_id=p_exclude),0) INTO used FROM public.tuition_recognitions WHERE academy_id=tenant AND invoice_id=x.id AND id IS DISTINCT FROM p_exclude;
 SELECT greatest(x.issued_on,max(on_date)) INTO latest FROM(SELECT posted_on on_date FROM public.tuition_recognitions WHERE academy_id=tenant AND invoice_id=x.id AND id IS DISTINCT FROM p_exclude UNION ALL SELECT v.posted_on FROM public.tuition_recognition_voids v JOIN public.tuition_recognitions h ON h.academy_id=v.academy_id AND h.id=v.recognition_id WHERE h.academy_id=tenant AND h.invoice_id=x.id AND v.id IS DISTINCT FROM p_exclude) dates;
 RETURN jsonb_build_object('invoice',jsonb_build_object('id',x.id,'studentId',x.student_id,'classId',x.class_id,'hubId',x.hub_id,'planId',x.plan_id,'planVersion',x.plan_version,'recognition',x.recognition,'creditId',x.credit_id,'issuedOn',x.issued_on::text,'netMinor',trunc(x.net_minor)::text,'currencyId',x.currency_id,'unitScale',x.unit_scale,'deferredAccount',x.consideration_account),
 'usedMinor',trunc(used)::text,'latestOn',latest::text,'accounts',accounts,'period',jsonb_build_object('version',p.version,'state',p.state,'startsOn',p.starts_on::text,'endsOn',p.ends_on::text,'closedThrough',(SELECT max(ends_on)::text FROM public.finance_periods WHERE academy_id=tenant AND active_closing_run_id IS NOT NULL AND state='closed')),
 'before',CASE WHEN rev THEN jsonb_build_object('id',b.id,'voidId',nullif(b.void_id,p_exclude),'amountMinor',trunc(b.amount_minor)::text,'deferredAccount',b.deferred_account,'deferredVersion',b.deferred_version,'revenueAccount',b.revenue_account,'revenueVersion',b.revenue_version,'postedOn',b.posted_on::text) ELSE NULL END);
END $$;
CREATE FUNCTION public.tuition_recognition_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE rev boolean:=TG_TABLE_NAME='tuition_recognition_voids';s jsonb;x jsonb;p record;a jsonb;period jsonb;amount numeric;target jsonb;BEGIN
 IF TG_OP='UPDATE' THEN IF OLD.void_id IS NOT NULL OR NEW.void_id IS NULL OR to_jsonb(NEW)-'void_id' IS DISTINCT FROM to_jsonb(OLD)-'void_id' THEN RAISE EXCEPTION 'TUITION_RECOGNITION_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;END IF;
 s=public.tuition_recognition_source(NEW.input,rev);x=s->'invoice';period=s->'period';SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 target=jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',x->>'classId','hubId',x->>'hubId')),'people',jsonb_build_array(jsonb_build_object('id',x->>'studentId','hubId',x->>'hubId')),'recordContext',jsonb_build_object('classId',x->>'classId','hubId',x->>'hubId','studentId',x->>'studentId'));
 IF s IS NULL OR p.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR p.action IS DISTINCT FROM (CASE WHEN rev THEN 'finance.tuition-recognition.void' ELSE 'finance.tuition-recognition.record' END) OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version IS DISTINCT FROM 0 OR p.privacy_capability IS DISTINCT FROM 'invoices.edit' OR public.scope_contains(p.scope,target) IS NOT TRUE OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR NOT public.report_comment_human_verified(NEW.created_by) THEN RAISE EXCEPTION 'TUITION_RECOGNITION_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) AND(NEW.created_by=(x->>'studentId')::uuid OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=(x->>'studentId')::uuid AND guardian_id=NEW.created_by)) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.posted_on=(NEW.input->>'postedOn')::date;NEW.created_at=clock_timestamp();
 IF (period->>'version')::integer IS DISTINCT FROM(NEW.input#>>'{period,version}')::integer OR period->>'state' IS DISTINCT FROM 'open' OR NEW.posted_on NOT BETWEEN(period->>'startsOn')::date AND(period->>'endsOn')::date OR(period->>'closedThrough' IS NOT NULL AND NEW.posted_on<=(period->>'closedThrough')::date) OR NEW.posted_on<(s->>'latestOn')::date THEN RAISE EXCEPTION 'TUITION_RECOGNITION_POSTING_DATE_INVALID' USING ERRCODE='23514';END IF;
 IF rev THEN
  IF s#>>'{before,voidId}' IS NOT NULL OR NEW.recognition_id IS DISTINCT FROM(s#>>'{before,id}')::uuid THEN RAISE EXCEPTION 'TUITION_RECOGNITION_ALREADY_VOIDED' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 amount=(NEW.input->>'amount')::numeric*power(10::numeric,(x->>'unitScale')::integer);
 IF x->>'recognition' IS DISTINCT FROM 'deferred' OR x->>'creditId' IS NOT NULL OR amount<>trunc(amount) OR amount<=0 OR amount>=1e38 OR amount+(s->>'usedMinor')::numeric>(x->>'netMinor')::numeric OR(NEW.input->>'earnedOn')::date>NEW.posted_on THEN RAISE EXCEPTION 'TUITION_RECOGNITION_BALANCE_INVALID' USING ERRCODE='23514';END IF;
 NEW.invoice_id=(x->>'id')::uuid;NEW.student_id=(x->>'studentId')::uuid;NEW.class_id=(x->>'classId')::uuid;NEW.hub_id=(x->>'hubId')::uuid;NEW.currency_id=(x->>'currencyId')::uuid;NEW.unit_scale=(x->>'unitScale')::integer;NEW.amount_minor=amount;NEW.deferred_account=(NEW.input#>>'{deferredAccount,id}')::uuid;NEW.deferred_version=(NEW.input#>>'{deferredAccount,version}')::integer;NEW.revenue_account=(NEW.input#>>'{revenueAccount,id}')::uuid;NEW.revenue_version=(NEW.input#>>'{revenueAccount,version}')::integer;NEW.earned_on=(NEW.input->>'earnedOn')::date;NEW.reference=NEW.input->>'reference';
 IF NEW.deferred_account IS DISTINCT FROM(x->>'deferredAccount')::uuid OR NEW.deferred_account=NEW.revenue_account THEN RAISE EXCEPTION 'TUITION_RECOGNITION_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(s->'accounts') LOOP
  IF a->'active' IS DISTINCT FROM 'true'::jsonb OR a->>'currencyId' IS DISTINCT FROM x->>'currencyId' OR a->'unitScale' IS DISTINCT FROM x->'unitScale' OR(a->>'hubId' IS NOT NULL AND a->>'hubId' IS DISTINCT FROM x->>'hubId') OR(a->>'id'=NEW.deferred_account::text AND(a->>'role'<>'deferred_revenue' OR(a->>'version')::integer<>NEW.deferred_version)) OR(a->>'id'=NEW.revenue_account::text AND(a->>'role'<>'revenue' OR(a->>'version')::integer<>NEW.revenue_version)) THEN RAISE EXCEPTION 'TUITION_RECOGNITION_MAPPING_INVALID' USING ERRCODE='23514';END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER tuition_recognition_guard BEFORE INSERT OR UPDATE ON public.tuition_recognitions FOR EACH ROW EXECUTE FUNCTION public.tuition_recognition_guard();
CREATE TRIGGER tuition_recognition_void_guard BEFORE INSERT ON public.tuition_recognition_voids FOR EACH ROW EXECUTE FUNCTION public.tuition_recognition_guard();
CREATE FUNCTION public.tuition_recognition_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE j record;b record;p record;BEGIN
 SELECT * INTO j FROM public.finance_journals WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF j.id IS NULL OR j.approval_id IS DISTINCT FROM NEW.approval_id OR j.posted_by IS DISTINCT FROM NEW.created_by OR j.posted_on IS DISTINCT FROM NEW.posted_on OR j.period_id IS DISTINCT FROM(NEW.input#>>'{period,id}')::uuid OR j.period_version IS DISTINCT FROM(NEW.input#>>'{period,version}')::integer OR j.line_count<>2 OR j.purpose IS DISTINCT FROM 'activity' THEN RAISE EXCEPTION 'TUITION_RECOGNITION_POSTING_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='tuition_recognitions' THEN
  IF j.reverses_id IS NOT NULL OR j.description IS DISTINCT FROM 'Reviewed deferred tuition recognition' OR j.reference IS DISTINCT FROM NEW.reference OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=1 AND account_id=NEW.deferred_account AND account_version=NEW.deferred_version AND side='debit' AND amount_minor=NEW.amount_minor AND note='') OR NOT EXISTS(SELECT 1 FROM public.finance_journal_lines WHERE academy_id=NEW.academy_id AND journal_id=NEW.id AND line_number=2 AND account_id=NEW.revenue_account AND account_version=NEW.revenue_version AND side='credit' AND amount_minor=NEW.amount_minor AND note='') THEN RAISE EXCEPTION 'TUITION_RECOGNITION_POSTING_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO b FROM public.tuition_recognitions WHERE academy_id=NEW.academy_id AND id=NEW.recognition_id;
  IF j.description IS DISTINCT FROM 'Correction of deferred tuition recognition' OR j.reference IS DISTINCT FROM 'TUITION-RECOGNITION-CORRECTION' OR b.void_id IS DISTINCT FROM NEW.id OR j.reverses_id IS DISTINCT FROM b.id THEN RAISE EXCEPTION 'TUITION_RECOGNITION_CORRECTION_INCOMPLETE' USING ERRCODE='23514';END IF;
 END IF;
 IF public.tuition_recognition_source(NEW.input,TG_TABLE_NAME='tuition_recognition_voids',NEW.id) IS DISTINCT FROM NEW.source_snapshot THEN RAISE EXCEPTION 'TUITION_RECOGNITION_SOURCE_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tuition_recognition_complete AFTER INSERT ON public.tuition_recognitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tuition_recognition_complete();
CREATE CONSTRAINT TRIGGER tuition_recognition_void_complete AFTER INSERT ON public.tuition_recognition_voids DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tuition_recognition_complete();
CREATE FUNCTION public.tuition_recognition_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND((NEW.action='finance.tuition-recognition.record' AND NOT EXISTS(SELECT 1 FROM public.tuition_recognitions WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id)) OR(NEW.action='finance.tuition-recognition.void' AND NOT EXISTS(SELECT 1 FROM public.tuition_recognition_voids WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id))) THEN RAISE EXCEPTION 'TUITION_RECOGNITION_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tuition_recognition_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.tuition_recognition_effect();
CREATE FUNCTION public.tuition_recognition_reversal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.tuition_recognitions WHERE academy_id=NEW.academy_id AND id=NEW.reverses_id) AND NOT EXISTS(SELECT 1 FROM public.tuition_recognition_voids v JOIN public.approval_requests p ON p.academy_id=v.academy_id AND p.id=v.approval_id WHERE v.academy_id=NEW.academy_id AND v.id=NEW.id AND v.recognition_id=NEW.reverses_id AND p.action='finance.tuition-recognition.void' AND p.target_id=NEW.id AND p.payload=v.input AND p.id=NEW.approval_id) THEN RAISE EXCEPTION 'TUITION_RECOGNITION_CORRECTION_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER tuition_recognition_reversal_guard BEFORE INSERT ON public.finance_journals FOR EACH ROW WHEN(NEW.reverses_id IS NOT NULL) EXECUTE FUNCTION public.tuition_recognition_reversal_guard();
CREATE FUNCTION public.tuition_recognition_credit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.credit_id IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM public.tuition_recognitions WHERE academy_id=NEW.academy_id AND invoice_id=NEW.id AND void_id IS NULL) THEN RAISE EXCEPTION 'REVERSE_TUITION_RECOGNITION_BEFORE_CREDIT' USING ERRCODE='23514';END IF;
  IF(SELECT issued_on FROM public.billing_documents WHERE academy_id=NEW.academy_id AND id=NEW.credit_id)<(SELECT max(event_on) FROM(SELECT posted_on event_on FROM public.tuition_recognitions WHERE academy_id=NEW.academy_id AND invoice_id=NEW.id UNION ALL SELECT v.posted_on FROM public.tuition_recognition_voids v JOIN public.tuition_recognitions r ON r.academy_id=v.academy_id AND r.id=v.recognition_id WHERE r.academy_id=NEW.academy_id AND r.invoice_id=NEW.id) dates) THEN RAISE EXCEPTION 'TUITION_CREDIT_BEFORE_RECOGNITION_CORRECTION' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER tuition_recognition_credit_guard BEFORE UPDATE ON public.tuition_invoices FOR EACH ROW EXECUTE FUNCTION public.tuition_recognition_credit_guard();
CREATE FUNCTION public.tuition_recognition_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a jsonb;BEGIN
 FOR a IN SELECT value FROM jsonb_array_elements(NEW.review_context->'accounts') LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('journals.view',ARRAY[(a->>'hubId')::uuid]));END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER zz_tuition_recognition_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.tuition-recognition.record','finance.tuition-recognition.void')) EXECUTE FUNCTION public.tuition_recognition_privacy();
GRANT SELECT ON public.tuition_recognitions,public.tuition_recognition_voids TO kavosh_runtime;
GRANT INSERT(academy_id,id,input,source_snapshot,approval_id,created_by) ON public.tuition_recognitions TO kavosh_runtime;
GRANT INSERT(academy_id,id,recognition_id,input,source_snapshot,approval_id,created_by) ON public.tuition_recognition_voids TO kavosh_runtime;
GRANT UPDATE(void_id) ON public.tuition_recognitions TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.tuition_recognition_input_valid(jsonb,boolean),public.tuition_recognition_source(jsonb,boolean,uuid),public.tuition_recognition_guard(),public.tuition_recognition_complete(),public.tuition_recognition_effect(),public.tuition_recognition_reversal_guard(),public.tuition_recognition_credit_guard(),public.tuition_recognition_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tuition_recognition_input_valid(jsonb,boolean),public.tuition_recognition_source(jsonb,boolean,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 241 $$;

INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('counterparty-statements.view','View retained counterparty statements','Finance',true,ARRAY['hub','country','region','city']),
 ('counterparty-statements.edit','Request reviewed statement issuance and withdrawal','Finance',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.counterparty_statement_records(
 academy_id uuid NOT NULL,id uuid NOT NULL,payee_id uuid NOT NULL,reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 1 AND 80),
 from_on date NOT NULL,through_on date NOT NULL,currency_ids uuid[],version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,payee_id,reference),CHECK(from_on<=through_on),
 FOREIGN KEY(academy_id,payee_id) REFERENCES public.financial_payees(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id)
);
CREATE TABLE public.counterparty_statement_revisions(
 academy_id uuid NOT NULL,statement_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('issued','withdrawn')),
 input jsonb NOT NULL CHECK(octet_length(input::text)<=32768),source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=2097152),content jsonb NOT NULL CHECK(octet_length(content::text)<=2097152),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(academy_id,statement_id,version),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,statement_id) REFERENCES public.counterparty_statement_records(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.counterparty_statement_records ADD CONSTRAINT counterparty_statement_current FOREIGN KEY(academy_id,id,version) REFERENCES public.counterparty_statement_revisions(academy_id,statement_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX counterparty_statement_directory ON public.counterparty_statement_records(academy_id,payee_id,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['counterparty_statement_records','counterparty_statement_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER statement_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,payee_id,reference,from_on,through_on,currency_ids,created_by),UPDATE(version) ON public.counterparty_statement_records TO kavosh_runtime;
GRANT INSERT(academy_id,statement_id,version,input,source_snapshot,changed_by,approval_id) ON public.counterparty_statement_revisions TO kavosh_runtime;
CREATE FUNCTION public.counterparty_statement_input_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE d jsonb;k text;v date;BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& ARRAY['expectedVersion','definition','reason']) OR i-ARRAY['expectedVersion','definition','reason']<>'{}'::jsonb OR octet_length(i::text)>32768 OR jsonb_typeof(i->'expectedVersion') IS DISTINCT FROM 'number' OR i->>'expectedVersion'!~'^(0|[1-9][0-9]*)$' OR(i->>'expectedVersion')::numeric>2147483646 OR jsonb_typeof(i->'reason') IS DISTINCT FROM 'string' OR length(btrim(i->>'reason')) NOT BETWEEN 1 AND 2000 OR i->>'reason'~'[[:cntrl:]]' THEN RETURN false;END IF;
 d=i->'definition';IF d='null'::jsonb THEN RETURN(i->>'expectedVersion')::integer>0;END IF;
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& ARRAY['payee','reference','from','through','statementOn','dueOn','language']) OR d-ARRAY['payee','reference','from','through','currencyIds','statementOn','dueOn','language']<>'{}'::jsonb OR jsonb_typeof(d->'payee') IS DISTINCT FROM 'object' OR (d->'payee')-ARRAY['id','version']<>'{}'::jsonb OR NOT(d->'payee' ?& ARRAY['id','version']) OR jsonb_typeof(d#>'{payee,id}') IS DISTINCT FROM 'string' OR(d#>>'{payee,id}')::uuid::text IS DISTINCT FROM d#>>'{payee,id}' OR jsonb_typeof(d#>'{payee,version}') IS DISTINCT FROM 'number' OR d#>>'{payee,version}'!~'^[1-9][0-9]*$' OR(d#>>'{payee,version}')::numeric>2147483647 THEN RETURN false;END IF;
 IF jsonb_typeof(d->'reference') IS DISTINCT FROM 'string' OR length(btrim(d->>'reference')) NOT BETWEEN 1 AND 80 OR d->>'reference'~'[[:cntrl:]]' OR d->>'language' IS NULL OR d->>'language' NOT IN('en','fr','zh-CN') THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['from','through','statementOn','dueOn'] LOOP
  IF jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR d->>k!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;v=(d->>k)::date;IF v NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RETURN false;END IF;
 END LOOP;
 IF d->>'from'>d->>'through' OR d->>'through'>d->>'statementOn' OR d->>'statementOn'>d->>'dueOn' THEN RETURN false;END IF;
 IF d ? 'currencyIds' THEN
  IF jsonb_typeof(d->'currencyIds') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  IF jsonb_array_length(d->'currencyIds') NOT BETWEEN 1 AND 200 OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'currencyIds') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR(x#>>'{}')::uuid::text IS DISTINCT FROM x#>>'{}') OR jsonb_array_length(d->'currencyIds')<>(SELECT count(DISTINCT x) FROM jsonb_array_elements(d->'currencyIds') x) THEN RETURN false;END IF;
 END IF;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.counterparty_statement_record_source(p_id uuid,i jsonb,p_scopes jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE h record;d jsonb;o record;b jsonb;v record;ids uuid[];scopes jsonb;BEGIN
 IF NOT public.counterparty_statement_input_valid(i) THEN RETURN jsonb_build_object('unavailable','STATEMENT_INPUT_INVALID');END IF;
 SELECT * INTO h FROM public.counterparty_statement_records WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_id;d=i->'definition';
 IF(i->>'expectedVersion')::integer>0 THEN
  IF h.id IS NULL THEN RETURN jsonb_build_object('unavailable','STATEMENT_NOT_FOUND');END IF;
  SELECT jsonb_build_object('version',version,'state',state,'contentSha256',encode(sha256(convert_to(content::text,'UTF8')),'hex')) INTO b FROM public.counterparty_statement_revisions WHERE academy_id=h.academy_id AND statement_id=h.id AND version=(i->>'expectedVersion')::integer;
  IF b IS NULL THEN RETURN jsonb_build_object('unavailable','STATEMENT_VERSION_CHANGED');END IF;
  IF d='null'::jsonb THEN
   IF b->>'state'<>'issued' THEN RETURN jsonb_build_object('unavailable','STATEMENT_WITHDRAWAL_UNAVAILABLE');END IF;
   d=jsonb_build_object('payee',jsonb_build_object('id',h.payee_id),'reference',h.reference,'from',h.from_on,'through',h.through_on);
   IF h.currency_ids IS NOT NULL THEN d=d||jsonb_build_object('currencyIds',h.currency_ids);END IF;
  ELSIF d#>>'{payee,id}' IS DISTINCT FROM h.payee_id::text OR d->>'reference' IS DISTINCT FROM h.reference OR(d->>'from')::date IS DISTINCT FROM h.from_on OR(d->>'through')::date IS DISTINCT FROM h.through_on OR coalesce(d->'currencyIds','null'::jsonb) IS DISTINCT FROM coalesce(to_jsonb(h.currency_ids),'null'::jsonb) THEN RETURN jsonb_build_object('unavailable','STATEMENT_IDENTITY_IMMUTABLE');END IF;
 END IF;
 SELECT p.*,r.name,r.legal_name,r.active INTO o FROM public.financial_payees p JOIN public.financial_payee_revisions r ON r.academy_id=p.academy_id AND r.payee_id=p.id AND r.version=p.version WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=(d#>>'{payee,id}')::uuid;
 IF o.id IS NULL OR o.kind='academy' THEN RETURN jsonb_build_object('unavailable','EXTERNAL_COUNTERPARTY_REQUIRED');END IF;
 IF i->'definition'<>'null'::jsonb AND(o.version IS DISTINCT FROM(d#>>'{payee,version}')::integer OR NOT o.active) THEN RETURN jsonb_build_object('unavailable','STATEMENT_PAYEE_CHANGED');END IF;
 IF(i->>'expectedVersion')::integer=0 AND EXISTS(SELECT 1 FROM public.counterparty_statement_records WHERE academy_id=o.academy_id AND payee_id=o.id AND reference=d->>'reference' AND id<>p_id) THEN RETURN jsonb_build_object('unavailable','STATEMENT_REFERENCE_EXISTS');END IF;
 IF d ? 'currencyIds' THEN SELECT array_agg(x::uuid ORDER BY x::uuid) INTO ids FROM jsonb_array_elements_text(d->'currencyIds') x;END IF;
 SELECT jsonb_object_agg(name,jsonb_build_object('all',true,'hubs','[]'::jsonb)) INTO scopes FROM public.capability_catalog;scopes=coalesce(p_scopes,scopes);
 SELECT * INTO v FROM public.counterparty_statement_rows(o.id,(d->>'from')::date,(d->>'through')::date,scopes,NULL,NULL,NULL,NULL,2001,ids);
 IF v."sourceFingerprint" IS NULL OR NOT v."validRange" OR v.denied<>0 OR v.unknown<>0 THEN RETURN jsonb_build_object('unavailable','STATEMENT_SOURCE_UNAVAILABLE');END IF;
 IF v."entryCount">2000 OR octet_length(to_jsonb(v)::text)>1800000 THEN RETURN jsonb_build_object('unavailable','STATEMENT_REQUIRES_BACKGROUND_JOB');END IF;
 RETURN jsonb_build_object('snapshot',to_jsonb(v)-'snapshotAt','scope',v."sourceScope",'academy',(SELECT jsonb_build_object('academyId',id,'displayName',name,'legalIdentityVerified',false) FROM public.academies WHERE id=o.academy_id),'payee',jsonb_build_object('id',o.id,'version',o.version,'hubId',o.hub_id,'personId',o.person_id,'kind',o.kind,'name',o.name,'legalName',o.legal_name,'active',o.active),'before',b);
END $$;
CREATE FUNCTION public.counterparty_statement_source_allows(frame jsonb,s jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE v record;ids uuid[];BEGIN
 IF jsonb_typeof(frame) IS DISTINCT FROM 'object' OR NOT(frame ?& ARRAY['payeeId','from','through']) OR frame-ARRAY['payeeId','from','through','currencyIds']<>'{}'::jsonb THEN RETURN false;END IF;
 IF frame ? 'currencyIds' AND frame->'currencyIds'<>'null'::jsonb THEN SELECT array_agg(x::uuid ORDER BY x::uuid) INTO ids FROM jsonb_array_elements_text(frame->'currencyIds') x;END IF;
 SELECT * INTO v FROM public.counterparty_statement_rows((frame->>'payeeId')::uuid,(frame->>'from')::date,(frame->>'through')::date,s,NULL,NULL,NULL,NULL,1,ids);
 RETURN v.denied=0 AND v.unknown=0 AND v."sourceFingerprint" IS NOT NULL AND public.scope_contains(s->'counterparty-statements.view',v."sourceScope");
 EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.guard_counterparty_statement_header() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' OR(TG_OP='INSERT' AND NEW.version<>1) OR(TG_OP='UPDATE' AND(NEW.version<>OLD.version+1 OR to_jsonb(NEW)-'version' IS DISTINCT FROM to_jsonb(OLD)-'version')) THEN RAISE EXCEPTION 'STATEMENT_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER counterparty_statement_header BEFORE INSERT OR UPDATE OR DELETE ON public.counterparty_statement_records FOR EACH ROW EXECUTE FUNCTION public.guard_counterparty_statement_header();
CREATE FUNCTION public.counterparty_statement_content(i jsonb,s jsonb,captured timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog SET TimeZone='UTC' AS $$
 SELECT jsonb_build_object('formatVersion',1,'definition',i->'definition','sender',s->'academy','recipient',s->'payee','capturedAt',captured,'recorded',(s->'snapshot')-ARRAY['sourceScope','denied','unknown','validRange'],'additionalLedgerPosting',false,'paymentExecuted',false,'bankSettlementVerified',false,'legalSetoffAuthorityVerified',false,'delivered',false,'pdfGenerated',false)
$$;
CREATE FUNCTION public.guard_counterparty_statement_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE h record;p record;s jsonb;d jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'STATEMENT_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.counterparty_statement_records WHERE academy_id=NEW.academy_id AND id=NEW.statement_id FOR UPDATE;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;s=public.counterparty_statement_record_source(NEW.statement_id,NEW.input);d=NEW.input->'definition';
 IF s ? 'unavailable' OR h.version IS DISTINCT FROM NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.counterparty_statement_revisions WHERE academy_id=NEW.academy_id AND statement_id=NEW.statement_id) OR(NEW.input->>'expectedVersion')::integer<>NEW.version-1
  OR p.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR p.action IS DISTINCT FROM 'finance.counterparty-statement.change' OR p.target_id IS DISTINCT FROM h.id OR p.target_version<>NEW.version-1 OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR p.scope IS DISTINCT FROM s->'scope' OR p.privacy_capability IS DISTINCT FROM 'counterparty-statements.view' OR NOT public.report_comment_human_verified(NEW.changed_by)
  OR(NEW.version=1 AND(h.created_by IS DISTINCT FROM NEW.changed_by OR h.payee_id::text IS DISTINCT FROM d#>>'{payee,id}' OR h.reference IS DISTINCT FROM d->>'reference' OR h.from_on::text IS DISTINCT FROM d->>'from' OR h.through_on::text IS DISTINCT FROM d->>'through' OR coalesce(to_jsonb(h.currency_ids),'null'::jsonb) IS DISTINCT FROM coalesce(d->'currencyIds','null'::jsonb)))
  OR((s#>>'{payee,personId}')::uuid=NEW.changed_by AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by))
 THEN RAISE EXCEPTION 'STATEMENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=statement_timestamp();
 IF d='null'::jsonb THEN NEW.state='withdrawn';SELECT content INTO NEW.content FROM public.counterparty_statement_revisions WHERE academy_id=NEW.academy_id AND statement_id=NEW.statement_id AND version=NEW.version-1;
 ELSE NEW.state='issued';NEW.content=public.counterparty_statement_content(NEW.input,s,NEW.created_at);END IF;RETURN NEW;
END $$;
CREATE TRIGGER counterparty_statement_revision BEFORE INSERT OR UPDATE OR DELETE ON public.counterparty_statement_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_counterparty_statement_revision();
CREATE CONSTRAINT TRIGGER counterparty_statement_reviewed AFTER INSERT ON public.counterparty_statement_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.complete_counterparty_statement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog SET TimeZone='UTC' AS $$ DECLARE expected jsonb;BEGIN
 IF NEW.state IS DISTINCT FROM(CASE WHEN NEW.input->'definition'='null'::jsonb THEN 'withdrawn' ELSE 'issued' END) OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.action='finance.counterparty-statement.change' AND p.target_id=NEW.statement_id AND p.target_version=NEW.version-1 AND p.payload=NEW.input AND p.review_context=NEW.source_snapshot AND p.scope=NEW.source_snapshot->'scope' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'STATEMENT_REVIEWED_EFFECT_CHANGED' USING ERRCODE='23514';END IF;
 IF public.counterparty_statement_record_source(NEW.statement_id,NEW.input) IS DISTINCT FROM NEW.source_snapshot THEN RAISE EXCEPTION 'STATEMENT_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NEW.input->'definition'='null'::jsonb THEN SELECT content INTO expected FROM public.counterparty_statement_revisions WHERE academy_id=NEW.academy_id AND statement_id=NEW.statement_id AND version=NEW.version-1;ELSE expected=public.counterparty_statement_content(NEW.input,NEW.source_snapshot,NEW.created_at);END IF;
 IF NEW.content IS DISTINCT FROM expected OR NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.statement_id AND e.actor_id=NEW.changed_by AND e.action='finance.counterparty-statement.change' AND e.created_at=transaction_timestamp() AND e.changes=jsonb_build_object('version',NEW.version,'state',NEW.state,'approvalId',NEW.approval_id,'severity','critical','additionalLedgerPosting',false,'paymentExecuted',false,'contentRedacted',true)) THEN RAISE EXCEPTION 'STATEMENT_AUDIT_CONTENT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER counterparty_statement_complete AFTER INSERT ON public.counterparty_statement_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_counterparty_statement();
CREATE FUNCTION public.counterparty_statement_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='finance.counterparty-statement.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.counterparty_statement_revisions r WHERE r.academy_id=NEW.academy_id AND r.statement_id=NEW.target_id AND r.version=NEW.target_version+1 AND r.approval_id=NEW.id AND r.changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'STATEMENT_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER counterparty_statement_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.counterparty_statement_effect_required();
DO $$ DECLARE body text;needle text:='ELSIF b ? ''personId'' THEN';BEGIN
 body=pg_get_functiondef('public.approval_bindings_allow(jsonb,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'STATEMENT_PRIVACY_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'ELSIF b ? ''counterpartyStatement'' THEN
  IF public.counterparty_statement_source_allows(b->''counterpartyStatement'',p_scopes) IS NOT TRUE THEN RETURN false;END IF;
  '||needle);
END $$;
CREATE FUNCTION public.counterparty_statement_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE d jsonb;BEGIN
 d=NEW.payload->'definition';IF d='null'::jsonb THEN SELECT jsonb_build_object('payee',jsonb_build_object('id',payee_id),'from',from_on,'through',through_on,'currencyIds',currency_ids) INTO d FROM public.counterparty_statement_records WHERE academy_id=NEW.academy_id AND id=NEW.target_id;END IF;
 IF d IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('counterpartyStatement',jsonb_build_object('payeeId',d#>>'{payee,id}','from',d->>'from','through',d->>'through','currencyIds',d->'currencyIds')));END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_counterparty_statement_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='finance.counterparty-statement.change') EXECUTE FUNCTION public.counterparty_statement_privacy();
REVOKE ALL ON FUNCTION public.counterparty_statement_input_valid(jsonb),public.counterparty_statement_record_source(uuid,jsonb,jsonb),public.counterparty_statement_source_allows(jsonb,jsonb),public.guard_counterparty_statement_header(),public.counterparty_statement_content(jsonb,jsonb,timestamptz),public.guard_counterparty_statement_revision(),public.complete_counterparty_statement(),public.counterparty_statement_effect_required(),public.counterparty_statement_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.counterparty_statement_input_valid(jsonb),public.counterparty_statement_record_source(uuid,jsonb,jsonb),public.counterparty_statement_source_allows(jsonb,jsonb),public.counterparty_statement_content(jsonb,jsonb,timestamptz) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 274 $$;

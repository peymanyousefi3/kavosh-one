-- Release reviewed statement content to its worker,not to other employees,
-- parents,bots or the public. Released archives never expose later drafts.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('paystatements.publish','Request reviewed worker statement release and withdrawal','Finance',true,ARRAY['hub','person','country','region','city']),
 ('received-paystatements.view','Read only own released payroll statements','Finance',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.pay_statement_releases(
 academy_id uuid NOT NULL,posting_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,posting_id),FOREIGN KEY(academy_id,posting_id) REFERENCES public.payrun_statement_records(academy_id,posting_id)
);
CREATE TABLE public.pay_statement_release_revisions(
 academy_id uuid NOT NULL,posting_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('released','withdrawn')),statement_version integer NOT NULL,recipient_content jsonb NOT NULL CHECK(octet_length(recipient_content::text)<=262144),recipient_sha256 text NOT NULL CHECK(recipient_sha256~'^[a-f0-9]{64}$'),input jsonb NOT NULL CHECK(octet_length(input::text)<=8192),source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=524288),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,posting_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,posting_id) REFERENCES public.pay_statement_releases(academy_id,posting_id),FOREIGN KEY(academy_id,posting_id,statement_version) REFERENCES public.payrun_statement_revisions(academy_id,posting_id,version),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK(recipient_sha256=encode(sha256(convert_to(recipient_content::text,'UTF8')),'hex'))
);
ALTER TABLE public.pay_statement_releases ADD CONSTRAINT pay_statement_release_current FOREIGN KEY(academy_id,posting_id,version) REFERENCES public.pay_statement_release_revisions(academy_id,posting_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX pay_statement_released_archive ON public.pay_statement_release_revisions(academy_id,posting_id,version DESC) WHERE state='released';
CREATE TRIGGER pay_statement_release_header BEFORE INSERT OR UPDATE ON public.pay_statement_releases FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['pay_statement_releases','pay_statement_release_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER pay_statement_release_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,posting_id),UPDATE(version) ON public.pay_statement_releases TO kavosh_runtime;
GRANT INSERT(academy_id,posting_id,version,input,source_snapshot,changed_by,approval_id) ON public.pay_statement_release_revisions TO kavosh_runtime;

CREATE FUNCTION public.pay_statement_recipient_content(c jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF c->'formatVersion' IS DISTINCT FROM '1'::jsonb THEN RETURN NULL;END IF;
 -- An explicit allowlist,not content-minus-a-few-secrets: future admin-only
 -- fields do not silently join the worker projection. Freeze this projection
 -- in each release rather than re-render old releases after helper changes.
 RETURN jsonb_build_object('formatVersion',1,'statementOn',c->>'statementOn','language',c->>'language','reference',c->>'reference','serviceFrom',c->>'serviceFrom','serviceThrough',c->>'serviceThrough','plannedPayOn',c->>'plannedPayOn','workerName',c->>'workerName',
 'employer',jsonb_build_object('legalName',c#>>'{employer,legalName}','address',c#>'{employer,address}'),'currencyCode',c->>'currencyCode','unitScale',c->'unitScale',
 'amounts',jsonb_build_object('grossMinor',c#>>'{amounts,grossMinor}','employeeDeductionMinor',c#>>'{amounts,employeeDeductionMinor}','netMinor',c#>>'{amounts,netMinor}'),
 'earnings',(SELECT coalesce(jsonb_agg(jsonb_build_object('label',e->>'label','calculation',e->>'calculation','rateDescription',e->>'rateDescription','from',e->>'from','through',e->>'through','unitScale',e->'unitScale','grossMinor',e->>'grossMinor','offPeriodSource',e->'offPeriodSource') ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(c->'earnings') WITH ORDINALITY x(e,ord)),
 'employeeDeductions',(SELECT coalesce(jsonb_agg(jsonb_build_object('code',e->>'code','label',e->>'label','amount',e->>'amount') ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(c->'employeeDeductions') WITH ORDINALITY x(e,ord)),
 'vacationPay',jsonb_build_object('includedInGrossMinor',c#>>'{vacationPay,includedInGrossMinor}','explanation',c#>>'{vacationPay,explanation}'),'calculationBasis',c->>'calculationBasis','periodCompletenessVerified',false,'grossCalculationIndependentlyVerified',false,'statutoryRulesCalculated',false,'authorityDocumentsVerified',false,'vacationEntitlementCalculated',false,'paymentDateVerified',false,'isOfficialPaystub',false);
END $$;
CREATE FUNCTION public.pay_statement_release_source(p_posting uuid,p_before integer,p_statement integer) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;g record;h record;r record;b jsonb;content jsonb;s jsonb;BEGIN
 SELECT * INTO p FROM public.payrun_net_postings WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_posting;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO g FROM public.payrun_groups WHERE academy_id=p.academy_id AND id=p.run_id;PERFORM public.lock_hourly_worker(g.person_id);
 SELECT * INTO p FROM public.payrun_net_postings WHERE academy_id=g.academy_id AND id=p_posting;
 SELECT jsonb_build_object('version',version,'state',state,'statementVersion',statement_version,'recipientSha256',recipient_sha256) INTO b FROM public.pay_statement_release_revisions WHERE academy_id=g.academy_id AND posting_id=p_posting AND version=p_before;
 IF p_statement IS NOT NULL THEN
  SELECT * INTO h FROM public.payrun_statement_records WHERE academy_id=g.academy_id AND posting_id=p_posting;
  SELECT * INTO r FROM public.payrun_statement_revisions WHERE academy_id=g.academy_id AND posting_id=p_posting AND version=p_statement;
  content=public.pay_statement_recipient_content(r.content);s=public.payrun_net_source(g.id);
 END IF;
 RETURN jsonb_build_object('posting',jsonb_build_object('id',p.id,'runId',p.run_id,'reversalId',CASE WHEN p_statement IS NOT NULL THEN p.reversal_id ELSE NULL END),'scope',g.scope,'personId',g.person_id,'accounts',p.plan->'accounts','before',b,
 'statement',CASE WHEN p_statement IS NULL THEN NULL ELSE jsonb_build_object('selectedVersion',p_statement,'latestVersion',h.version,'state',r.state,'retainedContentSha256',encode(sha256(convert_to(r.content::text,'UTF8')),'hex')) END,
 'releaseAvailable',CASE WHEN p_statement IS NULL THEN NULL ELSE p.reversal_id IS NULL AND g.cancellation_id IS NULL AND h.version=p_statement AND r.state='recorded' AND content IS NOT NULL AND s->'recordedSourcesCurrent'='true'::jsonb END,
 'alreadyReleased',CASE WHEN p_statement IS NULL THEN false ELSE coalesce(b->>'state'='released' AND(b->>'statementVersion')::integer=p_statement AND b->>'recipientSha256'=encode(sha256(convert_to(content::text,'UTF8')),'hex'),false) END,'recipientContent',content,'recipientSha256',encode(sha256(convert_to(content::text,'UTF8')),'hex'));
END $$;
CREATE FUNCTION public.pay_statement_release_input_valid(i jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& ARRAY['expectedVersion','statementVersion','reason']) OR i-ARRAY['expectedVersion','statementVersion','reason']<>'{}'::jsonb OR octet_length(i::text)>8192 OR jsonb_typeof(i->'expectedVersion') IS DISTINCT FROM 'number' OR i->>'expectedVersion'!~'^(0|[1-9][0-9]*)$' OR(i->>'expectedVersion')::numeric>2147483646 OR jsonb_typeof(i->'reason') IS DISTINCT FROM 'string' OR length(btrim(i->>'reason')) NOT BETWEEN 1 AND 2000 OR i->>'reason'~'[[:cntrl:]]' THEN RETURN false;END IF;
 IF i->'statementVersion'='null'::jsonb THEN RETURN(i->>'expectedVersion')::integer>0;END IF;
 RETURN jsonb_typeof(i->'statementVersion')='number' AND i->>'statementVersion'~'^[1-9][0-9]*$' AND(i->>'statementVersion')::numeric<=2147483647;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.guard_pay_statement_release() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb;p record;current_version integer;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAY_STATEMENT_RELEASE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT public.pay_statement_release_input_valid(NEW.input) OR(NEW.input->>'expectedVersion')::integer<>NEW.version-1 THEN RAISE EXCEPTION 'PAY_STATEMENT_RELEASE_INPUT_INVALID' USING ERRCODE='23514';END IF;
 s=public.pay_statement_release_source(NEW.posting_id,NEW.version-1,(NEW.input->>'statementVersion')::integer);SELECT version INTO current_version FROM public.pay_statement_releases WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s IS NULL OR current_version IS DISTINCT FROM NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.pay_statement_release_revisions WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id) OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.payrun-statement-release.change' OR p.target_id IS DISTINCT FROM NEW.posting_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR p.scope IS DISTINCT FROM s->'scope' OR p.privacy_capability IS DISTINCT FROM 'paystatements.view' OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'PAY_STATEMENT_RELEASE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by=(s->>'personId')::uuid AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 IF NEW.input->'statementVersion'='null'::jsonb THEN
  IF s#>>'{before,state}' IS DISTINCT FROM 'released' THEN RAISE EXCEPTION 'PAY_STATEMENT_RELEASE_WITHDRAWAL_UNAVAILABLE' USING ERRCODE='23514';END IF;
  NEW.state='withdrawn';SELECT statement_version,recipient_content,recipient_sha256 INTO NEW.statement_version,NEW.recipient_content,NEW.recipient_sha256 FROM public.pay_statement_release_revisions WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id AND version=NEW.version-1;
 ELSE
  IF s->'releaseAvailable' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'PAY_STATEMENT_RELEASE_SOURCE_UNAVAILABLE' USING ERRCODE='23514';END IF;
  IF s->'alreadyReleased'='true'::jsonb THEN RAISE EXCEPTION 'PAY_STATEMENT_ALREADY_RELEASED' USING ERRCODE='23514';END IF;
  NEW.state='released';NEW.statement_version=(NEW.input->>'statementVersion')::integer;NEW.recipient_content=s->'recipientContent';NEW.recipient_sha256=s->>'recipientSha256';
 END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER pay_statement_release_guard BEFORE INSERT OR UPDATE OR DELETE ON public.pay_statement_release_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_pay_statement_release();
CREATE CONSTRAINT TRIGGER pay_statement_release_review_applied AFTER INSERT ON public.pay_statement_release_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.pay_statement_release_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.pay_statement_release_source(NEW.posting_id,NEW.version-1,(NEW.input->>'statementVersion')::integer) IS DISTINCT FROM NEW.source_snapshot THEN RAISE EXCEPTION 'PAY_STATEMENT_RELEASE_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.posting_id AND a.actor_id=NEW.changed_by AND a.action='work.payrun-statement-release.change' AND a.created_at=transaction_timestamp() AND a.changes->'version'=to_jsonb(NEW.version) AND a.changes->>'approvalId'=NEW.approval_id::text AND a.changes->>'state'=NEW.state AND a.changes->'severity'='"critical"'::jsonb AND a.changes->'externalDeliveryPerformed'='false'::jsonb AND a.changes->'paymentExecuted'='false'::jsonb) THEN RAISE EXCEPTION 'PAY_STATEMENT_RELEASE_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pay_statement_release_complete AFTER INSERT ON public.pay_statement_release_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pay_statement_release_complete();
CREATE FUNCTION public.pay_statement_release_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.payrun-statement-release.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.pay_statement_release_revisions r WHERE r.academy_id=NEW.academy_id AND r.posting_id=NEW.target_id AND r.version=NEW.target_version+1 AND r.approval_id=NEW.id AND r.changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PAY_STATEMENT_RELEASE_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pay_statement_release_effect_required AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pay_statement_release_effect_required();
CREATE TRIGGER zz_pay_statement_release_source_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.payrun-statement-release.change') EXECUTE FUNCTION public.payrun_posting_privacy();
CREATE TRIGGER zzz_pay_statement_release_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.payrun-statement-release.change') EXECUTE FUNCTION public.pay_statement_privacy();
REVOKE ALL ON FUNCTION public.pay_statement_recipient_content(jsonb),public.pay_statement_release_source(uuid,integer,integer),public.pay_statement_release_input_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_statement_recipient_content(jsonb),public.pay_statement_release_source(uuid,integer,integer),public.pay_statement_release_input_valid(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 165 $$;

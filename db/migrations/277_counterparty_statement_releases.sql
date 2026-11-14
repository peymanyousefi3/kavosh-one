-- Explicit,reviewed recipient copies. No guessed hub manager,email send or
-- second financial ledger. Withdrawals retain the previously released copy.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('counterparty-statements.publish','Request reviewed named recipient statement releases','Finance',true,ARRAY['hub','country','region','city']),
 ('received-statements.view','Read own explicitly released counterparty statements','Finance',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.counterparty_statement_releases(
 academy_id uuid NOT NULL,id uuid NOT NULL,statement_id uuid NOT NULL,statement_version integer NOT NULL,recipient_id uuid NOT NULL,
 recipient_content jsonb NOT NULL CHECK(octet_length(recipient_content::text)<=2097152),recipient_sha256 text NOT NULL CHECK(recipient_sha256=encode(sha256(convert_to(recipient_content::text,'UTF8')),'hex')),
 input jsonb NOT NULL CHECK(octet_length(input::text)<=8192),source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=3145728),created_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,statement_id,statement_version) REFERENCES public.counterparty_statement_revisions(academy_id,statement_id,version),FOREIGN KEY(academy_id,recipient_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.counterparty_statement_release_withdrawals(
 academy_id uuid NOT NULL,id uuid NOT NULL,release_id uuid NOT NULL,input jsonb NOT NULL CHECK(octet_length(input::text)<=8192),source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=3145728),created_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,release_id),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,release_id) REFERENCES public.counterparty_statement_releases(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX counterparty_release_recipient ON public.counterparty_statement_releases(academy_id,recipient_id,id);
CREATE INDEX counterparty_release_statement ON public.counterparty_statement_releases(academy_id,statement_id,recipient_id,statement_version,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['counterparty_statement_releases','counterparty_statement_release_withdrawals'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);EXECUTE format('CREATE TRIGGER release_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,statement_id,statement_version,recipient_id,input,source_snapshot,created_by,approval_id) ON public.counterparty_statement_releases TO kavosh_runtime;
GRANT INSERT(academy_id,id,release_id,input,source_snapshot,created_by,approval_id) ON public.counterparty_statement_release_withdrawals TO kavosh_runtime;
CREATE FUNCTION public.counterparty_recipient_content(c jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 WITH entries AS(SELECT e->>'currencyId' currency_id,jsonb_agg(jsonb_build_object('postedOn',e->>'postedOn','family',e->>'family','category',e->>'category','changeMinor',e->>'change','balanceMinor',e->>'balance','isCorrection',e->'correctionOfId'<>'null'::jsonb) ORDER BY ord) items FROM jsonb_array_elements(c#>'{recorded,entries}') WITH ORDINALITY x(e,ord) GROUP BY e->>'currencyId'),
 days AS(SELECT d->>'currency_id' currency_id,jsonb_agg(jsonb_build_object('postedOn',d->>'postedOn','changeMinor',d->>'change','balanceMinor',d->>'balance') ORDER BY d->>'postedOn') items FROM jsonb_array_elements(c#>'{recorded,days}') d GROUP BY d->>'currency_id')
 SELECT CASE WHEN c->'formatVersion'='1'::jsonb THEN jsonb_build_object('formatVersion',1,'reference',c#>>'{definition,reference}','from',c#>>'{definition,from}','through',c#>>'{definition,through}','statementOn',c#>>'{definition,statementOn}','dueOn',c#>>'{definition,dueOn}','language',c#>>'{definition,language}','capturedAt',c->'capturedAt',
 'sender',jsonb_build_object('displayName',c#>>'{sender,displayName}','legalIdentityVerified',false),'beneficiary',jsonb_build_object('name',c#>>'{recipient,name}','legalName',c#>>'{recipient,legalName}','kind',c#>>'{recipient,kind}'),
 'currencies',(SELECT coalesce(jsonb_agg(jsonb_build_object('code',u->>'currencyCode','scale',u->'scale','openingMinor',u->>'opening','increasesMinor',u->>'increases','decreasesMinor',u->>'decreases','closingMinor',u->>'closing',
 'components',jsonb_build_object('principalMinor',u->>'manual_balance','custodyMinor',u->>'custody','payableMinor',u->>'payable'),
 'entries',coalesce(e.items,'[]'::jsonb),'days',coalesce(d.items,'[]'::jsonb)) ORDER BY u->>'currencyCode',u->>'currency_id'),'[]'::jsonb) FROM jsonb_array_elements(c#>'{recorded,currencies}') u LEFT JOIN entries e ON e.currency_id=u->>'currency_id' LEFT JOIN days d ON d.currency_id=u->>'currency_id'),
 'positiveBalanceMeaning','beneficiary_owes_academy','negativeBalanceMeaning','academy_owes_beneficiary','paymentStatusIncluded',false,'legalSetoffAuthorityVerified',false,'bankSettlementVerified',false,'paymentExecuted',false) END
$$;
CREATE FUNCTION public.counterparty_release_input_valid(i jsonb,withdrawal boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF withdrawal IS NULL OR jsonb_typeof(i) IS DISTINCT FROM 'object' OR octet_length(i::text)>8192 OR jsonb_typeof(i->'reason') IS DISTINCT FROM 'string' OR length(btrim(i->>'reason')) NOT BETWEEN 1 AND 2000 OR i->>'reason'~'[[:cntrl:]]' THEN RETURN false;END IF;
 IF withdrawal THEN RETURN i ?& ARRAY['releaseId','reason'] AND i-ARRAY['releaseId','reason']='{}'::jsonb AND jsonb_typeof(i->'releaseId')='string' AND(i->>'releaseId')::uuid::text=i->>'releaseId';END IF;
 RETURN i ?& ARRAY['statementId','statementVersion','recipientId','reason'] AND i-ARRAY['statementId','statementVersion','recipientId','reason']='{}'::jsonb AND jsonb_typeof(i->'statementId')='string' AND(i->>'statementId')::uuid::text=i->>'statementId' AND jsonb_typeof(i->'recipientId')='string' AND(i->>'recipientId')::uuid::text=i->>'recipientId' AND jsonb_typeof(i->'statementVersion')='number' AND i->>'statementVersion'~'^[1-9][0-9]*$' AND(i->>'statementVersion')::numeric<=2147483647;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.counterparty_release_source(target uuid,i jsonb,withdrawal boolean,scopes jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE a public.counterparty_statement_releases%ROWTYPE;h record;r record;p record;v record;frame jsonb;content jsonb;sid uuid;rid uuid;BEGIN
 IF target IS NULL OR public.counterparty_release_input_valid(i,withdrawal) IS NOT TRUE THEN RETURN jsonb_build_object('unavailable','STATEMENT_RELEASE_INPUT_INVALID');END IF;
 IF withdrawal THEN SELECT * INTO a FROM public.counterparty_statement_releases WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=(i->>'releaseId')::uuid;IF NOT FOUND THEN RETURN jsonb_build_object('unavailable','NOT_FOUND');END IF;sid=a.statement_id;rid=a.recipient_id;
 ELSE sid=(i->>'statementId')::uuid;rid=(i->>'recipientId')::uuid;END IF;
 SELECT * INTO h FROM public.counterparty_statement_records WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=sid;IF NOT FOUND THEN RETURN jsonb_build_object('unavailable','NOT_FOUND');END IF;
 frame=jsonb_build_object('payeeId',h.payee_id,'from',h.from_on,'through',h.through_on,'currencyIds',h.currency_ids);
 IF scopes IS NULL THEN SELECT jsonb_object_agg(name,jsonb_build_object('all',true,'hubs','[]'::jsonb)) INTO scopes FROM public.capability_catalog;END IF;
 SELECT * INTO v FROM public.counterparty_statement_rows(h.payee_id,h.from_on,h.through_on,scopes,NULL,NULL,NULL,NULL,1,h.currency_ids);
 IF v.denied<>0 OR v.unknown<>0 OR v."sourceFingerprint" IS NULL OR public.scope_contains(scopes->'counterparty-statements.view',v."sourceScope") IS NOT TRUE THEN RETURN jsonb_build_object('unavailable','NOT_FOUND');END IF;
 SELECT id,name,hub_id,kind,status,encode(sha256(convert_to(jsonb_build_array(id,auth_user_id,access_version)::text,'UTF8')),'hex') account_binding,public.report_comment_human_verified(id) verified INTO p FROM public.people WHERE academy_id=h.academy_id AND id=rid;
 IF p.id IS NULL OR p.kind<>'human' OR public.scope_contains(scopes->'people.view',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p.id,'hubId',p.hub_id)))) IS NOT TRUE OR public.scope_contains(scopes->'counterparty-statements.publish',v."sourceScope") IS NOT TRUE THEN RETURN jsonb_build_object('unavailable','NOT_FOUND');END IF;
 SELECT * INTO r FROM public.counterparty_statement_revisions WHERE academy_id=h.academy_id AND statement_id=h.id AND version=h.version;
 IF withdrawal THEN
  IF EXISTS(SELECT 1 FROM public.counterparty_statement_release_withdrawals WHERE academy_id=h.academy_id AND release_id=a.id AND id<>target) THEN RETURN jsonb_build_object('unavailable','STATEMENT_RELEASE_ALREADY_WITHDRAWN');END IF;
 ELSE
  IF h.version IS DISTINCT FROM(i->>'statementVersion')::integer OR r.state<>'issued' THEN RETURN jsonb_build_object('unavailable','STATEMENT_RELEASE_EDITION_CHANGED');END IF;
  IF p.status<>'active' OR p.verified IS NOT TRUE THEN RETURN jsonb_build_object('unavailable','VERIFIED_RECIPIENT_REQUIRED');END IF;
  IF EXISTS(SELECT 1 FROM public.counterparty_statement_releases x WHERE x.academy_id=h.academy_id AND x.statement_id=h.id AND x.statement_version=h.version AND x.recipient_id=p.id AND x.id<>target AND NOT EXISTS(SELECT 1 FROM public.counterparty_statement_release_withdrawals w WHERE w.academy_id=x.academy_id AND w.release_id=x.id)) THEN RETURN jsonb_build_object('unavailable','STATEMENT_ALREADY_RELEASED');END IF;
  content=public.counterparty_recipient_content(r.content);IF content IS NULL THEN RETURN jsonb_build_object('unavailable','STATEMENT_RELEASE_CONTENT_UNAVAILABLE');END IF;
 END IF;
 RETURN jsonb_build_object('scope',v."sourceScope",'frame',frame,'statementId',h.id,'statementVersion',h.version,'statementState',r.state,'statementHash',encode(sha256(convert_to(r.content::text,'UTF8')),'hex'),'recipient',jsonb_build_object('id',p.id,'name',p.name,'hubId',p.hub_id,'status',p.status,'verified',p.verified,'accountBinding',p.account_binding),'payeePersonId',(SELECT person_id FROM public.financial_payees WHERE academy_id=h.academy_id AND id=h.payee_id),'originalRelease',CASE WHEN withdrawal THEN jsonb_build_object('id',a.id,'statementVersion',a.statement_version,'recipientSha256',a.recipient_sha256) ELSE NULL END,'recipientContent',content,'recipientSha256',encode(sha256(convert_to(content::text,'UTF8')),'hex'));
END $$;
CREATE FUNCTION public.guard_counterparty_release() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE withdrawal boolean:=TG_TABLE_NAME='counterparty_statement_release_withdrawals';s jsonb;p record;sid uuid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'STATEMENT_RELEASE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF public.counterparty_release_input_valid(NEW.input,withdrawal) IS NOT TRUE THEN RAISE EXCEPTION 'STATEMENT_RELEASE_INPUT_INVALID' USING ERRCODE='23514';END IF;
 IF withdrawal THEN SELECT statement_id INTO sid FROM public.counterparty_statement_releases WHERE academy_id=NEW.academy_id AND id=(NEW.input->>'releaseId')::uuid;ELSE sid=(NEW.input->>'statementId')::uuid;END IF;
 PERFORM 1 FROM public.counterparty_statement_records WHERE academy_id=NEW.academy_id AND id=sid FOR UPDATE;
 s=public.counterparty_release_source(NEW.id,NEW.input,withdrawal);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s ? 'unavailable' OR p.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR p.action IS DISTINCT FROM(CASE WHEN withdrawal THEN 'finance.statement-release.withdraw' ELSE 'finance.statement-release.publish' END) OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR p.scope IS DISTINCT FROM s->'scope' OR p.privacy_capability IS DISTINCT FROM 'counterparty-statements.view' OR NOT public.report_comment_human_verified(NEW.created_by) OR(NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) AND(NEW.created_by=(s#>>'{recipient,id}')::uuid OR NEW.created_by=(s->>'payeePersonId')::uuid)) THEN RAISE EXCEPTION 'STATEMENT_RELEASE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF withdrawal THEN IF NEW.release_id::text IS DISTINCT FROM NEW.input->>'releaseId' THEN RAISE EXCEPTION 'STATEMENT_RELEASE_EXACT_FIELDS_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE IF NEW.statement_id::text IS DISTINCT FROM NEW.input->>'statementId' OR NEW.statement_version IS DISTINCT FROM(NEW.input->>'statementVersion')::integer OR NEW.recipient_id::text IS DISTINCT FROM NEW.input->>'recipientId' THEN RAISE EXCEPTION 'STATEMENT_RELEASE_EXACT_FIELDS_REQUIRED' USING ERRCODE='23514';END IF;NEW.recipient_content=s->'recipientContent';NEW.recipient_sha256=s->>'recipientSha256';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.complete_counterparty_release() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE withdrawal boolean:=TG_TABLE_NAME='counterparty_statement_release_withdrawals';s jsonb;expected_action text;BEGIN
 s=public.counterparty_release_source(NEW.id,NEW.input,withdrawal);expected_action=CASE WHEN withdrawal THEN 'finance.statement-release.withdraw' ELSE 'finance.statement-release.publish' END;
 IF s IS DISTINCT FROM NEW.source_snapshot OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.action=expected_action AND p.status='applied' AND p.target_id=NEW.id AND p.payload=NEW.input AND p.review_context=NEW.source_snapshot AND p.reviewer_id=NEW.created_by) OR NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.id AND e.actor_id=NEW.created_by AND e.action=expected_action AND e.created_at=transaction_timestamp() AND e.changes=jsonb_build_object('approvalId',NEW.approval_id,'severity','critical','recipientContentRedacted',true,'externalDeliveryPerformed',false,'paymentExecuted',false)) THEN RAISE EXCEPTION 'STATEMENT_RELEASE_COMPLETE_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF withdrawal THEN IF NEW.release_id::text IS DISTINCT FROM NEW.input->>'releaseId' THEN RAISE EXCEPTION 'STATEMENT_RELEASE_FIELDS_CHANGED' USING ERRCODE='23514';END IF;
 ELSE IF NEW.recipient_content IS DISTINCT FROM s->'recipientContent' OR NEW.recipient_sha256 IS DISTINCT FROM s->>'recipientSha256' OR NEW.statement_id::text IS DISTINCT FROM NEW.input->>'statementId' OR NEW.statement_version IS DISTINCT FROM(NEW.input->>'statementVersion')::integer OR NEW.recipient_id::text IS DISTINCT FROM NEW.input->>'recipientId' THEN RAISE EXCEPTION 'STATEMENT_RELEASE_FIELDS_CHANGED' USING ERRCODE='23514';END IF;END IF;RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['counterparty_statement_releases','counterparty_statement_release_withdrawals'] LOOP
 EXECUTE format('CREATE TRIGGER release_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_counterparty_release()',t);
 EXECUTE format('CREATE CONSTRAINT TRIGGER release_reviewed AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete()',t);
 EXECUTE format('CREATE CONSTRAINT TRIGGER release_complete AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_counterparty_release()',t);
END LOOP;END $$;
CREATE FUNCTION public.counterparty_release_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND((NEW.action='finance.statement-release.publish' AND NOT EXISTS(SELECT 1 FROM public.counterparty_statement_releases WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id)) OR(NEW.action='finance.statement-release.withdraw' AND NOT EXISTS(SELECT 1 FROM public.counterparty_statement_release_withdrawals WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id))) THEN RAISE EXCEPTION 'STATEMENT_RELEASE_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER counterparty_release_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.counterparty_release_effect_required();
CREATE FUNCTION public.counterparty_release_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.review_context->'frame' IS NULL OR NEW.review_context#>>'{recipient,id}' IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('counterpartyStatement',NEW.review_context->'frame'),jsonb_build_object('capability','people.view','personId',NEW.review_context#>>'{recipient,id}'),jsonb_build_object('capability','counterparty-statements.publish','scope',NEW.scope));END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_counterparty_release_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.statement-release.publish','finance.statement-release.withdraw')) EXECUTE FUNCTION public.counterparty_release_privacy();
REVOKE ALL ON FUNCTION public.counterparty_recipient_content(jsonb),public.counterparty_release_input_valid(jsonb,boolean),public.counterparty_release_source(uuid,jsonb,boolean,jsonb),public.guard_counterparty_release(),public.complete_counterparty_release(),public.counterparty_release_effect_required(),public.counterparty_release_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.counterparty_recipient_content(jsonb),public.counterparty_release_input_valid(jsonb,boolean),public.counterparty_release_source(uuid,jsonb,boolean,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 277 $$;

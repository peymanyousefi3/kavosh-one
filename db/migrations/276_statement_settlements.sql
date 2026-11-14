INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('counterparty-settlements.view','View recorded statement settlement allocations','Finance',true,ARRAY['hub','country','region','city']),
 ('counterparty-settlements.edit','Request reviewed statement settlement allocation changes','Finance',true,ARRAY['hub','country','region','city']);
-- These are allocations of EXISTING payments,not new cash or liabilities.
CREATE TABLE public.counterparty_statement_settlements(
 academy_id uuid NOT NULL,id uuid NOT NULL,statement_id uuid NOT NULL,statement_version integer NOT NULL,
 source_family text NOT NULL CHECK(source_family IN('manual_balance','custody','payable')),source_journal uuid NOT NULL,source_line integer NOT NULL CHECK(source_line BETWEEN 0 AND 200),
 currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),direction integer NOT NULL CHECK(direction IN(-1,1)),amount_minor numeric NOT NULL CHECK(amount_minor=trunc(amount_minor) AND amount_minor>0 AND amount_minor<1e38),allocated_on date NOT NULL,
 input jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=262144),created_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,statement_id,statement_version) REFERENCES public.counterparty_statement_revisions(academy_id,statement_id,version),FOREIGN KEY(academy_id,source_journal) REFERENCES public.finance_journals(academy_id,id),FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.counterparty_settlement_releases(
 academy_id uuid NOT NULL,id uuid NOT NULL,settlement_id uuid NOT NULL,released_on date NOT NULL,input jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=262144),created_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,settlement_id),FOREIGN KEY(academy_id,settlement_id) REFERENCES public.counterparty_statement_settlements(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX statement_settlement_source ON public.counterparty_statement_settlements(academy_id,source_family,source_journal,source_line,id);
CREATE INDEX statement_settlement_target ON public.counterparty_statement_settlements(academy_id,statement_id,currency_id,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['counterparty_statement_settlements','counterparty_settlement_releases'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER settlement_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,statement_id,statement_version,source_family,source_journal,source_line,currency_id,unit_scale,direction,amount_minor,allocated_on,input,source_snapshot,created_by,approval_id) ON public.counterparty_statement_settlements TO kavosh_runtime;
GRANT INSERT(academy_id,id,settlement_id,released_on,input,source_snapshot,created_by,approval_id) ON public.counterparty_settlement_releases TO kavosh_runtime;
CREATE VIEW public.counterparty_settlement_payments WITH(security_invoker=true) AS
 SELECT e.academy_id,e.payee_id,'manual_balance'::text family,e.journal_id,e.line_number::integer line_number,e.currency_id,e.unit_scale,e.delta_minor,j.posted_on,p.handled_by handler_id,r.id reversal_id,r.posted_on reversed_on
 FROM public.counterparty_balance_events e JOIN public.counterparty_payments p ON p.academy_id=e.academy_id AND p.journal_id=e.journal_id JOIN public.finance_journals j ON j.academy_id=e.academy_id AND j.id=e.journal_id LEFT JOIN public.finance_journals r ON r.academy_id=j.academy_id AND r.reverses_id=j.id WHERE e.category='loan_repayment' AND j.reverses_id IS NULL
 UNION ALL SELECT m.academy_id,p.id,'custody',j.id,0,m.currency_id,m.unit_scale,CASE WHEN m.direction='to_academy' THEN -m.amount_minor ELSE m.amount_minor END,j.posted_on,m.handled_by,r.id,r.posted_on
 FROM public.collector_remittances m JOIN public.finance_collectors c ON c.academy_id=m.academy_id AND c.id=m.collector_id JOIN public.financial_payees p ON p.academy_id=c.academy_id AND((p.kind='hub' AND c.kind='hub' AND p.hub_id=c.hub_id) OR(p.kind='person' AND c.kind='person' AND p.person_id=c.person_id) OR(p.kind='organization' AND c.organization_payee_id=p.id)) JOIN public.finance_journals j ON j.academy_id=m.academy_id AND j.id=m.id LEFT JOIN public.finance_journals r ON r.academy_id=j.academy_id AND r.reverses_id=j.id
 UNION ALL SELECT p.academy_id,b.payee_id,'payable',j.id,0,b.currency_id,b.unit_scale,p.amount_minor,j.posted_on,p.handled_by,r.id,r.posted_on
 FROM public.expense_payments p JOIN public.expense_bills b ON b.academy_id=p.academy_id AND b.id=p.bill_id JOIN public.finance_journals j ON j.academy_id=p.academy_id AND j.id=p.id LEFT JOIN public.finance_journals r ON r.academy_id=j.academy_id AND r.reverses_id=j.id WHERE p.settlement_kind='cash';
GRANT SELECT ON public.counterparty_settlement_payments TO kavosh_runtime;
CREATE FUNCTION public.lock_statement_settlement_source(f text,j uuid,l integer) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF nullif(current_setting('app.academy_id',true),'') IS NULL OR f IS NULL OR f NOT IN('manual_balance','custody','payable') OR j IS NULL OR l IS NULL OR l NOT BETWEEN 0 AND 200 THEN RAISE EXCEPTION 'SETTLEMENT_SOURCE_INVALID' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('statement-payment-allocation',current_setting('app.academy_id'),f,j,l)::text,0));
END $$;
-- One bounded date sweep for either payment capacity or statement capacity.
-- Every future reservation counts;future release never frees an earlier day.
CREATE FUNCTION public.statement_payment_membership(snapshot jsonb,content jsonb,f text,j uuid,l integer,posted date) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN jsonb_typeof(snapshot#>'{snapshot,sourceManifest}')='array' THEN CASE WHEN snapshot#>'{snapshot,sourceManifest}' @> jsonb_build_array(jsonb_build_array(f,j,l)) THEN 'included' ELSE 'excluded' END
 WHEN posted IS NULL OR content#>>'{definition,from}' IS NULL OR posted<(content#>>'{definition,from}')::date THEN 'unknown'
 WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(content#>'{recorded,entries}') e WHERE e->>'family'=f AND e->>'journalId'=j::text AND(e->>'lineNumber')::integer=l) THEN 'included' ELSE 'excluded' END
$$;
CREATE FUNCTION public.statement_settlement_capacity(mode text,statement_id uuid,currency_id uuid,f text,j uuid,l integer,on_date date,base_minor numeric,base_scale integer,wanted_direction integer,excluded uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE v record;BEGIN
 WITH selected AS MATERIALIZED(
  SELECT a.*,r.id release_id,r.released_on,p.reversal_id,p.reversed_on,CASE WHEN r.released_on IS NULL AND p.reversed_on IS NULL THEN NULL ELSE greatest(a.allocated_on,least(r.released_on,p.reversed_on)) END ended_on,
   mode='statement' AND public.statement_payment_membership(doc.source_snapshot,doc.content,a.source_family,a.source_journal,a.source_line,p.posted_on)<>'excluded' included
  FROM public.counterparty_statement_settlements a LEFT JOIN public.counterparty_settlement_releases r ON r.academy_id=a.academy_id AND r.settlement_id=a.id AND r.id IS DISTINCT FROM excluded
  LEFT JOIN public.counterparty_statement_records h ON h.academy_id=a.academy_id AND h.id=a.statement_id LEFT JOIN public.counterparty_statement_revisions doc ON doc.academy_id=h.academy_id AND doc.statement_id=h.id AND doc.version=h.version LEFT JOIN public.counterparty_settlement_payments p ON p.academy_id=a.academy_id AND p.payee_id=h.payee_id AND p.family=a.source_family AND p.journal_id=a.source_journal AND p.line_number=a.source_line
  WHERE a.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND a.id IS DISTINCT FROM excluded AND((mode='source' AND a.source_family=f AND a.source_journal=j AND a.source_line=l) OR(mode='statement' AND a.statement_id=statement_id AND a.currency_id=currency_id)) LIMIT 10001
 ),units AS(SELECT greatest(base_scale,coalesce(max(unit_scale),base_scale)) scale FROM selected),
 events AS(SELECT allocated_on event_on,amount_minor*power(10::numeric,(SELECT scale FROM units)-unit_scale) delta,CASE WHEN direction<>wanted_direction OR included THEN 1 ELSE 0 END bad FROM selected
  UNION ALL SELECT ended_on,-amount_minor*power(10::numeric,(SELECT scale FROM units)-unit_scale),CASE WHEN direction<>wanted_direction OR included THEN -1 ELSE 0 END FROM selected WHERE ended_on IS NOT NULL),
 daily AS(SELECT event_on,sum(delta) delta,sum(bad) bad FROM events GROUP BY event_on),running AS(SELECT event_on,sum(delta) OVER(ORDER BY event_on) used,sum(bad) OVER(ORDER BY event_on) bad FROM daily)
 SELECT (SELECT count(*) FROM selected) n,(SELECT scale FROM units) scale,coalesce(sum(delta) FILTER(WHERE event_on<=on_date),0) used,coalesce(sum(bad) FILTER(WHERE event_on<=on_date),0) bad,
 greatest(coalesce(sum(delta) FILTER(WHERE event_on<=on_date),0),coalesce((SELECT max(used) FROM running WHERE event_on>=on_date),0)) maximum,
 greatest(coalesce(sum(bad) FILTER(WHERE event_on<=on_date),0),coalesce((SELECT max(bad) FROM running WHERE event_on>=on_date),0)) max_bad,
 (SELECT encode(sha256(convert_to(coalesce(string_agg(jsonb_build_array(id,release_id,reversal_id)::text,',' ORDER BY id),''),'UTF8')),'hex') FROM selected) stamp INTO v FROM events;
 IF v.n>10000 THEN RAISE EXCEPTION 'SETTLEMENT_HISTORY_LIMIT' USING ERRCODE='54000';END IF;
 RETURN jsonb_build_object('scale',v.scale,'usedMinor',v.used::text,'maximumMinor',v.maximum::text,'bad',v.bad,'maximumBad',v.max_bad,'availableMinor',greatest(0,abs(base_minor)*power(10::numeric,v.scale-base_scale)-v.maximum)::text,'activity',v.n,'sourceStamp',v.stamp);
END $$;
CREATE FUNCTION public.statement_settlement_allows(frame jsonb,s jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE h record;p record;r record;BEGIN
 SELECT * INTO h FROM public.counterparty_statement_records WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=(frame->>'statementId')::uuid;IF NOT FOUND THEN RETURN false;END IF;
 IF NOT public.counterparty_statement_source_allows(jsonb_build_object('payeeId',h.payee_id,'from',h.from_on,'through',h.through_on,'currencyIds',h.currency_ids),s) THEN RETURN false;END IF;
 SELECT * INTO p FROM public.counterparty_settlement_payments WHERE academy_id=h.academy_id AND payee_id=h.payee_id AND family=frame->>'family' AND journal_id=(frame->>'journalId')::uuid AND line_number=(frame->>'lineNumber')::integer;IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO r FROM public.counterparty_statement_rows(h.payee_id,h.from_on,greatest(h.through_on,p.posted_on),s,NULL,NULL,NULL,NULL,1,h.currency_ids);
 RETURN r."sourceFingerprint" IS NOT NULL AND r.denied=0 AND public.scope_contains(s->'counterparty-settlements.view',r."sourceScope");
 EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.statement_settlement_source(target uuid,i jsonb,releasing boolean,scopes jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE a public.counterparty_statement_settlements%ROWTYPE;h record;r record;p record;c jsonb;sp jsonb;tp jsonb;v record;frame jsonb;ids uuid[];at_date date;scale integer;amount numeric;direction integer;BEGIN
 IF target IS NULL OR releasing IS NULL OR public.statement_settlement_input_valid(i,releasing) IS NOT TRUE THEN RETURN jsonb_build_object('unavailable','SETTLEMENT_INPUT_INVALID');END IF;
 IF releasing THEN SELECT * INTO a FROM public.counterparty_statement_settlements WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=(i->>'settlementId')::uuid;IF NOT FOUND THEN RETURN jsonb_build_object('unavailable','NOT_FOUND');END IF;frame=jsonb_build_object('statementId',a.statement_id,'family',a.source_family,'journalId',a.source_journal,'lineNumber',a.source_line);at_date=(i->>'releasedOn')::date;
 ELSE frame=jsonb_build_object('statementId',i->>'statementId','family',i#>>'{source,family}','journalId',i#>>'{source,journalId}','lineNumber',(i#>>'{source,lineNumber}')::integer);at_date=(i->>'allocatedOn')::date;END IF;
 SELECT * INTO h FROM public.counterparty_statement_records WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=(frame->>'statementId')::uuid;
 IF h.id IS NULL THEN RETURN jsonb_build_object('unavailable','NOT_FOUND');END IF;
 IF scopes IS NULL THEN SELECT jsonb_object_agg(name,jsonb_build_object('all',true,'hubs','[]'::jsonb)) INTO scopes FROM public.capability_catalog;END IF;
 IF NOT public.statement_settlement_allows(frame,scopes) THEN RETURN jsonb_build_object('unavailable','NOT_FOUND');END IF;
 SELECT * INTO r FROM public.counterparty_statement_revisions WHERE academy_id=h.academy_id AND statement_id=h.id AND version=h.version;
 SELECT * INTO p FROM public.counterparty_settlement_payments WHERE academy_id=h.academy_id AND payee_id=h.payee_id AND family=frame->>'family' AND journal_id=(frame->>'journalId')::uuid AND line_number=(frame->>'lineNumber')::integer;
 IF h.version IS DISTINCT FROM(i->>'statementVersion')::integer THEN RETURN jsonb_build_object('unavailable','STATEMENT_VERSION_CHANGED');END IF;
 IF releasing THEN
  IF at_date<a.allocated_on OR EXISTS(SELECT 1 FROM public.counterparty_settlement_releases WHERE academy_id=a.academy_id AND settlement_id=a.id AND id<>target) THEN RETURN jsonb_build_object('unavailable','SETTLEMENT_RELEASE_UNAVAILABLE');END IF;
  scale=a.unit_scale;amount=a.amount_minor;direction=a.direction;
 ELSE
  IF r.state<>'issued' THEN RETURN jsonb_build_object('unavailable','STATEMENT_NOT_ISSUED');END IF;
  IF at_date<p.posted_on OR at_date<(r.content#>>'{definition,statementOn}')::date OR(p.reversed_on IS NOT NULL AND p.reversed_on<=at_date) THEN RETURN jsonb_build_object('unavailable','SETTLEMENT_DATE_OR_SOURCE_INVALID');END IF;
  IF jsonb_typeof(r.source_snapshot#>'{snapshot,sourceManifest}')='array' THEN
   IF r.source_snapshot#>'{snapshot,sourceManifest}' @> jsonb_build_array(jsonb_build_array(p.family,p.journal_id,p.line_number)) THEN RETURN jsonb_build_object('unavailable','PAYMENT_ALREADY_INCLUDED_IN_STATEMENT');END IF;
  ELSIF p.posted_on<h.from_on THEN RETURN jsonb_build_object('unavailable','LEGACY_SOURCE_MEMBERSHIP_REVIEW_REQUIRED');
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(r.content#>'{recorded,entries}') e WHERE e->>'family'=p.family AND e->>'journalId'=p.journal_id::text AND(e->>'lineNumber')::integer=p.line_number) THEN RETURN jsonb_build_object('unavailable','PAYMENT_ALREADY_INCLUDED_IN_STATEMENT');END IF;
  SELECT x INTO c FROM jsonb_array_elements(r.content#>'{recorded,currencies}') x WHERE x->>'currency_id'=p.currency_id::text;
  IF c IS NULL OR(c->>'closing')::numeric=0 OR sign((c->>'closing')::numeric)=sign(p.delta_minor) THEN RETURN jsonb_build_object('unavailable','SETTLEMENT_CURRENCY_OR_DIRECTION_INVALID');END IF;
  direction=sign((c->>'closing')::numeric);scale=greatest((c->>'scale')::integer,p.unit_scale);
 END IF;
 SELECT * INTO v FROM public.counterparty_statement_rows(h.payee_id,h.from_on,greatest(h.through_on,p.posted_on),scopes,NULL,NULL,NULL,NULL,1,h.currency_ids);
 sp=public.statement_settlement_capacity('source',h.id,p.currency_id,p.family,p.journal_id,p.line_number,at_date,abs(p.delta_minor),p.unit_scale,direction,target);
 IF c IS NULL THEN SELECT x INTO c FROM jsonb_array_elements(r.content#>'{recorded,currencies}') x WHERE x->>'currency_id'=p.currency_id::text;END IF;
 tp=public.statement_settlement_capacity('statement',h.id,p.currency_id,p.family,p.journal_id,p.line_number,at_date,coalesce((c->>'closing')::numeric,0),coalesce((c->>'scale')::integer,scale),direction,target);
 scale=greatest(scale,(sp->>'scale')::integer,(tp->>'scale')::integer);
 IF releasing THEN amount=a.amount_minor*power(10::numeric,scale-a.unit_scale);ELSE
  IF NOT public.work_money_valid(i->'amount',scale) THEN RETURN jsonb_build_object('unavailable','SETTLEMENT_AMOUNT_INVALID');END IF;amount=(i->>'amount')::numeric*power(10::numeric,scale);
  IF amount<=0 OR amount>=1e38 OR amount>(sp->>'availableMinor')::numeric*power(10::numeric,scale-(sp->>'scale')::integer) OR amount>(tp->>'availableMinor')::numeric*power(10::numeric,scale-(tp->>'scale')::integer) OR(tp->>'maximumBad')::numeric>0 THEN RETURN jsonb_build_object('unavailable','SETTLEMENT_CAPACITY_OR_REVIEW_REQUIRED');END IF;
 END IF;
 RETURN jsonb_build_object('frame',frame,'statementVersion',h.version,'statementHash',encode(sha256(convert_to(r.content::text,'UTF8')),'hex'),'statementState',r.state,'scope',v."sourceScope",'payeePersonId',(SELECT person_id FROM public.financial_payees WHERE academy_id=h.academy_id AND id=h.payee_id),'payment',to_jsonb(p)-'handler_id','scale',scale,'direction',direction,'amountMinor',amount::text,'on',at_date,'sourceCapacity',sp,'statementCapacity',tp,'originalAllocation',CASE WHEN releasing THEN jsonb_build_object('id',a.id,'amountMinor',a.amount_minor::text,'scale',a.unit_scale,'allocatedOn',a.allocated_on) ELSE NULL END);
END $$;
CREATE FUNCTION public.statement_settlement_input_valid(i jsonb,releasing boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE d date;s jsonb;BEGIN
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR octet_length(i::text)>32768 OR jsonb_typeof(i->'statementVersion') IS DISTINCT FROM 'number' OR i->>'statementVersion'!~'^[1-9][0-9]*$' OR(i->>'statementVersion')::numeric>2147483647 OR jsonb_typeof(i->'reason') IS DISTINCT FROM 'string' OR length(btrim(i->>'reason')) NOT BETWEEN 1 AND 2000 OR i->>'reason'~'[[:cntrl:]]' THEN RETURN false;END IF;
 IF releasing THEN
  IF NOT(i ?& ARRAY['statementVersion','settlementId','releasedOn','reason']) OR i-ARRAY['statementVersion','settlementId','releasedOn','reason']<>'{}'::jsonb OR jsonb_typeof(i->'settlementId') IS DISTINCT FROM 'string' OR(i->>'settlementId')::uuid::text IS DISTINCT FROM i->>'settlementId' OR jsonb_typeof(i->'releasedOn') IS DISTINCT FROM 'string' OR i->>'releasedOn'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;d=(i->>'releasedOn')::date;
 ELSE
  IF NOT(i ?& ARRAY['statementVersion','statementId','source','amount','allocatedOn','basis','reason']) OR i-ARRAY['statementVersion','statementId','source','amount','allocatedOn','basis','reason']<>'{}'::jsonb OR jsonb_typeof(i->'statementId') IS DISTINCT FROM 'string' OR(i->>'statementId')::uuid::text IS DISTINCT FROM i->>'statementId' OR i->>'basis' IS DISTINCT FROM 'net_statement_balance' OR jsonb_typeof(i->'amount') IS DISTINCT FROM 'string' OR length(i->>'amount')>80 OR i->>'amount'!~'^[0-9]+([.][0-9]+)?$' OR jsonb_typeof(i->'allocatedOn') IS DISTINCT FROM 'string' OR i->>'allocatedOn'!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;d=(i->>'allocatedOn')::date;s=i->'source';
  IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR NOT(s ?& ARRAY['family','journalId','lineNumber']) OR s-ARRAY['family','journalId','lineNumber']<>'{}'::jsonb OR s->>'family' IS NULL OR s->>'family' NOT IN('manual_balance','custody','payable') OR jsonb_typeof(s->'journalId') IS DISTINCT FROM 'string' OR(s->>'journalId')::uuid::text IS DISTINCT FROM s->>'journalId' OR jsonb_typeof(s->'lineNumber') IS DISTINCT FROM 'number' OR s->>'lineNumber'!~'^(0|[1-9][0-9]*)$' OR(s->>'lineNumber')::numeric>200 THEN RETURN false;END IF;
 END IF;RETURN d BETWEEN DATE '1900-01-01' AND DATE '9999-12-31';
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
ALTER TABLE public.counterparty_statement_settlements ADD CONSTRAINT settlement_exact_fields CHECK(
 statement_id::text IS NOT DISTINCT FROM source_snapshot#>>'{frame,statementId}' AND statement_version::text IS NOT DISTINCT FROM source_snapshot->>'statementVersion' AND source_family IS NOT DISTINCT FROM source_snapshot#>>'{frame,family}' AND source_journal::text IS NOT DISTINCT FROM source_snapshot#>>'{frame,journalId}' AND source_line::text IS NOT DISTINCT FROM source_snapshot#>>'{frame,lineNumber}' AND currency_id::text IS NOT DISTINCT FROM source_snapshot#>>'{payment,currency_id}' AND unit_scale IS NOT DISTINCT FROM(source_snapshot->>'scale')::integer AND direction IS NOT DISTINCT FROM(source_snapshot->>'direction')::integer AND amount_minor IS NOT DISTINCT FROM(source_snapshot->>'amountMinor')::numeric AND allocated_on::text IS NOT DISTINCT FROM source_snapshot->>'on');
ALTER TABLE public.counterparty_settlement_releases ADD CONSTRAINT settlement_release_exact_fields CHECK(settlement_id::text IS NOT DISTINCT FROM input->>'settlementId' AND released_on::text IS NOT DISTINCT FROM input->>'releasedOn');
CREATE FUNCTION public.statement_settlement_status(p_id uuid,p_version integer,p_on date,scopes jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE result jsonb;BEGIN
 IF p_on IS NULL OR p_on NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' THEN RAISE EXCEPTION 'SETTLEMENT_STATUS_DATE_INVALID' USING ERRCODE='22023';END IF;
 WITH h AS MATERIALIZED(SELECT * FROM public.counterparty_statement_records WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_id),
 r AS MATERIALIZED(SELECT r.* FROM h JOIN public.counterparty_statement_revisions r ON r.academy_id=h.academy_id AND r.statement_id=h.id AND r.version=coalesce(p_version,h.version)),
 links AS MATERIALIZED(SELECT a.*,x.id release_id,x.released_on,p.reversal_id,p.reversed_on,a.allocated_on<=p_on AND(x.released_on IS NULL OR x.released_on>p_on) AND(p.reversed_on IS NULL OR p.reversed_on>p_on) active,
 public.statement_settlement_allows(jsonb_build_object('statementId',h.id,'family',a.source_family,'journalId',a.source_journal,'lineNumber',a.source_line),scopes) allowed,
 public.statement_payment_membership((SELECT source_snapshot FROM r),(SELECT content FROM r),a.source_family,a.source_journal,a.source_line,p.posted_on)<>'excluded' included
 FROM h JOIN public.counterparty_statement_settlements a ON a.academy_id=h.academy_id AND a.statement_id=h.id LEFT JOIN public.counterparty_settlement_releases x ON x.academy_id=a.academy_id AND x.settlement_id=a.id LEFT JOIN public.counterparty_settlement_payments p ON p.academy_id=a.academy_id AND p.payee_id=h.payee_id AND p.family=a.source_family AND p.journal_id=a.source_journal AND p.line_number=a.source_line LIMIT 10001),
 targets AS MATERIALIZED(SELECT (x->>'currency_id')::uuid currency_id,(x->>'scale')::integer scale,(x->>'closing')::numeric closing FROM r CROSS JOIN LATERAL jsonb_array_elements(r.content#>'{recorded,currencies}') x),
 currencies AS(SELECT currency_id FROM targets UNION SELECT currency_id FROM links),units AS(SELECT c.currency_id,greatest(coalesce(t.scale,0),coalesce(max(a.unit_scale),0)) scale,coalesce(t.closing,0) closing,coalesce(t.scale,0) target_scale FROM currencies c LEFT JOIN targets t ON t.currency_id=c.currency_id LEFT JOIN links a ON a.currency_id=c.currency_id GROUP BY c.currency_id,t.scale,t.closing),
 amounts AS(SELECT u.currency_id,u.scale,u.closing*power(10::numeric,u.scale-u.target_scale) signed_due,coalesce(sum(a.amount_minor*power(10::numeric,u.scale-a.unit_scale)) FILTER(WHERE a.active AND a.direction=sign(u.closing) AND NOT a.included),0) matched,count(*) FILTER(WHERE a.active AND(a.direction<>sign(u.closing) OR a.included)) bad FROM units u LEFT JOIN links a ON a.currency_id=u.currency_id GROUP BY u.currency_id,u.scale,u.closing,u.target_scale),
 result_rows AS(SELECT currency_id,scale,signed_due::text "signedDueMinor",matched::text "matchedMinor",greatest(0,abs(signed_due)-matched)::text "remainingMinor",CASE WHEN(SELECT state FROM r)='withdrawn' THEN 'withdrawn' WHEN bad>0 OR matched>abs(signed_due) THEN 'needs_review' WHEN signed_due=0 THEN 'no_payment_due' WHEN matched=abs(signed_due) THEN 'paid' WHEN matched>0 THEN 'partially_paid' ELSE 'unpaid' END status FROM amounts)
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM h) OR NOT EXISTS(SELECT 1 FROM r) OR NOT public.counterparty_statement_source_allows((SELECT jsonb_build_object('payeeId',payee_id,'from',from_on,'through',through_on,'currencyIds',currency_ids) FROM h),scopes) OR public.scope_contains(scopes->'counterparty-settlements.view',(SELECT source_snapshot->'scope' FROM r)) IS NOT TRUE OR EXISTS(SELECT 1 FROM links WHERE allowed IS NOT TRUE) THEN jsonb_build_object('unavailable','NOT_FOUND')
 WHEN(SELECT count(*) FROM links)>10000 THEN jsonb_build_object('unavailable','SETTLEMENT_REQUIRES_BACKGROUND_JOB')
 ELSE jsonb_build_object('statementId',p_id,'statementVersion',(SELECT version FROM r),'statementState',(SELECT state FROM r),'on',p_on,'currencies',coalesce((SELECT jsonb_agg(to_jsonb(result_rows) ORDER BY currency_id) FROM result_rows),'[]'::jsonb),'allocationCount',(SELECT count(*) FROM links),'invalidatedCount',(SELECT count(*) FROM links WHERE reversed_on<=p_on),'releasedCount',(SELECT count(*) FROM links WHERE released_on<=p_on),'basis','reviewed_allocations_against_net_statement_balance','underlyingGrossClearanceVerified',false,'nettingPerformed',false,'bankSettlementVerified',false,'paymentExecuted',false,'additionalLedgerPosting',false) END INTO result;
 RETURN result;
END $$;
CREATE FUNCTION public.guard_statement_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE releasing boolean:=TG_TABLE_NAME='counterparty_settlement_releases';s jsonb;p record;h record;frame jsonb;handler uuid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SETTLEMENT_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF NOT public.statement_settlement_input_valid(NEW.input,releasing) THEN RAISE EXCEPTION 'SETTLEMENT_INPUT_INVALID' USING ERRCODE='23514';END IF;
 IF releasing THEN SELECT jsonb_build_object('statementId',statement_id,'family',source_family,'journalId',source_journal,'lineNumber',source_line) INTO frame FROM public.counterparty_statement_settlements WHERE academy_id=NEW.academy_id AND id=NEW.settlement_id;
 ELSE frame=jsonb_build_object('statementId',NEW.statement_id,'family',NEW.source_family,'journalId',NEW.source_journal,'lineNumber',NEW.source_line);END IF;
 PERFORM public.lock_statement_settlement_source(frame->>'family',(frame->>'journalId')::uuid,(frame->>'lineNumber')::integer);
 PERFORM 1 FROM public.counterparty_statement_records WHERE academy_id=NEW.academy_id AND id=(frame->>'statementId')::uuid FOR UPDATE;
 s=public.statement_settlement_source(NEW.id,NEW.input,releasing);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 SELECT handler_id INTO handler FROM public.counterparty_settlement_payments WHERE academy_id=NEW.academy_id AND payee_id=(SELECT payee_id FROM public.counterparty_statement_records WHERE academy_id=NEW.academy_id AND id=(frame->>'statementId')::uuid) AND family=frame->>'family' AND journal_id=(frame->>'journalId')::uuid AND line_number=(frame->>'lineNumber')::integer;
 IF s ? 'unavailable' OR p.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR p.action IS DISTINCT FROM(CASE WHEN releasing THEN 'finance.statement-settlement.release' ELSE 'finance.statement-settlement.allocate' END) OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.payload IS DISTINCT FROM NEW.input OR p.review_context IS DISTINCT FROM s OR NEW.source_snapshot IS DISTINCT FROM s OR p.scope IS DISTINCT FROM s->'scope' OR p.privacy_capability IS DISTINCT FROM 'counterparty-settlements.view' OR NOT public.report_comment_human_verified(NEW.created_by)
  OR(NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.created_by) AND((s->>'payeePersonId')::uuid=NEW.created_by OR handler=NEW.created_by)) THEN RAISE EXCEPTION 'SETTLEMENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF releasing THEN IF NEW.input->>'settlementId' IS DISTINCT FROM NEW.settlement_id::text OR NEW.input->>'releasedOn' IS DISTINCT FROM NEW.released_on::text THEN RAISE EXCEPTION 'SETTLEMENT_EXACT_FIELDS_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE IF s->'frame' IS DISTINCT FROM frame OR NEW.statement_version IS DISTINCT FROM(s->>'statementVersion')::integer OR NEW.currency_id::text IS DISTINCT FROM s#>>'{payment,currency_id}' OR NEW.unit_scale IS DISTINCT FROM(s->>'scale')::integer OR NEW.direction IS DISTINCT FROM(s->>'direction')::integer OR NEW.amount_minor IS DISTINCT FROM(s->>'amountMinor')::numeric OR NEW.allocated_on::text IS DISTINCT FROM s->>'on' OR NEW.input->>'basis' IS DISTINCT FROM 'net_statement_balance' THEN RAISE EXCEPTION 'SETTLEMENT_EXACT_FIELDS_REQUIRED' USING ERRCODE='23514';END IF;END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['counterparty_statement_settlements','counterparty_settlement_releases'] LOOP
 EXECUTE format('CREATE TRIGGER settlement_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_statement_settlement()',t);
 EXECUTE format('CREATE CONSTRAINT TRIGGER settlement_reviewed AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete()',t);
END LOOP;END $$;
CREATE FUNCTION public.complete_statement_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE releasing boolean:=TG_TABLE_NAME='counterparty_settlement_releases';expected jsonb;BEGIN
 expected=public.statement_settlement_source(NEW.id,NEW.input,releasing);
 IF expected IS DISTINCT FROM NEW.source_snapshot OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.target_id=NEW.id AND p.payload=NEW.input AND p.review_context=NEW.source_snapshot AND p.reviewer_id=NEW.created_by) OR NOT EXISTS(SELECT 1 FROM public.audit_events e WHERE e.academy_id=NEW.academy_id AND e.entity_id=NEW.id AND e.actor_id=NEW.created_by AND e.created_at=transaction_timestamp() AND e.action=CASE WHEN releasing THEN 'finance.statement-settlement.release' ELSE 'finance.statement-settlement.allocate' END AND e.changes=jsonb_build_object('approvalId',NEW.approval_id,'severity','critical','additionalLedgerPosting',false,'paymentExecuted',false,'hasReason',true)) THEN RAISE EXCEPTION 'SETTLEMENT_APPLIED_SOURCE_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['counterparty_statement_settlements','counterparty_settlement_releases'] LOOP EXECUTE format('CREATE CONSTRAINT TRIGGER settlement_complete AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.complete_statement_settlement()',t);END LOOP;END $$;
CREATE FUNCTION public.statement_settlement_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND((NEW.action='finance.statement-settlement.allocate' AND NOT EXISTS(SELECT 1 FROM public.counterparty_statement_settlements WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id)) OR(NEW.action='finance.statement-settlement.release' AND NOT EXISTS(SELECT 1 FROM public.counterparty_settlement_releases WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id))) THEN RAISE EXCEPTION 'SETTLEMENT_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER statement_settlement_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.statement_settlement_effect_required();
DO $$ DECLARE body text;needle text:='ELSIF b ? ''personId'' THEN';BEGIN body=pg_get_functiondef('public.approval_bindings_allow(jsonb,jsonb)'::regprocedure);IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'SETTLEMENT_PRIVACY_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'ELSIF b ? ''counterpartySettlement'' THEN IF public.statement_settlement_allows(b->''counterpartySettlement'',p_scopes) IS NOT TRUE THEN RETURN false;END IF; '||needle);
END $$;
CREATE FUNCTION public.statement_settlement_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.review_context->'frame' IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('counterpartySettlement',NEW.review_context->'frame'));END IF;RETURN NEW;
END $$;
CREATE TRIGGER zz_statement_settlement_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('finance.statement-settlement.allocate','finance.statement-settlement.release')) EXECUTE FUNCTION public.statement_settlement_privacy();
REVOKE ALL ON FUNCTION public.lock_statement_settlement_source(text,uuid,integer),public.statement_settlement_capacity(text,uuid,uuid,text,uuid,integer,date,numeric,integer,integer,uuid),public.statement_settlement_allows(jsonb,jsonb),public.statement_settlement_source(uuid,jsonb,boolean,jsonb),public.guard_statement_settlement(),public.complete_statement_settlement(),public.statement_settlement_effect_required(),public.statement_settlement_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_statement_settlement_source(text,uuid,integer),public.statement_settlement_capacity(text,uuid,uuid,text,uuid,integer,date,numeric,integer,integer,uuid),public.statement_settlement_allows(jsonb,jsonb),public.statement_settlement_source(uuid,jsonb,boolean,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 276 $$;
REVOKE ALL ON FUNCTION public.statement_settlement_input_valid(jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.statement_settlement_input_valid(jsonb,boolean) TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.statement_settlement_status(uuid,integer,date,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.statement_settlement_status(uuid,integer,date,jsonb) TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.statement_payment_membership(jsonb,jsonb,text,uuid,integer,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.statement_payment_membership(jsonb,jsonb,text,uuid,integer,date) TO kavosh_runtime;

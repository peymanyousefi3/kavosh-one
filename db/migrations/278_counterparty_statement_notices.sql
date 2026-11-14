-- New reviewed releases only;do not reconstruct notices for old archives.
ALTER TABLE public.counterparty_statement_releases ADD notice_origin_transaction xid8;
ALTER TABLE public.counterparty_statement_releases ALTER notice_origin_transaction SET DEFAULT pg_current_xact_id();
ALTER TABLE public.counterparty_statement_release_withdrawals ADD notice_origin_transaction xid8;
ALTER TABLE public.counterparty_statement_release_withdrawals ALTER notice_origin_transaction SET DEFAULT pg_current_xact_id();
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule','report_job','pay_statement','account_security','calendar_event','work_signature','tuition_due','expense_due','payroll_due','counterparty_statement'));
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_operational_audit;
ALTER TABLE public.automation_event_sources ADD CONSTRAINT automation_event_operational_audit CHECK((source_kind IN('report_schedule','report_job','pay_statement','account_security','work_signature','counterparty_statement'))=(audit_id IS NULL));
ALTER TABLE public.automation_event_sources ADD counterparty_release_id uuid,ADD counterparty_withdrawal_id uuid,
 ADD FOREIGN KEY(academy_id,counterparty_release_id) REFERENCES public.counterparty_statement_releases(academy_id,id),ADD FOREIGN KEY(academy_id,counterparty_withdrawal_id) REFERENCES public.counterparty_statement_release_withdrawals(academy_id,id),
 ADD CHECK((source_kind='counterparty_statement')=(counterparty_release_id IS NOT NULL)),ADD CHECK(counterparty_withdrawal_id IS NULL OR source_kind='counterparty_statement'),ADD UNIQUE(academy_id,counterparty_withdrawal_id);
CREATE UNIQUE INDEX counterparty_release_notice_once ON public.automation_event_sources(academy_id,counterparty_release_id) WHERE source_kind='counterparty_statement' AND counterparty_withdrawal_id IS NULL;
GRANT SELECT(academy_id,id,statement_id,statement_version,recipient_id,source_snapshot,approval_id,created_by,created_at,notice_origin_transaction) ON public.counterparty_statement_releases TO kavosh_event_policy;
GRANT SELECT(academy_id,id,release_id,approval_id,created_by,created_at,notice_origin_transaction) ON public.counterparty_statement_release_withdrawals TO kavosh_event_policy;
CREATE FUNCTION public.counterparty_notice_projection(release_id uuid,withdrawal_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE r record;w record;scope jsonb;hub uuid;at_time timestamptz;BEGIN
 SELECT id,academy_id,created_at,source_snapshot,statement_version,approval_id,created_by INTO r FROM public.counterparty_statement_releases WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=release_id;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT id,created_at,approval_id,created_by INTO w FROM public.counterparty_statement_release_withdrawals WHERE academy_id=r.academy_id AND id=withdrawal_id AND public.counterparty_statement_release_withdrawals.release_id=r.id;
 IF withdrawal_id IS NOT NULL THEN IF w.id IS NULL THEN RETURN NULL;END IF;at_time=w.created_at;
 ELSE at_time=r.created_at;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=r.academy_id AND a.id=CASE WHEN withdrawal_id IS NULL THEN r.approval_id ELSE w.approval_id END AND a.status='applied' AND a.action=CASE WHEN withdrawal_id IS NULL THEN 'finance.statement-release.publish' ELSE 'finance.statement-release.withdraw' END AND a.target_id=CASE WHEN withdrawal_id IS NULL THEN r.id ELSE w.id END AND a.reviewer_id=CASE WHEN withdrawal_id IS NULL THEN r.created_by ELSE w.created_by END) THEN RETURN NULL;END IF;
 scope=r.source_snapshot->'scope';IF scope->'all'='false'::jsonb AND jsonb_array_length(scope->'hubs')=1 THEN hub=(scope#>>'{hubs,0}')::uuid;END IF;
 RETURN jsonb_build_object('eventType',CASE WHEN withdrawal_id IS NULL THEN 'counterparty-statement.released' ELSE 'counterparty-statement.withdrawn' END,'entityId',r.id,'hubId',hub,'actorId',NULL,'actorKind','system','severity','critical','occurredAt',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',jsonb_build_object('releaseId',r.id,'statementVersion',r.statement_version,'state',CASE WHEN withdrawal_id IS NULL THEN 'released' ELSE 'withdrawn' END));
END $$;
CREATE FUNCTION public.counterparty_notice_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE expected jsonb;at_time timestamptz;tx xid8;BEGIN
 expected=public.counterparty_notice_projection(NEW.counterparty_release_id,NEW.counterparty_withdrawal_id);
 IF NEW.counterparty_withdrawal_id IS NULL THEN SELECT created_at,notice_origin_transaction INTO at_time,tx FROM public.counterparty_statement_releases WHERE academy_id=NEW.academy_id AND id=NEW.counterparty_release_id;
 ELSE SELECT created_at,notice_origin_transaction INTO at_time,tx FROM public.counterparty_statement_release_withdrawals WHERE academy_id=NEW.academy_id AND id=NEW.counterparty_withdrawal_id AND release_id=NEW.counterparty_release_id;END IF;
 IF current_user<>'kavosh_event_policy' OR expected IS NULL OR tx IS DISTINCT FROM pg_current_xact_id() OR NEW.origin_transaction IS DISTINCT FROM tx OR NEW.source_version<>1 OR NEW.approval_id IS NOT NULL OR NEW.audit_id IS NOT NULL OR NEW.event_type IS DISTINCT FROM expected->>'eventType' OR NEW.hub_id::text IS DISTINCT FROM expected->>'hubId' OR NEW.projection IS DISTINCT FROM expected OR NEW.occurred_at IS DISTINCT FROM at_time OR NOT EXISTS(SELECT 1 FROM public.outbox_events o WHERE o.academy_id=NEW.academy_id AND o.id=NEW.event_id AND o.entity_id=NEW.counterparty_release_id AND o.event_type=NEW.event_type AND o.created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'COUNTERPARTY_NOTICE_NATIVE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER counterparty_notice_source_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='counterparty_statement') EXECUTE FUNCTION public.counterparty_notice_source_guard();
CREATE FUNCTION public.capture_counterparty_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a record;r record;w record;release_id uuid;withdrawal_id uuid;at_time timestamptz;projection jsonb;event_id uuid:=gen_random_uuid();BEGIN
 SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id AND status='applied' AND action IN('finance.statement-release.publish','finance.statement-release.withdraw');IF NOT FOUND THEN RETURN NULL;END IF;
 IF a.action='finance.statement-release.publish' THEN SELECT id,created_at INTO r FROM public.counterparty_statement_releases WHERE academy_id=a.academy_id AND id=a.target_id AND approval_id=a.id AND created_by=a.reviewer_id AND notice_origin_transaction=pg_current_xact_id();IF NOT FOUND THEN RETURN NULL;END IF;release_id=r.id;at_time=r.created_at;
 ELSE SELECT w0.id,w0.release_id,w0.created_at INTO w FROM public.counterparty_statement_release_withdrawals w0 WHERE w0.academy_id=a.academy_id AND w0.id=a.target_id AND w0.approval_id=a.id AND w0.created_by=a.reviewer_id AND w0.notice_origin_transaction=pg_current_xact_id();IF NOT FOUND THEN RETURN NULL;END IF;release_id=w.release_id;withdrawal_id=w.id;at_time=w.created_at;END IF;
 IF EXISTS(SELECT 1 FROM public.automation_event_sources e WHERE e.academy_id=a.academy_id AND e.source_kind='counterparty_statement' AND e.counterparty_release_id=release_id AND e.counterparty_withdrawal_id IS NOT DISTINCT FROM withdrawal_id) THEN RETURN NULL;END IF;
 projection=public.counterparty_notice_projection(release_id,withdrawal_id);IF projection IS NULL THEN RAISE EXCEPTION 'COUNTERPARTY_NOTICE_PROJECTION_REQUIRED' USING ERRCODE='23514';END IF;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(a.academy_id,event_id,projection->>'eventType',release_id,gen_random_uuid());
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,counterparty_release_id,counterparty_withdrawal_id) VALUES(a.academy_id,event_id,NULL,NULL,'counterparty_statement',1,projection->>'eventType',(projection->>'hubId')::uuid,at_time,projection,release_id,withdrawal_id);RETURN NULL;
END $$;
ALTER FUNCTION public.capture_counterparty_notice() OWNER TO kavosh_event_policy;
CREATE TRIGGER capture_counterparty_notice AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='approval' AND NEW.event_type='approval.applied') EXECUTE FUNCTION public.capture_counterparty_notice();
CREATE FUNCTION public.counterparty_notice_recipient(event_id uuid) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT r.recipient_id FROM public.automation_event_sources e JOIN public.counterparty_statement_releases r ON r.academy_id=e.academy_id AND r.id=e.counterparty_release_id WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=$1 AND e.source_kind='counterparty_statement'
$$;
CREATE FUNCTION public.counterparty_notice_current(event_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.automation_event_sources e JOIN public.counterparty_statement_releases r ON r.academy_id=e.academy_id AND r.id=e.counterparty_release_id JOIN public.counterparty_statement_records h ON h.academy_id=r.academy_id AND h.id=r.statement_id JOIN public.counterparty_statement_revisions v ON v.academy_id=h.academy_id AND v.statement_id=h.id AND v.version=h.version WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=$1 AND e.source_kind='counterparty_statement' AND(e.counterparty_withdrawal_id IS NOT NULL OR(h.version=r.statement_version AND v.state='issued' AND NOT EXISTS(SELECT 1 FROM public.counterparty_statement_release_withdrawals w WHERE w.academy_id=r.academy_id AND w.release_id=r.id))))
$$;
CREATE FUNCTION public.counterparty_notice_allows(event_id uuid,actor uuid,scopes jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r record;h record;p record;actor_kind text;BEGIN
 SELECT kind INTO actor_kind FROM public.people WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=actor AND status='active';
 IF actor_kind IS NULL OR(actor_kind='human' AND NOT public.report_comment_human_verified(actor)) THEN RETURN false;END IF;
 SELECT a.* INTO r FROM public.automation_event_sources e JOIN public.counterparty_statement_releases a ON a.academy_id=e.academy_id AND a.id=e.counterparty_release_id WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.event_id=$1 AND e.source_kind='counterparty_statement';IF NOT FOUND THEN RETURN false;END IF;
 SELECT id,hub_id INTO p FROM public.people WHERE academy_id=r.academy_id AND id=r.recipient_id;
 IF actor_kind='human' AND actor=r.recipient_id AND public.approval_scope_nonempty(scopes->'received-statements.view') AND public.scope_contains(scopes->'received-statements.view',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p.id,'hubId',p.hub_id)))) THEN RETURN true;END IF;
 SELECT * INTO h FROM public.counterparty_statement_records WHERE academy_id=r.academy_id AND id=r.statement_id;
 RETURN public.approval_scope_nonempty(scopes->'people.view') AND public.scope_contains(scopes->'people.view',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p.id,'hubId',p.hub_id)))) AND public.counterparty_statement_source_allows(jsonb_build_object('payeeId',h.payee_id,'from',h.from_on,'through',h.through_on,'currencyIds',h.currency_ids),scopes);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_runtime;
ALTER FUNCTION public.counterparty_notice_current(uuid) OWNER TO kavosh_runtime;
ALTER FUNCTION public.counterparty_notice_allows(uuid,uuid,jsonb) OWNER TO kavosh_runtime;
REVOKE CREATE ON SCHEMA public FROM kavosh_runtime;
CREATE FUNCTION public.publish_counterparty_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin)
 SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,p.id,0,'critical',CASE WHEN NEW.counterparty_withdrawal_id IS NULL THEN 'Academy statement released' ELSE 'Academy statement release withdrawn' END,
 CASE WHEN NEW.counterparty_withdrawal_id IS NULL THEN 'Open your academy statement archive to review the released copy. This notice does not confirm payment.' ELSE 'Open your academy statement archive to review its current status. Previously released copies remain available.' END,'en','mandatory'
 FROM public.counterparty_statement_releases r JOIN public.people p ON p.academy_id=r.academy_id AND p.id=r.recipient_id WHERE r.academy_id=NEW.academy_id AND r.id=NEW.counterparty_release_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL;RETURN NULL;
END $$;
ALTER FUNCTION public.publish_counterparty_alert() OWNER TO kavosh_event_policy;
CREATE TRIGGER publish_counterparty_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='counterparty_statement') EXECUTE FUNCTION public.publish_counterparty_alert();
DO $$ DECLARE body text;needle text:='IF source.event_id IS NULL';BEGIN
 body=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'COUNTERPARTY_MANDATORY_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF source.source_kind='counterparty_statement' THEN
  IF NEW.locale<>'en' OR source.projection->>'severity' IS DISTINCT FROM 'critical' OR source.event_type NOT IN('counterparty-statement.released','counterparty-statement.withdrawn') OR NEW.title IS DISTINCT FROM(CASE WHEN source.counterparty_withdrawal_id IS NULL THEN 'Academy statement released' ELSE 'Academy statement release withdrawn' END) OR NEW.body IS DISTINCT FROM(CASE WHEN source.counterparty_withdrawal_id IS NULL THEN 'Open your academy statement archive to review the released copy. This notice does not confirm payment.' ELSE 'Open your academy statement archive to review its current status. Previously released copies remain available.' END) OR NOT EXISTS(SELECT 1 FROM public.counterparty_statement_releases r JOIN public.people p ON p.academy_id=r.academy_id AND p.id=r.recipient_id WHERE r.academy_id=NEW.academy_id AND r.id=source.counterparty_release_id AND p.id=NEW.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL) THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);
 body=pg_get_functiondef('public.automation_rule_guard()'::regprocedure);needle='''statement_worker''';IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'COUNTERPARTY_AUDIENCE_BASE_CHANGED';END IF;EXECUTE replace(body,needle,needle||',''statement_recipient''');
END $$;
CREATE FUNCTION public.counterparty_notice_delivery_current() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_NAME='automation_runs' THEN IF NEW.outcome<>'processed' OR coalesce((NEW.summary->>'portalNotifications')::integer,0)+coalesce((NEW.summary->>'outboundQueued')::integer,0)=0 THEN RETURN NULL;END IF;
 ELSE IF NEW.status<>'sending' THEN RETURN NULL;END IF;END IF;
 IF EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND source_kind='counterparty_statement') AND NOT public.counterparty_notice_current(NEW.event_id) THEN RAISE EXCEPTION 'COUNTERPARTY_NOTICE_DELIVERY_CHANGED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER counterparty_notice_delivery_current AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.counterparty_notice_delivery_current();
CREATE CONSTRAINT TRIGGER counterparty_notice_handoff_current AFTER UPDATE ON public.notification_deliveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.status='sending') EXECUTE FUNCTION public.counterparty_notice_delivery_current();
-- Passive senders receive only currentness/permission booleans,not raw finance.
GRANT SELECT(academy_id,id,statement_id) ON public.counterparty_statement_releases TO kavosh_message_policy;
GRANT SELECT(academy_id,id),UPDATE(id) ON public.counterparty_statement_records TO kavosh_message_policy;
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.lock_notification_delivery_source(uuid,uuid)'::regprocedure);needle='IF e.source_kind IN(''tuition_due'',''expense_due'',''payroll_due'') THEN PERFORM public.lock_finance_book();END IF;';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'COUNTERPARTY_DELIVERY_BOOK_BASE_CHANGED';END IF;body=replace(body,needle,'IF e.source_kind IN(''tuition_due'',''expense_due'',''payroll_due'',''counterparty_statement'') THEN PERFORM public.lock_finance_book();END IF;');
 needle='IF e.source_kind=''payroll_due'' THEN';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'COUNTERPARTY_DELIVERY_ROW_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,$branch$IF e.source_kind='counterparty_statement' THEN
  PERFORM h.id FROM public.counterparty_statement_records h JOIN public.counterparty_statement_releases r ON r.academy_id=h.academy_id AND r.statement_id=h.id WHERE h.academy_id=tenant AND r.id=e.counterparty_release_id FOR SHARE OF h;
 ELSIF e.source_kind='payroll_due' THEN$branch$);
END $$;
REVOKE ALL ON FUNCTION public.counterparty_notice_projection(uuid,uuid),public.counterparty_notice_source_guard(),public.capture_counterparty_notice(),public.counterparty_notice_recipient(uuid),public.counterparty_notice_current(uuid),public.counterparty_notice_allows(uuid,uuid,jsonb),public.publish_counterparty_alert(),public.counterparty_notice_delivery_current() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.counterparty_notice_projection(uuid,uuid) TO kavosh_event_policy;
GRANT EXECUTE ON FUNCTION public.counterparty_notice_recipient(uuid),public.counterparty_notice_current(uuid),public.counterparty_notice_allows(uuid,uuid,jsonb) TO kavosh_runtime;
GRANT EXECUTE ON FUNCTION public.counterparty_notice_current(uuid),public.counterparty_notice_allows(uuid,uuid,jsonb) TO kavosh_message_worker,kavosh_message_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 278 $$;

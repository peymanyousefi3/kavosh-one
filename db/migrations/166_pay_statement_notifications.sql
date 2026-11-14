-- Observe only new,applied releases. Older rows remain NULL: no reconstructed
-- notification history and no migration-time messages to existing workers.
ALTER TABLE public.pay_statement_release_revisions ADD notice_origin_transaction xid8;
ALTER TABLE public.pay_statement_release_revisions ALTER notice_origin_transaction SET DEFAULT pg_current_xact_id();
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_sources_source_kind_check;
ALTER TABLE public.automation_event_sources ADD CHECK(source_kind IN('approval','audit','session','report_schedule','report_job','pay_statement'));
ALTER TABLE public.automation_event_sources DROP CONSTRAINT automation_event_operational_audit;
ALTER TABLE public.automation_event_sources ADD CONSTRAINT automation_event_operational_audit CHECK((source_kind IN('report_schedule','report_job','pay_statement'))=(audit_id IS NULL));
ALTER TABLE public.automation_event_sources ADD pay_statement_posting_id uuid,ADD pay_statement_release_version integer,
 ADD FOREIGN KEY(academy_id,pay_statement_posting_id,pay_statement_release_version) REFERENCES public.pay_statement_release_revisions(academy_id,posting_id,version),
 ADD UNIQUE(academy_id,pay_statement_posting_id,pay_statement_release_version),
 ADD CHECK((source_kind='pay_statement' AND pay_statement_posting_id IS NOT NULL AND pay_statement_release_version IS NOT NULL) OR(source_kind<>'pay_statement' AND pay_statement_posting_id IS NULL AND pay_statement_release_version IS NULL));
GRANT SELECT(academy_id,posting_id,version,state,statement_version,approval_id,changed_by,created_at,notice_origin_transaction) ON public.pay_statement_release_revisions TO kavosh_event_policy;
GRANT SELECT(academy_id,id,run_id) ON public.payrun_net_postings TO kavosh_event_policy;
GRANT SELECT(academy_id,id,person_id,scope) ON public.payrun_groups TO kavosh_event_policy;
GRANT SELECT(academy_id,id,event_type,entity_id,created_at) ON public.outbox_events TO kavosh_event_policy;

CREATE FUNCTION public.pay_statement_notice_projection(p_posting uuid,p_release integer) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE r record;hubs uuid[];hub uuid;BEGIN
 SELECT s.posting_id,s.version,s.state,s.statement_version,s.created_at,g.scope INTO r FROM public.pay_statement_release_revisions s JOIN public.approval_requests a ON a.academy_id=s.academy_id AND a.id=s.approval_id AND a.status='applied' AND a.action='work.payrun-statement-release.change' AND a.target_id=s.posting_id AND a.target_version=s.version-1 AND a.reviewer_id=s.changed_by JOIN public.payrun_net_postings p ON p.academy_id=s.academy_id AND p.id=s.posting_id JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.posting_id=p_posting AND s.version=p_release;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT array_agg(DISTINCT(x->>'hubId')::uuid) INTO hubs FROM jsonb_array_elements(r.scope->'workContexts') x;IF cardinality(hubs)=1 AND hubs[1] IS NOT NULL THEN hub=hubs[1];END IF;
 RETURN jsonb_build_object('eventType','pay-statement.'||r.state,'entityId',r.posting_id,'hubId',hub,'actorId',NULL,'actorKind','system','severity','critical','occurredAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'attributes',jsonb_build_object('postingId',r.posting_id,'releaseVersion',r.version,'statementVersion',r.statement_version,'state',r.state));
END $$;
CREATE FUNCTION public.pay_statement_notice_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE projection jsonb:=public.pay_statement_notice_projection(NEW.pay_statement_posting_id,NEW.pay_statement_release_version);at timestamptz;tx xid8;BEGIN
 SELECT created_at,notice_origin_transaction INTO at,tx FROM public.pay_statement_release_revisions WHERE academy_id=NEW.academy_id AND posting_id=NEW.pay_statement_posting_id AND version=NEW.pay_statement_release_version;
 IF current_user<>'kavosh_event_policy' OR projection IS NULL OR tx IS DISTINCT FROM pg_current_xact_id() OR NEW.origin_transaction IS DISTINCT FROM tx OR NEW.source_version IS DISTINCT FROM NEW.pay_statement_release_version OR NEW.event_type IS DISTINCT FROM projection->>'eventType' OR NEW.hub_id::text IS DISTINCT FROM projection->>'hubId' OR NEW.projection IS DISTINCT FROM projection OR NEW.occurred_at IS DISTINCT FROM at OR NOT EXISTS(SELECT 1 FROM public.outbox_events o WHERE o.academy_id=NEW.academy_id AND o.id=NEW.event_id AND o.event_type=NEW.event_type AND o.entity_id=NEW.pay_statement_posting_id AND o.created_at=transaction_timestamp()) THEN RAISE EXCEPTION 'PAY_STATEMENT_NOTICE_NATIVE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER pay_statement_notice_source_guard BEFORE INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='pay_statement') EXECUTE FUNCTION public.pay_statement_notice_source_guard();
CREATE FUNCTION public.capture_pay_statement_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r record;projection jsonb;i uuid:=gen_random_uuid();BEGIN
 SELECT s.posting_id,s.version,s.created_at INTO r FROM public.approval_requests a JOIN public.pay_statement_release_revisions s ON s.academy_id=a.academy_id AND s.approval_id=a.id AND s.posting_id=a.target_id AND s.version=a.target_version+1 AND s.changed_by=a.reviewer_id WHERE a.academy_id=NEW.academy_id AND a.id=NEW.approval_id AND a.action='work.payrun-statement-release.change' AND a.status='applied' AND s.notice_origin_transaction=pg_current_xact_id();IF NOT FOUND OR EXISTS(SELECT 1 FROM public.automation_event_sources e WHERE e.academy_id=NEW.academy_id AND e.pay_statement_posting_id=r.posting_id AND e.pay_statement_release_version=r.version) THEN RETURN NULL;END IF;
 projection=public.pay_statement_notice_projection(r.posting_id,r.version);IF projection IS NULL THEN RAISE EXCEPTION 'PAY_STATEMENT_NOTICE_PROJECTION_REQUIRED' USING ERRCODE='23514';END IF;
 INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES(NEW.academy_id,i,projection->>'eventType',r.posting_id,gen_random_uuid());
 INSERT INTO public.automation_event_sources(academy_id,event_id,audit_id,approval_id,source_kind,source_version,event_type,hub_id,occurred_at,projection,pay_statement_posting_id,pay_statement_release_version) VALUES(NEW.academy_id,i,NULL,NULL,'pay_statement',r.version,projection->>'eventType',(projection->>'hubId')::uuid,r.created_at,projection,r.posting_id,r.version);RETURN NULL;
END $$;
ALTER FUNCTION public.capture_pay_statement_notice() OWNER TO kavosh_event_policy;
CREATE TRIGGER capture_pay_statement_notice AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='approval' AND NEW.event_type='approval.applied') EXECUTE FUNCTION public.capture_pay_statement_notice();
CREATE FUNCTION public.pay_statement_notice_worker(p_event uuid) RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT g.person_id FROM public.automation_event_sources e JOIN public.payrun_net_postings p ON p.academy_id=e.academy_id AND p.id=e.pay_statement_posting_id JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id WHERE e.event_id=p_event AND e.source_kind='pay_statement'
$$;
CREATE FUNCTION public.pay_statement_notice_current(p_event uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.automation_event_sources e JOIN public.pay_statement_releases h ON h.academy_id=e.academy_id AND h.posting_id=e.pay_statement_posting_id AND h.version=e.pay_statement_release_version JOIN public.pay_statement_release_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version JOIN public.payrun_net_postings p ON p.academy_id=h.academy_id AND p.id=h.posting_id JOIN public.payrun_statement_records sh ON sh.academy_id=h.academy_id AND sh.posting_id=h.posting_id JOIN public.payrun_statement_revisions sr ON sr.academy_id=sh.academy_id AND sr.posting_id=sh.posting_id AND sr.version=sh.version WHERE e.event_id=p_event AND e.source_kind='pay_statement' AND(r.state='withdrawn' OR(r.state='released' AND r.statement_version=sh.version AND sr.state='recorded' AND p.reversal_id IS NULL)))
$$;
CREATE FUNCTION public.pay_statement_notice_allows(p_event uuid,p_actor uuid,p_scopes jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE r record;cap text;account record;target jsonb;BEGIN
 IF NOT public.report_comment_human_verified(p_actor) THEN RETURN false;END IF;
 SELECT g.person_id,g.scope,g.source_snapshot,p.plan,p.run_id INTO r FROM public.automation_event_sources e JOIN public.payrun_net_postings p ON p.academy_id=e.academy_id AND p.id=e.pay_statement_posting_id JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id WHERE e.event_id=p_event AND e.source_kind='pay_statement';IF NOT FOUND THEN RETURN false;END IF;
 IF r.person_id=p_actor AND public.scope_contains(p_scopes->'received-paystatements.view',r.scope) THEN RETURN true;END IF;
 FOREACH cap IN ARRAY ARRAY['paystatements.view','payruns.view','payrun-net.view','payrun-postings.view'] LOOP IF public.scope_contains(p_scopes->cap,r.scope) IS NOT TRUE THEN RETURN false;END IF;END LOOP;
 IF public.payrun_net_source_allows(r.run_id,'work-pay.view',p_scopes->'work-pay.view') IS NOT TRUE THEN RETURN false;END IF;
 FOREACH cap IN ARRAY ARRAY['payroll-accruals.view','payroll-adjustments.view'] LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r.source_snapshot->'items') v WHERE(cap='payroll-adjustments.view')=(v->>'kind'='manual_bonus')) AND public.payrun_net_source_allows(r.run_id,cap,p_scopes->cap) IS NOT TRUE THEN RETURN false;END IF;
 END LOOP;
 FOR account IN SELECT a.id,a.hub_id FROM jsonb_array_elements(r.plan->'accounts') v LEFT JOIN public.finance_accounts a ON a.id=(v->>'id')::uuid LOOP
  IF account.id IS NULL THEN RETURN false;END IF;target=CASE WHEN account.hub_id IS NULL THEN '{"all":true,"hubs":[]}'::jsonb ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(account.hub_id)) END;
  FOREACH cap IN ARRAY ARRAY['accounts.view','journals.view'] LOOP IF public.scope_contains(p_scopes->cap,target) IS NOT TRUE THEN RETURN false;END IF;END LOOP;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION public.publish_pay_statement_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin)
 SELECT NEW.academy_id,gen_random_uuid(),NEW.event_id,person.id,0,'critical',CASE WHEN NEW.event_type='pay-statement.released' THEN 'Statement released' ELSE 'Statement release withdrawn' END,
 CASE WHEN NEW.event_type='pay-statement.released' THEN 'Open your statement archive to review the released copy. This notice does not confirm payment.' ELSE 'Open your statement archive to review its current status. Previously released copies remain available.' END,'en','mandatory'
 FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id JOIN public.people person ON person.academy_id=g.academy_id AND person.id=g.person_id AND person.kind='human' AND person.status='active' AND person.auth_user_id IS NOT NULL WHERE p.academy_id=NEW.academy_id AND p.id=NEW.pay_statement_posting_id;RETURN NULL;
END $$;
ALTER FUNCTION public.publish_pay_statement_alert() OWNER TO kavosh_event_policy;
CREATE TRIGGER publish_pay_statement_alert AFTER INSERT ON public.automation_event_sources FOR EACH ROW WHEN(NEW.source_kind='pay_statement') EXECUTE FUNCTION public.publish_pay_statement_alert();
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.mandatory_alert_guard()'::regprocedure);needle='IF source.event_id IS NULL';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAY_STATEMENT_MANDATORY_BASE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,$branch$IF source.source_kind='pay_statement' THEN
  IF NEW.locale<>'en' OR source.projection->>'severity' IS DISTINCT FROM 'critical' OR source.event_type NOT IN('pay-statement.released','pay-statement.withdrawn') OR NEW.title IS DISTINCT FROM (CASE WHEN source.event_type='pay-statement.released' THEN 'Statement released' ELSE 'Statement release withdrawn' END) OR NEW.body IS DISTINCT FROM (CASE WHEN source.event_type='pay-statement.released' THEN 'Open your statement archive to review the released copy. This notice does not confirm payment.' ELSE 'Open your statement archive to review its current status. Previously released copies remain available.' END) OR NOT EXISTS(SELECT 1 FROM public.payrun_net_postings post JOIN public.payrun_groups g ON g.academy_id=post.academy_id AND g.id=post.run_id JOIN public.people recipient ON recipient.academy_id=g.academy_id AND recipient.id=g.person_id WHERE post.id=source.pay_statement_posting_id AND recipient.id=NEW.person_id AND recipient.kind='human' AND recipient.status='active' AND recipient.auth_user_id IS NOT NULL) THEN RAISE EXCEPTION 'MANDATORY_ALERT_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 IF source.event_id IS NULL$branch$);
 body=pg_get_functiondef('public.automation_rule_guard()'::regprocedure);needle='''school_master'',''actor_supervisors'',''people'',''session_guardians'',''session_staff''';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAY_STATEMENT_AUDIENCE_BASE_UNEXPECTED';END IF;EXECUTE replace(body,needle,needle||',''statement_worker''');
END $$;
REVOKE ALL ON FUNCTION public.pay_statement_notice_projection(uuid,integer),public.pay_statement_notice_source_guard(),public.capture_pay_statement_notice(),public.pay_statement_notice_worker(uuid),public.pay_statement_notice_current(uuid),public.pay_statement_notice_allows(uuid,uuid,jsonb),public.publish_pay_statement_alert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_statement_notice_projection(uuid,integer) TO kavosh_event_policy;
GRANT EXECUTE ON FUNCTION public.pay_statement_notice_worker(uuid),public.pay_statement_notice_current(uuid),public.pay_statement_notice_allows(uuid,uuid,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 166 $$;

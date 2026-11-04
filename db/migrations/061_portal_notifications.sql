INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('automations.execute','Process approved automatic notification rules','Administration',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.automation_runs(
 academy_id uuid NOT NULL,id uuid NOT NULL,rule_id uuid NOT NULL,rule_version integer NOT NULL,event_id uuid NOT NULL,
 actor_id uuid NOT NULL,outcome text NOT NULL CHECK(outcome IN('not_matched','dry_run','approval_required','recipient_limit','daily_limit','processed')),
 summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object' AND octet_length(summary::text)<16384),created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),created_in xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,rule_id,event_id),
 FOREIGN KEY(academy_id,rule_id,rule_version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version),
 FOREIGN KEY(academy_id,event_id) REFERENCES public.automation_event_sources(academy_id,event_id),
 FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id)
);
CREATE TABLE public.portal_notifications(
 academy_id uuid NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,rule_id uuid NOT NULL,event_id uuid NOT NULL,person_id uuid NOT NULL,
 person_kind text NOT NULL DEFAULT 'human' CHECK(person_kind='human'),action_index integer NOT NULL CHECK(action_index BETWEEN 0 AND 9),
 severity text NOT NULL CHECK(severity IN('normal','critical')),title text NOT NULL CHECK(length(title) BETWEEN 1 AND 1000),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 10000),
 locale text NOT NULL CHECK(locale IN('en','fr','zh-CN')),created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,rule_id,event_id,person_id,action_index),
 FOREIGN KEY(academy_id,run_id) REFERENCES public.automation_runs(academy_id,id),
 FOREIGN KEY(academy_id,rule_id) REFERENCES public.automation_rules(academy_id,id),
 FOREIGN KEY(academy_id,event_id) REFERENCES public.automation_event_sources(academy_id,event_id),
 FOREIGN KEY(academy_id,person_id,person_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE INDEX portal_inbox ON public.portal_notifications(academy_id,person_id,created_at,id);
CREATE INDEX portal_rule_budget ON public.portal_notifications(academy_id,rule_id,created_at,person_id);
CREATE TABLE public.portal_notification_reads(
 academy_id uuid NOT NULL,notification_id uuid NOT NULL,person_id uuid NOT NULL,read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,notification_id),FOREIGN KEY(academy_id,notification_id) REFERENCES public.portal_notifications(academy_id,id),
 FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id)
);
CREATE FUNCTION public.portal_notification_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'NOTIFICATION_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='automation_runs' THEN
  SELECT h.version,h.hub_id,v.definition INTO r FROM public.automation_rules h JOIN public.automation_rule_revisions v ON v.academy_id=h.academy_id AND v.rule_id=h.id AND v.version=h.version WHERE h.academy_id=NEW.academy_id AND h.id=NEW.rule_id;
  IF r.version IS DISTINCT FROM NEW.rule_version OR jsonb_typeof(NEW.summary->'portalNotifications') IS DISTINCT FROM 'number' OR (NEW.summary->>'portalNotifications')::numeric NOT BETWEEN 0 AND 10000 OR (NEW.summary->>'portalNotifications')::numeric<>trunc((NEW.summary->>'portalNotifications')::numeric) OR
   (NEW.outcome='processed' AND(r.definition->'enabled' IS DISTINCT FROM 'true'::jsonb OR r.definition#>>'{execution,mode}' IS DISTINCT FROM 'automatic')) OR
   (NEW.outcome<>'processed' AND NEW.summary->>'portalNotifications'<>'0') OR NOT EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND(NEW.outcome<>'processed' OR r.hub_id IS NULL OR hub_id=r.hub_id))
   THEN RAISE EXCEPTION 'AUTOMATION_RUN_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='portal_notifications' THEN
  SELECT * INTO r FROM public.automation_runs WHERE academy_id=NEW.academy_id AND id=NEW.run_id;
  IF r.id IS NULL OR r.created_in IS DISTINCT FROM pg_current_xact_id() OR r.outcome<>'processed' OR r.rule_id<>NEW.rule_id OR r.event_id<>NEW.event_id OR
   NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.person_id AND kind='human' AND status='active' AND auth_user_id IS NOT NULL)
   THEN RAISE EXCEPTION 'NOTIFICATION_SOURCE_INVALID' USING ERRCODE='23514';END IF;
  IF NEW.severity='normal' AND EXISTS(SELECT 1 FROM public.automation_event_sources WHERE academy_id=NEW.academy_id AND event_id=NEW.event_id AND projection->>'severity'='critical') THEN RAISE EXCEPTION 'CRITICAL_NOTIFICATION_REQUIRED' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='portal_notification_reads' THEN
  IF NOT EXISTS(SELECT 1 FROM public.portal_notifications WHERE academy_id=NEW.academy_id AND id=NEW.notification_id AND person_id=NEW.person_id) THEN RAISE EXCEPTION 'NOTIFICATION_OWNER_INVALID' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.notification_run_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (SELECT count(*) FROM public.portal_notifications WHERE academy_id=NEW.academy_id AND run_id=NEW.id)<>(NEW.summary->>'portalNotifications')::integer THEN RAISE EXCEPTION 'NOTIFICATION_RUN_INCOMPLETE' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER notification_run_complete AFTER INSERT ON public.automation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.notification_run_complete();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['automation_runs','portal_notifications','portal_notification_reads'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE TRIGGER notification_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.portal_notification_guard()',t);
END LOOP;END $$;
REVOKE ALL ON FUNCTION public.portal_notification_guard(),public.notification_run_complete() FROM PUBLIC;
GRANT SELECT ON public.automation_runs,public.portal_notifications,public.portal_notification_reads TO kavosh_runtime;
GRANT INSERT(academy_id,id,rule_id,rule_version,event_id,actor_id,outcome,summary) ON public.automation_runs TO kavosh_runtime;
GRANT INSERT(academy_id,id,run_id,rule_id,event_id,person_id,action_index,severity,title,body,locale) ON public.portal_notifications TO kavosh_runtime;
GRANT INSERT(academy_id,notification_id,person_id) ON public.portal_notification_reads TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 61 $$;

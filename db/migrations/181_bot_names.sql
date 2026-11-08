-- Cosmetic names have their own revision;changing a label must not rotate
-- credentials,increment the access version or invent legacy history.
CREATE TABLE public.bot_name_changes(
 academy_id uuid NOT NULL,person_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),before_name text NOT NULL,after_name text NOT NULL CHECK(length(btrim(after_name)) BETWEEN 1 AND 200 AND after_name!~'[[:cntrl:]]'),source_basis jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,person_id,version),UNIQUE(academy_id,approval_id),CHECK(before_name<>after_name),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.bot_name_heads(
 academy_id uuid NOT NULL,person_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),PRIMARY KEY(academy_id,person_id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,person_id,version) REFERENCES public.bot_name_changes(academy_id,person_id,version)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['bot_name_changes','bot_name_heads'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,person_id,version,before_name,after_name,source_basis,changed_by,approval_id,reason) ON public.bot_name_changes TO kavosh_runtime;
GRANT INSERT(academy_id,person_id,version),UPDATE(version) ON public.bot_name_heads TO kavosh_runtime;
GRANT UPDATE(name) ON public.people TO kavosh_runtime;
CREATE FUNCTION public.bot_name_basis(who uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',p.id,'name',p.name,'hubId',p.hub_id,'status',p.status,'accessVersion',p.access_version,'ownerId',coalesce(p.supervisor_person_id,a.master_person_id),'cutoff',p.credentials_valid_after,'nameVersion',coalesce(h.version,0))
 FROM public.people p JOIN public.academies a ON a.id=p.academy_id LEFT JOIN public.bot_name_heads h ON h.academy_id=p.academy_id AND h.person_id=p.id WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=who AND p.kind='bot'
$$;
CREATE FUNCTION public.bot_name_change_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;b jsonb;s jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BOT_NAME_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));b=public.bot_name_basis(NEW.person_id);SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',NEW.person_id,'hubId',b->'hubId')));
 IF b IS NULL OR NEW.version<>(b->>'nameVersion')::integer+1 OR NEW.before_name IS DISTINCT FROM b->>'name' OR NEW.source_basis IS DISTINCT FROM b OR a.id IS NULL OR a.status<>'pending' OR a.action IS DISTINCT FROM 'bot.rename' OR a.target_id IS DISTINCT FROM NEW.person_id OR a.target_version<>NEW.version-1 OR a.privacy_capability IS DISTINCT FROM 'bots.view' OR a.scope IS DISTINCT FROM s OR a.review_context IS DISTINCT FROM b OR a.payload IS DISTINCT FROM jsonb_build_object('expectedNameVersion',NEW.version-1,'name',NEW.after_name,'reason',NEW.reason) OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'BOT_NAME_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER bot_name_change_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bot_name_changes FOR EACH ROW EXECUTE FUNCTION public.bot_name_change_guard();
CREATE FUNCTION public.bot_name_head_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BOT_NAME_HEAD_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND(NEW.academy_id IS DISTINCT FROM OLD.academy_id OR NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.version<>OLD.version+1) OR NOT EXISTS(SELECT 1 FROM public.bot_name_changes WHERE academy_id=NEW.academy_id AND person_id=NEW.person_id AND version=NEW.version AND created_at>=transaction_timestamp()) THEN RAISE EXCEPTION 'BOT_NAME_HEAD_EXACT_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER bot_name_head_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bot_name_heads FOR EACH ROW EXECUTE FUNCTION public.bot_name_head_guard();
CREATE FUNCTION public.person_name_write_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.name IS NOT DISTINCT FROM OLD.name OR NOT pg_has_role(current_user,'kavosh_runtime','member') OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RETURN NEW;END IF;
 IF NEW.kind<>'bot' THEN RAISE EXCEPTION 'PERSON_NAME_WORKFLOW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.bot_name_changes c JOIN public.bot_name_heads h ON h.academy_id=c.academy_id AND h.person_id=c.person_id AND h.version=c.version WHERE c.academy_id=NEW.academy_id AND c.person_id=NEW.id AND c.before_name=OLD.name AND c.after_name=NEW.name AND c.created_at>=transaction_timestamp()) THEN RAISE EXCEPTION 'BOT_NAME_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER person_name_write_guard BEFORE UPDATE OF name ON public.people FOR EACH ROW EXECUTE FUNCTION public.person_name_write_guard();
CREATE CONSTRAINT TRIGGER bot_name_reviewed AFTER INSERT ON public.bot_name_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.bot_name_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;BEGIN
 b=public.bot_name_basis(NEW.person_id);
 IF b->>'name' IS DISTINCT FROM NEW.after_name OR(b->>'nameVersion')::integer IS DISTINCT FROM NEW.version OR b-ARRAY['name','nameVersion'] IS DISTINCT FROM NEW.source_basis-ARRAY['name','nameVersion'] OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.person_id AND actor_id=NEW.changed_by AND action='bot.rename' AND created_at=transaction_timestamp() AND changes->>'approvalId'=NEW.approval_id::text AND changes->>'nameVersion'=NEW.version::text AND changes#>>'{before,name}'=NEW.before_name AND changes#>>'{after,name}'=NEW.after_name AND changes->'severity'='"critical"'::jsonb AND changes->'permissionsChanged'='false'::jsonb AND changes->'credentialsChanged'='false'::jsonb) THEN RAISE EXCEPTION 'BOT_NAME_EFFECT_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bot_name_complete AFTER INSERT ON public.bot_name_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bot_name_complete();
CREATE FUNCTION public.bot_name_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='bot.rename' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.bot_name_changes WHERE academy_id=NEW.academy_id AND person_id=NEW.target_id AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'BOT_NAME_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bot_name_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bot_name_effect_required();
-- Preserve existing private handoffs after cosmetic changes only. Every owner,
-- cutoff,role,status,access-version and replacement field remains pinned.
DO $$ DECLARE b text;n text:='p.source_basis IS DISTINCT FROM public.bot_credential_basis(p.person_id,(p.configuration->>''replacesCredentialId'')::uuid)';BEGIN
 b=pg_get_functiondef('public.issue_bot_credential(uuid,uuid,uuid,text)'::regprocedure);IF position(n IN b)=0 THEN RAISE EXCEPTION 'BOT_NAME_CREDENTIAL_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,'(p.source_basis #- ''{bot,person,name}'') IS DISTINCT FROM (public.bot_credential_basis(p.person_id,(p.configuration->>''replacesCredentialId'')::uuid) #- ''{bot,person,name}'')');
END $$;
DO $$ DECLARE b text;n text:='p.action IN(''access.replace'',''supervisor.set'',''person.status'',''bot.create'',''bot-credential.prepare'')';BEGIN
 b=pg_get_functiondef('public.capture_automation_event()'::regprocedure);IF position(n IN b)=0 THEN RAISE EXCEPTION 'BOT_NAME_ALERT_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,'p.action IN(''access.replace'',''supervisor.set'',''person.status'',''bot.create'',''bot-credential.prepare'',''bot.rename'')');
END $$;
REVOKE ALL ON FUNCTION public.bot_name_basis(uuid),public.bot_name_change_guard(),public.bot_name_head_guard(),public.person_name_write_guard(),public.bot_name_complete(),public.bot_name_effect_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bot_name_basis(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 181 $$;

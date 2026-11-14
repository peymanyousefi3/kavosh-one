INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('bots.view','View permitted bot accounts','Administration',true,ARRAY['hub','person','country','region','city']),
 ('bots.edit','Request and inspect reviewed bot registration','Administration',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.bot_account_registrations(
 academy_id uuid NOT NULL,person_id uuid NOT NULL,name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),hub_id uuid,owner_id uuid NOT NULL,owner_version integer NOT NULL CHECK(owner_version>0),source_basis jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,person_id),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id) DEFERRABLE INITIALLY DEFERRED,FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,owner_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.bot_account_registrations ENABLE ROW LEVEL SECURITY;ALTER TABLE public.bot_account_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.bot_account_registrations USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.bot_account_registrations TO kavosh_runtime;
GRANT INSERT(academy_id,person_id,name,hub_id,owner_id,owner_version,source_basis,changed_by,approval_id,reason) ON public.bot_account_registrations TO kavosh_runtime;
CREATE FUNCTION public.bot_registration_basis(who uuid,hub uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('schoolStatus',a.status,'owner',jsonb_build_object('id',p.id,'kind',p.kind,'status',p.status,'hubId',p.hub_id,'version',p.access_version,'verified',public.report_comment_human_verified(p.id)),
 'hub',CASE WHEN h.id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',h.id,'version',h.version,'active',h.active) END)
 FROM public.people p JOIN public.academies a ON a.id=p.academy_id LEFT JOIN public.hubs h ON h.academy_id=p.academy_id AND h.id=hub
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=who
$$;
CREATE FUNCTION public.bot_registration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;b jsonb;s jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BOT_REGISTRATION_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));b=public.bot_registration_basis(NEW.owner_id,NEW.hub_id);
 SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=CASE WHEN NEW.hub_id IS NULL THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(NEW.hub_id)) END;
 IF b IS NULL OR b->>'schoolStatus'<>'active' OR b#>>'{owner,kind}'<>'human' OR b#>>'{owner,status}'<>'active' OR b#>'{owner,verified}' IS DISTINCT FROM 'true'::jsonb OR(b#>>'{owner,version}')::integer<>NEW.owner_version OR(NEW.hub_id IS NOT NULL AND(b#>'{hub,active}' IS DISTINCT FROM 'true'::jsonb OR(b#>>'{hub,id}')::uuid IS DISTINCT FROM NEW.hub_id))
 OR a.id IS NULL OR a.action IS DISTINCT FROM 'bot.create' OR a.target_id IS DISTINCT FROM NEW.person_id OR a.target_version<>0 OR a.status<>'pending' OR a.privacy_capability IS DISTINCT FROM 'bots.view' OR a.scope IS DISTINCT FROM s OR a.review_context IS DISTINCT FROM b OR NEW.source_basis IS DISTINCT FROM b
 OR a.payload IS DISTINCT FROM jsonb_build_object('name',NEW.name,'hubId',NEW.hub_id,'ownerId',NEW.owner_id,'expectedOwnerVersion',NEW.owner_version,'reason',NEW.reason) OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'BOT_REGISTRATION_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER bot_registration_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bot_account_registrations FOR EACH ROW EXECUTE FUNCTION public.bot_registration_guard();
CREATE FUNCTION public.bot_person_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.kind<>'bot' OR NOT pg_has_role(current_user,'kavosh_runtime','member') OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RETURN NEW;END IF;
 IF NEW.status<>'active' OR NEW.auth_user_id IS NOT NULL OR NEW.email IS NOT NULL OR NEW.access_version<>1 OR NEW.credentials_valid_after IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.bot_account_registrations WHERE academy_id=NEW.academy_id AND person_id=NEW.id AND name=NEW.name AND hub_id IS NOT DISTINCT FROM NEW.hub_id AND owner_id=NEW.supervisor_person_id AND created_at>=transaction_timestamp()) THEN RAISE EXCEPTION 'BOT_REGISTRATION_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER bot_person_insert_guard BEFORE INSERT ON public.people FOR EACH ROW EXECUTE FUNCTION public.bot_person_insert_guard();
-- A bot key belongs to its current human owner. Changing the supervisor must
-- not transfer an old owner's key to a new owner with a clean cutoff.
CREATE FUNCTION public.bot_owner_credential_cutoff() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.kind='bot' AND NEW.supervisor_person_id IS DISTINCT FROM OLD.supervisor_person_id THEN NEW.credentials_valid_after=clock_timestamp();END IF;RETURN NEW;
END $$;
CREATE TRIGGER bot_owner_credential_cutoff BEFORE UPDATE OF supervisor_person_id ON public.people FOR EACH ROW EXECUTE FUNCTION public.bot_owner_credential_cutoff();
CREATE CONSTRAINT TRIGGER bot_registration_reviewed AFTER INSERT ON public.bot_account_registrations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.bot_registration_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.bot_registration_basis(NEW.owner_id,NEW.hub_id) IS DISTINCT FROM NEW.source_basis OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.person_id AND kind='bot' AND name=NEW.name AND hub_id IS NOT DISTINCT FROM NEW.hub_id AND supervisor_person_id=NEW.owner_id AND status='active' AND auth_user_id IS NULL AND access_version=1)
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.person_id AND actor_id=NEW.changed_by AND action='bot.create' AND created_at=transaction_timestamp() AND changes->>'approvalId'=NEW.approval_id::text AND changes->>'ownerId'=NEW.owner_id::text AND changes->'severity'='"critical"'::jsonb AND changes->'rolesGranted'='0'::jsonb AND changes->'credentialIssued'='false'::jsonb)
 THEN RAISE EXCEPTION 'BOT_REGISTRATION_EFFECT_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bot_registration_complete AFTER INSERT ON public.bot_account_registrations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bot_registration_complete();
CREATE FUNCTION public.bot_registration_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='bot.create' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.bot_account_registrations WHERE academy_id=NEW.academy_id AND person_id=NEW.target_id AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'BOT_REGISTRATION_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bot_registration_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bot_registration_effect_required();
DO $$ DECLARE b text;n text:='p.action IN(''access.replace'',''supervisor.set'',''person.status'')';BEGIN
 b=pg_get_functiondef('public.capture_automation_event()'::regprocedure);IF position(n IN b)=0 THEN RAISE EXCEPTION 'BOT_REGISTRATION_ALERT_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,'p.action IN(''access.replace'',''supervisor.set'',''person.status'',''bot.create'')');
END $$;
REVOKE ALL ON FUNCTION public.bot_registration_basis(uuid,uuid),public.bot_registration_guard(),public.bot_person_insert_guard(),public.bot_registration_complete(),public.bot_registration_effect_required() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bot_owner_credential_cutoff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bot_registration_basis(uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 179 $$;

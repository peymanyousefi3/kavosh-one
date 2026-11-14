-- School-local credential cutoff: disabling one membership must not delete a
-- shared login or sessions belonging to another school. Old credentials stay
-- invalid after reactivation; new verified login/token issuance is required.
ALTER TABLE public.people ADD COLUMN credentials_valid_after timestamptz;
CREATE TABLE public.person_status_changes(
 academy_id uuid NOT NULL,person_id uuid NOT NULL,version integer NOT NULL CHECK(version>1),before_status text NOT NULL CHECK(before_status IN('active','pending','disabled')),after_status text NOT NULL CHECK(after_status IN('active','pending','disabled')),source_snapshot jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,person_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),CHECK(before_status<>after_status)
);
ALTER TABLE public.person_status_changes ENABLE ROW LEVEL SECURITY;ALTER TABLE public.person_status_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.person_status_changes USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.person_status_changes TO kavosh_runtime;
GRANT INSERT(academy_id,person_id,version,before_status,after_status,source_snapshot,changed_by,approval_id) ON public.person_status_changes TO kavosh_runtime;
GRANT UPDATE(status) ON public.people TO kavosh_runtime;
CREATE FUNCTION public.person_status_basis(who uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('personId',p.id,'kind',p.kind,'status',p.status,'version',p.access_version,'hubId',p.hub_id,'identityBound',p.auth_user_id IS NOT NULL)
 FROM public.people p WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=who
$$;
CREATE FUNCTION public.person_status_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;a record;expected text;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PERSON_STATUS_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));
 SELECT * INTO p FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.person_id FOR UPDATE NOWAIT;
 SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 expected=CASE WHEN a.payload->'enabled'='true'::jsonb THEN CASE WHEN p.kind='bot' OR p.auth_user_id IS NOT NULL THEN 'active' ELSE 'pending' END ELSE 'disabled' END;
 IF p.id IS NULL OR NEW.changed_by=NEW.person_id OR EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.person_id)
 OR p.access_version<>NEW.version-1 OR p.status IS DISTINCT FROM NEW.before_status OR NEW.after_status IS DISTINCT FROM expected OR(NEW.after_status<>'disabled' AND p.status<>'disabled')
 OR a.id IS NULL OR a.status<>'pending' OR a.action IS DISTINCT FROM 'person.status' OR a.target_id IS DISTINCT FROM NEW.person_id OR a.target_version<>NEW.version-1 OR a.privacy_capability IS DISTINCT FROM 'access.view'
 OR a.payload-ARRAY['expectedVersion','enabled','reason']<>'{}'::jsonb OR a.payload->'expectedVersion' IS DISTINCT FROM to_jsonb(NEW.version-1) OR jsonb_typeof(a.payload->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(a.payload->'reason') IS DISTINCT FROM 'string' OR length(btrim(a.payload->>'reason')) NOT BETWEEN 1 AND 2000
 OR a.review_context IS DISTINCT FROM public.person_status_basis(NEW.person_id) OR NEW.source_snapshot IS DISTINCT FROM a.review_context OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'PERSON_STATUS_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER person_status_revision BEFORE INSERT OR UPDATE OR DELETE ON public.person_status_changes FOR EACH ROW EXECUTE FUNCTION public.person_status_revision_guard();
CREATE FUNCTION public.person_status_write_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record;BEGIN
 -- Identity acceptance retains its existing separately privileged verified
 -- invitation policy. Ordinary runtime cannot call that executor or rebind IDs.
 IF NOT pg_has_role(current_user,'kavosh_runtime','member') OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RETURN NEW;END IF;
 IF NEW.credentials_valid_after IS DISTINCT FROM OLD.credentials_valid_after THEN RAISE EXCEPTION 'PERSON_CREDENTIAL_CUTOFF_SERVER_OWNED' USING ERRCODE='23514';END IF;
 IF NEW.status=OLD.status THEN RETURN NEW;END IF;
 SELECT * INTO r FROM public.person_status_changes WHERE academy_id=NEW.academy_id AND person_id=NEW.id AND version=OLD.access_version+1 AND before_status=OLD.status AND after_status=NEW.status AND created_at>=transaction_timestamp();
 IF r.person_id IS NULL OR NEW.access_version<>OLD.access_version+1 THEN RAISE EXCEPTION 'PERSON_STATUS_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.status='disabled' THEN NEW.credentials_valid_after=r.created_at;END IF;RETURN NEW;
END $$;
CREATE TRIGGER person_status_write BEFORE UPDATE OF status,credentials_valid_after ON public.people FOR EACH ROW EXECUTE FUNCTION public.person_status_write_guard();
CREATE CONSTRAINT TRIGGER person_status_reviewed AFTER INSERT ON public.person_status_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.person_status_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.person_id AND status=NEW.after_status AND access_version=NEW.version AND(NEW.after_status<>'disabled' OR credentials_valid_after=NEW.created_at))
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.person_id AND actor_id=NEW.changed_by AND action='person.status' AND created_at=transaction_timestamp() AND changes->'version'=to_jsonb(NEW.version) AND changes->>'approvalId'=NEW.approval_id::text AND changes->'severity'='"critical"'::jsonb)
 THEN RAISE EXCEPTION 'PERSON_STATUS_EFFECT_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER person_status_complete AFTER INSERT ON public.person_status_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.person_status_complete();
CREATE FUNCTION public.person_status_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='person.status' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.person_status_changes WHERE academy_id=NEW.academy_id AND person_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PERSON_STATUS_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER person_status_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.person_status_effect_required();
-- Preserve existing function identity,owner,ACL and all original checks. The
-- new predicates only narrow to an active school membership and fresh secret.
DO $$ DECLARE f text;b text;n text;r text;BEGIN
 FOREACH f IN ARRAY ARRAY['public.authenticate_human(uuid,uuid,uuid)','public.lock_human(uuid,uuid)'] LOOP
  b=pg_get_functiondef(f::regprocedure);n='p.status=''active''';r=n||' AND(p.credentials_valid_after IS NULL OR s."createdAt">p.credentials_valid_after)';
  IF position(n IN b)=0 THEN RAISE EXCEPTION 'PERSON_STATUS_HUMAN_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,r);
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.authenticate_bot(text)','public.lock_bot(uuid)','public.current_bot_scope(uuid)'] LOOP
  b=pg_get_functiondef(f::regprocedure);
  IF f='public.authenticate_bot(text)' THEN n='t.expires_at > clock_timestamp()';r=n||' AND EXISTS(SELECT 1 FROM public.people p JOIN public.academies school ON school.id=p.academy_id JOIN public.people owner ON owner.academy_id=p.academy_id AND owner.id=coalesce(p.supervisor_person_id,school.master_person_id) WHERE p.academy_id=t.academy_id AND p.id=t.person_id AND p.status=''active'' AND owner.status=''active'' AND(owner.credentials_valid_after IS NULL OR t.created_at>owner.credentials_valid_after) AND(p.credentials_valid_after IS NULL OR t.created_at>p.credentials_valid_after))';
  ELSIF f='public.lock_bot(uuid)' THEN n='t.expires_at > clock_timestamp()';r=n||' AND EXISTS(SELECT 1 FROM public.people p JOIN public.academies school ON school.id=p.academy_id JOIN public.people owner ON owner.academy_id=p.academy_id AND owner.id=coalesce(p.supervisor_person_id,school.master_person_id) WHERE p.academy_id=t.academy_id AND p.id=t.person_id AND p.status=''active'' AND owner.status=''active'' AND(owner.credentials_valid_after IS NULL OR t.created_at>owner.credentials_valid_after) AND(p.credentials_valid_after IS NULL OR t.created_at>p.credentials_valid_after))';
  ELSE n='c.expires_at>clock_timestamp()';r=n||' AND EXISTS(SELECT 1 FROM public.people p JOIN public.academies school ON school.id=p.academy_id JOIN public.people owner ON owner.academy_id=p.academy_id AND owner.id=coalesce(p.supervisor_person_id,school.master_person_id) WHERE p.academy_id=c.academy_id AND p.id=c.person_id AND p.status=''active'' AND owner.status=''active'' AND(owner.credentials_valid_after IS NULL OR c.created_at>owner.credentials_valid_after) AND(p.credentials_valid_after IS NULL OR c.created_at>p.credentials_valid_after))';END IF;
  IF position(n IN b)=0 THEN RAISE EXCEPTION 'PERSON_STATUS_BOT_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,r);
 END LOOP;
END $$;
-- Hold the bot membership as well as its key while an authenticated operation
-- runs. Status changes use NOWAIT,so they never deadlock behind that operation.
CREATE OR REPLACE FUNCTION public.lock_bot(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM 1 FROM auth_private.credentials t JOIN public.people p ON p.academy_id=t.academy_id AND p.id=t.person_id
 JOIN public.academies school ON school.id=p.academy_id JOIN public.people owner ON owner.academy_id=p.academy_id AND owner.id=coalesce(p.supervisor_person_id,school.master_person_id)
 WHERE t.id=p_id AND t.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid
 AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp() AND p.status='active' AND owner.status='active' AND(owner.credentials_valid_after IS NULL OR t.created_at>owner.credentials_valid_after) AND(p.credentials_valid_after IS NULL OR t.created_at>p.credentials_valid_after) FOR SHARE OF t,p,owner;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.person_status_basis(uuid),public.person_status_revision_guard(),public.person_status_write_guard(),public.person_status_complete(),public.person_status_effect_required() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.person_status_basis(uuid) TO kavosh_runtime;
-- Account shutdown/reactivation is critical before it is applied too: reuse
-- the existing bounded upper-review alert publisher,not a second message path.
DO $$ DECLARE b text;n text:='p.action IN(''access.replace'',''supervisor.set'')';BEGIN
 b=pg_get_functiondef('public.capture_automation_event()'::regprocedure);
 IF position(n IN b)=0 THEN RAISE EXCEPTION 'PERSON_STATUS_ALERT_SOURCE_CHANGED';END IF;
 EXECUTE replace(b,n,'p.action IN(''access.replace'',''supervisor.set'',''person.status'')');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 178 $$;

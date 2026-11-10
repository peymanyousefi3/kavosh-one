-- Reviewed academic images/certificate files reuse private file inspection,
-- verified copies and conditional downloads;never upload/public bearer links.
CREATE TABLE public.achievement_asset_revisions(
 academy_id uuid NOT NULL,award_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),award_version integer NOT NULL CHECK(award_version>0),
 assets jsonb NOT NULL,source jsonb NOT NULL CHECK(jsonb_typeof(source)='object'),changed_by uuid NOT NULL,approval_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,award_id,version),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,award_id,award_version) REFERENCES public.achievement_award_revisions(academy_id,award_id,version),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.achievement_asset_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.achievement_asset_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.achievement_asset_revisions USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.achievement_asset_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,award_id,version,award_version,assets,source,changed_by,approval_id,reason) ON public.achievement_asset_revisions TO kavosh_runtime;
CREATE FUNCTION public.achievement_assets_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE x jsonb;BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v)>10 OR octet_length(v::text)>16384 THEN RETURN false;END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(v) LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR NOT(x ?& ARRAY['fileId','fileVersion','copyId','kind','label']) OR x-ARRAY['fileId','fileVersion','copyId','kind','label']<>'{}'::jsonb
  OR jsonb_typeof(x->'fileId') IS DISTINCT FROM 'string' OR(x->>'fileId')::uuid::text IS DISTINCT FROM x->>'fileId' OR jsonb_typeof(x->'copyId') IS DISTINCT FROM 'string' OR(x->>'copyId')::uuid::text IS DISTINCT FROM x->>'copyId'
  OR jsonb_typeof(x->'fileVersion') IS DISTINCT FROM 'number' OR x->>'fileVersion'!~'^[1-9][0-9]*$' OR(x->>'fileVersion')::numeric>2147483647
  OR jsonb_typeof(x->'kind') IS DISTINCT FROM 'string' OR x->>'kind' NOT IN('image','certificate') OR jsonb_typeof(x->'label') IS DISTINCT FROM 'string' OR length(btrim(x->>'label')) NOT BETWEEN 1 AND 200 OR x->>'label'~'[[:cntrl:]]' THEN RETURN false;END IF;
 END LOOP;
 RETURN(SELECT count(*)=count(DISTINCT value->>'fileId') FROM jsonb_array_elements(v));
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.achievement_asset_source(p_award uuid,p_version integer,p_assets jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;award record;x jsonb;f record;d jsonb;items jsonb:='[]'::jsonb;BEGIN
 IF NOT public.achievement_assets_valid(p_assets) THEN RETURN NULL;END IF;
 SELECT a.* INTO award FROM public.achievement_awards a JOIN public.achievement_award_revisions r ON r.academy_id=a.academy_id AND r.award_id=a.id AND r.version=a.version AND r.definition=to_jsonb(a)
 JOIN public.approval_requests p ON p.academy_id=a.academy_id AND p.id=a.approval_id AND p.status='applied' AND p.action IN('achievement.issue','achievement.change') AND p.target_id=a.id AND p.target_version=a.version-1 AND p.reviewer_id=a.changed_by
 WHERE a.academy_id=tenant AND a.id=p_award AND a.version=p_version;
 IF award.id IS NULL OR(jsonb_array_length(p_assets)>0 AND award.status<>'awarded') THEN RETURN NULL;END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(p_assets) LOOP
  SELECT id,version,archived,domain,person_id,claimed_mime_type INTO f FROM public.file_catalogue WHERE academy_id=tenant AND id=(x->>'fileId')::uuid;
  IF f.id IS NULL OR f.version<>(x->>'fileVersion')::integer OR f.archived OR f.domain<>'student_private' OR f.person_id IS DISTINCT FROM award.student_id THEN RETURN NULL;END IF;
  d=public.file_download_source(f.id,f.version,(x->>'copyId')::uuid);
  IF d IS NULL OR(x->>'kind'='certificate' AND d->>'mime'<>'application/pdf') OR(x->>'kind'='image' AND d->>'mime' NOT IN('image/jpeg','image/png','image/webp','image/gif','image/avif')) THEN RETURN NULL;END IF;
  items=items||jsonb_build_array(jsonb_build_object('asset',x,'file',d));
 END LOOP;
 RETURN jsonb_build_object('awardId',award.id,'awardVersion',award.version,'studentId',award.student_id,'hubId',award.hub_id,'classId',award.class_id,'status',award.status,'files',items);
END $$;
CREATE FUNCTION public.guard_achievement_asset_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a record;b jsonb;prior jsonb;v integer;f uuid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ACHIEVEMENT_ASSET_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 IF NOT public.achievement_assets_valid(NEW.assets) THEN RAISE EXCEPTION 'ACHIEVEMENT_ASSET_INPUT_INVALID' USING ERRCODE='23514';END IF;
 FOR f IN SELECT(value->>'fileId')::uuid FROM jsonb_array_elements(NEW.assets) ORDER BY 1 LOOP PERFORM id FROM public.file_records WHERE academy_id=NEW.academy_id AND id=f FOR SHARE;END LOOP;
 SELECT to_jsonb(r),r.version INTO prior,v FROM public.achievement_asset_revisions r WHERE r.academy_id=NEW.academy_id AND r.award_id=NEW.award_id ORDER BY r.version DESC LIMIT 1;
 b=public.achievement_asset_source(NEW.award_id,NEW.award_version,NEW.assets);SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR NEW.source IS DISTINCT FROM b OR NEW.version<>coalesce(v,0)+1 OR a.id IS NULL OR a.status<>'pending' OR a.action<>'achievement-assets.change' OR a.target_id IS DISTINCT FROM NEW.award_id OR a.target_version<>NEW.version-1 OR a.privacy_capability IS DISTINCT FROM 'achievements.view'
 OR a.scope IS DISTINCT FROM public.achievement_award_scope((b->>'studentId')::uuid,(b->>'hubId')::uuid,(b->>'classId')::uuid) OR a.review_context IS DISTINCT FROM jsonb_build_object('before',prior,'source',b)
 OR a.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'awardVersion',NEW.award_version,'assets',NEW.assets,'reason',NEW.reason) OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'ACHIEVEMENT_ASSET_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF(NEW.changed_by=(b->>'studentId')::uuid OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=(b->>'studentId')::uuid AND guardian_id=NEW.changed_by)) AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'ACHIEVEMENT_ASSET_BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.recorded_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER achievement_asset_guard BEFORE INSERT OR UPDATE OR DELETE ON public.achievement_asset_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_achievement_asset_revision();
CREATE TRIGGER achievement_asset_write BEFORE INSERT ON public.achievement_asset_revisions FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write();
CREATE CONSTRAINT TRIGGER achievement_asset_reviewed AFTER INSERT ON public.achievement_asset_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.achievement_asset_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events e ON e.academy_id=a.academy_id AND e.entity_id=a.entity_id AND e.request_id=a.request_id AND e.event_type=a.action AND e.created_at=transaction_timestamp()
 WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.award_id AND a.actor_id=NEW.changed_by AND a.actor_kind='human' AND a.action='achievement-assets.change' AND a.created_at=transaction_timestamp() AND a.hub_id IS NOT DISTINCT FROM(NEW.source->>'hubId')::uuid AND a.changes=jsonb_build_object('version',NEW.version,'awardVersion',NEW.award_version,'approvalId',NEW.approval_id,'severity','critical','assetCount',jsonb_array_length(NEW.assets),'privateContentRedacted',true)) THEN RAISE EXCEPTION 'ACHIEVEMENT_ASSET_AUDIT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER achievement_asset_complete AFTER INSERT ON public.achievement_asset_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.achievement_asset_complete();
CREATE FUNCTION public.achievement_asset_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;event uuid;BEGIN
 IF NEW.action<>'achievement-assets.change' THEN RETURN NULL;END IF;SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF a.status='applied' AND NOT EXISTS(SELECT 1 FROM public.achievement_asset_revisions r WHERE r.academy_id=a.academy_id AND r.award_id=a.target_id AND r.approval_id=a.id AND r.changed_by=a.reviewer_id AND r.version=a.target_version+1) THEN RAISE EXCEPTION 'ACHIEVEMENT_ASSET_EFFECT_REQUIRED' USING ERRCODE='55000';END IF;
 SELECT e.event_id INTO event FROM public.automation_event_sources e JOIN public.audit_events audit ON audit.academy_id=e.academy_id AND audit.id=e.audit_id WHERE e.academy_id=a.academy_id AND e.approval_id=a.id AND e.source_kind='approval' AND e.source_version=a.version AND e.event_type='approval.'||CASE WHEN a.status='pending' THEN 'requested' ELSE a.status END AND e.projection->>'severity'='critical' AND e.origin_transaction=pg_current_xact_id() AND audit.action=e.event_type AND audit.entity_id=a.id AND audit.created_at=transaction_timestamp();
 IF event IS NULL OR EXISTS(SELECT 1 FROM(SELECT c.person_id FROM public.supervisor_chain(a.requester_id) c UNION SELECT a.requester_id WHERE a.status<>'pending' UNION SELECT master_person_id FROM public.academies WHERE id=a.academy_id) audience JOIN public.people p ON p.academy_id=a.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL WHERE NOT EXISTS(SELECT 1 FROM public.portal_notifications n WHERE n.academy_id=a.academy_id AND n.event_id=event AND n.person_id=p.id AND n.origin='mandatory')) THEN RAISE EXCEPTION 'ACHIEVEMENT_ASSET_NOTICE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER achievement_asset_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.achievement_asset_effect_required();
CREATE FUNCTION public.achievement_asset_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;x jsonb;f record;BEGIN
 SELECT student_id,hub_id,class_id INTO a FROM public.achievement_awards WHERE academy_id=NEW.academy_id AND id=NEW.target_id;
 IF NOT FOUND OR NOT public.achievement_assets_valid(NEW.payload->'assets') THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','achievements.view','scope',public.achievement_award_scope(a.student_id,a.hub_id,a.class_id)));
 FOR x IN SELECT * FROM jsonb_array_elements((NEW.payload->'assets')||coalesce((SELECT r.assets FROM public.achievement_asset_revisions r WHERE r.academy_id=NEW.academy_id AND r.award_id=NEW.target_id ORDER BY r.version DESC LIMIT 1),'[]'::jsonb)) LOOP
  SELECT id,person_id,effective_hub_id INTO f FROM public.file_catalogue WHERE academy_id=NEW.academy_id AND id=(x->>'fileId')::uuid AND domain='student_private' AND person_id=a.student_id;
  IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','files.view','personId',f.person_id),jsonb_build_object('capability','students.view','personId',f.person_id));END IF;
 END LOOP;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END $$;
CREATE TRIGGER zz_achievement_asset_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='achievement-assets.change') EXECUTE FUNCTION public.achievement_asset_privacy();
CREATE FUNCTION public.achievement_asset_release_binding(p_award uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE rev record;s jsonb;ok boolean;BEGIN
 SELECT r.* INTO rev FROM public.achievement_asset_revisions r WHERE r.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND r.award_id=p_award ORDER BY r.version DESC LIMIT 1;
 IF rev.version IS NULL THEN RETURN '{}'::jsonb;END IF;s=public.achievement_asset_source(rev.award_id,rev.award_version,rev.assets);
 ok=s IS NOT NULL AND s=rev.source AND EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=rev.academy_id AND p.id=rev.approval_id AND p.status='applied' AND p.action='achievement-assets.change' AND p.target_id=rev.award_id AND p.target_version=rev.version-1 AND p.reviewer_id=rev.changed_by);
 RETURN jsonb_build_object('assetRevision',rev.version,'assetsReady',ok,'assetSourceFingerprint',CASE WHEN ok THEN encode(sha256(convert_to(rev.source::text,'UTF8')),'hex') ELSE NULL END);
END $$;
DO $$ DECLARE d text;u text;BEGIN
 -- Attachment proposals are manual publishing decisions,including before a
 -- domain row exists. Preserve the shared mandatory critical approval floor.
 d=pg_get_functiondef('public.capture_automation_event()'::regprocedure);
 u=replace(d,$q$p.action IN('access.replace','supervisor.set'$q$,$r$p.action IN('access.replace','supervisor.set','achievement-assets.change'$r$);
 IF u=d THEN RAISE EXCEPTION 'ACHIEVEMENT_ASSET_ALERT_SOURCE_CHANGED';END IF;EXECUTE u;
 d=pg_get_functiondef('public.achievement_family_source(uuid)'::regprocedure);
 u=replace(d,$q$'typeDefinition',a.context#>'{type,definition}')$q$,$r$'typeDefinition',a.context#>'{type,definition}')||public.achievement_asset_release_binding(a.id)$r$);
 IF u=d THEN RAISE EXCEPTION 'ACHIEVEMENT_FAMILY_ASSET_SOURCE_CHANGED';END IF;u=replace(u,' STABLE',' VOLATILE');EXECUTE u;
 d=pg_get_functiondef('public.guard_achievement_family_publication()'::regprocedure);
 u=replace(d,$q$(NEW.state='published' AND a.status<>'awarded')$q$,$r$(NEW.state='published' AND(a.status<>'awarded' OR s->'assetsReady' IS NOT DISTINCT FROM 'false'::jsonb))$r$);
 IF u=d THEN RAISE EXCEPTION 'ACHIEVEMENT_FAMILY_ASSET_GUARD_CHANGED';END IF;EXECUTE u;
END $$;
CREATE FUNCTION public.achievement_family_recipient(p_award uuid,p_student uuid,p_actor uuid,p_scope jsonb) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.achievement_awards a JOIN public.achievement_family_publications f ON f.academy_id=a.academy_id AND f.award_id=a.id AND f.award_version=a.version AND f.state='published'
 JOIN public.approval_requests p ON p.academy_id=f.academy_id AND p.id=f.approval_id AND p.status='applied' AND p.action='achievement-family.change' AND p.target_id=f.id AND p.target_version=f.version-1 AND p.reviewer_id=f.changed_by
 WHERE a.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND a.id=p_award AND a.student_id=p_student AND a.status='awarded' AND public.report_recipient(p_student,p_actor) AND f.source=public.achievement_family_source(a.id) AND f.source->'assetsReady' IS DISTINCT FROM 'false'::jsonb
 AND public.scope_contains(p_scope,public.achievement_award_scope(a.student_id,a.hub_id,a.class_id)) AND(a.class_id IS NULL OR EXISTS(SELECT 1 FROM public.class_enrollments e WHERE e.academy_id=a.academy_id AND e.class_id=a.class_id AND e.student_id=a.student_id AND e.enabled AND e.joins_on<=a.earned_on AND(e.leaves_on IS NULL OR e.leaves_on>=a.earned_on))))
$$;
REVOKE ALL ON FUNCTION public.achievement_family_recipient(uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.achievement_family_recipient(uuid,uuid,uuid,jsonb) TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.achievement_assets_valid(jsonb),public.achievement_asset_source(uuid,integer,jsonb),public.guard_achievement_asset_revision(),public.achievement_asset_complete(),public.achievement_asset_privacy(),public.achievement_asset_release_binding(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.achievement_asset_effect_required() FROM PUBLIC;
-- Audit/outbox verification stays behind the existing non-login event policy;
-- never grant the web runtime raw outbox reads or the policy private assets.
GRANT CREATE ON SCHEMA public TO kavosh_event_policy;
GRANT SELECT(academy_id,award_id,version,changed_by,approval_id) ON public.achievement_asset_revisions TO kavosh_event_policy;
ALTER FUNCTION public.achievement_asset_effect_required() SECURITY DEFINER;
ALTER FUNCTION public.achievement_asset_effect_required() OWNER TO kavosh_event_policy;
ALTER FUNCTION public.achievement_asset_complete() SECURITY DEFINER;
ALTER FUNCTION public.achievement_asset_complete() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy;
GRANT EXECUTE ON FUNCTION public.achievement_assets_valid(jsonb),public.achievement_asset_source(uuid,integer,jsonb),public.achievement_asset_release_binding(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 355 $$;

-- Explicit image release is independent of the text profile and academic
-- showcase. A private upload or award is never implicit image publication.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('profile-images.view','View reviewed profile image selections','Community',true,ARRAY['academy','hub','person','country','region','city']),
 ('profile-images.publish','Review profile avatar and achievement image sharing','Community',true,ARRAY['academy','hub','person','country','region','city']);
CREATE TABLE public.profile_image_releases(
 academy_id uuid NOT NULL,profile_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('published','withdrawn')),
 selection jsonb NOT NULL,source jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,profile_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,profile_id) REFERENCES public.community_profiles(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.profile_image_releases ENABLE ROW LEVEL SECURITY;ALTER TABLE public.profile_image_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.profile_image_releases USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.profile_image_releases TO kavosh_runtime;
GRANT INSERT(academy_id,profile_id,version,state,selection,source,changed_by,approval_id,reason) ON public.profile_image_releases TO kavosh_runtime;
CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.profile_image_releases FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion();
CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.profile_image_releases FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate();
CREATE FUNCTION public.profile_image_selection_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE x jsonb;t jsonb;k text;identities text[]:=ARRAY[]::text[];BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v)>100 OR octet_length(v::text)>65536 THEN RETURN false;END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(v) LOOP
  IF jsonb_typeof(x) IS DISTINCT FROM 'object' OR x->>'kind' IS NULL OR x->>'kind' NOT IN('avatar','achievement') OR jsonb_typeof(x->'alt') IS DISTINCT FROM 'object' OR NOT((x->'alt')?'en') OR (x->'alt')-ARRAY['en','fr','zh-CN']<>'{}'::jsonb THEN RETURN false;END IF;
  FOR k,t IN SELECT * FROM jsonb_each(x->'alt') LOOP IF jsonb_typeof(t) IS DISTINCT FROM 'string' OR length(btrim(t#>>'{}')) NOT BETWEEN 1 AND 300 OR(t#>>'{}')~'[[:cntrl:]]' THEN RETURN false;END IF;END LOOP;
  IF x->>'kind'='avatar' THEN IF x-ARRAY['kind','alt']<>'{}'::jsonb THEN RETURN false;END IF;k='avatar';
  ELSE
   IF NOT(x ?& ARRAY['awardId','awardVersion','assetVersion','attachmentNo']) OR x-ARRAY['kind','alt','awardId','awardVersion','assetVersion','attachmentNo']<>'{}'::jsonb OR jsonb_typeof(x->'awardId') IS DISTINCT FROM 'string' OR(x->>'awardId')::uuid::text IS DISTINCT FROM x->>'awardId' THEN RETURN false;END IF;
   FOREACH k IN ARRAY ARRAY['awardVersion','assetVersion','attachmentNo'] LOOP IF jsonb_typeof(x->k) IS DISTINCT FROM 'number' OR x->>k!~'^[1-9][0-9]*$' OR(x->>k)::numeric>2147483647 THEN RETURN false;END IF;END LOOP;
   IF(x->>'attachmentNo')::integer>10 THEN RETURN false;END IF;k=(x->>'awardId')||':'||(x->>'attachmentNo');
  END IF;
  IF k=ANY(identities) THEN RETURN false;END IF;identities=array_append(identities,k);
 END LOOP;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
CREATE FUNCTION public.profile_image_source(p_profile uuid,p_state text,p_selection jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;p record;b jsonb;public_id uuid;audience text;eligible boolean;x jsonb;f record;d jsonb;entry jsonb;asset record;academic record;academic_version integer;binding jsonb;cache jsonb:='{}'::jsonb;selected_asset jsonb;items jsonb:='[]'::jsonb;BEGIN
 IF tenant IS NULL OR p_state IS NULL OR p_state NOT IN('published','withdrawn') OR NOT public.profile_image_selection_valid(p_selection) OR(p_state='withdrawn' AND p_selection<>'[]'::jsonb) OR(p_state='published' AND p_selection='[]'::jsonb) THEN RETURN NULL;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 SELECT c.id,c.anchor_kind,c.person_id,c.hub_id,c.definition INTO p FROM public.community_profiles c WHERE c.academy_id=tenant AND c.id=p_profile;IF p.id IS NULL THEN RETURN NULL;END IF;
 b=public.profile_publication_basis(p_profile);IF b->'owner' IS NULL OR b->'owner'='null'::jsonb THEN RETURN NULL;END IF;
 SELECT h.public_id INTO public_id FROM public.profile_publication_heads h WHERE h.academy_id=tenant AND h.profile_id=p_profile;
 audience=CASE WHEN p.anchor_kind='person' THEN 'members' ELSE 'public' END;
 IF p.anchor_kind='person' THEN b=public.profile_publication_basis(p_profile,audience);END IF;
 eligible=public_id IS NOT NULL AND public.published_profile_projection(public_id,audience) IS NOT NULL;
 IF p_state='published' AND NOT eligible THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_selection) s WHERE s->>'kind'='achievement') THEN
  IF p.anchor_kind<>'person' OR public.published_academic_profile(public_id,'members') IS NULL THEN RETURN NULL;END IF;
  SELECT r.* INTO academic FROM public.academic_profile_releases r WHERE r.academy_id=tenant AND r.profile_id=p_profile ORDER BY r.version DESC LIMIT 1;
  academic_version=academic.version;
 END IF;
 FOR x IN SELECT * FROM jsonb_array_elements(p_selection) LOOP
  IF x->>'kind'='avatar' THEN
   entry=p.definition->'avatar';IF entry IS NULL OR entry='null'::jsonb THEN RETURN NULL;END IF;
   SELECT id,version,domain,anchor_kind,person_id,hub_id INTO f FROM public.file_records WHERE academy_id=tenant AND id=(entry->>'fileId')::uuid AND version=(entry->>'fileVersion')::integer AND NOT archived;
   IF f.id IS NULL OR f.domain<>'general' OR f.anchor_kind<>p.anchor_kind OR(f.anchor_kind='person' AND f.person_id IS DISTINCT FROM p.person_id) OR(f.anchor_kind='hub' AND f.hub_id IS DISTINCT FROM p.hub_id) THEN RETURN NULL;END IF;
   d=public.file_download_source(f.id,f.version,(entry->>'copyId')::uuid);
  ELSE
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(academic.awards) a WHERE a->>'awardId'=x->>'awardId' AND a->'awardVersion'=x->'awardVersion') THEN RETURN NULL;END IF;
   -- Recheck an original asset bundle once per award,not once per image.
   -- Cache is statement-local and the shared topology lock stays held.
   IF NOT(cache?(x->>'awardId')) THEN
    SELECT r.* INTO asset FROM public.achievement_asset_revisions r WHERE r.academy_id=tenant AND r.award_id=(x->>'awardId')::uuid ORDER BY r.version DESC LIMIT 1;
    binding=public.achievement_asset_release_binding((x->>'awardId')::uuid);
    IF asset.version IS NULL OR binding->'assetsReady' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL;END IF;
    cache=jsonb_set(cache,ARRAY[x->>'awardId'],jsonb_build_object('version',asset.version,'awardVersion',asset.award_version,'assets',asset.assets,'files',asset.source->'files','studentId',asset.source->'studentId'));
   END IF;
   selected_asset=cache->(x->>'awardId');
   IF(selected_asset->>'version')::integer<>(x->>'assetVersion')::integer OR(selected_asset->>'awardVersion')::integer<>(x->>'awardVersion')::integer THEN RETURN NULL;END IF;
   entry=(selected_asset->'assets')->((x->>'attachmentNo')::integer-1);IF entry IS NULL OR entry->>'kind'<>'image' OR selected_asset->>'studentId' IS DISTINCT FROM p.person_id::text THEN RETURN NULL;END IF;
   d=selected_asset#>ARRAY['files',((x->>'attachmentNo')::integer-1)::text,'file'];
  END IF;
  IF d IS NULL OR jsonb_typeof(d) IS DISTINCT FROM 'object' OR d->>'mime' IS NULL OR d->>'mime' NOT IN('image/jpeg','image/png','image/webp','image/gif','image/avif') OR jsonb_typeof(d->'bytes') IS DISTINCT FROM 'number' OR d->>'bytes'!~'^[1-9][0-9]{0,7}$' OR(d->>'bytes')::bigint>33554432 THEN RETURN NULL;END IF;
  items=items||jsonb_build_array(jsonb_build_object('choice',x,'file',d));
 END LOOP;
 RETURN jsonb_build_object('profile',b,'publicId',public_id,'readAudience',audience,'eligible',eligible,'academicReleaseVersion',academic_version,'images',items);
END $$;
CREATE FUNCTION public.guard_profile_image_release() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE q record;prior jsonb;v integer;s jsonb;f uuid;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PROFILE_IMAGE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.academy_id::text,9));
 SELECT to_jsonb(r),r.version INTO prior,v FROM public.profile_image_releases r WHERE r.academy_id=NEW.academy_id AND r.profile_id=NEW.profile_id ORDER BY r.version DESC LIMIT 1;
 s=public.profile_image_source(NEW.profile_id,NEW.state,NEW.selection);
 FOR f IN SELECT DISTINCT(x#>>'{file,fileId}')::uuid FROM jsonb_array_elements(s->'images') x ORDER BY 1 LOOP PERFORM id FROM public.file_records WHERE academy_id=NEW.academy_id AND id=f FOR SHARE;END LOOP;
 FOR f IN SELECT DISTINCT(x#>>'{file,routeId}')::uuid FROM jsonb_array_elements(s->'images') x ORDER BY 1 LOOP PERFORM id FROM public.file_storage_routes WHERE academy_id=NEW.academy_id AND id=f FOR SHARE;END LOOP;
 s=public.profile_image_source(NEW.profile_id,NEW.state,NEW.selection);SELECT * INTO q FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s IS NULL OR NEW.source IS DISTINCT FROM s OR NEW.version<>coalesce(v,0)+1 OR q.id IS NULL OR q.status<>'pending' OR q.action<>'profile-images.publish' OR q.target_id IS DISTINCT FROM NEW.profile_id OR q.target_version<>NEW.version-1 OR q.privacy_capability IS DISTINCT FROM 'profile-images.view' OR q.scope IS DISTINCT FROM s#>'{profile,owner,scope}'
 OR q.review_context IS DISTINCT FROM jsonb_build_object('before',prior,'source',s) OR q.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'state',NEW.state,'selection',NEW.selection,'reason',NEW.reason) OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'PROFILE_IMAGE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF s#>>'{profile,owner,kind}'='person' AND(s#>>'{profile,owner,id}'=NEW.changed_by::text OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=(s#>>'{profile,owner,id}')::uuid AND guardian_id=NEW.changed_by)) AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'PROFILE_IMAGE_BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER profile_image_guard BEFORE INSERT OR UPDATE OR DELETE ON public.profile_image_releases FOR EACH ROW EXECUTE FUNCTION public.guard_profile_image_release();
CREATE TRIGGER profile_image_write BEFORE INSERT ON public.profile_image_releases FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write();
CREATE CONSTRAINT TRIGGER profile_image_reviewed AFTER INSERT ON public.profile_image_releases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.profile_image_release_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events e ON e.academy_id=a.academy_id AND e.entity_id=a.entity_id AND e.request_id=a.request_id AND e.event_type=a.action AND e.created_at=transaction_timestamp() WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.profile_id AND a.actor_id=NEW.changed_by AND a.actor_kind='human' AND a.action='profile-images.publish' AND a.created_at=transaction_timestamp() AND a.hub_id IS NOT DISTINCT FROM(NEW.source#>>'{profile,owner,hubId}')::uuid AND a.changes=jsonb_build_object('version',NEW.version,'state',NEW.state,'imageCount',jsonb_array_length(NEW.selection),'approvalId',NEW.approval_id,'severity','critical','privateContentRedacted',true)) THEN RAISE EXCEPTION 'PROFILE_IMAGE_AUDIT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER profile_image_complete AFTER INSERT ON public.profile_image_releases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.profile_image_release_complete();
CREATE FUNCTION public.profile_image_effect_required() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE q record;event uuid;BEGIN
 IF NEW.action<>'profile-images.publish' THEN RETURN NULL;END IF;SELECT * INTO q FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.id;
 IF q.status='applied' AND NOT EXISTS(SELECT 1 FROM public.profile_image_releases r WHERE r.academy_id=q.academy_id AND r.profile_id=q.target_id AND r.approval_id=q.id AND r.version=q.target_version+1 AND r.changed_by=q.reviewer_id) THEN RAISE EXCEPTION 'PROFILE_IMAGE_EFFECT_REQUIRED' USING ERRCODE='55000';END IF;
 SELECT e.event_id INTO event FROM public.automation_event_sources e JOIN public.audit_events a ON a.academy_id=e.academy_id AND a.id=e.audit_id WHERE e.academy_id=q.academy_id AND e.approval_id=q.id AND e.source_kind='approval' AND e.source_version=q.version AND e.event_type='approval.'||CASE WHEN q.status='pending' THEN 'requested' ELSE q.status END AND e.projection->>'severity'='critical' AND e.origin_transaction=pg_current_xact_id() AND a.action=e.event_type AND a.entity_id=q.id AND a.created_at=transaction_timestamp();
 IF event IS NULL OR EXISTS(SELECT 1 FROM(SELECT c.person_id FROM public.supervisor_chain(q.requester_id) c UNION SELECT q.requester_id WHERE q.status<>'pending' UNION SELECT master_person_id FROM public.academies WHERE id=q.academy_id) audience JOIN public.people p ON p.academy_id=q.academy_id AND p.id=audience.person_id AND p.kind='human' AND p.status='active' AND p.auth_user_id IS NOT NULL WHERE NOT EXISTS(SELECT 1 FROM public.portal_notifications n WHERE n.academy_id=q.academy_id AND n.event_id=event AND n.person_id=p.id AND n.origin='mandatory')) THEN RAISE EXCEPTION 'PROFILE_IMAGE_NOTICE_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER profile_image_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.profile_image_effect_required();
CREATE FUNCTION public.profile_image_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE s jsonb;prior jsonb;x jsonb;o jsonb;cap text;f record;a record;BEGIN
 s=public.profile_image_source(NEW.target_id,NEW.payload->>'state',NEW.payload->'selection');
 IF s IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;o=s#>'{profile,owner}';
 FOREACH cap IN ARRAY ARRAY['profiles.view','profile-images.view'] LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',o->'scope'));END LOOP;
 IF o->>'kind'='person' THEN cap=CASE WHEN EXISTS(SELECT 1 FROM public.student_profiles WHERE academy_id=NEW.academy_id AND person_id=(o->>'id')::uuid) THEN 'student-profiles.view' ELSE 'worker-profiles.view' END;NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability',cap,'scope',o->'scope'));END IF;
 SELECT r.source INTO prior FROM public.profile_image_releases r WHERE r.academy_id=NEW.academy_id AND r.profile_id=NEW.target_id ORDER BY r.version DESC LIMIT 1;
 FOR x IN SELECT * FROM jsonb_array_elements((s->'images')||coalesce(prior->'images','[]'::jsonb)) LOOP
  SELECT id,person_id,effective_hub_id INTO f FROM public.file_catalogue WHERE academy_id=NEW.academy_id AND id=(x#>>'{file,fileId}')::uuid;
  IF f.id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;
  ELSIF f.person_id IS NOT NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','files.view','personId',f.person_id));
  ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','files.view','scope',CASE WHEN f.effective_hub_id IS NULL THEN '{"all":true,"hubs":[]}'::jsonb ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(f.effective_hub_id)) END));END IF;
  IF x#>>'{file,domain}'='student_private' THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','students.view','personId',o->>'id'));END IF;
  IF x#>>'{choice,kind}'='achievement' THEN SELECT student_id,hub_id,class_id INTO a FROM public.achievement_awards WHERE academy_id=NEW.academy_id AND id=(x#>>'{choice,awardId}')::uuid;
   IF a.student_id IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','achievements.view','scope',public.achievement_award_scope(a.student_id,a.hub_id,a.class_id)));END IF;
  END IF;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER zz_profile_image_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='profile-images.publish') EXECUTE FUNCTION public.profile_image_privacy();
REVOKE ALL ON FUNCTION public.profile_image_selection_valid(jsonb),public.profile_image_source(uuid,text,jsonb),public.guard_profile_image_release(),public.profile_image_release_complete(),public.profile_image_effect_required() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.profile_image_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.profile_image_selection_valid(jsonb),public.profile_image_source(uuid,text,jsonb) TO kavosh_runtime;
GRANT CREATE ON SCHEMA public TO kavosh_event_policy;
GRANT SELECT(academy_id,profile_id,version,changed_by,approval_id) ON public.profile_image_releases TO kavosh_event_policy;
ALTER FUNCTION public.profile_image_release_complete() OWNER TO kavosh_event_policy;ALTER FUNCTION public.profile_image_effect_required() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy;
DO $$ DECLARE d text;u text;BEGIN d=pg_get_functiondef('public.capture_automation_event()'::regprocedure);u=replace(d,$q$p.action IN('access.replace','supervisor.set'$q$,$r$p.action IN('access.replace','supervisor.set','profile-images.publish'$r$);IF u=d THEN RAISE EXCEPTION 'PROFILE_IMAGE_ALERT_SOURCE_CHANGED';END IF;EXECUTE u;END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 414 $$;

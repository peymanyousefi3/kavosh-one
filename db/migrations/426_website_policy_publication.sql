-- Reviewed website notices are separate from signed enrollment agreements.
-- Draft edits never silently replace or remove an already published edition.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('website-policies.view','View school website-policy drafts and history','Administration',true,'{}'),
 ('website-policies.edit','Request school website-policy draft changes','Administration',true,'{}'),
 ('website-policies.publish','Request publication or withdrawal of an exact website-policy edition','Administration',true,'{}');
DO $$ DECLARE body text;needle text:='p.action LIKE ''storage.%''';BEGIN
 body=pg_get_functiondef('public.capture_automation_event()'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'WEBSITE_POLICY_ALERT_CLASSIFIER_CHANGED';END IF;
 EXECUTE replace(body,needle,needle||' OR p.action LIKE ''website-policy.%''');
END $$;
CREATE TABLE public.website_policies(
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,code text COLLATE "C" NOT NULL CHECK(code~'^[a-z][a-z0-9-]{0,63}$'),
 kind text NOT NULL CHECK(kind IN('privacy_notice','terms_of_service','cookie_notice','accessibility_statement','acceptable_use','cancellation_refund','copyright_ip','security_contact','subprocessors','data_processing','retention_schedule','incident_response')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),publication_version integer NOT NULL DEFAULT 0 CHECK(publication_version>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),UNIQUE(academy_id,code)
);
CREATE TABLE public.website_policy_revisions(
 academy_id uuid NOT NULL,policy_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),content jsonb NOT NULL,
 content_sha256 text NOT NULL CHECK(content_sha256~'^[a-f0-9]{64}$'),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,policy_id,version),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,policy_id) REFERENCES public.website_policies(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK(octet_length(content::text)<=262144)
);
CREATE TABLE public.website_policy_publications(
 academy_id uuid NOT NULL,policy_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),document_version integer NOT NULL CHECK(document_version>0),
 audience text NOT NULL CHECK(audience IN('public','internal','unpublished')),review_reference text NOT NULL CHECK(length(btrim(review_reference)) BETWEEN 1 AND 2000),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,policy_id,version),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,policy_id,document_version) REFERENCES public.website_policy_revisions(academy_id,policy_id,version),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['website_policies','website_policy_revisions','website_policy_publications'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 -- These daemons inherit ordinary runtime grants for their existing work,but
 -- have no reason to read or mutate private website-policy drafts.
 EXECUTE format('CREATE POLICY website_policy_no_unrelated_worker ON public.%I AS RESTRICTIVE TO kavosh_runtime USING(NOT pg_has_role(current_user,''kavosh_automation_worker'',''member'') AND NOT pg_has_role(current_user,''kavosh_message_worker'',''member'')) WITH CHECK(NOT pg_has_role(current_user,''kavosh_automation_worker'',''member'') AND NOT pg_has_role(current_user,''kavosh_message_worker'',''member''))',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate()',t);
END LOOP;END $$;
GRANT SELECT ON public.website_policies,public.website_policy_revisions,public.website_policy_publications TO kavosh_runtime;
GRANT INSERT(academy_id,id,code,kind),UPDATE(version,publication_version) ON public.website_policies TO kavosh_runtime;
GRANT INSERT(academy_id,policy_id,version,content,changed_by,approval_id,reason) ON public.website_policy_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,policy_id,version,document_version,audience,review_reference,changed_by,approval_id,reason) ON public.website_policy_publications TO kavosh_runtime;
CREATE FUNCTION public.website_policy_content_valid(c jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE k text;v jsonb;BEGIN
 IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR NOT(c?'en') OR c-ARRAY['en','fr','zh-CN']<>'{}'::jsonb OR octet_length(c::text)>262144 THEN RETURN false;END IF;
 FOR k,v IN SELECT key,value FROM jsonb_each(c) LOOP
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v?&ARRAY['title','body']) OR v-ARRAY['title','body']<>'{}'::jsonb OR jsonb_typeof(v->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'body') IS DISTINCT FROM 'string'
   OR length(btrim(v->>'title')) NOT BETWEEN 1 AND 200 OR length(btrim(v->>'body')) NOT BETWEEN 1 AND 20000 OR(v->>'body')!~'[^[:space:]]' OR(v->>'title')~U&'[\0001-\001F\007F-\009F]' OR(v->>'body')~U&'[\0001-\0008\000B\000C\000E-\001F\007F-\009F]' THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
ALTER TABLE public.website_policy_revisions ADD CHECK(public.website_policy_content_valid(content));
CREATE FUNCTION public.website_policy_basis(p_policy uuid,p_version integer,p_publication integer,p_selected integer DEFAULT 0) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('document',CASE WHEN p_version=0 THEN 'null'::jsonb ELSE(SELECT jsonb_build_object('id',h.id,'code',h.code,'kind',h.kind,'version',r.version,'content',r.content,'sha256',r.content_sha256) FROM public.website_policies h JOIN public.website_policy_revisions r ON r.academy_id=h.academy_id AND r.policy_id=h.id AND r.version=p_version WHERE h.id=p_policy AND h.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) END,
 'publication',(SELECT to_jsonb(p) FROM public.website_policy_publications p WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.policy_id=p_policy AND p.version=p_publication),
 'selected',(SELECT jsonb_build_object('version',r.version,'sha256',r.content_sha256,'content',r.content) FROM public.website_policy_revisions r WHERE r.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND r.policy_id=p_policy AND r.version=p_selected))
$$;
CREATE FUNCTION public.website_policy_head_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='INSERT' THEN IF NEW.version<>1 OR NEW.publication_version<>0 THEN RAISE EXCEPTION 'WEBSITE_POLICY_INITIAL_VERSION_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE IF ROW(NEW.academy_id,NEW.id,NEW.code,NEW.kind,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.code,OLD.kind,OLD.created_at) OR NOT((NEW.version=OLD.version+1 AND NEW.publication_version=OLD.publication_version) OR(NEW.version=OLD.version AND NEW.publication_version=OLD.publication_version+1)) THEN RAISE EXCEPTION 'WEBSITE_POLICY_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER website_policy_head_guard BEFORE INSERT OR UPDATE ON public.website_policies FOR EACH ROW EXECUTE FUNCTION public.website_policy_head_guard();
CREATE FUNCTION public.website_policy_record_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;expected jsonb;selected record;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'WEBSITE_POLICY_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.website_policies WHERE academy_id=NEW.academy_id AND id=NEW.policy_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF h.id IS NULL OR p.id IS NULL OR p.status IS DISTINCT FROM 'pending' OR p.target_id IS DISTINCT FROM NEW.policy_id OR p.privacy_capability IS DISTINCT FROM 'website-policies.view' OR p.scope IS DISTINCT FROM '{"all":true,"hubs":[]}'::jsonb OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'WEBSITE_POLICY_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='website_policy_revisions' THEN
  NEW.content_sha256=encode(sha256(convert_to(NEW.content::text,'UTF8')),'hex');
  expected=public.website_policy_basis(NEW.policy_id,NEW.version-1,h.publication_version);
  IF h.version<>NEW.version OR p.review_context IS DISTINCT FROM expected OR p.payload->'content' IS DISTINCT FROM NEW.content OR NOT public.website_policy_content_valid(NEW.content) OR p.target_version<>NEW.version-1 THEN RAISE EXCEPTION 'WEBSITE_POLICY_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
  IF NEW.version=1 THEN IF p.action<>'website-policy.create' OR p.payload->>'code' IS DISTINCT FROM h.code OR p.payload->>'kind' IS DISTINCT FROM h.kind THEN RAISE EXCEPTION 'WEBSITE_POLICY_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
  ELSE IF p.action<>'website-policy.change' OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM NEW.version-1 THEN RAISE EXCEPTION 'WEBSITE_POLICY_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;END IF;
 ELSE
  SELECT * INTO selected FROM public.website_policy_revisions WHERE academy_id=NEW.academy_id AND policy_id=NEW.policy_id AND version=NEW.document_version;
  expected=public.website_policy_basis(NEW.policy_id,h.version,NEW.version-1,NEW.document_version);
  IF h.publication_version<>NEW.version OR selected.version IS NULL OR p.review_context IS DISTINCT FROM expected OR p.action<>'website-policy.publish' OR p.target_version<>NEW.version-1 OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM NEW.version-1 OR(p.payload->>'documentVersion')::integer IS DISTINCT FROM NEW.document_version OR p.payload->>'documentSha256' IS DISTINCT FROM selected.content_sha256 OR p.payload->>'audience' IS DISTINCT FROM NEW.audience OR p.payload->>'reviewReference' IS DISTINCT FROM NEW.review_reference OR(h.kind='incident_response' AND NEW.audience='public') THEN RAISE EXCEPTION 'WEBSITE_POLICY_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
  IF NEW.audience='unpublished' AND NOT EXISTS(SELECT 1 FROM public.website_policy_publications previous WHERE previous.academy_id=NEW.academy_id AND previous.policy_id=NEW.policy_id AND previous.version=NEW.version-1 AND previous.audience<>'unpublished' AND previous.document_version=NEW.document_version) THEN RAISE EXCEPTION 'WEBSITE_POLICY_PUBLICATION_CHANGED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER website_policy_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.website_policy_revisions FOR EACH ROW EXECUTE FUNCTION public.website_policy_record_guard();
CREATE TRIGGER website_policy_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON public.website_policy_publications FOR EACH ROW EXECUTE FUNCTION public.website_policy_record_guard();
CREATE FUNCTION public.verify_website_policy_effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE target uuid;h record;p record;r record;action_name text;BEGIN
 IF TG_TABLE_NAME='approval_requests' THEN IF NEW.status<>'applied' OR NEW.action NOT IN('website-policy.create','website-policy.change','website-policy.publish') THEN RETURN NULL;END IF;target=NEW.target_id;action_name=NEW.action;
 ELSE target=NEW.id;action_name=CASE WHEN TG_OP='INSERT' THEN 'website-policy.create' WHEN NEW.version<>OLD.version THEN 'website-policy.change' ELSE 'website-policy.publish' END;END IF;
 SELECT academy_id,id,version,publication_version INTO h FROM public.website_policies WHERE academy_id=NEW.academy_id AND id=target;
 IF action_name='website-policy.publish' THEN SELECT approval_id,changed_by INTO r FROM public.website_policy_publications WHERE academy_id=h.academy_id AND policy_id=h.id AND version=h.publication_version;
 ELSE SELECT approval_id,changed_by INTO r FROM public.website_policy_revisions WHERE academy_id=h.academy_id AND policy_id=h.id AND version=h.version;END IF;
 SELECT id,status,action,reviewer_id INTO p FROM public.approval_requests WHERE academy_id=h.academy_id AND id=r.approval_id;
 IF h.id IS NULL OR p.id IS NULL OR p.status<>'applied' OR p.action IS DISTINCT FROM action_name OR p.reviewer_id IS DISTINCT FROM r.changed_by OR(TG_TABLE_NAME='approval_requests' AND NEW.id IS DISTINCT FROM p.id) OR NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.automation_event_sources e ON e.academy_id=a.academy_id AND e.audit_id=a.id AND e.source_kind='audit' AND e.event_type=a.action JOIN public.outbox_events o ON o.academy_id=e.academy_id AND o.id=e.event_id AND o.request_id=a.request_id AND o.event_type=a.action AND o.entity_id=a.entity_id WHERE a.academy_id=h.academy_id AND a.action=action_name AND a.entity_id=h.id AND a.actor_id=r.changed_by AND a.changes->>'approvalId'=p.id::text) THEN RAISE EXCEPTION 'WEBSITE_POLICY_EFFECTS_MISSING' USING ERRCODE='XX000';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER website_policy_complete AFTER INSERT OR UPDATE ON public.website_policies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.verify_website_policy_effect();
CREATE CONSTRAINT TRIGGER website_policy_approval_complete AFTER UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.verify_website_policy_effect();
-- Anonymous role has no table rights. Only the exact reviewed public edition
-- is projected;draft text,private review notes and actor identities stay private.
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['website_policies','website_policy_revisions','website_policy_publications'] LOOP
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_public_profile_policy',t);
 EXECUTE format('CREATE POLICY website_policy_public_read ON public.%I FOR SELECT TO kavosh_public_profile_policy USING(true)',t);
END LOOP;END $$;
CREATE FUNCTION public.website_policy_public_budget(p_budget text) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE used integer;at_time timestamptz:=clock_timestamp();BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'PUBLIC_POLICY_READ_COMMITTED_REQUIRED' USING ERRCODE='25000';END IF;
 IF p_budget IS NULL OR p_budget!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_PUBLIC_POLICY_INPUT' USING ERRCODE='22023';END IF;
 INSERT INTO public.profile_public_rate_windows AS r(key,started_at,used) VALUES(p_budget,date_trunc('minute',at_time),1) ON CONFLICT(key) DO UPDATE SET started_at=greatest(r.started_at,excluded.started_at),used=CASE WHEN r.started_at>=excluded.started_at THEN least(r.used+1,1000000) ELSE 1 END RETURNING r.used INTO used;
 IF used IS NULL THEN RAISE EXCEPTION 'PUBLIC_POLICY_BUDGET_MISSING' USING ERRCODE='XX000';END IF;
 DELETE FROM public.profile_public_rate_windows WHERE key IN(SELECT key FROM public.profile_public_rate_windows WHERE key<>p_budget AND started_at<at_time-interval '24 hours' ORDER BY started_at,key LIMIT 25 FOR UPDATE SKIP LOCKED);
 RETURN used>120;
END $$;
CREATE FUNCTION public.read_published_website_policy(p_academy uuid,p_code text,p_locale text,p_budget text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE data jsonb;BEGIN
 IF p_academy IS NULL OR p_code IS NULL OR p_code!~'^[a-z][a-z0-9-]{0,63}$' OR p_locale IS NULL OR p_locale NOT IN('en','fr','zh-CN') THEN RAISE EXCEPTION 'INVALID_PUBLIC_POLICY_INPUT' USING ERRCODE='22023';END IF;
 IF public.website_policy_public_budget(p_budget) THEN RETURN jsonb_build_object('limited',true);END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_academy::text,310));PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_academy::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_academy::text,9));
 SELECT jsonb_build_object('academyId',h.academy_id,'code',h.code,'kind',h.kind,'documentVersion',r.version,'publicationVersion',p.version,'contentSha256',r.content_sha256,'publishedAt',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'locale',CASE WHEN r.content?p_locale THEN p_locale ELSE 'en' END,'title',coalesce(r.content->p_locale,r.content->'en')->>'title','body',coalesce(r.content->p_locale,r.content->'en')->>'body','contentFormat','plain_text','legalValidityCertified',false) INTO data
 FROM public.website_policies h JOIN public.website_policy_publications p ON p.academy_id=h.academy_id AND p.policy_id=h.id AND p.version=h.publication_version JOIN public.website_policy_revisions r ON r.academy_id=p.academy_id AND r.policy_id=p.policy_id AND r.version=p.document_version JOIN public.academies a ON a.id=h.academy_id
 WHERE h.academy_id=p_academy AND h.code=p_code AND p.audience='public' AND h.kind<>'incident_response' AND a.status IN('active','read_only');
 RETURN jsonb_build_object('limited',false,'data',data);
END $$;
CREATE FUNCTION public.list_published_website_policies(p_academy uuid,p_locale text,p_after text,p_limit integer,p_budget text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE data jsonb;next_code text;BEGIN
 IF p_academy IS NULL OR p_locale IS NULL OR p_locale NOT IN('en','fr','zh-CN') OR(p_after IS NOT NULL AND p_after!~'^[a-z][a-z0-9-]{0,63}$') OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'INVALID_PUBLIC_POLICY_INPUT' USING ERRCODE='22023';END IF;
 IF public.website_policy_public_budget(p_budget) THEN RETURN jsonb_build_object('limited',true);END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_academy::text,310));PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_academy::text,8));PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_academy::text,9));
 SELECT coalesce(jsonb_agg(to_jsonb(listed) ORDER BY listed.code COLLATE "C"),'[]'::jsonb) INTO data FROM(
  SELECT h.code,h.kind,r.version AS "documentVersion",p.version AS "publicationVersion",r.content_sha256 AS "contentSha256",CASE WHEN r.content?p_locale THEN p_locale ELSE 'en' END locale,coalesce(r.content->p_locale,r.content->'en')->>'title' title
  FROM public.website_policies h JOIN public.website_policy_publications p ON p.academy_id=h.academy_id AND p.policy_id=h.id AND p.version=h.publication_version JOIN public.website_policy_revisions r ON r.academy_id=p.academy_id AND r.policy_id=p.policy_id AND r.version=p.document_version JOIN public.academies a ON a.id=h.academy_id
  WHERE h.academy_id=p_academy AND(p_after IS NULL OR h.code>p_after COLLATE "C") AND p.audience='public' AND h.kind<>'incident_response' AND a.status IN('active','read_only') ORDER BY h.code LIMIT p_limit+1
 ) listed;
 IF jsonb_array_length(data)>p_limit THEN next_code=data->(p_limit-1)->>'code';data=data-p_limit;END IF;
 RETURN jsonb_build_object('limited',false,'academyId',p_academy,'data',data,'nextCode',next_code);
END $$;
REVOKE ALL ON FUNCTION public.website_policy_content_valid(jsonb),public.website_policy_basis(uuid,integer,integer,integer),public.website_policy_head_guard(),public.website_policy_record_guard(),public.verify_website_policy_effect(),public.read_published_website_policy(uuid,text,text,text),public.website_policy_public_budget(text),public.list_published_website_policies(uuid,text,text,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.website_policy_content_valid(jsonb),public.website_policy_basis(uuid,integer,integer,integer) TO kavosh_runtime;
-- Commit-time evidence checks need metadata reads,not new web-role access to
-- the outbox or private legal text. Reuse the isolated native event authority.
GRANT SELECT(academy_id,id,version,publication_version) ON public.website_policies TO kavosh_event_policy;
GRANT SELECT(academy_id,policy_id,version,approval_id,changed_by) ON public.website_policy_revisions,public.website_policy_publications TO kavosh_event_policy;
GRANT SELECT(academy_id,request_id,event_type,entity_id) ON public.outbox_events TO kavosh_event_policy;
GRANT CREATE ON SCHEMA public TO kavosh_event_policy;
ALTER FUNCTION public.verify_website_policy_effect() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy;
GRANT CREATE ON SCHEMA public TO kavosh_public_profile_policy;
ALTER FUNCTION public.read_published_website_policy(uuid,text,text,text) OWNER TO kavosh_public_profile_policy;
ALTER FUNCTION public.list_published_website_policies(uuid,text,text,integer,text) OWNER TO kavosh_public_profile_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_public_profile_policy;
GRANT EXECUTE ON FUNCTION public.website_policy_public_budget(text) TO kavosh_public_profile_policy;
GRANT EXECUTE ON FUNCTION public.read_published_website_policy(uuid,text,text,text),public.list_published_website_policies(uuid,text,text,integer,text) TO kavosh_public_profile_service;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 426 $$;

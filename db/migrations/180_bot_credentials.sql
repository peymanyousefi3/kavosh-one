-- Approved metadata lives in tenant-scoped tables. Actual credential hashes
-- remain in auth_private;the web role never gains schema or table access.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kavosh_bot_policy') THEN CREATE ROLE kavosh_bot_policy NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;END $$;
GRANT kavosh_bot_policy TO CURRENT_USER;
GRANT USAGE,CREATE ON SCHEMA public TO kavosh_bot_policy;GRANT USAGE ON SCHEMA auth_private TO kavosh_bot_policy;
GRANT SELECT,INSERT ON auth_private.credentials,auth_private.credential_hubs TO kavosh_bot_policy;
GRANT UPDATE(revoked_at) ON auth_private.credentials TO kavosh_bot_policy;
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('bot-credentials.view','View permitted bot API key metadata','Administration',true,ARRAY['hub','person','country','region','city']),
 ('bot-credentials.edit','Request reviewed bot API key permissions and expiry','Administration',true,ARRAY['hub','person','country','region','city']),
 ('bot-credentials.issue','Retrieve a permitted private bot API key as a verified human','Administration',true,ARRAY['hub','person','country','region','city']),
 ('bot-credentials.revoke','Immediately revoke a permitted bot API key as a verified human','Administration',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.bot_credential_preparations(
 academy_id uuid NOT NULL,id uuid NOT NULL,person_id uuid NOT NULL,hub_id uuid,configuration jsonb NOT NULL CHECK(octet_length(configuration::text)<=131072),source_basis jsonb NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE INDEX bot_credential_preparations_person ON public.bot_credential_preparations(academy_id,person_id,id);
CREATE TABLE public.bot_credential_issuance_receipts(
 academy_id uuid NOT NULL,preparation_id uuid NOT NULL,credential_id uuid NOT NULL CHECK(credential_id=preparation_id),person_id uuid NOT NULL,replaces_credential_id uuid,issued_by uuid NOT NULL,issued_at timestamptz NOT NULL,
 PRIMARY KEY(academy_id,preparation_id),UNIQUE(academy_id,replaces_credential_id),FOREIGN KEY(academy_id,preparation_id) REFERENCES public.bot_credential_preparations(academy_id,id),FOREIGN KEY(academy_id,credential_id) REFERENCES auth_private.credentials(academy_id,id),FOREIGN KEY(academy_id,replaces_credential_id) REFERENCES auth_private.credentials(academy_id,id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,issued_by) REFERENCES public.people(academy_id,id)
);
CREATE TABLE public.bot_credential_revocations(
 academy_id uuid NOT NULL,credential_id uuid NOT NULL,person_id uuid NOT NULL,revoked_by uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),revoked_at timestamptz NOT NULL,
 PRIMARY KEY(academy_id,credential_id),FOREIGN KEY(academy_id,credential_id) REFERENCES auth_private.credentials(academy_id,id),FOREIGN KEY(academy_id,person_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,revoked_by) REFERENCES public.people(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['bot_credential_preparations','bot_credential_issuance_receipts','bot_credential_revocations'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime,kavosh_bot_policy',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,person_id,hub_id,configuration,source_basis,changed_by,approval_id) ON public.bot_credential_preparations TO kavosh_runtime;
GRANT UPDATE(id) ON public.bot_credential_preparations TO kavosh_bot_policy;
GRANT INSERT ON public.bot_credential_issuance_receipts,public.bot_credential_revocations TO kavosh_bot_policy;
CREATE FUNCTION public.bot_credential_metadata(who uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',c.id,'botId',c.person_id,'capabilities',c.capabilities,'allHubs',c.all_hubs,'hubIds',ARRAY(SELECT h.hub_id FROM auth_private.credential_hubs h WHERE h.academy_id=c.academy_id AND h.credential_id=c.id ORDER BY h.hub_id),'expiresAt',c.expires_at,'revokedAt',c.revoked_at,'createdAt',c.created_at)
 FROM auth_private.credentials c WHERE c.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND c.id=who
$$;
CREATE FUNCTION public.bot_credential_basis(who uuid,replaces uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('schoolStatus',a.status,'bot',public.human_invitation_basis(p.id),'botCutoff',p.credentials_valid_after,'owner',public.person_status_basis(owner.id),'ownerCutoff',owner.credentials_valid_after,'ownerVerified',public.report_comment_human_verified(owner.id),'replacement',public.bot_credential_metadata(replaces)-'revokedAt')
 FROM public.people p JOIN public.academies a ON a.id=p.academy_id JOIN public.people owner ON owner.academy_id=p.academy_id AND owner.id=coalesce(p.supervisor_person_id,a.master_person_id)
 WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=who AND p.kind='bot' AND(replaces IS NULL OR public.bot_credential_metadata(replaces)->>'botId'=who::text)
$$;
CREATE FUNCTION public.bot_credential_configuration_valid(c jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(c)<>'object' OR NOT(c?&ARRAY['name','expectedBotVersion','capabilities','allHubs','hubIds','expiresAt','replacesCredentialId','reason']) OR c-ARRAY['name','expectedBotVersion','capabilities','allHubs','hubIds','expiresAt','replacesCredentialId','reason']<>'{}'::jsonb OR octet_length(c::text)>131072
 OR jsonb_typeof(c->'name') IS DISTINCT FROM 'string' OR length(btrim(c->>'name')) NOT BETWEEN 1 AND 150 OR jsonb_typeof(c->'reason') IS DISTINCT FROM 'string' OR length(btrim(c->>'reason')) NOT BETWEEN 1 AND 2000 OR jsonb_typeof(c->'expectedBotVersion') IS DISTINCT FROM 'number' OR c->>'expectedBotVersion'!~'^[1-9][0-9]{0,9}$' OR(c->>'expectedBotVersion')::numeric>2147483647
 OR jsonb_typeof(c->'allHubs') IS DISTINCT FROM 'boolean' OR jsonb_typeof(c->'capabilities') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'capabilities') NOT BETWEEN 1 AND 1000 OR jsonb_typeof(c->'hubIds') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'hubIds')>1000 OR(c->'allHubs'='true'::jsonb AND c->'hubIds'<>'[]'::jsonb) OR(c->'allHubs'='false'::jsonb AND c->'hubIds'='[]'::jsonb)
 OR jsonb_typeof(c->'expiresAt') IS DISTINCT FROM 'string' OR(c->>'expiresAt')::timestamptz<=clock_timestamp() OR(c->>'expiresAt')::timestamptz>clock_timestamp()+interval '365 days'
 OR(c->'replacesCredentialId'<>'null'::jsonb AND(jsonb_typeof(c->'replacesCredentialId') IS DISTINCT FROM 'string' OR c->>'replacesCredentialId'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')) THEN RETURN false;END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'capabilities') x WHERE jsonb_typeof(x)<>'string' OR NOT EXISTS(SELECT 1 FROM public.capability_catalog WHERE name=x#>>'{}')) OR(SELECT count(DISTINCT x) FROM jsonb_array_elements(c->'capabilities') x)<>jsonb_array_length(c->'capabilities')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'hubIds') x WHERE jsonb_typeof(x)<>'string' OR x#>>'{}'!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR NOT EXISTS(SELECT 1 FROM public.hubs WHERE id=(x#>>'{}')::uuid AND active)) OR(SELECT count(DISTINCT x) FROM jsonb_array_elements(c->'hubIds') x)<>jsonb_array_length(c->'hubIds') THEN RETURN false;END IF;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.bot_credential_preparation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;b jsonb;s jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'BOT_CREDENTIAL_PREPARATION_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF public.bot_credential_configuration_valid(NEW.configuration) IS NOT TRUE THEN RAISE EXCEPTION 'BOT_CREDENTIAL_CONFIGURATION_INVALID' USING ERRCODE='23514';END IF;
 b=public.bot_credential_basis(NEW.person_id,(NEW.configuration->>'replacesCredentialId')::uuid);SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',NEW.person_id,'hubId',NEW.hub_id)));
 IF b IS NULL OR b->>'schoolStatus'<>'active' OR b#>>'{bot,person,status}'<>'active' OR b#>>'{bot,person,kind}'<>'bot' OR b->'ownerVerified' IS DISTINCT FROM 'true'::jsonb OR(b#>>'{bot,person,version}')::integer<>(NEW.configuration->>'expectedBotVersion')::integer OR(b#>>'{bot,person,hubId}')::uuid IS DISTINCT FROM NEW.hub_id
 OR a.id IS NULL OR a.action IS DISTINCT FROM 'bot-credential.prepare' OR a.target_id IS DISTINCT FROM NEW.id OR a.target_version<>0 OR a.status<>'pending' OR a.privacy_capability IS DISTINCT FROM 'bot-credentials.view' OR a.scope IS DISTINCT FROM s OR a.payload IS DISTINCT FROM jsonb_build_object('botId',NEW.person_id,'configuration',NEW.configuration) OR a.review_context IS DISTINCT FROM b OR NEW.source_basis IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'BOT_CREDENTIAL_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER bot_credential_preparation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bot_credential_preparations FOR EACH ROW EXECUTE FUNCTION public.bot_credential_preparation_guard();
CREATE CONSTRAINT TRIGGER bot_credential_preparation_reviewed AFTER INSERT ON public.bot_credential_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.bot_credential_preparation_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.id AND actor_id=NEW.changed_by AND action='bot-credential.prepare' AND created_at=transaction_timestamp() AND changes->>'approvalId'=NEW.approval_id::text AND changes->>'botId'=NEW.person_id::text AND changes->'severity'='"critical"'::jsonb AND changes->'credentialIssued'='false'::jsonb) THEN RAISE EXCEPTION 'BOT_CREDENTIAL_PREPARATION_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bot_credential_preparation_complete AFTER INSERT ON public.bot_credential_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bot_credential_preparation_complete();
CREATE FUNCTION public.bot_credential_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='bot-credential.prepare' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.bot_credential_preparations WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'BOT_CREDENTIAL_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bot_credential_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bot_credential_effect_required();
CREATE FUNCTION public.bot_credential_receipt_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' OR current_user<>'kavosh_bot_policy' THEN RAISE EXCEPTION 'BOT_CREDENTIAL_RECEIPT_PRIVATE_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER bot_credential_issue_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bot_credential_issuance_receipts FOR EACH ROW EXECUTE FUNCTION public.bot_credential_receipt_guard();
CREATE TRIGGER bot_credential_revoke_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bot_credential_revocations FOR EACH ROW EXECUTE FUNCTION public.bot_credential_receipt_guard();
CREATE FUNCTION public.bot_credential_receipt_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE actor uuid;entity uuid;event text;BEGIN
 IF TG_TABLE_NAME='bot_credential_issuance_receipts' THEN actor=NEW.issued_by;entity=NEW.preparation_id;event='bot-credential.token.revealed';ELSE actor=NEW.revoked_by;entity=NEW.credential_id;event='bot-credential.revoked';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=entity AND actor_id=actor AND action=event AND created_at=transaction_timestamp() AND changes->>'botId'=NEW.person_id::text AND changes->'severity'='"critical"'::jsonb) THEN RAISE EXCEPTION 'BOT_CREDENTIAL_RECEIPT_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bot_credential_issue_audit AFTER INSERT ON public.bot_credential_issuance_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bot_credential_receipt_audit();
CREATE CONSTRAINT TRIGGER bot_credential_revoke_audit AFTER INSERT ON public.bot_credential_revocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bot_credential_receipt_audit();
CREATE FUNCTION public.bot_credential_human_actor(actor uuid,session uuid,bot uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE u uuid;BEGIN
 SELECT auth_user_id INTO u FROM public.people WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=actor AND kind='human' AND status='active';
 IF u IS NULL OR NOT public.lock_human(session,u) OR NOT(EXISTS(SELECT 1 FROM public.academies WHERE master_person_id=actor) OR public.is_supervisor(actor,bot)) THEN RAISE EXCEPTION 'BOT_CREDENTIAL_HUMAN_SUPERVISOR_REQUIRED' USING ERRCODE='42501';END IF;
END $$;
CREATE FUNCTION public.issue_bot_credential(preparation uuid,actor uuid,session uuid,token_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;p record;c record;r record;at timestamptz:=clock_timestamp();replaces uuid;BEGIN
 IF tenant IS NULL OR token_hash IS NULL OR token_hash!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_BOT_CREDENTIAL_HASH' USING ERRCODE='22023';END IF;PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text,8));
 SELECT * INTO p FROM public.bot_credential_preparations WHERE academy_id=tenant AND id=preparation FOR SHARE;IF p.id IS NULL THEN RAISE EXCEPTION 'BOT_CREDENTIAL_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 PERFORM public.bot_credential_human_actor(actor,session,p.person_id);IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=tenant AND status='active') OR p.source_basis IS DISTINCT FROM public.bot_credential_basis(p.person_id,(p.configuration->>'replacesCredentialId')::uuid) THEN RAISE EXCEPTION 'BOT_CREDENTIAL_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF(p.configuration->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'BOT_CREDENTIAL_EXPIRED' USING ERRCODE='23514';END IF;replaces=(p.configuration->>'replacesCredentialId')::uuid;
 SELECT * INTO r FROM public.bot_credential_issuance_receipts WHERE academy_id=tenant AND preparation_id=preparation;
 IF FOUND THEN
  SELECT * INTO c FROM auth_private.credentials WHERE academy_id=tenant AND id=r.credential_id;
  IF c.token_hash IS DISTINCT FROM token_hash THEN RAISE EXCEPTION 'BOT_CREDENTIAL_TOKEN_KEY_CHANGED' USING ERRCODE='23514';END IF;
  IF c.revoked_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.current_bot_scope(c.id)) THEN RAISE EXCEPTION 'BOT_CREDENTIAL_REVOKED' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.approval_requests WHERE academy_id=tenant AND id=p.approval_id AND status='applied' AND reviewer_id=p.changed_by) THEN RAISE EXCEPTION 'BOT_CREDENTIAL_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
  IF replaces IS NOT NULL AND EXISTS(SELECT 1 FROM public.bot_credential_issuance_receipts WHERE academy_id=tenant AND replaces_credential_id=replaces) THEN RAISE EXCEPTION 'BOT_CREDENTIAL_ALREADY_REPLACED' USING ERRCODE='23514';END IF;
  IF replaces IS NOT NULL THEN PERFORM 1 FROM auth_private.credentials WHERE academy_id=tenant AND id=replaces AND person_id=p.person_id FOR UPDATE NOWAIT;IF NOT FOUND THEN RAISE EXCEPTION 'BOT_CREDENTIAL_SOURCE_CHANGED' USING ERRCODE='23514';END IF;END IF;
  INSERT INTO auth_private.credentials(id,academy_id,person_id,token_hash,capabilities,all_hubs,expires_at,created_at) VALUES(p.id,tenant,p.person_id,token_hash,ARRAY(SELECT jsonb_array_elements_text(p.configuration->'capabilities')),(p.configuration->>'allHubs')::boolean,(p.configuration->>'expiresAt')::timestamptz,at);
  INSERT INTO auth_private.credential_hubs(credential_id,academy_id,hub_id) SELECT p.id,tenant,x::uuid FROM jsonb_array_elements_text(p.configuration->'hubIds') x;
  IF replaces IS NOT NULL THEN UPDATE auth_private.credentials SET revoked_at=coalesce(revoked_at,at) WHERE academy_id=tenant AND id=replaces AND person_id=p.person_id;IF NOT FOUND THEN RAISE EXCEPTION 'BOT_CREDENTIAL_SOURCE_CHANGED' USING ERRCODE='23514';END IF;END IF;
  INSERT INTO public.bot_credential_issuance_receipts(academy_id,preparation_id,credential_id,person_id,replaces_credential_id,issued_by,issued_at) VALUES(tenant,p.id,p.id,p.person_id,replaces,actor,at);
  SELECT * INTO c FROM auth_private.credentials WHERE academy_id=tenant AND id=p.id;
 END IF;
 RETURN jsonb_build_object('preparationId',p.id,'credentialId',c.id,'botId',p.person_id,'expiresAt',c.expires_at,'issuedAt',c.created_at,'replacesCredentialId',replaces);
END $$;
CREATE FUNCTION public.revoke_bot_credential(bot uuid,credential uuid,actor uuid,session uuid,reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;c record;at timestamptz:=clock_timestamp();BEGIN
 IF tenant IS NULL OR length(btrim(reason)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'INVALID_BOT_CREDENTIAL_REVOCATION' USING ERRCODE='22023';END IF;PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text,8));PERFORM public.bot_credential_human_actor(actor,session,bot);
 IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=tenant AND status IN('active','read_only')) THEN RAISE EXCEPTION 'BOT_CREDENTIAL_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM auth_private.credentials WHERE academy_id=tenant AND id=credential AND person_id=bot FOR UPDATE NOWAIT;IF c.id IS NULL THEN RAISE EXCEPTION 'BOT_CREDENTIAL_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF c.revoked_at IS NULL THEN UPDATE auth_private.credentials SET revoked_at=at WHERE id=c.id;
  INSERT INTO public.bot_credential_revocations(academy_id,credential_id,person_id,revoked_by,reason,revoked_at) VALUES(tenant,c.id,bot,actor,reason,at);
 END IF;RETURN jsonb_build_object('credentialId',c.id,'botId',bot,'revoked',true,'revokedAt',coalesce(c.revoked_at,at));
END $$;
CREATE FUNCTION public.bot_credentials_directory(bot uuid,after_id uuid,page_limit integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH rows AS MATERIALIZED(SELECT c.id,c.person_id,c.expires_at,c.revoked_at,c.created_at,cardinality(c.capabilities) capability_count,c.all_hubs,(SELECT count(*)::integer FROM auth_private.credential_hubs h WHERE h.credential_id=c.id) hub_count,(SELECT x.credential_id FROM public.bot_credential_issuance_receipts x WHERE x.academy_id=c.academy_id AND x.replaces_credential_id=c.id) replaced_by FROM auth_private.credentials c WHERE c.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND c.person_id=bot AND(after_id IS NULL OR c.id>after_id) ORDER BY c.id LIMIT least(greatest(page_limit,1),100)+1)
 SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'botId',r.person_id,'expiresAt',r.expires_at,'revokedAt',r.revoked_at,'createdAt',r.created_at,'capabilityCount',r.capability_count,'allHubs',r.all_hubs,'hubCount',r.hub_count,'replacedBy',r.replaced_by) ORDER BY id) FROM(SELECT * FROM rows ORDER BY id LIMIT least(greatest(page_limit,1),100)) r),'[]'::jsonb),'nextCursor',CASE WHEN(SELECT count(*) FROM rows)>least(greatest(page_limit,1),100) THEN(SELECT id FROM rows ORDER BY id OFFSET least(greatest(page_limit,1),100)-1 LIMIT 1) ELSE NULL END)
$$;
GRANT SELECT ON public.people,public.academies,public.hubs,public.audit_events,public.approval_requests,public.capability_catalog,public.roles,public.role_permissions,public.role_assignments,public.assignment_hubs,public.assignment_classes,public.assignment_people,public.assignment_geography,public.geographic_areas,public.assignment_countries,public.assignment_regions,public.assignment_cities,public.countries,public.regions,public.cities TO kavosh_bot_policy;
GRANT EXECUTE ON FUNCTION public.human_invitation_basis(uuid),public.person_status_basis(uuid),public.report_comment_human_verified(uuid),public.lock_human(uuid,uuid),public.current_bot_scope(uuid),public.is_supervisor(uuid,uuid),public.supervisor_chain(uuid) TO kavosh_bot_policy;
ALTER FUNCTION public.bot_credential_metadata(uuid) OWNER TO kavosh_bot_policy;
ALTER FUNCTION public.issue_bot_credential(uuid,uuid,uuid,text) OWNER TO kavosh_bot_policy;
ALTER FUNCTION public.revoke_bot_credential(uuid,uuid,uuid,uuid,text) OWNER TO kavosh_bot_policy;
ALTER FUNCTION public.bot_credentials_directory(uuid,uuid,integer) OWNER TO kavosh_bot_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_bot_policy;
REVOKE ALL ON FUNCTION public.bot_credential_metadata(uuid),public.bot_credential_basis(uuid,uuid),public.bot_credential_configuration_valid(jsonb),public.bot_credential_preparation_guard(),public.bot_credential_preparation_complete(),public.bot_credential_effect_required(),public.bot_credential_receipt_guard(),public.bot_credential_receipt_audit(),public.bot_credential_human_actor(uuid,uuid,uuid),public.issue_bot_credential(uuid,uuid,uuid,text),public.revoke_bot_credential(uuid,uuid,uuid,uuid,text),public.bot_credentials_directory(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bot_credential_metadata(uuid),public.bot_credential_basis(uuid,uuid),public.bot_credential_configuration_valid(jsonb) TO kavosh_runtime,kavosh_bot_policy;
GRANT EXECUTE ON FUNCTION public.bot_credential_human_actor(uuid,uuid,uuid) TO kavosh_bot_policy;
GRANT EXECUTE ON FUNCTION public.issue_bot_credential(uuid,uuid,uuid,text),public.revoke_bot_credential(uuid,uuid,uuid,uuid,text),public.bot_credentials_directory(uuid,uuid,integer) TO kavosh_runtime;
DO $$ DECLARE b text;n text:='p.action IN(''access.replace'',''supervisor.set'',''person.status'',''bot.create'')';BEGIN
 b=pg_get_functiondef('public.capture_automation_event()'::regprocedure);IF position(n IN b)=0 THEN RAISE EXCEPTION 'BOT_CREDENTIAL_ALERT_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,'p.action IN(''access.replace'',''supervisor.set'',''person.status'',''bot.create'',''bot-credential.prepare'')');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 180 $$;

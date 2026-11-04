INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('automations.view','View private automation rules and simulations','Administration',true,ARRAY['hub','country','region','city']),
 ('automations.edit','Propose reviewed automation rules and limits','Administration',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.automation_rules(
 academy_id uuid NOT NULL,id uuid NOT NULL,hub_id uuid,code text NOT NULL CHECK(code~'^[A-Z0-9][A-Z0-9._-]{0,63}$'),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE NULLS NOT DISTINCT(academy_id,hub_id,code),FOREIGN KEY(academy_id) REFERENCES public.academies(id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id)
);
CREATE TABLE public.automation_rule_revisions(
 academy_id uuid NOT NULL,rule_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object' AND octet_length(definition::text)<=100000),
 changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,rule_id,version),FOREIGN KEY(academy_id,rule_id) REFERENCES public.automation_rules(academy_id,id),FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.automation_rules ADD CONSTRAINT automation_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.automation_rule_revisions(academy_id,rule_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX automation_rules_hub ON public.automation_rules(academy_id,hub_id,id);
CREATE TRIGGER automation_header_guard BEFORE INSERT OR UPDATE ON public.automation_rules FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.automation_instant_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR(v#>>'{}') LIKE '0000-%' OR(v#>>'{}')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?(Z|[+-](0[0-9]|1[0-5]):[0-5][0-9])$' THEN RETURN false;END IF;
 PERFORM(v#>>'{}')::timestamptz;RETURN true;
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.automation_condition_valid(root jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE n record;v jsonb;op text;val jsonb;total integer:=0;keys text[];
BEGIN
 -- Native JSONB text includes separator whitespace; the API uses a stricter
 -- 16 KiB compact-JSON budget before insertion. Both retain node/depth caps.
 IF octet_length(root::text)>32000 THEN RETURN false;END IF;
 FOR n IN WITH RECURSIVE nodes(v,depth) AS(
  SELECT root,1 UNION ALL SELECT child,nodes.depth+1 FROM nodes CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN nodes.v->>'op' IN('all','any') AND jsonb_typeof(nodes.v->'conditions')='array' THEN nodes.v->'conditions' WHEN nodes.v->>'op'='not' THEN jsonb_build_array(nodes.v->'condition') ELSE '[]'::jsonb END) child WHERE nodes.depth<=8
 ) SELECT * FROM nodes LOOP
  total=total+1;v=n.v;op=v->>'op';IF total>200 OR n.depth>8 OR jsonb_typeof(v) IS DISTINCT FROM 'object' OR op IS NULL THEN RETURN false;END IF;
  IF op IN('all','any') THEN
   IF NOT(v ?& ARRAY['op','conditions']) OR v-ARRAY['op','conditions']<>'{}'::jsonb OR jsonb_typeof(v->'conditions') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'conditions') NOT BETWEEN 1 AND 32 THEN RETURN false;END IF;
  ELSIF op='not' THEN IF NOT(v ?& ARRAY['op','condition']) OR v-ARRAY['op','condition']<>'{}'::jsonb THEN RETURN false;END IF;
  ELSE
   IF op NOT IN('eq','neq','in','not_in','exists','missing','contains','starts_with','ends_with','decimal_eq','decimal_gt','decimal_gte','decimal_lt','decimal_lte','before','after') OR jsonb_typeof(v->'field') IS DISTINCT FROM 'string' OR length(v->>'field')>200 OR v->>'field'!~'^(eventType|entityId|hubId|actorId|actorKind|severity|occurredAt|attributes([.][A-Za-z0-9_-]+){1,7})$' OR EXISTS(SELECT 1 FROM unnest(string_to_array(v->>'field','.')) f WHERE f IN('__proto__','prototype','constructor')) THEN RETURN false;END IF;
   keys=CASE WHEN op IN('exists','missing') THEN ARRAY['op','field'] ELSE ARRAY['op','field','value'] END;
   IF NOT(v ?& keys) OR v-keys<>'{}'::jsonb THEN RETURN false;END IF;val=v->'value';
   IF op IN('in','not_in') THEN
    IF jsonb_typeof(val) IS DISTINCT FROM 'array' OR jsonb_array_length(val) NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(val) x WHERE jsonb_typeof(x) NOT IN('string','number','boolean','null') OR(jsonb_typeof(x)='string' AND length(x#>>'{}')>2000)) THEN RETURN false;END IF;
   ELSIF op NOT IN('exists','missing') THEN
    IF jsonb_typeof(val) NOT IN('string','number','boolean','null') OR(jsonb_typeof(val)='string' AND length(val#>>'{}')>2000) THEN RETURN false;END IF;
    IF op LIKE 'decimal_%' AND(jsonb_typeof(val) IS DISTINCT FROM 'string' OR length(val#>>'{}')>80 OR(val#>>'{}')!~'^-?[0-9]+([.][0-9]{1,18})?$') THEN RETURN false;END IF;
    IF op IN('contains','starts_with','ends_with','before','after') AND jsonb_typeof(val) IS DISTINCT FROM 'string' THEN RETURN false;END IF;
    IF op IN('before','after') AND NOT public.automation_instant_valid(val) THEN RETURN false;END IF;
   END IF;
  END IF;
 END LOOP;RETURN total>0;
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;
CREATE FUNCTION public.automation_rule_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record;p record;d jsonb:=NEW.definition;a jsonb;e jsonb;aud jsonb;labels jsonb;k text;keys text[];disable_only boolean;
BEGIN
 SELECT * INTO r FROM public.automation_rules WHERE academy_id=NEW.academy_id AND id=NEW.rule_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 disable_only=NEW.version>1 AND d->'enabled'='false'::jsonb AND(d-'enabled')=(SELECT definition-'enabled' FROM public.automation_rule_revisions WHERE academy_id=NEW.academy_id AND rule_id=NEW.rule_id AND version=NEW.version-1);
 IF r.id IS NULL OR r.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.automation_rule_revisions WHERE academy_id=NEW.academy_id AND rule_id=NEW.rule_id) OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM(CASE WHEN NEW.version=1 THEN 'automation.rule.create' ELSE 'automation.rule.change' END) OR p.target_id IS DISTINCT FROM NEW.rule_id OR p.target_version IS DISTINCT FROM NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'automations.view' OR p.payload->'definition' IS DISTINCT FROM d OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR(NEW.version=1 AND((p.payload->>'hubId')::uuid IS DISTINCT FROM r.hub_id OR p.payload->>'code' IS DISTINCT FROM r.code)) THEN RAISE EXCEPTION 'AUTOMATION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 keys=ARRAY['name','enabled','startsAt','endsAt','trigger','condition','actions','execution'];
 IF NOT(d ?& keys) OR d-keys<>'{}'::jsonb OR jsonb_typeof(d->'name') IS DISTINCT FROM 'string' OR length(btrim(d->>'name')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(d->'enabled') IS DISTINCT FROM 'boolean' OR NOT public.automation_condition_valid(d->'condition') THEN RAISE EXCEPTION 'AUTOMATION_DEFINITION_INVALID' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['startsAt','endsAt'] LOOP IF d->k<>'null'::jsonb AND NOT public.automation_instant_valid(d->k) THEN RAISE EXCEPTION 'AUTOMATION_WINDOW_INVALID' USING ERRCODE='23514';END IF;END LOOP;
 IF(d->>'endsAt')::timestamptz<(d->>'startsAt')::timestamptz THEN RAISE EXCEPTION 'AUTOMATION_WINDOW_INVALID' USING ERRCODE='23514';END IF;
 a=d->'trigger';IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& ARRAY['kind','eventTypes']) OR a-ARRAY['kind','eventTypes']<>'{}'::jsonb OR a->>'kind' IS DISTINCT FROM 'domain_event' OR jsonb_typeof(a->'eventTypes') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'eventTypes') NOT BETWEEN 1 AND 50 OR(SELECT count(DISTINCT x) FROM jsonb_array_elements(a->'eventTypes') x)<>jsonb_array_length(a->'eventTypes') OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'eventTypes') x WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}')>160 OR((x#>>'{}')<>'*' AND(x#>>'{}')!~'^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)+([.][*])?$')) THEN RAISE EXCEPTION 'AUTOMATION_TRIGGER_INVALID' USING ERRCODE='23514';END IF;
 e=d->'execution';keys=ARRAY['mode','maxRecipientsPerEvent','maxDailyDeliveries','maxDailySms','cooldownSeconds','maxChainDepth'];
 IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR NOT(e ?& keys) OR e-keys<>'{}'::jsonb OR e->>'mode' IS NULL OR e->>'mode' NOT IN('dry_run','approval_required','automatic') THEN RAISE EXCEPTION 'AUTOMATION_LIMITS_INVALID' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['maxRecipientsPerEvent','maxDailyDeliveries','maxDailySms','cooldownSeconds','maxChainDepth'] LOOP IF jsonb_typeof(e->k) IS DISTINCT FROM 'number' OR(e->>k)::numeric<>trunc((e->>k)::numeric) OR(e->>k)::numeric<(CASE WHEN k IN('maxDailySms','cooldownSeconds') THEN 0 ELSE 1 END) OR(e->>k)::numeric>(CASE k WHEN 'maxDailyDeliveries' THEN 10000 WHEN 'cooldownSeconds' THEN 604800 WHEN 'maxChainDepth' THEN 3 ELSE 1000 END) THEN RAISE EXCEPTION 'AUTOMATION_LIMITS_INVALID' USING ERRCODE='23514';END IF;END LOOP;
 IF jsonb_typeof(d->'actions') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'actions') NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'AUTOMATION_ACTION_INVALID' USING ERRCODE='23514';END IF;
 FOR a IN SELECT * FROM jsonb_array_elements(d->'actions') LOOP
  keys=ARRAY['kind','channels','audience','severity','title','body'];IF jsonb_typeof(a) IS DISTINCT FROM 'object' OR NOT(a ?& keys) OR a-keys<>'{}'::jsonb OR a->>'kind' IS DISTINCT FROM 'notify' OR a->>'severity' IS NULL OR a->>'severity' NOT IN('inherit','normal','critical') OR jsonb_typeof(a->'channels') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'channels') NOT BETWEEN 1 AND 3 OR(SELECT count(DISTINCT x) FROM jsonb_array_elements(a->'channels') x)<>jsonb_array_length(a->'channels') OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'channels') x WHERE jsonb_typeof(x)<>'string' OR(x#>>'{}') NOT IN('portal','email','sms')) THEN RAISE EXCEPTION 'AUTOMATION_ACTION_INVALID' USING ERRCODE='23514';END IF;
  aud=a->'audience';IF jsonb_typeof(aud) IS DISTINCT FROM 'object' OR aud->>'kind' IS NULL OR aud->>'kind' NOT IN('school_master','actor_supervisors','people') THEN RAISE EXCEPTION 'AUTOMATION_AUDIENCE_INVALID' USING ERRCODE='23514';END IF;
  keys=CASE WHEN aud->>'kind'='people' THEN ARRAY['kind','personIds'] ELSE ARRAY['kind'] END;
  IF NOT(aud ?& keys) OR aud-keys<>'{}'::jsonb THEN RAISE EXCEPTION 'AUTOMATION_AUDIENCE_INVALID' USING ERRCODE='23514';END IF;
  IF aud->>'kind'='people' THEN
   IF jsonb_typeof(aud->'personIds') IS DISTINCT FROM 'array' OR jsonb_array_length(aud->'personIds') NOT BETWEEN 1 AND 100 OR(SELECT count(DISTINCT x) FROM jsonb_array_elements(aud->'personIds') x)<>jsonb_array_length(aud->'personIds') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(aud->'personIds') x WHERE NOT EXISTS(SELECT 1 FROM public.people person WHERE person.academy_id=NEW.academy_id AND person.id=x::uuid AND person.kind='human' AND(coalesce(disable_only,false) OR((r.hub_id IS NULL OR person.hub_id=r.hub_id) AND(d->'enabled'='false'::jsonb OR person.status='active'))))) THEN RAISE EXCEPTION 'AUTOMATION_AUDIENCE_INVALID' USING ERRCODE='23514';END IF;
  END IF;
  FOREACH k IN ARRAY ARRAY['title','body'] LOOP
   labels=a->k;IF jsonb_typeof(labels) IS DISTINCT FROM 'object' OR NOT(labels ? 'en') OR labels-ARRAY['en','fr','zh-CN']<>'{}'::jsonb OR EXISTS(SELECT 1 FROM jsonb_each(labels) l WHERE jsonb_typeof(l.value)<>'string' OR length(l.value#>>'{}') NOT BETWEEN 1 AND CASE WHEN k='title' THEN 200 ELSE 2000 END OR regexp_replace(l.value#>>'{}','[[:space:]]','','g')='' OR(k='title' AND(position(chr(10) IN (l.value#>>'{}'))>0 OR position(chr(13) IN (l.value#>>'{}'))>0)) OR regexp_replace(l.value#>>'{}','[{][{][[:space:]]*(eventType|entityId|hubId|actorId|actorKind|severity|occurredAt)[[:space:]]*[}][}]','','g')~'([{][{]|[}][}])') THEN RAISE EXCEPTION 'AUTOMATION_TEMPLATE_INVALID' USING ERRCODE='23514';END IF;
  END LOOP;
 END LOOP;RETURN NEW;
END $$;
CREATE TRIGGER automation_revision_guard BEFORE INSERT ON public.automation_rule_revisions FOR EACH ROW EXECUTE FUNCTION public.automation_rule_guard();
CREATE CONSTRAINT TRIGGER automation_applied_guard AFTER INSERT ON public.automation_rule_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['automation_rules','automation_rule_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
END LOOP;END $$;
REVOKE ALL ON FUNCTION public.automation_instant_valid(jsonb),public.automation_condition_valid(jsonb),public.automation_rule_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.automation_instant_valid(jsonb),public.automation_condition_valid(jsonb) TO kavosh_runtime;
GRANT SELECT ON public.automation_rules,public.automation_rule_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,id,hub_id,code) ON public.automation_rules TO kavosh_runtime;
GRANT UPDATE(version) ON public.automation_rules TO kavosh_runtime;
GRANT INSERT(academy_id,rule_id,version,definition,changed_by,approval_id,reason) ON public.automation_rule_revisions TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 59 $$;

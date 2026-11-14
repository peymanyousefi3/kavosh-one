INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('signature-sends.view','View private signing-request history','People',true,ARRAY['hub','class','person','country','region','city']),
 ('signature-sends.edit','Request or cancel reviewed signing intentions','People',true,ARRAY['hub','class','person','country','region','city']),
 ('signature-sends.execute','Reserve one signing-attempt manifest; not provider delivery authority','People',true,ARRAY['hub','class','person','country','region','city']);
ALTER TABLE public.agreement_package_contents ADD CONSTRAINT package_content_send_identity UNIQUE(academy_id,id,package_id);
CREATE TABLE public.signature_send_requests(
 academy_id uuid NOT NULL,id uuid NOT NULL,package_id uuid NOT NULL,attachment_id uuid NOT NULL,prior_id uuid,
 options jsonb NOT NULL,dispatch_within_minutes integer NOT NULL CHECK(dispatch_within_minutes BETWEEN 1 AND 1440),
 context jsonb NOT NULL,created_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),authorization_until timestamptz NOT NULL,
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,id,attachment_id),UNIQUE(academy_id,prior_id),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,attachment_id,package_id) REFERENCES public.agreement_package_contents(academy_id,id,package_id),
 FOREIGN KEY(academy_id,prior_id,attachment_id) REFERENCES public.signature_send_requests(academy_id,id,attachment_id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK(authorization_until=created_at+dispatch_within_minutes*interval '1 minute')
);
CREATE UNIQUE INDEX signature_send_one_root ON public.signature_send_requests(academy_id,attachment_id) WHERE prior_id IS NULL;
CREATE INDEX signature_send_package ON public.signature_send_requests(academy_id,package_id,id);
CREATE TABLE public.signature_send_cancellations(
 academy_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,created_by uuid NOT NULL,approval_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,request_id) REFERENCES public.signature_send_requests(academy_id,id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
-- A conservative single-use reservation, NOT proof of transport invocation,
-- provider acceptance, delivery, signature completion or court sufficiency.
CREATE TABLE public.signature_send_attempts(
 academy_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,actor_id uuid NOT NULL,audit_id uuid NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256~'^[a-f0-9]{64}$'),request_bytes integer NOT NULL CHECK(request_bytes BETWEEN 1 AND 16777216),
 document_sha256 text NOT NULL CHECK(document_sha256~'^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),FOREIGN KEY(academy_id,request_id) REFERENCES public.signature_send_requests(academy_id,id),
 FOREIGN KEY(academy_id,actor_id) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,audit_id) REFERENCES public.audit_events(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['signature_send_requests','signature_send_cancellations','signature_send_attempts'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,package_id,attachment_id,prior_id,options,dispatch_within_minutes,context,created_by,approval_id,reason) ON public.signature_send_requests TO kavosh_runtime;
GRANT INSERT(academy_id,id,request_id,created_by,approval_id,reason) ON public.signature_send_cancellations TO kavosh_runtime;
GRANT INSERT(academy_id,id,request_id,actor_id,audit_id,request_sha256,request_bytes,document_sha256) ON public.signature_send_attempts TO kavosh_runtime;

CREATE FUNCTION public.signature_send_request_source(p_package uuid,p_attachment uuid,p_prior uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;l record;a record;prior record;cancel_id uuid;actual jsonb;BEGIN
 SELECT * INTO l FROM public.agreement_package_contents WHERE academy_id=tenant AND id=p_attachment AND package_id=p_package;
 IF l.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.approval_requests WHERE academy_id=tenant AND id=l.approval_id AND status='applied';
 actual=public.agreement_package_content_basis(l.package_id,l.binding_id);
 IF actual IS NULL OR a.id IS NULL OR a.action<>'agreement.content.attach' OR a.target_id IS DISTINCT FROM l.id OR a.reviewer_id IS DISTINCT FROM l.created_by OR actual IS DISTINCT FROM a.review_context THEN RETURN NULL;END IF;
 IF p_prior IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.signature_send_requests WHERE academy_id=tenant AND attachment_id=l.id AND prior_id IS NULL) THEN RETURN NULL;END IF;
 ELSE
  SELECT * INTO prior FROM public.signature_send_requests WHERE academy_id=tenant AND id=p_prior AND attachment_id=l.id;
  SELECT id INTO cancel_id FROM public.signature_send_cancellations WHERE academy_id=tenant AND request_id=p_prior;
  IF prior.id IS NULL OR cancel_id IS NULL OR EXISTS(SELECT 1 FROM public.signature_send_requests WHERE academy_id=tenant AND prior_id=p_prior)
  OR EXISTS(SELECT 1 FROM public.signature_send_attempts WHERE academy_id=tenant AND request_id=p_prior) THEN RETURN NULL;END IF;
 END IF;
 RETURN jsonb_build_object('attachmentId',l.id,'packageContent',actual,'prior',CASE WHEN p_prior IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',p_prior,'cancellationId',cancel_id) END);
END $$;
CREATE FUNCTION public.signature_send_cancel_source(p_request uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r record;BEGIN
 SELECT * INTO r FROM public.signature_send_requests WHERE academy_id=tenant AND id=p_request;
 IF r.id IS NULL OR EXISTS(SELECT 1 FROM public.signature_send_cancellations WHERE academy_id=tenant AND request_id=p_request)
 OR EXISTS(SELECT 1 FROM public.signature_send_attempts WHERE academy_id=tenant AND request_id=p_request) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('request',to_jsonb(r));
END $$;
CREATE FUNCTION public.signature_send_current(p_request uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r record;l record;a record;BEGIN
 SELECT * INTO r FROM public.signature_send_requests WHERE academy_id=tenant AND id=p_request;
 IF r.id IS NULL OR r.authorization_until<=clock_timestamp() OR EXISTS(SELECT 1 FROM public.signature_send_cancellations WHERE academy_id=tenant AND request_id=p_request)
 OR EXISTS(SELECT 1 FROM public.signature_send_requests WHERE academy_id=tenant AND prior_id=p_request) THEN RETURN false;END IF;
 SELECT * INTO l FROM public.agreement_package_contents WHERE academy_id=tenant AND id=r.attachment_id AND package_id=r.package_id;
 SELECT * INTO a FROM public.approval_requests WHERE academy_id=tenant AND id=r.approval_id AND status='applied';
 RETURN l.id IS NOT NULL AND a.id IS NOT NULL AND a.action='signature.send.request' AND a.target_id=r.id AND a.reviewer_id=r.created_by
 AND public.agreement_package_content_basis(l.package_id,l.binding_id) IS NOT DISTINCT FROM r.context#>'{source,packageContent}';
END $$;
CREATE FUNCTION public.guard_signature_send_record() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;r record;a record;actual jsonb;BEGIN
 IF TG_TABLE_NAME='signature_send_requests' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':'||NEW.attachment_id::text,24));
  actual=jsonb_build_object('source',public.signature_send_request_source(NEW.package_id,NEW.attachment_id,NEW.prior_id));
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':'||NEW.request_id::text,25));
  actual=public.signature_send_cancel_source(NEW.request_id);
 END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'signature-sends.view'
 OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR actual IS NULL OR actual->'source'='null'::jsonb OR p.review_context IS DISTINCT FROM actual
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.created_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'SIGNATURE_SEND_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='signature_send_requests' THEN
  IF p.action<>'signature.send.request' OR(p.payload->>'packageId')::uuid IS DISTINCT FROM NEW.package_id OR(p.payload->>'attachmentId')::uuid IS DISTINCT FROM NEW.attachment_id
  OR(p.payload->>'priorId')::uuid IS DISTINCT FROM NEW.prior_id OR p.payload->'options' IS DISTINCT FROM NEW.options OR(p.payload->>'dispatchWithinMinutes')::integer IS DISTINCT FROM NEW.dispatch_within_minutes
  OR NEW.context IS DISTINCT FROM actual OR jsonb_typeof(NEW.options) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_object_keys(NEW.options))<>3
  OR jsonb_typeof(NEW.options->'title') IS DISTINCT FROM 'string' OR length(NEW.options->>'title') NOT BETWEEN 1 AND 200 OR length(btrim(NEW.options->>'title'))=0 OR NEW.options->>'title'~'[\r\n]'
  OR jsonb_typeof(NEW.options->'message') IS DISTINCT FROM 'string' OR length(NEW.options->>'message')>2000 OR jsonb_typeof(NEW.options->'expiryDays') IS DISTINCT FROM 'number'
  OR(NEW.options->>'expiryDays')::numeric NOT BETWEEN 1 AND 180 OR trunc((NEW.options->>'expiryDays')::numeric)<>(NEW.options->>'expiryDays')::numeric
  THEN RAISE EXCEPTION 'SIGNATURE_SEND_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
  NEW.created_at=clock_timestamp();NEW.authorization_until=NEW.created_at+NEW.dispatch_within_minutes*interval '1 minute';
 ELSE
  IF p.action<>'signature.send.cancel' OR(p.payload->>'requestId')::uuid IS DISTINCT FROM NEW.request_id THEN RAISE EXCEPTION 'SIGNATURE_SEND_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER signature_send_request_guard BEFORE INSERT ON public.signature_send_requests FOR EACH ROW EXECUTE FUNCTION public.guard_signature_send_record();
CREATE TRIGGER signature_send_cancel_guard BEFORE INSERT ON public.signature_send_cancellations FOR EACH ROW EXECUTE FUNCTION public.guard_signature_send_record();
CREATE CONSTRAINT TRIGGER signature_send_request_reviewed AFTER INSERT ON public.signature_send_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE CONSTRAINT TRIGGER signature_send_cancel_reviewed AFTER INSERT ON public.signature_send_cancellations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.guard_signature_send_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE r record;a record;BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':'||NEW.request_id::text,25));
 SELECT * INTO r FROM public.signature_send_requests WHERE academy_id=NEW.academy_id AND id=NEW.request_id;
 SELECT * INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id AND entity_id=NEW.id AND action='signature.send.attempt_reserved' AND actor_id=NEW.actor_id AND created_at=transaction_timestamp();
 IF a.id IS NULL OR NOT public.signature_send_current(NEW.request_id) OR NEW.document_sha256 IS DISTINCT FROM r.context#>>'{source,packageContent,content,source,sha256}'
 OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.actor_id AND status='active') THEN RAISE EXCEPTION 'SIGNATURE_SEND_ATTEMPT_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER signature_send_attempt_guard BEFORE INSERT ON public.signature_send_attempts FOR EACH ROW EXECUTE FUNCTION public.guard_signature_send_attempt();
CREATE FUNCTION public.signature_send_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE attachment uuid;refs jsonb;BEGIN
 IF NEW.action='signature.send.request' THEN attachment=(NEW.payload->>'attachmentId')::uuid;
 ELSE SELECT attachment_id INTO attachment FROM public.signature_send_requests WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'requestId')::uuid;END IF;
 SELECT p.privacy_bindings INTO refs FROM public.agreement_package_contents l JOIN public.approval_requests p ON p.academy_id=l.academy_id AND p.id=l.approval_id WHERE l.academy_id=NEW.academy_id AND l.id=attachment;
 NEW.privacy_bindings=NEW.privacy_bindings||coalesce(refs,jsonb_build_array(jsonb_build_object('unresolved',true)));RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_signature_send_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('signature.send.request','signature.send.cancel')) EXECUTE FUNCTION public.signature_send_privacy();
REVOKE ALL ON FUNCTION public.signature_send_request_source(uuid,uuid,uuid),public.signature_send_cancel_source(uuid),public.signature_send_current(uuid),public.guard_signature_send_record(),public.guard_signature_send_attempt(),public.signature_send_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_send_request_source(uuid,uuid,uuid),public.signature_send_cancel_source(uuid),public.signature_send_current(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 71 $$;

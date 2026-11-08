-- Reviewed two-party worker sending intentions, separate from one-party
-- enrollment/admission. This migration performs no provider operation.
ALTER TABLE public.work_agreement_contents ADD UNIQUE(academy_id,id,preparation_id);
CREATE TABLE public.work_signature_send_requests(
 academy_id uuid NOT NULL,id uuid NOT NULL,preparation_id uuid NOT NULL,binding_id uuid NOT NULL,prior_id uuid,
 academy_signer_legal_name text NOT NULL CHECK(length(academy_signer_legal_name) BETWEEN 1 AND 200 AND length(btrim(academy_signer_legal_name))>0 AND position(chr(10) IN academy_signer_legal_name)=0 AND position(chr(13) IN academy_signer_legal_name)=0),options jsonb NOT NULL,dispatch_within_minutes integer NOT NULL CHECK(dispatch_within_minutes BETWEEN 1 AND 1440),context jsonb NOT NULL,
 created_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),authorization_until timestamptz NOT NULL,
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,id,binding_id),UNIQUE(academy_id,prior_id),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,binding_id,preparation_id) REFERENCES public.work_agreement_contents(academy_id,id,preparation_id),
 FOREIGN KEY(academy_id,prior_id,binding_id) REFERENCES public.work_signature_send_requests(academy_id,id,binding_id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),
 CHECK(authorization_until=created_at+dispatch_within_minutes*interval '1 minute')
);
CREATE UNIQUE INDEX work_signature_send_one_root ON public.work_signature_send_requests(academy_id,binding_id) WHERE prior_id IS NULL;
CREATE INDEX work_signature_send_preparation ON public.work_signature_send_requests(academy_id,preparation_id,id);
CREATE TABLE public.work_signature_send_cancellations(
 academy_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,created_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,request_id),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,request_id) REFERENCES public.work_signature_send_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['work_signature_send_requests','work_signature_send_cancellations'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER immutable_work_send BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.subscription_event_immutable()',t);
 EXECUTE format('CREATE TRIGGER work_send_write BEFORE INSERT ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('CREATE CONSTRAINT TRIGGER work_send_reviewed AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,preparation_id,binding_id,prior_id,academy_signer_legal_name,options,dispatch_within_minutes,context,created_by,approval_id,reason) ON public.work_signature_send_requests TO kavosh_runtime;
GRANT INSERT(academy_id,id,request_id,created_by,approval_id,reason) ON public.work_signature_send_cancellations TO kavosh_runtime;
CREATE FUNCTION public.work_signature_content_basis(p_preparation uuid,p_binding uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE c record;a record;s jsonb;BEGIN
 SELECT * INTO c FROM public.work_agreement_contents WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_binding AND preparation_id=p_preparation;IF c.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.approval_requests WHERE academy_id=c.academy_id AND id=c.approval_id;
 s=public.work_agreement_content_source(c.input);
 IF s IS NULL OR s IS DISTINCT FROM c.source_snapshot OR a.status IS DISTINCT FROM 'applied' OR a.action IS DISTINCT FROM 'work.agreement.content' OR a.target_id IS DISTINCT FROM c.id OR a.reviewer_id IS DISTINCT FROM c.created_by OR a.payload IS DISTINCT FROM c.input OR a.review_context IS DISTINCT FROM jsonb_build_object('source',s) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('protocolVersion',1,'preparationId',p_preparation,'bindingId',c.id,'bindingApprovalId',c.approval_id,'content',s);
END $$;
CREATE FUNCTION public.work_signature_send_source(p_preparation uuid,p_binding uuid,p_prior uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE s jsonb:=public.work_signature_content_basis(p_preparation,p_binding);prior record;cancel_id uuid;BEGIN
 IF s IS NULL THEN RETURN NULL;END IF;
 IF p_prior IS NULL THEN IF EXISTS(SELECT 1 FROM public.work_signature_send_requests WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND binding_id=p_binding AND prior_id IS NULL) THEN RETURN NULL;END IF;
 ELSE
  SELECT * INTO prior FROM public.work_signature_send_requests WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_prior AND preparation_id=p_preparation AND binding_id=p_binding;
  SELECT id INTO cancel_id FROM public.work_signature_send_cancellations WHERE academy_id=prior.academy_id AND request_id=prior.id;
  IF prior.id IS NULL OR cancel_id IS NULL OR EXISTS(SELECT 1 FROM public.work_signature_send_requests WHERE academy_id=prior.academy_id AND prior_id=prior.id) THEN RETURN NULL;END IF;
 END IF;
 RETURN jsonb_build_object('content',s,'prior',CASE WHEN p_prior IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',p_prior,'cancellationId',cancel_id) END);
END $$;
CREATE FUNCTION public.work_signature_cancel_source(p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE r record;BEGIN
 SELECT * INTO r FROM public.work_signature_send_requests WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_request;
 IF r.id IS NULL OR EXISTS(SELECT 1 FROM public.work_signature_send_cancellations WHERE academy_id=r.academy_id AND request_id=r.id) OR EXISTS(SELECT 1 FROM public.work_signature_send_requests WHERE academy_id=r.academy_id AND prior_id=r.id) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('request',to_jsonb(r));
END $$;
CREATE FUNCTION public.work_signature_send_current(p_request uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE r record;a record;BEGIN
 SELECT * INTO r FROM public.work_signature_send_requests WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_request;
 IF r.id IS NULL OR r.authorization_until<=statement_timestamp() OR EXISTS(SELECT 1 FROM public.work_signature_send_cancellations WHERE academy_id=r.academy_id AND request_id=r.id) OR EXISTS(SELECT 1 FROM public.work_signature_send_requests WHERE academy_id=r.academy_id AND prior_id=r.id) THEN RETURN false;END IF;
 SELECT * INTO a FROM public.approval_requests WHERE academy_id=r.academy_id AND id=r.approval_id;
 RETURN a.status='applied' AND a.action='work.signature.send.request' AND a.target_id=r.id AND a.reviewer_id=r.created_by AND a.review_context=r.context AND a.payload->>'academySignerLegalName'=r.academy_signer_legal_name AND public.work_signature_content_basis(r.preparation_id,r.binding_id) IS NOT DISTINCT FROM r.context#>'{source,content}';
END $$;
CREATE FUNCTION public.work_signature_send_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;s jsonb;binding uuid;BEGIN
 IF TG_TABLE_NAME='work_signature_send_requests' THEN binding=NEW.binding_id;ELSE SELECT binding_id INTO binding FROM public.work_signature_send_requests WHERE academy_id=NEW.academy_id AND id=NEW.request_id;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':work-signature-send:'||coalesce(binding,NEW.id)::text,41));
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>0 OR p.privacy_capability IS DISTINCT FROM 'work-signatures.edit' OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR NOT public.report_comment_human_verified(NEW.created_by) THEN RAISE EXCEPTION 'WORK_SIGNATURE_SEND_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='work_signature_send_requests' THEN
  s=public.work_signature_send_source(NEW.preparation_id,NEW.binding_id,NEW.prior_id);
  IF s IS NULL OR p.action<>'work.signature.send.request' OR NOT(p.payload ?& ARRAY['preparationId','bindingId','priorId','academySignerLegalName','options','dispatchWithinMinutes','reason']) OR p.payload-ARRAY['preparationId','bindingId','priorId','academySignerLegalName','options','dispatchWithinMinutes','reason']<>'{}'::jsonb OR(p.payload->>'preparationId')::uuid IS DISTINCT FROM NEW.preparation_id OR(p.payload->>'bindingId')::uuid IS DISTINCT FROM NEW.binding_id OR(p.payload->>'priorId')::uuid IS DISTINCT FROM NEW.prior_id OR p.payload->>'academySignerLegalName' IS DISTINCT FROM NEW.academy_signer_legal_name OR p.payload->'options' IS DISTINCT FROM NEW.options OR(p.payload->>'dispatchWithinMinutes')::numeric IS DISTINCT FROM NEW.dispatch_within_minutes::numeric OR p.review_context IS DISTINCT FROM jsonb_build_object('source',s) OR NEW.context IS DISTINCT FROM p.review_context
   OR p.scope IS DISTINCT FROM public.work_agreement_scope((s#>>'{content,content,framework,engagement,id}')::uuid)
   OR jsonb_typeof(NEW.options) IS DISTINCT FROM 'object' OR NOT(NEW.options ?& ARRAY['title','message','expiryDays']) OR NEW.options-ARRAY['title','message','expiryDays']<>'{}'::jsonb OR jsonb_typeof(NEW.options->'title') IS DISTINCT FROM 'string' OR length(NEW.options->>'title') NOT BETWEEN 1 AND 200 OR length(btrim(NEW.options->>'title'))=0 OR NEW.options->>'title'~'[\r\n]' OR jsonb_typeof(NEW.options->'message') IS DISTINCT FROM 'string' OR length(NEW.options->>'message')>2000 OR jsonb_typeof(NEW.options->'expiryDays') IS DISTINCT FROM 'number' OR(NEW.options->>'expiryDays')::numeric NOT BETWEEN 1 AND 180 OR trunc((NEW.options->>'expiryDays')::numeric)<>(NEW.options->>'expiryDays')::numeric THEN RAISE EXCEPTION 'WORK_SIGNATURE_SEND_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
  NEW.created_at=clock_timestamp();NEW.authorization_until=NEW.created_at+NEW.dispatch_within_minutes*interval '1 minute';
 ELSE
  s=public.work_signature_cancel_source(NEW.request_id);
  IF s IS NULL OR p.action<>'work.signature.send.cancel' OR NOT(p.payload ?& ARRAY['requestId','reason']) OR p.payload-ARRAY['requestId','reason']<>'{}'::jsonb OR(p.payload->>'requestId')::uuid IS DISTINCT FROM NEW.request_id OR p.review_context IS DISTINCT FROM s OR p.scope IS DISTINCT FROM public.work_agreement_scope((SELECT w.engagement_id FROM public.work_signature_send_requests r JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id WHERE r.academy_id=NEW.academy_id AND r.id=NEW.request_id)) THEN RAISE EXCEPTION 'WORK_SIGNATURE_SEND_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
  NEW.created_at=clock_timestamp();
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER work_signature_send_guard BEFORE INSERT ON public.work_signature_send_requests FOR EACH ROW EXECUTE FUNCTION public.work_signature_send_guard();
CREATE TRIGGER work_signature_send_guard BEFORE INSERT ON public.work_signature_send_cancellations FOR EACH ROW EXECUTE FUNCTION public.work_signature_send_guard();
CREATE FUNCTION public.work_signature_send_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE w record;c record;s jsonb;BEGIN
 IF NEW.action='work.signature.send.request' THEN SELECT * INTO c FROM public.work_agreement_contents WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'bindingId')::uuid AND preparation_id=(NEW.payload->>'preparationId')::uuid;
 ELSE SELECT b.* INTO c FROM public.work_signature_send_requests r JOIN public.work_agreement_contents b ON b.academy_id=r.academy_id AND b.id=r.binding_id WHERE r.academy_id=NEW.academy_id AND r.id=(NEW.payload->>'requestId')::uuid;END IF;
 SELECT p.*,t.hub_id template_hub INTO w FROM public.work_agreement_preparations p JOIN public.agreement_templates t ON t.academy_id=p.academy_id AND t.id=p.template_id WHERE p.academy_id=NEW.academy_id AND p.id=c.preparation_id;s=public.work_agreement_scope(w.engagement_id);
 IF c.id IS NULL OR w.id IS NULL OR s IS NULL OR NEW.scope IS DISTINCT FROM s THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;
 ELSE NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','work-signatures.view','scope',s),jsonb_build_object('capability','work-pay.view','scope',s),public.approval_hub_binding('agreements.view',ARRAY[w.template_hub]),jsonb_build_object('fileId',c.file_id));END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;
END $$;
CREATE TRIGGER zz_work_signature_send_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('work.signature.send.request','work.signature.send.cancel')) EXECUTE FUNCTION public.work_signature_send_privacy();
CREATE FUNCTION public.work_signature_send_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.status='applied' AND((NEW.action='work.signature.send.request' AND NOT EXISTS(SELECT 1 FROM public.work_signature_send_requests WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id)) OR(NEW.action='work.signature.send.cancel' AND NOT EXISTS(SELECT 1 FROM public.work_signature_send_cancellations WHERE academy_id=NEW.academy_id AND id=NEW.target_id AND approval_id=NEW.id AND created_by=NEW.reviewer_id))) THEN RAISE EXCEPTION 'WORK_SIGNATURE_SEND_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER work_signature_send_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_signature_send_effect();
CREATE FUNCTION public.work_signature_send_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.outbox_events o ON o.academy_id=a.academy_id AND o.request_id=a.request_id AND o.event_type=a.action AND o.entity_id=a.entity_id AND o.created_at=transaction_timestamp() WHERE a.academy_id=NEW.academy_id AND a.entity_id=NEW.id AND a.actor_id=NEW.created_by AND a.action=CASE WHEN TG_TABLE_NAME='work_signature_send_requests' THEN 'work.signature.send.request' ELSE 'work.signature.send.cancel' END AND a.created_at=transaction_timestamp() AND a.changes->'severity'='"critical"'::jsonb AND a.changes->'externalRequestMade'='false'::jsonb) THEN RAISE EXCEPTION 'WORK_SIGNATURE_SEND_AUDIT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
ALTER FUNCTION public.work_signature_send_complete() OWNER TO kavosh_event_policy;
CREATE CONSTRAINT TRIGGER work_signature_send_complete AFTER INSERT ON public.work_signature_send_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_signature_send_complete();
CREATE CONSTRAINT TRIGGER work_signature_send_complete AFTER INSERT ON public.work_signature_send_cancellations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.work_signature_send_complete();
REVOKE ALL ON FUNCTION public.work_signature_content_basis(uuid,uuid),public.work_signature_send_source(uuid,uuid,uuid),public.work_signature_cancel_source(uuid),public.work_signature_send_current(uuid),public.work_signature_send_guard(),public.work_signature_send_privacy(),public.work_signature_send_effect(),public.work_signature_send_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.work_signature_content_basis(uuid,uuid),public.work_signature_send_source(uuid,uuid,uuid),public.work_signature_cancel_source(uuid),public.work_signature_send_current(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 219 $$;


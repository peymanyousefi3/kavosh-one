-- No plaintext names,addresses,SINs or reasons in this private edition ledger.
-- Cipher authentication/semantic validation stays in the application;the DB
-- enforces tenant,exact review,source/edition,verified-human and audit fences.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('payroll-identity.view','View private payroll identity metadata','Finance',true,ARRAY['person']),
 ('payroll-identity.edit','Propose encrypted private payroll identity changes','Finance',true,ARRAY['person']),
 ('payroll-identity.reveal','Reveal private payroll identity with purpose audit','Finance',true,ARRAY['person']);
CREATE TABLE public.payroll_private_identities(
 academy_id uuid NOT NULL,person_id uuid NOT NULL,person_kind text NOT NULL DEFAULT 'human' CHECK(person_kind='human'),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,person_id),FOREIGN KEY(academy_id,person_id,person_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE TABLE public.payroll_private_identity_revisions(
 academy_id uuid NOT NULL,person_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('recorded','withdrawn')),envelope jsonb NOT NULL,commitment text NOT NULL CHECK(commitment~'^[a-f0-9]{64}$'),source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=65536),changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,person_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,person_id) REFERENCES public.payroll_private_identities(academy_id,person_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.payroll_private_identities ADD CONSTRAINT payroll_identity_current_revision FOREIGN KEY(academy_id,person_id,version) REFERENCES public.payroll_private_identity_revisions(academy_id,person_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['payroll_private_identities','payroll_private_identity_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);EXECUTE format('CREATE TRIGGER payroll_identity_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,person_id),UPDATE(version) ON public.payroll_private_identities TO kavosh_runtime;
GRANT INSERT(academy_id,person_id,version,state,envelope,commitment,source_snapshot,changed_by,approval_id) ON public.payroll_private_identity_revisions TO kavosh_runtime;
CREATE FUNCTION public.payroll_identity_envelope_valid(e jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 RETURN jsonb_typeof(e)='object' AND e?&ARRAY['format','keyId','nonce','tag','ciphertext'] AND e-ARRAY['format','keyId','nonce','tag','ciphertext']='{}'::jsonb AND octet_length(e::text)<=23000 AND e->>'format'='payroll-private-v1'
 AND jsonb_typeof(e->'keyId')='string' AND e->>'keyId'~'^[a-z][a-z0-9_-]{0,31}$' AND jsonb_typeof(e->'nonce')='string' AND e->>'nonce'~'^[A-Za-z0-9_-]{16}$'
 AND jsonb_typeof(e->'tag')='string' AND e->>'tag'~'^[A-Za-z0-9_-]{22}$' AND jsonb_typeof(e->'ciphertext')='string' AND length(e->>'ciphertext') BETWEEN 1 AND 21846 AND e->>'ciphertext'~'^[A-Za-z0-9_-]+$';
END $$;
CREATE FUNCTION public.payroll_identity_basis(who uuid,before_version integer) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE p record;b jsonb;n integer;digest text;BEGIN
 SELECT id,kind,status INTO p FROM public.people WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=who;IF NOT FOUND OR p.kind<>'human' THEN RETURN NULL;END IF;
 WITH eligible AS MATERIALIZED(SELECT e.id,max(r.version) version FROM public.work_engagements e JOIN public.work_engagement_revisions r ON r.academy_id=e.academy_id AND r.engagement_id=e.id JOIN public.financial_payees pay ON pay.academy_id=r.academy_id AND pay.id=r.payee_id WHERE e.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND e.person_id=who AND r.definition->>'countryCode'='CA' AND r.definition->>'classification' IN('employee','contractor') AND pay.kind='person' AND pay.person_id=who GROUP BY e.id ORDER BY e.id LIMIT 501)
 SELECT count(*)::integer,encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(id,version) ORDER BY id),'[]'::jsonb)::text,'UTF8')),'hex') INTO n,digest FROM eligible;
 IF n>500 THEN RAISE EXCEPTION 'PAYROLL_IDENTITY_SOURCE_LIMIT' USING ERRCODE='23514';END IF;
 SELECT jsonb_build_object('version',version,'state',state,'commitment',commitment,'envelopeSha256',encode(sha256(convert_to(envelope::text,'UTF8')),'hex')) INTO b FROM public.payroll_private_identity_revisions WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND person_id=who AND version=before_version;
 RETURN jsonb_build_object('personId',p.id,'personKind',p.kind,'personStatus',p.status,'eligibleWorkerCount',n,'workerSourceSha256',digest,'before',b);
END $$;
CREATE FUNCTION public.payroll_identity_header_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAYROLL_IDENTITY_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;PERFORM public.lock_hourly_worker(NEW.person_id);
 IF(TG_OP='INSERT' AND NEW.version<>1) OR(TG_OP='UPDATE' AND(NEW.version<>OLD.version+1 OR(to_jsonb(NEW)-'version') IS DISTINCT FROM(to_jsonb(OLD)-'version'))) THEN RAISE EXCEPTION 'PAYROLL_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER payroll_identity_header BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_private_identities FOR EACH ROW EXECUTE FUNCTION public.payroll_identity_header_guard();
CREATE FUNCTION public.payroll_identity_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;b jsonb;s jsonb;i jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'PAYROLL_IDENTITY_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.payroll_private_identities WHERE academy_id=NEW.academy_id AND person_id=NEW.person_id;SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;b=public.payroll_identity_basis(NEW.person_id,NEW.version-1);
 s=jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',NEW.person_id,'hubId',NULL)),'workContext',jsonb_build_object('personId',NEW.person_id,'hubId',NULL));i=jsonb_build_object('personId',NEW.person_id,'expectedVersion',NEW.version-1,'state',NEW.state,'envelope',NEW.envelope,'commitment',NEW.commitment);
 IF h.person_id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.payroll_private_identity_revisions WHERE academy_id=NEW.academy_id AND person_id=NEW.person_id) OR public.payroll_identity_envelope_valid(NEW.envelope) IS NOT TRUE OR b IS NULL OR(NEW.state='recorded' AND(b->>'eligibleWorkerCount')::integer<1) OR(NEW.state='withdrawn' AND b#>>'{before,state}' IS DISTINCT FROM 'recorded')
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.payroll-identity.change' OR p.target_id IS DISTINCT FROM NEW.person_id OR p.target_version<>NEW.version-1 OR p.privacy_capability IS DISTINCT FROM 'payroll-identity.view' OR p.scope IS DISTINCT FROM s OR p.payload IS DISTINCT FROM i OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'PAYROLL_IDENTITY_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NOT(p.requester_id=NEW.changed_by AND p.requester_kind='human' AND EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by)) AND NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND actor_id=NEW.changed_by AND entity_id=NEW.person_id AND action='work.payroll-identity.proposal-revealed' AND changes->>'approvalId'=NEW.approval_id::text AND changes->'version'=to_jsonb(NEW.version) AND changes->'privateContentRedacted'='true'::jsonb) THEN RAISE EXCEPTION 'PAYROLL_IDENTITY_INSPECTION_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by=NEW.person_id AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER payroll_identity_revision BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_private_identity_revisions FOR EACH ROW EXECUTE FUNCTION public.payroll_identity_revision_guard();
CREATE CONSTRAINT TRIGGER payroll_identity_reviewed AFTER INSERT ON public.payroll_private_identity_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.payroll_identity_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.payroll_identity_basis(NEW.person_id,NEW.version-1) IS DISTINCT FROM NEW.source_snapshot OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.person_id AND actor_id=NEW.changed_by AND created_at=transaction_timestamp() AND action='work.payroll-identity.change' AND changes->'version'=to_jsonb(NEW.version) AND changes->>'approvalId'=NEW.approval_id::text AND changes->'severity'='"critical"'::jsonb AND changes->'privateContentRedacted'='true'::jsonb AND changes->'paymentExecuted'='false'::jsonb) THEN RAISE EXCEPTION 'PAYROLL_IDENTITY_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_identity_complete AFTER INSERT ON public.payroll_private_identity_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_identity_complete();
CREATE FUNCTION public.payroll_identity_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.payroll-identity.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.payroll_private_identity_revisions WHERE academy_id=NEW.academy_id AND person_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'PAYROLL_IDENTITY_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payroll_identity_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.payroll_identity_effect_required();
CREATE FUNCTION public.payroll_identity_private_reason_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE prefix text:='payroll-private-review-v1:';BEGIN
 IF NEW.action<>'work.payroll-identity.change' OR NEW.status='pending' THEN RETURN NEW;END IF;
 IF NEW.status='applied' AND NEW.reason='Master self-approved' AND NEW.requester_kind='human' AND NEW.requester_id=NEW.reviewer_id AND EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.reviewer_id) THEN RETURN NEW;END IF;
 IF left(NEW.reason,length(prefix)) IS DISTINCT FROM prefix OR public.payroll_identity_envelope_valid(substring(NEW.reason from length(prefix)+1)::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'PAYROLL_IDENTITY_PRIVATE_REASON_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'PAYROLL_IDENTITY_PRIVATE_REASON_REQUIRED' USING ERRCODE='23514';
END $$;
CREATE TRIGGER payroll_identity_private_reason BEFORE INSERT OR UPDATE ON public.approval_requests FOR EACH ROW EXECUTE FUNCTION public.payroll_identity_private_reason_guard();
REVOKE ALL ON FUNCTION public.payroll_identity_envelope_valid(jsonb),public.payroll_identity_basis(uuid,integer),public.payroll_identity_header_guard(),public.payroll_identity_revision_guard(),public.payroll_identity_complete(),public.payroll_identity_effect_required() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payroll_identity_private_reason_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_identity_envelope_valid(jsonb),public.payroll_identity_basis(uuid,integer) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 177 $$;

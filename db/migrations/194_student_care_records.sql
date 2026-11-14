-- Care text and all free-form reasons are application-encrypted before storage.
-- No existing role inherits these sensitive permissions automatically.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('care-records.view','View scoped student care record metadata','People',true,ARRAY['hub','person','country','region','city']),
 ('care-records.edit','Propose reviewed encrypted student care records','People',true,ARRAY['hub','person','country','region','city']),
 ('care-records.reveal','Read scoped private student care text with purpose audit','People',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.student_care_revisions(
 academy_id uuid NOT NULL,student_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('recorded','withdrawn')),envelope jsonb NOT NULL,commitment text NOT NULL CHECK(commitment~'^[a-f0-9]{64}$'),source_basis jsonb NOT NULL CHECK(octet_length(source_basis::text)<=16384),changed_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,student_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.student_care_heads(
 academy_id uuid NOT NULL,student_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),PRIMARY KEY(academy_id,student_id),FOREIGN KEY(academy_id,student_id,version) REFERENCES public.student_care_revisions(academy_id,student_id,version)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['student_care_revisions','student_care_heads'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,student_id,version,state,envelope,commitment,source_basis,changed_by,approval_id) ON public.student_care_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,student_id,version),UPDATE(version) ON public.student_care_heads TO kavosh_runtime;
CREATE FUNCTION public.student_care_envelope_valid(e jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT e->>'format'='student-care-private-v1' AND public.payroll_identity_envelope_valid(jsonb_set(e,'{format}','"payroll-private-v1"'::jsonb)) $$;
CREATE FUNCTION public.student_care_basis(p_student uuid) RETURNS jsonb LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('studentId',p.id,'studentProfileVersion',s.version,'studentStatus',p.status,'hubId',p.hub_id,'version',coalesce(h.version,0),'state',r.state,'commitment',r.commitment,'envelopeSha256',CASE WHEN r.envelope IS NOT NULL THEN encode(sha256(convert_to(r.envelope::text,'UTF8')),'hex') ELSE NULL END,
 'scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p.id,'hubId',p.hub_id))))
 FROM public.student_profiles s JOIN public.people p ON p.academy_id=s.academy_id AND p.id=s.person_id LEFT JOIN public.student_care_heads h ON h.academy_id=s.academy_id AND h.student_id=s.person_id LEFT JOIN public.student_care_revisions r ON r.academy_id=h.academy_id AND r.student_id=h.student_id AND r.version=h.version
 WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.person_id=p_student AND p.kind='human'
$$;
CREATE FUNCTION public.student_care_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;b jsonb;is_master boolean;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'STUDENT_CARE_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,8));b=public.student_care_basis(NEW.student_id);SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF b IS NULL OR NEW.version<>(b->>'version')::integer+1 OR NEW.source_basis IS DISTINCT FROM b OR public.student_care_envelope_valid(NEW.envelope) IS NOT TRUE OR(NEW.state='withdrawn' AND b->>'state' IS DISTINCT FROM 'recorded')
 OR a.id IS NULL OR a.action IS DISTINCT FROM 'student.care.change' OR a.status<>'pending' OR a.requester_kind IS DISTINCT FROM 'human' OR a.target_id IS DISTINCT FROM NEW.student_id OR a.target_version<>NEW.version-1 OR a.privacy_capability IS DISTINCT FROM 'care-records.view' OR a.scope IS DISTINCT FROM b->'scope' OR a.review_context IS DISTINCT FROM b OR a.payload IS DISTINCT FROM jsonb_build_object('expectedVersion',NEW.version-1,'state',NEW.state,'envelope',NEW.envelope,'commitment',NEW.commitment) OR NOT public.report_comment_human_verified(NEW.changed_by)
 THEN RAISE EXCEPTION 'STUDENT_CARE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) INTO is_master;
 IF NOT is_master AND(NEW.changed_by=NEW.student_id OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=NEW.student_id AND guardian_id=NEW.changed_by AND relationship IN('parent','legal_guardian') AND state='approved' AND valid_from<=clock_timestamp() AND(valid_until IS NULL OR valid_until>clock_timestamp()))) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 IF NOT(is_master AND a.requester_id=NEW.changed_by) AND NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND actor_id=NEW.changed_by AND entity_id=NEW.student_id AND action='student.care.proposal-revealed' AND changes->>'approvalId'=NEW.approval_id::text AND changes->'version'=to_jsonb(NEW.version) AND changes->'privateContentRedacted'='true'::jsonb) THEN RAISE EXCEPTION 'STUDENT_CARE_INSPECTION_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER student_care_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.student_care_revisions FOR EACH ROW EXECUTE FUNCTION public.student_care_revision_guard();
CREATE FUNCTION public.student_care_head_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'STUDENT_CARE_HEAD_REQUIRED' USING ERRCODE='23514';END IF;
 IF(TG_OP='INSERT' AND NEW.version<>1) OR(TG_OP='UPDATE' AND(NEW.academy_id IS DISTINCT FROM OLD.academy_id OR NEW.student_id IS DISTINCT FROM OLD.student_id OR NEW.version<>OLD.version+1)) OR NOT EXISTS(SELECT 1 FROM public.student_care_revisions WHERE academy_id=NEW.academy_id AND student_id=NEW.student_id AND version=NEW.version AND created_at>=transaction_timestamp()) THEN RAISE EXCEPTION 'STUDENT_CARE_HEAD_EXACT_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER student_care_head_guard BEFORE INSERT OR UPDATE OR DELETE ON public.student_care_heads FOR EACH ROW EXECUTE FUNCTION public.student_care_head_guard();
CREATE CONSTRAINT TRIGGER student_care_reviewed AFTER INSERT ON public.student_care_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.student_care_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b jsonb;BEGIN
 b=public.student_care_basis(NEW.student_id);
 IF b IS NULL OR b->>'version' IS DISTINCT FROM NEW.version::text OR b->>'state' IS DISTINCT FROM NEW.state OR b->>'commitment' IS DISTINCT FROM NEW.commitment OR b-ARRAY['version','state','commitment','envelopeSha256'] IS DISTINCT FROM NEW.source_basis-ARRAY['version','state','commitment','envelopeSha256']
 OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.student_id AND actor_id=NEW.changed_by AND created_at=transaction_timestamp() AND action='student.care.change' AND hub_id IS NOT DISTINCT FROM(NEW.source_basis->>'hubId')::uuid AND changes->'version'=to_jsonb(NEW.version) AND changes->>'state'=NEW.state AND changes->>'approvalId'=NEW.approval_id::text AND changes->'severity'='"critical"'::jsonb AND changes->'privateContentRedacted'='true'::jsonb)
 THEN RAISE EXCEPTION 'STUDENT_CARE_EFFECT_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER student_care_complete AFTER INSERT ON public.student_care_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.student_care_complete();
CREATE FUNCTION public.student_care_approval_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='student.care.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.student_care_revisions WHERE academy_id=NEW.academy_id AND student_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'STUDENT_CARE_APPROVAL_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER student_care_approval_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.student_care_approval_effect();
CREATE FUNCTION public.student_care_private_reason_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE prefix text:='student-care-private-review-v1:';BEGIN
 IF NEW.action<>'student.care.change' OR NEW.status='pending' THEN RETURN NEW;END IF;
 IF NEW.status='applied' AND NEW.reason='Master self-approved' AND NEW.requester_kind='human' AND NEW.requester_id=NEW.reviewer_id AND EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.reviewer_id) THEN RETURN NEW;END IF;
 IF left(NEW.reason,length(prefix)) IS DISTINCT FROM prefix OR public.student_care_envelope_valid(substring(NEW.reason from length(prefix)+1)::jsonb) IS NOT TRUE THEN RAISE EXCEPTION 'STUDENT_CARE_PRIVATE_REASON_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'STUDENT_CARE_PRIVATE_REASON_REQUIRED' USING ERRCODE='23514';
END $$;
CREATE TRIGGER student_care_private_reason BEFORE INSERT OR UPDATE ON public.approval_requests FOR EACH ROW EXECUTE FUNCTION public.student_care_private_reason_guard();
DO $$ DECLARE b text;n text:='''student.registration.correct'')';BEGIN
 b=pg_get_functiondef('public.capture_automation_event()'::regprocedure);IF position(n IN b)=0 THEN RAISE EXCEPTION 'STUDENT_CARE_ALERT_SOURCE_CHANGED';END IF;EXECUTE replace(b,n,'''student.registration.correct'',''student.care.change'')');
END $$;
REVOKE ALL ON FUNCTION public.student_care_envelope_valid(jsonb),public.student_care_basis(uuid),public.student_care_revision_guard(),public.student_care_head_guard(),public.student_care_complete(),public.student_care_approval_effect(),public.student_care_private_reason_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_care_envelope_valid(jsonb),public.student_care_basis(uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 194 $$;

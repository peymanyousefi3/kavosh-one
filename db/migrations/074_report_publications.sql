INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('report-publications.view','View private report-publication history','Learning',true,ARRAY['hub','class','country','region','city']),
 ('report-publications.edit','Request reviewed class-report publication or withdrawal','Learning',true,ARRAY['hub','class','country','region','city']),
 ('report-publications.override','Explicitly publish a text report without a media reference; not payroll override','Learning',true,ARRAY['hub','class','country','region','city']),
 ('received-reports.view','Read published reports for own or currently linked students; not private draft/file access','Learning',true,ARRAY['hub','person','country','region','city']);
CREATE TABLE public.report_publications(
 academy_id uuid NOT NULL,id uuid NOT NULL,session_id uuid NOT NULL,class_id uuid NOT NULL,hub_id uuid NOT NULL,report_version integer NOT NULL,prior_id uuid,
 allow_missing_media boolean NOT NULL,audience_reviewed boolean NOT NULL CHECK(audience_reviewed),context jsonb NOT NULL,
 created_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,id,session_id),UNIQUE(academy_id,prior_id),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,session_id,class_id,hub_id) REFERENCES public.class_sessions(academy_id,id,class_id,hub_id),
 FOREIGN KEY(academy_id,session_id,report_version) REFERENCES public.session_report_revisions(academy_id,session_id,version),
 FOREIGN KEY(academy_id,prior_id,session_id) REFERENCES public.report_publications(academy_id,id,session_id),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE UNIQUE INDEX report_publication_root ON public.report_publications(academy_id,session_id) WHERE prior_id IS NULL;
CREATE INDEX report_publication_session ON public.report_publications(academy_id,session_id,id);
CREATE INDEX report_publication_class ON public.report_publications(academy_id,class_id,id);
CREATE TABLE public.report_publication_withdrawals(
 academy_id uuid NOT NULL,id uuid NOT NULL,publication_id uuid NOT NULL,created_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,publication_id),UNIQUE(academy_id,approval_id),
 FOREIGN KEY(academy_id,publication_id) REFERENCES public.report_publications(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['report_publications','report_publication_withdrawals'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
END LOOP;END $$;
GRANT INSERT(academy_id,id,session_id,class_id,hub_id,report_version,prior_id,allow_missing_media,audience_reviewed,context,created_by,approval_id,reason) ON public.report_publications TO kavosh_runtime;
GRANT INSERT(academy_id,id,publication_id,created_by,approval_id,reason) ON public.report_publication_withdrawals TO kavosh_runtime;
CREATE FUNCTION public.report_publication_source(p_session uuid,p_version integer,p_prior uuid,p_override boolean) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r record;prior record;withdrawal uuid;actual jsonb;BEGIN
 SELECT * INTO r FROM public.session_reports WHERE academy_id=tenant AND session_id=p_session AND version=p_version;
 IF r.session_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.session_report_revisions x WHERE x.academy_id=tenant AND x.session_id=r.session_id AND x.version=r.version AND x.definition=to_jsonb(r)) THEN RETURN NULL;END IF;
 IF r.approval_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=tenant AND a.id=r.approval_id AND a.status='applied' AND a.reviewer_id=r.changed_by AND a.action='session-report.correct' AND a.target_id=r.session_id) THEN RETURN NULL;END IF;
 actual=public.session_report_source(r.session_id,r.document);
 IF actual IS NULL OR actual IS DISTINCT FROM r.context OR(actual#>>'{session,startsAt}')::timestamptz>clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.document->'blocks') b WHERE b->>'kind'='text') OR(NOT p_override AND jsonb_array_length(actual->'media')=0) THEN RETURN NULL;END IF;
 IF p_prior IS NULL THEN IF EXISTS(SELECT 1 FROM public.report_publications WHERE academy_id=tenant AND session_id=p_session AND prior_id IS NULL) THEN RETURN NULL;END IF;
 ELSE
  SELECT * INTO prior FROM public.report_publications WHERE academy_id=tenant AND id=p_prior AND session_id=p_session;
  IF prior.id IS NULL OR EXISTS(SELECT 1 FROM public.report_publications WHERE academy_id=tenant AND prior_id=p_prior) THEN RETURN NULL;END IF;
  SELECT id INTO withdrawal FROM public.report_publication_withdrawals WHERE academy_id=tenant AND publication_id=p_prior;
 END IF;
 RETURN jsonb_build_object('report',to_jsonb(r),'source',actual,'prior',CASE WHEN p_prior IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',p_prior,'withdrawalId',withdrawal) END);
END $$;
CREATE FUNCTION public.report_withdrawal_source(p_publication uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;p record;BEGIN
 SELECT * INTO p FROM public.report_publications WHERE academy_id=tenant AND id=p_publication;
 IF p.id IS NULL OR EXISTS(SELECT 1 FROM public.report_publication_withdrawals WHERE academy_id=tenant AND publication_id=p.id) OR EXISTS(SELECT 1 FROM public.report_publications WHERE academy_id=tenant AND prior_id=p.id) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('publication',to_jsonb(p));
END $$;
CREATE FUNCTION public.guard_report_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a record;actual jsonb;BEGIN
 IF TG_TABLE_NAME='report_publications' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':'||NEW.session_id::text,26));
  actual=public.report_publication_source(NEW.session_id,NEW.report_version,NEW.prior_id,NEW.allow_missing_media);
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text||':'||(SELECT session_id::text FROM public.report_publications WHERE academy_id=NEW.academy_id AND id=NEW.publication_id),26));
  actual=public.report_withdrawal_source(NEW.publication_id);
 END IF;
 SELECT * INTO a FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF actual IS NULL OR a.id IS NULL OR a.status<>'pending' OR a.target_id IS DISTINCT FROM NEW.id OR a.target_version<>0 OR a.privacy_capability IS DISTINCT FROM 'report-publications.view'
 OR a.payload->>'reason' IS DISTINCT FROM NEW.reason OR a.review_context IS DISTINCT FROM actual OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.created_by AND kind='human' AND status='active') THEN RAISE EXCEPTION 'REPORT_PUBLICATION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='report_publications' THEN
  IF a.action<>'report.publish' OR(a.payload->>'sessionId')::uuid IS DISTINCT FROM NEW.session_id OR(a.payload->>'reportVersion')::integer IS DISTINCT FROM NEW.report_version
  OR(a.payload->>'priorId')::uuid IS DISTINCT FROM NEW.prior_id OR(a.payload->>'allowMissingMedia')::boolean IS DISTINCT FROM NEW.allow_missing_media OR(a.payload->>'classAudienceReviewed')::boolean IS DISTINCT FROM NEW.audience_reviewed
  OR NEW.context IS DISTINCT FROM actual OR(actual#>>'{source,session,classId}')::uuid IS DISTINCT FROM NEW.class_id OR(actual#>>'{source,session,hubId}')::uuid IS DISTINCT FROM NEW.hub_id THEN RAISE EXCEPTION 'REPORT_PUBLICATION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE IF a.action<>'report.withdraw' OR(a.payload->>'publicationId')::uuid IS DISTINCT FROM NEW.publication_id THEN RAISE EXCEPTION 'REPORT_PUBLICATION_EXACT_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;END IF;RETURN NEW;
END $$;
CREATE TRIGGER report_publication_guard BEFORE INSERT ON public.report_publications FOR EACH ROW EXECUTE FUNCTION public.guard_report_publication();
CREATE TRIGGER report_withdrawal_guard BEFORE INSERT ON public.report_publication_withdrawals FOR EACH ROW EXECUTE FUNCTION public.guard_report_publication();
CREATE CONSTRAINT TRIGGER report_publication_reviewed AFTER INSERT ON public.report_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE CONSTRAINT TRIGGER report_withdrawal_reviewed AFTER INSERT ON public.report_publication_withdrawals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.report_publication_active(p_id uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.report_publications p JOIN public.approval_requests a ON a.academy_id=p.academy_id AND a.id=p.approval_id WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_id AND a.status='applied' AND a.action='report.publish' AND a.target_id=p.id AND a.reviewer_id=p.created_by
 AND NOT EXISTS(SELECT 1 FROM public.report_publications n WHERE n.academy_id=p.academy_id AND n.prior_id=p.id) AND NOT EXISTS(SELECT 1 FROM public.report_publication_withdrawals w WHERE w.academy_id=p.academy_id AND w.publication_id=p.id))
$$;
CREATE FUNCTION public.report_recipient(p_student uuid,p_actor uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.student_profiles s JOIN public.people student ON student.academy_id=s.academy_id AND student.id=s.person_id JOIN public.people actor ON actor.academy_id=s.academy_id AND actor.id=p_actor
 WHERE s.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND s.person_id=p_student AND student.status='active' AND actor.status='active' AND actor.kind='human' AND(student.id=actor.id
 OR EXISTS(SELECT 1 FROM public.academies a WHERE a.id=s.academy_id AND a.master_person_id=actor.id)
 OR EXISTS(SELECT 1 FROM public.family_relationships f WHERE f.academy_id=s.academy_id AND f.student_id=s.person_id AND f.guardian_id=actor.id AND f.relationship IN('parent','legal_guardian') AND f.state='approved' AND f.valid_from<=statement_timestamp() AND(f.valid_until IS NULL OR f.valid_until>statement_timestamp()))))
$$;
CREATE FUNCTION public.report_publication_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE d jsonb;b jsonb;c jsonb;BEGIN
 d=CASE WHEN NEW.action='report.publish' THEN NEW.review_context#>'{report,document}' ELSE NEW.review_context#>'{publication,context,report,document}' END;
 c=CASE WHEN NEW.action='report.publish' THEN NEW.review_context#>'{source,session}' ELSE NEW.review_context#>'{publication,context,source,session}' END;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','session-reports.view','scope',jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',c->'classId','hubId',c->'hubId')))));
 FOR b IN SELECT value FROM jsonb_array_elements(coalesce(d->'blocks','[]'::jsonb)) WHERE value->>'kind'='media' LOOP NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('fileId',(b->>'fileId')::uuid));END LOOP;RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('unresolved',true));RETURN NEW;
END $$;
CREATE TRIGGER zz_report_publication_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('report.publish','report.withdraw')) EXECUTE FUNCTION public.report_publication_privacy();
REVOKE ALL ON FUNCTION public.report_publication_source(uuid,integer,uuid,boolean),public.report_withdrawal_source(uuid),public.guard_report_publication(),public.report_publication_active(uuid),public.report_recipient(uuid,uuid),public.report_publication_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_publication_source(uuid,integer,uuid,boolean),public.report_withdrawal_source(uuid),public.report_publication_active(uuid),public.report_recipient(uuid,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 74 $$;

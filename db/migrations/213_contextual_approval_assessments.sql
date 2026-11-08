-- Context belongs to the existing approval case,not a parallel authority.
CREATE TABLE public.approval_assessments(
 academy_id uuid NOT NULL,approval_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),approval_version integer NOT NULL CHECK(approval_version>0),source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=20000),content_hash text NOT NULL,author_id uuid NOT NULL,request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,approval_id,version),UNIQUE(academy_id,request_id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,author_id) REFERENCES public.people(academy_id,id)
);
ALTER TABLE public.approval_assessments ENABLE ROW LEVEL SECURITY;ALTER TABLE public.approval_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.approval_assessments USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.approval_assessments TO kavosh_runtime;
GRANT INSERT(academy_id,approval_id,version,approval_version,source_hash,content,author_id,request_id) ON public.approval_assessments TO kavosh_runtime;
CREATE FUNCTION public.approval_assessment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;o jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'APPROVAL_ASSESSMENT_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id FOR UPDATE;
 IF p.id IS NULL OR p.status<>'pending' OR p.version<>NEW.approval_version OR p.dependency_hash IS DISTINCT FROM NEW.source_hash
  OR p.action IN('work.payroll-identity.change','student.care.change','student.care.submit')
  OR NEW.version<>coalesce((SELECT max(version) FROM public.approval_assessments WHERE academy_id=NEW.academy_id AND approval_id=NEW.approval_id),0)+1
  OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.author_id AND status='active')
 THEN RAISE EXCEPTION 'APPROVAL_ASSESSMENT_SOURCE_CHANGED' USING ERRCODE='23514';END IF;
 IF NEW.content-ARRAY['summary','reasoning','options','recommendedOption','uncertainties','relatedApprovalIds']<>'{}'::jsonb OR NOT(NEW.content ?& ARRAY['summary','reasoning','options','recommendedOption','uncertainties','relatedApprovalIds'])
  OR jsonb_typeof(NEW.content->'summary') IS DISTINCT FROM 'string' OR length(btrim(NEW.content->>'summary')) NOT BETWEEN 1 AND 2000
  OR jsonb_typeof(NEW.content->'reasoning') IS DISTINCT FROM 'string' OR length(btrim(NEW.content->>'reasoning')) NOT BETWEEN 1 AND 4000
  OR jsonb_typeof(NEW.content->'options') IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.content->'uncertainties') IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.content->'relatedApprovalIds') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'APPROVAL_ASSESSMENT_CONTENT_INVALID' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(NEW.content->'options') NOT BETWEEN 1 AND 5 OR jsonb_array_length(NEW.content->'uncertainties')>10 OR jsonb_array_length(NEW.content->'relatedApprovalIds')>5 THEN RAISE EXCEPTION 'APPROVAL_ASSESSMENT_CONTENT_INVALID' USING ERRCODE='23514';END IF;
 FOR o IN SELECT value FROM jsonb_array_elements(NEW.content->'options') LOOP
  IF jsonb_typeof(o) IS DISTINCT FROM 'object' OR o-ARRAY['code','title','tradeoffs']<>'{}'::jsonb OR NOT(o ?& ARRAY['code','title','tradeoffs']) OR jsonb_typeof(o->'code') IS DISTINCT FROM 'string' OR(o->>'code')!~'^[a-z][a-z0-9_-]{0,39}$' OR jsonb_typeof(o->'title') IS DISTINCT FROM 'string' OR length(btrim(o->>'title')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(o->'tradeoffs') IS DISTINCT FROM 'string' OR length(btrim(o->>'tradeoffs')) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'APPROVAL_ASSESSMENT_CONTENT_INVALID' USING ERRCODE='23514';END IF;
 END LOOP;
 IF jsonb_typeof(NEW.content->'recommendedOption') IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.content->'options') x WHERE x->>'code'=NEW.content->>'recommendedOption')
  OR(SELECT count(*) FROM jsonb_array_elements(NEW.content->'options'))<>(SELECT count(DISTINCT x->>'code') FROM jsonb_array_elements(NEW.content->'options') x)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.content->'uncertainties') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR length(btrim(x#>>'{}')) NOT BETWEEN 1 AND 2000)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.content->'relatedApprovalIds') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR(x#>>'{}')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR(x#>>'{}')=NEW.approval_id::text)
 THEN RAISE EXCEPTION 'APPROVAL_ASSESSMENT_CONTENT_INVALID' USING ERRCODE='23514';END IF;
 NEW.content_hash=encode(sha256(convert_to(NEW.content::text,'UTF8')),'hex');NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER approval_assessment_guard BEFORE INSERT OR UPDATE OR DELETE ON public.approval_assessments FOR EACH ROW EXECUTE FUNCTION public.approval_assessment_guard();
CREATE INDEX approval_assessment_outbox_receipt ON public.outbox_events(academy_id,request_id,entity_id) WHERE event_type='approval.assessment.recorded';
GRANT SELECT(request_id) ON public.outbox_events TO kavosh_event_policy;
CREATE FUNCTION public.approval_assessment_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.approval_id AND request_id=NEW.request_id AND actor_id=NEW.author_id AND action='approval.assessment.recorded' AND created_at=transaction_timestamp() AND changes->>'assessmentVersion'=NEW.version::text AND changes->>'contentHash'=NEW.content_hash AND changes->'severity'='"critical"'::jsonb AND changes->'changesApplied'='false'::jsonb)
 OR NOT EXISTS(SELECT 1 FROM public.outbox_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.approval_id AND request_id=NEW.request_id AND event_type='approval.assessment.recorded' AND created_at=transaction_timestamp())
 THEN RAISE EXCEPTION 'APPROVAL_ASSESSMENT_AUDIT_REQUIRED' USING ERRCODE='55000';END IF;RETURN NULL;
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_event_policy;
ALTER FUNCTION public.approval_assessment_complete() OWNER TO kavosh_event_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_event_policy;
CREATE CONSTRAINT TRIGGER approval_assessment_complete AFTER INSERT ON public.approval_assessments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.approval_assessment_complete();
REVOKE ALL ON FUNCTION public.approval_assessment_guard(),public.approval_assessment_complete() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 213 $$;

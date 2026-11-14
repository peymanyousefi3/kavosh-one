-- Retry creates new work;terminal evidence and original credentials never change.
ALTER TABLE public.report_jobs ADD retry_of_job_id uuid,
 ADD FOREIGN KEY(academy_id,retry_of_job_id) REFERENCES public.report_jobs(academy_id,id),
 ADD UNIQUE(academy_id,retry_of_job_id),ADD CHECK(retry_of_job_id IS DISTINCT FROM id);
GRANT INSERT(retry_of_job_id) ON public.report_jobs TO kavosh_runtime;
CREATE FUNCTION public.report_job_retry_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;a jsonb;BEGIN
 SELECT changes INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id;
 IF coalesce(a->'retryOfJobId','null'::jsonb) IS DISTINCT FROM coalesce(to_jsonb(NEW.retry_of_job_id),'null'::jsonb) THEN RAISE EXCEPTION 'REPORT_RETRY_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.retry_of_job_id IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO p FROM public.report_jobs WHERE academy_id=NEW.academy_id AND id=NEW.retry_of_job_id;
 IF p.id IS NULL OR p.status NOT IN('failed','cancelled') OR p.last_error='CANCELLED_BY_REQUEST'
  OR NOT(p.requester_id=NEW.requester_id OR(NEW.requester_kind='human' AND EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.requester_id)))
  OR p.configuration IS DISTINCT FROM NEW.configuration OR p.preset_id IS DISTINCT FROM NEW.preset_id OR p.preset_version IS DISTINCT FROM NEW.preset_version OR p.window_resolution IS DISTINCT FROM NEW.window_resolution
  OR jsonb_typeof(a->'retryReason') IS DISTINCT FROM 'string' OR length(btrim(a->>'retryReason')) NOT BETWEEN 3 AND 2000
  OR EXISTS(SELECT 1 FROM public.report_job_results WHERE academy_id=p.academy_id AND job_id=p.id)
  THEN RAISE EXCEPTION 'REPORT_RETRY_SOURCE_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER report_job_retry_guard BEFORE INSERT ON public.report_jobs FOR EACH ROW EXECUTE FUNCTION public.report_job_retry_guard();
REVOKE ALL ON FUNCTION public.report_job_retry_guard() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 138 $$;

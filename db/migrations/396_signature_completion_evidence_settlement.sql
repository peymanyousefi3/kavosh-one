-- Retained evidence resolves an operational check, not legal validity, safe
-- downloads, admission, attendance or payment. Keep prior incidents/attempts.
GRANT CREATE ON SCHEMA public TO kavosh_signature_completion_policy;
CREATE FUNCTION public.settle_signature_completion_evidence(p_academy uuid,p_purpose text,p_start uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q public.signature_completion_jobs;s jsonb;e uuid;BEGIN
 IF p_purpose IS NULL OR p_purpose NOT IN('unified_enrollment','worker_services') THEN RAISE EXCEPTION 'INVALID_SIGNATURE_COMPLETION_PURPOSE';END IF;
 -- Same transport-before-job order as recording, finishing and source locking.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_academy::text||CASE WHEN p_purpose='worker_services' THEN ':work-signature-transport:' ELSE ':signature-transport:' END||p_start::text,0));
 SELECT * INTO q FROM public.signature_completion_jobs j WHERE j.academy_id=p_academy AND j.purpose=p_purpose AND j.start_id=p_start AND j.state IN('queued','blocked') FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF; -- A running lease belongs to its finisher.
 s=public.signature_completion_job_source(q.academy_id,q.purpose,q.start_id);
 IF s IS NULL OR s->>'sourceFingerprint' IS DISTINCT FROM q.source_fingerprint THEN RETURN;END IF;
 e=public.signature_completion_job_evidence(q.academy_id,q.purpose,q.start_id,q.source_fingerprint);
 IF e IS NULL THEN RETURN;END IF;
 UPDATE public.signature_completion_jobs j SET state='complete',evidence_id=e,last_outcome='recorded',last_finished_at=clock_timestamp(),priority=0
 WHERE j.academy_id=q.academy_id AND j.purpose=q.purpose AND j.start_id=q.start_id;
END $$;
ALTER FUNCTION public.settle_signature_completion_evidence(uuid,text,uuid) OWNER TO kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.settle_signature_completion_evidence(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION public.settle_signature_completion_on_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME NOT IN('signature_completion_evidence','work_signature_completion_evidence') THEN RAISE EXCEPTION 'SIGNATURE_COMPLETION_TRIGGER_SCOPE_INVALID';END IF;
 PERFORM public.settle_signature_completion_evidence(NEW.academy_id,CASE WHEN TG_TABLE_NAME='work_signature_completion_evidence' THEN 'worker_services' ELSE 'unified_enrollment' END,NEW.start_id);
 RETURN NEW;
END $$;
ALTER FUNCTION public.settle_signature_completion_on_evidence() OWNER TO kavosh_signature_completion_policy;
REVOKE ALL ON FUNCTION public.settle_signature_completion_on_evidence() FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_completion_policy;
CREATE TRIGGER zz_signature_completion_settlement AFTER INSERT ON public.signature_completion_evidence FOR EACH ROW EXECUTE FUNCTION public.settle_signature_completion_on_evidence();
CREATE TRIGGER zz_work_signature_completion_settlement AFTER INSERT ON public.work_signature_completion_evidence FOR EACH ROW EXECUTE FUNCTION public.settle_signature_completion_on_evidence();
-- Upgrade only real matching evidence. Do not invent attempts or retrospective
-- incidents. The same validator and lock order apply to pre-upgrade records.
DO $$ DECLARE q record;BEGIN
 FOR q IN SELECT academy_id,purpose,start_id FROM public.signature_completion_jobs WHERE state IN('queued','blocked') ORDER BY academy_id,purpose,start_id LOOP
  PERFORM public.settle_signature_completion_evidence(q.academy_id,q.purpose,q.start_id);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 396 $$;

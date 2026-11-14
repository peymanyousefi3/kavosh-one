-- Future schedule batches advance classes.version,not past session evidence.
-- Legacy NULL uses the existing header revision until the next normal write:
-- no cross-tenant backfill,stored proof rewrite or previously stale revival.
ALTER TABLE public.classes ADD evidence_version integer CHECK(evidence_version IS NULL OR evidence_version>0);
CREATE FUNCTION public.class_evidence_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='INSERT' THEN NEW.evidence_version=NEW.version;
 ELSIF ROW(NEW.active,NEW.time_zone) IS DISTINCT FROM ROW(OLD.active,OLD.time_zone) THEN NEW.evidence_version=greatest(coalesce(OLD.evidence_version,OLD.version)+1,NEW.version);
 ELSE NEW.evidence_version=coalesce(OLD.evidence_version,OLD.version);END IF;RETURN NEW;
END $$;
CREATE TRIGGER class_evidence_revision_guard BEFORE INSERT OR UPDATE ON public.classes FOR EACH ROW EXECUTE FUNCTION public.class_evidence_revision_guard();
REVOKE ALL ON FUNCTION public.class_evidence_revision_guard() FROM PUBLIC;
-- The legacy opaque-context key classVersion now identifies the class facts
-- used by evidence (active/time zone),not unrelated header/schedule edits.
-- Actual classes.version still versions all class operations. Existing source
-- function OIDs/ACLs and native exact-source comparisons remain unchanged.
DO $$ DECLARE signature text;body text;BEGIN
 FOREACH signature IN ARRAY ARRAY['public.session_attendance_source(uuid)','public.session_report_source(uuid,jsonb)','public.student_feedback_source(uuid,uuid,uuid,integer,uuid)'] LOOP
  body=pg_get_functiondef(signature::regprocedure);
  IF position('c.version AS class_version' IN body)=0 THEN RAISE EXCEPTION 'CLASS_EVIDENCE_SOURCE_BASE_UNEXPECTED';END IF;
  body=replace(body,'c.version AS class_version','coalesce(c.evidence_version,c.version) AS class_version');EXECUTE body;
 END LOOP;
 body=pg_get_functiondef('public.session_evidence_snapshot(uuid)'::regprocedure);
 IF position('c.version class_version' IN body)=0 THEN RAISE EXCEPTION 'CLASS_EVIDENCE_SNAPSHOT_BASE_UNEXPECTED';END IF;
 body=replace(body,'c.version class_version','coalesce(c.evidence_version,c.version) class_version');EXECUTE body;
 body=pg_get_functiondef('public.homework_grade_source(uuid,integer,uuid)'::regprocedure);
 IF position('SELECT id,version,active INTO c FROM public.classes' IN body)=0 THEN RAISE EXCEPTION 'CLASS_GRADE_SOURCE_BASE_UNEXPECTED';END IF;
 body=replace(body,'SELECT id,version,active INTO c FROM public.classes','SELECT id,coalesce(evidence_version,version) AS version,active INTO c FROM public.classes');EXECUTE body;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 141 $$;

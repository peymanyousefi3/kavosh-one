-- Explicitly shared feedback stays separate from private review reasons and
-- from existing review JSON/history. No historical reason is auto-published.
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('session-staff-feedback.view','Read explicitly shared feedback for own reviewed teaching-team sessions','Learning',true,ARRAY['hub','class','country','region','city']);
CREATE TABLE public.session_evidence_staff_notes(
 academy_id uuid NOT NULL,session_id uuid NOT NULL,review_version integer NOT NULL CHECK(review_version>0),
 body text NOT NULL CHECK(body=btrim(body) AND body ~ '[^[:space:]]' AND length(body) BETWEEN 1 AND 2000),audience text NOT NULL DEFAULT 'session_teaching_team' CHECK(audience='session_teaching_team'),
 created_by uuid NOT NULL,approval_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,session_id,review_version),FOREIGN KEY(academy_id,session_id,review_version) REFERENCES public.session_evidence_review_revisions(academy_id,session_id,version),
 FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.session_evidence_staff_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_evidence_staff_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.session_evidence_staff_notes USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.session_evidence_staff_notes TO kavosh_runtime;
GRANT INSERT(academy_id,session_id,review_version,body,created_by,approval_id) ON public.session_evidence_staff_notes TO kavosh_runtime;
CREATE FUNCTION public.session_staff_note_recipient(p_source jsonb,p_person uuid) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN jsonb_typeof(p_source->'staff')='array' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(p_source->'staff') s WHERE s->>'personId'=p_person::text) ELSE false END
$$;
CREATE FUNCTION public.guard_session_staff_note() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r record;note jsonb;BEGIN
 SELECT a.payload,a.status,a.action,a.target_id,review.changed_by,review.approval_id INTO r FROM public.session_evidence_reviews review JOIN public.approval_requests a ON a.academy_id=review.academy_id AND a.id=review.approval_id WHERE review.academy_id=NEW.academy_id AND review.session_id=NEW.session_id AND review.version=NEW.review_version;
 note=r.payload->'staffNote';
 IF r.approval_id IS NULL OR r.approval_id IS DISTINCT FROM NEW.approval_id OR r.changed_by IS DISTINCT FROM NEW.created_by OR r.status<>'pending' OR r.action<>'session-evidence.decide' OR r.target_id IS DISTINCT FROM NEW.session_id
 OR jsonb_typeof(note) IS DISTINCT FROM 'object' OR jsonb_typeof(note->'text') IS DISTINCT FROM 'string' OR note->'audienceReviewed' IS DISTINCT FROM 'true'::jsonb OR note->>'text' IS DISTINCT FROM NEW.body OR NOT public.report_comment_human_verified(NEW.created_by) THEN RAISE EXCEPTION 'SESSION_STAFF_NOTE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM jsonb_object_keys(note))<>2 THEN RAISE EXCEPTION 'SESSION_STAFF_NOTE_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER session_staff_note_guard BEFORE INSERT ON public.session_evidence_staff_notes FOR EACH ROW EXECUTE FUNCTION public.guard_session_staff_note();
CREATE FUNCTION public.require_session_staff_note() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE note jsonb;BEGIN
 SELECT payload->'staffNote' INTO note FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF note IS NOT NULL AND note<>'null'::jsonb THEN
  IF NOT EXISTS(SELECT 1 FROM public.session_evidence_staff_notes n WHERE n.academy_id=NEW.academy_id AND n.session_id=NEW.session_id AND n.review_version=NEW.version AND n.approval_id=NEW.approval_id AND n.created_by=NEW.changed_by AND n.body=note->>'text') THEN RAISE EXCEPTION 'SESSION_STAFF_NOTE_MISSING' USING ERRCODE='23514';END IF;
 ELSIF EXISTS(SELECT 1 FROM public.session_evidence_staff_notes n WHERE n.academy_id=NEW.academy_id AND n.session_id=NEW.session_id AND n.review_version=NEW.version) THEN RAISE EXCEPTION 'SESSION_STAFF_NOTE_NOT_REQUESTED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER session_staff_note_required AFTER INSERT OR UPDATE ON public.session_evidence_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_session_staff_note();
REVOKE ALL ON FUNCTION public.session_staff_note_recipient(jsonb,uuid),public.guard_session_staff_note(),public.require_session_staff_note() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_staff_note_recipient(jsonb,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 89 $$;

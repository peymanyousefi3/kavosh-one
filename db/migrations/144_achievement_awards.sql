INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('achievements.view','View permitted private school-issued student achievements','Community',true,ARRAY['hub','class','person','country','region','city']),
 ('achievements.issue','Propose a reviewed school-issued achievement','Community',true,ARRAY['hub','class','person','country','region','city']),
 ('achievements.edit','Request reviewed achievement correction,revocation or restoration','Community',true,ARRAY['hub','class','person','country','region','city']);
CREATE TABLE public.achievement_awards(
 academy_id uuid NOT NULL,id uuid NOT NULL,student_id uuid NOT NULL,hub_id uuid,class_id uuid,type_id uuid NOT NULL,type_version integer NOT NULL,
 reference text NOT NULL CHECK(reference~'^[A-Z0-9][A-Z0-9._-]{0,63}$'),earned_on date NOT NULL CHECK(earned_on>=date '1900-01-01'),caption text NOT NULL CHECK(length(btrim(caption)) BETWEEN 1 AND 4000),
 status text NOT NULL CHECK(status IN('awarded','revoked')),version integer NOT NULL DEFAULT 1 CHECK(version>0),context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'),
 issued_by uuid NOT NULL,changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE(academy_id,reference),FOREIGN KEY(academy_id,student_id) REFERENCES public.student_profiles(academy_id,person_id),
 FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),FOREIGN KEY(academy_id,class_id,hub_id) REFERENCES public.classes(academy_id,id,hub_id),
 FOREIGN KEY(academy_id,type_id,type_version) REFERENCES public.achievement_type_revisions(academy_id,type_id,version),
 FOREIGN KEY(academy_id,issued_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),CHECK(class_id IS NULL OR hub_id IS NOT NULL)
);
CREATE INDEX achievement_award_student ON public.achievement_awards(academy_id,student_id,earned_on,id);
CREATE INDEX achievement_award_hub ON public.achievement_awards(academy_id,hub_id,id);
CREATE TABLE public.achievement_award_revisions(academy_id uuid NOT NULL,award_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,award_id,version),FOREIGN KEY(academy_id,award_id) REFERENCES public.achievement_awards(academy_id,id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['achievement_awards','achievement_award_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);END LOOP;END $$;
GRANT INSERT(academy_id,id,student_id,hub_id,class_id,type_id,type_version,reference,earned_on,caption,status,context,issued_by,changed_by,approval_id,reason) ON public.achievement_awards TO kavosh_runtime;
GRANT UPDATE(version,caption,status,context,changed_by,approval_id,reason) ON public.achievement_awards TO kavosh_runtime;
GRANT INSERT(academy_id,award_id,version,definition) ON public.achievement_award_revisions TO kavosh_runtime;
CREATE FUNCTION public.achievement_award_scope(student uuid,hub uuid,class uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',student,'hubId',hub)))||CASE WHEN class IS NULL THEN jsonb_build_object('workContext',jsonb_build_object('personId',student,'hubId',hub)) ELSE jsonb_build_object('classes',jsonb_build_array(jsonb_build_object('id',class,'hubId',hub)),'recordContext',jsonb_build_object('classId',class,'hubId',hub,'studentId',student)) END
$$;
CREATE FUNCTION public.achievement_award_source(student uuid,typ uuid,revision integer,class uuid,earned date,award uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;p record;t record;c record;e record;h record;r record;hub uuid;zone text;BEGIN
 SELECT x.id,x.hub_id,x.kind,x.status,earned>=s.date_of_birth born_before_award INTO p FROM public.people x JOIN public.student_profiles s ON s.academy_id=x.academy_id AND s.person_id=x.id WHERE x.academy_id=tenant AND x.id=student AND x.kind='human';IF p.id IS NULL THEN RETURN NULL;END IF;
 SELECT x.id,x.hub_id,x.version current_version,(x.definition->>'active')::boolean active,v.definition->'definition' definition INTO t FROM public.achievement_types x JOIN public.achievement_type_revisions v ON v.academy_id=x.academy_id AND v.type_id=x.id AND v.version=revision WHERE x.academy_id=tenant AND x.id=typ;IF t.id IS NULL THEN RETURN NULL;END IF;
 SELECT x.id,x.hub_id,x.active,x.time_zone,coalesce(x.evidence_version,x.version) evidence_version INTO c FROM public.classes x WHERE x.academy_id=tenant AND x.id=class;IF class IS NOT NULL AND c.id IS NULL THEN RETURN NULL;END IF;
 SELECT id,hub_id INTO r FROM public.achievement_awards WHERE academy_id=tenant AND id=award;hub=CASE WHEN r.id IS NOT NULL THEN r.hub_id WHEN class IS NULL THEN p.hub_id ELSE c.hub_id END;
 SELECT id,version,joins_on,leaves_on,enabled INTO e FROM public.class_enrollments WHERE academy_id=tenant AND class_id=class AND student_id=student AND enabled AND joins_on<=earned AND(leaves_on IS NULL OR leaves_on>=earned);
 SELECT id,active,time_zone INTO h FROM public.hubs WHERE academy_id=tenant AND id=hub;zone=coalesce(c.time_zone,h.time_zone,'UTC');
 RETURN jsonb_build_object('student',to_jsonb(p),'type',to_jsonb(t)||jsonb_build_object('pinnedVersion',revision),'class',CASE WHEN class IS NULL THEN 'null'::jsonb ELSE to_jsonb(c) END,'enrollment',CASE WHEN e.id IS NULL THEN 'null'::jsonb ELSE to_jsonb(e) END,'hubId',hub,'earnedOn',earned,'dateBasisTimeZone',zone,
 'eligible',p.status='active' AND p.born_before_award AND t.active AND(typ IS NOT NULL AND coalesce(t.hub_id IS NULL OR t.hub_id=hub,false)) AND(hub IS NULL OR h.active) AND earned>=date '1900-01-01' AND earned<=(clock_timestamp() AT TIME ZONE zone)::date AND(class IS NULL OR(coalesce(c.active,false) AND coalesce(e.enabled,false))));
END $$;
CREATE FUNCTION public.guard_achievement_award() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE p record;s jsonb;before jsonb;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ACHIEVEMENT_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.version<>OLD.version+1 OR ROW(NEW.academy_id,NEW.id,NEW.student_id,NEW.hub_id,NEW.class_id,NEW.type_id,NEW.type_version,NEW.reference,NEW.earned_on,NEW.issued_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.academy_id,OLD.id,OLD.student_id,OLD.hub_id,OLD.class_id,OLD.type_id,OLD.type_version,OLD.reference,OLD.earned_on,OLD.issued_by,OLD.created_at) THEN RAISE EXCEPTION 'ACHIEVEMENT_IDENTITY_OR_VERSION_CHANGED' USING ERRCODE='23514';END IF;before=to_jsonb(OLD);
 ELSIF NEW.version<>1 OR NEW.status<>'awarded' OR NEW.issued_by<>NEW.changed_by THEN RAISE EXCEPTION 'ACHIEVEMENT_INITIAL_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 s=public.achievement_award_source(NEW.student_id,NEW.type_id,NEW.type_version,NEW.class_id,NEW.earned_on,NEW.id);SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF s IS NULL OR p.id IS NULL OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR p.target_version<>coalesce(OLD.version,0) OR p.privacy_capability IS DISTINCT FROM 'achievements.view'
 OR NEW.hub_id IS DISTINCT FROM(s->>'hubId')::uuid OR NEW.context IS DISTINCT FROM s OR p.review_context IS DISTINCT FROM jsonb_build_object('before',before,'source',s)
 OR p.payload->>'caption' IS DISTINCT FROM NEW.caption OR p.payload->>'reason' IS DISTINCT FROM NEW.reason OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND status='active' AND kind='human') THEN RAISE EXCEPTION 'ACHIEVEMENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF(NEW.changed_by=NEW.student_id OR EXISTS(SELECT 1 FROM public.family_relationships WHERE academy_id=NEW.academy_id AND student_id=NEW.student_id AND guardian_id=NEW.changed_by)) AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'ACHIEVEMENT_BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF p.action<>'achievement.issue' OR(p.payload->>'studentId')::uuid IS DISTINCT FROM NEW.student_id OR(p.payload->>'classId')::uuid IS DISTINCT FROM NEW.class_id OR(p.payload->>'typeId')::uuid IS DISTINCT FROM NEW.type_id OR(p.payload->>'typeVersion')::integer IS DISTINCT FROM NEW.type_version OR(p.payload->>'earnedOn')::date IS DISTINCT FROM NEW.earned_on OR p.payload->>'reference' IS DISTINCT FROM NEW.reference OR s->>'eligible' IS DISTINCT FROM 'true' OR(s#>>'{type,current_version}')::integer<>NEW.type_version THEN RAISE EXCEPTION 'ACHIEVEMENT_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 ELSE
  IF p.action<>'achievement.change' OR(p.payload->>'expectedVersion')::integer IS DISTINCT FROM OLD.version OR p.payload->>'status' IS DISTINCT FROM NEW.status OR(OLD.status='revoked' AND NEW.status='awarded' AND s->>'eligible' IS DISTINCT FROM 'true') THEN RAISE EXCEPTION 'ACHIEVEMENT_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 END IF;NEW.changed_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER achievement_award_guard BEFORE INSERT OR UPDATE OR DELETE ON public.achievement_awards FOR EACH ROW EXECUTE FUNCTION public.guard_achievement_award();
CREATE FUNCTION public.guard_achievement_award_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM public.achievement_awards a WHERE a.academy_id=NEW.academy_id AND a.id=NEW.award_id AND a.version=NEW.version AND to_jsonb(a)=NEW.definition) THEN RAISE EXCEPTION 'ACHIEVEMENT_EXACT_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER achievement_award_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.achievement_award_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_achievement_award_revision();
CREATE FUNCTION public.require_achievement_award_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.achievement_award_revisions r WHERE r.academy_id=NEW.academy_id AND r.award_id=NEW.id AND r.version=NEW.version AND r.definition=to_jsonb(NEW)) OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=NEW.changed_by) THEN RAISE EXCEPTION 'ACHIEVEMENT_APPLIED_REVIEW_AND_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER achievement_award_revision_required AFTER INSERT OR UPDATE ON public.achievement_awards DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_achievement_award_revision();
CREATE FUNCTION public.achievement_award_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE student uuid;hub uuid;class uuid;BEGIN
 IF NEW.action='achievement.issue' THEN student=(NEW.payload->>'studentId')::uuid;class=(NEW.payload->>'classId')::uuid;SELECT CASE WHEN class IS NULL THEN p.hub_id ELSE c.hub_id END INTO hub FROM public.student_profiles s JOIN public.people p ON p.academy_id=s.academy_id AND p.id=s.person_id LEFT JOIN public.classes c ON c.academy_id=s.academy_id AND c.id=class WHERE s.academy_id=NEW.academy_id AND s.person_id=student AND(class IS NULL OR c.id IS NOT NULL);
  IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 ELSE SELECT student_id,hub_id,class_id INTO student,hub,class FROM public.achievement_awards WHERE academy_id=NEW.academy_id AND id=NEW.target_id;IF NOT FOUND THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','achievements.view','scope',public.achievement_award_scope(student,hub,class)));RETURN NEW;
 EXCEPTION WHEN invalid_text_representation THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END $$;
CREATE TRIGGER zz_achievement_award_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action IN('achievement.issue','achievement.change')) EXECUTE FUNCTION public.achievement_award_privacy();
REVOKE ALL ON FUNCTION public.achievement_award_scope(uuid,uuid,uuid),public.achievement_award_source(uuid,uuid,integer,uuid,date,uuid),public.guard_achievement_award(),public.guard_achievement_award_revision(),public.require_achievement_award_revision(),public.achievement_award_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.achievement_award_scope(uuid,uuid,uuid),public.achievement_award_source(uuid,uuid,integer,uuid,date,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 144 $$;

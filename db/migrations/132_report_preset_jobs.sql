ALTER TABLE public.report_jobs ADD preset_id uuid,ADD preset_version integer,ADD window_resolution jsonb,
 ADD CHECK((preset_id IS NULL)=(preset_version IS NULL)),ADD CHECK(preset_version IS NULL OR preset_version>0),
 ADD FOREIGN KEY(academy_id,preset_id,preset_version) REFERENCES public.report_preset_revisions(academy_id,preset_id,version),
 ADD CHECK(window_resolution IS NULL OR(jsonb_typeof(window_resolution)='object' AND octet_length(window_resolution::text)<=16384));
GRANT INSERT(preset_id,preset_version,window_resolution) ON public.report_jobs TO kavosh_runtime;
GRANT SELECT ON public.report_presets,public.report_preset_revisions TO kavosh_automation_policy;
-- PostgreSQL row-share locks require UPDATE on at least one column. This is
-- solely for the final source fence;existing immutable/review/FK guards still
-- prevent advancing a preset without its exact reviewed revision.
GRANT UPDATE(version) ON public.report_presets TO kavosh_automation_policy;
CREATE FUNCTION public.report_job_preset_current(p_id uuid,p_version integer) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.report_presets p JOIN public.report_preset_revisions v ON v.academy_id=p.academy_id AND v.preset_id=p.id AND v.version=p_version
 WHERE p.id=p_id AND p.version>=p_version AND v.definition->'active'='true'::jsonb AND NOT EXISTS(
  SELECT 1 FROM public.report_preset_revisions later WHERE later.academy_id=p.academy_id AND later.preset_id=p.id AND later.version>p_version
   AND(later.definition-ARRAY['name','translations']) IS DISTINCT FROM(v.definition-ARRAY['name','translations'])))
$$;
CREATE FUNCTION public.report_job_preset_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE a jsonb;d jsonb;w jsonb;fields text[];BEGIN
 SELECT changes INTO a FROM public.audit_events WHERE academy_id=NEW.academy_id AND id=NEW.audit_id;
 IF a->'preset' IS DISTINCT FROM(CASE WHEN NEW.preset_id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('id',NEW.preset_id,'version',NEW.preset_version) END) OR a->'windowResolution' IS DISTINCT FROM coalesce(NEW.window_resolution,'null'::jsonb) THEN RAISE EXCEPTION 'REPORT_JOB_PROVENANCE_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.preset_id IS NOT NULL THEN
  PERFORM 1 FROM public.report_presets WHERE academy_id=NEW.academy_id AND id=NEW.preset_id FOR SHARE;
  SELECT definition INTO d FROM public.report_preset_revisions WHERE academy_id=NEW.academy_id AND preset_id=NEW.preset_id AND version=NEW.preset_version;
  IF NOT public.report_job_preset_current(NEW.preset_id,NEW.preset_version) OR d->>'reportId' IS DISTINCT FROM NEW.configuration->>'reportId' THEN RAISE EXCEPTION 'REPORT_PRESET_CHANGED' USING ERRCODE='23514';END IF;
  IF d->'dateWindow' IS DISTINCT FROM NEW.window_resolution->'window' THEN RAISE EXCEPTION 'REPORT_JOB_WINDOW_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.window_resolution IS NOT NULL THEN
  w=NEW.window_resolution;
  IF NOT(w ?& ARRAY['window','resolvedAt','from','through','calendar','interval','effectiveParameters','overriddenFields']) OR w-ARRAY['window','resolvedAt','from','through','calendar','interval','effectiveParameters','overriddenFields']<>'{}'::jsonb
   OR w->>'calendar' IS DISTINCT FROM 'iso8601' OR w->>'interval' IS DISTINCT FROM 'inclusive_civil_days' OR jsonb_typeof(w->'resolvedAt') IS DISTINCT FROM 'string' OR(w->>'resolvedAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
   OR jsonb_typeof(w->'from') IS DISTINCT FROM 'string' OR jsonb_typeof(w->'through') IS DISTINCT FROM 'string' OR(w->>'from')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR(w->>'through')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   OR jsonb_typeof(w->'effectiveParameters') IS DISTINCT FROM 'object' OR jsonb_typeof(w->'overriddenFields') IS DISTINCT FROM 'array'
   OR NOT public.report_preset_definition_valid(jsonb_build_object('name','Window validation','translations','{}'::jsonb,'reportId',NEW.configuration->>'reportId','queryContractVersion',1,'parameters','{}'::jsonb,'pathParameters','{}'::jsonb,'active',true,'dateWindow',w->'window'))
   THEN RAISE EXCEPTION 'REPORT_JOB_WINDOW_INVALID' USING ERRCODE='23514';END IF;
  fields=CASE WHEN NEW.configuration->>'reportId'='finance.profit-loss' THEN ARRAY['from','through'] ELSE ARRAY['through'] END;
  IF(w->>'from')::date>(w->>'through')::date OR NOT(w->'effectiveParameters' ?& fields) OR(w->'effectiveParameters')-fields<>'{}'::jsonb
   OR EXISTS(SELECT 1 FROM jsonb_each(w->'effectiveParameters') e WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'string' OR e.value IS DISTINCT FROM NEW.configuration#>ARRAY['parameters',e.key])
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(w->'overriddenFields') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR NOT(x#>>'{}')=ANY(fields)) THEN RAISE EXCEPTION 'REPORT_JOB_WINDOW_BINDING_INVALID' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER report_job_preset_guard BEFORE INSERT ON public.report_jobs FOR EACH ROW EXECUTE FUNCTION public.report_job_preset_guard();
CREATE FUNCTION public.report_result_preset_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE j record;BEGIN
 SELECT preset_id,preset_version INTO j FROM public.report_jobs WHERE academy_id=NEW.academy_id AND id=NEW.job_id;
 IF j.preset_id IS NOT NULL THEN PERFORM 1 FROM public.report_presets WHERE academy_id=NEW.academy_id AND id=j.preset_id FOR SHARE;
  IF NOT public.report_job_preset_current(j.preset_id,j.preset_version) THEN RAISE EXCEPTION 'REPORT_PRESET_CHANGED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER report_result_preset_guard BEFORE INSERT ON public.report_job_results FOR EACH ROW EXECUTE FUNCTION public.report_result_preset_guard();
REVOKE ALL ON FUNCTION public.report_job_preset_current(uuid,integer),public.report_job_preset_guard(),public.report_result_preset_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_job_preset_current(uuid,integer) TO kavosh_runtime,kavosh_automation_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 132 $$;

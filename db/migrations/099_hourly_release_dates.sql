-- Keep published098 and all old accounting history unchanged. New hourly
-- replacements cannot predate the financial reversal releasing their source.
ALTER TABLE public.payroll_hourly_accruals ADD COLUMN release_date_policy integer NOT NULL DEFAULT 0 CHECK(release_date_policy IN(0,1));
CREATE INDEX hourly_released_time ON public.payroll_hourly_claims USING gist(academy_id,person_id,int8range(start_ms,end_ms,'[)')) WHERE release_id IS NOT NULL;
CREATE INDEX hourly_released_source ON public.payroll_hourly_entry_sources(academy_id,entry_id,entry_version,pricing_fingerprint) WHERE release_id IS NOT NULL;
CREATE FUNCTION public.hourly_release_floor(p_person uuid,p_claims jsonb,p_identities jsonb,p_exclude uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH released AS(
  SELECT c.release_id FROM jsonb_array_elements(p_claims) r JOIN public.payroll_hourly_claims c
   ON c.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND c.person_id=p_person AND c.release_id IS NOT NULL AND(p_exclude IS NULL OR c.accrual_id<>p_exclude)
   AND int8range(c.start_ms,c.end_ms,'[)')&&int8range((r->>'start')::bigint,(r->>'end')::bigint,'[)')
  UNION ALL
  SELECT c.release_id FROM jsonb_array_elements(p_identities) i JOIN public.payroll_hourly_entry_sources c
   ON c.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND c.person_id=p_person AND c.entry_id=(i->>'entryId')::uuid AND c.release_id IS NOT NULL AND(p_exclude IS NULL OR c.accrual_id<>p_exclude)
   AND(c.entry_version<>(i->>'entryVersion')::integer OR c.pricing_fingerprint<>i->>'pricingFingerprint')
 ) SELECT max(j.posted_on) FROM released r JOIN public.finance_journals j ON j.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND j.id=r.release_id
$$;
CREATE FUNCTION public.hourly_release_date_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE floor_on date;BEGIN
 IF TG_WHEN='BEFORE' THEN NEW.release_date_policy=1;RETURN NEW;END IF;
 PERFORM public.lock_hourly_worker(NEW.person_id);
 floor_on=public.hourly_release_floor(NEW.person_id,NEW.earning_plan->'timeClaims',NEW.earning_plan->'sourceIdentities',NEW.id);
 -- The floor is part of the reviewed server-generated plan, never a client
 -- override. Recheck at commit, including any late in-transaction releases.
 IF NEW.release_date_policy<>1 OR NEW.earning_plan->'releaseFloorOn' IS DISTINCT FROM coalesce(to_jsonb(floor_on::text),'null'::jsonb) THEN RAISE EXCEPTION 'HOURLY_RELEASE_DATE_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF floor_on IS NOT NULL AND NEW.posted_on<floor_on THEN RAISE EXCEPTION 'HOURLY_CORRECTION_DATE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER hourly_release_date_complete AFTER INSERT ON public.payroll_hourly_accruals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.hourly_release_date_complete();
CREATE TRIGGER hourly_release_policy BEFORE INSERT ON public.payroll_hourly_accruals FOR EACH ROW EXECUTE FUNCTION public.hourly_release_date_complete();
REVOKE ALL ON FUNCTION public.hourly_release_floor(uuid,jsonb,jsonb,uuid),public.hourly_release_date_complete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hourly_release_floor(uuid,jsonb,jsonb,uuid) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 99 $$;

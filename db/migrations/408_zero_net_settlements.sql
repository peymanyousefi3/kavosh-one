-- An explicit human-reviewed zero-net settlement date is not a cash payment,
-- remittance,statutory classification or automatic year-end tax recognition.
CREATE TABLE public.zero_net_settlements(
 academy_id uuid NOT NULL,posting_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,posting_id),FOREIGN KEY(academy_id,posting_id) REFERENCES public.payrun_net_postings(academy_id,id)
);
CREATE TABLE public.zero_net_settlement_revisions(
 academy_id uuid NOT NULL,posting_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),state text NOT NULL CHECK(state IN('recorded','withdrawn')),
 definition jsonb NOT NULL,source_snapshot jsonb NOT NULL CHECK(octet_length(source_snapshot::text)<=1048576),changed_by uuid NOT NULL,approval_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000 AND reason!~'[[:cntrl:]]'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,posting_id,version),UNIQUE(academy_id,approval_id),FOREIGN KEY(academy_id,posting_id) REFERENCES public.zero_net_settlements(academy_id,posting_id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
ALTER TABLE public.zero_net_settlements ADD CONSTRAINT zero_net_current_revision FOREIGN KEY(academy_id,posting_id,version) REFERENCES public.zero_net_settlement_revisions(academy_id,posting_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['zero_net_settlements','zero_net_settlement_revisions'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_runtime',t);
 EXECUTE format('CREATE TRIGGER zero_net_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_expense_commitment_write()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion()',t);
 EXECUTE format('CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate()',t);
END LOOP;END $$;
GRANT INSERT(academy_id,posting_id),UPDATE(version) ON public.zero_net_settlements TO kavosh_runtime;
GRANT INSERT(academy_id,posting_id,version,definition,source_snapshot,changed_by,approval_id,reason) ON public.zero_net_settlement_revisions TO kavosh_runtime;
CREATE FUNCTION public.zero_net_settlement_plan(p_posting uuid,p_before integer,d jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p record;g record;h record;b jsonb;s jsonb;settled timestamptz;on_day date;keys text[]:=ARRAY['settledAt','timeZone','reference','review'];k text;BEGIN
 IF p_before NOT BETWEEN 0 AND 2147483646 OR d IS NULL THEN RETURN jsonb_build_object('unavailable','ZERO_NET_SETTLEMENT_INPUT_INVALID');END IF;
 SELECT * INTO p FROM public.payrun_net_postings WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_posting;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO g FROM public.payrun_groups WHERE academy_id=p.academy_id AND id=p.run_id;PERFORM public.lock_hourly_worker(g.person_id);
 SELECT * INTO h FROM public.zero_net_settlements WHERE academy_id=p.academy_id AND posting_id=p.id;
 IF(h.posting_id IS NULL AND p_before<>0) OR(h.posting_id IS NOT NULL AND h.version NOT IN(p_before,p_before+1)) THEN RETURN jsonb_build_object('unavailable','ZERO_NET_SETTLEMENT_VERSION_CHANGED');END IF;
 SELECT jsonb_build_object('version',version,'state',state,'definition',definition) INTO b FROM public.zero_net_settlement_revisions WHERE academy_id=p.academy_id AND posting_id=p.id AND version=p_before;
 IF d='null'::jsonb THEN
  IF b->>'state' IS DISTINCT FROM 'recorded' THEN RETURN jsonb_build_object('unavailable','ZERO_NET_SETTLEMENT_WITHDRAWAL_UNAVAILABLE');END IF;
 ELSE
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d?&keys) OR d-keys<>'{}'::jsonb OR octet_length(d::text)>16384 THEN RETURN jsonb_build_object('unavailable','ZERO_NET_SETTLEMENT_INPUT_INVALID');END IF;
  FOREACH k IN ARRAY keys LOOP IF jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR d->>k~'[[:cntrl:]]' OR length(btrim(d->>k))<1 THEN RETURN jsonb_build_object('unavailable','ZERO_NET_SETTLEMENT_INPUT_INVALID');END IF;END LOOP;
  IF length(d->>'settledAt')>40 OR d->>'settledAt'!~'^[12][0-9]{3}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-5][0-9])$'
   OR length(d->>'timeZone')>100 OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=d->>'timeZone') OR length(d->>'reference')>200 OR length(d->>'review')>2000 THEN RETURN jsonb_build_object('unavailable','ZERO_NET_SETTLEMENT_INPUT_INVALID');END IF;
  BEGIN settled=(d->>'settledAt')::timestamptz;on_day=(settled AT TIME ZONE(d->>'timeZone'))::date;EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN jsonb_build_object('unavailable','ZERO_NET_SETTLEMENT_INPUT_INVALID');END;
  IF settled>transaction_timestamp() OR on_day<'1900-01-01'::date THEN RETURN jsonb_build_object('unavailable','ZERO_NET_SETTLEMENT_ACTUAL_DATE_REQUIRED');END IF;
  s=public.payrun_net_source(p.run_id);
  IF p.reversal_id IS NOT NULL OR s IS NULL OR s->'recordedSourcesCurrent' IS DISTINCT FROM 'true'::jsonb OR s->'cancellationId'<>'null'::jsonb OR s->>'runSourceSha256' IS DISTINCT FROM p.plan#>>'{source,runSourceSha256}' THEN RETURN jsonb_build_object('unavailable','ZERO_NET_SETTLEMENT_ACTIVE_CURRENT_POSTING_REQUIRED');END IF;
  IF p.plan#>>'{net,amounts,netMinor}' IS DISTINCT FROM '0' OR coalesce((p.plan#>>'{net,amounts,grossMinor}')::numeric,0)<=0 OR EXISTS(SELECT 1 FROM public.payrun_payments WHERE academy_id=p.academy_id AND posting_id=p.id) THEN RETURN jsonb_build_object('unavailable','ZERO_NET_SETTLEMENT_POSITIVE_GROSS_ZERO_NET_REQUIRED');END IF;
 END IF;
 RETURN jsonb_build_object('posting',jsonb_build_object('id',p.id,'runId',p.run_id,'netVersion',p.net_version,'reversalId',p.reversal_id,'planSha256',encode(sha256(convert_to(p.plan::text,'UTF8')),'hex')),
  'source',jsonb_build_object('personId',g.person_id,'runId',g.id,'scope',p.plan#>'{source,scope}','currencyId',g.currency_id,'unitScale',g.unit_scale),
  'accounts',p.plan->'accounts','before',b,'settledOn',on_day::text,'unavailable',NULL);
END $$;
CREATE FUNCTION public.zero_net_settlement_header_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE person uuid;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ZERO_NET_SETTLEMENT_HISTORY_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT g.person_id INTO person FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id WHERE p.academy_id=NEW.academy_id AND p.id=NEW.posting_id;PERFORM public.lock_hourly_worker(person);
 IF(TG_OP='INSERT' AND NEW.version<>1) OR(TG_OP='UPDATE' AND(NEW.version<>OLD.version+1 OR(to_jsonb(NEW)-'version') IS DISTINCT FROM(to_jsonb(OLD)-'version'))) THEN RAISE EXCEPTION 'ZERO_NET_SETTLEMENT_IDENTITY_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER zero_net_settlement_header BEFORE INSERT OR UPDATE OR DELETE ON public.zero_net_settlements FOR EACH ROW EXECUTE FUNCTION public.zero_net_settlement_header_guard();
CREATE FUNCTION public.zero_net_settlement_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;p record;b jsonb;i jsonb;BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'ZERO_NET_SETTLEMENT_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO h FROM public.zero_net_settlements WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id;
 i=jsonb_build_object('postingId',NEW.posting_id,'expectedVersion',NEW.version-1,'definition',NEW.definition,'reason',NEW.reason);b=public.zero_net_settlement_plan(NEW.posting_id,NEW.version-1,NEW.definition);
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF h.posting_id IS NULL OR h.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.zero_net_settlement_revisions WHERE academy_id=NEW.academy_id AND posting_id=NEW.posting_id)
  OR b IS NULL OR b->>'unavailable' IS NOT NULL OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'work.zero-net-settlement.change' OR p.target_id IS DISTINCT FROM NEW.posting_id OR p.target_version<>NEW.version-1
  OR p.payload IS DISTINCT FROM i OR p.privacy_capability IS DISTINCT FROM 'payrun-payments.view' OR p.scope IS DISTINCT FROM b#>'{source,scope}' OR p.review_context IS DISTINCT FROM b OR NEW.source_snapshot IS DISTINCT FROM b OR NOT public.report_comment_human_verified(NEW.changed_by) THEN RAISE EXCEPTION 'ZERO_NET_SETTLEMENT_EXACT_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.changed_by::text=b#>>'{source,personId}' AND NOT EXISTS(SELECT 1 FROM public.academies WHERE id=NEW.academy_id AND master_person_id=NEW.changed_by) THEN RAISE EXCEPTION 'BENEFICIARY_REVIEW_FORBIDDEN' USING ERRCODE='23514';END IF;
 NEW.state=CASE WHEN NEW.definition='null'::jsonb THEN 'withdrawn' ELSE 'recorded' END;NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER zero_net_settlement_revision BEFORE INSERT OR UPDATE OR DELETE ON public.zero_net_settlement_revisions FOR EACH ROW EXECUTE FUNCTION public.zero_net_settlement_revision_guard();
CREATE CONSTRAINT TRIGGER zero_net_settlement_reviewed AFTER INSERT ON public.zero_net_settlement_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reviewed_approval_complete();
CREATE FUNCTION public.zero_net_settlement_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF public.zero_net_settlement_plan(NEW.posting_id,NEW.version-1,NEW.definition) IS DISTINCT FROM NEW.source_snapshot OR NOT EXISTS(SELECT 1 FROM public.audit_events WHERE academy_id=NEW.academy_id AND entity_id=NEW.posting_id AND actor_id=NEW.changed_by AND action='work.zero-net-settlement.change' AND created_at=transaction_timestamp() AND changes->'version'=to_jsonb(NEW.version) AND changes->>'approvalId'=NEW.approval_id::text AND changes->>'severity'='critical' AND changes->'privateContentRedacted'='true'::jsonb AND changes->'paymentExecuted'='false'::jsonb AND changes->'additionalLedgerPosting'='false'::jsonb) THEN RAISE EXCEPTION 'ZERO_NET_SETTLEMENT_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zero_net_settlement_complete AFTER INSERT ON public.zero_net_settlement_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.zero_net_settlement_complete();
CREATE FUNCTION public.zero_net_settlement_effect_required() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NEW.action='work.zero-net-settlement.change' AND NEW.status='applied' AND NOT EXISTS(SELECT 1 FROM public.zero_net_settlement_revisions WHERE academy_id=NEW.academy_id AND posting_id=NEW.target_id AND version=NEW.target_version+1 AND approval_id=NEW.id AND changed_by=NEW.reviewer_id) THEN RAISE EXCEPTION 'ZERO_NET_SETTLEMENT_EFFECT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zero_net_settlement_effect AFTER INSERT OR UPDATE ON public.approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.zero_net_settlement_effect_required();
CREATE TRIGGER zz_zero_net_source_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.zero-net-settlement.change') EXECUTE FUNCTION public.payrun_posting_privacy();
CREATE FUNCTION public.zero_net_settlement_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','payrun-postings.view','scope',NEW.scope));RETURN NEW;
END $$;
CREATE TRIGGER zzz_zero_net_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='work.zero-net-settlement.change') EXECUTE FUNCTION public.zero_net_settlement_privacy();
REVOKE ALL ON FUNCTION public.zero_net_settlement_plan(uuid,integer,jsonb),public.zero_net_settlement_header_guard(),public.zero_net_settlement_revision_guard(),public.zero_net_settlement_complete(),public.zero_net_settlement_effect_required(),public.zero_net_settlement_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.zero_net_settlement_plan(uuid,integer,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 408 $$;

-- Private durable source capture for resumable report rendering. Reuse the
-- canonical monetary CTEs;do not assemble a200000member JSON array in Node.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kavosh_report_capture_policy') THEN CREATE ROLE kavosh_report_capture_policy NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kavosh_report_capture_policy' AND(rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'UNSAFE_REPORT_CAPTURE_POLICY';END IF;
END $$;
GRANT kavosh_runtime TO kavosh_report_capture_policy;
CREATE TABLE public.counterparty_report_captures(
 academy_id uuid NOT NULL,job_id uuid NOT NULL,lease_token uuid NOT NULL,request_id uuid NOT NULL,frame jsonb NOT NULL,source_metadata jsonb,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),created_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(academy_id,job_id),UNIQUE(academy_id,request_id),FOREIGN KEY(academy_id,job_id) REFERENCES public.report_jobs(academy_id,id),
 CHECK(octet_length(frame::text)<=16384),CHECK(source_metadata IS NULL OR octet_length(source_metadata::text)<=1048576));
CREATE TABLE public.counterparty_report_capture_rows(
 academy_id uuid NOT NULL,job_id uuid NOT NULL,section smallint NOT NULL CHECK(section BETWEEN 0 AND 4),ordinal integer NOT NULL,payload jsonb NOT NULL,
 PRIMARY KEY(academy_id,job_id,section,ordinal),FOREIGN KEY(academy_id,job_id) REFERENCES public.counterparty_report_captures(academy_id,job_id),
 CHECK((section=0 AND ordinal=0) OR(section=1 AND ordinal BETWEEN 1 AND 1000) OR(section IN(2,4) AND ordinal BETWEEN 1 AND 200000) OR(section=3 AND ordinal BETWEEN 1 AND 10000)),
 CHECK(jsonb_typeof(payload)=CASE WHEN section=4 THEN 'array' ELSE 'object' END),CHECK(octet_length(payload::text)<=CASE WHEN section=0 THEN 1048576 ELSE 16384 END));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['counterparty_report_captures','counterparty_report_capture_rows'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT ON public.%I TO kavosh_report_capture_policy,kavosh_automation_worker',t);EXECUTE format('GRANT INSERT ON public.%I TO kavosh_report_capture_policy',t);
END LOOP;END $$;
GRANT UPDATE(source_metadata) ON public.counterparty_report_captures TO kavosh_report_capture_policy;
DO $derive$
DECLARE source text;summary text;prefix text;marker text:='SELECT statement_timestamp()::text AS "snapshotAt"';p integer;
BEGIN
 SELECT prosrc INTO source FROM pg_proc WHERE oid='public.counterparty_statement_snapshot_read(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)'::regprocedure;
 IF(length(source)-length(replace(source,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'REPORT_CAPTURE_KERNEL_BASE_CHANGED';END IF;
 p=position(marker IN source);prefix=left(source,p-1);summary=regexp_replace(substring(source FROM p),';[[:space:]]*END[[:space:]]*$','');
 IF summary=substring(source FROM p) OR position('CASE WHEN $11 AND' IN summary)=0 THEN RAISE EXCEPTION 'REPORT_CAPTURE_SUMMARY_BASE_CHANGED';END IF;
 -- Source membership is emitted as bounded rows below,not a giant JSON value.
 summary=replace(summary,'CASE WHEN $11 AND','CASE WHEN false AND');
 source=prefix||', capture_summary AS MATERIALIZED('||summary||')'||$tail$
 SELECT 0::smallint,0,to_jsonb(s)-ARRAY['currencies','entries','days','sourceManifest'] FROM capture_summary s
 UNION ALL
 SELECT 1::smallint,row_number() OVER(ORDER BY c.code,t.currency_id)::integer,to_jsonb(t)||jsonb_build_object('currencyCode',c.code)
 FROM totals t JOIN public.finance_currencies c ON c.id=t.currency_id WHERE(SELECT allowed FROM proof_gate)
 UNION ALL
 SELECT 2::smallint,row_number() OVER(ORDER BY w.posted_on,w.journal_id,w.family COLLATE "C",w.line_number)::integer,
 jsonb_build_object('journalId',w.journal_id,'lineNumber',w.line_number,'postedOn',w.posted_on::text,'currencyId',w.currency_id,'currencyCode',c.code,'scale',w.scale,'family',w.family,'category',w.category,'correctionOfId',w.correction_of,'change',w.amount::text,'balance',w.balance::text)
 FROM windowed w JOIN public.finance_currencies c ON c.id=w.currency_id WHERE(SELECT allowed FROM proof_gate)
 UNION ALL
 SELECT 3::smallint,row_number() OVER(ORDER BY d."postedOn",d.currency_id)::integer,to_jsonb(d)||jsonb_build_object('currencyCode',c.code,'scale',t.scale)
 FROM day_balances d JOIN totals t ON t.currency_id=d.currency_id JOIN public.finance_currencies c ON c.id=d.currency_id WHERE(SELECT allowed FROM proof_gate)
 UNION ALL
 SELECT 4::smallint,row_number() OVER(ORDER BY r.posted_on,r.journal_id,r.family COLLATE "C",r.line_number)::integer,jsonb_build_array(r.family,r.journal_id,r.line_number)
 FROM raw r WHERE(SELECT allowed FROM proof_gate);
END
$tail$;
 EXECUTE 'CREATE FUNCTION public.counterparty_report_capture_rows(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean) RETURNS TABLE(section smallint,ordinal integer,payload jsonb) LANGUAGE plpgsql STABLE SET search_path=pg_catalog SET DateStyle=''ISO,YMD'' SET TimeZone=''UTC'' AS '||quote_literal(source);
END $derive$;
REVOKE ALL ON FUNCTION public.counterparty_report_capture_rows(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.counterparty_report_capture_rows(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean) TO kavosh_report_capture_policy;
CREATE FUNCTION public.counterparty_report_capture_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;j record;BEGIN
 IF current_user<>'kavosh_report_capture_policy' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'REPORT_CAPTURE_IMMUTABLE' USING ERRCODE='23514';END IF;
 h=NEW;
 IF TG_OP='UPDATE' AND(OLD.source_metadata IS NOT NULL OR(to_jsonb(NEW)-'source_metadata') IS DISTINCT FROM(to_jsonb(OLD)-'source_metadata')) THEN RAISE EXCEPTION 'REPORT_CAPTURE_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO j FROM public.report_jobs WHERE academy_id=NEW.academy_id AND id=NEW.job_id AND status='running' AND lease_token=h.lease_token AND lease_until>clock_timestamp() AND expires_at>clock_timestamp();
 IF j.id IS NULL OR j.configuration->>'reportId'<>'finance.counterparty-statement' OR h.created_transaction IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'REPORT_CAPTURE_LIVE_LEASE_REQUIRED' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER counterparty_report_capture_guard BEFORE INSERT OR UPDATE OR DELETE ON public.counterparty_report_captures FOR EACH ROW EXECUTE FUNCTION public.counterparty_report_capture_guard();
-- Validate one inserted batch,not two header/lease queries for every row.
CREATE FUNCTION public.counterparty_report_capture_batch_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF current_user<>'kavosh_report_capture_policy' OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'REPORT_CAPTURE_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM new_capture_rows n LEFT JOIN public.counterparty_report_captures h ON h.academy_id=n.academy_id AND h.job_id=n.job_id LEFT JOIN public.report_jobs j ON j.academy_id=h.academy_id AND j.id=h.job_id
  WHERE h.job_id IS NULL OR h.source_metadata IS NOT NULL OR h.created_transaction IS DISTINCT FROM pg_current_xact_id() OR j.id IS NULL OR j.status<>'running' OR j.lease_token IS DISTINCT FROM h.lease_token OR j.lease_until<=clock_timestamp() OR j.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'REPORT_CAPTURE_LIVE_LEASE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE TRIGGER counterparty_report_capture_insert AFTER INSERT ON public.counterparty_report_capture_rows REFERENCING NEW TABLE AS new_capture_rows FOR EACH STATEMENT EXECUTE FUNCTION public.counterparty_report_capture_batch_guard();
CREATE TRIGGER counterparty_report_capture_change BEFORE UPDATE OR DELETE ON public.counterparty_report_capture_rows FOR EACH STATEMENT EXECUTE FUNCTION public.counterparty_report_capture_batch_guard();
CREATE FUNCTION public.counterparty_report_capture_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;m jsonb;BEGIN
 SELECT * INTO h FROM public.counterparty_report_captures WHERE academy_id=NEW.academy_id AND job_id=NEW.job_id;SELECT payload INTO m FROM public.counterparty_report_capture_rows WHERE academy_id=NEW.academy_id AND job_id=NEW.job_id AND section=0 AND ordinal=0;
 IF h.source_metadata IS NULL OR m IS DISTINCT FROM h.source_metadata OR NOT(m ?& ARRAY['sourceFingerprint','validRange','denied','unknown','sourceCount','currencyCount','entryCount','dayCount']) OR m->>'sourceFingerprint' !~ '^[a-f0-9]{64}$' OR m->'validRange' IS DISTINCT FROM 'true'::jsonb OR m->'denied' IS DISTINCT FROM '0'::jsonb OR m->'unknown' IS DISTINCT FROM '0'::jsonb
  OR EXISTS(SELECT 1 FROM public.counterparty_report_capture_rows r WHERE r.academy_id=h.academy_id AND r.job_id=h.job_id AND r.section<>0 GROUP BY r.section HAVING min(r.ordinal)<>1 OR max(r.ordinal)<>count(*))
  OR(m->>'sourceCount')::integer<>(SELECT count(*) FROM public.counterparty_report_capture_rows WHERE academy_id=h.academy_id AND job_id=h.job_id AND section=4)
  OR(m->>'currencyCount')::integer<>(SELECT count(*) FROM public.counterparty_report_capture_rows WHERE academy_id=h.academy_id AND job_id=h.job_id AND section=1)
  OR(m->>'entryCount')::integer<>(SELECT count(*) FROM public.counterparty_report_capture_rows WHERE academy_id=h.academy_id AND job_id=h.job_id AND section=2)
  OR(m->>'dayCount')::integer<>(SELECT count(*) FROM public.counterparty_report_capture_rows WHERE academy_id=h.academy_id AND job_id=h.job_id AND section=3)
 THEN RAISE EXCEPTION 'REPORT_CAPTURE_COMPLETE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER counterparty_report_capture_complete AFTER INSERT OR UPDATE ON public.counterparty_report_captures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.counterparty_report_capture_complete();
CREATE FUNCTION public.capture_counterparty_report_job(p_job uuid,p_lease uuid,p_request uuid,p_scopes jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE j record;f jsonb;m jsonb;currencies uuid[];BEGIN
 SELECT * INTO j FROM public.report_jobs WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_job AND status='running' AND lease_token=p_lease AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() AND configuration->>'reportId'='finance.counterparty-statement';
 IF j.id IS NULL THEN RAISE EXCEPTION 'REPORT_CAPTURE_LIVE_LEASE_REQUIRED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=j.academy_id AND a.request_id=p_request AND a.entity_id=j.id AND a.action='report.capture' AND a.actor_id=j.requester_id AND a.actor_kind=j.requester_kind AND coalesce(a.session_id,a.credential_id)=j.credential_id AND a.created_at=transaction_timestamp() AND a.changes=jsonb_build_object('reportId','finance.counterparty-statement','externalRequestMade',false)) THEN RAISE EXCEPTION 'REPORT_CAPTURE_ACTUAL_ACTOR_REQUIRED' USING ERRCODE='23514';END IF;
 f=jsonb_build_object('payeeId',j.configuration#>>'{parameters,payeeId}','from',j.configuration#>>'{parameters,from}','through',j.configuration#>>'{parameters,through}');
 IF j.configuration#>>'{parameters,currencyIds}' IS NOT NULL THEN currencies=string_to_array(j.configuration#>>'{parameters,currencyIds}',',')::uuid[];f=f||jsonb_build_object('currencyIds',to_jsonb(currencies));END IF;
 INSERT INTO public.counterparty_report_captures(academy_id,job_id,lease_token,request_id,frame) VALUES(j.academy_id,j.id,p_lease,p_request,f);
 INSERT INTO public.counterparty_report_capture_rows(academy_id,job_id,section,ordinal,payload)
 SELECT j.academy_id,j.id,r.section,r.ordinal,r.payload FROM public.counterparty_report_capture_rows((f->>'payeeId')::uuid,(f->>'from')::date,(f->>'through')::date,p_scopes,NULL,NULL,NULL,NULL,1,currencies,false) r;
 SELECT payload INTO m FROM public.counterparty_report_capture_rows WHERE academy_id=j.academy_id AND job_id=j.id AND section=0 AND ordinal=0;
 IF m->'denied' IS DISTINCT FROM '0'::jsonb THEN RAISE EXCEPTION 'REPORT_CAPTURE_SOURCE_DENIED' USING ERRCODE='42501';END IF;
 IF m->>'sourceFingerprint' IS NULL OR m->'validRange' IS DISTINCT FROM 'true'::jsonb OR m->'unknown' IS DISTINCT FROM '0'::jsonb THEN RAISE EXCEPTION 'REPORT_CAPTURE_SOURCE_INCOMPLETE' USING ERRCODE='23514';END IF;
 -- Cancellation/replacement can win while the monetary query is running.
 PERFORM id FROM public.report_jobs WHERE academy_id=j.academy_id AND id=j.id AND status='running' AND lease_token=p_lease AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'REPORT_CAPTURE_LIVE_LEASE_REQUIRED' USING ERRCODE='23514';END IF;
 UPDATE public.counterparty_report_captures SET source_metadata=m WHERE academy_id=j.academy_id AND job_id=j.id;
 RETURN jsonb_build_object('jobId',j.id,'captured',true,'sourceFingerprint',m->>'sourceFingerprint','sourceCount',m->'sourceCount','entryCount',m->'entryCount');
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_report_capture_policy;
ALTER FUNCTION public.capture_counterparty_report_job(uuid,uuid,uuid,jsonb) OWNER TO kavosh_report_capture_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_report_capture_policy;
REVOKE ALL ON FUNCTION public.counterparty_report_capture_guard(),public.counterparty_report_capture_batch_guard(),public.counterparty_report_capture_complete(),public.capture_counterparty_report_job(uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capture_counterparty_report_job(uuid,uuid,uuid,jsonb) TO kavosh_automation_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 284 $$;

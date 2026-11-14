-- Durable bounded pieces of one CSV. Existing small report results are not
-- rewritten. A multipart result stores only an explicitly labelled index.
CREATE TABLE public.report_job_parts(
 academy_id uuid NOT NULL,job_id uuid NOT NULL,part_no integer NOT NULL CHECK(part_no BETWEEN 1 AND 1000),
 first_section smallint NOT NULL,first_ordinal integer NOT NULL,last_section smallint NOT NULL,last_ordinal integer NOT NULL,
 records integer NOT NULL CHECK(records BETWEEN 1 AND 250),body text NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 1048576),
 sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),lease_token uuid NOT NULL,request_id uuid NOT NULL,
 created_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,job_id,part_no),UNIQUE(academy_id,request_id),FOREIGN KEY(academy_id,job_id) REFERENCES public.counterparty_report_captures(academy_id,job_id),
 CHECK(first_section BETWEEN 0 AND 3 AND last_section BETWEEN 0 AND 3 AND first_ordinal BETWEEN 0 AND 200000 AND last_ordinal BETWEEN 0 AND 200000),
 CHECK((first_section,first_ordinal)<=(last_section,last_ordinal)));
ALTER TABLE public.report_job_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_job_parts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON public.report_job_parts USING(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid) WITH CHECK(academy_id=nullif(current_setting('app.academy_id',true),'')::uuid);
GRANT SELECT ON public.report_job_parts TO kavosh_runtime,kavosh_automation_worker,kavosh_automation_policy,kavosh_report_capture_policy;
GRANT INSERT ON public.report_job_parts TO kavosh_report_capture_policy;
GRANT SELECT ON public.counterparty_report_captures TO kavosh_automation_policy;
ALTER TABLE public.report_job_results ADD multipart jsonb;
ALTER TABLE public.report_job_results ADD CHECK(multipart IS NULL OR(jsonb_typeof(multipart)='object' AND octet_length(multipart::text)<=4096));
CREATE FUNCTION public.counterparty_report_part_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE j record;h record;prior record;first_row record;matched integer;BEGIN
 IF TG_OP<>'INSERT' OR current_user<>'kavosh_report_capture_policy' THEN RAISE EXCEPTION 'REPORT_PART_IMMUTABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO j FROM public.report_jobs WHERE academy_id=NEW.academy_id AND id=NEW.job_id AND status='running' AND lease_token=NEW.lease_token AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE;
 SELECT * INTO h FROM public.counterparty_report_captures WHERE academy_id=NEW.academy_id AND job_id=NEW.job_id AND source_metadata IS NOT NULL;
 IF j.id IS NULL OR h.job_id IS NULL OR j.configuration->>'reportId'<>'finance.counterparty-statement' OR NEW.created_transaction IS DISTINCT FROM pg_current_xact_id() OR NEW.sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.body,'UTF8')),'hex') THEN RAISE EXCEPTION 'REPORT_PART_LIVE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT * INTO prior FROM public.report_job_parts WHERE academy_id=NEW.academy_id AND job_id=NEW.job_id ORDER BY part_no DESC LIMIT 1;
 SELECT section,ordinal INTO first_row FROM public.counterparty_report_capture_rows WHERE academy_id=NEW.academy_id AND job_id=NEW.job_id AND section<4 AND(section,ordinal)>(coalesce(prior.last_section,-1),coalesce(prior.last_ordinal,-1)) ORDER BY section,ordinal LIMIT 1;
 SELECT count(*)::integer INTO matched FROM public.counterparty_report_capture_rows WHERE academy_id=NEW.academy_id AND job_id=NEW.job_id AND section<4 AND(section,ordinal)>=(NEW.first_section,NEW.first_ordinal) AND(section,ordinal)<=(NEW.last_section,NEW.last_ordinal);
 IF NEW.part_no<>coalesce(prior.part_no,0)+1 OR(first_row.section,first_row.ordinal) IS DISTINCT FROM(NEW.first_section,NEW.first_ordinal) OR matched<>NEW.records
  OR NOT EXISTS(SELECT 1 FROM public.counterparty_report_capture_rows WHERE academy_id=NEW.academy_id AND job_id=NEW.job_id AND section=NEW.last_section AND ordinal=NEW.last_ordinal)
 THEN RAISE EXCEPTION 'REPORT_PART_CONTIGUOUS_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.academy_id=j.academy_id AND a.request_id=NEW.request_id AND a.entity_id=j.id AND a.action='report.part' AND a.actor_id=j.requester_id AND a.actor_kind=j.requester_kind AND coalesce(a.session_id,a.credential_id)=j.credential_id AND a.created_at=transaction_timestamp()
  AND a.changes=jsonb_build_object('reportId','finance.counterparty-statement','part',NEW.part_no,'records',NEW.records,'first',jsonb_build_array(NEW.first_section,NEW.first_ordinal),'last',jsonb_build_array(NEW.last_section,NEW.last_ordinal),'sha256',NEW.sha256,'bytes',octet_length(NEW.body),'externalRequestMade',false)) THEN RAISE EXCEPTION 'REPORT_PART_ACTUAL_ACTOR_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.created_at=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER counterparty_report_part_guard BEFORE INSERT OR UPDATE OR DELETE ON public.report_job_parts FOR EACH ROW EXECUTE FUNCTION public.counterparty_report_part_guard();
CREATE FUNCTION public.append_counterparty_report_part(p_job uuid,p_lease uuid,p_request uuid,p_part integer,p_first_section smallint,p_first_ordinal integer,p_last_section smallint,p_last_ordinal integer,p_records integer,p_body text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;BEGIN
 INSERT INTO public.report_job_parts(academy_id,job_id,part_no,first_section,first_ordinal,last_section,last_ordinal,records,body,sha256,lease_token,request_id)
 VALUES(tenant,p_job,p_part,p_first_section,p_first_ordinal,p_last_section,p_last_ordinal,p_records,p_body,encode(sha256(convert_to(p_body,'UTF8')),'hex'),p_lease,p_request);
 RETURN NOT EXISTS(SELECT 1 FROM public.counterparty_report_capture_rows WHERE academy_id=tenant AND job_id=p_job AND section<4 AND(section,ordinal)>(p_last_section,p_last_ordinal));
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_report_capture_policy;
ALTER FUNCTION public.append_counterparty_report_part(uuid,uuid,uuid,integer,smallint,integer,smallint,integer,integer,text) OWNER TO kavosh_report_capture_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_report_capture_policy;
REVOKE ALL ON FUNCTION public.append_counterparty_report_part(uuid,uuid,uuid,integer,smallint,integer,smallint,integer,integer,text),public.counterparty_report_part_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_counterparty_report_part(uuid,uuid,uuid,integer,smallint,integer,smallint,integer,integer,text) TO kavosh_automation_worker;
CREATE FUNCTION public.yield_counterparty_report_job(p_job uuid,p_lease uuid,p_part integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE j record;p record;expected integer;BEGIN
 SELECT * INTO j FROM public.report_jobs WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_job AND status='running' AND lease_token=p_lease AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE;
 IF j.id IS NULL THEN RETURN false;END IF;
 SELECT * INTO p FROM public.report_job_parts WHERE academy_id=j.academy_id AND job_id=j.id AND part_no=p_part AND lease_token=p_lease AND created_transaction=pg_current_xact_id();
 SELECT 1+(source_metadata->>'currencyCount')::integer+(source_metadata->>'entryCount')::integer+(source_metadata->>'dayCount')::integer INTO expected FROM public.counterparty_report_captures WHERE academy_id=j.academy_id AND job_id=j.id;
 IF p.job_id IS NULL OR p.part_no<>(SELECT max(part_no) FROM public.report_job_parts WHERE academy_id=j.academy_id AND job_id=j.id) OR expected IS NULL OR expected<=(SELECT sum(records) FROM public.report_job_parts WHERE academy_id=j.academy_id AND job_id=j.id) THEN RAISE EXCEPTION 'REPORT_PRODUCTIVE_CONTINUATION_REQUIRED' USING ERRCODE='23514';END IF;
 -- Productive continuation does not consume the existing failure-retry budget.
 UPDATE public.report_jobs SET status='queued',attempts=attempts-1,available_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,last_error=NULL WHERE academy_id=j.academy_id AND id=j.id;RETURN true;
END $$;
ALTER FUNCTION public.yield_counterparty_report_job(uuid,uuid,integer) OWNER TO kavosh_automation_policy;
REVOKE ALL ON FUNCTION public.yield_counterparty_report_job(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.yield_counterparty_report_job(uuid,uuid,integer) TO kavosh_automation_worker;
CREATE FUNCTION public.counterparty_capture_result_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& ARRAY['kind','jobId','frame','sourceFingerprint']) OR p-ARRAY['kind','jobId','frame','sourceFingerprint']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'counterparty_capture' OR jsonb_typeof(p->'jobId') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
 PERFORM(p->>'jobId')::uuid;
 RETURN public.counterparty_report_result_valid((p-'jobId')||jsonb_build_object('kind','counterparty_statement','sourceManifest','[]'::jsonb));
 EXCEPTION WHEN invalid_text_representation THEN RETURN false;END $$;
DO $$ DECLARE body text;needle text:='RETURN public.counterparty_report_result_valid(p);';r record;BEGIN
 body=pg_get_functiondef('public.report_result_context_valid(text,jsonb)'::regprocedure);
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'REPORT_PART_CONTEXT_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,'RETURN CASE WHEN p->>''kind''=''counterparty_capture'' THEN public.counterparty_capture_result_valid(p) ELSE public.counterparty_report_result_valid(p) END;');
 FOR r IN SELECT DISTINCT role.rolname FROM pg_proc f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl JOIN pg_roles role ON role.oid=acl.grantee WHERE f.oid='public.report_result_context_valid(text,jsonb)'::regprocedure AND acl.privilege_type='EXECUTE' LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION public.counterparty_capture_result_valid(jsonb) TO %I',r.rolname);END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.counterparty_capture_result_valid(jsonb) FROM PUBLIC;
CREATE FUNCTION public.report_parts_index(p_job uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT '"part","bytes","sha256"'||chr(13)||chr(10)||coalesce(string_agg('"'||part_no::text||'","'||octet_length(body)::text||'","'||sha256||'"',chr(13)||chr(10) ORDER BY part_no),'')||chr(13)||chr(10)
 FROM public.report_job_parts WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND job_id=p_job;
$$;
REVOKE ALL ON FUNCTION public.report_parts_index(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_parts_index(uuid) TO kavosh_automation_worker,kavosh_automation_policy;
CREATE FUNCTION public.counterparty_parts_result_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE h record;n integer;rendered integer;total bigint;expected integer;BEGIN
 IF NEW.authorization_context->>'kind' IS DISTINCT FROM 'counterparty_capture' THEN
  IF NEW.multipart IS NOT NULL OR EXISTS(SELECT 1 FROM public.report_job_parts WHERE academy_id=NEW.academy_id AND job_id=NEW.job_id) THEN RAISE EXCEPTION 'REPORT_PART_CONTEXT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 SELECT * INTO h FROM public.counterparty_report_captures WHERE academy_id=NEW.academy_id AND job_id=NEW.job_id;
 SELECT count(*)::integer,coalesce(sum(records),0)::integer,coalesce(sum(octet_length(body)),0) INTO n,rendered,total FROM public.report_job_parts WHERE academy_id=NEW.academy_id AND job_id=NEW.job_id;
 expected=1+(h.source_metadata->>'currencyCount')::integer+(h.source_metadata->>'entryCount')::integer+(h.source_metadata->>'dayCount')::integer;
 IF h.job_id IS NULL OR expected IS NULL OR n<1 OR rendered<>expected OR NEW.authorization_context->>'jobId' IS DISTINCT FROM NEW.job_id::text OR NEW.authorization_context->>'sourceFingerprint' IS DISTINCT FROM h.source_metadata->>'sourceFingerprint' OR NEW.authorization_context->'frame' IS DISTINCT FROM h.frame OR NEW.body IS DISTINCT FROM public.report_parts_index(NEW.job_id) THEN RAISE EXCEPTION 'REPORT_PARTS_COMPLETE_SOURCE_REQUIRED' USING ERRCODE='23514';END IF;
 NEW.multipart=jsonb_build_object('version',1,'format','ordered_csv_byte_parts','partCount',n,'totalBytes',total,'renderedRecords',rendered);RETURN NEW;
END $$;
CREATE TRIGGER counterparty_parts_result_guard BEFORE INSERT ON public.report_job_results FOR EACH ROW EXECUTE FUNCTION public.counterparty_parts_result_guard();
REVOKE ALL ON FUNCTION public.counterparty_parts_result_guard() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 286 $$;

-- Reuse the canonical monetary snapshot and existing requester-bound job,
-- preset,relative-window and scheduler protocol. No extra financial ledger.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.counterparty_statement_snapshot_read(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)'::regprocedure);
 needle='$9 NOT BETWEEN 1 AND 2001';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'COUNTERPARTY_EXPORT_KERNEL_BASE_CHANGED';END IF;
 EXECUTE replace(replace(body,'FUNCTION public.counterparty_statement_snapshot_read(','FUNCTION public.counterparty_statement_export_snapshot_read('),needle,'$9 NOT BETWEEN 1 AND 10001');
END $$;
REVOKE ALL ON FUNCTION public.counterparty_statement_export_snapshot_read(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.counterparty_statement_export_snapshot_read(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean) TO kavosh_runtime;
CREATE FUNCTION public.counterparty_report_result_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE f jsonb;m jsonb;BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>1048576 OR NOT(p ?& ARRAY['kind','frame','sourceFingerprint','sourceManifest']) OR p-ARRAY['kind','frame','sourceFingerprint','sourceManifest']<>'{}'::jsonb OR p->>'kind' IS DISTINCT FROM 'counterparty_statement' OR jsonb_typeof(p->'sourceFingerprint') IS DISTINCT FROM 'string' OR(p->>'sourceFingerprint')!~'^[a-f0-9]{64}$' THEN RETURN false;END IF;
 f=p->'frame';IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR NOT(f ?& ARRAY['payeeId','from','through']) OR f-ARRAY['payeeId','from','through','currencyIds']<>'{}'::jsonb OR jsonb_typeof(f->'payeeId') IS DISTINCT FROM 'string' OR jsonb_typeof(f->'from') IS DISTINCT FROM 'string' OR jsonb_typeof(f->'through') IS DISTINCT FROM 'string' OR(f->>'from')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR(f->>'through')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false;END IF;
 PERFORM(f->>'payeeId')::uuid;IF(f->>'from')::date NOT BETWEEN DATE '1900-01-01' AND DATE '9999-12-31' OR(f->>'through')::date NOT BETWEEN(f->>'from')::date AND(f->>'from')::date+3660 THEN RETURN false;END IF;
 IF f ? 'currencyIds' THEN
  IF jsonb_typeof(f->'currencyIds') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'currencyIds') NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;
  FOR m IN SELECT value FROM jsonb_array_elements(f->'currencyIds') LOOP IF jsonb_typeof(m) IS DISTINCT FROM 'string' THEN RETURN false;END IF;PERFORM(m#>>'{}')::uuid;END LOOP;
  IF(SELECT count(*)<>count(DISTINCT(value#>>'{}')::uuid) FROM jsonb_array_elements(f->'currencyIds')) THEN RETURN false;END IF;
 END IF;
 IF jsonb_typeof(p->'sourceManifest') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'sourceManifest')>10000 THEN RETURN false;END IF;
 FOR m IN SELECT value FROM jsonb_array_elements(p->'sourceManifest') LOOP
  IF jsonb_typeof(m) IS DISTINCT FROM 'array' OR jsonb_array_length(m)<>3 OR jsonb_typeof(m->0) IS DISTINCT FROM 'string' OR m->>0 NOT IN('manual_balance','custody','payable') OR jsonb_typeof(m->1) IS DISTINCT FROM 'string' OR jsonb_typeof(m->2) IS DISTINCT FROM 'number' OR(m->>2)::numeric<>trunc((m->>2)::numeric) OR(m->>2)::numeric NOT BETWEEN 0 AND 200 THEN RETURN false;END IF;PERFORM(m->>1)::uuid;
 END LOOP;
 RETURN(SELECT count(*)=count(DISTINCT jsonb_build_array(value->>0,(value->>1)::uuid,(value->>2)::integer)) FROM jsonb_array_elements(p->'sourceManifest'));
 EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN RETURN false;
END $$;
DO $$ DECLARE body text;r record;BEGIN
 FOR r IN SELECT * FROM(VALUES
 ('public.report_job_guard()','''finance.profitability'')','''finance.profitability'',''finance.counterparty-statement'')'),
 ('public.report_job_preset_guard()','''finance.profitability'') THEN ARRAY[''from'',''through'']','''finance.profitability'',''finance.counterparty-statement'') THEN ARRAY[''from'',''through'']'),
 ('public.report_result_context_valid(text,jsonb)',' IF report=''finance.profitability'' THEN',' IF report=''finance.counterparty-statement'' THEN RETURN public.counterparty_report_result_valid(p); END IF; IF report=''finance.profitability'' THEN')
 ) changes(signature,old_text,new_text) LOOP
  body=pg_get_functiondef(r.signature::regprocedure);IF(length(body)-length(replace(body,r.old_text,'')))/length(r.old_text)<>1 THEN RAISE EXCEPTION 'COUNTERPARTY_REPORT_BASE_CHANGED:%',r.signature;END IF;EXECUTE replace(body,r.old_text,r.new_text);
 END LOOP;
 FOR r IN SELECT DISTINCT role.rolname FROM pg_proc f CROSS JOIN LATERAL aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) acl JOIN pg_roles role ON role.oid=acl.grantee WHERE f.oid='public.report_result_context_valid(text,jsonb)'::regprocedure AND acl.privilege_type='EXECUTE' LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION public.counterparty_report_result_valid(jsonb) TO %I',r.rolname);END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.counterparty_report_result_valid(jsonb) FROM PUBLIC;
CREATE FUNCTION public.counterparty_report_result_frame_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE c jsonb;f jsonb;BEGIN
 SELECT configuration INTO c FROM public.report_jobs WHERE academy_id=NEW.academy_id AND id=NEW.job_id;
 IF c->>'reportId'='finance.counterparty-statement' THEN
  f=jsonb_build_object('payeeId',c#>>'{parameters,payeeId}','from',c#>>'{parameters,from}','through',c#>>'{parameters,through}');
  IF c#>>'{parameters,currencyIds}' IS NOT NULL THEN f=f||jsonb_build_object('currencyIds',string_to_array(c#>>'{parameters,currencyIds}',','));END IF;
  IF NEW.authorization_context->'frame' IS DISTINCT FROM f THEN RAISE EXCEPTION 'COUNTERPARTY_REPORT_FRAME_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER counterparty_report_result_frame_guard BEFORE INSERT ON public.report_job_results FOR EACH ROW EXECUTE FUNCTION public.counterparty_report_result_frame_guard();
REVOKE ALL ON FUNCTION public.counterparty_report_result_frame_guard() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 282 $$;

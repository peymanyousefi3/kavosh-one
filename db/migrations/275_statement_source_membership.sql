-- Archive exact event membership,including rolled-up opening history. A
-- timestamp cannot prove whether a concurrently committed payment was in a
-- saved MVCC snapshot. Interactive reports do not build this private array.
DO $migration$
DECLARE definition text;source text;old_source text;head text;tail text;r record;
BEGIN
 definition=pg_get_functiondef('public.counterparty_statement_rows(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[])'::regprocedure);
 SELECT prosrc INTO old_source FROM pg_proc WHERE oid='public.counterparty_statement_rows(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[])'::regprocedure;
 head='public.counterparty_statement_rows(uuid, date, date, jsonb, date, uuid, text, integer, integer, uuid[])';
 tail='ELSE NULL END AS "sourceScope";';
 IF(length(definition)-length(replace(definition,head,'')))/length(head)<>1 OR(length(definition)-length(replace(definition,'"sourceScope" jsonb)','')))/length('"sourceScope" jsonb)')<>1 OR(length(old_source)-length(replace(old_source,tail,'')))/length(tail)<>1 OR to_regprocedure('public.counterparty_statement_snapshot(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean)') IS NOT NULL THEN RAISE EXCEPTION 'STATEMENT_MEMBERSHIP_BASE_CHANGED';END IF;
 source=replace(definition,head,'public.counterparty_statement_snapshot(uuid, date, date, jsonb, date, uuid, text, integer, integer, uuid[], boolean)');
 source=replace(source,'"sourceScope" jsonb)','"sourceScope" jsonb, "sourceManifest" jsonb)');
 source=replace(source,tail,$patch$ELSE NULL END AS "sourceScope",
 CASE WHEN $11 AND(SELECT allowed FROM proof_gate) THEN(SELECT coalesce(jsonb_agg(jsonb_build_array(family,journal_id,line_number) ORDER BY posted_on,journal_id,family COLLATE "C",line_number),'[]'::jsonb) FROM raw) ELSE NULL END AS "sourceManifest";$patch$);
 EXECUTE source;
 REVOKE ALL ON FUNCTION public.counterparty_statement_snapshot(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean) FROM PUBLIC;
 FOR r IN SELECT DISTINCT roles.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a JOIN pg_roles roles ON roles.oid=a.grantee WHERE p.oid='public.counterparty_statement_rows(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[])'::regprocedure AND a.privilege_type='EXECUTE' LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.counterparty_statement_snapshot(uuid,date,date,jsonb,date,uuid,text,integer,integer,uuid[],boolean) TO %I',r.rolname);
 END LOOP;
 -- Preserve the original function identity,ACL,configuration and result type.
 EXECUTE replace(definition,old_source,$body$BEGIN RETURN QUERY SELECT s."snapshotAt",s."sourceCount",s.denied,s.unknown,s."billCount",s."currencyCount",s."dayCount",s."entryCount",s."validRange",s.currencies,s.entries,s.days,s."sourceFingerprint",s."sourceScope" FROM public.counterparty_statement_snapshot($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false) s;END $body$);
 definition=pg_get_functiondef('public.counterparty_statement_record_source(uuid,jsonb,jsonb)'::regprocedure);
 head='public.counterparty_statement_rows(o.id,(d->>''from'')::date,(d->>''through'')::date,scopes,NULL,NULL,NULL,NULL,2001,ids)';
 IF(length(definition)-length(replace(definition,head,'')))/length(head)<>1 THEN RAISE EXCEPTION 'STATEMENT_ARCHIVE_MEMBERSHIP_BASE_CHANGED';END IF;
 EXECUTE replace(definition,head,'public.counterparty_statement_snapshot(o.id,(d->>''from'')::date,(d->>''through'')::date,scopes,NULL,NULL,NULL,NULL,2001,ids,true)');
 definition=pg_get_functiondef('public.counterparty_statement_content(jsonb,jsonb,timestamptz)'::regprocedure);
 head='ARRAY[''sourceScope'',''denied'',''unknown'',''validRange'']';
 IF(length(definition)-length(replace(definition,head,'')))/length(head)<>1 THEN RAISE EXCEPTION 'STATEMENT_CONTENT_MEMBERSHIP_BASE_CHANGED';END IF;
 EXECUTE replace(definition,head,'ARRAY[''sourceScope'',''sourceManifest'',''denied'',''unknown'',''validRange'']');
END $migration$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 275 $$;

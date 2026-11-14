-- Preserve durable tenant records without freezing security revocation or
-- the report worker's disposable issue backlog. These exceptions are current
-- operational projections/grants,not the immutable business/audit history.
CREATE TABLE platform_private.preservation_exemptions(
 relation_name text PRIMARY KEY CHECK(relation_name~'^[a-z_]+$'),reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500)
);
INSERT INTO platform_private.preservation_exemptions VALUES
 ('role_permissions','Mutable current authorization projection;versioned approval and audit evidence remains preserved.'),
 ('role_assignments','Mutable current authorization projection;access replacement and revocation must remain possible.'),
 ('assignment_hubs','Current authorization projection removed with its role assignment;immutable access audit is preserved.'),
 ('assignment_classes','Current authorization projection removed with its role assignment;immutable access audit is preserved.'),
 ('assignment_people','Current authorization projection removed with its role assignment;immutable access audit is preserved.'),
 ('assignment_countries','Current authorization projection removed with its role assignment;immutable access audit is preserved.'),
 ('assignment_regions','Current authorization projection removed with its role assignment;immutable access audit is preserved.'),
 ('assignment_cities','Current authorization projection removed with its role assignment;immutable access audit is preserved.'),
 ('report_job_issue_backlog','Disposable work pointer removed only after durable job-issue observation;job/audit/notification evidence is preserved.');
CREATE TRIGGER preservation_exemptions_immutable BEFORE UPDATE OR DELETE ON platform_private.preservation_exemptions FOR EACH ROW EXECUTE FUNCTION platform_private.immutable_record();
CREATE FUNCTION platform_private.prevent_preserved_truncate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'PRESERVATION_READ_COMMITTED_REQUIRED' USING ERRCODE='25000';END IF;
 -- Shared by every legal-hold writer. A bulk operation cannot race a new
 -- preservation case into existence after checking an obsolete snapshot.
 PERFORM pg_advisory_xact_lock(375,0);
 IF EXISTS(SELECT 1 FROM platform_private.academy_legal_holds h WHERE NOT EXISTS(SELECT 1 FROM platform_private.academy_legal_hold_releases r WHERE r.hold_id=h.id)) THEN RAISE EXCEPTION 'ACADEMY_LEGAL_HOLD_ACTIVE' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
DO $$ DECLARE relation record;body text;needle text;BEGIN
 body=pg_get_functiondef('platform_private.legal_hold_request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 needle=$old$IF p_operation IN('holds.create','holds.release') THEN PERFORM pg_advisory_xact_lock(hashtextextended(school::text,374));$old$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PRESERVATION_HOLD_GATEWAY_CHANGED';END IF;
 EXECUTE replace(body,needle,$new$IF p_operation IN('holds.create','holds.release') THEN PERFORM pg_advisory_xact_lock_shared(375,0);PERFORM pg_advisory_xact_lock(hashtextextended(school::text,374));$new$);
 body=pg_get_functiondef('platform_private.guard_legal_hold_entry()'::regprocedure);
 needle='PERFORM pg_advisory_xact_lock(hashtextextended(NEW.academy_id::text,374));';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PRESERVATION_HOLD_ENTRY_CHANGED';END IF;
 EXECUTE replace(body,needle,'PERFORM pg_advisory_xact_lock_shared(375,0);'||needle);
 body=pg_get_functiondef('platform_private.guard_legal_hold_entry()'::regprocedure);
 needle=' PERFORM platform_private.authorize_owner(NEW.actor_user_id,NEW.session_id);';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PRESERVATION_HOLD_ISOLATION_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,' IF current_setting(''transaction_isolation'') IS DISTINCT FROM ''read committed'' THEN RAISE EXCEPTION ''PRESERVATION_READ_COMMITTED_REQUIRED'' USING ERRCODE=''25000'';END IF;'||needle);
 body=pg_get_functiondef('platform_private.prevent_held_record_deletion()'::regprocedure);
 needle=' IF TG_TABLE_NAME=''academies'' THEN';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PRESERVATION_DELETE_ISOLATION_BASE_CHANGED';END IF;
 EXECUTE replace(body,needle,' IF current_setting(''transaction_isolation'') IS DISTINCT FROM ''read committed'' THEN RAISE EXCEPTION ''PRESERVATION_READ_COMMITTED_REQUIRED'' USING ERRCODE=''25000'';END IF;'||needle);
 FOR relation IN
  SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN('r','p') AND(c.relname='academies' OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='academy_id' AND NOT a.attisdropped))
  AND NOT EXISTS(SELECT 1 FROM platform_private.preservation_exemptions e WHERE e.relation_name=c.relname) ORDER BY c.relname
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=relation.oid AND t.tgfoid='platform_private.prevent_held_record_deletion()'::regprocedure AND NOT t.tgisinternal) THEN
   EXECUTE format('CREATE TRIGGER academy_preservation_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION platform_private.prevent_held_record_deletion()',relation.relname);
  END IF;
  EXECUTE format('CREATE TRIGGER academy_preservation_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION platform_private.prevent_preserved_truncate()',relation.relname);
 END LOOP;
END $$;
CREATE VIEW platform_private.academy_preservation_coverage AS
 SELECT c.relname::text relation_name,CASE WHEN e.relation_name IS NULL THEN 'preserved_record' ELSE 'operational_projection' END classification,e.reason exemption_reason,
 EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgfoid='platform_private.prevent_held_record_deletion()'::regprocedure AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=11) delete_guard_present,
 EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgfoid='platform_private.prevent_preserved_truncate()'::regprocedure AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=34) truncate_guard_present
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN platform_private.preservation_exemptions e ON e.relation_name=c.relname
 WHERE n.nspname='public' AND c.relkind IN('r','p') AND(c.relname='academies' OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='academy_id' AND NOT a.attisdropped));
DO $$ DECLARE body text;needle text:='response=jsonb_build_object(''data'',data);action_name=''platform.retention.policy.read'';';BEGIN
 body=pg_get_functiondef('platform_private.legal_hold_request(uuid,uuid,text,uuid,jsonb)'::regprocedure);IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'PRESERVATION_POLICY_READER_CHANGED';END IF;
 EXECUTE replace(body,needle,'data=data||jsonb_build_object(''databasePreservationCoverage'',(SELECT jsonb_build_object(''preservedRelationCount'',count(*) FILTER(WHERE classification=''preserved_record''),''operationalProjectionCount'',count(*) FILTER(WHERE classification=''operational_projection''),''unprotectedRelationCount'',count(*) FILTER(WHERE classification=''preserved_record'' AND NOT(delete_guard_present AND truncate_guard_present)),''basis'',''current_public_academy_relations_with_explicit_operational_exceptions'',''identityAndExternalStorageIncluded'',false) FROM platform_private.academy_preservation_coverage));'||needle);
END $$;
REVOKE ALL ON FUNCTION platform_private.prevent_preserved_truncate() FROM PUBLIC;
GRANT SELECT ON platform_private.preservation_exemptions,platform_private.academy_preservation_coverage TO kavosh_platform_policy;
GRANT CREATE ON SCHEMA platform_private TO kavosh_platform_policy;
ALTER FUNCTION platform_private.prevent_preserved_truncate() OWNER TO kavosh_platform_policy;
REVOKE CREATE ON SCHEMA platform_private FROM kavosh_platform_policy;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 375 $$;

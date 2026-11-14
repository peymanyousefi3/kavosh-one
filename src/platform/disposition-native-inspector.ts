import {ApiError} from '../core/policy.ts';
import {dispositionCatalogQuery,validatedDispositionCatalog} from './disposition-schema.ts';
import {buildDispositionSnapshotQuery} from './disposition-snapshot-query.ts';

export const dispositionInspectorRole='kavosh_disposition_policy';
export const dispositionInspectorSignature='platform_private.inspect_disposition_manifest(uuid,uuid,uuid,jsonb,integer,integer,text)';
const quoted=(s:string)=>'"'+s.replaceAll('"','""')+'"';
// Explicit E literals remain safe even if the installer changed string settings;
// neither dollar-quote delimiters nor caller values can become executable SQL.
const literal=(s:string)=>"E'"+s.replaceAll('\\','\\\\').replaceAll("'","''")+"'";

// Operator/compiler only. Install the returned definition inside one transaction
// after granting the dedicated NOLOGIN role its required SELECT-only policies.
// No runtime route accepts this SQL,or any other caller-supplied statement.
export function compileDispositionInspector(raw:unknown,expectedCatalogFingerprint:string){
 if(!/^[a-f0-9]{64}$/.test(expectedCatalogFingerprint))throw new ApiError(400,'DISPOSITION_SCHEMA_INVALID');
 const catalog=validatedDispositionCatalog(raw),{sql,structure}=buildDispositionSnapshotQuery(catalog,catalog.relations.map(r=>'public.'+r.name),true,true);
 const catalogRead=`SELECT meta.snapshot FROM (${dispositionCatalogQuery}) meta`;
 const readerGuard=`  SELECT current_user='${dispositionInspectorRole}' AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolinherit
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)
   AND NOT has_schema_privilege(r.oid,'public','CREATE') AND NOT has_schema_privilege(r.oid,'platform_private','CREATE') AND NOT has_database_privilege(r.oid,current_database(),'CREATE') INTO safe FROM pg_catalog.pg_roles r WHERE r.rolname=current_user;
  IF safe IS DISTINCT FROM true THEN RAISE EXCEPTION 'UNSAFE_DISPOSITION_READER' USING ERRCODE='42501';END IF;
  EXECUTE ${literal(catalogRead)} INTO catalog_state;
  current_hash=encode(sha256(convert_to(catalog_state::text,'UTF8')),'hex');
  IF current_hash<>${literal(expectedCatalogFingerprint)} THEN RAISE EXCEPTION 'DISPOSITION_SCHEMA_CHANGED' USING ERRCODE='23514';END IF;
  -- row_security=off rejects even a SELECT USING(true) role. Instead require
  -- real SELECT-only coverage and reject any applicable restrictive policy;
  -- never add BYPASSRLS,table ownership or raw service-role table access.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(catalog_state->'relations') meta
   JOIN pg_catalog.pg_namespace n ON n.nspname='public' JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=meta->>'name'
   JOIN pg_catalog.pg_roles r ON r.rolname=current_user
   WHERE NOT c.relrowsecurity OR pg_has_role(r.oid,c.relowner,'MEMBER')
    OR has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='disposition_reader_select' AND p.polcmd='r' AND p.polpermissive AND p.polroles=ARRAY[r.oid] AND pg_get_expr(p.polqual,p.polrelid)='true')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND NOT p.polpermissive AND p.polcmd IN('r','*') AND EXISTS(SELECT 1 FROM unnest(p.polroles) member WHERE CASE WHEN member=0 THEN true ELSE pg_has_role(r.oid,member,'USAGE') END))) THEN RAISE EXCEPTION 'UNSAFE_DISPOSITION_READER' USING ERRCODE='42501';END IF;`;
 const body=`DECLARE catalog_state jsonb;current_hash text;seed jsonb;part jsonb;source_relation jsonb;data jsonb;result jsonb;safe boolean;row_seeds jsonb;retained_relations jsonb;audit_id uuid:=gen_random_uuid();
 BEGIN
  PERFORM platform_private.authorize_owner(p_user,p_session);
  IF p_academy IS NULL OR p_seeds IS NULL OR p_max_rows IS NULL OR p_max_rows NOT BETWEEN 1 AND 1000000 OR p_max_source_rows IS NULL OR p_max_source_rows NOT BETWEEN 1 AND 1000000 OR p_purpose IS NULL OR length(btrim(p_purpose)) NOT BETWEEN 1 AND 2000 OR p_purpose~'[[:cntrl:]]' OR octet_length(p_seeds::text)>2097152 THEN RAISE EXCEPTION 'DISPOSITION_RETENTION_INPUT_INVALID' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(p_seeds)='array' THEN row_seeds=p_seeds;retained_relations='[]'::jsonb;
  ELSIF jsonb_typeof(p_seeds)='object' THEN
   IF p_seeds-ARRAY['records','relations']<>'{}'::jsonb OR jsonb_typeof(p_seeds->'records') IS DISTINCT FROM 'array' OR jsonb_typeof(p_seeds->'relations') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'DISPOSITION_RETENTION_INPUT_INVALID' USING ERRCODE='22023';END IF;
   row_seeds=p_seeds->'records';retained_relations=p_seeds->'relations';
  ELSE RAISE EXCEPTION 'DISPOSITION_RETENTION_INPUT_INVALID' USING ERRCODE='22023';END IF;
  IF jsonb_array_length(row_seeds)>10000 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(row_seeds))<>jsonb_array_length(row_seeds) OR jsonb_array_length(retained_relations)>2000 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(retained_relations))<>jsonb_array_length(retained_relations) THEN RAISE EXCEPTION 'DISPOSITION_RETENTION_INPUT_INVALID' USING ERRCODE='22023';END IF;
  ${readerGuard}
  FOR part IN SELECT value FROM jsonb_array_elements(retained_relations) LOOP
   IF jsonb_typeof(part)<>'string' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(catalog_state->'relations') r WHERE 'public.'||(r->>'name')=part#>>'{}') THEN RAISE EXCEPTION 'DISPOSITION_RETENTION_INPUT_INVALID' USING ERRCODE='22023';END IF;
  END LOOP;
  FOR seed IN SELECT value FROM jsonb_array_elements(row_seeds) LOOP
   IF jsonb_typeof(seed)<>'object' OR seed-ARRAY['relation','key']<>'{}'::jsonb OR jsonb_typeof(seed->'relation') IS DISTINCT FROM 'string' OR jsonb_typeof(seed->'key') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'DISPOSITION_RETENTION_INPUT_INVALID' USING ERRCODE='22023';END IF;
   IF jsonb_array_length(seed->'key') NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'DISPOSITION_RETENTION_INPUT_INVALID' USING ERRCODE='22023';END IF;
   SELECT value INTO source_relation FROM jsonb_array_elements(catalog_state->'relations') WHERE 'public.'||(value->>'name')=seed->>'relation';
   IF NOT FOUND OR jsonb_array_length(source_relation->'primaryKey')<>jsonb_array_length(seed->'key') THEN RAISE EXCEPTION 'DISPOSITION_RETENTION_INPUT_INVALID' USING ERRCODE='22023';END IF;
   FOR part IN SELECT value FROM jsonb_array_elements(seed->'key') LOOP
    IF jsonb_typeof(part)<>'string' OR length(part#>>'{}')>2048 THEN RAISE EXCEPTION 'DISPOSITION_RETENTION_INPUT_INVALID' USING ERRCODE='22023';END IF;
   END LOOP;
  END LOOP;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_academy::text,374));
  IF EXISTS(SELECT 1 FROM platform_private.academy_legal_holds h WHERE h.academy_id=p_academy AND NOT EXISTS(SELECT 1 FROM platform_private.academy_legal_hold_releases r WHERE r.hold_id=h.id)) THEN RAISE EXCEPTION 'ACADEMY_LEGAL_HOLD_ACTIVE' USING ERRCODE='23514';END IF;
  EXECUTE ${literal('SELECT to_jsonb(snapshot) FROM ('+sql+') snapshot')} INTO data USING p_academy,row_seeds,p_max_rows,p_max_source_rows,retained_relations;
  IF (data->>'academy_count')::integer<>1 OR (data->>'accepted_count')::integer<>jsonb_array_length(row_seeds) THEN RAISE EXCEPTION 'DISPOSITION_RETENTION_SOURCE_MISSING' USING ERRCODE='23514';END IF;
  IF (data->>'retained_count')::integer>p_max_rows THEN RAISE EXCEPTION 'DISPOSITION_RETENTION_LIMIT_EXCEEDED' USING ERRCODE='23514';END IF;
  IF (data->'source_manifest'->>'totalRows')::integer>p_max_source_rows THEN RAISE EXCEPTION 'DISPOSITION_MANIFEST_LIMIT_EXCEEDED' USING ERRCODE='23514';END IF;
  IF data->'source_manifest' IS NULL OR (data->'source_manifest'->>'retainedRows')::integer<>(data->>'retained_count')::integer OR (data->'source_manifest'->>'totalRows')::integer<>(data->'source_manifest'->>'candidateRows')::integer+(data->>'retained_count')::integer THEN RAISE EXCEPTION 'DISPOSITION_MANIFEST_INVALID' USING ERRCODE='23514';END IF;
  ${readerGuard}
  PERFORM platform_private.authorize_owner(p_user,p_session);
  result=jsonb_build_object('schemaRevision',${catalog.schemaRevision},'structuralFingerprint',${literal(structure.structuralFingerprint)},'catalogFingerprint',current_hash,'snapshot',data,
   'sourceFingerprint',encode(sha256(convert_to(jsonb_build_object('academyId',p_academy,'catalogFingerprint',current_hash,'snapshot',data)::text,'UTF8')),'hex'),
   'retentionEvaluated',false,'executionAuthorized',false,'dataDeleted',false,'auditId',audit_id);
  -- Reuse the immutable private audit record for the exact bounded manifest.
  -- It contains counts and hashes,never record bodies or raw primary keys.
  -- A future review can reference this durable evidence without inventing a
  -- second snapshot store or treating a fingerprint alone as approval.
  INSERT INTO platform_private.audit_events(id,actor_user_id,session_id,action,academy_id,after_data,reason) VALUES(audit_id,p_user,p_session,'platform.disposition.snapshot.read',p_academy,jsonb_build_object('academyId',p_academy,'sourceFingerprint',result->'sourceFingerprint','retainedRows',data->'retained_count','candidateRows',data->'source_manifest'->'candidateRows','executionAuthorized',false,'manifest',result),btrim(p_purpose));
  RETURN result;
 END`;
 return{catalog,body,requiredBrokerGrants:`GRANT USAGE ON SCHEMA public,identity,platform_private TO ${dispositionInspectorRole};GRANT CREATE ON SCHEMA platform_private TO ${dispositionInspectorRole};
  GRANT SELECT(user_id) ON platform_private.owner_registration TO ${dispositionInspectorRole};
  GRANT SELECT(id,"emailVerified","phoneNumberVerified","phoneNumber","mfaRequired","twoFactorEnabled") ON identity."user" TO ${dispositionInspectorRole};
  GRANT SELECT(id,"userId","expiresAt","mfaVerified") ON identity.session TO ${dispositionInspectorRole};
  GRANT EXECUTE ON FUNCTION platform_private.authorize_owner(uuid,uuid,boolean),public.schema_revision() TO ${dispositionInspectorRole};
  GRANT INSERT ON platform_private.audit_events TO ${dispositionInspectorRole};
  GRANT SELECT(id,academy_id) ON platform_private.academy_legal_holds TO ${dispositionInspectorRole};GRANT SELECT(hold_id) ON platform_private.academy_legal_hold_releases TO ${dispositionInspectorRole};`,definition:`CREATE OR REPLACE FUNCTION platform_private.inspect_disposition_manifest(p_user uuid,p_session uuid,p_academy uuid,p_seeds jsonb,p_max_rows integer,p_max_source_rows integer,p_purpose text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog SET row_security=on SET jit=off SET work_mem='16MB' SET TimeZone='UTC' SET DateStyle='ISO,YMD' SET extra_float_digits=3 SET bytea_output=hex SET IntervalStyle=iso_8601
 AS ${literal(body)};
 ALTER FUNCTION ${dispositionInspectorSignature} OWNER TO ${dispositionInspectorRole};
 REVOKE ALL ON FUNCTION ${dispositionInspectorSignature} FROM PUBLIC;
  REVOKE CREATE ON SCHEMA platform_private FROM ${dispositionInspectorRole};
 GRANT EXECUTE ON FUNCTION ${dispositionInspectorSignature} TO kavosh_platform_policy;`,
  requiredExternalReads:catalog.foreignKeys.filter(f=>!catalog.relations.some(r=>r.schema===f.childSchema&&r.name===f.childRelation)&&catalog.relations.some(r=>r.schema===f.parentSchema&&r.name===f.parentRelation)).map(f=>`GRANT USAGE ON SCHEMA ${quoted(f.childSchema)} TO ${dispositionInspectorRole};GRANT SELECT(${f.childColumns.map(quoted).join(',')}) ON ${quoted(f.childSchema)}.${quoted(f.childRelation)} TO ${dispositionInspectorRole};`)};
}

import {createHash} from 'node:crypto';
import type {Connection} from '../core/database.ts';
import {dispositionCatalogQuery} from './disposition-schema.ts';
import {compileDispositionInspector,dispositionInspectorRole,dispositionInspectorSignature} from './disposition-native-inspector.ts';

type Installer=Pick<Connection,'query'>&{exec(sql:string):Promise<unknown>};
const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const literal=(s:string)=>"E'"+s.replaceAll('\\','\\\\').replaceAll("'","''")+"'";
const settings={search_path:'pg_catalog',row_security:'on',jit:'off',work_mem:'16MB',timezone:'UTC',datestyle:'ISO,YMD',extra_float_digits:'3',bytea_output:'hex',intervalstyle:'iso_8601'};

async function describe(db:Pick<Connection,'query'>){
 const metadata=(await db.query<{snapshot:unknown;fingerprint:string}>('SELECT meta.snapshot,encode(sha256(convert_to(meta.snapshot::text,\'UTF8\')),\'hex\') fingerprint FROM ('+dispositionCatalogQuery+') meta')).rows[0];
 const compiled=compileDispositionInspector(metadata.snapshot,metadata.fingerprint),bodyHash=createHash('sha256').update(compiled.body).digest('hex');
 const actual=(await db.query<{body_hash:string|null;configs:string[]|null;function_safe:boolean;boundary_safe:boolean;coverage_complete:boolean;dependencies_complete:boolean}>(`
  WITH reader AS(SELECT * FROM pg_catalog.pg_roles WHERE rolname=$1),target AS(SELECT p.* FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure($2)),relations AS(
   SELECT c.* FROM jsonb_array_elements($3::jsonb->'relations') meta JOIN pg_catalog.pg_namespace n ON n.nspname='public' JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=meta->>'name')
  SELECT (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM target) body_hash,(SELECT proconfig FROM target) configs,
   EXISTS(SELECT 1 FROM target p JOIN reader r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE p.prosecdef AND p.provolatile='v' AND p.proparallel='u' AND l.lanname='plpgsql'
    AND has_function_privilege('kavosh_platform_policy',p.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN(r.oid,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='kavosh_platform_policy')))) function_safe,
   EXISTS(SELECT 1 FROM reader r WHERE NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolinherit
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AND NOT has_schema_privilege(r.oid,'public','CREATE') AND NOT has_schema_privilege(r.oid,'platform_private','CREATE') AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM relations c WHERE pg_has_role(r.oid,c.relowner,'MEMBER') OR has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES'))) boundary_safe,
   EXISTS(SELECT 1 FROM reader r WHERE NOT EXISTS(SELECT 1 FROM relations c WHERE NOT c.relrowsecurity OR NOT has_table_privilege(r.oid,c.oid,'SELECT')
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND p.polname='disposition_reader_select' AND p.polcmd='r' AND p.polpermissive AND p.polroles=ARRAY[r.oid] AND pg_get_expr(p.polqual,p.polrelid)='true')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid AND NOT p.polpermissive AND p.polcmd IN('r','*') AND EXISTS(SELECT 1 FROM unnest(p.polroles) member WHERE CASE WHEN member=0 THEN true ELSE pg_has_role(r.oid,member,'USAGE') END)))) coverage_complete,
   EXISTS(SELECT 1 FROM reader r WHERE has_function_privilege(r.oid,'platform_private.authorize_owner(uuid,uuid,boolean)','EXECUTE') AND has_function_privilege(r.oid,'public.schema_revision()','EXECUTE') AND has_table_privilege(r.oid,'platform_private.audit_events','INSERT')
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['public','identity','platform_private']) n WHERE NOT has_schema_privilege(r.oid,n,'USAGE'))
    AND NOT EXISTS(SELECT 1 FROM(VALUES('platform_private.owner_registration',ARRAY['user_id']),('identity."user"',ARRAY['id','emailVerified','phoneNumberVerified','phoneNumber','mfaRequired','twoFactorEnabled']),('identity.session',ARRAY['id','userId','expiresAt','mfaVerified']),('platform_private.academy_legal_holds',ARRAY['id','academy_id']),('platform_private.academy_legal_hold_releases',ARRAY['hold_id'])) needed(tab,columns) CROSS JOIN LATERAL unnest(needed.columns) column_name WHERE NOT has_column_privilege(r.oid,needed.tab,column_name,'SELECT'))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($3::jsonb->'foreignKeys') fk WHERE fk->>'parentSchema'='public' AND EXISTS(SELECT 1 FROM relations p WHERE p.relname=fk->>'parentRelation') AND NOT(fk->>'childSchema'='public' AND EXISTS(SELECT 1 FROM relations c WHERE c.relname=fk->>'childRelation'))
     AND(NOT has_schema_privilege(r.oid,fk->>'childSchema','USAGE') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(fk->'childColumns') column_name WHERE NOT has_column_privilege(r.oid,format('%I.%I',fk->>'childSchema',fk->>'childRelation'),column_name,'SELECT'))))) dependencies_complete`,[dispositionInspectorRole,dispositionInspectorSignature,JSON.stringify(metadata.snapshot)])).rows[0];
 const configured=Object.fromEntries((actual.configs??[]).map(value=>{const at=value.indexOf('=');return[value.slice(0,at).toLowerCase(),value.slice(at+1)];}));
 const configCurrent=Object.entries(settings).every(([key,value])=>(key==='datestyle'?configured[key]?.replaceAll(' ',''):configured[key])===value)&&Object.keys(configured).length===Object.keys(settings).length;
 return{compiled,bodyHash,catalogFingerprint:metadata.fingerprint,boundarySafe:actual.boundary_safe===true,current:actual.boundary_safe===true&&actual.coverage_complete===true&&actual.dependencies_complete===true&&actual.function_safe===true&&actual.body_hash===bodyHash&&configCurrent};
}

// Metadata-only preflight: never returns function text,records or credentials.
export async function inspectDispositionInstallation(db:Pick<Connection,'query'>){
 const state=await describe(db);return{current:state.current,boundarySafe:state.boundarySafe,catalogFingerprint:state.catalogFingerprint,bodyHash:state.bodyHash};
}

// Caller owns BEGIN/COMMIT (migration runner or explicit operator transaction).
// No network-facing route imports or executes this installer.
export async function installDispositionInspectorInTransaction(db:Installer){
 const before=await describe(db);if(before.current)return{changed:false,catalogFingerprint:before.catalogFingerprint,bodyHash:before.bodyHash};
 if(!before.boundarySafe)throw new Error('UNSAFE_DISPOSITION_READER');
 await db.exec(before.compiled.requiredBrokerGrants);
 for(const r of before.compiled.catalog.relations){
  const table='public.'+quote(r.name);
  const policy=`BEGIN IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=${literal(table)}::regclass AND polname='disposition_reader_select') THEN EXECUTE ${literal(`CREATE POLICY disposition_reader_select ON ${table} FOR SELECT TO ${dispositionInspectorRole} USING(true)`)};END IF;END`;
  await db.exec(`GRANT SELECT ON ${table} TO ${dispositionInspectorRole};DO ${literal(policy)}`);
 }
 for(const grant of before.compiled.requiredExternalReads)await db.exec(grant);
 await db.exec(before.compiled.definition);
 const after=await describe(db);if(!after.current)throw new Error('DISPOSITION_INSPECTOR_INSTALLATION_INVALID');
 return{changed:true,catalogFingerprint:after.catalogFingerprint,bodyHash:after.bodyHash};
}

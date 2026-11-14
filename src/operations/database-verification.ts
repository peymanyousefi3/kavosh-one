import { createHash } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';

const digest=z.string().regex(/^[a-f0-9]{64}$/),fingerprint=z.object({rows:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),sha256:digest}).strict();
export const databaseVerification=z.object({format:z.literal('kavosh-database-verification-v1'),schemaRevision:z.number().int().positive(),
 tables:z.array(z.object({schema:z.string().min(1).max(63),name:z.string().min(1).max(63),fingerprint}).strict()).max(10000),
 relations:fingerprint,functions:fingerprint,policies:fingerprint,columnPrivileges:fingerprint.optional(),sequenceValuesCovered:z.literal(false),globalRolesCovered:z.literal(false)}).strict();
const clusterVerification=z.object({databaseAccess:fingerprint,globalRoleProperties:fingerprint}).strict();
export const backupVerification=z.object({archiveSha256:digest,snapshot:databaseVerification,cluster:clusterVerification.optional()}).strict();
const namespaces="n.nspname!~'^pg_' AND n.nspname<>'information_schema'";
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';

// pg's row event API does not accumulate result.rows when no callback is used.
// Sorts spill under the connection's bounded work_mem; only one decoded row is
// retained here. No plaintext row, signer detail or private value is returned.
export function fingerprintQuery(client:Pick<pg.Client,'query'>,sql:string,signal?:AbortSignal){
 if(signal?.aborted)return Promise.reject(new Error('VERIFICATION_CANCELLED'));
 return new Promise<z.infer<typeof fingerprint>>((resolve,reject)=>{
  const hash=createHash('sha256').update('kavosh-row-frames-v1\0');let rows=0,failure:Error|undefined;
  const q=new pg.Query<{value:string}>({text:sql});
  q.on('row',({value})=>{
   if(failure)return;
   if(signal?.aborted){failure=new Error('VERIFICATION_CANCELLED');return;}
   if(typeof value!=='string'||Buffer.byteLength(value)>67_108_864||rows>=Number.MAX_SAFE_INTEGER){failure=new Error('VERIFICATION_ROW_LIMIT');return;}
   const bytes=Buffer.from(value),length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(bytes.length));hash.update(length).update(bytes);rows++;
  });
  q.once('error',()=>reject(new Error('VERIFICATION_QUERY_FAILED')));
  q.once('end',()=>failure||signal?.aborted?reject(failure??new Error('VERIFICATION_CANCELLED')):resolve({rows,sha256:hash.digest('hex')}));
  client.query(q);
 });
}
// Separate from table/RLS equality;never expose raw role or database settings.
export function databaseAccessFingerprint(client:Pick<pg.Client,'query'>,signal?:AbortSignal){
 return fingerprintQuery(client,`SELECT jsonb_build_object('name',d.datname,'owner',pg_get_userbyid(d.datdba),'encoding',pg_encoding_to_char(d.encoding),'collation',d.datcollate,'ctype',d.datctype,'provider',to_jsonb(d)->>'datlocprovider','locale',coalesce(to_jsonb(d)->>'datlocale',to_jsonb(d)->>'daticulocale'),'collationVersion',d.datcollversion,'connections',d.datconnlimit,'allowed',d.datallowconn,'template',d.datistemplate,'acl',(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),a.grantee=0,CASE WHEN a.grantee=0 THEN NULL ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY pg_get_userbyid(a.grantor) COLLATE "C",a.grantee=0,pg_get_userbyid(a.grantee) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable) FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a),'settings',(SELECT jsonb_agg(jsonb_build_object('allRoles',s.setrole=0,'role',CASE WHEN s.setrole=0 THEN NULL ELSE pg_get_userbyid(s.setrole) END,'values',(SELECT jsonb_agg(v ORDER BY v COLLATE "C") FROM unnest(s.setconfig) v)) ORDER BY s.setrole=0,pg_get_userbyid(s.setrole) COLLATE "C") FROM pg_db_role_setting s WHERE s.setdatabase=d.oid))::text value FROM pg_database d WHERE d.datname=current_database()`,signal);
}
export async function clusterVerificationSnapshot(client:pg.Client,signal?:AbortSignal,excludedBootstrap?:string){
 if(signal?.aborted)throw new Error('VERIFICATION_CANCELLED');
 const state=(await client.query<{isolation:string;read_only:string;unfiltered:boolean}>("SELECT current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') read_only,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) unfiltered")).rows[0];
 if(state?.isolation!=='repeatable read'||state.read_only!=='on'||state.unfiltered!==true)throw new Error('VERIFICATION_SNAPSHOT_REQUIRED');
 return clusterVerification.parse({databaseAccess:await databaseAccessFingerprint(client,signal),globalRoleProperties:await globalRolePropertiesFingerprint(client,signal,excludedBootstrap)});
}
export function globalRolePropertiesFingerprint(client:Pick<pg.Client,'query'>,signal?:AbortSignal,excludedBootstrap?:string){
 if(excludedBootstrap!==undefined&&(!/^kavosh_recovery_bootstrap_[a-f0-9]{16,32}$/.test(excludedBootstrap)||/[\x00-\x1f\x7f]/.test(excludedBootstrap)))throw new Error('INVALID_RECOVERY_BOOTSTRAP');
 const exclude=excludedBootstrap?"'"+excludedBootstrap+"'":"NULL";
 return fingerprintQuery(client,`SELECT value FROM(SELECT 'role' kind,r.rolname name,'' secondary,to_jsonb(t)::text value FROM pg_roles r CROSS JOIN LATERAL(SELECT r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolconnlimit,r.rolvaliduntil AT TIME ZONE 'UTC' rolvaliduntil,(SELECT jsonb_agg(v ORDER BY v COLLATE "C") FROM unnest(r.rolconfig) v) configuration) t WHERE r.rolname IS DISTINCT FROM ${exclude} UNION ALL SELECT 'membership',r.rolname,m.rolname,to_jsonb(t)::text FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor CROSS JOIN LATERAL(SELECT r.rolname role,m.rolname member,g.rolname grantor,a.admin_option,a.inherit_option,a.set_option) t WHERE r.rolname IS DISTINCT FROM ${exclude} AND m.rolname IS DISTINCT FROM ${exclude}) records ORDER BY kind COLLATE "C",name COLLATE "C",secondary COLLATE "C",value COLLATE "C"`,signal);
}

// The caller MUST hold its original REPEATABLE READ transaction. Capture after
// pg_dump finishes but before COMMIT,using the same exported MVCC snapshot.
// Optional acceptance work only;ordinary nightly backups do not scan twice.
// Only authenticated legacy baselines may opt out;new exports always include
// column ACLs. Names,not attribute numbers,remain stable across dropped columns.
export function columnPrivilegesFingerprint(client:Pick<pg.Client,'query'>,signal?:AbortSignal){
 return fingerprintQuery(client,`SELECT jsonb_build_array(n.nspname,c.relname,a.attname,pg_get_userbyid(x.grantor),x.grantee=0,CASE WHEN x.grantee=0 THEN NULL ELSE pg_get_userbyid(x.grantee) END,x.privilege_type,x.is_grantable)::text value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE ${namespaces} AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",a.attname COLLATE "C",pg_get_userbyid(x.grantor) COLLATE "C",x.grantee=0,pg_get_userbyid(x.grantee) COLLATE "C",x.privilege_type COLLATE "C",x.is_grantable`,signal);
}
export async function databaseVerificationSnapshot(client:pg.Client,signal?:AbortSignal,includeColumnPrivileges=true){
 if(signal?.aborted)throw new Error('VERIFICATION_CANCELLED');
 const isolation=await client.query<{isolation:string;read_only:string}>("SELECT current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') read_only");
 if(isolation.rows[0]?.isolation!=='repeatable read'||isolation.rows[0]?.read_only!=='on')throw new Error('VERIFICATION_SNAPSHOT_REQUIRED');
 await client.query("SET LOCAL search_path=pg_catalog;SET LOCAL TIME ZONE 'UTC';SET LOCAL DateStyle='ISO, YMD';SET LOCAL IntervalStyle='postgres';SET LOCAL extra_float_digits=3;SET LOCAL work_mem='4MB'");
 const revision=(await client.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0].revision;
 const tables=(await client.query<{schema:string;name:string}>(`SELECT n.nspname schema,c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespaces} AND c.relkind IN('r','m') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`)).rows;
 if(tables.length>10000)throw new Error('VERIFICATION_TABLE_LIMIT');
 const result=[];
 for(const t of tables){if(signal?.aborted)throw new Error('VERIFICATION_CANCELLED');result.push({...t,fingerprint:await fingerprintQuery(client,`SELECT to_jsonb(t)::text value FROM ONLY ${quote(t.schema)}.${quote(t.name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`,signal)});}
 const relations=await fingerprintQuery(client,`SELECT to_jsonb(t)::text value FROM(SELECT n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) owner,c.reloptions,(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY pg_get_userbyid(a.grantor) COLLATE "C",(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable) FROM aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a) acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespaces}) t ORDER BY t.nspname COLLATE "C",t.relname COLLATE "C"`,signal);
 const functions=await fingerprintQuery(client,`SELECT to_jsonb(t)::text value FROM(SELECT n.nspname,p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) definition,(SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) ORDER BY pg_get_userbyid(a.grantor) COLLATE "C",(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C",a.privilege_type COLLATE "C",a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${namespaces} AND p.prokind IN('f','p')) t ORDER BY t.nspname COLLATE "C",t.signature COLLATE "C"`,signal);
 const policies=await fingerprintQuery(client,"SELECT to_jsonb(t)::text value FROM pg_policies t WHERE schemaname!~'^pg_' AND schemaname<>'information_schema' ORDER BY schemaname COLLATE \"C\",tablename COLLATE \"C\",policyname COLLATE \"C\"",signal);
 return databaseVerification.parse({format:'kavosh-database-verification-v1',schemaRevision:revision,tables:result,relations,functions,policies,...includeColumnPrivileges?{columnPrivileges:await columnPrivilegesFingerprint(client,signal)}:{},sequenceValuesCovered:false,globalRolesCovered:false});
}

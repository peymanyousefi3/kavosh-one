import { createHash } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';

const digest=z.string().regex(/^[a-f0-9]{64}$/),fingerprint=z.object({rows:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),sha256:digest}).strict();
export const databaseVerification=z.object({format:z.literal('kavosh-database-verification-v1'),schemaRevision:z.number().int().positive(),
 tables:z.array(z.object({schema:z.string().min(1).max(63),name:z.string().min(1).max(63),fingerprint}).strict()).max(10000),
 relations:fingerprint,functions:fingerprint,policies:fingerprint,sequenceValuesCovered:z.literal(false),globalRolesCovered:z.literal(false)}).strict();
export const backupVerification=z.object({archiveSha256:digest,snapshot:databaseVerification}).strict();
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

// The caller MUST hold its original REPEATABLE READ transaction. Capture after
// pg_dump finishes but before COMMIT,using the same exported MVCC snapshot.
// Optional acceptance work only;ordinary nightly backups do not scan twice.
export async function databaseVerificationSnapshot(client:pg.Client,signal?:AbortSignal){
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
 return databaseVerification.parse({format:'kavosh-database-verification-v1',schemaRevision:revision,tables:result,relations,functions,policies,sequenceValuesCovered:false,globalRolesCovered:false});
}

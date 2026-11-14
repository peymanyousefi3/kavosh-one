import { z } from 'zod';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';

const result=z.object({claimed:z.boolean(),published:z.number().int().min(0).max(100),processed:z.number().int().min(0).max(100),batchId:z.string().uuid().nullable()}).strict().refine(v=>(v.processed===0)===(v.batchId===null)&&v.published<=v.processed&&(!v.processed||v.claimed));
export async function assertPlatformNoticeWorker(db:Connection){
 const r=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND pg_has_role(current_user,'kavosh_platform_notice_worker','member')
 AND NOT EXISTS(SELECT 1 FROM pg_roles x WHERE (x.rolname IN('kavosh_runtime','kavosh_platform_service','kavosh_platform_policy') OR left(x.rolname,3)='pg_' OR x.rolsuper OR x.rolbypassrls OR x.rolcreaterole OR x.rolcreatedb OR x.rolreplication) AND pg_has_role(current_user,x.oid,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('identity','auth_private') AND has_schema_privilege(current_user,n.oid,'usage'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','identity','auth_private','platform_private') AND has_schema_privilege(current_user,n.oid,'create'))
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND c.relkind IN('r','p','v','m','f') AND(has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE(n.nspname='platform_private' OR(n.nspname IN('public','identity','auth_private') AND p.prosecdef)) AND p.oid NOT IN('platform_private.publish_cancellation_notices(integer)'::regprocedure,'platform_private.record_operational_health(jsonb)'::regprocedure) AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS safe FROM pg_roles r WHERE r.rolname=current_user`);
 if(r.rows[0]?.safe!==true)throw new Error('UNSAFE_PLATFORM_NOTICE_WORKER');
}
export async function processPlatformNotices(database:Database,limit=50){
 z.number().int().min(1).max(100).parse(limit);const db=await database.connect();let transaction=false,destroy=false;
 try{await assertPlatformNoticeWorker(db);await assertSchemaReady(db);await db.query('BEGIN');transaction=true;await db.query("SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true)");
  const r=result.parse((await db.query<{result:unknown}>('SELECT platform_private.publish_cancellation_notices($1) result',[limit])).rows[0]?.result);await db.query('COMMIT');transaction=false;return r;
 }catch(error){if(transaction)try{await db.query('ROLLBACK');}catch{destroy=true;}throw error;}finally{db.release(destroy);}
}

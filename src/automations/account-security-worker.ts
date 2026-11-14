import { z } from 'zod';
import { assertRuntimeRole,assertSchemaReady,type Database } from '../core/database.ts';

const academies=z.array(z.string().uuid().transform(v=>v.toLowerCase())).min(1).max(1000).refine(v=>new Set(v).size===v.length);
// One durable,school-bound native observation per cycle. This worker holds no
// identity/provider credentials and never creates an actor,session or approval.
export async function processOneAccountSecurity(database:Database,allowedAcademies:string[],signal?:AbortSignal){
 const ids=academies.parse(allowedAcademies);if(signal?.aborted)return {published:false};const db=await database.connect();let transaction=false,broken=false;
 try{
  await assertRuntimeRole(db,'automation_worker');await assertSchemaReady(db);await db.query('BEGIN');transaction=true;
  await db.query("SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)");
  const published=(await db.query<{published:boolean}>('SELECT public.publish_pending_account_security($1) published',[ids])).rows[0]?.published===true;
  if(signal?.aborted)throw new Error('WORKER_STOPPED');await db.query('COMMIT');transaction=false;return {published};
 }catch(error){if(transaction)try{await db.query('ROLLBACK');}catch{broken=true;}throw error;}finally{db.release(broken);}
}

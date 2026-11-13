import {z} from 'zod';
import {assertSchemaReady,type Database} from '../core/database.ts';
import {assertPlatformNoticeWorker} from './notice-worker.ts';
import {readOperationalHealthStatus} from '../operations/health-status.ts';

const result=z.object({claimed:z.boolean(),changed:z.number().int().min(0).max(40),sourceAccepted:z.boolean()}).strict();
export async function recordOperationalHealth(database:Database,read=readOperationalHealthStatus){
 const db=await database.connect();let transaction=false,destroy=false;
 try{
  await assertSchemaReady(db);await assertPlatformNoticeWorker(db);await db.query('BEGIN');transaction=true;
  await db.query("SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true)");
  // Lock BEFORE reading shared metadata. No parallel older file read can
  // manufacture a recovery after a newer observation has been recorded.
  const claimed=(await db.query<{claimed:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended('platform-operational-health',400)) claimed")).rows[0]?.claimed;
  if(!claimed){await db.query('ROLLBACK');transaction=false;return result.parse({claimed:false,changed:0,sourceAccepted:false});}
  let observation:{observedAt:string|null;issues:unknown[]}={observedAt:null,issues:[]};
  try{const value=await read();observation={observedAt:value.observedAt,issues:value.issues.filter(i=>i.component!=='monitor')};}catch{
   // Missing,unsafe or malformed metadata is not evidence of recovery. The
   // native clock records an unavailable-source incident without private errors.
  }
  const value=result.parse((await db.query<{result:unknown}>('SELECT platform_private.record_operational_health($1::jsonb) result',[JSON.stringify(observation)])).rows[0]?.result);
  await db.query('COMMIT');transaction=false;return value;
 }catch(error){if(transaction)try{await db.query('ROLLBACK');}catch{destroy=true;}throw error;}finally{db.release(destroy);}
}

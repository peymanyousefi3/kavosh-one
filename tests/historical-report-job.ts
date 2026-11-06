import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadGrants,mutation,record,type ApiContext } from '../src/core/api.ts';
import type { Credential } from '../src/core/policy.ts';
import { reportConfiguration } from '../src/modules/report-catalogue.ts';
import type { operationsFixture } from './operations-fixture.ts';

// Execute the actual130/131 queue protocol under its runtime grants,including
// authentication,rate accounting,audit and idempotency. No current worker or
// invented schema revision is used to seed a historical database.
export async function historicalReportJob(f:Awaited<ReturnType<typeof operationsFixture>>){
 const revision=(await f.pg.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0].revision;assert.ok([130,131].includes(revision));
 const key=randomUUID(),requestId=randomUUID(),configuration=reportConfiguration('finance.trial-balance',{through:'2026-12-31'},{}),actor=f.actors.master;await f.pg.exec('SET ROLE kavosh_runtime');let transaction=false;
 try{
  const credential=(await f.pg.query<Credential>('SELECT * FROM public.authenticate_human($1,$2,$3)',[actor.session,actor.user,f.a])).rows[0];assert.ok(credential?.allowed);credential.kind='human';
  await f.pg.exec('BEGIN');transaction=true;await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);assert.equal((await f.pg.query<{valid:boolean}>('SELECT public.lock_human($1,$2) valid',[actor.session,actor.user])).rows[0].valid,true);
  const db={query:f.pg.query.bind(f.pg),release(){}},request=new Request('https://academy.example/api/v1/reports/jobs',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify({reportId:configuration.reportId,parameters:{through:'2026-12-31'}})}),ctx:ApiContext={db,credential,grants:await loadGrants(db,credential),request,path:'reports/jobs',requestId};
  const reply=await mutation(ctx,configuration,async()=>{const id=randomUUID();await record(db,credential,requestId,'report.queued',id,null,{configuration,externalRequestMade:false});
   await f.pg.query(`INSERT INTO public.report_jobs(academy_id,id,configuration,requester_id,requester_kind,credential_id,user_id,enqueue_request_id,audit_id) SELECT $1,$2,$3::jsonb,$4,'human',$5,$6,$7,id FROM public.audit_events WHERE academy_id=$1 AND request_id=$7 AND action='report.queued' AND entity_id=$2`,[f.a,id,JSON.stringify(configuration),actor.person,actor.session,actor.user,requestId]);
   const data=(await f.pg.query('SELECT id,configuration,status,attempts,created_at,finished_at,expires_at,last_error FROM public.report_jobs WHERE id=$1',[id])).rows[0];return {status:202,body:{data,backgroundWorkerRequired:true,resultAvailable:false,externalRequestMade:false}};
  });await f.pg.exec('COMMIT');transaction=false;return {key,reply:JSON.parse(JSON.stringify(reply)) as typeof reply,configuration};
 }finally{if(transaction)await f.pg.exec('ROLLBACK');await f.pg.exec('RESET ROLE');}
}

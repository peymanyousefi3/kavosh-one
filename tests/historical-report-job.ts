import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { loadGrants,mutation,record,type ApiContext } from '../src/core/api.ts';
import { scopeContains,type Credential } from '../src/core/policy.ts';
import { lockApprovalWrites,permissionScope,readableApproval,type Proposal } from '../src/core/approvals.ts';
import { reportScheduleActions } from '../src/modules/report-schedules.ts';
import { reportConfiguration } from '../src/modules/report-catalogue.ts';
import type { operationsFixture } from './operations-fixture.ts';

// Execute the actual130..137 queue protocol under its runtime grants,including
// authentication,rate accounting,audit and idempotency. No current worker or
// invented schema revision is used to seed a historical database.
export async function historicalReportJob(f:Awaited<ReturnType<typeof operationsFixture>>,who='master'){
 const revision=(await f.pg.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0].revision;assert.ok(revision>=130&&revision<=137);
 const key=randomUUID(),requestId=randomUUID(),configuration=reportConfiguration('finance.trial-balance',{through:'2026-12-31'},{}),actor=f.actors[who];await f.pg.exec('SET ROLE kavosh_runtime');let transaction=false;
 try{
  const credential=(await f.pg.query<Credential>('SELECT * FROM public.authenticate_human($1,$2,$3)',[actor.session,actor.user,f.a])).rows[0];assert.ok(credential?.allowed);credential.kind='human';
  await f.pg.exec('BEGIN');transaction=true;await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);assert.equal((await f.pg.query<{valid:boolean}>('SELECT public.lock_human($1,$2) valid',[actor.session,actor.user])).rows[0].valid,true);
  const db={query:f.pg.query.bind(f.pg),release(){}},request=new Request('https://academy.example/api/v1/reports/jobs',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify({reportId:configuration.reportId,parameters:{through:'2026-12-31'}})}),ctx:ApiContext={db,credential,grants:await loadGrants(db,credential),request,path:'reports/jobs',requestId};
  const reply=await mutation(ctx,configuration,async()=>{const id=randomUUID();await record(db,credential,requestId,'report.queued',id,null,{configuration,...(revision>=132?{preset:null,windowResolution:null}:{}),externalRequestMade:false});
   await f.pg.query(`INSERT INTO public.report_jobs(academy_id,id,configuration,requester_id,requester_kind,credential_id,user_id,enqueue_request_id,audit_id) SELECT $1,$2,$3::jsonb,$4,'human',$5,$6,$7,id FROM public.audit_events WHERE academy_id=$1 AND request_id=$7 AND action='report.queued' AND entity_id=$2`,[f.a,id,JSON.stringify(configuration),actor.person,actor.session,actor.user,requestId]);
   const data=(await f.pg.query('SELECT id,configuration,status,attempts,created_at,finished_at,expires_at,last_error'+(revision>=132?',NULL::jsonb preset,NULL::jsonb "resolvedDateWindow"':'')+' FROM public.report_jobs WHERE id=$1',[id])).rows[0];return {status:202,body:{data,backgroundWorkerRequired:true,resultAvailable:false,externalRequestMade:false}};
  });await f.pg.exec('COMMIT');transaction=false;return {key,reply:JSON.parse(JSON.stringify(reply)) as typeof reply,configuration};
 }finally{if(transaction)await f.pg.exec('ROLLBACK');await f.pg.exec('RESET ROLE');}
}

// Narrow pre-assessment schedule SETUP protocol for real133..135 upgrade
// fixtures. This is not a claim that the current approval gateway ran there.
// Keep the actual staff owner,verified upper reviewer,source pins,native domain
// guards,revision,audit,outbox and request receipt. Never install future tables,
// forge readiness,disable approval guards or invent a master-owned replacement.
export async function historicalReportScheduleApproval(f:Awaited<ReturnType<typeof operationsFixture>>,approvalId:string){
 const revision=(await f.pg.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0].revision;assert.ok(revision>=133&&revision<=135);
 const actor=f.actors.manager,key=randomUUID(),requestId=randomUUID();await f.pg.exec('SET ROLE kavosh_runtime');let transaction=false;
 try{
  const credential=(await f.pg.query<Credential>('SELECT * FROM public.authenticate_human($1,$2,$3)',[actor.session,actor.user,f.a])).rows[0];assert.ok(credential?.allowed);credential.kind='human';
  await f.pg.exec('BEGIN');transaction=true;await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);assert.equal((await f.pg.query<{valid:boolean}>('SELECT public.lock_human($1,$2) valid',[actor.session,actor.user])).rows[0].valid,true);
  const db={query:f.pg.query.bind(f.pg),release(){}},ctx:ApiContext={db,credential,grants:await loadGrants(db,credential),request:new Request('https://academy.example/api/v1/approvals/'+approvalId+'/decide',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key}}),path:'approvals/'+approvalId+'/decide',requestId};
  await lockApprovalWrites(ctx,true);await readableApproval(ctx,approvalId);const p=(await f.pg.query<Proposal>('SELECT * FROM public.approval_requests WHERE id=$1 FOR UPDATE',[approvalId])).rows[0];assert.equal(p.action,'report.schedule.create');assert.equal(p.status,'pending');assert.equal(p.version,1);assert.equal(p.requester_kind,'human');assert.notEqual(p.requester_id,actor.person);
  assert.ok(scopeContains(permissionScope(ctx,'approvals.review'),p.scope));assert.equal((await f.pg.query<{valid:boolean}>('SELECT public.is_supervisor($1,$2) valid',[actor.person,p.requester_id])).rows[0].valid,true);
  const user=(await f.pg.query<{auth_user_id:string}>('SELECT auth_user_id FROM public.people WHERE id=$1',[p.requester_id])).rows[0],snapshot=p.credential_snapshot as Credential,owner=(await f.pg.query<Credential>('SELECT * FROM public.authenticate_human($1,$2,$3)',[snapshot.token_id,user.auth_user_id,f.a])).rows[0];assert.ok(owner?.allowed);owner.kind='human';assert.deepEqual(owner,snapshot);
  const definition=reportScheduleActions[p.action],requester={...ctx,credential:owner,grants:await loadGrants(db,owner)};assert.ok(scopeContains(await definition.validate(requester,p.target_id,p.payload,'request'),p.scope));assert.ok(scopeContains(await definition.validate(ctx,p.target_id,p.payload,'review'),p.scope));await definition.authorizeReviewer?.(ctx,p);
  const source=await definition.dependencies(ctx,p.target_id,p.payload,'review');assert.equal(createHash('sha256').update(JSON.stringify(source)).digest('hex'),p.dependency_hash);
  const reply=await mutation(ctx,{expectedVersion:1,decision:'approve',reason:'Historical exact schedule source reviewed'},async()=>{
   const data=await definition.apply(ctx,p);await f.pg.query("UPDATE public.approval_requests SET status='applied',version=version+1,reviewer_id=$2,reason='Historical exact schedule source reviewed',decided_at=now() WHERE id=$1",[p.id,actor.person]);
   await record(db,credential,requestId,'approval.applied',p.id,null,{before:'pending',after:'applied',hasReason:true,action:p.action,targetId:p.target_id});return {status:200,body:{data,approval:{id:p.id,status:'applied',version:2}}};
  });await f.pg.exec('COMMIT');transaction=false;return {status:reply.status,body:JSON.parse(JSON.stringify(reply.body))};
 }finally{if(transaction)await f.pg.exec('ROLLBACK');await f.pg.exec('RESET ROLE');}
}

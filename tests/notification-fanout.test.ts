import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { notificationFixture } from './notification-fixture.ts';

test('event batch queues only matching automatic rules and preserves durable per-requester deduplication',async()=>{
 const f=await notificationFixture();try{
  const a=await f.rule({},'BATCH_A'),b=await f.rule({},'BATCH_B');await f.rule({enabled:false},'DISABLED');await f.rule({execution:{...f.definition.execution,mode:'dry_run'}},'DRY');await f.rule({trigger:{kind:'domain_event',eventTypes:['approval.rejected']}},'OTHER_EVENT');
  const event=await f.source(),path='automations/events/'+event.id+'/queue',key=randomUUID(),result=await f.request(path,{},'staff',{key});assert.equal(result.response.status,202,JSON.stringify(result.body));assert.deepEqual(result.body.data.map((r:{ruleId:string})=>r.ruleId).sort(),[a.id,b.id].sort());assert.equal(result.body.delivered,false);assert.equal(result.body.externalRequestMade,false);assert.equal(result.body.nextCursor,null);
  assert.doesNotMatch(JSON.stringify(result.body),/credential_id|user_id|lease_token|personIds|PRIVATE/);assert.deepEqual((await f.request(path,{},'staff',{key})).body,result.body);
  const again=await f.request(path,{},'staff');assert.ok(again.body.data.every((r:{duplicate:boolean})=>r.duplicate));assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,2);assert.equal((await f.pg.query("SELECT * FROM public.portal_notifications WHERE origin='automation'")).rows.length,0);
  const jobs=(await f.pg.query('SELECT requester_id,credential_id,rule_version FROM public.notification_jobs')).rows;assert.ok(jobs.every(j=>j.requester_id===f.actors.staff.person&&j.credential_id===f.actors.staff.session&&j.rule_version===1));
  const applied=(await f.pg.query<{event_id:string}>("SELECT event_id FROM public.automation_event_sources WHERE event_type='approval.applied' ORDER BY event_id LIMIT 1")).rows[0];assert.ok(applied);const none=await f.request('automations/events/'+applied.event_id+'/queue',{});assert.equal(none.response.status,200);assert.deepEqual(none.body.data,[]);assert.equal(none.body.queued,false);assert.equal(none.body.backgroundWorkerRequired,false);assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,2);
 }finally{await f.pg.close();}
});
test('event batch filters rule view and execute scopes before its bounded cursor and rejects stale-permission replay',async()=>{
 const f=await notificationFixture();try{
  await f.rule({},'VISIBLE_A');await f.rule({},'VISIBLE_B');const hidden=await f.request('automations/rules',{hubId:f.otherHub,code:'HIDDEN',definition:{...f.definition,actions:[{...f.definition.actions[0],audience:{kind:'school_master'}}]},reason:'Other hub policy'});assert.equal(hidden.response.status,201);
  const event=await f.source(),path='automations/events/'+event.id+'/queue',key=randomUUID(),first=await f.request(path,{limit:1},'staff',{key});assert.equal(first.response.status,202,JSON.stringify(first.body));assert.equal(first.body.data.length,1);assert.ok(first.body.nextCursor);assert.notEqual(first.body.nextCursor,hidden.body.data.id);
  const second=await f.request(path,{limit:1,after:first.body.nextCursor},'staff');assert.equal(second.response.status,202);assert.equal(second.body.data.length,1);assert.equal(second.body.nextCursor,null);assert.notEqual(second.body.data[0].ruleId,hidden.body.data.id);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='automations.execute'",[f.staffRole]);assert.equal((await f.request(path,{limit:1},'staff',{key})).response.status,403);assert.equal((await f.request(path,{},'foreignMaster',{academy:f.b})).response.status,404);
  for(const input of [{limit:0},{limit:26},{after:'invalid'},{locale:'de'},{send:true}])assert.equal((await f.request(path,input)).response.status,400);
  assert.equal((await f.request(path,undefined)).response.status,405);
 }finally{await f.pg.close();}
});
test('batch queue is atomic when its audit/outbox cannot commit',async()=>{
 const f=await notificationFixture();try{
  await f.rule({},'ROLLBACK');const event=await f.source(),path='automations/events/'+event.id+'/queue',key=randomUUID();
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.request(path,{},'master',{key})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,0);assert.equal((await f.request(path,{},'master',{key})).response.status,202);assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,1);
 }finally{await f.pg.close();}
});
test('scoped bot batch retains the actual finite credential rather than borrowing master authority',async()=>{
 const f=await notificationFixture();try{
  await f.rule({},'BOT_BATCH');await f.pg.query('INSERT INTO public.assignment_hubs(academy_id,assignment_id,hub_id) SELECT $1,id,$2 FROM public.role_assignments WHERE person_id=$3 AND role_id=$4',[f.a,f.otherHub,f.bot,f.managerRole]);const proposed=await f.request('automations/rules',{hubId:f.hub,code:'BOT_SOURCE',definition:f.definition,reason:'Bot private source'},'bot');assert.equal(proposed.response.status,202);const event=(await f.pg.query<{event_id:string}>('SELECT event_id FROM public.automation_event_sources WHERE approval_id=$1',[proposed.body.approval.id])).rows[0];
  const path='automations/events/'+event.event_id+'/queue',key=randomUUID(),result=await f.request(path,{},'bot',{key});assert.equal(result.response.status,202,JSON.stringify(result.body));assert.equal(result.body.data.length,1);assert.equal((await f.pg.query('SELECT requester_id,credential_id FROM public.notification_jobs')).rows[0].requester_id,f.bot);assert.equal((await f.pg.query('SELECT credential_id FROM public.notification_jobs')).rows[0].credential_id,f.credential);
  await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs(credential_id,academy_id,hub_id) VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);assert.equal((await f.request(path,{},'bot',{key})).response.status,409,'cached page is bound to the exact current permission ceiling');
  await f.pg.query('UPDATE auth_private.credential_hubs SET hub_id=$2 WHERE credential_id=$1',[f.credential,f.otherHub]);assert.ok([403,404].includes((await f.request(path,{},'bot',{key})).response.status));assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,1);
 }finally{await f.pg.close();}
});
test('tiny concurrent event batches retain one durable job per rule and requester',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await notificationFixture();try{
  await f.rule({},'RACE');const event=await f.source(),path='automations/events/'+event.id+'/queue',began=performance.now(),results=await Promise.all([f.request(path,{},'staff'),f.request(path,{},'staff')]);assert.ok(results.every(r=>r.response.status===202));assert.equal((await f.pg.query('SELECT * FROM public.notification_jobs')).rows.length,1);assert.deepEqual(results.map(r=>r.body.data[0].duplicate).sort(),[false,true]);console.log(JSON.stringify({case:'notification-batch-two-requests',elapsedMs:Math.round(performance.now()-began)}));
 }finally{await f.pg.close();}
});

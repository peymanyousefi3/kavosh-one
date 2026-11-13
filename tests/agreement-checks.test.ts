import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

test('agreement attention queue and summary are read-only and strict;empty school is not an external completion claim',async()=>{
 const f=await operationsFixture();try{
  const before=(await f.pg.query('SELECT id FROM public.audit_events ORDER BY id')).rows;
  for(const path of ['agreement-checks','agreement-checks/summary']){const r=await f.request(path);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.data,[]);assert.equal(r.body.caseResolvedByReading,false);assert.equal(r.body.providerStatusFreshlyChecked,false);assert.equal(r.body.permissionsAppliedBeforeAggregation,true);assert.equal((await f.request(path,{})).response.status,405);}
  for(const tail of ['?limit=51','?limit=0','?attention=resolved','?purpose=arbitrary','?hubId=bad','?afterId='+randomUUID(),'?afterRecordedAt=2026-11-01T00:00:00Z','?limit=1&limit=2','?actorId='+f.actors.master.person])assert.equal((await f.request('agreement-checks'+tail)).response.status,400,tail);
  assert.equal((await f.request('agreement-checks/summary?limit=1')).response.status,400);
  assert.deepEqual((await f.pg.query('SELECT id FROM public.audit_events ORDER BY id')).rows,before);
  assert.equal((await f.pg.query('SELECT notification_id FROM public.portal_notification_reads')).rows.length,0);
 }finally{await f.pg.close();}
});
test('overview includes agreement work without a new admin grant and does not pretend unauthorized users have zero cases',async()=>{
 const f=await operationsFixture();try{
  const own=await f.request('overview?timeZone=America/Toronto');assert.equal(own.response.status,200,JSON.stringify(own.body));assert.ok(own.body.data.sections.some((s:{id:string;status:string})=>s.id==='agreement_checks'&&s.status==='available'));
  for(const actor of ['staff','bot']){assert.equal((await f.request('agreement-checks',undefined,actor)).response.status,403);const r=await f.request('overview?timeZone=America/Toronto&include=agreement_checks',undefined,actor);assert.equal(r.response.status,200);assert.equal(r.body.data.sections[0].status,'not_authorized');assert.equal(r.body.data.sections[0].rows,null);assert.equal(r.body.data.sections[0].listed,null);}
  const foreign=await f.request('agreement-checks',undefined,'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,200);assert.deepEqual(foreign.body.data,[]);
 }finally{await f.pg.close();}
});

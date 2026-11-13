import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';
import { requireCurrentSessionEvent,type BoundEvent } from '../src/modules/automation-events.ts';
import { assertRuntimeRole } from '../src/core/database.ts';

test('actual393to394 preserves old cases without retrospective alerts and retains worker isolation and preservation coverage',async()=>{
 const f=await operationsFixture({throughSchema:393});try{
  const connection=randomUUID(),start=randomUUID();await f.pg.query("INSERT INTO public.signature_connections(academy_id,id,region,environment,enabled) VALUES($1,$2,'CA','Test',true)",[f.a,connection]);
  await f.pg.query("INSERT INTO public.signature_completion_jobs(academy_id,purpose,start_id,connection_id,document_id,source_fingerprint,poll_until) VALUES($1,'worker_services',$2,$3,$4,$5,clock_timestamp()+interval '1 day')",[f.a,start,connection,randomUUID(),'a'.repeat(64)]);
  await f.pg.exec('SET ROLE kavosh_signature_completion_worker');try{assert.equal((await f.pg.query('SELECT * FROM public.claim_signature_completion_job($1,$2,60)',[[f.a],randomUUID()])).rows.length,0);}finally{await f.pg.exec('RESET ROLE');}
  const old=(await f.pg.query('SELECT * FROM public.signature_completion_incidents')).rows;assert.equal(old.length,1);
  await f.pg.exec(readFileSync(new URL('../db/migrations/394_signature_completion_alerts.sql',import.meta.url),'utf8'));await upgradeToCurrent(f.pg);
  assert.deepEqual((await f.pg.query('SELECT * FROM public.signature_completion_incidents')).rows,old);assert.equal((await f.pg.query("SELECT * FROM public.automation_event_sources WHERE source_kind='signature_check'")).rows.length,0);
  assert.equal((await f.pg.query("SELECT count(*)::integer n FROM platform_private.academy_preservation_coverage WHERE classification='preserved_record' AND NOT(delete_guard_present AND truncate_guard_present)")).rows[0].n,0);
  for(const [role,purpose] of [['kavosh_runtime','web'],['kavosh_automation_worker','automation_worker'],['kavosh_message_worker','message_worker']] as const){await f.pg.exec('SET ROLE '+role);try{await assertRuntimeRole({query:f.pg.query.bind(f.pg),release(){}},purpose);}finally{await f.pg.exec('RESET ROLE');}}
 }finally{await f.pg.close();}
});
test('signature failure sources cannot enter custom dispatch while its final delivery checks are disabled',()=>{
 const event={source_kind:'signature_check',source_current:true} as BoundEvent;
 assert.throws(()=>requireCurrentSessionEvent(event),{code:'AUTOMATION_SIGNATURE_CHECK_CUSTOM_DELIVERY_NOT_ENABLED'});
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));assert.ok(api.paths['/api/v1/automations/events'].get.parameters.find((p:{name:string})=>p.name==='sourceKind').schema.enum.includes('signature_check'));
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {operationsFixture} from './operations-fixture.ts';
import {upgradeToCurrent} from './migration-upgrade.ts';
import {createPlatformApi} from '../src/platform/api.ts';
import {evaluateOperationalHealth} from '../src/operations/operational-health.ts';
import type {Database} from '../src/core/database.ts';

test('operational health real database enforces current owner MFA and immutable audit before metadata access',async()=>{
 const f=await operationsFixture({throughSchema:396});try{
  const owner=f.actors.master;await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Synthetic operational owner']);
  const authoritySql="SELECT oid,proowner,proacl FROM pg_proc WHERE oid='platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure",authority=(await f.pg.query(authoritySql)).rows,people=(await f.pg.query('SELECT * FROM public.people ORDER BY id')).rows,audit=(await f.pg.query('SELECT * FROM platform_private.audit_events ORDER BY id')).rows;
  await upgradeToCurrent(f.pg);assert.deepEqual((await f.pg.query(authoritySql)).rows,authority);assert.deepEqual((await f.pg.query('SELECT * FROM public.people ORDER BY id')).rows,people);assert.deepEqual((await f.pg.query('SELECT * FROM platform_private.audit_events ORDER BY id')).rows,audit);
  let reads=0;const database:Database={async connect(){if(f.pg.runtime){const c=await f.pg.runtime.connect();await c.query('SET ROLE kavosh_platform_service');return c;}await f.pg.exec('SET ROLE kavosh_platform_service');return {query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}};}};
  const api=createPlatformApi(database,async r=>{const actor=f.actors[r.headers.get('x-test-actor')??''];return actor?{userId:actor.user,sessionId:actor.session}:null;},true,{readOperationalHealth:async()=>{reads++;const done={active:'inactive',result:'success',exitStatus:0,lastSuccessfulExitAt:new Date().toISOString()};return evaluateOperationalHealth({observedAt:new Date().toISOString(),ready:true,freeBackupDiskBytes:'50000000000',web:{...done,active:'active'},backup:done,configuration:done,backupTimerActive:true,configurationTimerActive:true});}});
  const request=async(actor:string)=>{try{return await api(new Request('https://example.test/api/platform/v1/operations/health',{headers:{'x-test-actor':actor}}),'operations/health');}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}};
  for(const actor of ['manager','staff','foreignMaster'])assert.equal((await request(actor)).status,403);assert.equal(reads,0);
  const success=await request('master');assert.equal(success.status,200,JSON.stringify(await success.clone().json()));assert.equal((await success.json()).data.status,'healthy');assert.equal(reads,1);
  const events=(await f.pg.query<{id:string;after_data:unknown}>("SELECT id,after_data FROM platform_private.audit_events WHERE action='platform.operations.health.access' AND actor_user_id=$1",[owner.user])).rows;assert.equal(events.length,1);assert.deepEqual(events[0].after_data,{scope:'same_vps_operational_metadata',serviceControlGranted:false});
  await assert.rejects(f.pg.query('DELETE FROM platform_private.audit_events WHERE id=$1',[events[0].id]),/PLATFORM_HISTORY_IMMUTABLE/);
  await f.pg.query('UPDATE identity.session SET "mfaVerified"=false WHERE id=$1',[owner.session]);assert.equal((await request('master')).status,403);assert.equal(reads,1);
  await f.pg.query('UPDATE identity.session SET "mfaVerified"=true WHERE id=$1',[owner.session]);
  await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id=$1',[owner.user]);assert.equal((await request('master')).status,403);assert.equal(reads,1);
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

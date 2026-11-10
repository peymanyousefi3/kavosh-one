import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { createPlatformApi,assertPlatformRole } from '../src/platform/api.ts';
import type { Database } from '../src/core/database.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';

const definition={name:'Synthetic free academy',description:'Reference terms only',currencyCode:'CAD',unitScale:2,amountMinor:'0',periodMonths:1,graceDays:30,active:true};
async function fixture(options:{throughSchema?:number}={}){
 const f=await operationsFixture(options);try{
  const owner=f.actors.master;await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Synthetic verified platform owner']);
  const database:Database={async connect(){if(f.pg.runtime){const c=await f.pg.runtime.connect();await c.query('SET ROLE kavosh_platform_service');return c;}await f.pg.exec('SET ROLE kavosh_platform_service');return{query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}};}};
  const api=createPlatformApi(database,async r=>{const a=f.actors[r.headers.get('x-test-actor')??''];return a?{userId:a.user,sessionId:a.session}:null;},true);
  async function request(path:string,body?:unknown,actor='master',key:string=randomUUID()){
   try{const response=await api(new Request('https://academy.example/api/platform/v1/'+path,{method:body===undefined?'GET':'POST',headers:{'x-test-actor':actor,'content-type':'application/json','idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})}),path.split('?')[0]);return{response,body:await response.json()};}
   finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  }
  return{...f,owner,request,create:(key?:string)=>request('plans',{definition,reason:'Synthetic free school plan'},'master',key)};
 }catch(e){await f.pg.close();throw e;}
}
test('platform plans persist exact zero and large prices, editable terms, archive, copies and bounded immutable history without tuition effects',async()=>{
 const f=await fixture();try{
  const schools=(await f.pg.query('SELECT * FROM public.academies ORDER BY id')).rows,key=randomUUID(),first=await f.create(key);assert.equal(first.response.status,201,JSON.stringify(first.body));assert.equal(first.response.headers.get('cache-control'),'no-store');assert.equal(first.body.chargesPerformed,false);assert.equal(first.body.schoolAccessChanged,false);
  assert.deepEqual((await f.create(key)).body,first.body);const id=first.body.data.id;
  const changedDefinition={...definition,amountMinor:'99999999999999999999999999999999999999',active:false};
  const changed=await f.request('plans/'+id+'/change',{expectedVersion:1,definition:changedDefinition,reason:'Synthetic archive and exact large reference price'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));assert.equal(changed.body.data.version,2);
  assert.equal((await f.request('plans/'+id)).body.data.definition.amountMinor,changedDefinition.amountMinor);
  const copy=await f.request('plans/'+id+'/duplicate',{expectedVersion:2,name:'Synthetic copied plan',reason:'Synthetic exact edition copy'});assert.equal(copy.response.status,201,JSON.stringify(copy.body));assert.equal(copy.body.data.sourcePlanId,id);assert.equal(copy.body.data.sourceVersion,2);assert.deepEqual(copy.body.data.definition,{...changedDefinition,name:'Synthetic copied plan'});
  const history=(await f.request('plans/'+id+'/history?limit=1')).body;assert.equal(history.data.length,1);assert.equal(history.nextBeforeVersion,2);
  assert.deepEqual((await f.request('plans/'+id+'/history?limit=1&beforeVersion='+history.nextBeforeVersion)).body.data.map((e:any)=>e.version),[1]);
  const page=(await f.request('plans?limit=1')).body;assert.equal(page.data.length,1);assert.ok(page.nextCursor);assert.equal((await f.request('plans?limit=1&after='+page.nextCursor)).body.data.length,1);
  assert.equal((await f.request('plans?limit=1&limit=2')).response.status,400);assert.equal((await f.request('plans/'+id+'/history?beforeVersion=0')).response.status,400);
  const editions=await f.request('plans/'+id+'/history');assert.deepEqual(editions.body.data.map((e:any)=>e.version),[2,1]);assert.deepEqual(editions.body.data[1].definition,definition);
  assert.deepEqual((await f.pg.query('SELECT * FROM public.academies ORDER BY id')).rows,schools);
  assert.equal((await f.pg.query('SELECT * FROM platform_private.subscription_plan_editions')).rows.length,3);
  await assert.rejects(f.pg.exec('UPDATE platform_private.subscription_plan_editions SET definition=definition'),/PLATFORM_HISTORY_IMMUTABLE/);
  await assert.rejects(f.pg.exec('DELETE FROM platform_private.subscription_plans'),/PLATFORM_HISTORY_IMMUTABLE/);
 }finally{await f.pg.close();}
});
test('platform plans reject stale versions, changed retries, malformed money and native SQL bypass, and require current owner MFA',async()=>{
 const f=await fixture();try{
  const key=randomUUID(),first=await f.create(key),id=first.body.data.id;assert.equal(first.response.status,201);
  assert.equal((await f.request('plans',{definition:{...definition,name:'Changed retry'},reason:'Synthetic free school plan'},'master',key)).response.status,409);
  for(const patch of [{amountMinor:'-1'},{amountMinor:'1.1'},{amountMinor:'01'},{amountMinor:5},{currencyCode:'cad'},{unitScale:19},{periodMonths:0},{graceDays:366},{extra:true}])assert.equal((await f.request('plans',{definition:{...definition,...patch},reason:'Synthetic bad terms'})).response.status,400);
  assert.equal((await f.request('plans/'+id+'/change',{expectedVersion:2,definition:{...definition,active:false},reason:'Synthetic stale version'})).response.status,409);
  assert.equal((await f.request('plans/'+id+'/duplicate',{expectedVersion:2,name:'Synthetic stale copy',reason:'Synthetic stale source'})).response.status,409);
  assert.equal((await f.request('plans/'+randomUUID())).response.status,404);
  assert.equal((await f.create()).response.status,201);
  assert.equal((await f.request('plans',undefined,'foreignMaster')).response.status,403);
  await f.pg.exec('SET ROLE kavosh_platform_service');try{
   await assertPlatformRole({query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}});
   await assert.rejects(f.pg.query('SELECT * FROM platform_private.subscription_plans'),/permission denied/);
   await assert.rejects(f.pg.query('SELECT platform_private.plan_request($1,$2,$3,$4,$5::jsonb)',[f.owner.user,f.owner.session,'plans.create',randomUUID(),JSON.stringify({definition,reason:'Synthetic bypass'})]),/permission denied/);
   await assert.rejects(f.pg.query('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb)',[f.owner.user,f.owner.session,'plans.create',randomUUID(),JSON.stringify({definition:{...definition,amountMinor:'-9'},reason:'Synthetic native invalid price'})]),/INVALID_PLATFORM_INPUT/);
  }finally{await f.pg.exec('RESET ROLE');}
  await f.pg.query('UPDATE identity.session SET "mfaVerified"=false WHERE id=$1',[f.owner.session]);
  assert.equal((await f.create(key)).response.status,403);assert.equal((await f.request('plans')).response.status,403);
 }finally{await f.pg.close();}
});
test('platform plan missing audit or immutable edition rolls the entire transaction back, preserving its retry',async()=>{
 const f=await fixture();try{
  for(const [table,condition] of [['audit_events',"NEW.action='platform.plans.created'"],['subscription_plan_editions','true']] as const){
   const key=randomUUID();await f.pg.exec(`CREATE FUNCTION platform_private.synthetic_skip_plan_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RETURN NULL;END IF;RETURN NEW;END $$;CREATE TRIGGER synthetic_skip BEFORE INSERT ON platform_private.${table} FOR EACH ROW EXECUTE FUNCTION platform_private.synthetic_skip_plan_effect()`);
   const before=(await f.pg.query('SELECT * FROM platform_private.subscription_plans ORDER BY id')).rows;const result=await f.create(key);assert.equal(result.response.status,503,JSON.stringify(result.body));assert.deepEqual((await f.pg.query('SELECT * FROM platform_private.subscription_plans ORDER BY id')).rows,before);assert.equal((await f.pg.query('SELECT * FROM platform_private.request_receipts WHERE request_key=$1',[key])).rows.length,0);
   await f.pg.exec(`DROP TRIGGER synthetic_skip ON platform_private.${table};DROP FUNCTION platform_private.synthetic_skip_plan_effect()`);assert.equal((await f.create(key)).response.status,201);
  }
 }finally{await f.pg.close();}
});
test('platform plans brief native concurrent retry and edit checks create one edition per winning request',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{const start=performance.now(),key=randomUUID(),[a,b]=await Promise.all([f.create(key),f.create(key)]);assert.equal(a.response.status,201);assert.deepEqual(a.body,b.body);const id=a.body.data.id;
  const [x,y]=await Promise.all([f.request('plans/'+id+'/change',{expectedVersion:1,definition:{...definition,name:'Synthetic winner A'},reason:'Synthetic concurrent change A'}),f.request('plans/'+id+'/change',{expectedVersion:1,definition:{...definition,name:'Synthetic winner B'},reason:'Synthetic concurrent change B'})]);assert.deepEqual([x.response.status,y.response.status].sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM platform_private.subscription_plan_editions WHERE plan_id=$1',[id])).rows.length,2);console.info('Platform catalogue concurrent retry/edit check ms:',Math.round(performance.now()-start));
 }finally{await f.pg.close();}
});
test('actual 308 to309 platform upgrade preserves schools, identities and gateway identity and permissions',async()=>{
 const f=await fixture({throughSchema:308});try{
  const schools=(await f.pg.query('SELECT * FROM public.academies ORDER BY id')).rows,users=(await f.pg.query('SELECT * FROM identity."user" ORDER BY id')).rows,gateway=(await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid='platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure")).rows;
  await upgradeToCurrent(f.pg);assert.deepEqual((await f.pg.query('SELECT * FROM public.academies ORDER BY id')).rows,schools);assert.deepEqual((await f.pg.query('SELECT * FROM identity."user" ORDER BY id')).rows,users);assert.deepEqual((await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid='platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure")).rows,gateway);assert.equal((await f.create()).response.status,201);
 }finally{await f.pg.close();}
});

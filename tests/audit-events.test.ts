import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import {auditDiff} from '../src/core/audit-diff.ts';

test('audit field comparison preserves missing versus null,atomic arrays,object key order and bounded complete results',()=>{
 const diff=auditDiff({before:{name:'Before',gone:null,nested:{same:1,changed:false},array:[1,2]},after:{name:'After',added:null,nested:{changed:true,same:1},array:[2,1]}});assert.equal(diff.availability,'recorded');assert.deepEqual(diff.fields.map(f=>f.path),[['added'],['array'],['gone'],['name'],['nested','changed']]);assert.deepEqual(diff.fields[0],{path:['added'],beforePresent:false,afterPresent:true,after:null});assert.deepEqual(diff.fields[2],{path:['gone'],beforePresent:true,afterPresent:false,before:null});
 assert.deepEqual(auditDiff({before:[{a:1,b:2}],after:[{b:2,a:1}]}).fields,[]);assert.equal(auditDiff({after:{name:'No invented past'}}).availability,'not_recorded');assert.deepEqual(auditDiff({before:'active',after:'disabled'}).fields,[{path:[],beforePresent:true,afterPresent:true,before:'active',after:'disabled'}]);
 assert.equal(auditDiff({before:Object.fromEntries(Array.from({length:2100},(_,i)=>['f'+i,0])),after:Object.fromEntries(Array.from({length:2100},(_,i)=>['f'+i,0]))}).availability,'limit_exceeded');
 for(const value of [{before:{},after:Object.fromEntries(Array.from({length:101},(_,i)=>['field'+i,i]))},{before:'',after:'x'.repeat(65536)},{before:{},after:JSON.parse('{"a":'.repeat(14)+'1'+'}'.repeat(14))}]){const result=auditDiff(value);assert.equal(result.availability,'limit_exceeded');assert.deepEqual(result.fields,[]);}
 const keys=JSON.parse('{"__proto__":"before","a.b":null}');assert.deepEqual(auditDiff({before:keys,after:JSON.parse('{"__proto__":"after","a.b":1}')}).fields.map(f=>f.path),[['__proto__'],['a.b']]);assert.equal(({} as {polluted?:unknown}).polluted,undefined);
});

test('real bot rename produces an authorized field comparison without private reasons and retains hub/school/revocation gates',async()=>{
 const f=await operationsFixture();try{
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'audit.view','allow')",[f.a,f.staffRole]);const before=(await f.pg.query<{name:string}>('SELECT name FROM public.people WHERE id=$1',[f.bot])).rows[0].name;
  const renamed=await f.request('bots/'+f.bot+'/name',{expectedNameVersion:0,name:'Updated operations assistant',reason:'PRIVATE_COMPARISON_REASON'});assert.equal(renamed.response.status,200,JSON.stringify(renamed.body));const event=(await f.pg.query<{id:string}>("SELECT id FROM public.audit_events WHERE entity_id=$1 AND action='bot.rename'",[f.bot])).rows[0],path='audit-events/'+event.id+'/diff';
  const read=await f.request(path,undefined,'staff');assert.equal(read.response.status,200,JSON.stringify(read.body));assert.deepEqual(read.body.data.fields,[{path:['name'],beforePresent:true,afterPresent:true,before,after:'Updated operations assistant'}]);assert.equal(read.body.data.availability,'recorded');assert.doesNotMatch(JSON.stringify(read.body),/PRIVATE_COMPARISON_REASON|credential|session/);
  assert.equal((await f.request(path,undefined,'foreignMaster',{academy:f.b})).response.status,404);assert.equal((await f.request(path,undefined,'peer')).response.status,403);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'audit.view','allow')",[f.a,f.managerRole]);assert.equal((await f.request(path,undefined,'peer')).response.status,404);assert.equal((await f.request(path+'?includePrivate=true')).response.status,400);assert.equal((await f.request(path,{})).response.status,405);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='audit.view'",[f.staffRole]);assert.equal((await f.request(path,undefined,'staff')).response.status,403);
 }finally{await f.pg.close();}
});

async function fixture(){const f=await operationsFixture();try{
 for(const role of [f.staffRole,f.managerRole])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'audit.view','allow')",[f.a,role]);
 const create=async(hubId:string,as='master')=>{const r=await f.request('people',{name:'Synthetic audit subject',hubId},as);assert.equal(r.response.status,201,JSON.stringify(r.body));return r.body.data.id as string;};
 const own=await create(f.hub),other=await create(f.otherHub);const probe=await f.request('people',undefined,'bot');if(probe.response.status===401)await f.refreshBotCredential();else assert.equal(probe.response.status,200);const botEntity=await create(f.hub,'bot');
 const event=async(entity:string)=>(await f.pg.query<{id:string;request_id:string;stamp:string}>(`SELECT id,request_id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') stamp FROM public.audit_events WHERE entity_id=$1 AND action='person.created'`,[entity])).rows[0];
 return {...f,own,other,botEntity,event};
 }catch(e){await f.pg.close();throw e;}}
test('audit searches match real human and bot writes by exact actor record request action kind and microsecond timestamps',async()=>{
 const f=await fixture();try{const e=await f.event(f.own),q=new URLSearchParams({actorId:f.actors.master.person,entityId:f.own,requestId:e.request_id,action:'person.created',actorKind:'human',from:e.stamp,through:e.stamp}),r=await f.request('audit-events?'+q);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.data.map((v:any)=>v.id),[e.id]);assert.equal(r.body.data[0].actorKind,'human');assert.equal(r.body.data[0].created_at,e.stamp);assert.equal(r.response.headers.get('cache-control'),'no-store');assert.doesNotMatch(JSON.stringify(r.body),/credential_id|session_id|token_hash/);
 const bot=await f.request('audit-events?actorId='+f.bot+'&actorKind=bot');assert.deepEqual(bot.body.data.map((v:any)=>v.entity_id),[f.botEntity]);const wrong=await f.request('audit-events?entityId='+f.own+'&actorKind=bot');assert.deepEqual(wrong.body.data,[]);
 assert.deepEqual((await f.request('audit-events/'+e.id)).body.data,r.body.data[0]);
 }finally{await f.pg.close();}
});
test('audit filters never grant another hub school or revoked feature access and retain readonly review',async()=>{
 const f=await fixture();try{const own=await f.event(f.own),other=await f.event(f.other);assert.equal((await f.request('audit-events/'+own.id,undefined,'staff')).response.status,200);assert.equal((await f.request('audit-events/'+other.id,undefined,'staff')).response.status,404);assert.deepEqual((await f.request('audit-events?entityId='+f.other,undefined,'staff')).body.data,[]);assert.equal((await f.request('audit-events/'+own.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='audit.view'",[f.staffRole]);assert.equal((await f.request('audit-events?entityId='+f.own,undefined,'staff')).response.status,403);assert.equal((await f.request('audit-events/'+own.id,undefined,'staff')).response.status,403);await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.request('audit-events/'+own.id)).response.status,200);
 }finally{await f.pg.close();}
});
test('audit search validates strict selectors duplicate keys timestamp precision and matching filtered cursor pages',async()=>{
 const f=await fixture();try{for(const q of ['actorKind=system','action=person.%25','limit=101','actorId=not-a-uuid','action=person.created&action=hub.created','includePrivate=true','from=2026-01-01T00:00:00.000002Z&through=2026-01-01T00:00:00.000001Z','from=2026-01-01T00:00:00.0000001Z','from=2026-01-01','from=invalid&through=invalid','from=2026-02-30T00:00:00Z&through=2026-03-01T00:00:00Z','from=1969-12-31T23:59:59.999501Z&through=1969-12-31T23:59:59.999500Z'])assert.equal((await f.request('audit-events?'+q)).response.status,400,q);
 const equivalent=new URLSearchParams({from:'2026-01-01T01:00:00.000001+01:00',through:'2026-01-01T00:00:00.000001Z'});assert.equal((await f.request('audit-events?'+equivalent)).response.status,200);equivalent.set('from','2026-01-01T01:00:00.000002+01:00');assert.equal((await f.request('audit-events?'+equivalent)).response.status,400);
 const e=await f.event(f.own);assert.equal((await f.request('audit-events/'+e.id+'?limit=1')).response.status,400);assert.equal((await f.request('audit-events/'+e.id,{})).response.status,405);assert.equal((await f.request('audit-events/'+randomUUID())).response.status,404);
 const all=(await f.request('audit-events?action=person.created',undefined,'staff')).body.data,seen:string[]=[];let after:string|null=null;do{const r=await f.request('audit-events?action=person.created&limit=1'+(after?'&after='+after:''),undefined,'staff');assert.equal(r.response.status,200);seen.push(...r.body.data.map((v:any)=>v.id));after=r.body.nextCursor;}while(after);assert.deepEqual(seen,all.map((v:any)=>v.id));assert.equal(new Set(seen).size,2);
 }finally{await f.pg.close();}
});
test('audit explicit geographic denial excludes global events even before the denied country has any hubs',async()=>{
 const f=await fixture();try{
  const country=await f.request('locations/countries',{code:'FR',name:'Synthetic France'});assert.equal(country.response.status,201,JSON.stringify(country.body));
  const makeRole=async(name:string,effect:string)=>{const r=await f.request('roles',{name,permissions:[{capability:'audit.view',effect}]});assert.equal(r.response.status,201,JSON.stringify(r.body));return r.body.data.id;},allow=await makeRole('Global audit','allow'),deny=await makeRole('Geographic audit deny','deny'),old=await f.request('people/'+f.actors.staff.person+'/access');
  const assigned=await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:old.body.data.version,assignments:[{roleId:allow,allHubs:true},{roleId:deny,allHubs:false,countryIds:[country.body.data.id]}]});assert.equal(assigned.response.status,200,JSON.stringify(assigned.body));
  const global=(await f.pg.query<{id:string}>('SELECT id FROM public.audit_events WHERE entity_id=$1 AND hub_id IS NULL ORDER BY id LIMIT 1',[allow])).rows[0];assert.ok(global);assert.equal((await f.request('audit-events/'+global.id,undefined,'staff')).response.status,404);assert.equal((await f.request('audit-events/'+(await f.event(f.own)).id,undefined,'staff')).response.status,200);assert.deepEqual((await f.request('audit-events?entityId='+allow,undefined,'staff')).body.data,[]);
 }finally{await f.pg.close();}
});
test('audit exact detail and directory retain legacy private approval reason redaction without rewriting history',async()=>{
 const f=await fixture();try{for(const cap of ['assessment-rubrics.view','assessment-rubrics.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,cap]);const proposed=await f.request('assessment-rubrics',{hubId:f.hub,definition:{name:'Private audit review',criteria:[{code:'focus',labels:{en:'Focus'}}]},reason:'Synthetic private case'},'manager');assert.equal(proposed.response.status,202,JSON.stringify(proposed.body));const pending=proposed.body.approval;assert.equal((await f.pg.query('SELECT privacy_capability FROM public.approval_requests WHERE id=$1',[pending.id])).rows[0].privacy_capability,'assessment-rubrics.view');const eventId=randomUUID(),privateReason='PRIVATE_AUDIT_LEGACY_NOTE';await f.pg.query(`INSERT INTO public.audit_events(academy_id,id,actor_id,actor_kind,session_id,request_id,action,entity_id,changes) VALUES($1,$2,$3,'human',$4,$5,'approval.rejected',$6,$7::jsonb)`,[f.a,eventId,f.actors.master.person,f.actors.master.session,randomUUID(),pending.id,JSON.stringify({reason:privateReason,after:'rejected'})]);
 for(const path of ['audit-events/'+eventId,'audit-events?entityId='+pending.id]){const r=await f.request(path);assert.equal(r.response.status,200,JSON.stringify(r.body));assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE_AUDIT_LEGACY_NOTE/);const rows=Array.isArray(r.body.data)?r.body.data:[r.body.data];assert.equal(rows.find((v:any)=>v.id===eventId).changes.hasReason,true);}
 const comparison=await f.request('audit-events/'+eventId+'/diff');assert.equal(comparison.response.status,200);assert.equal(comparison.body.data.availability,'not_recorded');assert.deepEqual(comparison.body.data.fields,[]);assert.doesNotMatch(JSON.stringify(comparison.body),/PRIVATE_AUDIT_LEGACY_NOTE/);
 assert.equal((await f.pg.query<{reason:string}>('SELECT changes->>\'reason\' reason FROM public.audit_events WHERE id=$1',[eventId])).rows[0].reason,privateReason);
 }finally{await f.pg.close();}
});

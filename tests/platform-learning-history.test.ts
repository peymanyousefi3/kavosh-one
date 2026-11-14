import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reportFixture} from './report-fixture.ts';
import {upgradeToCurrent} from './migration-upgrade.ts';
import {createPlatformApi,assertPlatformRole} from '../src/platform/api.ts';
import type {Database} from '../src/core/database.ts';

test('owner learning history keeps exact retained editions and complete byte-bounded pages across a populated upgrade',async()=>{
 const f=await reportFixture(404);try{
  assert.equal((await f.save()).response.status,201);
  const revised={...f.document,title:'PRIVATE revised draft'};assert.equal((await f.save({...f.input,expectedVersion:1,document:revised})).response.status,200);
  const owner=f.actors.master;await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Synthetic immutable learning review']);
  const entries=[];
  // Ordinary business APIs create a small JSON-escaped byte-boundary fixture,not a
  // stress campaign or injected oversized/corrupt archive rows.
  for(let i=0;i<35;i++){
   const person=await f.request('people',{name:'Synthetic history learner '+i,hubId:f.hub});assert.equal(person.response.status,201);
   assert.equal((await f.request('students',{personId:person.body.data.id,legalName:'Synthetic history learner '+i,dateOfBirth:'1990-01-01',recruiter:{kind:'academy'}})).response.status,201);
   const enrollment=await f.request('classes/'+f.c.id+'/enrollments',{studentId:person.body.data.id,studentProfileVersion:1,joinsOn:'2026-01-02',reason:'Synthetic history roster'});assert.equal(enrollment.response.status,201);
   entries.push({enrollmentId:enrollment.body.data.id,enrollmentVersion:1,status:'late',note:'\u0001'.repeat(1000)});
  }
  for(const capability of ['attendance.view','attendance.record','rosters.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.staffRole,capability]);
  for(let expectedVersion=0;expectedVersion<5;expectedVersion++){
   const saved=await f.request('sessions/'+f.c.session.id+'/attendance',{expectedVersion,sessionVersion:1,assignmentId:f.assignment.id,assignmentVersion:1,entries:entries.map(e=>({...e,status:expectedVersion%2?'present':'late'})),reason:'PRIVATE edition '+expectedVersion},'staff');assert.equal(saved.response.status,expectedVersion?200:201,JSON.stringify(saved.body));
  }
  const snapshot=async()=>{const rows=[];for(const table of ['session_reports','session_report_revisions','session_attendance','session_attendance_revisions','role_assignments','finance_journals'])rows.push((await f.pg.query('SELECT to_jsonb(t) row FROM public.'+table+' t ORDER BY to_jsonb(t)::text')).rows);return rows;},before=await snapshot();
  const authoritySql="SELECT oid,proowner,proacl FROM pg_proc WHERE oid IN('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure,'platform_private.read_learning_session(uuid,uuid,jsonb)'::regprocedure) ORDER BY oid",authority=(await f.pg.query(authoritySql)).rows;
  const retained=async(table:string)=>(await f.pg.query<{version:number;definition:unknown}>('SELECT version,definition FROM public.'+table+' WHERE academy_id=$1 AND session_id=$2 ORDER BY version',[f.a,f.c.session.id])).rows;
  const originalReports=await retained('session_report_revisions'),originalAttendance=await retained('session_attendance_revisions');
  await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.pg.query(authoritySql)).rows,authority);
  const database:Database={async connect(){if(f.pg.runtime){const c=await f.pg.runtime.connect();await c.query('SET ROLE kavosh_platform_service');return c;}await f.pg.exec('SET ROLE kavosh_platform_service');return{query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}};}};
  const api=createPlatformApi(database,async r=>{const a=f.actors[r.headers.get('x-test-actor')??''];return a?{userId:a.user,sessionId:a.session}:null;},true);
  const read=async(query='?record=report',options:{academy?:string;actor?:string;purpose?:boolean;method?:string;bearer?:boolean}={})=>{const path='academies/'+(options.academy??f.a)+'/learning/sessions/'+f.c.session.id+'/history',headers:Record<string,string>={'x-test-actor':options.actor??'master'};if(options.purpose!==false)headers['x-access-purpose']='PRIVATE_HISTORY_REVIEW';if(options.bearer)headers.authorization='Bearer synthetic';try{const response=await api(new Request('https://example.test/api/platform/v1/'+path+query,{headers,method:options.method??'GET'}),path),text=await response.text();return{response,body:JSON.parse(text),bytes:Buffer.byteLength(text)};}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}};
  const first=await read('?record=report&limit=1');assert.equal(first.response.status,200,JSON.stringify(first.body));assert.deepEqual(first.body.data.map(({version,definition}:any)=>({version,definition})),originalReports.slice(0,1));assert.equal(first.body.nextVersion,1);assert.equal(first.response.headers.get('cache-control'),'no-store');
  const last=await read('?record=report&limit=1&afterVersion=1');assert.deepEqual(last.body.data.map(({version,definition}:any)=>({version,definition})),originalReports.slice(1));assert.equal(last.body.nextVersion,null);assert.equal((await read('?record=report&afterVersion=2147483647')).body.data.length,0);
  const all=[],pageSizes:number[]=[],pageBytes:number[]=[];let afterVersion=0,pages=0;do{
   const page=await read('?record=attendance&limit=5&afterVersion='+afterVersion);assert.equal(page.response.status,200,JSON.stringify(page.body));assert.ok(page.bytes<=1048576);assert.ok(page.body.data.length>0);if(pages===0){assert.ok(page.body.data.length<5);assert.notEqual(page.body.nextVersion,null);}
   all.push(...page.body.data.map(({version,definition}:any)=>({version,definition})));pageSizes.push(page.body.data.length);pageBytes.push(page.bytes);afterVersion=page.body.nextVersion;pages++;
  }while(afterVersion!==null);assert.ok(pages>1);assert.deepEqual(all,originalAttendance);assert.equal(new Set(all.map(r=>r.version)).size,5);console.log(JSON.stringify({case:'owner-learning-history-byte-boundary',retainedAttendanceEditions:all.length,pageSizes,pageBytes,sourceRowsRewritten:0}));
  for(const query of ['', '?record=unknown','?record=report&record=attendance','?record=report&limit=6','?record=report&afterVersion=-1','?record=report&afterVersion=2147483648','?record=report&approved=true'])assert.equal((await read(query)).response.status,400);
  for(const actor of ['manager','staff','foreignMaster'])assert.equal((await read('?record=report',{actor})).response.status,403);assert.equal((await read('?record=report',{academy:f.b})).response.status,404);assert.equal((await read('?record=report',{purpose:false})).response.status,400);assert.equal((await read('?record=report',{method:'POST'})).response.status,405);assert.equal((await read('?record=report',{bearer:true})).response.status,401);
  const input={academyId:f.a,sessionId:f.c.session.id,purpose:'Synthetic history direct',record:'report'};for(const patch of [{record:null},{record:'other'},{limit:0},{limit:6},{afterVersion:-1},{afterVersion:2147483648},{callerApproval:true}])await assert.rejects(f.pg.query('SELECT platform_private.request($1,$2,$3,NULL,$4::jsonb)',[owner.user,owner.session,'academies.learning-session-history',JSON.stringify({...input,...patch})]),/INVALID_PLATFORM_INPUT/);
  await assert.rejects(f.pg.query('SELECT platform_private.request($1,$2,$3,NULL,$4::jsonb)',[owner.user,owner.session,'academies.learning-session',JSON.stringify(input)]),/INVALID_PLATFORM_INPUT/);
  const {record,...current}=input;await assert.rejects(f.pg.query('SELECT platform_private.request($1,$2,$3,NULL,$4::jsonb)',[owner.user,owner.session,'academies.learning-session-history',JSON.stringify(current)]),/INVALID_PLATFORM_INPUT/);
  const audit=(await f.pg.query<{reason:string;after_data:unknown}>("SELECT reason,after_data FROM platform_private.audit_events WHERE action='platform.academy.learning-history.read'")).rows;assert.ok(audit.length>=5);assert.ok(audit.every(a=>a.reason==='PRIVATE_HISTORY_REVIEW'));assert.doesNotMatch(JSON.stringify(audit.map(a=>a.after_data)),/PRIVATE|界|definition|document|entries|expectedSha256/);
  await f.pg.query('UPDATE identity.session SET "mfaVerified"=false WHERE id=$1',[owner.session]);assert.equal((await read()).response.status,403);await f.pg.query('UPDATE identity.session SET "mfaVerified"=true WHERE id=$1',[owner.session]);assert.deepEqual(await snapshot(),before);
  await f.pg.exec('REVOKE SELECT(definition) ON public.session_report_revisions FROM kavosh_platform_policy');const denied=await read();assert.equal(denied.response.status,503);assert.deepEqual(denied.body,{error:{code:'PLATFORM_UNAVAILABLE'}});
  await f.pg.exec('SET ROLE kavosh_platform_service');await assertPlatformRole({query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}});for(const table of ['session_report_revisions','session_attendance_revisions'])await assert.rejects(f.pg.query('SELECT session_id FROM public.'+table),/permission denied/);
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

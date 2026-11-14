import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { reportFixture } from './report-fixture.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';

async function fixture(throughSchema?:number){
 const f=await reportFixture(throughSchema),student=f.actors.peer.person,guardian=f.actors.staff.person;
 assert.equal((await f.save()).response.status,201);
 assert.equal((await f.request('students',{personId:student,legalName:'PRIVATE linked student',dateOfBirth:'2014-03-20',recruiter:{kind:'academy'}})).response.status,201);
 assert.equal((await f.request('guardians',{personId:guardian,legalName:'PRIVATE linked guardian'})).response.status,201);
 const relationship=await f.request('students/'+student+'/guardians',{guardianId:guardian,relationship:'parent',reason:'PRIVATE approved family link'});assert.equal(relationship.response.status,201);
 const enrollment=await f.request('classes/'+f.c.id+'/enrollments',{studentId:student,studentProfileVersion:1,joinsOn:'2026-01-02',reason:'PRIVATE actual dated membership'});assert.equal(enrollment.response.status,201);
 for(const cap of ['report-publications.view','report-publications.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,cap]);
 const role=await f.request('roles',{name:'Parent own child reports only',permissions:[{capability:'received-reports.view',effect:'allow'}]});assert.equal(role.response.status,201);
 const target='people/'+guardian+'/access',v=(await f.request(target)).body.data.version;assert.equal((await f.request(target,{expectedVersion:v,assignments:[{roleId:role.body.data.id,allHubs:false,personIds:[student]}]})).response.status,200);
 const path='sessions/'+f.c.session.id+'/report/publications',input={reportVersion:1,priorId:null,allowMissingMedia:false,classAudienceReviewed:true,reason:'PRIVATE reviewed class-audience publication'};
 const publish=(value:unknown=input,as='master',key?:string)=>f.request(path,value,as,key?{key}:{});
 const withdraw=(id:string,as='master',key?:string)=>f.request('report-publications/'+id+'/withdraw',{reason:'PRIVATE protective withdrawal'},as,key?{key}:{});
 const received=(id?:string,as='staff',query='')=>f.request('students/'+student+'/published-reports'+(id?'/'+id:'')+query,undefined,as);
 return {...f,student,guardian,relationship:relationship.body.data,enrollment:enrollment.body.data,parentRole:role.body.data.id,pubPath:path,pubInput:input,publish,withdraw,received};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>,nativeOnly=false){test(name,{skip:nativeOnly&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
test('actual355to356 preserves published learning records and role assignments while declaring supported family class scopes',async()=>{
 const f=await fixture(355);try{const made=await f.publish();assert.equal(made.response.status,201,JSON.stringify(made.body));const snapshot=async()=>({publications:(await f.pg.query('SELECT * FROM public.report_publications ORDER BY id')).rows,permissions:(await f.pg.query('SELECT * FROM public.role_permissions ORDER BY role_id,capability')).rows,assignments:(await f.pg.query('SELECT * FROM public.role_assignments ORDER BY id')).rows,people:(await f.pg.query('SELECT * FROM public.assignment_people ORDER BY assignment_id,person_id')).rows,classes:(await f.pg.query('SELECT * FROM public.assignment_classes ORDER BY assignment_id,class_id')).rows}),before=await snapshot(),functions=await f.pg.query("SELECT oid,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid=ANY(ARRAY['public.scope_contains(jsonb,jsonb)'::regprocedure,'public.report_recipient(uuid,uuid)'::regprocedure]) ORDER BY oid");await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);assert.deepEqual(await f.pg.query("SELECT oid,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid=ANY(ARRAY['public.scope_contains(jsonb,jsonb)'::regprocedure,'public.report_recipient(uuid,uuid)'::regprocedure]) ORDER BY oid"),functions);const rows=(await f.pg.query<{name:string;scope_kinds:string[]}>("SELECT name,scope_kinds FROM public.capability_catalog WHERE name=ANY($1::text[]) ORDER BY name",[['received-reports.view','received-homework.view','received-submissions.view','received-submissions.drafts','received-grades.view','received-solutions.view','received-comments.view','received-comments.write','received-polls.view','received-polls.respond','homework-submissions.submit']])).rows;assert.equal(rows.length,11);assert.ok(rows.every(r=>r.scope_kinds.includes('class')&&new Set(r.scope_kinds).size===r.scope_kinds.length));assert.equal((await f.received(made.body.data.id)).response.status,200);}finally{await f.pg.close();}
});
check('family learning uses exact class grants and explicit class denials instead of the student primary hub',async f=>{
 const duplicate=await f.received(undefined,'staff','?limit=1&limit=2');assert.equal(duplicate.response.status,400);assert.equal(duplicate.body.error.code,'DUPLICATE_QUERY');
 const made=await f.publish();assert.equal(made.response.status,201,JSON.stringify(made.body));const id=made.body.data.id,access='people/'+f.guardian+'/access',assign=async(assignments:unknown[])=>{const version=(await f.request(access)).body.data.version;const r=await f.request(access,{expectedVersion:version,assignments});assert.equal(r.response.status,200,JSON.stringify(r.body));};
 const deny=await f.request('roles',{name:'Hide one family report class',permissions:[{capability:'received-reports.view',effect:'deny'}]});assert.equal(deny.response.status,201);await assign([{roleId:f.parentRole,allHubs:false,personIds:[f.student]},{roleId:deny.body.data.id,allHubs:false,classIds:[f.c.id]}]);const hidden=await f.received(id);assert.equal(hidden.response.status,404,JSON.stringify(hidden.body));assert.deepEqual((await f.received()).body.data,[]);
 await f.pg.query('UPDATE public.people SET hub_id=$2 WHERE id=$1',[f.student,f.otherHub]);await assign([{roleId:f.parentRole,allHubs:false,classIds:[f.c.id]}]);const allowed=await f.received(id);assert.equal(allowed.response.status,200,JSON.stringify(allowed.body));assert.equal(allowed.body.data.document.blocks[0].text,f.document.blocks[0].text);assert.equal((await f.received()).body.data.length,1);assert.equal((await f.request('students/'+f.student,undefined,'staff')).response.status,403);
});
check('upper-reviewed publication delivers frozen text/captions only to a linked scoped parent, not draft or file authority',async f=>{
 assert.deepEqual((await f.received()).body.data,[]);const pending=await f.publish(f.pubInput,'manager');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);
 const start=performance.now(),made=await f.approve(pending.body.approval.id);assert.equal(made.response.status,200,JSON.stringify(made.body));console.log(JSON.stringify({case:'reviewed-parent-publication',elapsedMs:Math.round(performance.now()-start)}));
 const id=made.body.data.id,list=await f.received();assert.equal(list.response.status,200,JSON.stringify(list.body));assert.equal(list.body.data.length,1);assert.equal(list.body.data[0].on,'2026-01-02');assert.equal(list.body.data[0].document,undefined);
 const read=await f.received(id);assert.equal(read.response.status,200);assert.equal(read.body.data.document.blocks[0].text,f.document.blocks[0].text);assert.equal(read.body.data.document.blocks[1].availability,'unavailable');
 assert.equal(read.body.data.mediaServingEnabled,false);assert.equal(read.body.data.externalDeliveryVerified,false);assert.equal(read.body.data.payrollApproved,false);
 const text=JSON.stringify(read.body);for(const privateField of ['fileId','fileVersion','expectedSha256','context','changed_by','PRIVATE reviewed class-audience publication',f.file.id])assert.ok(!text.includes(privateField),privateField);
 assert.ok([403,404].includes((await f.request(f.path,undefined,'staff')).response.status));assert.ok([403,404].includes((await f.request('files/'+f.file.id,undefined,'staff')).response.status));
 for(const candidate of [id,randomUUID()])assert.equal((await f.request('report-publications/'+candidate,undefined,'staff')).response.status,404,'recipient access must not reveal private publication-context existence');
});
check('draft changes do not silently alter published content; explicit replacement supersedes the old immutable publication',async f=>{
 const made=await f.publish();assert.equal(made.response.status,201);const id=made.body.data.id;
 const d={...f.document,title:'PRIVATE New class story',blocks:[{...f.document.blocks[0],text:'New explicitly reviewed story'},f.document.blocks[1]]};assert.equal((await f.correction({...f.change,expectedVersion:1,document:d},'master')).response.status,200);
 assert.equal((await f.received(id)).body.data.document.title,f.document.title);
 const next=await f.publish({...f.pubInput,reportVersion:2,priorId:id});assert.equal(next.response.status,201,JSON.stringify(next.body));assert.equal((await f.received(id)).response.status,404);assert.equal((await f.received(next.body.data.id)).body.data.document.title,d.title);
 assert.equal((await f.request('report-publications/'+id)).body.data.active,false);assert.equal((await f.pg.query('SELECT * FROM public.report_publications')).rows.length,2);
});
check('withdrawal preserves evidence, blocks subsequent parent access and allows explicit reviewed republication with safe retries',async f=>{
 const key=randomUUID(),made=await f.publish(f.pubInput,'master',key);assert.equal(made.response.status,201);assert.deepEqual((await f.publish(f.pubInput,'master',key)).body,made.body);assert.equal((await f.publish()).response.status,409);
 const id=made.body.data.id,stopKey=randomUUID(),stopped=await f.withdraw(id,'master',stopKey);assert.equal(stopped.response.status,201,JSON.stringify(stopped.body));assert.deepEqual((await f.withdraw(id,'master',stopKey)).body,stopped.body);
 assert.equal((await f.received(id)).response.status,404);assert.deepEqual((await f.received()).body.data,[]);assert.equal((await f.request('report-publications/'+id)).body.data.active,false);
 const restored=await f.publish({...f.pubInput,priorId:id});assert.equal(restored.response.status,201);assert.equal((await f.received(restored.body.data.id)).response.status,200);assert.equal((await f.pg.query('SELECT * FROM public.report_publication_withdrawals')).rows.length,1);
});
check('current family validity, relationship type, student state and identity verification are required on every received read',async f=>{
 const made=await f.publish();assert.equal(made.response.status,201);const id=made.body.data.id;
 for(const sql of ["UPDATE public.family_relationships SET state='suspended' WHERE id=$1","UPDATE public.family_relationships SET relationship='authorized_contact' WHERE id=$1","UPDATE public.family_relationships SET valid_from=now()+interval '1 day' WHERE id=$1","UPDATE public.family_relationships SET valid_until=now()-interval '1 second',valid_from=now()-interval '2 days' WHERE id=$1"]){
  await f.pg.query(sql,[f.relationship.id]);assert.equal((await f.received(id)).response.status,404);
  await f.pg.query("UPDATE public.family_relationships SET state='approved',relationship='parent',valid_from=now()-interval '1 minute',valid_until=NULL WHERE id=$1",[f.relationship.id]);
 }
 await f.pg.query("UPDATE public.people SET status='disabled' WHERE id=$1",[f.student]);assert.equal((await f.received()).response.status,404);await f.pg.query("UPDATE public.people SET status='active' WHERE id=$1",[f.student]);
 await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id=$1',[f.actors.staff.user]);assert.equal((await f.received(id)).response.status,401);await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=true WHERE id=$1',[f.actors.staff.user]);assert.equal((await f.received(id)).response.status,401,'verification completion requires a new session');
 assert.equal((await f.pg.query('SELECT * FROM identity.session WHERE id=$1',[f.actors.staff.session])).rows.length,0);
 // Fixture-owner models a fresh login; no production session bypass is added.
 await f.pg.query('INSERT INTO identity.session(id,token,"userId","expiresAt","updatedAt","mfaVerified") VALUES($1,$2,$3,now()+interval \'1 day\',now(),true)',[f.actors.staff.session,'synthetic-new-session-'+randomUUID(),f.actors.staff.user]);assert.equal((await f.received(id)).response.status,200);
});
check('broad recipient permission is not a family link, bots cannot impersonate humans and unrelated students or schools stay hidden',async f=>{
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'received-reports.view','allow')",[f.a,f.managerRole]);const made=await f.publish();assert.equal(made.response.status,201);
 assert.equal((await f.received(made.body.data.id,'manager')).response.status,404);assert.equal((await f.received(made.body.data.id,'bot')).response.status,403);
 assert.equal((await f.request('students/'+randomUUID()+'/published-reports',undefined,'staff')).response.status,404);
 assert.equal((await f.request('students/'+f.student+'/published-reports/'+made.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='received-reports.view'",[f.parentRole]);assert.equal((await f.received(made.body.data.id)).response.status,403);
});
check('membership uses frozen local session day, not UTC; corrected join/leave or disabled membership excludes reports before pagination',async f=>{
 const made=await f.publish();assert.equal(made.response.status,201);assert.equal((await f.received()).body.data.length,1);
 const change=await f.request('enrollments/'+f.enrollment.id+'/change',{expectedVersion:1,joinsOn:'2026-01-03',reason:'PRIVATE corrected local joining date'});assert.equal(change.response.status,200);
 assert.deepEqual((await f.received()).body.data,[]);assert.equal((await f.received(made.body.data.id)).response.status,404);
 assert.equal((await f.request('enrollments/'+f.enrollment.id+'/change',{expectedVersion:2,joinsOn:'2026-01-02',reason:'PRIVATE corrected membership'})).response.status,200);assert.equal((await f.received(made.body.data.id)).response.status,200);
 assert.equal((await f.request('enrollments/'+f.enrollment.id+'/change',{expectedVersion:3,enabled:false,reason:'Disabled membership'})).response.status,200);assert.deepEqual((await f.received()).body.data,[]);
 assert.equal((await f.request('enrollments/'+f.enrollment.id+'/change',{expectedVersion:4,enabled:true,reason:'Restored actual membership'})).response.status,200);assert.equal((await f.received(made.body.data.id)).response.status,200);
 assert.equal((await f.request('enrollments/'+f.enrollment.id+'/change',{expectedVersion:5,joinsOn:'2026-01-01',leavesOn:'2026-01-01',reason:'Left before session local day'})).response.status,200);assert.equal((await f.received(made.body.data.id)).response.status,404);
 assert.equal((await f.request('enrollments/'+f.enrollment.id+'/change',{expectedVersion:6,leavesOn:'2026-01-02',reason:'Inclusive final attendance day'})).response.status,200);assert.equal((await f.received(made.body.data.id)).response.status,200);
});
check('publishing without a media reference needs an explicit scoped override; media-only drafts cannot publish as a text report',async f=>{
 const d={...f.document,blocks:[f.document.blocks[0]]};assert.equal((await f.correction({...f.change,expectedVersion:1,document:d},'master')).response.status,200);
 assert.equal((await f.publish({...f.pubInput,reportVersion:2})).response.status,409);assert.ok([403,404].includes((await f.publish({...f.pubInput,reportVersion:2,allowMissingMedia:true},'manager')).response.status));
 const explicit=await f.publish({...f.pubInput,reportVersion:2,allowMissingMedia:true});assert.equal(explicit.response.status,201);assert.equal((await f.request('report-publications/'+explicit.body.data.id)).body.data.allow_missing_media,true);
 const onlyMedia={...f.document,blocks:[f.document.blocks[1]]};assert.equal((await f.correction({...f.change,expectedVersion:2,document:onlyMedia},'master')).response.status,200);assert.equal((await f.publish({...f.pubInput,reportVersion:3,priorId:explicit.body.data.id})).response.status,409);
});
check('changed reports and file sources invalidate pending publication, while lost private source rights hide review cases',async f=>{
 const pending=await f.publish(f.pubInput,'manager');assert.equal(pending.response.status,202);assert.equal((await f.correction({...f.change,expectedVersion:1,document:{...f.document,title:'Updated draft'}},'master')).response.status,200);
 const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.status,'stale');assert.equal((await f.pg.query('SELECT * FROM public.report_publications')).rows.length,0);
 const next=await f.publish({...f.pubInput,reportVersion:2},'manager');assert.equal(next.response.status,202);
 for(const cap of ['files.view','session-reports.view']){await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1 AND capability=$2',[f.managerRole,cap]);assert.equal((await f.request('approvals/'+next.body.approval.id,undefined,'manager')).response.status,404);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,cap]);}
 await f.request('files/'+f.file.id+'/change',{expectedVersion:1,archived:true});assert.equal((await f.approve(next.body.approval.id)).body.approval.status,'stale');
});
check('publication and withdrawal failures roll back their approvals, audit, outbox, notices and records before exact-key retry',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.report_publications) publications,(SELECT count(*)::int FROM public.report_publication_withdrawals) withdrawals,(SELECT count(*)::int FROM public.approval_requests) approvals,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events,(SELECT count(*)::int FROM public.portal_notifications) notices')).rows[0],before=await counts(),key=randomUUID();
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.publish(f.pubInput,'master',key)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}assert.deepEqual(await counts(),before);
 const made=await f.publish(f.pubInput,'master',key);assert.equal(made.response.status,201);const nextBefore=await counts(),stop=randomUUID();
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.withdraw(made.body.data.id,'master',stop)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}assert.deepEqual(await counts(),nextBefore);assert.equal((await f.withdraw(made.body.data.id,'master',stop)).response.status,201);
});
check('strict requests cannot choose another guardian, forge delivery/clearance or bypass the explicit class-audience review',async f=>{
 for(const patch of [{classAudienceReviewed:false},{classAudienceReviewed:undefined},{guardianId:f.guardian},{published:true},{payrollApproved:true},{mediaServingEnabled:true},{reportVersion:0},{reason:'\0'}])assert.equal((await f.publish({...f.pubInput,...patch})).response.status,400);
 assert.equal((await f.received(undefined,'staff','?guardianId='+f.guardian)).response.status,400);assert.equal((await f.received(undefined,'staff','?after='+randomUUID())).response.status,400);
 assert.equal((await f.request('students/'+f.student+'/published-reports',{},'staff')).response.status,405);
});
check('students can read their own published report only when that optional permission is explicitly assigned',async f=>{
 const made=await f.publish();assert.equal(made.response.status,201);assert.equal((await f.received(made.body.data.id,'peer')).response.status,403);
 const target='people/'+f.student+'/access',v=(await f.request(target)).body.data.version;assert.equal((await f.request(target,{expectedVersion:v,assignments:[{roleId:f.parentRole,allHubs:false,personIds:[f.student]}]})).response.status,200);
 const read=await f.received(made.body.data.id,'peer');assert.equal(read.response.status,200);assert.equal(read.body.data.document.blocks[1].fileId,undefined);
});
check('an original report author cannot review a subordinate publication request even after receiving administrative authority',async f=>{
 for(const cap of ['report-publications.view','report-publications.edit','approvals.view','approvals.review'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);
 const target='people/'+f.guardian+'/access',v=(await f.request(target)).body.data.version;assert.equal((await f.request(target,{expectedVersion:v,assignments:[{roleId:f.staffRole,allHubs:false,hubIds:[f.hub]},{roleId:f.parentRole,allHubs:false,personIds:[f.student]}]})).response.status,200);
 await f.pg.query('UPDATE public.people SET supervisor_person_id=NULL WHERE id=$1',[f.guardian]);await f.pg.query('UPDATE public.people SET supervisor_person_id=$1 WHERE id=$2',[f.guardian,f.actors.manager.person]);
 const p=await f.publish(f.pubInput,'manager');assert.equal(p.response.status,202);const denied=await f.approve(p.body.approval.id,'staff');assert.equal(denied.response.status,403);assert.equal(denied.body.error.code,'BENEFICIARY_REVIEW_FORBIDDEN');assert.equal((await f.approve(p.body.approval.id)).response.status,200);
});
check('received chronology pages have no gaps and explicit source-hub denial overrides a selected-student grant',async f=>{
 const first=await f.publish();assert.equal(first.response.status,201);const ids=[first.body.data.id];
 for(let n=0;n<2;n++){
  const c=await f.makeClass();assert.equal((await f.request('classes/'+c.id+'/enrollments',{studentId:f.student,studentProfileVersion:1,joinsOn:'2026-01-02',reason:'Synthetic other eligible class'})).response.status,201);
  const report=await f.request('sessions/'+c.session.id+'/report/change',{expectedVersion:0,sessionVersion:1,document:{...f.document,blocks:[f.document.blocks[0]]},reason:'Synthetic explicit class story'});assert.equal(report.response.status,200);
  const published=await f.request('sessions/'+c.session.id+'/report/publications',{...f.pubInput,allowMissingMedia:true});assert.equal(published.response.status,201);ids.push(published.body.data.id);
 }
 const found:string[]=[];let query='?limit=1';for(let page=0;page<4;page++){const r=await f.received(undefined,'staff',query);assert.equal(r.response.status,200);found.push(...r.body.data.map((p:{id:string})=>p.id));const next=r.body.nextCursor;if(!next)break;query='?limit=1&beforeOn='+next.beforeOn+'&after='+next.after;}
 assert.deepEqual(found,[...ids].sort().reverse());assert.equal(new Set(found).size,3);
 const role=await f.request('roles',{name:'Do not share this source hub',permissions:[{capability:'received-reports.view',effect:'deny'}]});assert.equal(role.response.status,201);const target='people/'+f.guardian+'/access',v=(await f.request(target)).body.data.version;
 assert.equal((await f.request(target,{expectedVersion:v,assignments:[{roleId:f.parentRole,allHubs:false,personIds:[f.student]},{roleId:role.body.data.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);assert.deepEqual((await f.received()).body.data,[]);
});
check('native publication and withdrawal require applied human approval at commit and preserve append-only tenant history',async f=>{
 const pending=await f.publish(f.pubInput,'manager');assert.equal(pending.response.status,202);
 const p=(await f.pg.query<{id:string;target_id:string;review_context:unknown}>('SELECT id,target_id,review_context FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows[0];
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query('INSERT INTO public.report_publications(academy_id,id,session_id,class_id,hub_id,report_version,allow_missing_media,audience_reviewed,context,created_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,1,false,true,$6::jsonb,$7,$8,$9)',[f.a,p.target_id,f.c.session.id,f.c.id,f.hub,JSON.stringify(p.review_context),f.actors.master.person,p.id,f.pubInput.reason]),/REVIEWED_APPROVAL_NOT_APPLIED/);
 }finally{await f.pg.exec('RESET ROLE');}
 const made=await f.approve(p.id);assert.equal(made.response.status,200);const stop=await f.withdraw(made.body.data.id,'manager');assert.equal(stop.response.status,202);
 const w=(await f.pg.query<{id:string;target_id:string}>('SELECT id,target_id FROM public.approval_requests WHERE id=$1',[stop.body.approval.id])).rows[0];
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query('INSERT INTO public.report_publication_withdrawals(academy_id,id,publication_id,created_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6)',[f.a,w.target_id,made.body.data.id,f.actors.master.person,w.id,'PRIVATE protective withdrawal']),/REVIEWED_APPROVAL_NOT_APPLIED/);
  for(const t of ['report_publications','report_publication_withdrawals']){await assert.rejects(f.pg.exec('DELETE FROM public.'+t),/permission denied/i);await assert.rejects(f.pg.exec('UPDATE public.'+t+' SET created_at=now()'),/permission denied/i);}
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.report_publications')).rows.length,0);
 }finally{await f.pg.exec('RESET ROLE');}
 assert.equal((await f.approve(w.id)).response.status,200);assert.equal((await f.received(made.body.data.id)).response.status,404);
},true);
check('an actual source-file change during publication INSERT rolls back all effects and permits exact-key retry',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.report_publications) publications,(SELECT count(*)::int FROM public.approval_requests) approvals,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events,(SELECT count(*)::int FROM public.portal_notifications) notices')).rows[0],before=await counts(),key=randomUUID();
 await f.pg.exec(`CREATE FUNCTION public.synthetic_publication_file_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN UPDATE public.file_records SET archived=true WHERE id='${f.file.id}';RETURN NEW;END $$;CREATE TRIGGER aa_synthetic_publication_file_change BEFORE INSERT ON public.report_publications FOR EACH ROW EXECUTE FUNCTION public.synthetic_publication_file_change()`);
 try{const blocked=await f.publish(f.pubInput,'master',key);assert.equal(blocked.response.status,409,JSON.stringify(blocked.body));assert.equal(blocked.body.error.code,'REPORT_PUBLICATION_SOURCE_CHANGED');}finally{await f.pg.exec('DROP TRIGGER aa_synthetic_publication_file_change ON public.report_publications;DROP FUNCTION public.synthetic_publication_file_change()');}
 assert.deepEqual(await counts(),before);assert.equal((await f.pg.query('SELECT archived FROM public.file_records WHERE id=$1',[f.file.id])).rows[0].archived,false);assert.equal((await f.publish(f.pubInput,'master',key)).response.status,201);
},true);
check('tiny duplicate and competing-successor publication races keep one receipt and one active head',async f=>{
 const start=performance.now(),key=randomUUID(),same=await Promise.all([f.publish(f.pubInput,'master',key),f.publish(f.pubInput,'master',key)]);for(const r of same)assert.equal(r.response.status,201);assert.deepEqual(same[0].body,same[1].body);
 const i={...f.pubInput,priorId:same[0].body.data.id},race=await Promise.all([f.publish(i),f.publish({...i,reason:'Another explicitly competing successor'})]);assert.deepEqual(race.map(r=>r.response.status).sort(),[201,409]);assert.equal((await f.received()).body.data.length,1);assert.equal((await f.pg.query('SELECT * FROM public.report_publications')).rows.length,2);console.log(JSON.stringify({case:'tiny-publication-races',elapsedMs:Math.round(performance.now()-start),activeHeads:1,duplicateKeyReceipts:1}));
},true);
test('schema74 preserves a real schema73 report draft and never automatically publishes existing reports',async()=>{
 const f=await reportFixture(73);try{
  assert.equal((await f.save()).response.status,201);const before=(await f.pg.query('SELECT to_jsonb(r) definition FROM public.session_reports r')).rows[0].definition;
  await f.pg.exec(await readFile(new URL('../db/migrations/074_report_publications.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.pg.query('SELECT to_jsonb(r) definition FROM public.session_reports r')).rows[0].definition,before);assert.equal((await f.pg.query('SELECT * FROM public.report_publications')).rows.length,0);
  const explicit=await f.request('sessions/'+f.c.session.id+'/report/publications',{reportVersion:1,classAudienceReviewed:true,reason:'Explicit review after upgrade'});assert.equal(explicit.response.status,201,JSON.stringify(explicit.body));assert.equal(explicit.body.data.mediaServingEnabled,false);
 }finally{await f.pg.close();}
});

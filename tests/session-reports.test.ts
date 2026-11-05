import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { operationsFixture } from './operations-fixture.ts';

async function fixture(throughSchema?:number){
 const f=await operationsFixture({throughSchema}),country=randomUUID(),region=randomUUID(),city=randomUUID();
 await f.pg.query("INSERT INTO public.countries(academy_id,id,code,name) VALUES($1,$2,'CA','Canada')",[f.a,country]);
 await f.pg.query("INSERT INTO public.regions(academy_id,id,country_id,code,name) VALUES($1,$2,$3,'ON','Ontario')",[f.a,region,country]);
 await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Toronto')",[f.a,city,region]);
 await f.pg.query("UPDATE public.hubs SET city_id=$1,time_zone='America/Toronto',currency='CAD' WHERE academy_id=$2",[city,f.a]);
 const course=await f.request('courses',{code:'REPORT',name:'Session report tests'});assert.equal(course.response.status,201);
 const makeClass=async(hubId=f.hub)=>{const c=await f.request('classes',{hubId,courseId:course.body.data.id,courseVersion:1,name:'Shared session report',mode:'in_person',schedule:{oneOff:[{start:'2026-01-02T23:30',end:'2026-01-03T00:30'}]}});assert.equal(c.response.status,201);return {...c.body.data,session:(await f.request('classes/'+c.body.data.id+'/sessions')).body.data[0]};};
 const c=await makeClass(),assignment=await f.request('classes/'+c.id+'/staff',{personId:f.actors.staff.person,role:'teacher',startsOn:'2026-01-02',endsOn:'2026-01-02',reason:'Synthetic accepted staff assignment'});assert.equal(assignment.response.status,201);
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['session-reports.view','session-reports.record','session-reports.edit','files.view','files.edit'].filter(c=>throughSchema===undefined||throughSchema>=73||!c.startsWith('session-reports.')))await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const fileInput={anchor:{kind:'class',id:c.id},domain:'general',name:'PRIVATE robotics image.jpg',claimedMimeType:'image/jpeg',expectedBytes:1234,expectedSha256:'a'.repeat(64)};
 const file=await f.request('files',fileInput);assert.equal(file.response.status,201,JSON.stringify(file.body));
 const document={title:'PRIVATE Robots and teamwork',locale:'en',blocks:[{id:randomUUID(),kind:'text',text:'PRIVATE Students built robots. <script>literal report text</script>'},{id:randomUUID(),kind:'media',fileId:file.body.data.id,fileVersion:1,mediaKind:'image',caption:'PRIVATE Class teamwork'}]};
 const input={expectedVersion:0,sessionVersion:1,assignmentId:assignment.body.data.id,assignmentVersion:1,document,reason:'PRIVATE shared draft'},path='sessions/'+c.session.id+'/report';
 const save=(value:unknown=input,as='staff',key?:string)=>f.request(path,value,as,key?{key}:{});
 const {assignmentId,assignmentVersion,...change}=input;
 const correction=(value:unknown=change,as='manager',key?:string)=>f.request(path+'/change',value,as,key?{key}:{});
 return {...f,c,assignment:assignment.body.data,file:file.body.data,fileInput,input,document,path,save,change,correction,makeClass};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>,nativeOnly=false){test(name,{skip:nativeOnly&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('assigned teacher records one ordered shared text/media draft without inventing media validation, parent publication or payroll approval',async f=>{
 assert.equal((await f.request(f.path,undefined,'staff')).body.data,null);
 const key=randomUUID(),start=performance.now(),queries=f.metrics.businessQueries,made=await f.save(f.input,'staff',key);assert.equal(made.response.status,201,JSON.stringify(made.body));console.log(JSON.stringify({case:'shared-report-draft',elapsedMs:Math.round(performance.now()-start),clientQueries:f.metrics.businessQueries-queries}));
 const r=made.body.data;assert.deepEqual(r.document,f.document);assert.equal(r.state,'draft');assert.equal(r.hasReportText,true);assert.equal(r.mediaReferenceCount,1);
 for(const flag of ['mediaContentVerified','mediaServingEnabled','publishedToParents','sessionEvidenceApproved','payrollApproved'])assert.equal(r[flag],false);
 assert.equal(r.context.media[0].fileVersion,1);assert.equal(r.context.media[0].expectedSha256,f.fileInput.expectedSha256);assert.equal((await f.request(f.path,undefined,'staff')).body.recordedSourcesCurrent,true);
 assert.deepEqual((await f.save(f.input,'staff',key)).body,made.body);assert.equal((await f.save()).response.status,409);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
 assert.doesNotMatch(JSON.stringify((await f.pg.query("SELECT changes FROM public.audit_events WHERE action='session.report.recorded'")).rows),/PRIVATE|teamwork|script|expectedSha256/);
});
check('drafts may start with text or pending media alone and all shared staff edits retain exact prior revisions',async f=>{
 const textOnly={...f.document,blocks:[f.document.blocks[0]]};const first=await f.save({...f.input,document:textOnly});assert.equal(first.response.status,201);assert.equal(first.body.data.mediaReferenceCount,0);
 const a=await f.request('classes/'+f.c.id+'/staff',{personId:f.actors.manager.person,role:'ta',startsOn:'2026-01-02',endsOn:'2026-01-02',reason:'Shared report coauthor'});assert.equal(a.response.status,201);
 const mediaOnly={...f.document,locale:'zh-CN',blocks:[f.document.blocks[1]]};const next=await f.save({...f.input,expectedVersion:1,assignmentId:a.body.data.id,document:mediaOnly},'manager');assert.equal(next.response.status,200);assert.equal(next.body.data.hasReportText,false);
 const h=await f.request(f.path+'/history?limit=1',undefined,'staff');assert.equal(h.body.data[0].definition.document.blocks[0].text,f.document.blocks[0].text);assert.equal(h.body.nextVersion,1);assert.equal((await f.request(f.path+'/history?afterVersion=1',undefined,'staff')).body.data[0].definition.document.locale,'zh-CN');
 assert.equal((await f.pg.query('SELECT * FROM public.session_reports')).rows.length,1);
});
check('media must belong to this exact class/general domain and current revision, not a hub, another class, protected finance or PDF claim',async f=>{
 const other=await f.makeClass();
 for(const patch of [{anchor:{kind:'class',id:other.id}},{anchor:{kind:'hub',id:f.hub}},{domain:'finance_private'},{claimedMimeType:'application/pdf'}]){
  const file=await f.request('files',{...f.fileInput,...patch});assert.equal(file.response.status,201,JSON.stringify(file.body));const blocks=[f.document.blocks[0],{...f.document.blocks[1],fileId:file.body.data.id}];const denied=await f.save({...f.input,document:{...f.document,blocks}});assert.equal(denied.body.error.code,'SESSION_REPORT_SOURCE_UNAVAILABLE');
 }
 assert.equal((await f.save({...f.input,document:{...f.document,blocks:[{...f.document.blocks[1],fileVersion:2}]}})).response.status,409);
 assert.equal((await f.request('files/'+f.file.id+'/change',{expectedVersion:1,archived:true})).response.status,200);assert.equal((await f.save()).response.status,409);assert.equal((await f.pg.query('SELECT * FROM public.session_reports')).rows.length,0);
});
check('administrative initial reports and corrections require upper human review; bots propose and masters self-approve',async f=>{
 const pending=await f.correction();assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);assert.equal((await f.pg.query('SELECT * FROM public.session_reports')).rows.length,0);
 const applied=await f.approve(pending.body.approval.id);assert.equal(applied.response.status,200,JSON.stringify(applied.body));assert.equal(applied.body.data.publishedToParents,false);
 const proposal=await f.correction({...f.change,expectedVersion:1,document:{...f.document,title:'PRIVATE reviewed replacement'}},'bot');assert.equal(proposal.response.status,202);assert.equal((await f.approve(proposal.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(proposal.body.approval.id)).response.status,200);
 const alerts=await f.pg.query("SELECT n.id FROM public.portal_notifications n JOIN public.automation_event_sources s ON s.academy_id=n.academy_id AND s.event_id=n.event_id WHERE s.approval_id=$1 AND n.origin='mandatory'",[proposal.body.approval.id]);assert.ok(alerts.rows.length>0);
});
check('file and report permission revocation protects cached replay, private approval context and media history before pagination',async f=>{
 const key=randomUUID();assert.equal((await f.save(f.input,'staff',key)).response.status,201);
 const textOnly={...f.document,blocks:[f.document.blocks[0]]};assert.equal((await f.save({...f.input,expectedVersion:1,document:textOnly})).response.status,200);
 const pending=await f.correction({...f.change,expectedVersion:2});assert.equal(pending.response.status,202);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.view'",[f.staffRole]);
 assert.equal((await f.request(f.path,undefined,'staff')).response.status,200);const history=await f.request(f.path+'/history?limit=1',undefined,'staff');assert.equal(history.response.status,200);assert.deepEqual(history.body.data.map((r:{version:number})=>r.version),[2]);assert.equal(history.body.nextVersion,null);
 assert.ok([403,404].includes((await f.save(f.input,'staff',key)).response.status));
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.view'",[f.managerRole]);assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'manager')).response.status,404);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='session-reports.view'",[f.staffRole]);for(const path of [f.path,f.path+'/history'])assert.ok([403,404].includes((await f.request(path,undefined,'staff')).response.status));
 assert.equal((await f.request(f.path,undefined,'foreignMaster',{academy:f.b})).response.status,404);
});
check('removed-media bindings protect correction context even when the replacement draft contains no files',async f=>{
 assert.equal((await f.save()).response.status,201);const textOnly={...f.document,blocks:[f.document.blocks[0]]},p=await f.correction({...f.change,expectedVersion:1,document:textOnly});assert.equal(p.response.status,202);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.view'",[f.managerRole]);assert.equal((await f.request('approvals/'+p.body.approval.id,undefined,'manager')).response.status,404);
 assert.ok(!(await f.request('approvals',undefined,'manager')).body.data.some((r:{id:string})=>r.id===p.body.approval.id));
});
check('changed draft, file metadata and calendar facts invalidate reviews but cannot rewrite retained report content',async f=>{
 assert.equal((await f.save()).response.status,201);const p=await f.correction({...f.change,expectedVersion:1});assert.equal(p.response.status,202);
 assert.equal((await f.save({...f.input,expectedVersion:1,document:{...f.document,title:'PRIVATE teacher correction'}})).response.status,200);assert.equal((await f.approve(p.body.approval.id)).body.approval.status,'stale');
 const next=await f.correction({...f.change,expectedVersion:2});assert.equal(next.response.status,202);await f.request('files/'+f.file.id+'/change',{expectedVersion:1,name:'PRIVATE renamed image.jpg'});
 const stale=await f.approve(next.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.status,'stale');const old=await f.request(f.path,undefined,'staff');assert.equal(old.body.data.document.title,'PRIVATE teacher correction');assert.equal(old.body.recordedSourcesCurrent,false);
});
check('unassigned, inactive and bot actors cannot self-record; cancelled sessions retain history and require reviewed correction',async f=>{
 assert.equal((await f.save(f.input,'manager')).body.error.code,'STAFF_ASSIGNMENT_CHANGED');assert.equal((await f.save(f.input,'bot')).response.status,403);
 assert.equal((await f.save()).response.status,201);await f.request('sessions/'+f.c.session.id+'/change',{expectedVersion:1,reason:'Historical calendar correction',change:{kind:'cancel'}});
 const old=await f.request(f.path,undefined,'staff');assert.equal(old.body.data.version,1);assert.equal(old.body.recordedSourcesCurrent,false);assert.equal((await f.save({...f.input,expectedVersion:1,sessionVersion:2})).body.error.code,'INACTIVE_SESSION_REPORT_REQUIRES_REVIEW');
 const reviewed=await f.correction({...f.change,expectedVersion:1,sessionVersion:2},'master');assert.equal(reviewed.response.status,200,JSON.stringify(reviewed.body));assert.equal(reviewed.body.data.publishedToParents,false);
});
check('strict structured documents reject executable embeds, forged audience, clearance and status while preserving literal text safely as JSON',async f=>{
 for(const patch of [{published:true},{payrollApproved:true},{guardianId:f.actors.manager.person},{signed:true},{reason:'\0'},{document:{...f.document,url:'https://example.test'}},{document:{...f.document,blocks:[{id:randomUUID(),kind:'html',html:'<script>bad()</script>'}]}},{document:{...f.document,blocks:[f.document.blocks[0],f.document.blocks[0]]}},{document:{...f.document,blocks:[f.document.blocks[1],{...f.document.blocks[1],id:randomUUID()}]}},{document:{...f.document,blocks:[]}}])assert.equal((await f.save({...f.input,...patch})).response.status,400,JSON.stringify(patch));
 assert.equal((await f.request(f.path+'?published=true',f.input,'staff')).response.status,400);assert.equal((await f.request(f.path,undefined,'master',{method:'DELETE'})).response.status,405);
});
check('failed outbox persistence rolls back report, revision, audit and mutation receipt; exact-key retry then succeeds',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events,(SELECT count(*)::int FROM public.request_keys) keys')).rows[0],before=await counts(),key=randomUUID();
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.save(f.input,'staff',key)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.deepEqual(await counts(),before);assert.equal((await f.pg.query('SELECT * FROM public.session_reports')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.session_report_revisions')).rows.length,0);assert.equal((await f.save(f.input,'staff',key)).response.status,201);
});
check('native report history is append-only, tenant-isolated and mandatory at commit',async f=>{
 assert.equal((await f.save()).response.status,201);await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);for(const sql of ['DELETE FROM public.session_reports','DELETE FROM public.session_report_revisions',"UPDATE public.session_report_revisions SET definition='{}'",'UPDATE public.session_reports SET created_at=now()','UPDATE public.session_reports SET version=version+2'])await assert.rejects(f.pg.exec(sql));
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.session_reports')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.session_report_revisions')).rows.length,0);
 }finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('BEGIN');await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.query('UPDATE public.session_reports SET version=version+1 WHERE session_id=$1',[f.c.session.id]);await assert.rejects(f.pg.exec('COMMIT'),/REPORT_REVISION_MISSING/);await f.pg.exec('ROLLBACK');assert.equal((await f.request(f.path,undefined,'staff')).body.data.version,1);
});
check('an actual file archive after source reads is caught at INSERT with complete rollback and successful same-key retry',async f=>{
 const key=randomUUID(),before=(await f.pg.query('SELECT(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events')).rows[0];
 await f.pg.exec(`CREATE FUNCTION public.synthetic_report_file_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN UPDATE public.file_records SET archived=true WHERE id='${f.file.id}';RETURN NEW;END $$;CREATE TRIGGER aa_synthetic_report_file_change BEFORE INSERT ON public.session_reports FOR EACH ROW EXECUTE FUNCTION public.synthetic_report_file_change()`);
 try{const blocked=await f.save(f.input,'staff',key);assert.equal(blocked.response.status,409,JSON.stringify(blocked.body));assert.equal(blocked.body.error.code,'SESSION_REPORT_SOURCE_CHANGED');}finally{await f.pg.exec('DROP TRIGGER aa_synthetic_report_file_change ON public.session_reports;DROP FUNCTION public.synthetic_report_file_change()');}
 assert.equal((await f.pg.query('SELECT archived FROM public.file_records WHERE id=$1',[f.file.id])).rows[0].archived,false);assert.deepEqual((await f.pg.query('SELECT(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events')).rows[0],before);assert.equal((await f.save(f.input,'staff',key)).response.status,201);
},true);
check('two competing shared-report submissions have one winner and duplicate-key submissions retain one exact receipt',async f=>{
 const start=performance.now(),race=await Promise.all([f.save(),f.save({...f.input,reason:'PRIVATE competing draft'})]);assert.deepEqual(race.map(r=>r.response.status).sort(),[201,409]);const key=randomUUID(),input={...f.input,expectedVersion:1},same=await Promise.all([f.save(input,'staff',key),f.save(input,'staff',key)]);for(const r of same)assert.equal(r.response.status,200);assert.deepEqual(same[0].body,same[1].body);assert.equal((await f.pg.query('SELECT * FROM public.session_report_revisions')).rows.length,2);console.log(JSON.stringify({case:'two-shared-report-races',elapsedMs:Math.round(performance.now()-start),competingWinners:1,duplicateKeyReceipts:1}));
},true);
check('an original report author cannot review a correction requested by their subordinate',async f=>{
 assert.equal((await f.save()).response.status,201);
 for(const cap of ['approvals.view','approvals.review'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);
 await f.pg.query('UPDATE public.people SET supervisor_person_id=NULL WHERE id=$1',[f.actors.staff.person]);await f.pg.query('UPDATE public.people SET supervisor_person_id=$1 WHERE id=$2',[f.actors.staff.person,f.actors.manager.person]);
 const p=await f.correction({...f.change,expectedVersion:1});assert.equal(p.response.status,202);const denied=await f.approve(p.body.approval.id,'staff');assert.equal(denied.response.status,403);assert.equal(denied.body.error.code,'BENEFICIARY_REVIEW_FORBIDDEN');assert.equal((await f.approve(p.body.approval.id)).response.status,200);
});
check('class-only report/file grants work and explicit denial hides private media rather than becoming hub-wide access',async f=>{
 const role=await f.request('roles',{name:'Selected class reports',permissions:['session-reports.view','session-reports.record','files.view'].map(capability=>({capability,effect:'allow'}))});assert.equal(role.response.status,201);
 const target='people/'+f.actors.staff.person+'/access',v=(await f.request(target)).body.data.version;assert.equal((await f.request(target,{expectedVersion:v,assignments:[{roleId:role.body.data.id,allHubs:false,classIds:[f.c.id]}]})).response.status,200);assert.equal((await f.save()).response.status,201);
 const other=await f.makeClass();assert.equal((await f.request('sessions/'+other.session.id+'/report',undefined,'staff')).response.status,404);
 const deny=await f.request('roles',{name:'Selected class files denied',permissions:[{capability:'files.view',effect:'deny'}]});assert.equal(deny.response.status,201);
 const version=(await f.request(target)).body.data.version;assert.equal((await f.request(target,{expectedVersion:version,assignments:[{roleId:role.body.data.id,allHubs:true},{roleId:deny.body.data.id,allHubs:false,classIds:[f.c.id]}]})).response.status,200);
 assert.equal((await f.request(f.path,undefined,'staff')).response.status,404);assert.deepEqual((await f.request(f.path+'/history',undefined,'staff')).body.data,[]);
});
check('preserved local session day governs staff eligibility; malformed and future time facts cannot create a report',async f=>{
 await f.pg.query("UPDATE public.hubs SET time_zone='Pacific/Kiritimati' WHERE id=$1",[f.hub]);const saved=await f.save();assert.equal(saved.response.status,201);assert.equal(saved.body.data.context.session.on,'2026-01-02');assert.equal(saved.body.data.context.session.timeZone,'America/Toronto');
 await f.pg.query("UPDATE public.class_sessions SET time_info=time_info-'localStart' WHERE id=$1",[f.c.session.id]);assert.equal((await f.save({...f.input,expectedVersion:1})).body.error.code,'SESSION_TIME_EVIDENCE_INVALID');
 const c=await f.request('classes',{hubId:f.hub,courseId:f.c.course_id,courseVersion:1,name:'Future report',mode:'in_person',schedule:{oneOff:[{start:'2099-01-01T10:00',end:'2099-01-01T11:00'}]}});assert.equal(c.response.status,201);const s=(await f.request('classes/'+c.body.data.id+'/sessions')).body.data[0];
 const future=await f.request('sessions/'+s.id+'/report/change',{...f.change,document:{...f.document,blocks:[f.document.blocks[0]]}});assert.equal(future.body.error.code,'FUTURE_REPORT_FORBIDDEN');
});
check('native exact review cannot commit a pending report correction even when a matching revision was inserted',async f=>{
 assert.equal((await f.save()).response.status,201);const change={...f.change,expectedVersion:1,document:{...f.document,title:'PRIVATE Native review required'}},pending=await f.correction(change);assert.equal(pending.response.status,202);
 await f.pg.exec('BEGIN');await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
 await f.pg.query('UPDATE public.session_reports SET document=$2::jsonb,version=version+1,changed_by=$3,assignment_id=NULL,assignment_version=NULL,approval_id=$4,reason=$5 WHERE session_id=$1',[f.c.session.id,JSON.stringify(change.document),f.actors.master.person,pending.body.approval.id,change.reason]);
 await f.pg.query('INSERT INTO public.session_report_revisions(academy_id,session_id,version,definition) SELECT academy_id,session_id,version,to_jsonb(r) FROM public.session_reports r WHERE session_id=$1',[f.c.session.id]);
 await assert.rejects(f.pg.exec('COMMIT'),/REPORT_REVIEW_NOT_APPLIED/);await f.pg.exec('ROLLBACK');assert.equal((await f.request(f.path,undefined,'staff')).body.data.version,1);assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
},true);
check('declared hundred-block/twenty-file draft is retained completely and excessive blocks, media or bytes never partially save',async f=>{
 const media=[f.document.blocks[1]];
 for(let n=1;n<21;n++){
  const kind=n%2?'video':'image',r=await f.request('files',{...f.fileInput,name:'PRIVATE boundary media '+n,claimedMimeType:kind==='video'?'video/mp4':'image/jpeg'});assert.equal(r.response.status,201);
  media.push({id:randomUUID(),kind:'media',fileId:r.body.data.id,fileVersion:1,mediaKind:kind,caption:'PRIVATE 机器人'});
 }
 const blocks=[...Array.from({length:80},()=>({id:randomUUID(),kind:'text',text:'PRIVATE 机器人 focus, teamwork and problem solving.'})),...media.slice(0,20)],d={...f.document,locale:'fr',blocks};
 const start=performance.now(),before=f.metrics.businessQueries,made=await f.save({...f.input,document:d});assert.equal(made.response.status,201,JSON.stringify(made.body));assert.equal(made.body.data.document.blocks.length,100);assert.equal(made.body.data.mediaReferenceCount,20);assert.equal(made.body.data.context.media.length,20);console.log(JSON.stringify({case:'declared-report-boundary',blocks:100,mediaReferences:20,elapsedMs:Math.round(performance.now()-start),clientQueries:f.metrics.businessQueries-before}));
 for(const oversized of [{...d,blocks:[...blocks,{id:randomUUID(),kind:'text',text:'extra'}]},{...d,blocks:media}])assert.equal((await f.save({...f.input,expectedVersion:1,document:oversized})).response.status,400);
 const heavy={...f.document,blocks:Array.from({length:11},()=>({id:randomUUID(),kind:'text',text:'界'.repeat(3500)}))};assert.ok(Buffer.byteLength(JSON.stringify({...f.input,expectedVersion:1,document:heavy}),'utf8')<131072);assert.equal((await f.save({...f.input,expectedVersion:1,document:heavy})).body.error.code,'SESSION_REPORT_TOO_LARGE');
 assert.equal((await f.pg.query('SELECT version FROM public.session_reports')).rows[0].version,1);assert.equal((await f.pg.query('SELECT * FROM public.session_report_revisions')).rows.length,1);
},true);
test('schema73 preserves a real schema72 attendance sheet without inventing any report or publication',async()=>{
 const f=await fixture(72);try{
  const path='sessions/'+f.c.session.id+'/attendance';const a=await f.request(path+'/change',{expectedVersion:0,sessionVersion:1,entries:[],reason:'Synthetic real prior-schema attendance'});assert.equal(a.response.status,200,JSON.stringify(a.body));
  const before=(await f.pg.query('SELECT to_jsonb(a) definition FROM public.session_attendance a')).rows[0].definition;
  await f.pg.exec(await readFile(new URL('../db/migrations/073_session_reports.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.pg.query('SELECT to_jsonb(a) definition FROM public.session_attendance a')).rows[0].definition,before);assert.equal((await f.pg.query('SELECT * FROM public.session_reports')).rows.length,0);
  assert.equal((await f.request(f.path)).body.data,null);assert.equal((await f.correction(f.change,'master')).response.status,200);
  assert.equal((await f.request(f.path)).body.data.publishedToParents,false);
 }finally{await f.pg.close();}
});

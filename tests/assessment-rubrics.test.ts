import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { operationsFixture } from './operations-fixture.ts';
import { reportFixture } from './report-fixture.ts';
import { assessmentDefinition,standardAssessmentRubric } from '../src/modules/assessment-rubrics.ts';

async function fixture(){
 const f=await operationsFixture();for(const r of [f.staffRole,f.managerRole])for(const cap of ['assessment-rubrics.view','assessment-rubrics.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,r,cap]);
 const definition=structuredClone(standardAssessmentRubric),input={hubId:f.hub,definition,reason:'PRIVATE reviewed criterion configuration'},create=(value:unknown=input,as='master',key?:string)=>f.request('assessment-rubrics',value,as,key?{key}:{});
 const change=(id:string,value:unknown,as='master',key?:string)=>f.request('assessment-rubrics/'+id+'/change',value,as,key?{key}:{});
 const duplicate=(id:string,value:unknown={expectedSourceVersion:1,hubId:f.hub,name:'Copied assessment criteria',reason:'PRIVATE exact template copy'},as='master',key?:string)=>f.request('assessment-rubrics/'+id+'/duplicate',value,as,key?{key}:{});
 return {...f,definition,input,create,change,duplicate};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>,nativeOnly=false){test(name,{skip:nativeOnly&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
test('standard preset has the exact six requested configurable criteria and three labelled languages, without a score or claim of student performance',()=>{
 assert.equal(assessmentDefinition.safeParse(standardAssessmentRubric).success,true);assert.deepEqual(standardAssessmentRubric.criteria.map(c=>c.code),['focus','performance','teamwork','behaviour','problem_solving','recall']);for(const c of standardAssessmentRubric.criteria)assert.deepEqual(Object.keys(c.labels),['en','fr','zh-CN']);
});
check('master creates and revises exact rubric definitions with immutable history, standard scale and no invented scores',async f=>{
 const preset=await f.request('assessment-rubrics/presets',undefined,'staff');assert.equal(preset.response.status,200);assert.equal(preset.body.persisted,false);assert.equal(preset.body.data[0].definition.criteria.length,6);
 const key=randomUUID(),start=performance.now(),made=await f.create(f.input,'master',key);assert.equal(made.response.status,201,JSON.stringify(made.body));console.log(JSON.stringify({case:'reviewed-rubric-create',elapsedMs:Math.round(performance.now()-start)}));
 assert.deepEqual(made.body.data.definition,f.definition);assert.deepEqual(made.body.data.scale,{minimum:1,maximum:5});assert.equal(made.body.data.studentScoresCreated,false);assert.deepEqual((await f.create(f.input,'master',key)).body,made.body);
 const id=made.body.data.id,newDefinition={...f.definition,name:'Updated rubric',criteria:[...f.definition.criteria,{code:'creativity',labels:{en:'Creativity',fr:'Créativité','zh-CN':'创造力'}}]};assert.equal((await f.change(id,{expectedVersion:1,definition:newDefinition,reason:'PRIVATE additional criterion'})).response.status,200);
 const h=await f.request('assessment-rubrics/'+id+'/history?limit=1',undefined,'staff');assert.equal(h.body.data[0].definition.definition.criteria.length,6);assert.equal(h.body.nextVersion,1);assert.equal((await f.request('assessment-rubrics/'+id+'/history?afterVersion=1')).body.data[0].definition.definition.criteria.length,7);
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);assert.doesNotMatch(JSON.stringify((await f.pg.query("SELECT changes FROM public.audit_events WHERE action LIKE 'assessment-rubric.%'")).rows),/PRIVATE|creativity|criteria/);
});
check('lower actors and bots propose only; upper human review and master self-approval reuse private approval notices',async f=>{
 const p=await f.create(f.input,'staff');assert.equal(p.response.status,202);assert.equal((await f.pg.query('SELECT * FROM public.assessment_rubrics')).rows.length,0);assert.equal((await f.approve(p.body.approval.id,'staff')).response.status,403);
 const made=await f.approve(p.body.approval.id,'manager');assert.equal(made.response.status,200,JSON.stringify(made.body));const next=await f.change(made.body.data.id,{expectedVersion:1,definition:{...f.definition,active:false},reason:'PRIVATE bot proposes retirement'},'bot');assert.equal(next.response.status,202);assert.equal((await f.approve(next.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(next.body.approval.id)).response.status,200);
 assert.ok((await f.pg.query("SELECT n.id FROM public.portal_notifications n JOIN public.automation_event_sources s ON s.academy_id=n.academy_id AND s.event_id=n.event_id WHERE s.approval_id=$1 AND n.origin='mandatory'",[next.body.approval.id])).rows.length>0);
});
check('shared catalogues are readable with a local grant but shared configuration requires school-wide edit and view authority',async f=>{
 const shared=await f.create({...f.input,hubId:null});assert.equal(shared.response.status,201,JSON.stringify(shared.body));assert.equal((await f.request('assessment-rubrics/'+shared.body.data.id,undefined,'staff')).response.status,200);
 assert.equal((await f.create({...f.input,hubId:null},'staff')).response.status,403);assert.equal((await f.change(shared.body.data.id,{expectedVersion:1,definition:f.definition,reason:'Cannot edit school policy'},'staff')).response.status,403);
 const local=await f.create();const other=await f.create({...f.input,hubId:f.otherHub});assert.equal(local.response.status,201);assert.equal(other.response.status,201);
 const list=await f.request('assessment-rubrics?limit=1',undefined,'staff');assert.equal(list.body.data.length,1);assert.ok(list.body.nextCursor);const next=await f.request('assessment-rubrics?after='+list.body.nextCursor,undefined,'staff');assert.equal(next.body.data.length,1);
 assert.equal((await f.request('assessment-rubrics?includeShared=false',undefined,'staff')).body.data.length,1);assert.equal((await f.request('assessment-rubrics/'+other.body.data.id,undefined,'staff')).response.status,403);
 assert.equal((await f.request('assessment-rubrics?q=Student',undefined,'staff')).body.data.length,2);assert.equal((await f.request('assessment-rubrics?q=%25',undefined,'staff')).body.data.length,0);
 assert.equal((await f.change(local.body.data.id,{expectedVersion:1,definition:{...f.definition,active:false},reason:'Retire local selection'})).response.status,200);assert.equal((await f.request('assessment-rubrics?includeShared=false&active=false',undefined,'staff')).body.data.length,1);
 assert.equal((await f.request('assessment-rubrics/'+local.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
});
check('duplicates pin a permitted current source, retain copy provenance and then evolve independently with exact retries',async f=>{
 const source=await f.create();assert.equal(source.response.status,201);const id=source.body.data.id,key=randomUUID(),i={expectedSourceVersion:1,hubId:f.otherHub,name:'Independent copy',reason:'PRIVATE reviewed copy'};
 const copied=await f.duplicate(id,i,'master',key);assert.equal(copied.response.status,201,JSON.stringify(copied.body));assert.equal(copied.body.data.copied_from_id,id);assert.equal(copied.body.data.copied_from_version,1);assert.deepEqual(copied.body.data.definition.criteria,f.definition.criteria);
 const localDefault=await f.duplicate(id,{expectedSourceVersion:1,name:'Keep source hub by default',reason:'PRIVATE easy local duplication'},'staff');assert.equal(localDefault.response.status,202);assert.equal((await f.request('approvals/'+localDefault.body.approval.id,undefined,'staff')).body.data.payload.hubId,f.hub);
 assert.equal((await f.change(id,{expectedVersion:1,definition:{...f.definition,description:'Source changed later'},reason:'PRIVATE source evolution'})).response.status,200);
 assert.deepEqual((await f.duplicate(id,i,'master',key)).body,copied.body);assert.equal((await f.duplicate(id,i)).response.status,409,'new stale copies are not silently made');
 const update=await f.change(copied.body.data.id,{expectedVersion:1,definition:{...copied.body.data.definition,active:false},reason:'Independent fork retirement'});assert.equal(update.response.status,200,JSON.stringify(update.body));assert.equal((await f.request('assessment-rubrics/'+id)).body.data.definition.active,true);
});
check('source template, hub and authority changes invalidate pending rubric requests rather than altering their meaning',async f=>{
 const source=await f.create();assert.equal(source.response.status,201);const id=source.body.data.id,p=await f.duplicate(id,undefined,'staff');assert.equal(p.response.status,202);
 await f.change(id,{expectedVersion:1,definition:{...f.definition,name:'Changed source name'},reason:'PRIVATE concurrent source change'});assert.equal((await f.approve(p.body.approval.id)).body.approval.status,'stale');
 const hub=await f.create(f.input,'staff');assert.equal(hub.response.status,202);await f.pg.query('UPDATE public.hubs SET active=false,version=version+1 WHERE id=$1',[f.hub]);assert.equal((await f.approve(hub.body.approval.id)).body.approval.status,'stale');
 await f.pg.query('UPDATE public.hubs SET active=true,version=version+1 WHERE id=$1',[f.hub]);const permission=await f.create(f.input,'staff');assert.equal(permission.response.status,202);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='assessment-rubrics.view'",[f.staffRole]);assert.equal((await f.request('approvals/'+permission.body.approval.id,undefined,'staff')).response.status,404);assert.equal((await f.approve(permission.body.approval.id)).body.approval.status,'stale');
});
check('cross-hub copy approval history requires both source and destination viewing rights',async f=>{
 const source=await f.create();assert.equal(source.response.status,201);const capRole=await f.request('roles',{name:'Cross-hub rubric editor',permissions:['assessment-rubrics.view','assessment-rubrics.edit'].map(capability=>({capability,effect:'allow'}))});assert.equal(capRole.response.status,201);
 const target='people/'+f.actors.staff.person+'/access',v=(await f.request(target)).body.data.version;assert.equal((await f.request(target,{expectedVersion:v,assignments:[{roleId:capRole.body.data.id,allHubs:false,hubIds:[f.hub,f.otherHub]}]})).response.status,200);
 const copy=await f.duplicate(source.body.data.id,{expectedSourceVersion:1,hubId:f.otherHub,name:'Other hub copy',reason:'PRIVATE cross-hub provenance'},'staff');assert.equal(copy.response.status,202);
 const now=(await f.request(target)).body.data.version;assert.equal((await f.request(target,{expectedVersion:now,assignments:[{roleId:capRole.body.data.id,allHubs:false,hubIds:[f.otherHub]}]})).response.status,200);assert.equal((await f.request('approvals/'+copy.body.approval.id,undefined,'staff')).response.status,404);
});
check('strict ordered criteria reject duplicate codes, unsupported languages, fake scores and scope/clearance injections',async f=>{
 for(const definition of [{...f.definition,criteria:[]},{...f.definition,criteria:[...f.definition.criteria,f.definition.criteria[0]]},{...f.definition,criteria:[{code:'Bad Code',labels:{en:'Bad'}}]},{...f.definition,criteria:[{code:'focus',labels:{fr:'Missing English'}}]},{...f.definition,criteria:[{code:'focus',labels:{en:'Focus',xx:'Unknown'}}]},{...f.definition,scores:[5]},{...f.definition,criteria:[{code:'focus',labels:{en:'bad\0'}}]}])assert.equal((await f.create({...f.input,definition})).response.status,400);
 for(const patch of [{approved:true},{copiedFrom:{id:randomUUID(),version:1}},{studentId:f.actors.peer.person},{reason:'\0'}])assert.equal((await f.create({...f.input,...patch})).response.status,400);
 const made=await f.create();for(const patch of [{hubId:f.otherHub},{copied_from_id:randomUUID()}])assert.equal((await f.change(made.body.data.id,{expectedVersion:1,definition:f.definition,reason:'Cannot move ownership',...patch})).response.status,400);
 for(const definition of [{name:'No accidental reactivation',criteria:f.definition.criteria},{name:'Explicit active missing description',criteria:f.definition.criteria,active:false},{name:'Explicit description missing active',criteria:f.definition.criteria,description:''}])assert.equal((await f.change(made.body.data.id,{expectedVersion:1,definition,reason:'Incomplete replacement must fail'})).response.status,400);
 assert.equal((await f.request('assessment-rubrics/presets/history')).response.status,404);
});
check('audit/outbox failure rolls back definition, immutable revision, approval and notifications before same-key retry',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.assessment_rubrics) rubrics,(SELECT count(*)::int FROM public.assessment_rubric_revisions) revisions,(SELECT count(*)::int FROM public.approval_requests) approvals,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.portal_notifications) notices')).rows[0],before=await counts(),key=randomUUID();
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.create(f.input,'master',key)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}assert.deepEqual(await counts(),before);assert.equal((await f.create(f.input,'master',key)).response.status,201);
});
check('native definition validation, exact applied review, append-only history and tenant boundaries reject forged records',async f=>{
 const pending=await f.create(f.input,'staff');assert.equal(pending.response.status,202);const p=(await f.pg.query<{id:string;target_id:string}>('SELECT id,target_id FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows[0];
 await f.pg.exec('BEGIN');await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
 await f.pg.query('INSERT INTO public.assessment_rubrics(academy_id,id,hub_id,definition,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)',[f.a,p.target_id,f.hub,JSON.stringify(f.definition),f.actors.master.person,p.id,f.input.reason]);
 await f.pg.query('INSERT INTO public.assessment_rubric_revisions(academy_id,rubric_id,version,definition) SELECT academy_id,id,version,to_jsonb(r) FROM public.assessment_rubrics r WHERE id=$1',[p.target_id]);
 await assert.rejects(f.pg.exec('COMMIT'),/RUBRIC_REVIEW_NOT_APPLIED/);await f.pg.exec('ROLLBACK');assert.equal((await f.pg.query('SELECT * FROM public.assessment_rubrics')).rows.length,0);
 const made=await f.approve(p.id);assert.equal(made.response.status,200);await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);for(const sql of ['DELETE FROM public.assessment_rubrics','DELETE FROM public.assessment_rubric_revisions',"UPDATE public.assessment_rubric_revisions SET definition='{}'",'UPDATE public.assessment_rubrics SET hub_id=NULL','UPDATE public.assessment_rubrics SET created_at=now()','UPDATE public.assessment_rubrics SET version=version+2'])await assert.rejects(f.pg.exec(sql));
  for(const d of [null,[],{}, {...f.definition,criteria:[{code:'focus',labels:{en:'Focus'},extra:true}]},{...f.definition,criteria:Array.from({length:31},(_,n)=>({code:'c'+n,labels:{en:'Criterion'}}))}])assert.equal((await f.pg.query<{valid:boolean}>('SELECT public.assessment_rubric_valid($1::jsonb) valid',[JSON.stringify(d)])).rows[0].valid,false);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.assessment_rubrics')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.assessment_rubric_revisions')).rows.length,0);
 }finally{await f.pg.exec('RESET ROLE');}
});
check('actual hub retirement after dependency reads is caught at INSERT and rolls back before an exact-key retry',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.assessment_rubrics) rubrics,(SELECT count(*)::int FROM public.approval_requests) approvals,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events')).rows[0],before=await counts(),key=randomUUID();
 await f.pg.exec(`CREATE FUNCTION public.synthetic_rubric_hub_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN UPDATE public.hubs SET active=false,version=version+1 WHERE id='${f.hub}';RETURN NEW;END $$;CREATE TRIGGER aa_synthetic_rubric_hub_change BEFORE INSERT ON public.assessment_rubrics FOR EACH ROW EXECUTE FUNCTION public.synthetic_rubric_hub_change()`);
 try{const blocked=await f.create(f.input,'master',key);assert.equal(blocked.response.status,409,JSON.stringify(blocked.body));assert.equal(blocked.body.error.code,'RUBRIC_SOURCE_CHANGED');}finally{await f.pg.exec('DROP TRIGGER aa_synthetic_rubric_hub_change ON public.assessment_rubrics;DROP FUNCTION public.synthetic_rubric_hub_change()');}
 assert.deepEqual(await counts(),before);assert.equal((await f.pg.query('SELECT active FROM public.hubs WHERE id=$1',[f.hub])).rows[0].active,true);assert.equal((await f.create(f.input,'master',key)).response.status,201);
},true);
check('thirty criteria are retained in order and excessive definitions fail without a partial revision',async f=>{
 const criteria=Array.from({length:30},(_,n)=>({code:'criterion_'+n,labels:{en:'Criterion '+n,fr:'Critère '+n,'zh-CN':'评估项 '+n}})),definition={...f.definition,criteria};
 const made=await f.create({...f.input,definition});assert.equal(made.response.status,201,JSON.stringify(made.body));assert.deepEqual(made.body.data.definition.criteria,criteria);
 assert.equal((await f.change(made.body.data.id,{expectedVersion:1,definition:{...definition,criteria:[...criteria,{code:'extra',labels:{en:'Extra'}}]},reason:'Too many'})).response.status,400);assert.equal((await f.pg.query('SELECT * FROM public.assessment_rubric_revisions')).rows.length,1);
});
check('two simultaneous edits cannot overwrite the same reviewed rubric version',async f=>{
 const made=await f.create();assert.equal(made.response.status,201);const id=made.body.data.id,start=performance.now(),i={expectedVersion:1,definition:{...f.definition,name:'One proposed revision'},reason:'PRIVATE competing revision'},race=await Promise.all([f.change(id,i),f.change(id,{...i,definition:{...i.definition,name:'Another proposed revision'}})]);
 assert.deepEqual(race.map(r=>r.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.assessment_rubric_revisions')).rows.length,2);console.log(JSON.stringify({case:'two-rubric-revisions',elapsedMs:Math.round(performance.now()-start),winners:1}));
},true);
test('schema75 preserves a real published schema74 report without inventing rubrics or scores',async()=>{
 const f=await reportFixture(74);try{
  assert.equal((await f.save()).response.status,201);const pub=await f.request('sessions/'+f.c.session.id+'/report/publications',{reportVersion:1,classAudienceReviewed:true,reason:'Synthetic actual prior-schema publication'});assert.equal(pub.response.status,201);
  const before=(await f.pg.query('SELECT to_jsonb(p) definition FROM public.report_publications p')).rows[0].definition;
  await f.pg.exec(await readFile(new URL('../db/migrations/075_assessment_rubrics.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query('SELECT to_jsonb(p) definition FROM public.report_publications p')).rows[0].definition,before);assert.equal((await f.pg.query('SELECT * FROM public.assessment_rubrics')).rows.length,0);
  const made=await f.request('assessment-rubrics',{definition:standardAssessmentRubric,reason:'Explicit standard template creation'});assert.equal(made.response.status,201,JSON.stringify(made.body));assert.equal(made.body.data.studentScoresCreated,false);
 }finally{await f.pg.close();}
});

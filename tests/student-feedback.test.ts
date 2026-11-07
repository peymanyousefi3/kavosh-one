import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { reportFixture } from './report-fixture.ts';
import { standardAssessmentRubric } from '../src/modules/assessment-rubrics.ts';

async function fixture(){
 const f=await reportFixture(),student=f.actors.peer.person;
 assert.equal((await f.request('students',{personId:student,legalName:'PRIVATE student',dateOfBirth:'2014-03-20',recruiter:{kind:'academy'}})).response.status,201);
 const enrollment=await f.request('classes/'+f.c.id+'/enrollments',{studentId:student,studentProfileVersion:1,joinsOn:'2026-01-02',reason:'PRIVATE dated student'});assert.equal(enrollment.response.status,201);
 const rubric=await f.request('assessment-rubrics',{hubId:f.hub,definition:standardAssessmentRubric,reason:'PRIVATE administrative rubric reason'});assert.equal(rubric.response.status,201);
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['student-feedback.view','student-feedback.record','student-feedback.edit','student-feedback.publish'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 // A grader sees applicable criteria, not the administrative rubric catalogue.
 const access='people/'+f.actors.staff.person+'/access',v=(await f.request(access)).body.data.version;assert.equal((await f.request(access,{expectedVersion:v,assignments:[{roleId:f.staffRole,allHubs:false,classIds:[f.c.id]}]})).response.status,200);
 const input={expectedVersion:0,sessionVersion:1,enrollmentId:enrollment.body.data.id,enrollmentVersion:1,rubricId:rubric.body.data.id,rubricVersion:1,ratings:standardAssessmentRubric.criteria.map((c,n)=>({code:c.code,score:n%5+1})),note:'PRIVATE individual learning observation',publishToFamily:false,reason:'PRIVATE grading reason'},staffInput={...input,assignmentId:f.assignment.id,assignmentVersion:1},path='sessions/'+f.c.session.id+'/student-feedback';
 const save=(i:unknown=staffInput,as='staff',key?:string)=>f.request(path,i,as,key?{key}:{}),change=(i:unknown=input,as='master',key?:string)=>f.request(path+'/change',i,as,key?{key}:{});
 async function parent(){const guardian=f.actors.manager.person;assert.equal((await f.request('guardians',{personId:guardian,legalName:'PRIVATE guardian'})).response.status,201);assert.equal((await f.request('students/'+student+'/guardians',{guardianId:guardian,relationship:'parent',reason:'PRIVATE verified family'})).response.status,201);
  const role=await f.request('roles',{name:'Own child learning only',permissions:[{capability:'received-reports.view',effect:'allow'}]});assert.equal(role.response.status,201);const p='people/'+guardian+'/access',version=(await f.request(p)).body.data.version;assert.equal((await f.request(p,{expectedVersion:version,assignments:[{roleId:role.body.data.id,allHubs:false,personIds:[student]}]})).response.status,200);return {guardian,role:role.body.data.id};}
 const received=(id?:string,as='manager',query='')=>f.request('students/'+student+'/session-feedback'+(id?'/'+id:'')+query,undefined,as);
 return {...f,student,enrollment:enrollment.body.data,rubric:rubric.body.data,input,staffInput,path,save,change,parent,received};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>,nativeOnly=false){test(name,{skip:nativeOnly&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('future scheduling preserves a pending student assessment source and its upper approval',async f=>{
 const p=await f.save();assert.equal(p.response.status,202);const next=await f.request('classes/'+f.c.id+'/schedules',{expectedVersion:1,schedule:{oneOff:[{start:'2027-01-09T23:30',end:'2027-01-10T00:30'}]}});assert.equal(next.response.status,201,JSON.stringify(next.body));const approved=await f.approve(p.body.approval.id,'manager');assert.equal(approved.response.status,200,JSON.stringify(approved.body));assert.equal(approved.body.approval.status,'applied');assert.equal(approved.body.data.context.source.session.classVersion,1);
});
check('assigned class-scoped staff select contextual criteria without catalogue access and require upper review',async f=>{
 assert.equal((await f.request('assessment-rubrics/'+f.rubric.id,undefined,'staff')).response.status,403);
 const options=await f.request(f.path+'/options?enrollmentId='+f.enrollment.id,undefined,'staff');assert.equal(options.response.status,200,JSON.stringify(options.body));assert.equal(options.body.assignment.id,f.assignment.id);assert.deepEqual(options.body.data[0].definition,standardAssessmentRubric);assert.doesNotMatch(JSON.stringify(options.body),/PRIVATE administrative rubric reason/);
 const pending=await f.save();assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.pg.query('SELECT * FROM public.student_feedback')).rows.length,0);assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);
 const made=await f.approve(pending.body.approval.id,'manager');assert.equal(made.response.status,200,JSON.stringify(made.body));assert.equal(made.body.data.publish_to_family,false);assert.equal(made.body.data.recorded_by,f.actors.staff.person);assert.equal(made.body.data.changed_by,f.actors.manager.person);assert.deepEqual(made.body.data.assessment.map((c:{code:string})=>c.code),standardAssessmentRubric.criteria.map(c=>c.code));assert.equal(made.body.data.payrollApproved,false);
 assert.equal((await f.request('student-feedback/'+made.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);
});
check('family sees only explicitly approved own-child feedback and no private provenance or history',async f=>{
 const made=await f.change();assert.equal(made.response.status,200,JSON.stringify(made.body));const id=made.body.data.id;await f.parent();assert.deepEqual((await f.received()).body.data,[]);assert.equal((await f.received(id)).response.status,404);
 const published=await f.change({...f.input,expectedVersion:1,publishToFamily:true});assert.equal(published.response.status,200,JSON.stringify(published.body));const read=await f.received(id);assert.equal(read.response.status,200,JSON.stringify(read.body));assert.equal(read.body.data.on,'2026-01-02');assert.equal(read.body.data.note,f.input.note);assert.equal(read.body.data.assessment.length,6);
 for(const secret of ['PRIVATE grading reason','context','changed_by','recorded_by',f.actors.staff.person])assert.ok(!JSON.stringify(read.body).includes(secret),secret);
 assert.equal((await f.request('student-feedback/'+id,undefined,'manager')).response.status,404);assert.equal((await f.request('student-feedback/'+id+'/history',undefined,'manager')).response.status,404);assert.equal((await f.received(id,'bot')).response.status,403);
 await f.pg.query('UPDATE public.class_enrollments SET enabled=false,version=version+1 WHERE id=$1',[f.enrollment.id]);assert.deepEqual((await f.received()).body.data,[]);assert.equal((await f.received(id)).response.status,404);
});
check('strict complete integer criterion scores reject malformed or incomplete ratings and forged flags',async f=>{
 for(const ratings of [[],f.input.ratings.slice(1),[...f.input.ratings,f.input.ratings[0]],[{code:'unknown',score:3}],f.input.ratings.map((r,n)=>n? r:{...r,score:0}),f.input.ratings.map((r,n)=>n?r:{...r,score:6}),f.input.ratings.map((r,n)=>n?r:{...r,score:2.5})])assert.ok([400,409].includes((await f.change({...f.input,ratings})).response.status));
 for(const patch of [{approved:true},{payrollApproved:true},{note:'\0'},{studentId:randomUUID()},{publishToFamily:'true'}])assert.equal((await f.change({...f.input,...patch})).response.status,400);
 assert.equal((await f.save({...f.staffInput,assignmentId:randomUUID()})).response.status,409);assert.equal((await f.save(f.staffInput,'bot')).response.status,403);
 assert.equal((await f.change({...f.input,sessionVersion:2})).response.status,409);assert.equal((await f.change({...f.input,enrollmentVersion:2})).response.status,409);
 assert.equal((await f.request(f.path+'/options?enrollmentId='+f.enrollment.id,undefined,'manager')).response.status,403);
});
check('pending source changes become stale and explicit publication needs separate current permission',async f=>{
 const p=await f.save();assert.equal(p.response.status,202);await f.pg.query('UPDATE public.class_enrollments SET version=version+1 WHERE id=$1',[f.enrollment.id]);assert.equal((await f.approve(p.body.approval.id)).body.approval.status,'stale');
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='student-feedback.publish'",[f.staffRole]);assert.equal((await f.save({...f.staffInput,enrollmentVersion:2,publishToFamily:true})).response.status,404);
 const privateRequest=await f.save({...f.staffInput,enrollmentVersion:2});assert.equal(privateRequest.response.status,202);assert.equal((await f.approve(privateRequest.body.approval.id)).response.status,200);
});
check('later rubric revisions never reinterpret existing scores and administrators can explicitly retain historical meaning',async f=>{
 const made=await f.change({...f.input,publishToFamily:true});assert.equal(made.response.status,200);const id=made.body.data.id;
 const revised={...standardAssessmentRubric,active:false,criteria:standardAssessmentRubric.criteria.map(c=>({...c,labels:{en:'New '+c.labels.en}}))};assert.equal((await f.request('assessment-rubrics/'+f.rubric.id+'/change',{expectedVersion:1,definition:revised,reason:'PRIVATE retire old meaning'})).response.status,200);
 assert.equal((await f.save({...f.staffInput,expectedVersion:1})).response.status,409);
 const corrected=await f.change({...f.input,expectedVersion:1,note:'Explicit correction with original meaning',publishToFamily:true});assert.equal(corrected.response.status,200,JSON.stringify(corrected.body));assert.equal(corrected.body.data.rubric_version,1);assert.equal(corrected.body.data.assessment[0].labels.en,'Focus');
 await f.parent();assert.equal((await f.received(id)).body.data.assessment[0].labels.en,'Focus');const history=await f.request('student-feedback/'+id+'/history?limit=1');assert.equal(history.body.data[0].definition.note,f.input.note);assert.equal(history.body.nextVersion,1);
 const stop=await f.request('student-feedback/'+id+'/withdraw',{expectedVersion:2,reason:'PRIVATE protective withdrawal'});assert.equal(stop.response.status,200,JSON.stringify(stop.body));assert.equal((await f.received(id)).response.status,404);assert.equal((await f.request('student-feedback/'+id)).body.data.note,'Explicit correction with original meaning');assert.equal((await f.pg.query('SELECT * FROM public.student_feedback_revisions')).rows.length,3);
});
check('atomic outbox failure rolls back grades, revisions and approval; exact-key retry returns one receipt',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.student_feedback) grades,(SELECT count(*)::int FROM public.student_feedback_revisions) revisions,(SELECT count(*)::int FROM public.approval_requests) approvals,(SELECT count(*)::int FROM public.audit_events) audits')).rows[0],before=await counts(),key=randomUUID();
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.change(f.input,'master',key)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}assert.deepEqual(await counts(),before);
 const made=await f.change(f.input,'master',key);assert.equal(made.response.status,200,JSON.stringify(made.body));assert.deepEqual((await f.change(f.input,'master',key)).body,made.body);
});
check('native immutable history and tenant boundaries protect stored grades',async f=>{
 const made=await f.change();assert.equal(made.response.status,200,JSON.stringify(made.body));await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);for(const sql of ['DELETE FROM public.student_feedback','DELETE FROM public.student_feedback_revisions',"UPDATE public.student_feedback_revisions SET definition='{}'",'UPDATE public.student_feedback SET student_id=gen_random_uuid()','UPDATE public.student_feedback SET version=version+2'])await assert.rejects(f.pg.exec(sql));await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.student_feedback')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.student_feedback_revisions')).rows.length,0);}finally{await f.pg.exec('RESET ROLE');}
});
check('native exact pending approval and revision cannot commit without an applied human review',async f=>{
 const pending=await f.save();assert.equal(pending.response.status,202);const p=(await f.pg.query<{id:string;target_id:string;review_context:{source:unknown}}>('SELECT id,target_id,review_context FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows[0];
 await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
  await f.pg.query(`INSERT INTO public.student_feedback(academy_id,id,session_id,class_id,hub_id,student_id,session_version,enrollment_id,enrollment_version,rubric_id,rubric_version,ratings,note,publish_to_family,context,assignment_id,assignment_version,recorded_by,created_by,changed_by,approval_id,reason) SELECT academy_id,target_id,$2,$3,$4,$5,1,$6,1,$7,1,payload->'ratings',payload->>'note',false,jsonb_build_object('source',review_context->'source'),$8,1,requester_id,requester_id,$9,id,payload->>'reason' FROM public.approval_requests WHERE id=$1`,[p.id,f.c.session.id,f.c.id,f.hub,f.student,f.enrollment.id,f.rubric.id,f.assignment.id,f.actors.master.person]);
  await f.pg.query('INSERT INTO public.student_feedback_revisions(academy_id,feedback_id,version,definition) SELECT academy_id,id,version,to_jsonb(f) FROM public.student_feedback f WHERE id=$1',[p.target_id]);await assert.rejects(f.pg.exec('COMMIT'),/FEEDBACK_REVIEW_NOT_APPLIED/);
 }finally{await f.pg.exec('ROLLBACK');}
 assert.equal((await f.pg.query('SELECT * FROM public.student_feedback')).rows.length,0);assert.equal((await f.approve(p.id)).response.status,200);
},true);
check('source-hub denial overrides a selected child whose current primary hub is elsewhere',async f=>{
 const made=await f.change({...f.input,publishToFamily:true});assert.equal(made.response.status,200);const {guardian,role}=await f.parent();assert.equal((await f.received(made.body.data.id)).response.status,200);
 const deny=await f.request('roles',{name:'Deny historical source hub',permissions:[{capability:'received-reports.view',effect:'deny'}]});assert.equal(deny.response.status,201);const path='people/'+guardian+'/access',version=(await f.request(path)).body.data.version;
 assert.equal((await f.request(path,{expectedVersion:version,assignments:[{roleId:role,allHubs:false,personIds:[f.student]},{roleId:deny.body.data.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);assert.deepEqual((await f.received()).body.data,[]);assert.equal((await f.received(made.body.data.id)).response.status,404);
});
check('local-day joining, leaving and future-session safeguards reject ineligible source selections',async f=>{
 await f.pg.query("UPDATE public.class_enrollments SET joins_on='2026-01-03',version=version+1 WHERE id=$1",[f.enrollment.id]);assert.equal((await f.change({...f.input,enrollmentVersion:2})).response.status,409);
 await f.pg.query("UPDATE public.class_enrollments SET joins_on='2026-01-01',leaves_on='2026-01-01',version=version+1 WHERE id=$1",[f.enrollment.id]);assert.equal((await f.change({...f.input,enrollmentVersion:3})).response.status,409);
 await f.pg.query("UPDATE public.class_enrollments SET joins_on='2026-01-02',leaves_on='2026-01-02',version=version+1 WHERE id=$1",[f.enrollment.id]);assert.equal((await f.change({...f.input,enrollmentVersion:4})).response.status,200);
 const future=await f.request('classes',{hubId:f.hub,courseId:f.c.course_id,courseVersion:1,name:'Future feedback safeguard',mode:'in_person',schedule:{oneOff:[{start:'2100-01-02T23:30',end:'2100-01-03T00:30'}]}});assert.equal(future.response.status,201,JSON.stringify(future.body));const session=(await f.request('classes/'+future.body.data.id+'/sessions')).body.data[0];
 const enrollment=await f.request('classes/'+future.body.data.id+'/enrollments',{studentId:f.student,studentProfileVersion:1,joinsOn:'2100-01-02',reason:'PRIVATE future enrollment'});assert.equal(enrollment.response.status,201);
 const denied=await f.request('sessions/'+session.id+'/student-feedback/change',{...f.input,enrollmentId:enrollment.body.data.id});assert.equal(denied.response.status,409,JSON.stringify(denied.body));assert.equal(denied.body.error.code,'FUTURE_FEEDBACK_FORBIDDEN');
});
check('publication revalidates upper reviewer rights and bot administrative requests remain proposals',async f=>{
 const p=await f.save({...f.staffInput,publishToFamily:true});assert.equal(p.response.status,202);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='student-feedback.publish'",[f.managerRole]);const denied=await f.approve(p.body.approval.id,'manager');assert.equal(denied.response.status,409);assert.equal(denied.body.approval.status,'stale');assert.equal((await f.pg.query('SELECT * FROM public.student_feedback')).rows.length,0);
 const bot=await f.change(f.input,'bot');assert.equal(bot.response.status,202,JSON.stringify(bot.body));assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
});
check('published feedback cannot be implicitly withdrawn through an edit or omitted visibility field',async f=>{
 const made=await f.change({...f.input,publishToFamily:true});assert.equal(made.response.status,200);const {publishToFamily,...withoutVisibility}=f.input;assert.equal((await f.change({...withoutVisibility,expectedVersion:1})).response.status,400);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='student-feedback.publish'",[f.managerRole]);for(const published of [true,false])assert.equal((await f.change({...f.input,expectedVersion:1,publishToFamily:published},'manager')).response.status,404);assert.equal((await f.request('student-feedback/'+made.body.data.id+'/withdraw',{expectedVersion:1,reason:'Cannot bypass publication permission'},'manager')).response.status,404);assert.equal((await f.request('student-feedback/'+made.body.data.id)).body.data.publish_to_family,true);
});
check('selected-student grading works without hub-wide access and native case bindings retain actual source denials',async f=>{
 const access='people/'+f.actors.staff.person+'/access',v=(await f.request(access)).body.data.version;assert.equal((await f.request(access,{expectedVersion:v,assignments:[{roleId:f.staffRole,allHubs:false,personIds:[f.student]}]})).response.status,200);
 const p=await f.save();assert.equal(p.response.status,202,JSON.stringify(p.body));assert.equal((await f.request('approvals/'+p.body.approval.id,undefined,'staff')).response.status,200);
 const binding=(await f.pg.query<{privacy_bindings:unknown[]}>('SELECT privacy_bindings FROM public.approval_requests WHERE id=$1',[p.body.approval.id])).rows[0].privacy_bindings;assert.ok(JSON.stringify(binding).includes(f.student));assert.ok(JSON.stringify(binding).includes(f.c.id));
 const deny=await f.request('roles',{name:'No grading from this source hub',permissions:[{capability:'student-feedback.view',effect:'deny'}]});assert.equal(deny.response.status,201);const next=(await f.request(access)).body.data.version;assert.equal((await f.request(access,{expectedVersion:next,assignments:[{roleId:f.staffRole,allHubs:false,personIds:[f.student]},{roleId:deny.body.data.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);
 assert.equal((await f.request(f.path+'/options?enrollmentId='+f.enrollment.id,undefined,'staff')).response.status,404);assert.equal((await f.request('approvals/'+p.body.approval.id,undefined,'staff')).response.status,404);assert.equal((await f.approve(p.body.approval.id)).body.approval.status,'stale');
});
check('actual enrollment change inside INSERT is caught natively and fully rolled back before retry',async f=>{
 const key=randomUUID();await f.pg.exec(`CREATE FUNCTION public.synthetic_feedback_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN UPDATE public.class_enrollments SET enabled=false,version=version+1 WHERE id='${f.enrollment.id}';RETURN NEW;END $$;CREATE TRIGGER aa_synthetic_feedback_change BEFORE INSERT ON public.student_feedback FOR EACH ROW EXECUTE FUNCTION public.synthetic_feedback_change()`);
 try{assert.equal((await f.change(f.input,'master',key)).response.status,409);}finally{await f.pg.exec('DROP TRIGGER aa_synthetic_feedback_change ON public.student_feedback;DROP FUNCTION public.synthetic_feedback_change()');}
 assert.equal((await f.pg.query('SELECT enabled FROM public.class_enrollments WHERE id=$1',[f.enrollment.id])).rows[0].enabled,true);assert.equal((await f.pg.query('SELECT * FROM public.student_feedback')).rows.length,0);assert.equal((await f.change(f.input,'master',key)).response.status,200);
},true);
check('tiny competing creation race preserves one reviewed head and one immutable revision',async f=>{
 const start=performance.now(),r=await Promise.all([f.change(),f.change({...f.input,note:'Another explicit proposal'})]);assert.deepEqual(r.map(x=>x.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.student_feedback')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.student_feedback_revisions')).rows.length,1);console.log(JSON.stringify({case:'tiny-student-feedback-create-race',elapsedMs:Math.round(performance.now()-start)}));
},true);
test('schema76 preserves schema75 rubric data without inventing student feedback',async()=>{
 const f=await reportFixture(75);try{const made=await f.request('assessment-rubrics',{definition:standardAssessmentRubric,reason:'PRIVATE existing rubric'});assert.equal(made.response.status,201);const before=(await f.pg.query('SELECT to_jsonb(r) record FROM public.assessment_rubrics r')).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/076_student_feedback.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query('SELECT to_jsonb(r) record FROM public.assessment_rubrics r')).rows,before);assert.equal((await f.pg.query('SELECT * FROM public.student_feedback')).rows.length,0);
 }finally{await f.pg.close();}
});

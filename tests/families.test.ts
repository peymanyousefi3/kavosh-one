import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture() {
  const f=await operationsFixture();
  async function person(name:string,hubId=f.hub) {const r=await f.request('people',{name,hubId});assert.equal(r.response.status,201);return r.body.data.id as string;}
  const student=await person('Synthetic child'),guardian=await person('Synthetic draft parent'),otherStudent=await person('Outside child',f.otherHub);
  for(const id of [student,otherStudent])assert.equal((await f.request('students',{personId:id,legalName:'Private legal child name',dateOfBirth:'2016-02-14',recruiter:{kind:'academy'}})).response.status,201);
  for(const id of [guardian,f.actors.manager.person])assert.equal((await f.request('guardians',{personId:id,legalName:'Private legal guardian name',wechatId:'Private_handle'})).response.status,201);
  for(const role of [f.staffRole,f.managerRole])for(const cap of ['families.view','families.edit','guardians.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
  const input={guardianId:guardian,relationship:'parent',validFrom:'2027-01-01T00:00:00Z',validUntil:'2027-07-01T00:00:00Z',reason:'Private relationship review evidence note'};
  async function link(as='master',body:unknown=input,child=student,key?:string){return f.request('students/'+child+'/guardians',body,as,key?{key}:{});}
  return {...f,student,guardian,otherStudent,input,link,person};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('master family approval persists exact half-open periods, private revisions and identity status without granting student access',async f=>{
  const before=await f.request('me/access',undefined,'manager');assert.equal((await f.request('students/'+f.student,undefined,'manager')).response.status,403);
  const one=await f.link();assert.equal(one.response.status,201,JSON.stringify(one.body));const id=one.body.data.id;assert.equal(one.body.approval.selfApproved,true);
  assert.equal((await f.request('students/'+f.student+'/guardians?at=2027-01-01T00:00:00Z&state=approved')).body.data.length,1);
  assert.equal((await f.request('students/'+f.student+'/guardians?at=2027-07-01T00:00:00Z')).body.data.length,0);
  const list=await f.request('students/'+f.student+'/guardians');assert.equal(list.body.data[0].identity_verification_complete,false);assert.equal(list.body.data[0].email,undefined);
  assert.equal((await f.link('master',{...f.input,guardianId:f.actors.manager.person})).response.status,201);
  const verified=(await f.request('students/'+f.student+'/guardians')).body.data.find((r:{guardian_id:string})=>r.guardian_id===f.actors.manager.person);assert.equal(verified.identity_verification_complete,true);
  assert.deepEqual((await f.request('me/access',undefined,'manager')).body,before.body);assert.equal((await f.request('students/'+f.student,undefined,'manager')).response.status,403);
  const history=await f.request('family-relationships/'+id+'/history');assert.equal(history.body.data[0].reason,f.input.reason);assert.equal(history.body.data[0].approval_id,one.body.approval.id);
  assert.equal((await f.pg.query('SELECT * FROM public.role_assignments WHERE person_id=$1',[f.guardian])).rows.length,0);
});
check('non-master family changes wait for an upper human and self approval cannot apply the association',async f=>{
  const locksBefore=f.metrics.exclusivePolicyLocks;
  const pending=await f.link('staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.request('students/'+f.student+'/guardians')).body.data.length,0);
  assert.ok(f.metrics.exclusivePolicyLocks>locksBefore,'positive control: an authorized family request takes the policy lock');
  assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);
  const approved=await f.approve(pending.body.approval.id,'manager');assert.equal(approved.response.status,200,JSON.stringify(approved.body));assert.equal(approved.body.data.guardian_id,f.guardian);
  const view=await f.request('approvals/'+pending.body.approval.id,undefined,'manager');assert.equal(view.body.data.privacyCapability,'families.view');
  assert.ok(!JSON.stringify(view.body.data.reviewContext).includes('Private legal'));assert.ok(!JSON.stringify(view.body.data.reviewContext).includes('2016-02-14'));
});
check('approval list/detail/decision require domain privacy as well as approval scope and cannot downgrade immutable case privacy',async f=>{
  const pending=await f.link('staff');assert.equal(pending.response.status,202);const id=pending.body.approval.id;
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='families.view'",[f.managerRole]);
  const list=await f.request('approvals?status=pending',undefined,'manager');assert.equal(list.response.status,200);assert.ok(!list.body.data.some((r:{id:string})=>r.id===id));
  assert.equal((await f.request('approvals/'+id,undefined,'manager')).response.status,404);assert.equal((await f.approve(id,'manager')).response.status,404);
  assert.equal((await f.request('approvals/'+id,undefined,'staff')).response.status,200,'the authorized requester can view their submitted case');
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='families.view'",[f.staffRole]);
  assert.equal((await f.request('approvals/'+id,undefined,'staff')).response.status,404,'private data revocation also applies to the original requester');
  assert.ok(!(await f.request('approvals',undefined,'staff')).body.data.some((r:{id:string})=>r.id===id));
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'families.view','allow')",[f.a,f.staffRole]);
  await f.pg.exec('SET ROLE kavosh_runtime');
  try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query('UPDATE public.approval_requests SET privacy_capability=NULL WHERE id=$1',[id]),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'families.view','allow')",[f.a,f.managerRole]);
  assert.equal((await f.approve(id,'manager')).response.status,200);
});
check('a reviewer cannot approve their own guardian or student benefit, and that rejection leaves the case for a higher reviewer',async f=>{
  const pending=await f.link('staff',{...f.input,guardianId:f.actors.manager.person});assert.equal(pending.response.status,202);
  const before=f.metrics.exclusivePolicyLocks;
  let denied=await f.approve(pending.body.approval.id,'manager');assert.equal(denied.response.status,403);assert.equal(denied.body.error.code,'BENEFICIARY_REVIEW_FORBIDDEN');
  assert.equal(f.metrics.exclusivePolicyLocks,before,'a conflicted reviewer must be rejected before taking the school-wide policy lock');
  assert.equal((await f.request('approvals/'+pending.body.approval.id+'/decide',{expectedVersion:1,decision:'reject',reason:'Cannot independently review own case'},'manager')).response.status,403);
  assert.equal((await f.request('approvals/'+pending.body.approval.id)).body.data.status,'pending');assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
  assert.equal((await f.request('students',{personId:f.actors.manager.person,legalName:'Adult student reviewer',dateOfBirth:'1990-01-01',recruiter:{kind:'academy'}})).response.status,201);
  const ownStudent=await f.link('staff',f.input,f.actors.manager.person);assert.equal(ownStudent.response.status,202);
  denied=await f.approve(ownStudent.body.approval.id,'manager');assert.equal(denied.response.status,403);assert.equal((await f.approve(ownStudent.body.approval.id)).response.status,200);
});
check('retired private approval handlers retain consistent authorized list/detail history without enabling application',async f=>{
  const pending=await f.link('staff');assert.equal(pending.response.status,202);const id=pending.body.approval.id;
  // Represent an older action whose handler is no longer mounted. Its stored
  // privacy requirement remains authoritative and cannot be changed by runtime.
  await f.pg.query("UPDATE public.approval_requests SET action='retired.private-action',privacy_capability='students.view' WHERE id=$1",[id]);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'students.view','allow')",[f.a,f.managerRole]);
  assert.equal((await f.request('approvals/'+id,undefined,'manager')).response.status,200);
  assert.ok((await f.request('approvals?status=pending',undefined,'manager')).body.data.some((r:{id:string})=>r.id===id));
  const result=await f.approve(id,'manager');assert.equal(result.response.status,409);assert.equal(result.body.approval.decisionCode,'ACTION_UNAVAILABLE');
  assert.equal((await f.pg.query('SELECT * FROM public.family_relationships')).rows.length,0);
});
check('default family effective time uses the database clock and stays stable across an identical request retry',async f=>{
  const before=(await f.pg.query<{instant:Date|string}>('SELECT clock_timestamp() AS instant')).rows[0].instant,key=randomUUID();
  const body={...f.input,validFrom:null,validUntil:null},one=await f.link('master',body,f.student,key);assert.equal(one.response.status,201,JSON.stringify(one.body));
  const after=(await f.pg.query<{instant:Date|string}>('SELECT clock_timestamp() AS instant')).rows[0].instant;
  const millis=(v:Date|string)=>v instanceof Date?v.getTime():Date.parse(v),from=Date.parse(one.body.data.valid_from);
  assert.ok(from>=millis(before)&&from<=millis(after));assert.deepEqual((await f.link('master',body,f.student,key)).body,one.body);
});
check('human protective suspension is immediate, critical, reversible only through approval and safe to retry without reactivating on partial edits',async f=>{
  const linked=await f.link();assert.equal(linked.response.status,201);const id=linked.body.data.id,key=randomUUID(),why={expectedVersion:1,reason:'Private protective hold details'};
  const held=await f.request('family-relationships/'+id+'/suspend',why,'manager',{key});assert.equal(held.response.status,200);assert.equal(held.body.data.state,'suspended');
  assert.deepEqual((await f.request('family-relationships/'+id+'/suspend',why,'manager',{key})).body,held.body);
  const corrected=await f.request('family-relationships/'+id+'/change',{expectedVersion:2,relationship:'legal_guardian',reason:'Correct held relationship label'});assert.equal(corrected.response.status,200);assert.equal(corrected.body.data.state,'suspended');
  const resume=await f.request('family-relationships/'+id+'/change',{expectedVersion:3,state:'approved',reason:'Request verified review of reinstatement'},'staff');assert.equal(resume.response.status,202);
  assert.equal((await f.request('family-relationships/'+id)).body.data.state,'suspended');assert.equal((await f.approve(resume.body.approval.id,'manager')).response.status,200);
  const history=await f.request('family-relationships/'+id+'/history?afterVersion=1&limit=1');assert.equal(history.body.data[0].approval_id,null);assert.equal(history.body.data[0].definition.state,'suspended');assert.equal(history.body.nextVersion,2);
  const events=(await f.request('audit-events')).body.data.filter((e:{action:string})=>e.action.startsWith('family.relationship.'));
  assert.equal(events.filter((e:{action:string})=>e.action==='family.relationship.suspended').length,1);assert.ok(events.every((e:{changes:{severity:string}})=>e.changes.severity==='critical'));
  const audit=JSON.stringify(events);for(const value of [f.guardian,f.input.reason,why.reason,'Private legal guardian name'])assert.ok(!audit.includes(value));
});
check('family scope, self-link protection, date precision and field allowlists block hidden or malformed associations',async f=>{
  const before=f.metrics.exclusivePolicyLocks;
  assert.equal((await f.link('staff',f.input,f.otherStudent)).response.status,404);
  assert.equal(f.metrics.exclusivePolicyLocks,before,'a forbidden family request must not acquire the school-wide policy lock');
  assert.equal((await f.request('students/'+f.otherStudent+'/guardians',undefined,'staff')).response.status,404);
  assert.equal((await f.request('guardians',{personId:f.student,legalName:'Self-link candidate'})).response.status,201);
  const self=await f.link('master',{...f.input,guardianId:f.student});assert.equal(self.response.status,400);assert.equal(self.body.error.code,'SELF_GUARDIANSHIP_FORBIDDEN');
  for(const patch of [{guardianId:randomUUID()},{validFrom:'2027-01-01T00:00:00.000001Z'},{validFrom:'2027-01-01T00:00:00'},{validFrom:'0000-01-01T00:00:00Z'},{state:'approved'},{identity_verification_complete:true},{studentId:f.otherStudent}])
    assert.ok([400,404].includes((await f.link('master',{...f.input,...patch})).response.status),JSON.stringify(patch));
  assert.equal((await f.link('master',{...f.input,validUntil:f.input.validFrom})).response.status,409);
  assert.equal((await f.request('students/'+f.student+'/guardians?unknown=true')).response.status,400);
});
check('family period overlap is prevented natively, touching intervals work and conflicts in upper review become stale without partial history',async f=>{
  const one=await f.link();assert.equal(one.response.status,201);
  const duplicate=await f.link();assert.equal(duplicate.response.status,409);assert.equal(duplicate.body.error.code,'FAMILY_PERIOD_OVERLAP');
  const adjacent={...f.input,validFrom:f.input.validUntil,validUntil:'2027-12-31T00:00:00Z'};
  const pending=await f.link('staff',adjacent);assert.equal(pending.response.status,202);
  assert.equal((await f.link('master',adjacent)).response.status,201);
  const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.status,'stale');assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');
  assert.equal((await f.pg.query('SELECT * FROM public.family_relationships')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM public.family_relationship_revisions')).rows.length,2);
});
check('profile corrections and permission revocation invalidate unexecuted family proposals while protective holds invalidate old reinstatements',async f=>{
  let pending=await f.link('staff');assert.equal(pending.response.status,202);
  assert.equal((await f.request('guardians/'+f.guardian+'/update',{expectedVersion:1,legalName:'Corrected guardian legal name'})).response.status,200);
  let stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');
  pending=await f.link('staff');assert.equal(pending.response.status,202);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='families.edit'",[f.staffRole]);
  stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'AUTHORITY_CHANGED');
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'families.edit','allow')",[f.a,f.staffRole]);
  const linked=await f.link();const id=linked.body.data.id;
  pending=await f.request('family-relationships/'+id+'/change',{expectedVersion:1,relationship:'legal_guardian',reason:'Earlier requested change'},'staff');assert.equal(pending.response.status,202);
  const future=await f.link('staff',{...f.input,validFrom:f.input.validUntil,validUntil:'2027-12-31T00:00:00Z'});assert.equal(future.response.status,202);
  assert.equal((await f.request('family-relationships/'+id+'/suspend',{expectedVersion:1,reason:'Later protective hold'})).response.status,200);
  assert.equal((await f.approve(pending.body.approval.id)).response.status,409);assert.equal((await f.request('family-relationships/'+id)).body.data.state,'suspended');
  const staleFuture=await f.approve(future.body.approval.id);assert.equal(staleFuture.response.status,409);assert.equal(staleFuture.body.approval.decisionCode,'DEPENDENCIES_CHANGED','a later hold must invalidate previously queued new periods for the same pair');
});
check('management bots can propose family changes but cannot approve or apply human-only protective actions',async f=>{
  const pending=await f.link('bot');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.approve(pending.body.approval.id,'bot')).response.status,403);
  const approved=await f.approve(pending.body.approval.id,'manager');assert.equal(approved.response.status,200);
  assert.equal((await f.request('family-relationships/'+approved.body.data.id+'/suspend',{expectedVersion:1,reason:'Bot cannot apply this directly'},'bot')).response.status,403);
});
check('family retries and outbox failures preserve atomic associations, histories and approval decisions',async f=>{
  const key=randomUUID(),one=await f.link('master',f.input,f.student,key),two=await f.link('master',f.input,f.student,key);assert.equal(one.response.status,201);assert.deepEqual(two.body,one.body);
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');
  try{assert.equal((await f.request('family-relationships/'+one.body.data.id+'/suspend',{expectedVersion:1,reason:'Must roll back'})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.request('family-relationships/'+one.body.data.id)).body.data.state,'approved');assert.equal((await f.pg.query('SELECT * FROM public.family_relationship_revisions')).rows.length,1);
  const pending=await f.link('staff',{...f.input,guardianId:f.actors.manager.person});assert.equal(pending.response.status,202);
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');
  try{assert.equal((await f.approve(pending.body.approval.id)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.request('approvals/'+pending.body.approval.id)).body.data.status,'pending');assert.equal((await f.pg.query('SELECT * FROM public.family_relationships')).rows.length,1);
  assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
});
check('family rows retain tenant-composite references, immutable members/history and scoped metadata protection',async f=>{
  const linked=await f.link();assert.equal(linked.response.status,201);const id=linked.body.data.id;
  const before=f.metrics.exclusivePolicyLocks;
  assert.equal((await f.request('family-relationships/'+id+'/suspend',{expectedVersion:1,reason:'Wrong-scope suspension'},'peer')).response.status,404);
  assert.equal(f.metrics.exclusivePolicyLocks,before);
  const foreign=await f.request('people',{name:'Foreign candidate',hubId:f.foreignHub},'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,201);
  assert.equal((await f.request('guardians',{personId:foreign.body.data.id,legalName:'Foreign guardian'},'foreignMaster',{academy:f.b})).response.status,201);
  await assert.rejects(f.pg.query('UPDATE public.family_relationships SET guardian_id=$2 WHERE id=$1',[id,foreign.body.data.id]),/foreign key/i);
  await f.pg.exec('SET ROLE kavosh_runtime');
  try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.family_relationships')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.family_relationship_revisions')).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.query('UPDATE public.family_relationships SET guardian_id=$2 WHERE id=$1',[id,f.actors.manager.person]),/permission denied/i);
    await assert.rejects(f.pg.query("UPDATE public.family_relationship_revisions SET definition='{}' WHERE relationship_id=$1",[id]),/permission denied/i);
    await assert.rejects(f.pg.query('DELETE FROM public.family_relationships WHERE id=$1',[id]),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.request('family-relationships/'+id,undefined,'peer')).response.status,404);
});
if(process.env.TEST_DATABASE_URL) {
  check('concurrent family creates and corrections cannot overlap or lose revisions',async f=>{
    const created=await Promise.all([f.link(),f.link()]);assert.deepEqual(created.map(r=>r.response.status).sort(),[201,409]);
    const id=created.find(r=>r.response.status===201)!.body.data.id;
    const updates=await Promise.all(['legal_guardian','authorized_contact'].map(relationship=>f.request('family-relationships/'+id+'/change',{expectedVersion:1,relationship,reason:'Concurrent family correction'})));
    assert.deepEqual(updates.map(r=>r.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.family_relationship_revisions')).rows.length,2);
  });
}

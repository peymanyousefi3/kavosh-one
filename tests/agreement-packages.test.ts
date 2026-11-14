import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agreementFixture as fixture } from './agreement-fixture.ts';
import { agreementRequiresGuardian } from '../src/modules/agreement-packages.ts';

type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

test('agreement age guard uses the eighteenth civil birthday, rejects pre-birth dates and conservatively protects leap-day births',()=>{
 assert.equal(agreementRequiresGuardian('2008-11-04','2026-11-03'),true);assert.equal(agreementRequiresGuardian('2008-11-04','2026-11-04'),false);
 assert.equal(agreementRequiresGuardian('2008-02-29','2026-02-28'),true);assert.equal(agreementRequiresGuardian('2008-02-29','2026-03-01'),false);
 assert.throws(()=>agreementRequiresGuardian('2026-11-04','2026-11-03'),{code:'AGREEMENT_DATE_BEFORE_BIRTH'});
});
check('prepared package binds immutable source revisions, approved guardian and verified contact digest without clearing admission or sending',async f=>{
 const made=await f.prepare();assert.equal(made.response.status,201,JSON.stringify(made.body));assert.equal(made.body.data.state,'prepared');assert.equal(made.body.data.admissionCleared,false);
 const read=await f.request('agreement-packages/'+made.body.data.id);assert.equal(read.response.status,200);const p=read.body.data;
 assert.equal(p.enrollment_id,f.e.id);assert.equal(p.enrollment_version,1);assert.equal(p.student_id,f.student);assert.equal(p.student_profile_version,1);assert.equal(p.template_hash,f.t.definition_hash);
 assert.equal(p.signer_id,f.signer);assert.equal(p.guardian_profile_version,1);assert.equal(p.relationship_id,f.relationship.id);assert.equal(p.relationship_version,1);assert.equal(p.connection_id,f.connection);assert.match(p.contact_fingerprint,/^[a-f0-9]{64}$/);
 assert.equal((await f.pg.query('SELECT * FROM public.signature_webhook_inbox')).rows.length,0);
 const events=(await f.pg.query("SELECT changes FROM public.audit_events WHERE action='agreement.package.prepared'")).rows;assert.equal(events.length,1);assert.ok(!JSON.stringify(events).includes('PRIVATE'));
 assert.ok(!JSON.stringify(p).includes('@example.test'));assert.equal((await f.request('enrollments/'+f.e.id)).body.data.version,1);
});
check('non-master preparation needs upper approval, prevents self and beneficiary review and detects changed source versions',async f=>{
 const pending=await f.prepare(f.input,'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,0);
 assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);
 const approved=await f.approve(pending.body.approval.id,'manager');assert.equal(approved.response.status,200,JSON.stringify(approved.body));
 const stale=await f.prepare(f.input,'staff');assert.equal(stale.response.status,202);
 assert.equal((await f.request('guardians/'+f.signer+'/update',{expectedVersion:1,legalName:'PRIVATE corrected guardian'})).response.status,200);
 assert.equal((await f.approve(stale.body.approval.id,'manager')).response.status,409);
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,1);
});
check('minor self signing, unrelated/authorized-only, suspended and future/expired guardian links cannot prepare a package',async f=>{
 assert.equal((await f.prepare({...f.input,signerId:f.student,relationshipId:null})).body.error.code,'LEGAL_GUARDIAN_REQUIRED');
 assert.equal((await f.prepare({...f.input,relationshipId:randomUUID()})).body.error.code,'LEGAL_GUARDIAN_REQUIRED');
 for(const patch of ["relationship='authorized_contact'","state='suspended'","valid_from=now()+interval '1 day'","valid_until=now()-interval '1 second',valid_from=now()-interval '2 days'"]) {
  await f.pg.query('UPDATE public.family_relationships SET '+patch+' WHERE id=$1',[f.relationship.id]);
  const r=await f.prepare();assert.equal(r.response.status,409);assert.equal(r.body.error.code,'LEGAL_GUARDIAN_REQUIRED');
  await f.pg.query("UPDATE public.family_relationships SET relationship='legal_guardian',state='approved',valid_from=now()-interval '1 hour',valid_until=NULL WHERE id=$1",[f.relationship.id]);
 }
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,0);
});
check('both email and phone verification are required and revoked verification invalidates pending preparation',async f=>{
 for(const field of ['emailVerified','phoneNumberVerified']) {
  const pending=await f.prepare(f.input,'staff');assert.equal(pending.response.status,202);
  await f.pg.query('UPDATE identity."user" SET "'+field+'"=false WHERE id=$1',[f.actors.staff.user]);
  const r=await f.prepare();assert.equal(r.response.status,409);assert.equal(r.body.error.code,'VERIFIED_SIGNER_REQUIRED');
  const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.status,'stale');
  await f.pg.query('UPDATE identity."user" SET "'+field+'"=true WHERE id=$1',[f.actors.staff.user]);
 }
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,0);
});
check('adult student must sign for themselves and stale enrollment profile basis must be explicitly refreshed',async f=>{
 assert.equal((await f.request('students/'+f.student+'/update',{expectedVersion:1,dateOfBirth:'2000-03-20'})).response.status,200);
 assert.equal((await f.prepare()).body.error.code,'STUDENT_PROFILE_CHANGED');
 assert.equal((await f.request('enrollments/'+f.e.id+'/change',{expectedVersion:1,studentProfileVersion:2,reason:'Refresh corrected DOB basis'})).response.status,200);
 assert.equal((await f.prepare({...f.input,enrollmentVersion:2})).body.error.code,'ADULT_STUDENT_SIGNER_REQUIRED');
 const adult=await f.prepare({...f.input,enrollmentVersion:2,signerId:f.student,relationshipId:null});assert.equal(adult.response.status,201,JSON.stringify(adult.body));
 const p=(await f.request('agreement-packages/'+adult.body.data.id)).body.data;assert.equal(p.guardian_profile_version,null);assert.equal(p.relationship_id,null);assert.equal(p.student_profile_version,2);
});
check('package reads enforce every current source permission and school boundary, including after roles are revoked',async f=>{
 const made=await f.prepare();assert.equal(made.response.status,201);const path='agreement-packages/'+made.body.data.id;
 assert.equal((await f.request(path,undefined,'staff')).response.status,200);
 assert.equal((await f.request(path,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 for(const cap of ['signatures.view','enrollments.view','students.view','guardians.view','families.view','agreements.view']) {
  await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1 AND capability=$2',[f.staffRole,cap]);
  assert.ok([403,404].includes((await f.request(path,undefined,'staff')).response.status),cap);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);
 }
 await f.pg.query('UPDATE public.people SET hub_id=$1 WHERE id=$2',[f.otherHub,f.signer]);
 assert.equal((await f.request(path,undefined,'staff')).response.status,404);
});
check('connection, availability, locale, enabled enrollment and strict input guards prevent invented signing evidence',async f=>{
 for(const patch of [{signed:true},{admissionCleared:true},{contactFingerprint:'0'.repeat(64)},{locale:'de'},{providerDocumentId:randomUUID()},{relationshipVersion:1},{enrollmentVersion:99},{templateVersion:99},{connectionId:randomUUID()},{locale:'fr'}])assert.ok([400,409].includes((await f.prepare({...f.input,...patch})).response.status),JSON.stringify(patch));
 await f.pg.query('UPDATE public.signature_connections SET enabled=false WHERE id=$1',[f.connection]);assert.equal((await f.prepare()).body.error.code,'SIGNATURE_CONNECTION_UNAVAILABLE');
 await f.pg.query('UPDATE public.signature_connections SET enabled=true WHERE id=$1',[f.connection]);
 await f.pg.query('UPDATE public.agreement_templates SET available=false WHERE id=$1',[f.t.id]);assert.equal((await f.prepare()).body.error.code,'AGREEMENT_NOT_READY');
 await f.pg.query('UPDATE public.agreement_templates SET available=true WHERE id=$1',[f.t.id]);
 await f.pg.query('UPDATE public.class_enrollments SET enabled=false WHERE id=$1',[f.e.id]);assert.equal((await f.prepare()).body.error.code,'ACTIVE_ENROLLMENT_REQUIRED');
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,0);
});
check('package creation is transactional, immutable, tenant-bound and retry-safe without leaking reason into general audit',async f=>{
 const key=randomUUID(),made=await f.prepare(f.input,'master',key);assert.equal(made.response.status,201);assert.deepEqual((await f.prepare(f.input,'master',key)).body,made.body);
 assert.equal((await f.prepare({...f.input,reason:'Changed intent'},'master',key)).response.status,409);
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.prepare()).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,1);
 await f.pg.exec('SET ROLE kavosh_runtime');try {
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  await assert.rejects(f.pg.query('UPDATE public.agreement_packages SET signer_id=$1',[f.student]),/permission denied/i);
  await assert.rejects(f.pg.exec('DELETE FROM public.agreement_packages'),/permission denied/i);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,0);
  assert.equal((await f.pg.query('SELECT * FROM public.signer_verification_status($1)',[f.signer])).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.signature_connection_status($1)',[f.connection])).rows.length,0);
 }finally{await f.pg.exec('RESET ROLE');}
});
check('a guardian with supervisor rights cannot review their own beneficiary package, while bots can only propose',async f=>{
 const relation=await f.request('students/'+f.student+'/guardians',{guardianId:f.actors.manager.person,relationship:'parent',reason:'Another approved guardian'});assert.equal(relation.response.status,201);
 const pending=await f.prepare({...f.input,signerId:f.actors.manager.person,relationshipId:relation.body.data.id},'staff');assert.equal(pending.response.status,202);
 const beneficiary=await f.approve(pending.body.approval.id,'manager');assert.equal(beneficiary.response.status,403);assert.equal(beneficiary.body.error.code,'BENEFICIARY_REVIEW_FORBIDDEN');
 assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
 const bot=await f.prepare(f.input,'bot');assert.equal(bot.response.status,202,JSON.stringify(bot.body));assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
});
check('contact changes and registry disabling invalidate pending requests; historical receipts remain readable without clearing admission',async f=>{
 const made=await f.prepare();assert.equal(made.response.status,201);
 const pending=await f.prepare(f.input,'staff');assert.equal(pending.response.status,202);
 await f.pg.query('UPDATE identity."user" SET "phoneNumber"=$1 WHERE id=$2',['+16475559999',f.actors.staff.user]);
 assert.equal((await f.prepare(f.input,'staff')).response.status,401,'contact changes revoke the old human session');
 // Owner-only fixture models successful verification of the replacement phone.
 // Even though both flags are true again, old approval must pin the old contact.
 await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=true WHERE id=$1',[f.actors.staff.user]);
 const changed=await f.approve(pending.body.approval.id);assert.equal(changed.response.status,409);assert.equal(changed.body.approval.status,'stale');
 const next=await f.prepare(f.input,'bot');assert.equal(next.response.status,202,JSON.stringify(next.body));
 await f.pg.query('UPDATE public.signature_connections SET enabled=false WHERE id=$1',[f.connection]);
 const disabled=await f.approve(next.body.approval.id);assert.equal(disabled.response.status,409);assert.equal(disabled.body.approval.status,'stale');
 const historical=await f.request('agreement-packages/'+made.body.data.id);assert.equal(historical.response.status,200);assert.equal(historical.body.data.admissionCleared,false);
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,1);
});
check('provider regions and template hub ownership must match the selected enrollment',async f=>{
 const changed=await f.request('agreements/'+f.t.id+'/change',{expectedVersion:1,provider:{region:'EU',templateId:randomUUID()},reason:'Different provider region'});assert.equal(changed.response.status,200);
 assert.equal((await f.prepare({...f.input,templateVersion:2})).body.error.code,'SIGNATURE_CONNECTION_UNAVAILABLE');
 const other=await f.request('agreements',{hubId:f.otherHub,name:'Other hub agreement',legalEntityName:'Kavosh Al and Robotics Academy Inc.',countryCode:'CA',jurisdiction:'Ontario',languages:[{locale:'en',title:'Other',body:'Other contract'}],provider:{region:'CA',templateId:randomUUID()},available:true,reason:'Other hub'});assert.equal(other.response.status,201);
 assert.equal((await f.prepare({...f.input,templateId:other.body.data.id})).body.error.code,'AGREEMENT_HUB_MISMATCH');
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,0);
});
check('native package foreign keys independently bind enrollment parties, family parties and the exact immutable content hash',async f=>{
 const made=await f.prepare();assert.equal(made.response.status,201);const p=(await f.pg.query('SELECT * FROM public.agreement_packages WHERE id=$1',[made.body.data.id])).rows[0];
 for(const patch of [{student_id:f.actors.manager.person},{signer_id:f.actors.manager.person},{class_id:randomUUID()},{template_hash:'0'.repeat(64)},{academy_id:f.b}]) {
  const forged={...p,...patch,id:randomUUID()},columns=Object.keys(forged);
  await assert.rejects(f.pg.query('INSERT INTO public.agreement_packages('+columns.join(',')+') VALUES('+columns.map((_,i)=>'$'+(i+1)).join(',')+')',Object.values(forged)),/foreign key/i);
 }
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,1);
});
check('explicit selected-person signature denial protects both a prepared receipt and its private approval case',async f=>{
 const made=await f.prepare(),pending=await f.prepare(f.input,'staff');assert.equal(made.response.status,201);assert.equal(pending.response.status,202);
 const denied=await f.request('roles',{name:'Deny selected signature subject',permissions:[{capability:'signatures.view',effect:'deny'}]});assert.equal(denied.response.status,201);
 const access=await f.request('people/'+f.actors.manager.person+'/access');
 const changed=await f.request('people/'+f.actors.manager.person+'/access',{expectedVersion:access.body.data.version,assignments:[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]},{roleId:f.policyRole,allHubs:true},{roleId:denied.body.data.id,allHubs:false,personIds:[f.student]}]});assert.equal(changed.response.status,200,JSON.stringify(changed.body));
 assert.equal((await f.request('agreement-packages/'+made.body.data.id,undefined,'manager')).response.status,404);
 assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'manager')).response.status,404);
 assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,404);
});
if(process.env.TEST_DATABASE_URL)check('one hundred simultaneous preparation retries persist exactly one package, audit and event under the four-connection pool',async f=>{
 const key=randomUUID(),started=performance.now(),times:number[]=[];
 const results=await Promise.all(Array.from({length:100},async()=>{const start=performance.now();const r=await f.prepare(f.input,'master',key);times.push(performance.now()-start);return r;}));
 for(const r of results){assert.equal(r.response.status,201,JSON.stringify(r.body));assert.deepEqual(r.body,results[0].body);}
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,1);
 assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='agreement.package.prepared'")).rows.length,1);
 assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='agreement.package.prepared'")).rows.length,1);
 times.sort((a,b)=>a-b);console.log(JSON.stringify({workload:'agreement-package-same-intent',requests:100,pool:4,packages:1,p99Ms:Math.ceil(times[98]),elapsedMs:Math.ceil(performance.now()-started),liveProviderRequests:0}));
});
if(process.env.TEST_DATABASE_URL)check('a preparation genuinely waiting on the policy lock rechecks a committed guardian suspension before saving any package',async f=>{
 await f.pg.exec('BEGIN');let open=true;
 await f.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8))',[f.a]);
 const pending=f.prepare();
 try {
  let observed=false;
  for(let n=0;n<200;n++) {
   await f.pg.query('SELECT pg_stat_clear_snapshot()');
   const blocked=await f.pg.query<{n:number}>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
    AND pid<>pg_backend_pid() AND pg_backend_pid()=ANY(pg_blocking_pids(pid)) AND query LIKE '%hashtextextended($1,8)%'`);
   if(blocked.rows[0].n>0){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(observed,true,'prove a genuine policy wait, not a timing assumption');
  await f.pg.query("UPDATE public.family_relationships SET state='suspended',version=version+1 WHERE id=$1",[f.relationship.id]);
  await f.pg.exec('COMMIT');open=false;
  const result=await pending;assert.equal(result.response.status,409,JSON.stringify(result.body));assert.equal(result.body.error.code,'LEGAL_GUARDIAN_REQUIRED');
  assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,0);
  assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='agreement.package.prepared'")).rows.length,0);
 }finally{if(open)await f.pg.exec('ROLLBACK');await pending;}
});

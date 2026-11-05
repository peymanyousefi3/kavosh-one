import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { agreementFixture,reviewedAgreementContent } from './agreement-fixture.ts';
import { buildBoldSignSendRequest } from '../src/integrations/boldsign-send-request.ts';

async function fixture() {
 const f=await agreementFixture(),binding=await reviewedAgreementContent(f),prepared=await f.prepare();assert.equal(prepared.response.status,201,JSON.stringify(prepared.body));
 const packageId=prepared.body.data.id,path='agreement-packages/'+packageId+'/content',input={bindingId:binding.id,reason:'PRIVATE approve this exact reviewed content for this student'};
 const attach=(value:unknown=input,as='master',key?:string)=>f.request(path,value,as,key?{key}:{});
 return {...f,binding,packageId,attachmentPath:path,attachmentInput:input,attach};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>,nativeOnly=false){test(name,{skip:nativeOnly&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('a prepared package gains one immutable exact reviewed content link without sending, signing or clearing admission',async f=>{
 const unbound=await f.request('agreement-packages/'+f.packageId);assert.equal(unbound.body.data.contentAttached,false);assert.equal(unbound.body.data.contentAttachmentId,null);
 const started=performance.now(),queries=f.metrics.businessQueries,made=await f.attach();assert.equal(made.response.status,201,JSON.stringify(made.body));
 console.log(JSON.stringify({case:'attach-reviewed-content',elapsedMs:Math.round(performance.now()-started),clientQueries:f.metrics.businessQueries-queries}));
 const detail=await f.request(f.attachmentPath);assert.equal(detail.response.status,200);assert.equal(detail.body.data.source.sha256,f.binding.sha256);assert.deepEqual(detail.body.data.routing,f.binding.routing);
 assert.equal(detail.body.data.recordedSourceCurrent,true);assert.equal(detail.body.data.recordedPackageSourcesCurrent,true);assert.equal(detail.body.data.readyToSend,false);assert.equal(detail.body.data.admissionCleared,false);
 const parent=await f.request('agreement-packages/'+f.packageId);assert.equal(parent.body.data.contentAttached,true);assert.equal(parent.body.data.contentAttachmentId,made.body.data.id);assert.equal(parent.body.data.readyToSend,false);
 assert.equal((await f.pg.query('SELECT * FROM public.signature_webhook_inbox')).rows.length,0);const audit=(await f.pg.query("SELECT changes FROM public.audit_events WHERE action='agreement.content.attach'")).rows;assert.equal(audit.length,1);assert.ok(!JSON.stringify(audit).includes('PRIVATE'));
});
check('offline provider request uses the actual persisted approved link and exact fixture bytes without claiming a production identity resolver',async f=>{
 const made=await f.attach();assert.equal(made.response.status,201);const link=(await f.request(f.attachmentPath)).body.data,p=(await f.request('agreement-packages/'+f.packageId)).body.data;
 // Fixture-owner identity access is NOT a production worker permission grant.
 const signer=(await f.pg.query('SELECT u.email,u."phoneNumber" AS phone,u."emailVerified" AS email_verified,u."phoneNumberVerified" AS phone_verified,g.legal_name FROM identity."user" u JOIN public.people person ON person.auth_user_id=u.id JOIN public.guardian_profiles g ON g.academy_id=person.academy_id AND g.person_id=person.id WHERE person.id=$1',[f.signer])).rows[0];
 const request=buildBoldSignSendRequest({packageId:p.id,attachmentId:link.id,bindingId:link.binding_id,title:'PRIVATE Unified agreement',message:'PRIVATE Review all terms',locale:p.locale,expiryDays:30,document:{sha256:link.source.sha256,sizeBytes:link.source.sizeBytes},routing:link.routing,
  signer:{personId:p.signer_id,legalName:signer.legal_name,email:signer.email,phoneE164:signer.phone,emailVerified:signer.email_verified,phoneVerified:signer.phone_verified,contactFingerprint:p.contact_fingerprint}},f.binding.bytes);
 const body=JSON.parse(request.body);assert.deepEqual(Buffer.from(body.Files[0].split(',')[1],'base64'),f.binding.bytes);assert.equal(request.receipt.attachmentId,link.id);assert.equal(request.receipt.documentSha256,link.source.sha256);assert.equal(body.Signers[0].EmailAddress,signer.email);
 assert.equal((await f.pg.query('SELECT * FROM public.signature_webhook_inbox')).rows.length,0);assert.equal((await f.request(f.attachmentPath)).body.data.readyToSend,false);
});
check('content attachment requires upper human review, excludes beneficiaries and permits only bot proposals',async f=>{
 const pending=await f.attach(f.attachmentInput,'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.pg.query('SELECT * FROM public.agreement_package_contents')).rows.length,0);
 assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);
 const relation=await f.request('students/'+f.student+'/guardians',{guardianId:f.actors.manager.person,relationship:'parent',reason:'PRIVATE another guardian'});assert.equal(relation.response.status,201);
 const forbidden=await f.approve(pending.body.approval.id,'manager');assert.equal(forbidden.response.status,403,JSON.stringify(forbidden.body));assert.equal(forbidden.body.error.code,'BENEFICIARY_REVIEW_FORBIDDEN');
 assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
 const audience=(await f.pg.query<{person_id:string}>("SELECT n.person_id FROM public.portal_notifications n JOIN public.automation_event_sources s ON s.academy_id=n.academy_id AND s.event_id=n.event_id WHERE s.approval_id=$1 AND s.event_type='approval.applied' AND n.origin='mandatory'",[pending.body.approval.id])).rows.map(n=>n.person_id).sort();assert.deepEqual(audience,[f.actors.master.person,f.actors.manager.person,f.actors.staff.person].sort());
 const next=await f.prepare();assert.equal(next.response.status,201);const bot=await f.request('agreement-packages/'+next.body.data.id+'/content',f.attachmentInput,'bot');assert.equal(bot.response.status,202,JSON.stringify(bot.body));
 assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
});
check('attachment retries are exact and failed saves roll back approval, link, audit, event and critical notices',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.approval_requests) approvals,(SELECT count(*)::int FROM public.agreement_package_contents) links,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events,(SELECT count(*)::int FROM public.portal_notifications) notices')).rows[0];
 const key=randomUUID(),before=await counts();await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');
 try{assert.equal((await f.attach(f.attachmentInput,'master',key)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.deepEqual(await counts(),before);const made=await f.attach(f.attachmentInput,'master',key);assert.equal(made.response.status,201,JSON.stringify(made.body));assert.deepEqual((await f.attach(f.attachmentInput,'master',key)).body,made.body);
 assert.equal((await f.attach({...f.attachmentInput,reason:'Different intent'},'master',key)).response.status,409);assert.equal((await f.attach()).body.error.code,'PACKAGE_CONTENT_ALREADY_ATTACHED');
});
check('mismatched agreement content and strict request fields cannot be used to invent a signed package',async f=>{
 const other=await f.request('agreements',{hubId:f.hub,name:'Other agreement',legalEntityName:'Kavosh Al and Robotics Academy Inc.',countryCode:'CA',jurisdiction:'Ontario',languages:[{locale:'en',title:'Other',body:'PRIVATE other agreement'}],provider:{region:'CA',templateId:randomUUID()},available:true,reason:'Different source'});assert.equal(other.response.status,201);
 const unrelated=await reviewedAgreementContent(f,other.body.data.id);assert.equal((await f.attach({...f.attachmentInput,bindingId:unrelated.id})).body.error.code,'PACKAGE_CONTENT_MISMATCH');
 for(const patch of [{signed:true},{readyToSend:true},{admissionCleared:true},{packageId:randomUUID()},{reason:'\0'}])assert.equal((await f.attach({...f.attachmentInput,...patch})).response.status,400);
 assert.equal((await f.attach({...f.attachmentInput,bindingId:randomUUID()})).response.status,404);
 assert.equal((await f.request(f.attachmentPath,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 assert.equal((await f.request(f.attachmentPath+'?extra=1',f.attachmentInput)).response.status,400);assert.equal((await f.request(f.attachmentPath,undefined,'master',{method:'DELETE'})).response.status,405);
});
check('current file and every party/source permission protect both parent and content history and private approval cases',async f=>{
 assert.equal((await f.attach()).response.status,201);const next=await f.prepare(),pending=await f.request('agreement-packages/'+next.body.data.id+'/content',f.attachmentInput,'staff');assert.equal(pending.response.status,202);
 for(const cap of ['files.view','agreements.view','signatures.view','enrollments.view','students.view','guardians.view','families.view']) {
  await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1 AND capability=$2',[f.staffRole,cap]);
  for(const path of [f.attachmentPath,'agreement-packages/'+f.packageId,'approvals/'+pending.body.approval.id])assert.ok([403,404].includes((await f.request(path,undefined,'staff')).response.status),cap+' '+path);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);
 }
 await f.pg.query('UPDATE public.people SET hub_id=$1 WHERE id=$2',[f.otherHub,f.student]);
 assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'manager')).response.status,404);assert.equal((await f.request(f.attachmentPath,undefined,'manager')).response.status,404);
});
for(const [name,change] of [
 ['enrollment',async(f:Fixture)=>{assert.equal((await f.request('enrollments/'+f.e.id+'/change',{expectedVersion:1,joinsOn:'2027-01-02',reason:'PRIVATE changed membership'})).response.status,200);}],
 ['guardian authority',async(f:Fixture)=>{await f.pg.query("UPDATE public.family_relationships SET state='suspended',version=version+1 WHERE id=$1",[f.relationship.id]);}],
 ['verified signer',async(f:Fixture)=>{await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id=$1',[f.actors.staff.user]);}],
 ['PDF metadata',async(f:Fixture)=>{assert.equal((await f.request('files/'+f.binding.fileId+'/change',{expectedVersion:1,archived:true})).response.status,200);}],
 ['provider connection',async(f:Fixture)=>{await f.pg.query('UPDATE public.signature_connections SET enabled=false WHERE id=$1',[f.connection]);}]
] as const)check('changed '+name+' invalidates pending content attachment without silently substituting a source',async f=>{
 const pending=await f.attach(f.attachmentInput,'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));await change(f);
 const decided=await f.approve(pending.body.approval.id);assert.equal(decided.response.status,409,JSON.stringify(decided.body));assert.equal(decided.body.approval.status,'stale');assert.equal((await f.pg.query('SELECT * FROM public.agreement_package_contents')).rows.length,0);
});
check('historical linked content remains immutable while current package-source checks detect later membership changes',async f=>{
 assert.equal((await f.attach()).response.status,201);const original=(await f.request(f.attachmentPath)).body.data;
 assert.equal((await f.request('enrollments/'+f.e.id+'/change',{expectedVersion:1,joinsOn:'2027-01-02',reason:'PRIVATE later membership'})).response.status,200);
 const detail=await f.request(f.attachmentPath);assert.equal(detail.response.status,200);assert.equal(detail.body.data.recordedSourceCurrent,true);assert.equal(detail.body.data.recordedPackageSourcesCurrent,false);assert.deepEqual(detail.body.data.source,original.source);assert.deepEqual(detail.body.data.routing,original.routing);assert.equal(detail.body.data.readyToSend,false);
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.exec("UPDATE public.agreement_package_contents SET reason='forged'"),/permission denied/i);await assert.rejects(f.pg.exec('DELETE FROM public.agreement_package_contents'),/permission denied/i);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.agreement_package_contents')).rows.length,0);}finally{await f.pg.exec('RESET ROLE');}
});
check('native package-content guards reject missing human review and stale signer verification independently of the API',async f=>{
 const pending=await f.attach(f.attachmentInput,'staff');assert.equal(pending.response.status,202);
 const p=(await f.pg.query<{id:string;target_id:string}>('SELECT id,target_id FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows[0];
 const insert='INSERT INTO public.agreement_package_contents(academy_id,id,package_id,binding_id,approval_id,created_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',args=[f.a,p.target_id,f.packageId,f.binding.id,p.id,f.actors.manager.person,f.attachmentInput.reason];
 const attempt=async(expected:RegExp,values=args)=>{await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query(insert,values),expected);}finally{await f.pg.exec('RESET ROLE');}};
 await attempt(/REVIEWED_APPROVAL_NOT_APPLIED/);await attempt(/PACKAGE_CONTENT_EXACT_APPROVAL_REQUIRED/,args.map((v,n)=>n===5?f.bot:v));
 await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id=$1',[f.actors.staff.user]);await attempt(/PACKAGE_CONTENT_EXACT_APPROVAL_REQUIRED/);
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_package_contents')).rows.length,0);
});
check('an actual signer change during INSERT is caught by the native guard and rolls back all effects before an exact-key retry',async f=>{
 const before=(await f.pg.query('SELECT(SELECT count(*)::int FROM public.approval_requests) approvals,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events,(SELECT count(*)::int FROM public.portal_notifications) notices')).rows[0],key=randomUUID();
 // Test-owned disposable database only: change the actual identity row AFTER
 // application dependency reads, BEFORE the real persistence guard executes.
 await f.pg.exec(`CREATE FUNCTION public.synthetic_signer_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id='${f.actors.staff.user}';RETURN NEW;END $$;CREATE TRIGGER aa_synthetic_signer_change BEFORE INSERT ON public.agreement_package_contents FOR EACH ROW EXECUTE FUNCTION public.synthetic_signer_change()`);
 try{const blocked=await f.attach(f.attachmentInput,'master',key);assert.equal(blocked.response.status,409,JSON.stringify(blocked.body));assert.equal(blocked.body.error.code,'PACKAGE_CONTENT_SOURCES_CHANGED');}
 finally{await f.pg.exec('DROP TRIGGER aa_synthetic_signer_change ON public.agreement_package_contents;DROP FUNCTION public.synthetic_signer_change()');}
 assert.equal((await f.pg.query('SELECT "phoneNumberVerified" AS verified FROM identity."user" WHERE id=$1',[f.actors.staff.user])).rows[0].verified,true);
 assert.deepEqual((await f.pg.query('SELECT(SELECT count(*)::int FROM public.approval_requests) approvals,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events,(SELECT count(*)::int FROM public.portal_notifications) notices')).rows[0],before);
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_package_contents')).rows.length,0);assert.equal((await f.attach(f.attachmentInput,'master',key)).response.status,201);
});
check('a civil-day rollover alone does not replace reviewed content but the native eighteenth-birthday guard still protects a guardian package',async f=>{
 // Owner-only fixture models yesterday's preparation; production has no clock
 // override or timestamp-edit endpoint. Keep the immutable source facts fixed.
 await f.pg.query('UPDATE public.agreement_packages SET prepared_on=prepared_on-1 WHERE id=$1',[f.packageId]);
 await f.pg.query("UPDATE public.approval_requests q SET review_context=jsonb_set(q.review_context,'{preparedOn}',to_jsonb(p.prepared_on::text)) FROM public.agreement_packages p WHERE p.approval_id=q.id AND p.id=$1",[f.packageId]);
 assert.equal((await f.attach()).response.status,201);
 await f.pg.query("UPDATE public.student_profiles SET date_of_birth=((clock_timestamp() AT TIME ZONE 'America/Toronto')::date-interval '18 years')::date WHERE person_id=$1",[f.student]);
 const read=await f.request(f.attachmentPath);assert.equal(read.response.status,200);assert.equal(read.body.data.recordedPackageSourcesCurrent,false);assert.equal(read.body.data.readyToSend,false);
});
check('two competing content-link requests keep exactly one approved attachment',async f=>{
 const key=randomUUID(),start=performance.now(),same=await Promise.all([f.attach(f.attachmentInput,'master',key),f.attach(f.attachmentInput,'master',key)]);
 assert.equal(same[0].response.status,201);assert.deepEqual(same[1].body,same[0].body);assert.equal((await f.pg.query('SELECT * FROM public.agreement_package_contents')).rows.length,1);
 const next=await f.prepare(),path='agreement-packages/'+next.body.data.id+'/content',competing=await Promise.all([f.request(path,f.attachmentInput),f.request(path,f.attachmentInput)]);
 assert.deepEqual(competing.map(r=>r.response.status).sort(),[201,409]);assert.equal((await f.pg.query('SELECT * FROM public.agreement_package_contents')).rows.length,2);
 console.log(JSON.stringify({case:'two-content-link-races',elapsedMs:Math.round(performance.now()-start),sameKeyReceipts:1,differentKeyWinner:1}));
},true);
test('schema70 preserves a real schema69 prepared package without inventing a content link',async()=>{
 const f=await agreementFixture(69);try{
  const prepared=await f.prepare();assert.equal(prepared.response.status,201);const id=prepared.body.data.id,old=(await f.pg.query('SELECT * FROM public.agreement_packages WHERE id=$1',[id])).rows[0];
  await f.pg.exec(await readFile(new URL('../db/migrations/070_agreement_package_contents.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/071_signature_send_requests.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/072_session_attendance.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/073_session_reports.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/074_report_publications.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/075_assessment_rubrics.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/076_student_feedback.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/077_homeworks.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/078_homework_submissions.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/079_homework_grades.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/080_homework_solutions.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/081_report_comments.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/082_polls.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/083_poll_responses.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/084_poll_results.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/085_poll_response_moderation.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/086_poll_templates.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/087_poll_template_use.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/088_session_evidence_reviews.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/089_session_staff_feedback.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/090_receivables_aging.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/091_payables_aging.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/092_expense_commitments.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/093_commitment_bill_links.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/094_financial_outlook.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/095_pay_periods.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/096_payroll_preparations.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/097_payroll_adjustments.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/098_hourly_accruals.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/099_hourly_release_dates.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/100_salary_earning_basis.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/101_salary_accruals.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/102_project_accruals.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/103_attendance_payroll_basis.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/104_tuition_course_accruals.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/105_tuition_session_allocations.sql',import.meta.url),'utf8'));
  await f.pg.exec(await readFile(new URL('../db/migrations/106_tuition_session_accruals.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.pg.query('SELECT * FROM public.agreement_packages WHERE id=$1',[id])).rows[0],old);assert.equal((await f.pg.query('SELECT * FROM public.agreement_package_contents')).rows.length,0);
  const unbound=await f.request('agreement-packages/'+id);assert.equal(unbound.response.status,200);assert.equal(unbound.body.data.contentAttached,false);assert.equal(unbound.body.data.readyToSend,false);
  const binding=await reviewedAgreementContent(f);assert.equal((await f.request('agreement-packages/'+id+'/content',{bindingId:binding.id,reason:'Explicitly review historical preparation content'})).response.status,201);
 }finally{await f.pg.close();}
});

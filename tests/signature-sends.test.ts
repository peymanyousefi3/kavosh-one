import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agreementFixture,reviewedAgreementContent } from './agreement-fixture.ts';

async function fixture(){
 const f=await agreementFixture();
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['signature-sends.view','signature-sends.edit','signature-sends.execute'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const binding=await reviewedAgreementContent(f),prepared=await f.prepare();assert.equal(prepared.response.status,201);const packageId=prepared.body.data.id;
 const attached=await f.request('agreement-packages/'+packageId+'/content',{bindingId:binding.id,reason:'PRIVATE exact source for send request'});assert.equal(attached.response.status,201,JSON.stringify(attached.body));
 const path='agreement-packages/'+packageId+'/send-requests',input={attachmentId:attached.body.data.id,options:{title:'PRIVATE Unified contract',message:'PRIVATE Review complete terms',expiryDays:30},dispatchWithinMinutes:60,reason:'PRIVATE request review'};
 const request=(value:unknown=input,as='master',key?:string)=>f.request(path,value,as,key?{key}:{});
 const cancel=(id:string,as='master',key?:string)=>f.request('signature-send-requests/'+id+'/cancel',{reason:'PRIVATE stop before transport'},as,key?{key}:{});
 // Attested synthetic wire hash: not a real outbound request or delivery proof.
 const manifest={requestSha256:'a'.repeat(64),requestBytes:1234,documentSha256:binding.sha256};
 const reserve=(id:string,as='master',key?:string,value:unknown=manifest)=>f.request('signature-send-requests/'+id+'/attempts',value,as,key?{key}:{});
 return {...f,binding,packageId,attachmentId:attached.body.data.id,sendPath:path,sendInput:input,send:request,cancel,reserve,manifest};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>,nativeOnly=false){test(name,{skip:nativeOnly&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('approved signing intention freezes source/options and server expiry without sending or clearing admission',async f=>{
 const started=performance.now(),queries=f.metrics.businessQueries,made=await f.send();assert.equal(made.response.status,201,JSON.stringify(made.body));console.log(JSON.stringify({case:'approve-signing-intention',elapsedMs:Math.round(performance.now()-started),clientQueries:f.metrics.businessQueries-queries}));
 const r=await f.request('signature-send-requests/'+made.body.data.id);assert.equal(r.response.status,200);assert.equal(r.body.data.state,'approved');assert.deepEqual(r.body.data.options,f.sendInput.options);assert.equal(r.body.data.recordedSourcesCurrent,true);assert.equal(r.body.data.readyToSend,false);assert.equal(r.body.data.deliveryVerified,false);assert.equal(r.body.data.admissionCleared,false);
 assert.equal(r.body.data.context.source.packageContent.content.source.sha256,f.binding.sha256);
 const dates=(await f.pg.query('SELECT extract(epoch FROM(authorization_until-created_at))::int seconds FROM public.signature_send_requests WHERE id=$1',[made.body.data.id])).rows[0];assert.equal(dates.seconds,3600);
 const list=await f.request(f.sendPath);assert.equal(list.body.data.length,1);assert.equal('options' in list.body.data[0],false);assert.equal('context' in list.body.data[0],false);
 assert.equal((await f.pg.query('SELECT * FROM public.signature_send_attempts')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.signature_webhook_inbox')).rows.length,0);
 const audit=(await f.pg.query("SELECT changes FROM public.audit_events WHERE action='signature.send.request'")).rows;assert.equal(audit.length,1);assert.ok(!JSON.stringify(audit).includes('PRIVATE'));
});
check('non-master send and cancellation require upper human review; bots only propose while master self-approves',async f=>{
 const pending=await f.send(f.sendInput,'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.pg.query('SELECT * FROM public.signature_send_requests')).rows.length,0);
 assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);const approved=await f.approve(pending.body.approval.id,'manager');assert.equal(approved.response.status,200,JSON.stringify(approved.body));
 const id=approved.body.data.id,stop=await f.cancel(id,'bot');assert.equal(stop.response.status,202,JSON.stringify(stop.body));assert.equal((await f.approve(stop.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(stop.body.approval.id)).response.status,200);
 const audience=(await f.pg.query<{person_id:string}>("SELECT n.person_id FROM public.portal_notifications n JOIN public.automation_event_sources s ON s.academy_id=n.academy_id AND s.event_id=n.event_id WHERE s.approval_id=$1 AND s.event_type='approval.applied' AND n.origin='mandatory'",[pending.body.approval.id])).rows.map(n=>n.person_id).sort();assert.deepEqual(audience,[f.actors.master.person,f.actors.manager.person,f.actors.staff.person].sort());
});
check('cancellation and an explicit successor preserve one immutable request chain and prevent an implicit duplicate',async f=>{
 const made=await f.send();assert.equal(made.response.status,201);assert.equal((await f.send()).response.status,409);
 const key=randomUUID(),stopped=await f.cancel(made.body.data.id,'master',key);assert.equal(stopped.response.status,201,JSON.stringify(stopped.body));assert.deepEqual((await f.cancel(made.body.data.id,'master',key)).body,stopped.body);
 const next=await f.send({...f.sendInput,priorId:made.body.data.id,options:{...f.sendInput.options,message:'PRIVATE new explicitly reviewed request'}});assert.equal(next.response.status,201,JSON.stringify(next.body));
 assert.equal((await f.request('signature-send-requests/'+made.body.data.id)).body.data.state,'superseded');assert.equal((await f.request('signature-send-requests/'+next.body.data.id)).body.data.state,'approved');
 assert.equal((await f.send({...f.sendInput,priorId:made.body.data.id})).response.status,409);assert.equal((await f.pg.query('SELECT * FROM public.signature_send_requests')).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM public.signature_send_cancellations')).rows.length,1);
});
check('one attested attempt is reserved without transport; it cannot be replayed as another attempt or locally cancelled',async f=>{
 const made=await f.send();assert.equal(made.response.status,201);const id=made.body.data.id,key=randomUUID(),reserved=await f.reserve(id,'bot',key);assert.equal(reserved.response.status,201,JSON.stringify(reserved.body));
 assert.equal(reserved.body.data.externalRequestMade,false);assert.equal(reserved.body.data.deliveryVerified,false);assert.equal(reserved.body.data.admissionCleared,false);assert.deepEqual((await f.reserve(id,'bot',key)).body,reserved.body);
 assert.equal((await f.reserve(id)).body.error.code,'SIGNATURE_ATTEMPT_ALREADY_RESERVED');assert.equal((await f.cancel(id)).body.error.code,'SIGNATURE_SEND_CANNOT_CANCEL');
 assert.equal((await f.request('signature-send-requests/'+id)).body.data.state,'attempt_reserved');const read=await f.request('signature-send-requests/'+id+'/attempts');assert.equal(read.body.data.length,1);assert.equal(read.body.data[0].request_sha256,f.manifest.requestSha256);assert.equal(read.body.deliveryVerified,false);
});
check('request and attempt failures roll back their complete audit/outbox/approval/notification effects and permit exact-key retry',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.approval_requests) approvals,(SELECT count(*)::int FROM public.signature_send_requests) requests,(SELECT count(*)::int FROM public.signature_send_attempts) attempts,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events,(SELECT count(*)::int FROM public.portal_notifications) notices')).rows[0];
 const key=randomUUID(),before=await counts();await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.send(f.sendInput,'master',key)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}assert.deepEqual(await counts(),before);
 const made=await f.send(f.sendInput,'master',key);assert.equal(made.response.status,201);assert.deepEqual((await f.send(f.sendInput,'master',key)).body,made.body);assert.equal((await f.send({...f.sendInput,reason:'Different intent'},'master',key)).response.status,409);
 const attemptKey=randomUUID(),beforeAttempt=await counts();assert.equal((await f.reserve(made.body.data.id,'master',attemptKey,{...f.manifest,documentSha256:'0'.repeat(64)})).response.status,409);assert.deepEqual(await counts(),beforeAttempt);
 assert.equal((await f.reserve(made.body.data.id,'master',attemptKey)).response.status,201);
});
check('current private source and new feature permissions protect request detail, directories, attempt metadata and pending approvals',async f=>{
 const made=await f.send();assert.equal(made.response.status,201);const id=made.body.data.id;assert.equal((await f.reserve(id)).response.status,201);
 const stopped=await f.prepare();assert.equal(stopped.response.status,201);const linked=await f.request('agreement-packages/'+stopped.body.data.id+'/content',{bindingId:f.binding.id,reason:'PRIVATE second reviewed package'});assert.equal(linked.response.status,201);
 const pending=await f.request('agreement-packages/'+stopped.body.data.id+'/send-requests',{...f.sendInput,attachmentId:linked.body.data.id},'staff');assert.equal(pending.response.status,202);
 for(const cap of ['signature-sends.view','files.view','agreements.view','signatures.view','enrollments.view','students.view','guardians.view','families.view']) {
  await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1 AND capability=$2',[f.staffRole,cap]);
  for(const path of ['signature-send-requests/'+id,'signature-send-requests/'+id+'/attempts',f.sendPath,'approvals/'+pending.body.approval.id])assert.ok([403,404].includes((await f.request(path,undefined,'staff')).response.status),cap+' '+path);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);
 }
 assert.equal((await f.request('signature-send-requests/'+id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='signature-sends.execute'",[f.managerRole]);
 assert.equal((await f.reserve(id,'bot')).response.status,404,'current execution grant must be required even on a replay-looking request');
});
check('an expired intention cannot reserve an attempt but may be cancelled even after its class retires',async f=>{
 const made=await f.send();assert.equal(made.response.status,201);const id=made.body.data.id;
 // Fixture owner models passage of the authorization window; no production
 // timestamp edit or clock override exists, and the native interval stays exact.
 await f.pg.query("UPDATE public.signature_send_requests SET created_at=transaction_timestamp()-interval '2 hours',authorization_until=transaction_timestamp()-interval '1 hour' WHERE id=$1",[id]);
 assert.equal((await f.request('signature-send-requests/'+id)).body.data.state,'expired');assert.equal((await f.reserve(id)).body.error.code,'SIGNATURE_SEND_NOT_CURRENT');
 await f.pg.query('UPDATE public.classes SET active=false WHERE id=$1',[f.c.id]);const stop=await f.cancel(id);assert.equal(stop.response.status,201,JSON.stringify(stop.body));
 assert.equal((await f.request('signature-send-requests/'+id)).body.data.state,'cancelled');
});
check('changed PDF source invalidates a pending request and restoring the file does not silently renew content approval',async f=>{
 const pending=await f.send(f.sendInput,'staff');assert.equal(pending.response.status,202);await f.request('files/'+f.binding.fileId+'/change',{expectedVersion:1,archived:true});
 const decision=await f.approve(pending.body.approval.id);assert.equal(decision.response.status,409);assert.equal(decision.body.approval.status,'stale');assert.equal((await f.pg.query('SELECT * FROM public.signature_send_requests')).rows.length,0);
 await f.request('files/'+f.binding.fileId+'/change',{expectedVersion:2,archived:false});
 // A new metadata revision needs new content approval, not silent substitution.
 assert.equal((await f.send()).response.status,409);
});
check('a pending cancellation cannot claim success after a reserved attempt and still preserves its rejected review history',async f=>{
 const made=await f.send();assert.equal(made.response.status,201);const id=made.body.data.id,stop=await f.cancel(id,'staff');assert.equal(stop.response.status,202);
 assert.equal((await f.reserve(id)).response.status,201);const decided=await f.approve(stop.body.approval.id);assert.equal(decided.response.status,409);assert.equal(decided.body.approval.status,'stale');assert.equal((await f.pg.query('SELECT * FROM public.signature_send_cancellations')).rows.length,0);
});
check('native request and attempt records are append-only, tenant-bound and cannot invent a reviewed intention or manifest audit',async f=>{
 const pending=await f.send(f.sendInput,'staff');assert.equal(pending.response.status,202);const p=(await f.pg.query<{id:string;target_id:string;review_context:unknown}>('SELECT id,target_id,review_context FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows[0];
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  await assert.rejects(f.pg.query('INSERT INTO public.signature_send_requests(academy_id,id,package_id,attachment_id,options,dispatch_within_minutes,context,created_by,approval_id,reason) VALUES($1,$2,$3,$4,$5::jsonb,60,$6::jsonb,$7,$8,$9)',[f.a,p.target_id,f.packageId,f.attachmentId,JSON.stringify(f.sendInput.options),JSON.stringify(p.review_context),f.actors.manager.person,p.id,f.sendInput.reason]),/REVIEWED_APPROVAL_NOT_APPLIED/);
 }finally{await f.pg.exec('RESET ROLE');}
 const made=await f.approve(p.id);assert.equal(made.response.status,200);const id=made.body.data.id;
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  await assert.rejects(f.pg.query('INSERT INTO public.signature_send_attempts(academy_id,id,request_id,actor_id,audit_id,request_sha256,request_bytes,document_sha256) VALUES($1,$2,$3,$4,$5,$6,1234,$7)',[f.a,randomUUID(),id,f.actors.master.person,randomUUID(),f.manifest.requestSha256,f.binding.sha256]),/SIGNATURE_SEND_ATTEMPT_INVALID/);
  for(const table of ['signature_send_requests','signature_send_cancellations','signature_send_attempts']){await assert.rejects(f.pg.exec('DELETE FROM public.'+table),/permission denied/i);await assert.rejects(f.pg.exec('UPDATE public.'+table+' SET created_at=now()'),/permission denied/i);}
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.signature_send_requests')).rows.length,0);
 }finally{await f.pg.exec('RESET ROLE');}
});
check('a real signer change after attempt authorization is caught at INSERT and rolls back before exact-key retry',async f=>{
 const made=await f.send();assert.equal(made.response.status,201);const id=made.body.data.id,key=randomUUID();
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.signature_send_attempts) attempts,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events')).rows[0],before=await counts();
 // Disposable test database only: invalidate the actual source after the API
 // precheck and before the production persistence guard, not a mocked return.
 await f.pg.exec(`CREATE FUNCTION public.synthetic_send_signer_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id='${f.actors.staff.user}';RETURN NEW;END $$;CREATE TRIGGER aa_synthetic_send_signer_change BEFORE INSERT ON public.signature_send_attempts FOR EACH ROW EXECUTE FUNCTION public.synthetic_send_signer_change()`);
 try{const denied=await f.reserve(id,'master',key);assert.equal(denied.response.status,409,JSON.stringify(denied.body));assert.equal(denied.body.error.code,'SIGNATURE_ATTEMPT_SOURCE_CHANGED');}
 finally{await f.pg.exec('DROP TRIGGER aa_synthetic_send_signer_change ON public.signature_send_attempts;DROP FUNCTION public.synthetic_send_signer_change()');}
 assert.deepEqual(await counts(),before);assert.equal((await f.pg.query('SELECT "phoneNumberVerified" verified FROM identity."user" WHERE id=$1',[f.actors.staff.user])).rows[0].verified,true);
 assert.equal((await f.reserve(id,'master',key)).response.status,201);
},true);
check('strict settings and manifest input never accept caller-supplied delivery, signature, recipient or authorization status',async f=>{
 for(const patch of [{signed:true},{readyToSend:true},{email:'another@example.test'},{authorization_until:'2030-01-01'},{dispatchWithinMinutes:0},{dispatchWithinMinutes:1441},{options:{...f.sendInput.options,expiryDays:181}},{options:{...f.sendInput.options,DisableEmails:true}},{reason:'\0'}])assert.equal((await f.send({...f.sendInput,...patch})).response.status,400,JSON.stringify(patch));
 const made=await f.send();assert.equal(made.response.status,201);for(const value of [{...f.manifest,delivered:true},{...f.manifest,requestBytes:16_777_217},{...f.manifest,requestSha256:'bad'}])assert.equal((await f.reserve(made.body.data.id,'master',undefined,value)).response.status,400);
 assert.equal((await f.request(f.sendPath+'?extra=1',f.sendInput)).response.status,400);assert.equal((await f.request('signature-send-requests/'+made.body.data.id,undefined,'master',{method:'DELETE'})).response.status,405);
});
check('small duplicate and cancellation-versus-reservation races keep exactly one durable winner',async f=>{
 const key=randomUUID(),start=performance.now(),same=await Promise.all([f.send(f.sendInput,'master',key),f.send(f.sendInput,'master',key)]);for(const r of same)assert.equal(r.response.status,201,JSON.stringify(r.body));assert.deepEqual(same[0].body,same[1].body);assert.equal((await f.pg.query('SELECT * FROM public.signature_send_requests')).rows.length,1);
 const id=same[0].body.data.id,race=await Promise.all([f.cancel(id),f.reserve(id)]);assert.deepEqual(race.map(r=>r.response.status).sort(),[201,409]);
 const n=(await f.pg.query('SELECT(SELECT count(*)::int FROM public.signature_send_attempts) attempts,(SELECT count(*)::int FROM public.signature_send_cancellations) cancellations')).rows[0];assert.equal(Number(n.attempts)+Number(n.cancellations),1);
 console.log(JSON.stringify({case:'signing-ledger-tiny-races',elapsedMs:Math.round(performance.now()-start),requests:1,cancellationOrReservationWinners:1}));
},true);

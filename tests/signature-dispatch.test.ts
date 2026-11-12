import assert from 'node:assert/strict';
import { upgradeToCurrent } from './migration-upgrade.ts';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { agreementFixture,reviewedAgreementContent } from './agreement-fixture.ts';
import { buildBoldSignSendRequest } from '../src/integrations/boldsign-send-request.ts';
import { recordSignatureTransportReceipt } from '../src/integrations/signature-result-worker.ts';
import type { Database } from '../src/core/database.ts';
import { signatureConnectionTarget } from '../src/integrations/boldsign-webhook-config.ts';
import { assertSignatureIngestRole } from '../src/integrations/boldsign-inbox.ts';

async function fixture(throughSchema?:number,boundDocumentsOnly=false){
 const f=await agreementFixture(throughSchema,undefined,'Test',{boundDocumentsOnly});
 try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['signature-sends.view','signature-sends.edit','signature-sends.execute','signature-dispatch.execute'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const binding=await reviewedAgreementContent(f,f.t.id,[120,203].includes(throughSchema??0)?{async recordInspection(database,academy,result){
  // Seed actual historical records using their native worker protocol. The
  // CURRENT worker refuses old schemas;never spoof schema_revision for it.
  assert.equal(result.outcome,'no_detection');if(result.outcome!=='no_detection')throw new Error('INVALID_LEGACY_FIXTURE');const c=await database.connect();try{
   const task=(await c.query<{inspection_id:string;lease_token:string}>('SELECT inspection_id,lease_token FROM public.claim_file_inspection($1,$2,150)',[[academy],randomUUID()])).rows[0];assert.ok(task);
   const recorded=(await c.query<{recorded:boolean}>('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb) recorded',[academy,task.inspection_id,task.lease_token,result.outcome,'MEASURED_NO_DETECTION',result.bytes,result.sha256,result.etag,result.providerContentType,JSON.stringify(result.signature),null,null,null])).rows[0];assert.equal(recorded.recorded,true);
  }finally{c.release();}
 }}:{}),pkg=await f.prepare();assert.equal(pkg.response.status,201);
 const linked=await f.request('agreement-packages/'+pkg.body.data.id+'/content',{bindingId:binding.id,reason:'Reviewed exact test source'});assert.equal(linked.response.status,201);
 const send=await f.request('agreement-packages/'+pkg.body.data.id+'/send-requests',{attachmentId:linked.body.data.id,options:{title:'Test agreement',message:'Review',expiryDays:30},dispatchWithinMinutes:60,reason:'Test approved intention'});assert.equal(send.response.status,201);
 // Synthetic attested manifest only; no real agreement or provider invocation.
 const manifest={requestSha256:'a'.repeat(64),requestBytes:1000,documentSha256:binding.sha256},requestId=send.body.data.id;
 let attemptId:string;
 if(throughSchema===120){
  // Retain the actual120 reservation protocol,not a current handler querying
  // tables that did not exist historically and not a spoofed schema version.
  attemptId=randomUUID();const auditId=randomUUID();await f.pg.exec('BEGIN');try{
   await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
   await f.pg.query(`INSERT INTO public.audit_events(academy_id,id,actor_id,session_id,actor_kind,request_id,action,entity_id,hub_id,changes) VALUES($1,$2,$3,$4,'human',$5,'signature.send.attempt_reserved',$6,$7,$8::jsonb)`,[f.a,auditId,f.actors.master.person,f.actors.master.session,randomUUID(),attemptId,f.hub,JSON.stringify({requestId,severity:'critical',externalRequestMade:false})]);
   await f.pg.query('INSERT INTO public.signature_send_attempts(academy_id,id,request_id,actor_id,audit_id,request_sha256,request_bytes,document_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[f.a,attemptId,requestId,f.actors.master.person,auditId,manifest.requestSha256,manifest.requestBytes,manifest.documentSha256]);await f.pg.exec('COMMIT');
  }catch(error){await f.pg.exec('ROLLBACK');throw error;}
 }else{const reserved=await f.request('signature-send-requests/'+requestId+'/attempts',manifest);assert.equal(reserved.response.status,201);attemptId=reserved.body.data.id;}
 const path='signature-send-requests/'+requestId+'/attempts/'+attemptId+'/dispatch';
 return {...f,binding,manifest,requestId,attemptId,path,start:(as='master',key?:string,input:unknown=manifest)=>f.request(path,input,as,key?{key}:{}),outcome:(input:unknown,as='master',key?:string)=>f.request(path+'/outcome',input,as,key?{key}:{})};
 }catch(error){await f.pg.close();throw error;}
}
function check(name:string,run:(f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>,native=false){test(name,{skip:native&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
test('account callback retains only the exact bound academy and connection; an early ignored event can be recorded after a transport observation',async()=>{
 const f=await fixture(undefined,true);try{
  const own={connectionId:f.connection,academyId:f.a,region:'CA' as const,environment:'Test' as const,clientId:null},other={...own,connectionId:randomUUID()},foreign={...own,connectionId:randomUUID(),academyId:f.b},document=randomUUID(),event=randomUUID();
  for(const c of [other,foreign])await f.pg.query("INSERT INTO public.signature_connections(id,academy_id,region,environment,enabled,bound_documents_only) VALUES($1,$2,'CA','Test',true,true)",[c.connectionId,c.academyId]);
  const receive=async(c=own,resource:string|null=document,id=event,object='document')=>{
   await f.pg.exec('SET ROLE kavosh_signature_ingest');try{await assertSignatureIngestRole({query:f.pg.query.bind(f.pg),release(){}});const now=Math.floor(Date.now()/1000);return(await f.pg.query<{outcome:string}>('SELECT public.receive_signature_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) outcome',[c.connectionId,signatureConnectionTarget(c),id,now,now,'Test',null,'Completed',object,resource,'Completed','a'.repeat(64),500])).rows[0].outcome;}finally{await f.pg.exec('RESET ROLE');}
  };
  assert.equal(await receive(),'ignored');assert.equal((await f.pg.query('SELECT * FROM public.signature_webhook_inbox')).rows.length,0);
  const started=await f.start();assert.equal(started.response.status,201,JSON.stringify(started.body));
  assert.equal((await f.outcome({state:'accepted_for_processing',documentId:document})).response.status,201);
  assert.equal(await receive(),'recorded');assert.equal(await receive(),'duplicate');
  assert.equal(await receive(other),'ignored');assert.equal(await receive(foreign),'ignored');assert.equal(await receive(own,randomUUID(),randomUUID()),'ignored');assert.equal(await receive(own,document,randomUUID(),'template'),'ignored');
  const rows=(await f.pg.query('SELECT academy_id,connection_id,event_id,resource_id FROM public.signature_webhook_inbox')).rows;assert.deepEqual(rows,[{academy_id:f.a,connection_id:f.connection,event_id:event,resource_id:document}]);
  assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='signature.webhook.received'")).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.signature_webhook_conflicts')).rows.length,0);
  await assert.rejects(f.pg.query('UPDATE public.signature_connections SET bound_documents_only=false WHERE id=$1',[f.connection]),/SIGNATURE_CONNECTION_IDENTITY_IMMUTABLE/);
  for(const role of ['kavosh_runtime','kavosh_signature_ingest']){await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT public.signature_callback_document_bound($1,$2,$3)',[f.a,f.connection,document]),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}}
 }finally{await f.pg.close();}
});
check('dispatch privately preserves the verified historical signer after email and phone replacement without exposing plaintext contacts',async f=>{
 const contact=(await f.pg.query<{name:string;email:string;phone:string}>(`SELECT g.legal_name name,u.email,u."phoneNumber" phone FROM public.guardian_profiles g JOIN public.people p ON p.academy_id=g.academy_id AND p.id=g.person_id JOIN identity."user" u ON u.id=p.auth_user_id WHERE p.id=$1`,[f.signer])).rows[0];
 const started=await f.start();assert.equal(started.response.status,201,JSON.stringify(started.body));const id=started.body.data.id,rows=(await f.pg.query('SELECT * FROM identity.signature_signer_history')).rows;assert.equal(rows.length,1);assert.equal(rows[0].start_id,id);assert.equal(rows[0].signer_id,f.signer);for(const value of [contact.name,contact.email,contact.phone])assert.ok(!JSON.stringify(rows).includes(value));
 const matches=async(name=contact.name,email=contact.email,phone=contact.phone,academy=f.a,signer=f.signer)=>f.pg.query('SELECT * FROM identity.signature_signer_matches($1,$2,$3,$4,$5,$6)',[academy,id,signer,name,email,phone]);assert.deepEqual((await matches()).rows,[{name_matches:true,email_matches:true,phone_matches:true}]);
 await f.pg.query('UPDATE identity."user" SET email=$1,"phoneNumber"=$2 WHERE id=$3',['later-signer@example.test','+16475559091',f.actors.staff.user]);assert.deepEqual((await matches()).rows,[{name_matches:true,email_matches:true,phone_matches:true}]);assert.deepEqual((await matches('Different name','later-signer@example.test','+16475559091')).rows,[{name_matches:false,email_matches:false,phone_matches:false}]);assert.deepEqual((await matches(contact.name,contact.email,contact.phone,f.b)).rows,[]);assert.deepEqual((await matches(contact.name,contact.email,contact.phone,f.a,randomUUID())).rows,[]);
 assert.ok(!JSON.stringify((await f.request(f.path)).body).includes('commitment'));assert.equal((await f.request(f.path)).body.data.admissionCleared,false);
});
check('historical signer commitments deny every ordinary role and cannot be forged rewritten or deleted',async f=>{
 const started=await f.start();assert.equal(started.response.status,201,JSON.stringify(started.body));const id=started.body.data.id;
 for(const role of ['kavosh_runtime','kavosh_identity','kavosh_delivery','kavosh_automation_worker','kavosh_signature_result_worker']){await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT * FROM identity.signature_signer_history'),(e:unknown)=>(e as {code:string}).code==='42501');await assert.rejects(f.pg.query('SELECT * FROM identity.signature_signer_matches($1,$2,$3,$4,$5,$6)',[f.a,id,f.signer,'x','x@example.test','+16475559091']),(e:unknown)=>(e as {code:string}).code==='42501');}finally{await f.pg.exec('RESET ROLE');}}
 for(const sql of ['UPDATE identity.signature_signer_history SET name_commitment=repeat(\'a\',64)','DELETE FROM identity.signature_signer_history'])await assert.rejects(f.pg.exec(sql),(e:unknown)=>(e as {message:string}).message==='SIGNATURE_SIGNER_HISTORY_IMMUTABLE');
 await f.pg.exec('SET ROLE kavosh_identity_policy');try{await assert.rejects(f.pg.query("INSERT INTO identity.signature_signer_history(academy_id,start_id,request_id,package_id,signer_id,name_commitment,email_commitment,phone_commitment) SELECT academy_id,$1,request_id,package_id,signer_id,name_commitment,email_commitment,phone_commitment FROM identity.signature_signer_history",[randomUUID()]),(e:unknown)=>(e as {message:string}).message==='SIGNATURE_SIGNER_CAPTURE_REQUIRED');}finally{await f.pg.exec('RESET ROLE');}
});
check('a late signer-history save failure rolls back dispatch consumption audit and retry intent together',async f=>{
 const key=randomUUID(),before=(await f.pg.query("SELECT count(*)::integer n FROM public.audit_events WHERE action='signature.dispatch.started'")).rows[0].n;await f.pg.exec('REVOKE INSERT ON identity.signature_signer_history FROM kavosh_identity_policy');try{assert.equal((await f.start('master',key)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON identity.signature_signer_history TO kavosh_identity_policy');}
 assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_starts')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM identity.signature_signer_history')).rows.length,0);assert.equal((await f.pg.query("SELECT count(*)::integer n FROM public.audit_events WHERE action='signature.dispatch.started'")).rows[0].n,before);assert.equal((await f.start('master',key)).response.status,201);assert.equal((await f.pg.query('SELECT * FROM identity.signature_signer_history')).rows.length,1);
});
test('actual203to204 upgrade preserves old starts without inventing historical signer commitments',async()=>{
 const f=await fixture(203);try{const old=await f.start();assert.equal(old.response.status,201,JSON.stringify(old.body));const sql="SELECT jsonb_build_object('starts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.signature_dispatch_starts x),'attempts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.signature_send_attempts x),'packages',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.agreement_packages x),'people',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.people x)) snapshot",before=(await f.pg.query(sql)).rows;await f.pg.exec(await readFile(new URL('../db/migrations/204_signature_signer_history.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query(sql)).rows,before);assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,204);assert.equal((await f.pg.query('SELECT * FROM identity.signature_signer_history')).rows.length,0);assert.deepEqual((await f.pg.query('SELECT * FROM identity.signature_signer_matches($1,$2,$3,$4,$5,$6)',[f.a,old.body.data.id,f.signer,'not guessed','not-guessed@example.test','+16475559091'])).rows,[]);
 await upgradeToCurrent(f.pg);const p=await f.prepare();assert.equal(p.response.status,201);const linked=await f.request('agreement-packages/'+p.body.data.id+'/content',{bindingId:f.binding.id,reason:'New reviewed link after upgrade'});assert.equal(linked.response.status,201);const send=await f.request('agreement-packages/'+p.body.data.id+'/send-requests',{attachmentId:linked.body.data.id,options:{title:'New agreement',message:'Review',expiryDays:30},dispatchWithinMinutes:60,reason:'New authorized request'});assert.equal(send.response.status,201);const attempt=await f.request('signature-send-requests/'+send.body.data.id+'/attempts',f.manifest);assert.equal(attempt.response.status,201);const started=await f.request('signature-send-requests/'+send.body.data.id+'/attempts/'+attempt.body.data.id+'/dispatch',f.manifest);assert.equal(started.response.status,201,JSON.stringify(started.body));assert.deepEqual((await f.pg.query('SELECT start_id FROM identity.signature_signer_history')).rows,[{start_id:started.body.data.id}]);
 }finally{await f.pg.close();}
});
check('durable start is consumed once across retry keys and outcome observations never claim delivery or admission',async f=>{
 assert.equal((await f.request(f.path)).body.data.state,'not_started');const key=randomUUID(),made=await f.start('master',key);assert.equal(made.response.status,201,JSON.stringify(made.body));assert.equal(made.body.data.externalRequestMade,false);
 for(const k of [key,randomUUID()]){const repeated=await f.start('master',k);assert.equal(repeated.response.status,409);assert.equal(repeated.body.error.code,'SIGNATURE_DISPATCH_ALREADY_STARTED');}
 assert.equal((await f.request(f.path)).body.data.state,'started_outcome_unrecorded');const documentId=randomUUID(),outcomeKey=randomUUID(),observed=await f.outcome({state:'accepted_for_processing',documentId},'master',outcomeKey);assert.equal(observed.response.status,201,JSON.stringify(observed.body));
 assert.equal((await f.request('signature-send-requests/'+f.requestId)).body.data.state,'accepted_for_processing');assert.equal((await f.request('signature-send-requests/'+f.requestId+'/attempts')).body.externalRequestMade,null,'history cannot claim no external effect after a dispatch start');
 for(const name of ['deliveryVerified','admissionCleared','providerVerified','automaticRetryAllowed','readyToSend'])assert.equal(observed.body.data[name],false);
 assert.equal(observed.body.data.source_current,true);assert.equal(observed.body.data.document_id,documentId);assert.deepEqual((await f.outcome({state:'accepted_for_processing',documentId},'master',outcomeKey)).body,observed.body);
 assert.equal((await f.outcome({state:'outcome_unknown'})).response.status,409);assert.equal((await f.start()).response.status,409);
 const read=await f.request(f.path);assert.equal(read.body.data.state,'accepted_for_processing');assert.equal(read.body.data.reconciliationRequired,true);
 assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_starts')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_outcomes')).rows.length,1);
});
check('unattempted and ambiguous observations both keep the durable start consumed',async f=>{
 assert.equal((await f.start('bot')).response.status,201);const observed=await f.outcome({state:'not_attempted'},'bot');assert.equal(observed.response.status,201,JSON.stringify(observed.body));assert.equal(observed.body.data.reconciliationRequired,false);assert.equal(observed.body.data.automaticRetryAllowed,false);assert.equal((await f.start('bot')).response.status,409);
});
check('a late outcome records changed authorization without silently discarding possible external effects',async f=>{
 assert.equal((await f.start()).response.status,201);
 await f.pg.query("UPDATE public.signature_send_requests SET created_at=transaction_timestamp()-interval '2 hours',authorization_until=transaction_timestamp()-interval '1 hour' WHERE id=$1",[f.requestId]);
 const result=await f.outcome({state:'outcome_unknown'});assert.equal(result.response.status,201,JSON.stringify(result.body));assert.equal(result.body.data.source_current,false);assert.equal(result.body.data.reconciliationRequired,true);assert.equal((await f.start()).response.status,409);
});
check('separate execution rights, current private sources, starter identity and tenant isolation protect starts and observations',async f=>{
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='signature-dispatch.execute'",[f.staffRole]);assert.equal((await f.start('staff')).response.status,404,'old manifest reservation permission must not grant transport coordination');
 assert.equal((await f.start('bot')).response.status,201);assert.equal((await f.outcome({state:'outcome_unknown'},'master')).response.status,404,'even master cannot impersonate the worker observation');
 assert.equal((await f.request(f.path,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.view'",[f.managerRole]);assert.ok([403,404].includes((await f.outcome({state:'outcome_unknown'},'bot')).response.status));assert.ok([403,404].includes((await f.request(f.path,undefined,'bot')).response.status));
});
check('manifest and input validation reject before any durable consumption; an expired request cannot start',async f=>{
 for(const input of [{...f.manifest,requestSha256:'b'.repeat(64)},{...f.manifest,requestBytes:1001},{...f.manifest,documentSha256:'b'.repeat(64)}])assert.equal((await f.start('master',undefined,input)).response.status,409);
 for(const input of [{...f.manifest,url:'https://localhost'},{...f.manifest,requestBytes:0},{...f.manifest,delivered:true}])assert.equal((await f.start('master',undefined,input)).response.status,400);
 assert.equal((await f.outcome({state:'outcome_unknown'})).response.status,404);
 for(const input of [{state:'accepted_for_processing'},{state:'outcome_unknown',documentId:randomUUID()},{state:'completed'},{state:'not_attempted',source_current:true}])assert.equal((await f.outcome(input)).response.status,400);
 assert.equal((await f.request(f.path+'?extra=1')).response.status,400);assert.equal((await f.request(f.path,undefined,'master',{method:'DELETE'})).response.status,405);
 await f.pg.query("UPDATE public.signature_send_requests SET created_at=transaction_timestamp()-interval '2 hours',authorization_until=transaction_timestamp()-interval '1 hour' WHERE id=$1",[f.requestId]);assert.equal((await f.start()).body.error.code,'SIGNATURE_SEND_NOT_CURRENT');assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_starts')).rows.length,0);
});
check('audit/outbox failure rolls back complete start and outcome and allows exact-key retry',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.signature_dispatch_starts) starts,(SELECT count(*)::int FROM public.signature_dispatch_outcomes) outcomes,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events')).rows[0];
 for(const phase of ['start','outcome']){const before=await counts(),key=randomUUID(),run=()=>phase==='start'?f.start('master',key):f.outcome({state:'outcome_unknown'},'master',key);await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await run()).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}assert.deepEqual(await counts(),before);assert.equal((await run()).response.status,201);}
});
check('native records are tenant-bound, append-only, server-dated and cannot bypass audit provenance',async f=>{
 const made=await f.start();assert.equal(made.response.status,201);await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  await assert.rejects(f.pg.query('INSERT INTO public.signature_dispatch_outcomes(academy_id,id,start_id,actor_id,audit_id,state) VALUES($1,$2,$3,$4,$5,$6)',[f.a,randomUUID(),made.body.data.id,f.actors.master.person,randomUUID(),'outcome_unknown']),/SIGNATURE_DISPATCH_INVALID/);
  for(const table of ['signature_dispatch_starts','signature_dispatch_outcomes']){await assert.rejects(f.pg.exec('DELETE FROM public.'+table),/permission denied/i);await assert.rejects(f.pg.exec('UPDATE public.'+table+' SET created_at=now()'),/permission denied/i);}
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_starts')).rows.length,0);
 }finally{await f.pg.exec('RESET ROLE');}
});
check('tiny simultaneous starts have exactly one winner even with the same retry key',async f=>{
 const key=randomUUID(),start=performance.now(),results=await Promise.all([f.start('master',key),f.start('master',key)]);assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_starts')).rows.length,1);console.log(JSON.stringify({case:'signature-dispatch-two-request-race',elapsedMs:Math.round(performance.now()-start)}));
},true);
check('native final guard catches a signer change after API authorization and rolls back the complete start',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.signature_dispatch_starts) starts,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events')).rows[0],before=await counts(),key=randomUUID();
 // Disposable database only: a real identity change between API check/INSERT.
 await f.pg.exec(`CREATE FUNCTION public.synthetic_dispatch_signer_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id='${f.actors.staff.user}';RETURN NEW;END $$;CREATE TRIGGER aa_synthetic_dispatch_signer_change BEFORE INSERT ON public.signature_dispatch_starts FOR EACH ROW EXECUTE FUNCTION public.synthetic_dispatch_signer_change()`);
 try{const denied=await f.start('master',key);assert.equal(denied.response.status,409,JSON.stringify(denied.body));assert.equal(denied.body.error.code,'SIGNATURE_DISPATCH_SOURCE_CHANGED');}finally{await f.pg.exec('DROP TRIGGER aa_synthetic_dispatch_signer_change ON public.signature_dispatch_starts;DROP FUNCTION public.synthetic_dispatch_signer_change()');}
 assert.deepEqual(await counts(),before);assert.equal((await f.start('master',key)).response.status,201);
},true);
check('private draft hydrates verified account contacts and legal profile name,not public aliases or caller assertions',async f=>{
 await f.pg.query("UPDATE public.people SET name='PRIVATE wrong public alias',email='wrong-public@example.test' WHERE id=$1",[f.signer]);
 const result=await f.request('signature-send-requests/'+f.requestId+'/dispatch-source',undefined,'bot');assert.equal(result.response.status,200,JSON.stringify(result.body));assert.equal(result.response.headers.get('cache-control'),'no-store');
 const contact=(await f.pg.query('SELECT u.email,u."phoneNumber" phone,g.legal_name FROM public.people p JOIN identity."user" u ON u.id=p.auth_user_id JOIN public.guardian_profiles g ON g.academy_id=p.academy_id AND g.person_id=p.id WHERE p.id=$1',[f.signer])).rows[0],data=result.body.data;
 assert.deepEqual(data.draft.signer,{personId:f.signer,legalName:contact.legal_name,email:contact.email,phoneE164:contact.phone,emailVerified:true,phoneVerified:true,contactFingerprint:data.draft.signer.contactFingerprint});assert.match(data.draft.signer.contactFingerprint,/^[a-f0-9]{64}$/);
 assert.equal(data.file.id,f.binding.fileId);assert.equal(data.file.version,1);assert.equal(data.draft.attachmentId,(await f.request('signature-send-requests/'+f.requestId)).body.data.attachment_id);
 const built=buildBoldSignSendRequest(data.draft,f.binding.bytes);assert.equal(built.receipt.documentSha256,f.binding.sha256);const wire=JSON.parse(built.body);assert.equal(wire.Signers[0].EmailAddress,contact.email);assert.equal(wire.Signers[0].Name,contact.legal_name);
 for(const flag of ['readyToSend','admissionCleared','providerVerified','originalBytesRetrieved','fileSafetyCleared','externalRequestMade'])assert.equal(data[flag],false);
 const audits=(await f.pg.query("SELECT changes FROM public.audit_events WHERE action='signature.dispatch.source.read'")).rows;assert.equal(audits.length,1);assert.doesNotMatch(JSON.stringify(audits),/PRIVATE|example.test|phoneNumber|contactFingerprint/);
 assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_starts')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_outcomes')).rows.length,0);
});
check('draft privacy requires distinct current dispatch and all underlying source rights,including for bots',async f=>{
 const path='signature-send-requests/'+f.requestId+'/dispatch-source';assert.equal((await f.request(path,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 for(const cap of ['signature-dispatch.execute','signature-sends.view','files.view','signatures.view','enrollments.view','guardians.view','families.view']){await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1 AND capability=$2',[f.managerRole,cap]);assert.ok([403,404].includes((await f.request(path,undefined,'bot')).response.status),cap);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.managerRole,cap]);}
 assert.equal((await f.request(path+'?email=other@example.test')).response.status,400);assert.equal((await f.request(path,{emailVerified:true,phoneVerified:true})).response.status,405);
});
check('changed verified contact or archived original invalidates draft without exposing the new private contact',async f=>{
 const path='signature-send-requests/'+f.requestId+'/dispatch-source';await f.pg.query('UPDATE identity."user" SET email=$1 WHERE id=$2',['new-PRIVATE@example.test',f.actors.staff.user]);
 const denied=await f.request(path);assert.equal(denied.response.status,409);assert.ok(!JSON.stringify(denied.body).includes('new-PRIVATE'));
 await f.pg.query('UPDATE identity."user" SET email=$1 WHERE id=$2',['staff@example.test',f.actors.staff.user]);assert.equal((await f.request(path)).response.status,200);
 assert.equal((await f.request('files/'+f.binding.fileId+'/change',{expectedVersion:1,archived:true})).response.status,200);assert.equal((await f.request(path)).response.status,409);
});
check('narrow native contact helper is tenant-bound and leaves raw identity access and file-worker access denied',async f=>{
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_contact($1)',[f.requestId])).rows.length,0);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_contact($1)',[f.requestId])).rows.length,1);await assert.rejects(f.pg.exec('SELECT email,"phoneNumber" FROM identity."user"'),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('SET ROLE kavosh_file_worker');try{await assert.rejects(f.pg.query('SELECT * FROM public.signature_dispatch_contact($1)',[f.requestId]),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
 await f.pg.query('UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id=$1',[f.actors.staff.user]);await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_contact($1)',[f.requestId])).rows.length,0);}finally{await f.pg.exec('RESET ROLE');}
});
check('private-contact read fails closed if its audit outbox cannot commit and does not cache contacts in retry receipts',async f=>{
 const path='signature-send-requests/'+f.requestId+'/dispatch-source',before=(await f.pg.query("SELECT count(*)::int n FROM public.audit_events WHERE action='signature.dispatch.source.read'")).rows[0].n;
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{const denied=await f.request(path);assert.equal(denied.response.status,503);assert.doesNotMatch(JSON.stringify(denied.body),/PRIVATE|staff@example.test|phoneE164|legalName/);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.pg.query("SELECT count(*)::int n FROM public.audit_events WHERE action='signature.dispatch.source.read'")).rows[0].n,before);assert.equal((await f.request(path)).response.status,200);
 assert.equal((await f.pg.query("SELECT count(*)::int n FROM public.request_keys WHERE response::text LIKE '%phoneE164%' OR response::text LIKE '%staff@example.test%'")).rows[0].n,0);
});
check('native contact hydration excludes an explicitly cancelled signing intention',async f=>{
 const pkg=await f.prepare();assert.equal(pkg.response.status,201);const linked=await f.request('agreement-packages/'+pkg.body.data.id+'/content',{bindingId:f.binding.id,reason:'Second reviewed package'});assert.equal(linked.response.status,201);
 const made=await f.request('agreement-packages/'+pkg.body.data.id+'/send-requests',{attachmentId:linked.body.data.id,options:{title:'Second agreement',message:'Review',expiryDays:30},dispatchWithinMinutes:60,reason:'Second reviewed intention'});assert.equal(made.response.status,201);const id=made.body.data.id;
 assert.equal((await f.request('signature-send-requests/'+id+'/dispatch-source')).response.status,200);assert.equal((await f.request('signature-send-requests/'+id+'/cancel',{reason:'Do not send'})).response.status,201);assert.equal((await f.request('signature-send-requests/'+id+'/dispatch-source')).response.status,409);
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_contact($1)',[id])).rows.length,0);const owner=(await f.pg.query("SELECT r.rolname,p.proconfig,r.rolsuper,r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.signature_dispatch_contact(uuid)'::regprocedure")).rows[0];assert.equal(owner.rolname,'kavosh_identity_policy');assert.deepEqual(owner.proconfig,['search_path=pg_catalog']);assert.equal(owner.rolsuper,false);assert.equal(owner.rolbypassrls,false);}finally{await f.pg.exec('RESET ROLE');}
});
check('send-only bot uses explicit execution plus private viewing rights without acquiring signature editing',async f=>{
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability IN('signatures.edit','signature-sends.edit')",[f.managerRole]);
 assert.equal((await f.request('signature-send-requests/'+f.requestId+'/dispatch-source',undefined,'bot')).response.status,200);assert.equal((await f.start('bot')).response.status,201);assert.equal((await f.outcome({state:'outcome_unknown'},'bot')).response.status,201);
 const stopped=await f.request('signature-send-requests/'+f.requestId+'/cancel',{reason:'Execution must not grant editing'},'bot');assert.ok([403,404].includes(stopped.response.status));
});
test('schema121 preserves a real schema120 coordination start without fabricating original-copy evidence',async()=>{
 const f=await fixture(120);try{
  const startId=randomUUID(),auditId=randomUUID();await f.pg.exec('BEGIN');try{
   await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
   await f.pg.query(`INSERT INTO public.audit_events(academy_id,id,actor_id,session_id,actor_kind,request_id,action,entity_id,hub_id,changes) VALUES($1,$2,$3,$4,'human',$5,'signature.dispatch.started',$6,$7,$8::jsonb)`,[f.a,auditId,f.actors.master.person,f.actors.master.session,randomUUID(),startId,f.hub,JSON.stringify({requestId:f.requestId,attemptId:f.attemptId,severity:'critical',providerVerified:false})]);
   await f.pg.query('INSERT INTO public.signature_dispatch_starts(academy_id,id,attempt_id,actor_id,audit_id) VALUES($1,$2,$3,$4,$5)',[f.a,startId,f.attemptId,f.actors.master.person,auditId]);await f.pg.exec('COMMIT');
  }catch(error){await f.pg.exec('ROLLBACK');throw error;}
  const before=(await f.pg.query('SELECT * FROM public.signature_dispatch_starts WHERE id=$1',[startId])).rows[0];await f.pg.exec(await readFile(new URL('../db/migrations/121_signature_original_binding.sql',import.meta.url),'utf8'));assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,121);
  const {original_copy_id,original_source,original_source_fingerprint,...unchanged}=(await f.pg.query('SELECT * FROM public.signature_dispatch_starts WHERE id=$1',[startId])).rows[0];assert.deepEqual(unchanged,before);assert.equal(original_copy_id,null);assert.equal(original_source,null);assert.equal(original_source_fingerprint,null);
  await f.pg.exec(await readFile(new URL('../db/migrations/122_signature_transport_receipts.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/123_signature_result_target.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/124_audited_automation_events.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/125_automation_subscriptions.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/126_session_notification_sources.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/127_session_notification_audiences.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/128_session_reminders.sql',import.meta.url),'utf8'));await f.pg.exec(await readFile(new URL('../db/migrations/129_report_presets.sql',import.meta.url),'utf8'));assert.equal((await f.pg.query('SELECT * FROM public.signature_transport_receipts')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.signature_transport_conflicts')).rows.length,0);await upgradeToCurrent(f.pg);
  const history=await f.request(f.path);assert.equal(history.response.status,200);assert.equal(history.body.data.start.originalCopyBound,false);assert.equal(history.body.data.start.originalCopyCurrent,null);assert.equal(history.body.data.workerObservation,null);
 }finally{await f.pg.close();}
});
check('a service receipt cannot promote unbound coordination into provider authority',async f=>{
 const started=await f.start();assert.equal(started.response.status,201);assert.equal(started.body.data.originalCopyBound,false);
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_signature_result_worker');return c;}},before=(await f.pg.query('SELECT count(*)::int n FROM public.outbox_events')).rows[0].n;
 try{const result=await recordSignatureTransportReceipt(database,{academyId:f.a,startId:started.body.data.id,workerId:randomUUID(),outcome:{state:'outcome_unknown',automaticRetryAllowed:false,reconciliationRequired:true,deliveryVerified:false}});assert.equal(result.status,'unavailable');assert.equal(result.recorded,false);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 assert.equal((await f.pg.query('SELECT count(*)::int n FROM public.outbox_events')).rows[0].n,before);assert.equal((await f.pg.query('SELECT * FROM public.signature_transport_receipts')).rows.length,0);
 assert.deepEqual((await f.request(f.path+'/conflicts')).body.data,[]);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.view'",[f.managerRole]);assert.ok([403,404].includes((await f.request(f.path+'/conflicts',undefined,'bot')).response.status));
});

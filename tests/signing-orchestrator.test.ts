import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { processEnrollmentSigning,processWorkSigning } from '../src/integrations/signing-orchestrator.ts';
import { createSigningControlApi } from '../src/integrations/signing-control-api.ts';
import { expectedSchemaRevision,type Database } from '../src/core/database.ts';
import { mintToken } from '../src/core/tokens.ts';
import { r2TargetId } from '../src/integrations/r2-config.ts';

// Offline workflow logic only. Synthetic control,storage,provider and DB replies
// are not evidence of native authorization,PDF safety or live delivery.
function fixture(mode='normal',work=false){
 const task={academyId:randomUUID(),requestId:randomUUID(),copyId:randomUUID(),workerId:randomUUID(),attemptKey:randomUUID(),startKey:randomUUID()},attemptId=randomUUID(),startId=randomUUID(),documentId=randomUUID();
 const bytes=Buffer.from('%PDF-1.7\nPRIVATE synthetic original\n'),sha256=createHash('sha256').update(bytes).digest('hex');
 const storage={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-signing',accessKeyId:'synthetic-reader',secretAccessKey:'PRIVATE-synthetic-key',maximumUploadBytes:10_485_760};
 const original={academyId:task.academyId,fileId:randomUUID(),fileVersion:1,copyId:task.copyId,sourceFingerprint:'a'.repeat(64),storageTargetId:r2TargetId(storage),bytes:bytes.length,sha256,etag:'"synthetic"'};
 const legacyDraft={packageId:randomUUID(),attachmentId:randomUUID(),bindingId:randomUUID(),locale:'en',title:'PRIVATE Agreement',message:'Review',expiryDays:30,document:{sha256,sizeBytes:bytes.length},signer:{personId:randomUUID(),legalName:'PRIVATE Signer',email:'synthetic@example.test',phoneE164:'+16475550101',emailVerified:true,phoneVerified:true,contactFingerprint:'b'.repeat(64)},routing:{version:1,role:'legal_signer',fields:[{id:'Signature1',fieldType:'Signature',isRequired:true,pageNumber:1,bounds:{x:10,y:10,width:100,height:30}}]}};
 const draft=work?{locale:legacyDraft.locale,title:legacyDraft.title,message:legacyDraft.message,expiryDays:legacyDraft.expiryDays,document:legacyDraft.document,preparationId:randomUUID(),bindingId:legacyDraft.bindingId,worker:legacyDraft.signer,academyRepresentative:{...legacyDraft.signer,personId:randomUUID(),legalName:'PRIVATE Academy Signer',email:'academy@example.test',phoneE164:'+16475550102',contactFingerprint:'f'.repeat(64)},routing:{version:1,parties:[{role:'worker',fields:legacyDraft.routing.fields},{role:'academy_representative',fields:[{...legacyDraft.routing.fields[0],id:'AcademySignature',pageNumber:2}]}]}}:legacyDraft;
 const source={data:{draft,original,originalEvidenceAvailable:true,connection:{id:randomUUID(),targetId:'c'.repeat(64),region:'CA'}}};
 let apiCalls=0,sourceCalls=0,storageCalls=0,providerCalls=0,receipts=0,connections=0,claimed=false,manifest:Record<string,unknown>|undefined;
 const api=createSigningControlApi({origin:'https://control.example',academyId:task.academyId,token:mintToken(),purpose:work?'worker_services':'unified_enrollment'},async(url,options)=>{
  apiCalls++;const path=new URL(String(url)).pathname;
  if(path.endsWith('/dispatch-source')){sourceCalls++;if(mode==='revoked'&&claimed)return Response.json({error:{code:'FORBIDDEN'}},{status:403});return Response.json(mode==='changed'&&sourceCalls>1?{data:{...source.data,draft:{...draft,title:'Changed'}}}:source);}
  if(path.endsWith('/dispatch')){claimed=true;if(mode==='uncertain')throw new Error('PRIVATE lost reply');return Response.json({data:{id:startId,attempt_id:attemptId,original_copy_id:task.copyId,original_source_fingerprint:original.sourceFingerprint,originalCopyBound:true,state:'started',externalRequestMade:false}});}
  if(path.endsWith('/attempts')){
   if(options?.method==='POST'){manifest=JSON.parse(String(options.body));return Response.json({data:{id:attemptId}});}
   return Response.json({data:[{id:attemptId,request_sha256:mode==='mismatch'?'d'.repeat(64):manifest?.requestSha256,request_bytes:manifest?.requestBytes,document_sha256:sha256}]});
  }
  return Response.json({data:work?{id:task.requestId,attemptId:manifest?attemptId:null,dispatchId:claimed?startId:null}:{id:task.requestId,attempt_id:manifest?attemptId:null,dispatch_id:claimed?startId:null}});
 });
 const resultDatabase:Database={async connect(){connections++;return {async query<Row>(sql:string){
  let row:unknown;
  if(/^SELECT public.record_(work_)?signature_transport_receipt\(/.test(sql)){if(mode==='sink_failure')throw new Error('PRIVATE failed');receipts++;row={status:'recorded'};}
  else if(sql.includes('schema_revision'))row={revision:expectedSchemaRevision};
  else if(sql.includes(' ready'))row={ready:!(mode==='wrong_sink'&&claimed)};
  else row={safe:true};
  return {rows:[row] as Row[]};
 },release(){connections--;}};}};
 const services={api,resultDatabase,readers:()=>storage,providers:()=>({region:'CA' as const,apiKey:'PRIVATE-synthetic-provider-key'}),
  storageHandler:{destroy(){},async handle(){storageCalls++;return {response:{statusCode:200,headers:{'content-type':'application/octet-stream','content-length':String(bytes.length),etag:original.etag},body:Readable.from([bytes])}};}},
  providerFetch:(async(url,options)=>{providerCalls++;assert.equal(connections,0);assert.equal(String(url),'https://api-ca.boldsign.com/v1/document/send');assert.equal(new Headers(options?.headers).get('authorization'),null);assert.match(String(options?.body),/PRIVATE Signer/);assert.equal(JSON.parse(String(options?.body)).Signers.length,work?2:1);if(mode==='unknown')throw new Error('PRIVATE provider outage');return Response.json({documentId},{status:201});}) as typeof fetch};
 return {task,services,counts:()=>({apiCalls,sourceCalls,storageCalls,providerCalls,receipts,connections})};
}
const enabled={enabled:true,dualOtpAccountAttested:true};
test('two-party work sender uses fixed work controls and remains disabled until explicitly enabled and attested',async()=>{
 const f=fixture('normal',true);assert.equal((await processWorkSigning(f.task,f.services)).state,'disabled');assert.equal((await processWorkSigning(f.task,f.services,{enabled:true})).state,'disabled');assert.equal((await processEnrollmentSigning(f.task,f.services,enabled)).state,'not_started');assert.equal(f.counts().apiCalls,0);const result=await processWorkSigning(f.task,f.services,enabled);assert.equal(result.state,'accepted_for_processing',JSON.stringify(f.counts()));assert.equal(result.receiptStored,true);assert.equal(result.signedByBothParties,false);assert.equal(result.legallyEffective,false);assert.equal(result.paymentCleared,false);assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().storageCalls,1);assert.equal(f.counts().connections,0);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|example.test|apiKey/);assert.equal((await processWorkSigning(f.task,f.services,enabled)).state,'already_started');assert.equal(f.counts().providerCalls,1);const enrollment=fixture();assert.equal((await processWorkSigning(enrollment.task,enrollment.services,enabled)).state,'not_started');assert.equal(enrollment.counts().apiCalls,0);
});
test('two-party work sender stops on changed source wrong sink uncertain starts and ambiguous provider or persistence outcomes',async()=>{
 for(const [mode,state,sends]of [['changed','source_changed',0],['mismatch','reservation_mismatch',0],['uncertain','start_uncertain',0],['revoked','not_attempted',0],['wrong_sink','not_attempted',0],['unknown','outcome_unknown',1],['sink_failure','receipt_pending',1]] as const){const f=fixture(mode,true),result=await processWorkSigning(f.task,f.services,enabled);assert.equal(result.state,state,mode);assert.equal(f.counts().providerCalls,sends,mode);assert.equal(f.counts().connections,0);assert.equal(result.automaticRetryAllowed,false);if(sends){assert.equal(result.reconciliationRequired,true);assert.equal((await processWorkSigning(f.task,f.services,enabled)).state,'already_started');assert.equal(f.counts().providerCalls,1);}}
});
test('work and enrollment share the same bounded sender slots until ignored provider IO really settles',async()=>{
 const cases=[{f:fixture('normal',true),run:processWorkSigning},{f:fixture(),run:processEnrollmentSigning}],controllers=[new AbortController(),new AbortController()],pending=cases.map(({f})=>{let settle!:(r:Response)=>void,started!:()=>void;const response=new Promise<Response>(resolve=>{settle=resolve;}),observed=new Promise<void>(resolve=>{started=resolve;});f.services.providerFetch=async()=>{started();return response;};return {settle,observed};});const calls=cases.map(({f,run},i)=>run(f.task,f.services,{...enabled,signal:controllers[i].signal}));await Promise.all(pending.map(p=>p.observed));controllers.forEach(c=>c.abort());for(const r of await Promise.all(calls)){assert.equal(r.state,'outcome_unknown');assert.equal(r.receiptStored,true);}const next=fixture('normal',true);assert.equal((await processWorkSigning(next.task,next.services,enabled)).state,'busy');assert.equal(next.counts().apiCalls,0);pending.forEach(p=>p.settle(Response.json({documentId:randomUUID()},{status:201})));await new Promise<void>(resolve=>setImmediate(resolve));assert.equal((await processWorkSigning(next.task,next.services,enabled)).state,'accepted_for_processing');
});
test('signing workflow is opt-in and cancellation does not contact dependencies',async()=>{
 const f=fixture();assert.equal((await processEnrollmentSigning(f.task,f.services)).state,'disabled');assert.equal((await processEnrollmentSigning(f.task,f.services,{enabled:true})).state,'disabled');assert.equal((await processEnrollmentSigning(f.task,f.services,{...enabled,signal:AbortSignal.abort()})).state,'not_started');assert.equal(f.counts().apiCalls,0);
});
test('signing workflow measures original,claims once,records unverified acknowledgement and refuses resend',async()=>{
 const f=fixture(),result=await processEnrollmentSigning(f.task,f.services,enabled);assert.equal(result.state,'accepted_for_processing',JSON.stringify(f.counts()));assert.equal(result.deliveryVerified,false);assert.equal(result.admissionCleared,false);assert.equal(result.receiptStored,true);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|example.test|apiKey/);
 assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().receipts,1);assert.equal(f.counts().storageCalls,1);assert.equal(f.counts().connections,0);
 assert.equal((await processEnrollmentSigning(f.task,f.services,enabled)).state,'already_started');assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().storageCalls,1);
});
test('changed originals,mismatched reservations and uncertain start replies never call provider',async()=>{
 for(const [mode,state] of [['changed','source_changed'],['mismatch','reservation_mismatch'],['uncertain','start_uncertain']]){const f=fixture(mode);assert.equal((await processEnrollmentSigning(f.task,f.services,enabled)).state,state,mode);assert.equal(f.counts().providerCalls,0);assert.equal(f.counts().connections,0);}
});
test('post-claim revocation or wrong result database records no-attempt without sending',async()=>{
 for(const mode of ['revoked','wrong_sink']){const f=fixture(mode),result=await processEnrollmentSigning(f.task,f.services,enabled);assert.equal(result.state,'not_attempted',mode);assert.equal(f.counts().providerCalls,0);assert.equal(f.counts().receipts,1);}
});
test('ambiguous provider outcome and failed receipt write never permit automatic resend',async()=>{
 for(const [mode,state] of [['unknown','outcome_unknown'],['sink_failure','receipt_pending']]){const f=fixture(mode),result=await processEnrollmentSigning(f.task,f.services,enabled);assert.equal(result.state,state);assert.equal(result.reconciliationRequired,true);assert.equal(result.automaticRetryAllowed,false);assert.equal(f.counts().providerCalls,1);assert.equal((await processEnrollmentSigning(f.task,f.services,enabled)).state,'already_started');assert.equal(f.counts().providerCalls,1);}
});
test('cancelled sends retain bounded admission until ignored provider IO actually settles',async()=>{
 const fixtures=[fixture(),fixture()],controllers=[new AbortController(),new AbortController()];
 const slow=fixtures.map(f=>{let settle!:(response:Response)=>void,started!:()=>void;const pending=new Promise<Response>(resolve=>{settle=resolve;}),observed=new Promise<void>(resolve=>{started=resolve;});f.services.providerFetch=async()=>{started();return pending;};return {settle,observed};});
 const requests=fixtures.map((f,i)=>processEnrollmentSigning(f.task,f.services,{...enabled,signal:controllers[i].signal}));await Promise.all(slow.map(s=>s.observed));controllers.forEach(c=>c.abort());
 for(const result of await Promise.all(requests)){assert.equal(result.state,'outcome_unknown');assert.equal(result.receiptStored,true);}
 const next=fixture();assert.equal((await processEnrollmentSigning(next.task,next.services,enabled)).state,'busy');assert.equal(next.counts().apiCalls,0);
 slow.forEach(s=>s.settle(Response.json({documentId:randomUUID()},{status:201})));await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal((await processEnrollmentSigning(next.task,next.services,enabled)).state,'accepted_for_processing');
});

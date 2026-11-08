import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Database } from '../src/core/database.ts';
import { expectedSchemaRevision } from '../src/core/database.ts';
import { processEnrollmentCompletion } from '../src/integrations/completion-orchestrator.ts';
import { r2TargetId } from '../src/integrations/r2-config.ts';

// Isolated orchestration checks,NOT native authority/provider/storage evidence.
function fixture(){
 const task={academyId:randomUUID(),startId:randomUUID()},source={...task,signerId:randomUUID(),documentId:randomUUID(),packageId:randomUUID(),attachmentId:randomUUID(),bindingId:randomUUID(),connectionId:randomUUID(),connectionTargetId:'c'.repeat(64),documentSha256:'a'.repeat(64),sourceFingerprint:'b'.repeat(64),region:'CA',signatureFields:[{id:'Signature1',pageNumber:1,bounds:{x:20,y:40,width:180,height:35}}]};
 const config={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-private-evidence',accessKeyId:'synthetic-evidence-writer',secretAccessKey:'PRIVATE-synthetic-evidence-key',maximumUploadBytes:10485760};let connections=0,queries=0,providerReads=0,selected=0,missing=false;
 const database:Database={async connect(){connections++;return {async query<Row>(sql:string){queries++;let row:unknown;if(sql.includes('schema_revision()'))row={revision:expectedSchemaRevision};else if(sql.startsWith('SELECT public.signature_completion_source('))row={source:missing?null:structuredClone(source)};else row={safe:true};return {rows:[row] as Row[]};},release(){connections--;}};}};
 const services={database,providers:(academy:string,connection:string,target:string)=>{selected++;assert.equal(connections,0);assert.deepEqual([academy,connection,target],[task.academyId,source.connectionId,source.connectionTargetId]);return {region:'CA' as const,apiKey:'PRIVATE-synthetic-key'};},evidenceStores:(academy:string)=>{assert.equal(connections,0);assert.equal(academy,task.academyId);return {configuration:config,targetId:r2TargetId(config)};},providerFetch:(async(_url,options)=>{providerReads++;assert.equal(connections,0);assert.equal(options?.method,'GET');return Response.json({documentId:source.documentId,status:'Sent',metaData:{kavoshPackageId:source.packageId,kavoshContentAttachmentId:source.attachmentId,kavoshContentBindingId:source.bindingId,kavoshDocumentSha256:source.documentSha256},signerDetails:[]});}) as typeof fetch};
 return {task,source,services,missing:()=>{missing=true;},counts:()=>({connections,queries,providerReads,selected})};
}
test('disabled cancelled and caller-overridden completion tasks perform no dependency calls',async()=>{
 const f=fixture();assert.equal((await processEnrollmentCompletion(f.task,f.services)).state,'disabled');await assert.rejects(processEnrollmentCompletion(f.task,f.services,{enabled:true,signal:AbortSignal.abort()}),{code:'SIGNATURE_COMPLETION_INTERRUPTED'});for(const raw of [{...f.task,documentId:randomUUID()},{...f.task,admissionCleared:true},{...f.task,sourceFingerprint:'a'.repeat(64)}])await assert.rejects(processEnrollmentCompletion(raw,f.services,{enabled:true}),{code:'INVALID_SIGNATURE_COMPLETION_TARGET'});assert.deepEqual(f.counts(),{connections:0,queries:0,providerReads:0,selected:0});
});
test('unavailable native authority selects no provider and a pending bound document performs one read with no evidence write',async()=>{
 const absent=fixture();absent.missing();assert.equal((await processEnrollmentCompletion(absent.task,absent.services,{enabled:true})).state,'source_unavailable');assert.equal(absent.counts().selected,0);assert.equal(absent.counts().providerReads,0);assert.equal(absent.counts().connections,0);
 const f=fixture(),result=await processEnrollmentCompletion(f.task,f.services,{enabled:true});assert.equal(result.state,'not_completed');assert.equal(result.evidenceRecorded,false);assert.equal(result.admissionCleared,false);assert.deepEqual(f.counts(),{connections:0,queries:3,providerReads:1,selected:1});
});
test('provider/storage configuration failures are redacted and invalid evidence targets cause zero provider IO',async()=>{
 const f=fixture();for(const services of [{...f.services,providers:()=>null},{...f.services,evidenceStores:()=>null},{...f.services,providers:()=>{throw Error('PRIVATE operator credentials');}},{...f.services,evidenceStores:()=>{throw Error('PRIVATE operator credentials');}},{...f.services,evidenceStores:()=>({...f.services.evidenceStores(f.task.academyId),targetId:'0'.repeat(64)})}])await assert.rejects(processEnrollmentCompletion(f.task,services,{enabled:true}),e=>{assert.equal((e as {code:string}).code,'SIGNATURE_COMPLETION_NOT_CONFIGURED');assert.doesNotMatch(String(e),/PRIVATE|credentials/);return true;});assert.equal(f.counts().providerReads,0);assert.equal(f.counts().connections,0);
});

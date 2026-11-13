import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { expectedSchemaRevision,type Database } from '../src/core/database.ts';
import { processOneSignatureCompletion } from '../src/integrations/signature-completion-job-worker.ts';

function fixture(){
 const academyId=randomUUID(),startId=randomUUID(),workerId=randomUUID(),lease=randomUUID();
 let live=0,claims=0,finishes=0,providers=0,malformed=false,idle=false,lost=false,sourceMissing=true;
 const database:Database={async connect(){live++;return {release(){live--;},async query<Row>(sql:string,values?:unknown[]){
  let row:unknown={safe:true};
  if(sql.includes('schema_revision()'))row={revision:expectedSchemaRevision};
  else if(sql.startsWith('SELECT * FROM public.claim_signature_completion_job(')){claims++;if(idle)return{rows:[]};row={academy_id:malformed?randomUUID():academyId,purpose:'unified_enrollment',start_id:startId,lease_token:lease,source_fingerprint:'a'.repeat(64),attempt_no:1};}
  else if(sql.startsWith('SELECT public.finish_signature_completion_job(')){finishes++;assert.equal(values?.[3],lease);assert.equal(values?.[4],'unavailable');assert.equal(values?.[5],null);row={recorded:!lost};}
  else if(sql.startsWith('SELECT public.signature_completion_source(')){assert.equal(sourceMissing,true);row={source:null};}
  return {rows:[row] as Row[]};
 }};}};
 const services={database,providers:()=>{providers++;throw Error('PRIVATE');},evidenceStores:()=>null};
 return {input:{academyIds:[academyId],workerId},services,counts:()=>({live,claims,finishes,providers}),malformed:()=>{malformed=true;},idle:()=>{idle=true;},lost:()=>{lost=true;}};
}
test('completion worker is opt-in and rejects invalid input without opening a connection',async()=>{
 const f=fixture();assert.equal((await processOneSignatureCompletion(f.input,f.services)).state,'disabled');assert.equal((await processOneSignatureCompletion(f.input,f.services,{enabled:true,signal:AbortSignal.abort()})).state,'interrupted');
 for(const raw of [{...f.input,retrySeconds:59},{...f.input,academyIds:[]},{...f.input,documentId:randomUUID()}])await assert.rejects(processOneSignatureCompletion(raw,f.services,{enabled:true}),{code:'INVALID_SIGNATURE_COMPLETION_WORKER'});
 assert.deepEqual(f.counts(),{live:0,claims:0,finishes:0,providers:0});
});
test('empty queue and foreign claim never select providers or write a completion',async()=>{
 const empty=fixture();empty.idle();assert.equal((await processOneSignatureCompletion(empty.input,empty.services,{enabled:true})).state,'idle');assert.deepEqual(empty.counts(),{live:0,claims:1,finishes:0,providers:0});
 const foreign=fixture();foreign.malformed();await assert.rejects(processOneSignatureCompletion(foreign.input,foreign.services,{enabled:true}),{code:'SIGNATURE_COMPLETION_QUEUE_UNAVAILABLE'});assert.deepEqual(foreign.counts(),{live:0,claims:1,finishes:0,providers:0});
});
test('missing source records a generic retry, and a lost lease cannot be reported as successful',async()=>{
 for(const lost of [false,true]){const f=fixture();if(lost)f.lost();const result=await processOneSignatureCompletion(f.input,f.services,{enabled:true});assert.equal(result.state,lost?'lease_lost':'unavailable');assert.equal(result.admissionCleared,false);assert.equal(result.paymentCleared,false);assert.deepEqual(f.counts(),{live:0,claims:1,finishes:1,providers:0});assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);}
});

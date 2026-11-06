import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { agreementFixture,reviewedAgreementContent } from './agreement-fixture.ts';
import { validateUnsignedPdf } from '../src/files/pdf-validation.ts';
import { detectContentSignature } from '../src/files/content-signature.ts';
import { processOneCopy } from '../src/files/copy-worker.ts';
import { prepareStoredBoldSignRequest } from '../src/integrations/boldsign-stored-request.ts';
import { r2TargetId } from '../src/integrations/r2-config.ts';
import type { Database } from '../src/core/database.ts';

const python=process.env.TEST_PDF_PYTHON_BINARY;
if(process.env.PDF_VALIDATION_TEST_REQUIRED==='true'&&!python)throw new Error('PDF_TEST_INTERPRETER_REQUIRED');
test('approved signing source,real PDF parsing,verified-copy policy,conditional measured read and durable reservation work together without a provider send',{skip:!python},async()=>{
 const f=await agreementFixture();try{
  const generated=spawnSync(python!,['-I','-B',fileURLToPath(new URL('./fixtures/pdf-fixtures.py',import.meta.url))],{env:{NODE_ENV:'test',TZ:'UTC'},encoding:'utf8',timeout:10000,maxBuffer:2_097_152});assert.equal(generated.status,0,generated.stderr);const bytes=Buffer.from(JSON.parse(generated.stdout).ordinary,'base64');
  const binding=await reviewedAgreementContent(f,f.t.id,{bytes,async inspect(content){const now=Date.now();return {outcome:'no_detection',bytes:content.length,sha256:createHash('sha256').update(content).digest('hex'),etag:'"synthetic-etag"',providerContentType:'application/octet-stream',signature:await detectContentSignature(content),pdfValidation:await validateUnsignedPdf(content,{pythonPath:python!}),databaseObservation:{formatVersion:1,engineVersion:'1.5.4',databaseVersion:30001,databaseCreatedAt:new Date(Math.floor((now-60000)/1000)*1000).toISOString().replace('.000Z','Z'),observedAt:new Date(now).toISOString(),observedBeforeAt:new Date(now).toISOString(),timeZone:'UTC',maximumAgeSeconds:172800}};}});
  const pkg=await f.prepare();assert.equal(pkg.response.status,201);const attached=await f.request('agreement-packages/'+pkg.body.data.id+'/content',{bindingId:binding.id,reason:'Reviewed parsed original'});assert.equal(attached.response.status,201);
  const request=await f.request('agreement-packages/'+pkg.body.data.id+'/send-requests',{attachmentId:attached.body.data.id,options:{title:'Private reviewed original',message:'Review',expiryDays:30},dispatchWithinMinutes:60,reason:'Reviewed signing intention'});assert.equal(request.response.status,201);const id=request.body.data.id,path='signature-send-requests/'+id+'/dispatch-source';
  assert.equal((await f.request(path)).body.data.original,null);assert.equal((await f.request(path+'?copyId='+randomUUID())).response.status,404);
  const reader={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-signing-copies',accessKeyId:'synthetic-original-reader',secretAccessKey:'synthetic-PRIVATE-original-reader-key',maximumUploadBytes:100000},target=r2TargetId(reader);
  const sourceTarget=(await f.pg.query<{source:{storageTargetId:string}}>('SELECT source FROM public.agreement_content_bindings WHERE id=$1',[binding.id])).rows[0].source.storageTargetId;
  const route=await f.request('storage/routes',{definition:{name:'Signing private originals',enabled:true,sourceTargetId:sourceTarget,destinationTargetId:target},reason:'Reviewed separate copy target'});assert.equal(route.response.status,201,JSON.stringify(route.body));
  const copy=await f.request('files/'+binding.fileId+'/copies',{fileVersion:1,inspectionId:binding.inspectionId,attemptNo:1,routeId:route.body.data.id,routeVersion:1});assert.equal(copy.response.status,202,JSON.stringify(copy.body));const copyId=copy.body.data.id;
  assert.equal((await f.request(path+'?copyId='+copyId)).response.status,409,'queued copy is not original retrieval evidence');
  const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}};await c.query('SET ROLE kavosh_file_worker');return c;}};
  // Only storage/scanner outcomes are synthetic. PDF parsing and actual
  // database source/approval/receipt guards run normally;no cloud IO is claimed.
  try{assert.deepEqual(await processOneCopy(database,[f.a],randomUUID(),async task=>({outcome:'written_verified',bytes:task.expectedBytes,sha256:task.expectedSha256,source:{storageTargetId:task.sourceTargetId,etag:'"synthetic-etag"'},destination:{storageTargetId:target,etag:'"verified-original"'}})),{claimed:true,recorded:true});}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  assert.equal((await f.request(path+'?copyId='+copyId)).response.status,409,'copy approval must not silently enable serving');
  const serving=await f.request('storage/routes/'+route.body.data.id+'/change',{expectedVersion:1,definition:{...route.body.data.definition,serving:{enabled:true,allowedMimeTypes:['application/pdf'],maximumLinkSeconds:30}},reason:'Explicit reviewed private original serving'});assert.equal(serving.response.status,200);
  const source=await f.request(path+'?copyId='+copyId);assert.equal(source.response.status,200,JSON.stringify(source.body));assert.equal(source.body.data.originalEvidenceAvailable,true);assert.equal(source.body.data.originalBytesRetrieved,false);assert.equal(source.body.data.fileSafetyCleared,false);assert.equal(source.body.data.original.copyId,copyId);
  let reads=0;const prepared=await prepareStoredBoldSignRequest(reader,{purpose:'unified_enrollment',draft:source.body.data.draft},source.body.data.original,{}, {destroy(){},async handle(req:{method:string;path:string;headers:Record<string,string>}){reads++;assert.equal(req.method,'GET');assert.equal(req.path,`/${reader.bucket}/academies/${f.a}/clean/${binding.fileId}`);assert.equal(req.headers['if-match'],'"verified-original"');return {response:{statusCode:200,headers:{'content-type':'application/octet-stream','content-length':String(bytes.length),etag:'"verified-original"'},body:Readable.from([bytes])}};}});
  assert.equal(reads,1);assert.equal(prepared.original.sha256,binding.sha256);assert.deepEqual(Buffer.from(JSON.parse(prepared.body).Files[0].split(',')[1],'base64'),bytes);assert.equal(prepared.signingProviderRequestMade,false);
  // Reauthorize after IO,before reserving the exact newly built manifest.
  const current=await f.request(path+'?copyId='+copyId);assert.equal(current.response.status,200);assert.deepEqual(current.body.data.draft,source.body.data.draft);assert.deepEqual(current.body.data.original,source.body.data.original);
  const manifest={requestSha256:prepared.receipt.requestSha256,requestBytes:prepared.receipt.requestBytes,documentSha256:prepared.receipt.documentSha256};
  const reserved=await f.request('signature-send-requests/'+id+'/attempts',manifest);assert.equal(reserved.response.status,201);const dispatch='signature-send-requests/'+id+'/attempts/'+reserved.body.data.id+'/dispatch';assert.equal((await f.request(dispatch,manifest)).response.status,201);const stopped=await f.request(dispatch+'/outcome',{state:'not_attempted'});assert.equal(stopped.response.status,201);assert.equal(stopped.body.data.admissionCleared,false);
  assert.equal((await f.pg.query('SELECT * FROM public.signature_webhook_inbox')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.file_download_grants')).rows.length,0,'internal preparation must not create/log a bearer URL');
  const disabled=await f.request('storage/routes/'+route.body.data.id+'/change',{expectedVersion:2,definition:{...serving.body.data.definition,serving:{enabled:false,allowedMimeTypes:['application/pdf'],maximumLinkSeconds:30}},reason:'Disable subsequent original access'});assert.equal(disabled.response.status,200);assert.equal((await f.request(path+'?copyId='+copyId)).response.status,409);
 }finally{await f.pg.close();}
});

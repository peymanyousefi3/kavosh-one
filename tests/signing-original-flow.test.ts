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
  const reserved=await f.request('signature-send-requests/'+id+'/attempts',manifest);assert.equal(reserved.response.status,201);const dispatch='signature-send-requests/'+id+'/attempts/'+reserved.body.data.id+'/dispatch';
  const bound=(fingerprint=source.body.data.original.sourceFingerprint,selectedCopy=copyId)=>({...manifest,original:{copyId:selectedCopy,sourceFingerprint:fingerprint}});
  assert.equal((await f.request(dispatch,bound('0'.repeat(64)))).body.error.code,'SIGNATURE_DISPATCH_ORIGINAL_CHANGED');assert.equal((await f.request(dispatch,bound(undefined,randomUUID()))).body.error.code,'SIGNATURE_DISPATCH_ORIGINAL_CHANGED');
  const policy=await f.request('storage/routes/'+route.body.data.id+'/change',{expectedVersion:2,definition:{...serving.body.data.definition,serving:{enabled:true,allowedMimeTypes:['application/pdf'],maximumLinkSeconds:20}},reason:'Change policy after document retrieval'});assert.equal(policy.response.status,200);
  assert.equal((await f.request(dispatch,bound())).body.error.code,'SIGNATURE_DISPATCH_ORIGINAL_CHANGED','even an enabled policy amendment invalidates the earlier fingerprint');
  const refreshed=await f.request(path+'?copyId='+copyId);assert.equal(refreshed.response.status,200);assert.notEqual(refreshed.body.data.original.sourceFingerprint,source.body.data.original.sourceFingerprint);const input=bound(refreshed.body.data.original.sourceFingerprint),key=randomUUID();
  if(process.env.TEST_DATABASE_URL){
   const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.signature_dispatch_starts) starts,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events')).rows[0],before=await counts();
   // Disposable DB only: invalidate the actual verified copy AFTER the API
   // source check and before the production final persistence guard.
   await f.pg.exec(`CREATE FUNCTION public.synthetic_original_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN UPDATE public.file_copy_jobs SET state='blocked' WHERE copy_id='${copyId}';RETURN NEW;END $$;CREATE TRIGGER aa_synthetic_original_change BEFORE INSERT ON public.signature_dispatch_starts FOR EACH ROW EXECUTE FUNCTION public.synthetic_original_change()`);
   try{assert.equal((await f.request(dispatch,input,'master',{key})).body.error.code,'SIGNATURE_DISPATCH_ORIGINAL_CHANGED');}finally{await f.pg.exec('DROP TRIGGER aa_synthetic_original_change ON public.signature_dispatch_starts;DROP FUNCTION public.synthetic_original_change()');}
   assert.deepEqual(await counts(),before);assert.equal((await f.pg.query('SELECT state FROM public.file_copy_jobs WHERE copy_id=$1',[copyId])).rows[0].state,'verified');console.log(JSON.stringify({case:'original-final-native-guard',rolledBack:true}));
  }
  const started=await f.request(dispatch,input,'master',{key});assert.equal(started.response.status,201,JSON.stringify(started.body));assert.equal(started.body.data.originalCopyBound,true);assert.equal(started.body.data.original_source_fingerprint,input.original.sourceFingerprint);assert.equal((await f.request(dispatch)).body.data.start.originalCopyCurrent,true);
  const stored=(await f.pg.query('SELECT original_source FROM public.signature_dispatch_starts WHERE id=$1',[started.body.data.id])).rows[0].original_source as {fileId:string;copyId:string};assert.equal(stored.fileId,binding.fileId);assert.equal(stored.copyId,copyId);
  await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query('UPDATE public.signature_dispatch_starts SET original_source=$1::jsonb WHERE id=$2',['{}',started.body.data.id]),/permission denied/i);await assert.rejects(f.pg.query('INSERT INTO public.signature_dispatch_starts(academy_id,id,attempt_id,actor_id,audit_id,original_source) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[f.a,randomUUID(),reserved.body.data.id,f.actors.master.person,randomUUID(),'{}']),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
  assert.equal((await f.request(dispatch,input,'master',{key})).response.status,409);
  assert.equal((await f.pg.query('SELECT * FROM public.signature_webhook_inbox')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.file_download_grants')).rows.length,0,'internal preparation must not create/log a bearer URL');
  const disabled=await f.request('storage/routes/'+route.body.data.id+'/change',{expectedVersion:3,definition:{...policy.body.data.definition,serving:{enabled:false,allowedMimeTypes:['application/pdf'],maximumLinkSeconds:20}},reason:'Disable subsequent original access'});assert.equal(disabled.response.status,200);assert.equal((await f.request(path+'?copyId='+copyId)).response.status,409);assert.equal((await f.request(dispatch)).body.data.start.originalCopyCurrent,false);
  const stopped=await f.request(dispatch+'/outcome',{state:'not_attempted'});assert.equal(stopped.response.status,201);assert.equal(stopped.body.data.admissionCleared,false);assert.equal(stopped.body.data.source_current,false,'late outcome must retain the changed original policy,not only contact validity');
 }finally{await f.pg.close();}
});

import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { operationsFixture } from './operations-fixture.ts';
import { processOneInspection,type InspectionResult } from '../src/files/inspection-worker.ts';
import { validateImage } from '../src/files/image-validation.ts';
import { validateUnsignedPdf } from '../src/files/pdf-validation.ts';
import { validateText } from '../src/files/text-validation.ts';
import { detectContentSignature } from '../src/files/content-signature.ts';
import type { Database } from '../src/core/database.ts';
import type { VideoValidation } from '../src/files/video-validation.ts';

export const config={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-copy-intentions',accessKeyId:'synthetic-id',secretAccessKey:'synthetic-not-real-secret',maximumUploadBytes:100000};
export const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex'),target=hash(Buffer.from(JSON.stringify([config.accountId,config.jurisdiction,config.bucket]))),python=process.env.TEST_PDF_PYTHON_BINARY;
export async function fixture(base?:Awaited<ReturnType<typeof operationsFixture>>,destinationTargetId='b'.repeat(64)){
 const f=base??await operationsFixture({connections:()=>config});for(const cap of ['files.view','files.edit','files.upload'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.managerRole,cap]);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'files.view','allow') ON CONFLICT DO NOTHING",[f.a,f.staffRole]);
 assert.equal((await f.request('storage-policy',{expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100000,maximumReservedBytes:2000000,maximumFiles:100,allowedMimeTypes:['image/png','application/pdf','text/plain'],reason:'Synthetic copy source uploads'})).response.status,200);
 const route=(await f.request('storage/routes',{definition:{name:'Approved staging destination',enabled:true,sourceTargetId:target,destinationTargetId},reason:'Synthetic metadata-only approved route'})).body.data;
 const bytes=await sharp({create:{width:8,height:4,channels:3,background:'red'}}).png().toBuffer();
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}};await c.query('SET ROLE kavosh_file_worker');return c;}};
 const expire=(id:string)=>f.pg.query("UPDATE public.file_upload_grants SET issued_at=date_trunc('second',clock_timestamp())-interval '10 minutes',expires_at=date_trunc('second',clock_timestamp())-interval '5 minutes' WHERE file_id=$1",[id]);
 async function file(options:{content?:Buffer;mime?:string;class?:string;hub?:string;person?:string;academy?:boolean;domain?:string;workEngagementId?:string;observation?:boolean;expire?:boolean;videoValidation?:VideoValidation}={}){
  const b=options.content??bytes,mime=options.mime??'image/png',made=await f.request('files',{anchor:options.class?{kind:'class',id:options.class}:options.academy?{kind:'academy'}:options.person?{kind:'person',id:options.person}:{kind:'hub',id:options.hub??f.hub},domain:options.domain??'general',...(options.workEngagementId?{workEngagementId:options.workEngagementId}:{}),name:'Synthetic source',claimedMimeType:mime,expectedBytes:b.length,expectedSha256:hash(b)});assert.equal(made.response.status,201,JSON.stringify(made.body));const id=made.body.data.id;
  const grant=await f.request('files/'+id+'/upload-link',{expectedMetadataVersion:1});assert.equal(grant.response.status,201);const inspection=await f.request('files/'+id+'/inspection',{expectedMetadataVersion:1,grantId:grant.body.data.id});assert.equal(inspection.response.status,202);
  const now=Date.now(),observation={formatVersion:1 as const,engineVersion:'1.5.4',databaseVersion:30001,databaseCreatedAt:new Date(Math.floor((now-60000)/1000)*1000).toISOString().replace('.000Z','Z'),observedAt:new Date(now).toISOString(),observedBeforeAt:new Date(now).toISOString(),timeZone:'UTC',maximumAgeSeconds:172800};
  const result:InspectionResult={outcome:'no_detection',bytes:b.length,sha256:hash(b),etag:'"synthetic-copy-source"',providerContentType:'application/octet-stream',signature:await detectContentSignature(b),...(mime==='image/png'?{imageValidation:await validateImage(b,mime)}:{}),...(mime==='application/pdf'?{pdfValidation:await validateUnsignedPdf(b,{pythonPath:python!})}:{}),...(mime==='text/plain'?{textValidation:validateText(b)}:{}),...(options.observation===false?{}:{databaseObservation:observation})};
  if(options.videoValidation&&result.outcome==='no_detection')result.videoValidation=options.videoValidation;
  try{assert.deepEqual(await processOneInspection(database,[f.a],randomUUID(),async()=>result),{claimed:true,recorded:true});}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  if(options.expire!==false)await expire(id);return {id,grantId:grant.body.data.id,input:{fileVersion:1,inspectionId:inspection.body.data.id,attemptNo:1,routeId:route.id,routeVersion:1}};
 }
 const copy=(item:Awaited<ReturnType<typeof file>>,patch:Record<string,unknown>={},as='master',key?:string)=>f.request('files/'+item.id+'/copies',{...item.input,...patch},as,{key});
 return {...f,route,bytes,file,copy,expire,database};
}
// Use the actual old native entrypoint,not a current worker or faked readiness.
export async function historicalImage(f:Awaited<ReturnType<typeof fixture>>,revision:358|359){
 assert.equal((await f.pg.query('SELECT public.schema_revision() revision')).rows[0].revision,revision);
 const made=await f.request('files',{anchor:{kind:'hub',id:f.hub},name:'Historical image',claimedMimeType:'image/png',expectedBytes:f.bytes.length,expectedSha256:hash(f.bytes)});assert.equal(made.response.status,201);const id=made.body.data.id,grant=await f.request('files/'+id+'/upload-link',{expectedMetadataVersion:1}),inspection=await f.request('files/'+id+'/inspection',{expectedMetadataVersion:1,grantId:grant.body.data.id});assert.equal(inspection.response.status,202);
 const now=Date.now(),observation={formatVersion:1,engineVersion:'1.5.4',databaseVersion:30001,databaseCreatedAt:new Date(Math.floor((now-60000)/1000)*1000).toISOString().replace('.000Z','Z'),observedAt:new Date(now).toISOString(),observedBeforeAt:new Date(now).toISOString(),timeZone:'UTC',maximumAgeSeconds:172800},signature=await detectContentSignature(f.bytes),image=await validateImage(f.bytes,'image/png'),c=await f.database.connect();
 try{const job=(await c.query('SELECT * FROM public.claim_file_inspection($1,$2,30)',[[f.a],randomUUID()])).rows[0];assert.equal((await c.query('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,NULL,NULL,NULL) recorded',[f.a,inspection.body.data.id,job.lease_token,'no_detection','MEASURED_NO_DETECTION',f.bytes.length,hash(f.bytes),'"historical-image"','application/octet-stream',JSON.stringify(signature),JSON.stringify(image),JSON.stringify(observation)])).rows[0].recorded,true);}finally{c.release();if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 await f.expire(id);return{id,grantId:grant.body.data.id,input:{fileVersion:1,inspectionId:inspection.body.data.id,attemptNo:1,routeId:f.route.id,routeVersion:1}};
}

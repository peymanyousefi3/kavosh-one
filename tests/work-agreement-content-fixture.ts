import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { workAgreementFixture } from './work-agreement-fixture.ts';
import { processOneInspection,type InspectionResult } from '../src/files/inspection-worker.ts';
import type { Database } from '../src/core/database.ts';

// Synthetic object/scanner evidence is actual stored test data,not a real file
// upload,complete PDF parse,current malware clearance or live signing result.
export const bytes=Buffer.from('%PDF-1.7\nPRIVATE synthetic worker framework\n'),sha256=createHash('sha256').update(bytes).digest('hex'),object={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-work-content',accessKeyId:'synthetic-id',secretAccessKey:'synthetic-not-real-secret',maximumUploadBytes:100000};
export const inspection={outcome:'no_detection',bytes:bytes.length,sha256,etag:'"synthetic-etag"',providerContentType:'application/pdf',signature:{detector:'file-type@22.3.0',sampleBytes:bytes.length,sampleSha256:sha256,mime:'application/pdf',extension:'pdf'}} satisfies InspectionResult;
export const field=(id:string,pageNumber=1)=>({id,fieldType:'Signature',isRequired:true,pageNumber,bounds:{x:20,y:40,width:180,height:35}}),routing={version:1,parties:[{role:'worker',fields:[field('WorkerSignature')]},{role:'academy_representative',fields:[field('AcademySignature',2)]}]};
export async function workContentFixture(throughSchema?:number){const legacy=throughSchema!==undefined&&throughSchema<=110;const f=await workAgreementFixture({throughSchema,connections:()=>object});try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['files.view',...!legacy?['work-files.view','work-files.edit','work-files.upload']:[]])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,role,cap]);
 const p=await f.prepare();assert.equal(p.response.status,201,JSON.stringify(p.body));const preparation=p.body.data;
 assert.equal((await f.request('storage-policy',{expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100000,maximumReservedBytes:1000000,maximumFiles:100,allowedMimeTypes:['application/pdf'],reason:'Synthetic PDF inspection policy'})).response.status,200);
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}};await c.query('SET ROLE kavosh_file_worker');return c;}};
 async function file(options:{hub?:string|null;domain?:string;workEngagementId?:string;inspect?:boolean;expire?:boolean}={}){
  const domain=options.domain??(!legacy?'work_private':'agreement_definition'),r=await f.request('files',{anchor:options.hub===null?{kind:'academy'}:{kind:'hub',id:options.hub??f.hub},domain,...domain==='work_private'?{workEngagementId:options.workEngagementId??f.e.id}:{},name:'PRIVATE worker.pdf',claimedMimeType:'application/pdf',expectedBytes:bytes.length,expectedSha256:sha256});assert.equal(r.response.status,201,JSON.stringify(r.body));const id=r.body.data.id,g=await f.request('files/'+id+'/upload-link',{expectedMetadataVersion:1});assert.equal(g.response.status,201,JSON.stringify(g.body));const scan=await f.request('files/'+id+'/inspection',{expectedMetadataVersion:1,grantId:g.body.data.id});assert.equal(scan.response.status,202);
  if(options.inspect!==false)try{
   if(throughSchema===undefined)assert.deepEqual(await processOneInspection(database,[f.a],randomUUID(),async()=>inspection),{claimed:true,recorded:true});
   else{
    // Use the actual selected historical schema's native worker entrypoints.
    // Current JS workers refuse old storage; never spoof schema readiness.
    const c=await database.connect();try{const task=(await c.query<{inspection_id:string;lease_token:string}>('SELECT * FROM public.claim_file_inspection($1,$2,60)',[[f.a],randomUUID()])).rows[0];assert.equal(task.inspection_id,scan.body.data.id);const done=await c.query<{recorded:boolean}>('SELECT public.finish_file_inspection($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) recorded',[f.a,task.inspection_id,task.lease_token,'no_detection','MEASURED_NO_DETECTION',bytes.length,sha256,inspection.etag,inspection.providerContentType,JSON.stringify(inspection.signature),null]);assert.equal(done.rows[0].recorded,true);}finally{c.release();}
   }
  }finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  if(options.expire!==false)await f.pg.query("UPDATE public.file_upload_grants SET issued_at=date_trunc('second',clock_timestamp())-interval '10 minutes',expires_at=date_trunc('second',clock_timestamp())-interval '5 minutes' WHERE file_id=$1",[id]);return {id,inspectionId:scan.body.data.id};
 }
 const pdf=await file(),input={fileId:pdf.id,fileVersion:1,inspectionId:pdf.inspectionId,attemptNo:1,routing,contentReviewed:true,routingReviewed:true,contentAttestation:'PRIVATE exact two-party PDF and geometry reviewed',reason:'PRIVATE source review'},path='payroll/work-agreements/'+preparation.id+'/content';
 const attach=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request(path,{...input,...patch},as,{key});return {...f,preparation,pdf,file,input,path,attach};
 }catch(e){await f.pg.close();throw e;}}


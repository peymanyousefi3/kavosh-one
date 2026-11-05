import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { operationsFixture } from './operations-fixture.ts';
import { processOneInspection,type InspectionResult } from '../src/files/inspection-worker.ts';
import type { Database } from '../src/core/database.ts';

const connection={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-package-content',accessKeyId:'synthetic-id',secretAccessKey:'synthetic-not-real-secret',maximumUploadBytes:100000};
export async function agreementFixture(throughSchema?:number) {
 const f=await operationsFixture({connections:()=>connection,throughSchema}),country=randomUUID(),region=randomUUID(),city=randomUUID(),connectionId=randomUUID();
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['signatures.view','signatures.edit','enrollments.view','students.view','guardians.view','families.view','agreements.view','files.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 await f.pg.query("INSERT INTO public.countries(academy_id,id,code,name) VALUES($1,$2,'CA','Canada')",[f.a,country]);
 await f.pg.query("INSERT INTO public.regions(academy_id,id,country_id,code,name) VALUES($1,$2,$3,'ON','Ontario')",[f.a,region,country]);
 await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Toronto')",[f.a,city,region]);
 await f.pg.query("UPDATE public.hubs SET city_id=$1,time_zone='America/Toronto',currency='CAD' WHERE academy_id=$2",[city,f.a]);
 await f.pg.query('UPDATE public.people SET hub_id=$1 WHERE id=$2',[f.hub,f.actors.peer.person]);
 const student=f.actors.peer.person,signer=f.actors.staff.person;
 assert.equal((await f.request('students',{personId:student,legalName:'PRIVATE Student',dateOfBirth:'2014-03-20',recruiter:{kind:'academy'}})).response.status,201);
 for(const name of ['staff','manager'])assert.equal((await f.request('guardians',{personId:f.actors[name].person,legalName:'PRIVATE Guardian '+name})).response.status,201);
 const relationship=await f.request('students/'+student+'/guardians',{guardianId:signer,relationship:'legal_guardian',reason:'PRIVATE family evidence'});assert.equal(relationship.response.status,201,JSON.stringify(relationship.body));
 const course=await f.request('courses',{code:'SIGN',name:'Signature test course'});assert.equal(course.response.status,201);
 const c=await f.request('classes',{hubId:f.hub,courseId:course.body.data.id,courseVersion:1,name:'Signature test class',mode:'in_person',schedule:{oneOff:[{start:'2027-01-01T10:00',end:'2027-01-01T11:00'}]}});assert.equal(c.response.status,201,JSON.stringify(c.body));
 const e=await f.request('classes/'+c.body.data.id+'/enrollments',{studentId:student,studentProfileVersion:1,joinsOn:'2027-01-01',reason:'PRIVATE membership'});assert.equal(e.response.status,201,JSON.stringify(e.body));
 const t=await f.request('agreements',{hubId:f.hub,name:'Unified package test',legalEntityName:'Kavosh Al and Robotics Academy Inc.',countryCode:'CA',jurisdiction:'Ontario',languages:[{locale:'en',title:'Unified contract',body:'PRIVATE contract, waiver and consent'}],provider:{region:'CA',templateId:randomUUID()},available:true,reason:'PRIVATE template evidence'});assert.equal(t.response.status,201);
 await f.pg.query("INSERT INTO public.signature_connections(id,academy_id,region,environment,enabled) VALUES($1,$2,'CA','Test',true)",[connectionId,f.a]);
 const input={enrollmentVersion:1,templateId:t.body.data.id,templateVersion:1,signerId:signer,relationshipId:relationship.body.data.id,connectionId,locale:'en',reason:'PRIVATE preparation reason'};
 const path='enrollments/'+e.body.data.id+'/agreement-packages';
 const prepare=(body:unknown=input,as='master',key?:string)=>f.request(path,body,as,key?{key}:{});
 return {...f,student,signer,connection:connectionId,c:c.body.data,e:e.body.data,t:t.body.data,relationship:relationship.body.data,input,path,prepare};
}
export async function reviewedAgreementContent(f:Awaited<ReturnType<typeof agreementFixture>>,templateId=f.t.id) {
 // Synthetic storage/scanner results: actual database evidence, not a real PDF
 // parse, physical object upload, live provider or current malware clearance.
 const bytes=Buffer.from('%PDF-1.7\nPRIVATE synthetic package agreement\n'),sha256=createHash('sha256').update(bytes).digest('hex');
 const result={outcome:'no_detection',bytes:bytes.length,sha256,etag:'"synthetic-etag"',providerContentType:'application/pdf',signature:{detector:'file-type@22.3.0',sampleBytes:bytes.length,sampleSha256:sha256,mime:'application/pdf',extension:'pdf'}} satisfies InspectionResult;
 if(!(await f.pg.query('SELECT 1 FROM public.file_storage_policies WHERE academy_id=$1',[f.a])).rows.length)assert.equal((await f.request('storage-policy',{expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100000,maximumReservedBytes:1000000,maximumFiles:100,allowedMimeTypes:['application/pdf'],reason:'Synthetic agreement content'})).response.status,200);
 const file=await f.request('files',{anchor:{kind:'hub',id:f.hub},domain:'agreement_definition',name:'PRIVATE exact agreement.pdf',claimedMimeType:'application/pdf',expectedBytes:bytes.length,expectedSha256:sha256});assert.equal(file.response.status,201,JSON.stringify(file.body));
 const fileId=file.body.data.id,grant=await f.request('files/'+fileId+'/upload-link',{expectedMetadataVersion:1});assert.equal(grant.response.status,201,JSON.stringify(grant.body));
 const scan=await f.request('files/'+fileId+'/inspection',{expectedMetadataVersion:1,grantId:grant.body.data.id});assert.equal(scan.response.status,202);
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}};await c.query('SET ROLE kavosh_file_worker');return c;}};
 try{assert.deepEqual(await processOneInspection(database,[f.a],randomUUID(),async()=>result),{claimed:true,recorded:true});}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 await f.pg.query("UPDATE public.file_upload_grants SET issued_at=date_trunc('second',clock_timestamp())-interval '10 minutes',expires_at=date_trunc('second',clock_timestamp())-interval '5 minutes' WHERE file_id=$1",[fileId]);
 const routing={version:1,role:'legal_signer',fields:[{id:'Signature1',fieldType:'Signature',isRequired:true,pageNumber:1,bounds:{x:20,y:40,width:180,height:35}}]};
 const binding=await f.request('agreements/'+templateId+'/content-bindings',{templateVersion:1,fileId,fileVersion:1,inspectionId:scan.body.data.id,attemptNo:1,locale:'en',routing,contentReviewed:true,routingReviewed:true,contentAttestation:'PRIVATE reviewed exact PDF and field layout',reason:'PRIVATE reviewed content'});assert.equal(binding.response.status,201,JSON.stringify(binding.body));
 return {id:binding.body.data.id,fileId,inspectionId:scan.body.data.id,sha256,routing,bytes};
}

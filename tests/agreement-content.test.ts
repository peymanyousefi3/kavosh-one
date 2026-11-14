import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { processOneInspection,type InspectionResult } from '../src/files/inspection-worker.ts';
import type { Database } from '../src/core/database.ts';

// Simulated provider/scanner evidence, deliberately not a structurally valid PDF.
const bytes=Buffer.from('%PDF-1.7\nPRIVATE synthetic agreement\n'),sha256=createHash('sha256').update(bytes).digest('hex');
const result={outcome:'no_detection',bytes:bytes.length,sha256,etag:'"synthetic-etag"',providerContentType:'application/pdf',signature:{detector:'file-type@22.3.0',sampleBytes:bytes.length,sampleSha256:sha256,mime:'application/pdf',extension:'pdf'}} satisfies InspectionResult;
const connection={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-agreement-content',accessKeyId:'synthetic-id',secretAccessKey:'synthetic-not-real-secret',maximumUploadBytes:100000};
async function fixture() {
 const f=await operationsFixture({connections:()=>connection});
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['agreements.view','agreements.edit','files.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 assert.equal((await f.request('storage-policy',{expectedVersion:0,uploadsEnabled:true,maximumFileBytes:100000,maximumReservedBytes:1000000,maximumFiles:100,allowedMimeTypes:['application/pdf'],reason:'Synthetic private PDF uploads'})).response.status,200);
 const t=await f.request('agreements',{hubId:f.hub,name:'Unified contract',legalEntityName:'Kavosh Al and Robotics Academy Inc.',countryCode:'CA',jurisdiction:'Ontario',languages:[{locale:'en',title:'PRIVATE terms',body:'PRIVATE contract, consent and waiver'}],available:true,provider:{region:'CA',templateId:randomUUID()},reason:'PRIVATE source definition'});assert.equal(t.response.status,201,JSON.stringify(t.body));
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}};await c.query('SET ROLE kavosh_file_worker');return c;}};
 async function file(hub=f.hub,domain='agreement_definition',inspect=true) {
  const made=await f.request('files',{anchor:{kind:'hub',id:hub},domain,name:'PRIVATE reviewed.pdf',claimedMimeType:'application/pdf',expectedBytes:bytes.length,expectedSha256:sha256});assert.equal(made.response.status,201,JSON.stringify(made.body));
  const id=made.body.data.id,grant=await f.request('files/'+id+'/upload-link',{expectedMetadataVersion:1});assert.equal(grant.response.status,201,JSON.stringify(grant.body));
  const scan=await f.request('files/'+id+'/inspection',{expectedMetadataVersion:1,grantId:grant.body.data.id});assert.equal(scan.response.status,202,JSON.stringify(scan.body));
  if(inspect){try{assert.deepEqual(await processOneInspection(database,[f.a],randomUUID(),async()=>result),{claimed:true,recorded:true});}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
  // Fixture owner models an expired grant without sleeping five minutes or
  // weakening production expiry checks. No real object upload/scan is claimed.
  await f.pg.query("UPDATE public.file_upload_grants SET issued_at=date_trunc('second',clock_timestamp())-interval '10 minutes',expires_at=date_trunc('second',clock_timestamp())-interval '5 minutes' WHERE file_id=$1",[id]);
  return {id,inspectionId:scan.body.data.id,grantId:grant.body.data.id};
 }
 const pdf=await file(),routing={version:1,role:'legal_signer',fields:[{id:'Signature1',fieldType:'Signature',isRequired:true,pageNumber:1,bounds:{x:20,y:40,width:180,height:35}}]};
 const input={templateVersion:1,fileId:pdf.id,fileVersion:1,inspectionId:pdf.inspectionId,attemptNo:1,locale:'en',routing,contentReviewed:true,routingReviewed:true,contentAttestation:'PRIVATE human attestation of PDF/legal definition equivalence and geometry',reason:'PRIVATE approval reason'};
 const path='agreements/'+t.body.data.id+'/content-bindings';
 const bind=(value:unknown=input,as='master',key?:string)=>f.request(path,value,as,key?{key}:{});
 return {...f,t:t.body.data,pdf,input,path,bind,file};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>,nativeOnly=false){test(name,{skip:nativeOnly&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('optional purpose-bound profile choices persist in the same upper-reviewed content binding without admission or publication claims',async f=>{
 const signature=f.input.routing.fields[0],choice={...signature,id:'PublicChoice',fieldType:'CheckBox',isRequired:false,consentPurpose:'public_profile'},routing={version:2,role:'legal_signer',fields:[signature,choice]};
 const pending=await f.bind({...f.input,routing},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));
 assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);
 const made=await f.approve(pending.body.approval.id,'manager');assert.equal(made.response.status,200,JSON.stringify(made.body));
 const rows=(await f.pg.query<{id:string;routing:unknown}>('SELECT id,routing FROM public.agreement_content_bindings')).rows;assert.deepEqual(rows.map(r=>r.routing),[routing]);
 const read=await f.request('agreement-content-bindings/'+rows[0].id);assert.equal(read.response.status,200,JSON.stringify(read.body));assert.equal(read.body.data.admissionCleared,false);
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.profile_publication_changes')).rows[0].n,0);
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.agreement_packages')).rows[0].n,0);
 for(const bad of [{...routing,version:1},{...routing,fields:[signature,{...choice,isRequired:true}]},{...routing,fields:[signature,{...choice,value:'on'}]}])assert.equal((await f.bind({...f.input,routing:bad})).response.status,400);
});

check('reviewed content binding persists exact inspected source identity and geometry without claiming signing, safe PDF or admission',async f=>{
 const start=performance.now(),queries=f.metrics.businessQueries,made=await f.bind();assert.equal(made.response.status,201,JSON.stringify(made.body));assert.equal(made.body.data.state,'reviewed_binding');
 console.log(JSON.stringify({case:'content-binding-single-request',elapsedMs:Math.round(performance.now()-start),clientQueries:f.metrics.businessQueries-queries}));
 const read=await f.request('agreement-content-bindings/'+made.body.data.id);assert.equal(read.response.status,200);const b=read.body.data;
 assert.equal(b.source.sha256,sha256);assert.equal(b.source.sizeBytes,bytes.length);assert.equal(b.source.templateHash,f.t.definition_hash);assert.equal(b.source.inspectionId,f.pdf.inspectionId);assert.equal(b.source.provider.templateId,f.t.definition.provider.templateId);assert.deepEqual(b.routing,f.input.routing);
 assert.equal(b.content_attestation,f.input.contentAttestation);assert.equal(b.recordedSourceCurrent,true);for(const key of ['readyToSend','admissionCleared','safeToServe','providerContentVerified'])assert.equal(b[key],false);
 assert.equal((await f.request(f.path)).body.data.length,1);assert.equal((await f.pg.query('SELECT * FROM public.agreement_packages')).rows.length,0);
 const audit=(await f.pg.query("SELECT changes FROM public.audit_events WHERE action='agreement.content.bind'")).rows;assert.equal(audit.length,1);assert.ok(!JSON.stringify(audit).includes('PRIVATE'));
 assert.equal((await f.request('files/'+f.pdf.id+'/change',{expectedVersion:1,archived:true})).response.status,200);
 const historical=await f.request('agreement-content-bindings/'+made.body.data.id);assert.equal(historical.response.status,200);assert.equal(historical.body.data.recordedSourceCurrent,false);assert.deepEqual(historical.body.data.source,b.source);assert.deepEqual(historical.body.data.routing,b.routing);
});
check('non-master content approval needs an upper human, bots cannot apply and stale template/file revisions cannot substitute content',async f=>{
 const pending=await f.bind(f.input,'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.pg.query('SELECT * FROM public.agreement_content_bindings')).rows.length,0);
 assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);
 const audience=(await f.pg.query<{person_id:string}>("SELECT n.person_id FROM public.portal_notifications n JOIN public.automation_event_sources s ON s.academy_id=n.academy_id AND s.event_id=n.event_id WHERE s.approval_id=$1 AND s.event_type='approval.applied' AND n.origin='mandatory'",[pending.body.approval.id])).rows.map(n=>n.person_id).sort();
 assert.deepEqual(audience,[f.actors.master.person,f.actors.manager.person,f.actors.staff.person].sort());
 const bot=await f.bind(f.input,'bot');assert.equal(bot.response.status,202,JSON.stringify(bot.body));assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
 const stale=await f.bind(f.input,'staff');assert.equal(stale.response.status,202);
 assert.equal((await f.request('agreements/'+f.t.id+'/change',{expectedVersion:1,name:'Corrected template',reason:'Source change'})).response.status,200);
 const rejected=await f.approve(stale.body.approval.id);assert.equal(rejected.response.status,409);assert.equal(rejected.body.approval.status,'stale');
 const current={...f.input,templateVersion:2},filePending=await f.bind(current,'staff');assert.equal(filePending.response.status,202);
 assert.equal((await f.request('files/'+f.pdf.id+'/change',{expectedVersion:1,name:'Renamed.pdf'})).response.status,200);
 assert.equal((await f.approve(filePending.body.approval.id)).body.approval.status,'stale');assert.equal((await f.bind({...current,fileVersion:2})).response.status,201);
});
check('missing inspection, live upload grant, mismatched file anchor/domain and unsupported locale cannot become reviewed content',async f=>{
 const uninspected=await f.file(f.hub,'agreement_definition',false);
 assert.equal((await f.bind({...f.input,fileId:uninspected.id,inspectionId:uninspected.inspectionId})).body.error.code,'AGREEMENT_CONTENT_NOT_READY');
 await f.pg.query("UPDATE public.file_upload_grants SET issued_at=date_trunc('second',clock_timestamp()),expires_at=date_trunc('second',clock_timestamp())+interval '300 seconds' WHERE file_id=$1",[f.pdf.id]);
 assert.equal((await f.bind()).body.error.code,'AGREEMENT_CONTENT_NOT_READY');
 const wrong=await f.file(f.otherHub),general=await f.file(f.hub,'general');
 for(const value of [wrong,general])assert.equal((await f.bind({...f.input,fileId:value.id,inspectionId:value.inspectionId})).body.error.code,'AGREEMENT_FILE_ANCHOR_MISMATCH');
 assert.equal((await f.bind({...f.input,locale:'fr'})).response.status,409);
});
check('content history and private approval cases honor current file/domain rights before pagination and academy isolation',async f=>{
 const made=await f.bind();assert.equal(made.response.status,201);const detail='agreement-content-bindings/'+made.body.data.id,pending=await f.bind(f.input,'staff');assert.equal(pending.response.status,202);
 assert.equal((await f.request(detail,undefined,'staff')).response.status,200);
 assert.equal((await f.request(detail,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.view'",[f.staffRole]);
 assert.ok([403,404].includes((await f.request(detail,undefined,'staff')).response.status));
 const list=await f.request(f.path+'?limit=1',undefined,'staff');assert.equal(list.response.status,200);assert.deepEqual(list.body,{data:[],nextCursor:null});
 assert.ok([403,404].includes((await f.request('approvals/'+pending.body.approval.id,undefined,'staff')).response.status));
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.view'",[f.managerRole]);
 assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,404);
});
check('content binding retries and failure rollback retain one immutable receipt without partial approval, audit or notices',async f=>{
 const key=randomUUID(),made=await f.bind(f.input,'master',key);assert.equal(made.response.status,201);assert.deepEqual((await f.bind(f.input,'master',key)).body,made.body);
 assert.equal((await f.bind({...f.input,reason:'Different intent'},'master',key)).response.status,409);
 const counts=async()=>(await f.pg.query(`SELECT (SELECT count(*)::int FROM public.approval_requests) approvals,(SELECT count(*)::int FROM public.agreement_content_bindings) bindings,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events,(SELECT count(*)::int FROM public.portal_notifications) notices`)).rows[0];
 const before=await counts();
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.bind()).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.deepEqual(await counts(),before);assert.equal((await f.pg.query('SELECT * FROM public.agreement_content_bindings')).rows.length,1);
 await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  await assert.rejects(f.pg.exec("UPDATE public.agreement_content_bindings SET content_attestation='forged'"),/permission denied/i);await assert.rejects(f.pg.exec('DELETE FROM public.agreement_content_bindings'),/permission denied/i);
  await assert.rejects(f.pg.query(`INSERT INTO public.agreement_content_bindings(academy_id,id,template_id,template_version,file_id,file_version,inspection_id,attempt_no,locale,source,routing,content_attestation,reason,created_by,approval_id)
   SELECT academy_id,$1,template_id,template_version,file_id,file_version,inspection_id,attempt_no,locale,jsonb_set(source,'{sha256}','"${'0'.repeat(64)}"'),routing,content_attestation,reason,created_by,approval_id FROM public.agreement_content_bindings`,[randomUUID()]),/AGREEMENT_CONTENT_EXACT_APPROVAL_REQUIRED/);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.agreement_content_bindings')).rows.length,0);
 }finally{await f.pg.exec('RESET ROLE');}
});
check('routing, attestation and request validation reject invented clearance, duplicate signatures and invalid geometry',async f=>{
 const field=f.input.routing.fields[0];
 for(const patch of [{readyToSend:true},{contentReviewed:false},{routingReviewed:false},{templateVersion:99},{fileVersion:99},{attemptNo:2},{routing:{...f.input.routing,fields:[]}},
  {routing:{...f.input.routing,fields:[field,field]}},{routing:{...f.input.routing,fields:[{...field,isRequired:false}]}},{routing:{...f.input.routing,fields:[{...field,pageNumber:0}]}},
  {routing:{...f.input.routing,fields:[{...field,bounds:{...field.bounds,width:0}}]}},{routing:{...f.input.routing,fields:[{...field,fieldType:'Label'}]}},{contentAttestation:'\0'}])assert.ok([400,409].includes((await f.bind({...f.input,...patch})).response.status),JSON.stringify(patch));
 assert.equal((await f.request(f.path+'?unexpected=1',f.input)).response.status,400);assert.equal((await f.request(f.path,undefined,'master',{method:'DELETE'})).response.status,405);
});
check('native receipt guards reject a corrupted frozen source and require an applied human review at commit',async f=>{
 const pending=await f.bind(f.input,'staff');assert.equal(pending.response.status,202);
 const p=(await f.pg.query<{id:string;target_id:string;review_context:{source:Record<string,unknown>}}>('SELECT * FROM public.approval_requests WHERE id=$1',[pending.body.approval.id])).rows[0];
 const insert=`INSERT INTO public.agreement_content_bindings(academy_id,id,template_id,template_version,file_id,file_version,inspection_id,attempt_no,locale,source,routing,content_attestation,reason,created_by,approval_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15)`;
 const args=[f.a,p.target_id,f.t.id,1,f.pdf.id,1,f.pdf.inspectionId,1,'en',JSON.stringify(p.review_context.source),JSON.stringify(f.input.routing),f.input.contentAttestation,f.input.reason,f.actors.manager.person,p.id];
 await f.pg.exec('SET ROLE kavosh_runtime');try {
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  await assert.rejects(f.pg.query(insert,args.map((v,n)=>n===9?JSON.stringify({...p.review_context.source,sha256:'0'.repeat(64)}):v)),/AGREEMENT_CONTENT_EXACT_APPROVAL_REQUIRED/);
  await assert.rejects(f.pg.query(insert,args.map((v,n)=>n===13?f.bot:v)),/AGREEMENT_CONTENT_EXACT_APPROVAL_REQUIRED/);
  await assert.rejects(f.pg.query(insert,args),/REVIEWED_APPROVAL_NOT_APPLIED/);
 }finally{await f.pg.exec('RESET ROLE');}
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_content_bindings')).rows.length,0);
 assert.equal((await f.approve(p.id,'manager')).response.status,200);
});
check('content routing preserves the declared hundred-field boundary and Unicode notes without executing unknown field types',async f=>{
 const base=f.input.routing.fields[0],fields=Array.from({length:100},(_,n)=>({...base,id:'签名-'+n,fieldType:n===0?'Signature':'FutureProviderField'}));
 const value={...f.input,routing:{...f.input.routing,fields},contentAttestation:'已人工核对 — Montréal — exact reviewed source'};
 const made=await f.bind(value);assert.equal(made.response.status,201,JSON.stringify(made.body));const stored=await f.request('agreement-content-bindings/'+made.body.data.id);
 assert.deepEqual(stored.body.data.routing.fields,fields);assert.equal(stored.body.data.content_attestation,value.contentAttestation);assert.equal(stored.body.data.readyToSend,false);
 assert.equal((await f.bind({...value,routing:{...value.routing,fields:[...fields,{...base,id:'next'}]}})).response.status,400);
});
check('unassessed format or malware detection cannot bind content and archived sources invalidate pending approvals',async f=>{
 const pending=await f.bind(f.input,'staff');assert.equal(pending.response.status,202);
 await f.pg.query("UPDATE public.file_format_assessments SET state='unassessed',reason_code='SIGNATURE_MISSING' WHERE inspection_id=$1",[f.pdf.inspectionId]);
 assert.equal((await f.bind()).body.error.code,'AGREEMENT_CONTENT_NOT_READY');
 await f.pg.query("UPDATE public.file_format_assessments SET state='matched',reason_code='SIGNATURE_CLAIM_MATCH' WHERE inspection_id=$1",[f.pdf.inspectionId]);
 await f.pg.query("UPDATE public.file_inspection_attempts SET outcome='detected',reason_code='MEASURED_DETECTION' WHERE inspection_id=$1",[f.pdf.inspectionId]);
 assert.equal((await f.bind()).body.error.code,'AGREEMENT_CONTENT_NOT_READY');
 await f.pg.query("UPDATE public.file_inspection_attempts SET outcome='no_detection',reason_code='MEASURED_NO_DETECTION' WHERE inspection_id=$1",[f.pdf.inspectionId]);
 assert.equal((await f.request('files/'+f.pdf.id+'/change',{expectedVersion:1,archived:true})).response.status,200);
 const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.status,'stale');
});
check('two concurrent identical content requests persist one receipt and approval without changing source evidence',async f=>{
 const key=randomUUID(),start=performance.now(),responses=await Promise.all([f.bind(f.input,'master',key),f.bind(f.input,'master',key)]);
 for(const response of responses)assert.equal(response.response.status,201,JSON.stringify(response.body));assert.deepEqual(responses[0].body,responses[1].body);
 assert.equal((await f.pg.query('SELECT * FROM public.agreement_content_bindings')).rows.length,1);
 console.log(JSON.stringify({case:'two-request-content-retry',elapsedMs:Math.round(performance.now()-start),receipts:1}));
},true);

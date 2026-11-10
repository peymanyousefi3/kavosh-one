import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture,submittedMedia } from './file-download-fixture.ts';
import { videoRuntimeConfigured } from './video-fixture.ts';

test('released class and student-answer videos use exact family and staff permissions without exposing file IDs or enabling old policies',{skip:!videoRuntimeConfigured},async()=>{
 const f=await fixture();try{
  const a=await submittedMedia(f,false,true),submission=a.ok(await a.save(0)),paths=[...a.paths.map(p=>p+'/media'),a.familyPath(1)];
  for(const path of paths){const r=await f.request(path,undefined,'manager');a.ok(r,200);assert.equal(r.body.data[0].availability,'unavailable','image/PDF-only serving must not silently authorize videos');}
  a.ok(await f.serving({allowedMimeTypes:['video/mp4']}),200);
  for(const path of paths){const list=await f.request(path,undefined,'manager');a.ok(list,200);const item=list.body.data[0];assert.equal(item.availability,'requestable');assert.equal(item.mime,'video/mp4');assert.doesNotMatch(JSON.stringify(list.body),/fileId|copyId|destination|etag|PRIVATE|X-Amz/);const r=await f.request(item.downloadPath.slice(8),{},'manager');a.ok(r,201);assert.equal(r.body.data.mime,'video/mp4');assert.equal(new URL(r.body.data.download.url).searchParams.get('response-content-type'),'application/octet-stream');assert.equal(r.body.data.retrievalVerified,false);}
  const staff=await f.request('homework-submissions/'+submission.id+'/versions/1/attachments',undefined,'staff');a.ok(staff,200);a.ok(await f.request(staff.body.data[0].downloadPath.slice(8),{},'staff'),201);
  assert.equal((await f.request('files/'+a.file.id+'/download-link',{expectedMetadataVersion:1,copyId:a.file.copyId},'manager')).response.status,403);
  assert.equal((await f.request(a.reportPath+'/media/'+a.block+'/download-link',{},'bot')).response.status,403);
 }finally{await f.pg.close();}
});
test('video family retries recheck joining dates,guardian authority,metadata and exact original report association',{skip:!videoRuntimeConfigured},async()=>{
 const f=await fixture();try{
  const a=await submittedMedia(f,false,true);a.ok(await a.save(0));a.ok(await f.serving({allowedMimeTypes:['video/mp4']}),200);const path=a.reportPath+'/media/'+a.block+'/download-link',answer=a.familyPath(1)+'/1/download-link',key=randomUUID();a.ok(await f.request(path,{},'manager',{key}),201);
  for(const data of [{fileId:a.answerFile!.id},{actorId:a.student},{copyId:a.file.copyId}])assert.equal((await f.request(path,data,'manager')).response.status,400);
  a.ok(await f.request('enrollments/'+a.enrollment.id+'/change',{expectedVersion:1,joinsOn:'2026-01-03',reason:'Actual corrected joining date'}),200);for(const p of [path,answer])assert.equal((await f.request(p,{},'manager')).response.status,404);
  a.ok(await f.request('enrollments/'+a.enrollment.id+'/change',{expectedVersion:2,joinsOn:'2026-01-02',reason:'Restored original joining date'}),200);a.ok(await f.request('files/'+a.file.id+'/change',{expectedVersion:1,name:'Renamed reviewed class clip',reason:'Metadata only'}),200);const renamed=await f.request(path,{},'manager');a.ok(renamed,201);assert.equal(renamed.body.data.fileVersion,2);
  a.ok(await f.request('files/'+a.file.id+'/change',{expectedVersion:2,archived:true,reason:'Withdrawn class clip'}),200);assert.equal((await f.request(path,{},'manager')).response.status,409);const list=await f.request(a.reportPath+'/media',undefined,'manager');a.ok(list,200);assert.equal(list.body.data[0].availability,'unavailable');a.ok(await f.request('files/'+a.file.id+'/change',{expectedVersion:3,archived:false,reason:'Restored reviewed clip'}),200);
  await f.pg.query("UPDATE public.family_relationships SET state='suspended' WHERE id=$1",[a.family.id]);for(const p of [path,answer])assert.equal((await f.request(p,{},'manager')).response.status,404);a.ok(await f.request(answer,{},'peer'),201);

 }finally{await f.pg.close();}
});

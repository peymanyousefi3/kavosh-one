import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { createApi } from '../src/core/api.ts';
import type { Database } from '../src/core/database.ts';
import { learningMedia } from '../src/modules/learning-media.ts';
import { submissionMedia } from '../src/modules/submission-media.ts';
import { selectMediaRequest } from '../src/server/media-request.ts';
import { fixture,submittedMedia,reader } from './file-download-fixture.ts';
import { videoFixture,videoRuntimeConfigured } from './video-fixture.ts';

test('native family video URLs stream released reports,homework,solutions and immutable answers under current permissions',{skip:!videoRuntimeConfigured},async()=>{
 const f=await fixture();try{
  const a=await submittedMedia(f,false,true),submission=a.ok(await a.save(0)),bytes=await videoFixture();a.ok(await f.serving({allowedMimeTypes:['video/mp4']}),200);let held=0,io=0;
  const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():(await f.pg.exec('SET ROLE kavosh_runtime'),{async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}});held++;return{query:c.query.bind(c),release(destroy?:boolean){held--;c.release(destroy);}};}};
  const handler={async handle(req:{headers:Record<string,string>}){assert.equal(held,0,'family delivery must not hold DB connections');assert.equal(req.headers['if-match'],'"synthetic-stored-object"');io++;const m=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range);assert.ok(m);const part=bytes.subarray(Number(m[1]),Number(m[2])+1);return{response:{statusCode:206,headers:{'content-type':'application/octet-stream','content-length':String(part.length),'content-range':`bytes ${m[1]}-${m[2]}/${bytes.length}`,etag:'"synthetic-stored-object"'},body:Readable.from([part])}};}};
  const api=createApi(database,async request=>{const actor=f.actors[request.headers.get('x-test-actor')??''];return actor?{userId:actor.user,sessionId:actor.session,academyId:request.headers.get('x-academy-id')!}:null;},async ctx=>(await learningMedia(ctx,()=>reader,handler))??submissionMedia(ctx,()=>reader,handler));
  async function raw(path:string,as='manager',method='GET',suffix=''){const p=path.replace('/api/media/'+f.a+'/',''),request=selectMediaRequest(new Request('https://academy.example'+path+suffix,{method,headers:{...as==='bot'?{authorization:'Bearer '+f.botAuth.token}:{cookie:'synthetic-only'},'x-test-actor':as,range:'bytes=0-1'}}),f.a,p).request;try{return await api(request,p);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}}
  const paths=[];for(const path of [...a.paths.map(p=>p+'/media'),a.familyPath(1),'homework-submissions/'+submission.id+'/versions/1/attachments']){const as=path.startsWith('homework-submissions/')?'staff':'manager',list=await f.request(path,undefined,as);a.ok(list,200);const video=list.body.data[0].videoPath;assert.match(video,new RegExp('^/api/media/'+f.a+'/'));paths.push({video,as});const r=await raw(video,as);assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(0,2));const head=await raw(video,as,'HEAD');assert.equal(head.status,200);assert.equal(head.body,null);assert.equal(head.headers.get('content-length'),String(bytes.length));}
  assert.equal(io,10);assert.equal(held,0);const report=paths[0].video,answer=paths[3].video,before=io;
  assert.equal((await raw(report,'staff')).status,403);assert.equal((await raw(report,'manager','GET','?fileId='+a.file.id)).status,400);assert.equal(io,before);
  a.ok(await f.request('enrollments/'+a.enrollment.id+'/change',{expectedVersion:1,joinsOn:'2026-01-03',reason:'Corrected original attendance date'}),200);for(const p of [report,answer])assert.equal((await raw(p)).status,404);assert.equal(io,before);
  a.ok(await f.request('enrollments/'+a.enrollment.id+'/change',{expectedVersion:2,joinsOn:'2026-01-02',reason:'Restored dated eligibility'}),200);
  await f.pg.query("UPDATE public.family_relationships SET state='suspended' WHERE id=$1",[a.family.id]);assert.equal((await raw(answer)).status,404);const self=await raw(answer,'peer');assert.equal(self.status,206);await self.arrayBuffer();
  a.ok(await a.save(1,'draft'),200);assert.equal((await raw(paths[4].video.replace('/versions/1/','/versions/2/'),'staff')).status,404);const old=await raw(answer,'peer');assert.equal(old.status,206);await old.arrayBuffer();
  assert.equal((await raw(answer,'bot')).status,403,'bot may never impersonate a legal family');assert.equal((await raw(paths[4].video,'bot')).status,404);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'homework-submissions.view','allow')",[f.a,f.managerRole]);const bot=await raw(paths[4].video,'bot');assert.equal(bot.status,206);await bot.arrayBuffer();assert.equal((await raw(paths[4].video.replace('/versions/1/','/versions/2/'),'bot')).status,404);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='homework-submissions.view'",[f.managerRole]);assert.equal((await raw(paths[4].video,'bot')).status,404);
  assert.equal((await f.pg.query('SELECT * FROM public.file_download_grants')).rows.length,0,'stream paths must not create bearer grants');
 }finally{await f.pg.close();}
});

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

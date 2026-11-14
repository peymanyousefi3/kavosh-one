import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createApi,type Reply } from '../src/core/api.ts';
import type { Database } from '../src/core/database.ts';
import { fileVideos } from '../src/modules/file-videos.ts';
import { selectMediaRequest,assertMediaAcademy } from '../src/server/media-request.ts';
import { fixture as downloadFixture,reader } from './file-download-fixture.ts';
import { videoFixture,videoRuntimeConfigured,videoRuntimeOptions } from './video-fixture.ts';
import { validateVideo } from '../src/files/video-validation.ts';
import { videoRange } from '../src/files/video-range.ts';

async function fixture(){
 const f=await downloadFixture();assert.equal((await f.request('storage-policy',{expectedVersion:1,uploadsEnabled:true,maximumFileBytes:100000,maximumReservedBytes:2000000,maximumFiles:100,allowedMimeTypes:['video/mp4','image/png'],reason:'Explicit video stream fixtures'})).response.status,200);
 const bytes=await videoFixture(),proof=await validateVideo(bytes,'video/mp4',videoRuntimeOptions),file=await f.file({content:bytes,mime:'video/mp4',videoValidation:proof});assert.equal((await f.serving({allowedMimeTypes:['video/mp4']})).response.status,200);
 let held=0,connections=0,commits=0,io=0,rowLocksVerified=0,failCommit=false,invalidReply=false;
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():(await f.pg.exec('SET ROLE kavosh_runtime'),{async query<Row>(sql:string,params?:unknown[]){return f.pg.query<Row>(sql,params);},release(){}});held++;connections++;let released=false;return{async query<Row>(sql:string,params?:unknown[]){if(sql==='COMMIT'&&failCommit)throw Error('SYNTHETIC_COMMIT_FAILURE');const r=await c.query<Row>(sql,params);if(sql==='COMMIT')commits++;return r;},release(destroy?:boolean){assert.equal(released,false,'DB connection must be released once');released=true;held--;c.release(destroy);}};}};
 const handler={async handle(req:{method:string;headers:Record<string,string>}){io++;assert.equal(held,0,'no authenticated DB connection may be held during media IO');assert.ok(commits>0);assert.equal(req.headers['if-match'],'"synthetic-stored-object"');
  if(f.pg.runtime){await f.pg.exec('BEGIN');try{assert.equal((await f.pg.query('SELECT id FROM public.file_records WHERE id=$1 FOR UPDATE NOWAIT',[file.id])).rows.length,1);rowLocksVerified++;}finally{await f.pg.exec('ROLLBACK');}}
  const match=req.headers.range?/^bytes=(\d+)-(\d+)$/.exec(req.headers.range):null,part=match?bytes.subarray(Number(match[1]),Number(match[2])+1):bytes;return{response:{statusCode:match?206:200,headers:{'content-length':String(part.length),'content-type':'application/octet-stream',etag:'"synthetic-stored-object"',...match?{'content-range':`bytes ${match[1]}-${match[2]}/${bytes.length}`}:{}} ,body:Readable.from([part])}};
 }};
 const path='files/'+file.id+'/video',query='?expectedMetadataVersion=1&copyId='+file.copyId;
 const api=(selected?:string)=>createApi(database,async request=>{const actor=f.actors[request.headers.get('x-test-actor')??''];return actor?{userId:actor.user,sessionId:actor.session,academyId:request.headers.get('x-academy-id')??f.a}:null;},async ctx=>{
  if(selected)assertMediaAcademy(ctx.credential.academy_id,selected);
  if(invalidReply)return{status:200,body:null,video:{mime:'text/html',plan:videoRange(bytes.length,'a'.repeat(64),null),open:async()=>{io++;return new ReadableStream();}}}as unknown as Reply;
  return fileVideos(ctx,()=>reader,handler);
 });
 async function raw(method='GET',suffix=query,headers:Record<string,string>={},as='master',selected?:string,requestedPath=path){
  let request=new Request('https://academy.example'+(selected?'/api/media/'+selected+'/':'/api/v1/')+requestedPath+suffix,{method,headers:{cookie:'synthetic-only-resolver-cookie','x-test-actor':as,...!selected?{'x-academy-id':f.a}:{},...headers}});if(selected)request=selectMediaRequest(request,selected,requestedPath).request;
  try{return await api(selected)(request,requestedPath);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 }
 return{...f,file,bytes,path,query,raw,state:()=>({held,connections,commits,io,rowLocksVerified}),setFailCommit:(v:boolean)=>failCommit=v,setInvalidReply:(v:boolean)=>invalidReply=v};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,{skip:!videoRuntimeConfigured},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('authenticated full,byte-range and HEAD responses release actual DB connections and native row locks BEFORE storage IO',async f=>{
 const full=await f.raw();assert.equal(full.status,200);assert.equal(full.headers.get('content-type'),'video/mp4');assert.equal(full.headers.get('content-disposition'),'inline');assert.equal(full.headers.get('cross-origin-resource-policy'),'same-origin');assert.equal(full.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await full.arrayBuffer()),f.bytes);
 const partial=await f.raw('GET',f.query,{range:'bytes=0-1'});assert.equal(partial.status,206);assert.equal(partial.headers.get('content-range'),'bytes 0-1/'+f.bytes.length);assert.equal(partial.headers.get('content-length'),'2');assert.deepEqual(Buffer.from(await partial.arrayBuffer()),f.bytes.subarray(0,2));assert.match(partial.headers.get('etag')!,/^"sha256-[a-f0-9]{64}"$/);
 const head=await f.raw('HEAD',f.query,{range:'invalid-but-ignored-on-HEAD'});assert.equal(head.status,200);assert.equal(head.body,null);assert.equal(head.headers.get('content-length'),String(f.bytes.length));assert.equal(f.state().held,0);assert.equal(f.state().io,3);if(f.pg.runtime)assert.equal(f.state().rowLocksVerified,3);assert.equal((await f.pg.query('SELECT * FROM public.file_download_grants')).rows.length,0);
 assert.doesNotMatch(JSON.stringify((await f.pg.query("SELECT changes FROM public.audit_events WHERE action='file.video.read'")).rows),/synthetic-stored-object|X-Amz|synthetic-download-reader/);
});
check('unsatisfied ranges return proper416without storage IO and malformed or duplicate selections never widen authority',async f=>{
 const bad=await f.raw('GET',f.query,{range:'bytes='+f.bytes.length+'-'});assert.equal(bad.status,416);assert.equal(bad.headers.get('content-range'),'bytes */'+f.bytes.length);assert.equal((await bad.arrayBuffer()).byteLength,0);assert.equal(f.state().io,0);
 for(const suffix of [f.query+'&copyId='+f.file.copyId,f.query+'&url=https://example.test/',f.query.replace('expectedMetadataVersion=1','expectedMetadataVersion=0')])assert.equal((await f.raw('GET',suffix)).status,400);assert.equal((await f.raw('GET',f.query,{range:'bytes=0-1,4-5'})).status,400);assert.equal(f.state().io,0);
 const current=await f.raw('GET',f.query,{range:'bytes=0-1','if-range':'"different"'});assert.equal(current.status,200);assert.deepEqual(Buffer.from(await current.arrayBuffer()),f.bytes);
});
check('native browser URL school selection is not membership or credential authority,and current rights apply on every GET/HEAD',async f=>{
 const native=await f.raw('GET',f.query,{range:'bytes=0-1'},'master',f.a);assert.equal(native.status,206);await native.arrayBuffer();assert.equal((await f.raw('GET',f.query,{},'master',f.b)).status,401);assert.equal((await f.raw('HEAD',f.query,{},'foreignMaster',f.b)).status,404);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.view'",[f.staffRole]);const before=f.state().io;assert.equal((await f.raw('GET',f.query,{},'staff')).status,403);assert.equal((await f.raw('GET',f.query,{'sec-fetch-site':'cross-site'})).status,403);assert.equal((await f.raw('GET',f.query,{origin:'https://other.example'})).status,403);assert.equal(f.state().io,before);
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);const head=await f.raw('HEAD');assert.equal(head.status,200);await f.pg.query("UPDATE public.academies SET status='suspended' WHERE id=$1",[f.a]);assert.equal((await f.raw()).status,403);
});
check('audit,commit and formatter failures cannot start storage IO or retain a DB connection',async f=>{
 await f.pg.exec("CREATE FUNCTION public.fail_video_stream() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_STREAM_AUDIT_FAILURE';END $$;CREATE TRIGGER fail_video_stream BEFORE INSERT ON public.outbox_events FOR EACH ROW WHEN(NEW.event_type='file.video.read') EXECUTE FUNCTION public.fail_video_stream()");assert.equal((await f.raw()).status,503);assert.equal(f.state().io,0);await f.pg.exec('DROP TRIGGER fail_video_stream ON public.outbox_events');
 f.setFailCommit(true);assert.equal((await f.raw()).status,503);assert.equal(f.state().held,0);assert.equal(f.state().io,0);f.setFailCommit(false);assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='file.video.read'")).rows.length,0);
 f.setInvalidReply(true);assert.equal((await f.raw()).status,503);assert.equal(f.state().io,0);f.setInvalidReply(false);const normal=await f.raw();assert.equal(normal.status,200);await normal.arrayBuffer();assert.equal(f.state().held,0);
});
test('media selector preserves cookies/range/abort but rejects unrelated methods,paths and conflicting school headers',()=>{
 const academy=randomUUID(),path='files/'+randomUUID()+'/video',controller=new AbortController(),original=new Request('https://academy.example/api/media/'+academy+'/'+path,{headers:{cookie:'synthetic','range':'bytes=0-1'},signal:controller.signal}),selected=selectMediaRequest(original,academy,path);assert.equal(original.headers.get('x-academy-id'),null);assert.equal(selected.request.headers.get('x-academy-id'),academy);assert.equal(selected.request.headers.get('cookie'),'synthetic');assert.equal(selected.request.headers.get('range'),'bytes=0-1');controller.abort();assert.equal(selected.request.signal.aborted,true);
 for(const [request,school,target]of [[new Request(original,{method:'POST'}),academy,path],[original,'bad',path],[original,academy,'people'],[new Request(original,{headers:{'x-academy-id':randomUUID()}}),academy,path]]as const)assert.throws(()=>selectMediaRequest(request,school,target),{code:'NOT_FOUND'});assert.throws(()=>assertMediaAcademy(randomUUID(),academy),{code:'NOT_FOUND'});
});

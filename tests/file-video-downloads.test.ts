import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {readFileSync} from 'node:fs';
import { fixture as copyFixture,config,historicalImage } from './file-copy-fixture.ts';
import { operationsFixture } from './operations-fixture.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';
import { videoFixture,videoRuntimeConfigured,videoRuntimeOptions } from './video-fixture.ts';
import { validateVideo } from '../src/files/video-validation.ts';
import { processOneCopy } from '../src/files/copy-worker.ts';
import { promoteQuarantinedFile } from '../src/integrations/r2-promotion.ts';
import { r2TargetId } from '../src/integrations/r2-config.ts';

const writer={...config,bucket:'synthetic-video-serving',accessKeyId:'synthetic-clean-writer'},reader={...writer,accessKeyId:'synthetic-clean-reader'},destination=r2TargetId(reader);
async function fixture(configured=true){
 const f=await copyFixture(await operationsFixture({connections:()=>config,downloadConnections:()=>configured?reader:null}),destination);
 assert.equal((await f.request('storage-policy',{expectedVersion:1,uploadsEnabled:true,maximumFileBytes:100000,maximumReservedBytes:2000000,maximumFiles:100,allowedMimeTypes:['video/mp4','image/png'],reason:'Explicit synthetic video intake'})).response.status,200);
 const bytes=await videoFixture(),proof=await validateVideo(bytes,'video/mp4',videoRuntimeOptions);assert.equal(proof.outcome,'decoded');
 const file=await f.file({content:bytes,mime:'video/mp4',videoValidation:proof}),made=await f.copy(file);assert.equal(made.response.status,202,JSON.stringify(made.body));const copyId=made.body.data.id;let stored:Buffer|undefined;
 const response=(b:Buffer)=>({response:{statusCode:200,headers:{'content-length':String(b.length),'content-type':'application/octet-stream',etag:'"synthetic-measured-video"'},body:Readable.from([b])}});
 try{assert.deepEqual(await processOneCopy(f.database,[f.a],randomUUID(),async task=>promoteQuarantinedFile(config,writer,{academyId:f.a,fileId:task.fileId,storageTargetId:task.sourceTargetId,bytes:task.expectedBytes,sha256:task.expectedSha256},{},{source:{async handle(){return response(bytes);}},destination:{async handle(req:{method:string;body?:unknown}){if(req.method==='PUT'){assert.ok(Buffer.isBuffer(req.body));stored=Buffer.from(req.body);return{response:{statusCode:200,headers:{},body:Readable.from([])}};}assert.ok(stored);return response(stored);}}})),{claimed:true,recorded:true});}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 assert.deepEqual(stored,bytes);let routeVersion=1;
 async function serving(types:string[],enabled=true){const r=await f.request('storage/routes/'+f.route.id+'/change',{expectedVersion:routeVersion,definition:{...f.route.definition,serving:{enabled,allowedMimeTypes:types,maximumLinkSeconds:30}},reason:'New exact reviewed private video serving policy'});assert.equal(r.response.status,200,JSON.stringify(r.body));routeVersion++;return r;}
 const download=(as='master',key?:string,version=1)=>f.request('files/'+file.id+'/download-link',{expectedMetadataVersion:version,copyId},as,{key});
 return{...f,bytes,file,copyId,serving,download};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,{skip:!videoRuntimeConfigured},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('exact real decoded video downloads require new video policy and remain conditional private binary attachments',async f=>{
 assert.equal(f.route.definition.serving,undefined);assert.equal((await f.download()).response.status,409);await f.serving(['image/png']);assert.equal((await f.download()).response.status,409);await f.serving(['video/mp4']);const key=randomUUID(),r=await f.download('master',key);assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.mime,'video/mp4');assert.equal(r.body.data.bytes,f.bytes.length);assert.equal(r.body.data.retrievalVerified,false);assert.equal(r.body.data.malwareFreeVerified,false);
 const url=new URL(r.body.data.download.url);assert.equal(url.searchParams.get('response-content-type'),'application/octet-stream');assert.equal(url.searchParams.get('response-content-disposition'),'attachment');assert.equal(url.searchParams.get('response-cache-control'),'private, no-store');assert.equal(url.searchParams.get('X-Amz-Expires'),'30');assert.deepEqual(r.body.data.download.headers,{'if-match':'"synthetic-measured-video"'});assert.deepEqual((await f.download('master',key)).body,r.body);
 assert.equal((await f.pg.query('SELECT * FROM public.file_download_grants')).rows.length,1);for(const table of ['audit_events','outbox_events','request_keys']){const rows=(await f.pg.query('SELECT * FROM public.'+table)).rows;assert.doesNotMatch(JSON.stringify(rows),/X-Amz|synthetic-measured-video|synthetic-clean-reader/);}
});
check('current video policy and immutable native evidence are rechecked on every download retry',async f=>{
 await f.serving(['video/mp4']);const key=randomUUID();assert.equal((await f.download('master',key)).response.status,201);await f.serving(['video/mp4'],false);assert.equal((await f.download('master',key)).response.status,409);await f.serving(['video/mp4']);assert.equal((await f.download('master',key)).response.status,409,'new policy edition cannot resurrect an old grant');assert.equal((await f.download()).response.status,201);
 await f.pg.query('DELETE FROM public.file_video_evidence WHERE academy_id=$1',[f.a]);assert.equal((await f.download()).response.status,409);assert.equal((await f.pg.query('SELECT * FROM public.file_download_grants')).rows.length,2);
});
check('video download read permissions,school boundaries and archived metadata remain enforced without payload overrides',async f=>{
 await f.serving(['video/mp4']);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.view'",[f.staffRole]);assert.equal((await f.download('staff')).response.status,403);assert.equal((await f.request('files/'+f.file.id+'/download-link',{expectedMetadataVersion:1,copyId:f.copyId},'foreignMaster',{academy:f.b})).response.status,404);
 for(const patch of [{mime:'video/mp4'},{videoValidation:{}},{actorId:randomUUID()},{maximumLinkSeconds:300}])assert.equal((await f.request('files/'+f.file.id+'/download-link',{expectedMetadataVersion:1,copyId:f.copyId,...patch})).response.status,400);
 const key=randomUUID();assert.equal((await f.download('master',key)).response.status,201);assert.equal((await f.request('files/'+f.file.id+'/change',{expectedVersion:1,archived:true,reason:'Withdrawn synthetic video'})).response.status,200);assert.equal((await f.download('master',key)).response.status,409);assert.equal((await f.download('master',undefined,2)).response.status,409);
});
check('video download audit failure rolls back native grant and cached intent before an exact retry succeeds',async f=>{
 await f.serving(['video/mp4']);const key=randomUUID();await f.pg.exec("CREATE FUNCTION public.fail_video_download() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_VIDEO_DOWNLOAD_FAILURE';END $$;CREATE TRIGGER fail_video_download BEFORE INSERT ON public.outbox_events FOR EACH ROW WHEN(NEW.event_type='file.download.link.issued') EXECUTE FUNCTION public.fail_video_download()");assert.equal((await f.download('master',key)).response.status,503);assert.equal((await f.pg.query('SELECT * FROM public.file_download_grants')).rows.length,0);await f.pg.exec('DROP TRIGGER fail_video_download ON public.outbox_events');assert.equal((await f.download('master',key)).response.status,201);assert.equal((await f.pg.query('SELECT * FROM public.file_download_grants')).rows.length,1);
});
test('video serving never invents missing separate reader credentials',{skip:!videoRuntimeConfigured},async()=>{const f=await fixture(false);try{await f.serving(['video/mp4']);const r=await f.download();assert.equal(r.response.status,503);assert.equal(r.body.error.code,'R2_DOWNLOAD_NOT_CONFIGURED');assert.equal((await f.pg.query('SELECT * FROM public.file_download_grants')).rows.length,0);}finally{await f.pg.close();}});
test('actual359to360 preserves existing exact image download grants,source fingerprints and native ownership',async()=>{
 const f=await copyFixture(await operationsFixture({throughSchema:359,connections:()=>config,downloadConnections:()=>reader}),destination);
 try{const file=await historicalImage(f,359),made=await f.copy(file);assert.equal(made.response.status,202);const c=await f.database.connect();try{const job=(await c.query('SELECT * FROM public.claim_file_copy($1,$2,30)',[[f.a],randomUUID()])).rows[0],result={outcome:'written_verified',bytes:f.bytes.length,sha256:job.expected_sha256,source:{storageTargetId:job.source_target_id,etag:'"historical-source"'},destination:{storageTargetId:job.destination_target_id,etag:'"historical-destination"'}};assert.equal((await c.query('SELECT public.finish_file_copy($1,$2,$3,$4::jsonb) recorded',[f.a,made.body.data.id,job.lease_token,JSON.stringify(result)])).rows[0].recorded,true);}finally{c.release();if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 assert.equal((await f.request('storage/routes/'+f.route.id+'/change',{expectedVersion:1,definition:{...f.route.definition,serving:{enabled:true,allowedMimeTypes:['image/png'],maximumLinkSeconds:30}},reason:'Historical image-only serving policy'})).response.status,200);const request=()=>f.request('files/'+file.id+'/download-link',{expectedMetadataVersion:1,copyId:made.body.data.id},'master',{key}),key=randomUUID(),first=await request();assert.equal(first.response.status,201,JSON.stringify(first.body));const before=(await f.pg.query('SELECT * FROM public.file_download_grants')).rows,functions=(await f.pg.query("SELECT oid,proowner,proacl,proconfig FROM pg_proc WHERE oid=ANY(ARRAY['public.file_download_source(uuid,integer,uuid)'::regprocedure,'public.file_storage_route_definition_valid(jsonb)'::regprocedure]) ORDER BY oid")).rows;
 await f.pg.exec(readFileSync(new URL('../db/migrations/360_file_video_downloads.sql',import.meta.url),'utf8'));assert.equal((await f.pg.query('SELECT public.schema_revision() revision')).rows[0].revision,360);assert.deepEqual((await f.pg.query('SELECT * FROM public.file_download_grants')).rows,before);assert.deepEqual((await f.pg.query("SELECT oid,proowner,proacl,proconfig FROM pg_proc WHERE oid=ANY(ARRAY['public.file_download_source(uuid,integer,uuid)'::regprocedure,'public.file_storage_route_definition_valid(jsonb)'::regprocedure]) ORDER BY oid")).rows,functions);
 await upgradeToCurrent(f.pg);assert.deepEqual((await f.pg.query('SELECT * FROM public.file_download_grants')).rows,before);assert.deepEqual((await request()).body,first.body);assert.equal((await f.pg.query('SELECT * FROM public.file_video_evidence')).rows.length,0);
 }finally{await f.pg.close();}
});

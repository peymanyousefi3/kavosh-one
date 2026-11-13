import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,realpath,chmod,writeFile,symlink,link,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evaluateOperationalHealth,operationalWorkerUnits} from '../src/operations/operational-health.ts';
import {operationalHealthStatus,readOperationalHealthStatus} from '../src/operations/health-status.ts';
import {createPlatformApi} from '../src/platform/api.ts';
import type {Database} from '../src/core/database.ts';
const now=Date.now(),completed={active:'inactive',result:'success',exitStatus:0,lastSuccessfulExitAt:new Date(now-3600000).toISOString()},normal=evaluateOperationalHealth({observedAt:new Date(now).toISOString(),ready:true,freeBackupDiskBytes:'50000000000',web:{...completed,active:'active'},backup:completed,configuration:completed,backupTimerActive:true,configurationTimerActive:true,workers:Object.fromEntries(Object.keys(operationalWorkerUnits).map(key=>[key,{...completed,active:'active'}]))});
test('owner status recomputes findings and marks stale/future samples critical instead of retaining a green label',()=>{
 assert.equal(operationalHealthStatus(normal,now).status,'healthy');assert.equal(operationalHealthStatus(normal,now+180000).status,'healthy');assert.equal(operationalHealthStatus(normal,now+180001).issues.at(-1)?.code,'MONITOR_OBSERVATION_STALE');assert.equal(operationalHealthStatus(normal,now-30001).issues.at(-1)?.code,'MONITOR_CLOCK_INCONSISTENT');
 assert.equal(operationalHealthStatus({...normal,ready:false},now).status,'critical');assert.throws(()=>operationalHealthStatus({...normal,secret:'DO_NOT_EXPOSE'},now));assert.throws(()=>operationalHealthStatus(normal,NaN));
 assert.equal(operationalHealthStatus({...normal,workers:{...normal.workers!,reports:{...normal.workers!.reports,active:'failed'}},status:'healthy',issues:[]},now).status,'critical');
 const {workers,workerCoverage,queueProgressVerified,...legacy}=normal,old=operationalHealthStatus(legacy,now);assert.equal(old.status,'warning');assert.equal(old.workerCoverage,'not_observed');assert.equal(old.queueProgressVerified,false);
 assert.equal(operationalHealthStatus({...legacy,workerCoverage:'required_process_states_observed'},now).workerCoverage,'not_observed');
 const worst=operationalHealthStatus({...normal,ready:false,freeBackupDiskBytes:'0',web:{...completed,active:'failed'},backup:{...completed,active:'failed'},configuration:{...completed,active:'failed'},workers:Object.fromEntries(Object.keys(operationalWorkerUnits).map(key=>[key,{...completed,active:'failed'}]))},now);assert.equal(worst.issues.length,16);assert.ok(Buffer.byteLength(JSON.stringify(worst))<16384);assert.equal(operationalHealthStatus(worst,now+180001).issues.length,17);
});
test('shared health file is bounded,strict,read-only metadata;unsafe permissions,links and injected fields fail closed',async()=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'kavosh-health-'))),file=join(directory,'status.json');try{
  await chmod(directory,0o750);await writeFile(file,JSON.stringify(normal),{mode:0o640});await chmod(file,0o640);assert.equal((await readOperationalHealthStatus(directory,now)).status,'healthy');
  await chmod(file,0o660);await assert.rejects(readOperationalHealthStatus(directory,now));await chmod(file,0o640);
  await chmod(directory,0o770);await assert.rejects(readOperationalHealthStatus(directory,now));await chmod(directory,0o750);
  await link(file,file+'.link');await assert.rejects(readOperationalHealthStatus(directory,now));await rm(file+'.link');
  await rm(file);await symlink('missing',file);await assert.rejects(readOperationalHealthStatus(directory,now));await rm(file);
  await writeFile(file,'x'.repeat(16385),{mode:0o640});await assert.rejects(readOperationalHealthStatus(directory,now));
  await writeFile(file,JSON.stringify({...normal,credential:'PRIVATE'}));await assert.rejects(readOperationalHealthStatus(directory,now));
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('platform health authorizes and rate-limits before reading;bots,nonowners and unavailable state cannot leak metadata',async()=>{
 let reads=0,allowed=true,deny=false,queries=0;
 const database:Database={async connect(){return {async query<Row>(sql:string){queries++;if(sql.startsWith('SELECT platform_private.consume_request_budget(')){if(deny)throw Error('PLATFORM_OWNER_REQUIRED');return {rows:[{allowed}] as Row[]};}if(sql.startsWith('SELECT platform_private.request('))return {rows:[{result:{status:200,body:{operationalHealthAccessGranted:true}}}] as Row[]};return {rows:[{safe:true,revision:400}] as Row[]};},release(){}};}};
 const api=createPlatformApi(database,async r=>r.headers.has('x-human')?{userId:'00000000-0000-4000-8000-000000000001',sessionId:'00000000-0000-4000-8000-000000000002'}:null,true,{readOperationalHealth:async()=>{reads++;return normal;}});
 const request=(headers:Record<string,string>={},suffix='',method='GET')=>api(new Request('https://example.test/api/platform/v1/operations/health'+suffix,{method,headers}), 'operations/health');
 assert.equal((await request()).status,401);assert.equal((await request({'x-human':'1',authorization:'Bearer synthetic'})).status,401);assert.equal(reads,0);assert.equal(queries,0);
 deny=true;assert.equal((await request({'x-human':'1'})).status,403);assert.equal(reads,0);deny=false;allowed=false;assert.equal((await request({'x-human':'1'})).status,429);assert.equal(reads,0);allowed=true;
 const response=await request({'x-human':'1'});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).data.status,'healthy');assert.equal(reads,1);
 assert.equal((await request({'x-human':'1'},'?path=/etc/private')).status,400);assert.equal((await request({'x-human':'1'},'','POST')).status,405);assert.equal(reads,1);
 const unavailable=createPlatformApi(database,async()=>({userId:'00000000-0000-4000-8000-000000000001',sessionId:'00000000-0000-4000-8000-000000000002'}),true,{readOperationalHealth:async()=>{throw Error('SECRET_DIAGNOSTIC');}});
 const failure=await unavailable(new Request('https://example.test/api/platform/v1/operations/health'),'operations/health');assert.equal(failure.status,503);assert.equal(JSON.stringify(await failure.json()).includes('SECRET'),false);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {createContext,runInContext} from 'node:vm';
import {z} from 'zod';

const cases=[['background','notifications'],['background','reports'],['background','messages'],['background','platform-notices'],['file-copies','promotion'],['file-copies','verification'],['file-inspection','--execute']] as const;
async function check(kind:string,mode:string,options:{sharedSecret?:boolean;rootReadable?:boolean;unsafeRole?:boolean;insecureTls?:boolean}={}){
 const id='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',prefix=mode==='notifications'?'NOTIFICATION_WORKER':mode==='reports'?'REPORT_WORKER':mode==='messages'?'NOTIFICATION_OUTBOUND':'PLATFORM_NOTICE_WORKER';
 const env:Record<string,string>={};
 if(kind==='background'){env[prefix+'_DATABASE_URL']='synthetic-private-connection';if(mode!=='platform-notices')env[prefix+'_ACADEMIES']=JSON.stringify([id]);}
 if(kind==='file-copies')Object.assign(env,{FILE_COPY_MODE:mode,FILE_COPY_WORKER_DATABASE_URL:'synthetic-private-copy',FILE_COPY_CONNECTIONS:JSON.stringify([{academyId:id,...mode==='promotion'?{source:{},destination:{}}:{reader:{}}}])});
 if(kind==='file-inspection')Object.assign(env,{FILE_INSPECTION_DATABASE_URL:'synthetic-private-inspection',FILE_INSPECTION_R2_CONNECTIONS:JSON.stringify([{academyId:id,configuration:{bucket:'kavosh-one-production-quarantine'}}]),FILE_IMAGE_VALIDATION_SOCKET_PATH:'/private/synthetic/image.sock',FILE_PDF_VALIDATION_SOCKET_PATH:'/private/synthetic/pdf.sock',FILE_VIDEO_VALIDATION_SOCKET_PATH:'/private/synthetic/video.sock',CLAMD_SOCKET_PATH:'/private/synthetic/clamd.sock',FILE_INSPECTION_MAXIMUM_BYTES:'100000',CLAMD_TIME_ZONE:'UTC'});
 if(mode==='messages')env.OPERATIONAL_DELIVERY_CONNECTIONS='synthetic-private-provider';if(options.sharedSecret)env.AUTH_SECRET='synthetic-private-web';
 let pools=0,ended=false,released=false,readonly=false,roleChecks=0,schemaChecks=0,mutations=0,deliveryModules=0;const queries:string[]=[],logs:string[]=[];
 const role=async()=>{roleChecks++;assert.equal(readonly,true);if(options.unsafeRole)throw Error('synthetic-private-role');};
 const c={async query(sql:string){queries.push(sql);if(sql==='BEGIN READ ONLY')readonly=true;else if(sql==='ROLLBACK')readonly=false;else{assert.equal(readonly,true);assert.ok(sql.startsWith('SELECT ')&&sql.includes('pg_stat_ssl'));}return{rows:[{tls:!options.insecureTls,login:'kavosh_one_'+(kind==='file-copies'?'file_':'')+mode.replaceAll('-','_'),identityAccess:false,direct:false,directAccess:false}]};},release(){released=true;}};
 const context=createContext({assert,z,Buffer,readFileSync:()=>{if(options.rootReadable)return 'synthetic-private-web';throw Object.assign(Error('denied'),{code:'EACCES'});},postgresOptions:()=>({ssl:{rejectUnauthorized:true}}),
  assertRuntimeRole:role,assertPlatformNoticeWorker:role,assertFileWorkerRole:role,assertSchemaReady:async()=>{schemaChecks++;assert.equal(readonly,true);},
  configuredOperationalDelivery:(academy:string)=>{assert.equal(academy,id);return{send(){mutations++;throw Error('MUST_NOT_SEND');}};},
  assertPrivateImageSocket:async()=>{},assertPrivatePdfSocket:async()=>{},assertPrivateVideoSocket:async()=>{},getClamdDatabase:async()=>({databaseVersion:30001}),detectContentSignature:async()=>({detector:'file-type@22.3.0'}),
  pg:{Pool:class{constructor(value:{max:number}){pools++;assert.equal(value.max,1);}on(){}async connect(){return c;}async end(){ended=true;}}},
  process:{env,getuid:()=>994,exitCode:undefined as number|undefined},console:{log:(value:string)=>logs.push(value),error:(value:string)=>logs.push(value)}});
 // Old checker bodies would call one of these and fail this regression even
 // when a claim returns no task. A diagnostic must never enter that path.
 for(const name of ['processOneNotification','processOneSubscription','processOneAccountSecurity','processOneReport','processOneReportSchedule','processOneMessage','processPlatformNotices','processOneInspection','processOneCopy','processOneCopyCheck'])context[name]=async()=>{mutations++;throw Error('MUST_NOT_CLAIM');};
 runInContext('process.argv='+JSON.stringify(['node','script',mode]),context);
 context.loadOperationalDelivery=async()=>{deliveryModules++;return{configuredOperationalDelivery:context.configuredOperationalDelivery};};
 const source=stripTypeScriptTypes(readFileSync(new URL('../deploy/ovh/check-'+kind+'.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace("await import('../../src/integrations/message-delivery.ts')",'await loadOperationalDelivery()');
 await runInContext('(async()=>{'+source+'})()',context,{timeout:1000});
 return{pools,ended,released,readonly,roleChecks,schemaChecks,mutations,deliveryModules,queries,logs,exitCode:context.process.exitCode};
}
test('all seven operational isolation checks are read-only and cannot claim,send,publish or advance queued work',async()=>{
 for(const [kind,mode]of cases){const r=await check(kind,mode);assert.equal(r.exitCode,undefined,JSON.stringify({kind,mode,logs:r.logs}));assert.equal(r.mutations,0);assert.equal(r.deliveryModules,mode==='messages'?1:0);assert.equal(r.pools,1);assert.equal(r.roleChecks,1);assert.equal(r.schemaChecks,1);assert.ok(r.ended&&r.released&&!r.readonly);assert.deepEqual(r.queries.filter(q=>!q.startsWith('SELECT ')),['BEGIN READ ONLY','ROLLBACK']);const data=JSON.parse(r.logs[0]);assert.equal(data.readOnlyIsolationCheck,true);assert.equal(data.jobsClaimed,0);assert.equal(data.queueState,'not_examined');assert.equal(data.emptyQueuesVerified,undefined);assert.equal(data.emptyQueueVerified,undefined);assert.doesNotMatch(r.logs.join(''),/synthetic-private/);}
});
test('shared credentials,readable web secrets,unsafe roles and missing TLS fail without side effects and release resources',async()=>{
 for(const [kind,mode]of cases)for(const options of [{sharedSecret:true},{rootReadable:true},{unsafeRole:true},{insecureTls:true}]){
  const r=await check(kind,mode,options);assert.equal(r.exitCode,1,JSON.stringify({kind,mode,options}));assert.equal(r.mutations,0);assert.doesNotMatch(r.logs.join(''),/synthetic-private/);if(r.pools)assert.ok(r.ended&&r.released&&!r.readonly);
 }
});

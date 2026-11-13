import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext,runInContext } from 'node:vm';
import { signatureCompletionWorkerConfiguration as configuration } from '../src/integrations/signature-completion-config.ts';
import { signatureConnectionTarget } from '../src/integrations/boldsign-webhook-config.ts';
import { r2TargetId } from '../src/integrations/r2-config.ts';

function fixture(){
 const academyId=randomUUID(),provider={connectionId:randomUUID(),region:'CA' as const,environment:'Live' as const,clientId:null,apiKey:'synthetic-private-provider-key'};
 const archive={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-signature-vault',accessKeyId:'synthetic-archive-writer',secretAccessKey:'synthetic-private-archive-key',maximumUploadBytes:10485760};
 const entries=[{academyId,providers:[provider],archive}],env={SIGNATURE_COMPLETION_WORKER_ENABLED:'true',SIGNATURE_COMPLETION_CONNECTIONS:JSON.stringify(entries),SIGNATURE_COMPLETION_DATABASE_URL:'postgresql://synthetic-only@127.0.0.1/synthetic'};
 return {academyId,provider,archive,entries,env};
}
test('completion configuration is opt-in and maps only exact school, provider identity and archive',()=>{
 assert.equal(configuration({}),null);assert.equal(configuration({SIGNATURE_COMPLETION_WORKER_ENABLED:'false',SIGNATURE_COMPLETION_CONNECTIONS:'invalid'}),null);
 const f=fixture(),c=configuration(f.env)!;assert.deepEqual(c.academyIds,[f.academyId]);assert.equal(c.retrySeconds,21600);
 const target=signatureConnectionTarget({...f.provider,academyId:f.academyId});
 assert.deepEqual(c.providers(f.academyId,f.provider.connectionId,target),{region:'CA',apiKey:f.provider.apiKey});
 for(const args of [[randomUUID(),f.provider.connectionId,target],[f.academyId,randomUUID(),target],[f.academyId,f.provider.connectionId,'a'.repeat(64)]])assert.equal(c.providers(...args as [string,string,string]),null);
 assert.equal(c.evidenceStores(randomUUID()),null);assert.equal(c.evidenceStores(f.academyId)?.targetId,r2TargetId(f.archive));
});
test('completion configuration refuses shared credentials, duplicates and malformed settings without revealing secrets',()=>{
 const f=fixture();
 const invalid=[{SIGNATURE_COMPLETION_WORKER_ENABLED:'yes'},{DATABASE_URL:'PRIVATE'},{BOLDSIGN_WEBHOOK_CONNECTIONS:'PRIVATE'},{R2_DOWNLOAD_CONNECTIONS:'PRIVATE'},{SIGNATURE_COMPLETION_RETRY_SECONDS:'59'},{SIGNATURE_COMPLETION_CONNECTIONS:'x'.repeat(1048577)},{SIGNATURE_COMPLETION_CONNECTIONS:JSON.stringify([...f.entries,...f.entries])},{SIGNATURE_COMPLETION_CONNECTIONS:JSON.stringify([{...f.entries[0],providers:[f.provider,f.provider]}])},{SIGNATURE_COMPLETION_CONNECTIONS:JSON.stringify([{...f.entries[0],extra:'PRIVATE'}])}];
 for(const change of invalid)assert.throws(()=>configuration({...f.env,...change}),e=>{assert.equal((e as Error).message,'SIGNATURE_COMPLETION_WORKER_NOT_CONFIGURED');assert.doesNotMatch(String(e),/PRIVATE|synthetic-private/);return true;});
});
test('completion daemon uses its own bounded pool and stops cleanly without logging credentials',async()=>{
 const source=stripTypeScriptTypes(readFileSync(new URL('../scripts/process-signature-completions.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
 const f=fixture();let ended=false,pools=0,calls=0,runtimeEnv:Record<string,string>=f.env;const logs:string[]=[],controllers:AbortController[]=[];
 const context=createContext({AbortController:class extends AbortController{constructor(){super();controllers.push(this);}},randomUUID,signatureCompletionWorkerConfiguration:()=>configuration(runtimeEnv),
  postgresOptions:(url:string)=>{assert.equal(url,f.env.SIGNATURE_COMPLETION_DATABASE_URL);return {connectionString:url};},pg:{Pool:class{constructor(options:{max:number;statement_timeout:number}){pools++;assert.equal(options.max,2);assert.equal(options.statement_timeout,5000);}on(){}async end(){ended=true;}}},
  processOneSignatureCompletion:async(i:{academyIds:string[]},_services:unknown,options:{signal:AbortSignal})=>{calls++;assert.deepEqual(i.academyIds,[f.academyId]);assert.equal(options.signal,controllers[0].signal);controllers[0].abort();return {state:'not_completed'};},delay:async()=>{throw Error('not idle');},console:{error:(s:string)=>logs.push(s)},process:{argv:['node','script'],env:f.env,on(){},exitCode:undefined}});
 await runInContext('(async()=>{'+source+'})()',context);
 assert.equal(pools,1);assert.equal(calls,1);assert.equal(ended,true);assert.deepEqual(logs,[]);
 const process=context.process as {env:Record<string,string>;exitCode?:number};process.env=runtimeEnv={...f.env,AUTH_SECRET:'PRIVATE'};
 await runInContext('(async()=>{'+source+'})()',context);assert.equal(process.exitCode,1);assert.equal(pools,1);assert.equal(calls,1);assert.equal(logs.length,1);assert.doesNotMatch(logs[0],/PRIVATE|synthetic-private/);
});

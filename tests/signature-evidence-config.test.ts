import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext,runInContext } from 'node:vm';
import { test } from 'node:test';
import { z } from 'zod';
import { signatureEvidenceConfiguration } from '../src/integrations/signature-evidence-config.ts';
import { r2TargetId } from '../src/integrations/r2-config.ts';
import { postgresOptions } from '../src/core/postgres-config.ts';

function fixture(){
 const academyId=randomUUID(),configuration={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-signature-vault',accessKeyId:'synthetic-inspection-reader',secretAccessKey:'synthetic-private-inspection-key',maximumUploadBytes:10485760};
 const entries=[{academyId,configuration}],env={NODE_ENV:'production',DATABASE_SSL_MODE:'require',SIGNATURE_EVIDENCE_ENABLED:'true',SIGNATURE_EVIDENCE_DATABASE_URL:'postgresql://synthetic-only@127.0.0.1/synthetic',SIGNATURE_EVIDENCE_CONNECTIONS:JSON.stringify(entries),CLAMD_SOCKET_PATH:'/run/kavosh-one-scanner/clamd.sock',CLAMD_TIME_ZONE:'UTC',SIGNATURE_EVIDENCE_PDF_SOCKET_PATH:'/run/kavosh-one-parser-pdf/validator.sock'};
 return {academyId,configuration,entries,env};
}
test('signed artifact inspection configuration is opt-in and pins both school and actual private storage target',()=>{
 assert.equal(signatureEvidenceConfiguration({}),null);assert.equal(signatureEvidenceConfiguration({SIGNATURE_EVIDENCE_ENABLED:'false',SIGNATURE_EVIDENCE_CONNECTIONS:'bad'}),null);
 const f=fixture(),c=signatureEvidenceConfiguration(f.env)!;assert.deepEqual(c.academyIds,[f.academyId]);assert.deepEqual(c.readers(f.academyId,r2TargetId(f.configuration)),f.configuration);assert.equal(c.readers(randomUUID(),r2TargetId(f.configuration)),null);assert.equal(c.readers(f.academyId,'b'.repeat(64)),null);
 assert.equal(c.scanner.maximumBytes,10485760);assert.equal(c.scanner.timeoutMs,30000);assert.equal(c.databasePolicy.maximumAgeSeconds,172800);
});
test('signed artifact configuration refuses mixed service credentials,duplicates and unsafe local service paths',()=>{
 const f=fixture();for(const patch of [{SIGNATURE_EVIDENCE_ENABLED:'yes'},{AUTH_SECRET:'PRIVATE'},{SIGNATURE_COMPLETION_CONNECTIONS:'PRIVATE'},{FILE_INSPECTION_R2_CONNECTIONS:'PRIVATE'},{OPERATIONAL_DELIVERY_CONNECTIONS:'PRIVATE'},{SIGNATURE_EVIDENCE_CONNECTIONS:'x'.repeat(1048577)},{SIGNATURE_EVIDENCE_CONNECTIONS:JSON.stringify([...f.entries,...f.entries])},{SIGNATURE_EVIDENCE_CONNECTIONS:JSON.stringify([{...f.entries[0],extra:true}])},{CLAMD_SOCKET_PATH:'https://untrusted.example'},{SIGNATURE_EVIDENCE_PDF_SOCKET_PATH:'/run/../private.sock'},{CLAMD_TIME_ZONE:''},{CLAMD_MAXIMUM_DATABASE_AGE_SECONDS:'604801'}])assert.throws(()=>signatureEvidenceConfiguration({...f.env,...patch}),e=>{assert.equal((e as Error).message,'SIGNATURE_EVIDENCE_NOT_CONFIGURED');assert.doesNotMatch(String(e),/PRIVATE|synthetic-private/);return true;});
});

const source=stripTypeScriptTypes(readFileSync(new URL('../scripts/inspect-signature-evidence.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
async function command(options:{purpose?:string;foreign?:boolean;root?:boolean;disabled?:boolean;badSocket?:boolean;failure?:boolean;unrecorded?:boolean;duplicate?:boolean;extraArg?:boolean}={}){
 const f=fixture(),evidence=randomUUID(),operation=randomUUID(),purpose=options.purpose??'worker_services',academy=options.foreign?randomUUID():f.academyId,args=[purpose,academy,evidence,'document',operation];if(options.extraArg)args.push('unexpected');
 let pools=0,calls=0,ended=false,sockets=0;const logs:string[]=[],env={...f.env,...(options.disabled?{SIGNATURE_EVIDENCE_ENABLED:'false'}:{})};
 const inspect=async(raw:unknown,services:{readers:(a:string,t:string)=>unknown},o:{enabled:boolean;signal:AbortSignal})=>{calls++;assert.deepEqual(JSON.parse(JSON.stringify(raw)),{academyId:f.academyId,evidenceId:evidence,kind:'document',operationId:operation});assert.ok(services.readers(f.academyId,r2TargetId(f.configuration)));assert.equal(o.enabled,true);assert.equal(o.signal.aborted,false);if(options.failure)throw Error('PRIVATE synthetic-inspection-key');return options.duplicate?{recorded:true,inserted:false,alreadyRecorded:true}:{recorded:!options.unrecorded,inserted:!options.unrecorded,outcome:'screened'};};
 const c=createContext({assert,z,AbortController,AbortSignal,signatureEvidenceConfiguration:()=>signatureEvidenceConfiguration(env),postgresOptions:(url:string)=>postgresOptions(url,env),
  assertPrivatePdfSocket:async(path:string)=>{sockets++;assert.equal(path,env.SIGNATURE_EVIDENCE_PDF_SOCKET_PATH);if(options.badSocket)throw Error('PRIVATE insecure socket');},
  processSignatureEvidenceInspection:async(...params:Parameters<typeof inspect>)=>{assert.equal(purpose,'unified_enrollment');return inspect(...params);},processWorkSignatureEvidenceInspection:async(...params:Parameters<typeof inspect>)=>{assert.equal(purpose,'worker_services');return inspect(...params);},
  pg:{Pool:class{constructor(o:{max:number;ssl:{rejectUnauthorized:boolean}}){pools++;assert.equal(o.max,2);assert.equal(o.ssl.rejectUnauthorized,true);}on(){}async end(){ended=true;}}},
  console:{log:(s:string)=>logs.push(s),error:(s:string)=>logs.push(s)},process:{argv:['node','script',...args],env,getuid:()=>options.root?0:994,on(){},exitCode:undefined as number|undefined}});
 await runInContext('(async()=>{'+source+'})()',c,{timeout:1000});return {pools,calls,ended,sockets,logs,exitCode:c.process.exitCode};
}
test('explicit inspection command routes both purposes without logging content and closes its bounded pool',async()=>{
 for(const purpose of ['unified_enrollment','worker_services']){const r=await command({purpose});assert.equal(r.exitCode,undefined);assert.equal(r.calls,1);assert.equal(r.pools,1);assert.ok(r.ended);const out=JSON.parse(r.logs[0]);assert.equal(out.recorded,true);assert.equal(out.purpose,purpose);assert.equal(out.privateContentIncluded,false);assert.equal(out.cryptographicValidityVerified,false);assert.equal(out.paymentCleared,false);assert.doesNotMatch(r.logs.join(''),/synthetic-private|PRIVATE|evidenceId|operationId/);}
 const duplicate=await command({duplicate:true});assert.equal(JSON.parse(duplicate.logs[0]).alreadyRecorded,true);
 const missing=await command({unrecorded:true});assert.equal(missing.exitCode,2);assert.equal(JSON.parse(missing.logs[0]).recorded,false);
});
test('inspection command rejects root,foreign targets,extra input and invalid services before connecting;runtime failures are redacted',async()=>{
 for(const options of [{root:true},{foreign:true},{disabled:true},{badSocket:true},{extraArg:true},{purpose:'arbitrary'}]){const r=await command(options);assert.equal(r.exitCode,1);assert.equal(r.pools,0);assert.equal(r.calls,0);assert.doesNotMatch(r.logs.join(''),/PRIVATE|synthetic-private/);}
 const failed=await command({failure:true});assert.equal(failed.exitCode,1);assert.ok(failed.ended);assert.doesNotMatch(failed.logs.join(''),/PRIVATE|synthetic-private/);
});

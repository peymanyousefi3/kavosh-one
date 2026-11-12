import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync(new URL('../deploy/ovh/check-boldsign.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
async function run({mode=0o600,region='CA',status=200,tls,fail=false,body=JSON.stringify({result:[{name:'synthetic-private-brand'}]})}={}){
 const logs=[],requests=[];const context=createContext({assert,Buffer,TextDecoder,AbortSignal,
  readFileSync:()=>JSON.stringify({region,environment:'Live',apiKey:'synthetic-private-signing-key'}),lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,uid:0,mode,nlink:1}),
  fetch:async(url,options)=>{requests.push({url,options});if(fail)throw Error('synthetic-private-provider-diagnostic');return new Response(body,{status,headers:{'content-type':'application/json'}});},console:{log:x=>logs.push(x),error:x=>logs.push(x)}});
 runInContext('process={getuid:()=>0,argv:["node","script","--execute"],env:'+JSON.stringify({NODE_TLS_REJECT_UNAUTHORIZED:tls})+'}',context);
 await runInContext('(async()=>{'+source+'})()',context);return{logs,requests,exitCode:context.process.exitCode};
}
test('production signing check uses only fixed Canadian read-only branding endpoint; logs no key or document data',async()=>{
 const r=await run();assert.equal(r.exitCode,undefined);assert.equal(r.requests.length,1);const q=r.requests[0];assert.equal(q.url,'https://api-ca.boldsign.com/v1/brand/list');assert.equal(q.options.method,'GET');assert.equal(q.options.redirect,'error');assert.equal(q.options.credentials,'omit');assert.equal(q.options.body,undefined);assert.doesNotMatch(r.logs.join(''),/synthetic-private/);
});
test('unsafe signing credentials or TLS bypass never connect; provider failures and oversize responses are redacted',async()=>{
 for(const options of [{mode:0o644},{region:'US'},{tls:'0'}]){const r=await run(options);assert.equal(r.exitCode,1);assert.equal(r.requests.length,0);}
 for(const options of [{status:401},{fail:true},{body:'{"result":"invalid"}'},{body:' '.repeat(1048577)}]){const r=await run(options);assert.equal(r.exitCode,1);assert.equal(r.requests.length,1);assert.doesNotMatch(r.logs.join(''),/synthetic-private|apiKey/);}
});

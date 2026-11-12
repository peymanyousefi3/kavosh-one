// Root-only read-only authentication check. Never lists, reads, sends, modifies
// or deletes agreements. Provider response contents and keys are never logged.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync} from 'node:fs';
let phase='configuration',response;
try{
 assert.equal(process.getuid(),0);assert.deepEqual(process.argv.slice(2),['--execute']);assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0');
 const path='/etc/kavosh-one/boldsign-production.json',s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);
 const c=JSON.parse(readFileSync(path,'utf8'));assert.deepEqual(Object.keys(c).sort(),['apiKey','environment','region']);assert.equal(c.region,'CA');assert.equal(c.environment,'Live');assert.match(c.apiKey,/^[\x21-\x7e]{20,4096}$/);
 phase='read-only Canadian endpoint';response=await fetch('https://api-ca.boldsign.com/v1/brand/list',{method:'GET',headers:{'X-API-KEY':c.apiKey,accept:'application/json'},redirect:'error',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(10000)});
 assert.equal(response.status,200);assert.equal(response.redirected,false);assert.equal(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(),'application/json');assert.ok(response.body);
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;assert.ok(bytes<=1048576);chunks.push(r.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const body=Buffer.concat(chunks),payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));body.fill(0);assert.ok(Array.isArray(payload.result));
 console.log(JSON.stringify({executedOnVps:true,region:'CA',environmentConfigured:'Live',authenticatedReadOnlyEndpoint:true,httpStatus:200,agreementRequests:0,agreementsSentModifiedOrDeleted:0,providerResponseContentsLogged:false}));
}catch{try{await response?.body?.cancel();}catch{}console.error('BOLDSIGN_CONNECTION_CHECK_FAILED: '+phase);process.exitCode=1;}

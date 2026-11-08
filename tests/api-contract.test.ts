import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('T4 working-paper contract accepts only a source profile and explicit timezone,not caller monetary or partial-year overrides',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
 for(const suffix of ['','/export']){const op=api.paths['/api/v1/reports/payroll/t4-working-paper'+suffix].get;assert.deepEqual(op.parameters.map((p:{name:string})=>p.name).sort(),['profileId','timeZone']);assert.match(op.summary,/working.paper/i);}
 assert.ok(api.paths['/api/v1/reports/jobs'].post.requestBody.content['application/json'].schema.properties.reportId.enum.includes('payroll.t4-working-paper'));
});

test('bot name editing documents independent name versions and bounded history',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),operation=api.paths['/api/v1/bots/{id}/name'].post,body=operation.requestBody.content['application/json'].schema;
 assert.equal(body.additionalProperties,false);assert.equal(body.properties.expectedNameVersion.minimum,0);assert.equal(body.properties.name.maxLength,200);assert.equal(api.paths['/api/v1/bots/{id}/name/history'].get.parameters.find((p:{name:string})=>p.name==='limit').schema.maximum,50);
});

test('private invitation handoff documents human-only academy authentication,not bot credentials',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));
 assert.deepEqual(api.paths['/api/v1/invitations/{id}/token'].post.security,[{humanSession:[],academySelection:[]}]);
 assert.ok(api.paths['/api/v1/invitations'].post.requestBody.required);
});
test('worker pay statement archive documents human-only academy authentication,not administrative bot access',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));for(const suffix of ['','/{id}','/{id}/history'])assert.deepEqual(api.paths['/api/v1/me/pay-statements'+suffix].get.security,[{humanSession:[],academySelection:[]}]);
});
test('bot private key handoff and revocation document human-only authentication while preparations remain scoped API operations',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));for(const path of ['/api/v1/bot-credential-requests/{id}/token','/api/v1/bots/{id}/credentials/{credentialId}/revoke']){assert.deepEqual(api.paths[path].post.security,[{humanSession:[],academySelection:[]}]);assert.deepEqual(api.paths[path].post.requestBody.content['application/json'].schema.additionalProperties,false);}assert.equal(api.paths['/api/v1/bots/{id}/credentials'].post.requestBody.content['application/json'].schema.properties.capabilities.maxItems,1000);assert.equal(api.paths['/api/v1/bots/{id}/credentials/issued'].get.parameters.find((p:{name:string})=>p.name==='limit').schema.maximum,100);
});

test('committed API reference is byte-exact generator output with sorted paths,without rewriting files',()=>{
 const target=new URL('../public/openapi.json',import.meta.url),generator=new URL('../scripts/generate-api.ts',import.meta.url);
 // Observe the real generator output;do not turn a stale checked-in artifact
 // green by rewriting it as part of its own test.
 const program=`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
 fs.writeFile=async(file,data)=>{if(String(file)!==${JSON.stringify(String(target))})throw Error('UNEXPECTED_API_WRITE');process.stdout.write(data);};
 syncBuiltinESMExports();await import(${JSON.stringify(String(generator))});`;
 const output=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',program],{cwd:fileURLToPath(new URL('../',import.meta.url)),maxBuffer:8_388_608,timeout:15000});
 const saved=readFileSync(target),paths=Object.keys(JSON.parse(saved.toString()).paths);assert.deepEqual(paths,[...paths].sort());assert.ok(output.equals(saved),'API reference differs from current generator output');
});

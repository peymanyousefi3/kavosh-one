import { readFile,writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { schemas,getPaths } from '../src/auth/gateway.ts';
import { businessContract } from '../src/modules/business.ts';
const file=new URL('../public/openapi.json',import.meta.url);
const api=JSON.parse(await readFile(file,'utf8'));
api.info.version='0.9.0';
api.info.description='Tested backend foundation and human identity APIs, not a complete academy/accounting platform. Bots use scoped bearer credentials; verified humans use host-only HttpOnly sessions plus X-Academy-Id, with membership and current role grants checked server-side. Cookie-authenticated mutations require exact APP_ORIGIN. Explicit denial wins. All sensitive responses are no-store.';
api.security=[{botBearer:[]},{humanSession:[],academySelection:[]}];
api.components.securitySchemes.humanSession={type:'apiKey',in:'cookie',name:'__Secure-kavosh.session_token',description:'Opaque HttpOnly signed cookie set by login/MFA, never read or stored by frontend JavaScript. Local HTTP development uses kavosh.session_token.'};
api.components.securitySchemes.academySelection={type:'apiKey',in:'header',name:'X-Academy-Id',description:'Academy UUID; selecting it does not grant membership or permission.'};
for(const path of Object.keys(api.paths))if(path.startsWith('/api/auth/'))delete api.paths[path];
for(const [path,schema] of Object.entries(schemas)) {
  const parameters=[{name:'Origin',in:'header',required:true,schema:{type:'string',format:'uri'},description:'Must exactly match configured APP_ORIGIN.'}];
  if(path==='/sign-up/email')parameters.push({name:'X-Kavosh-Invitation',in:'header',required:true,schema:{type:'string',format:'password'},description:'Single-use private kvi_ invitation for this email.'});
  api.paths['/api/auth'+path]={post:{security:[],summary:path.slice(1).replaceAll('/',' · ').replaceAll('-',' '),
    description:'Authentication gateway allowlist. Strict JSON, 16 KiB maximum. Phone setup requires a fresh email-verified session; academy access also requires phone verification. Master MFA is mandatory on new devices; enabling/disabling MFA or changing password revokes sessions. Reset does not disable MFA. Session revocation uses sessionId, never raw token. See repository auth flow for sequencing.',parameters,
    requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(schema,{io:'input'})}}},responses:{'200':{description:'Completed; may require email/phone/MFA next. Session tokens are never returned in JSON.'},'202':{description:'Recovery/resend accepted without disclosing account existence.'},default:{$ref:'#/components/responses/error'}}}};
}
for(const path of getPaths)api.paths['/api/auth'+path]={get:{security:[],summary:path.slice(1).replaceAll('-',' '),
  ...(path==='/verify-email'?{parameters:[{name:'token',in:'query',required:true,schema:{type:'string',maxLength:2048}},{name:'callbackURL',in:'query',schema:{type:'string'},description:'Only same-origin redirects accepted by authentication library.'}]}:{}),
  description:'Session-backed endpoints do not expose session tokens. Memberships require completed verification and MFA when enabled. verify-email is a bounded signed verification link; it does not sign in.',
  responses:{'200':{description:'Result'},'302':{description:'Same-origin verification redirect'},default:{$ref:'#/components/responses/error'}}}};
for(const endpoint of businessContract) {
  const parameters:Record<string,unknown>[]=[];
  if(endpoint.path.includes('{id}'))parameters.push({name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}});
  if(endpoint.method==='post'&&!('readOnly' in endpoint&&endpoint.readOnly))parameters.push({$ref:'#/components/parameters/idempotency'});
  if('paged' in endpoint)parameters.push({$ref:'#/components/parameters/limit'},{$ref:'#/components/parameters/after'});
  if('querySchema' in endpoint&&endpoint.querySchema) {
    const query=z.toJSONSchema(endpoint.querySchema,{io:'input'});
    for(const [name,schema] of Object.entries(query.properties??{}))parameters.push({name,in:'query',required:query.required?.includes(name)??false,schema});
  }
  const operation={summary:endpoint.summary,parameters,
    description:'Permission-aware academy/backend API. Approval-required actions return pending proposals for non-masters; ordinary catalogue edits apply within granted scope using optimistic versions. Unmentioned patch fields retain their values. Course modules, when supplied, replace the complete ordered outline; earlier revisions are preserved. No UI or live-provider verification is implied.',
    ...('schema' in endpoint&&endpoint.schema?{requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(endpoint.schema,{io:'input'})}}}}:{}),
    responses:{'200':{description:'Current data or applied change'},'201':{description:'Created within granted rights or master self-approval'},'202':{description:'Pending upper approval; domain change NOT applied'},default:{$ref:'#/components/responses/error'}}};
  api.paths[endpoint.path]??={};api.paths[endpoint.path][endpoint.method]=operation;
}
api.paths=Object.fromEntries(Object.keys(api.paths).sort().map(path=>[path,api.paths[path]]));
await writeFile(file,JSON.stringify(api,null,2)+'\n');

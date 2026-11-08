import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('private signing document and audit attachment APIs are human-only with no artifact hash credential or admission override',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));for(const kind of ['document','audit']){const op=api.paths['/api/v1/signature-send-requests/{id}/completion-evidence/{evidenceId}/'+kind+'/download-link'].post;assert.deepEqual(op.security,[{humanSession:[],academySelection:[]}]);const schema=op.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(schema.properties),['routeId']);assert.equal(schema.additionalProperties,false);assert.match(op.summary,/explicitly upper-reviewed signedEvidence/);assert.match(op.summary,/not admission/);}
});
test('completion directory contract is bounded read-only metadata without archive or admission overrides',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),path='/api/v1/signature-send-requests/{id}/completion-evidence';for(const p of [path,path+'/{evidenceId}']){assert.ok(api.paths[p].get);assert.equal(api.paths[p].post,undefined);assert.match(api.paths[p].get.summary,/metadata/);}const query=api.paths[path].get.parameters.filter((p:any)=>p.in==='query');assert.equal(query.find((p:any)=>p.name==='limit').schema.maximum,50);assert.deepEqual(query.find((p:any)=>p.name==='state').schema.enum,['evidence_recorded','review_required']);assert.equal(query.some((p:any)=>['fileId','storageTargetId','admissionCleared','approved','signerId'].includes(p.name)),false);
});

test('agreement preparation documents guardian-led pending child profiles without an account activation or verification override',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),op=api.paths['/api/v1/enrollments/{id}/agreement-packages'].post;assert.match(op.summary,/pending minor profile needs no child login/);assert.match(op.summary,/never activates/);const s=op.requestBody.content['application/json'].schema;assert.equal(s.additionalProperties,false);for(const key of ['studentStatus','emailVerified','phoneVerified','admissionCleared','activateChild'])assert.equal(s.properties[key],undefined);
});

test('family registration and preparation APIs are human-only bounded and do not offer admission or signer overrides',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),path='/api/v1/students/{id}/registrations';for(const p of [path,path+'/{enrollmentId}',path+'/{enrollmentId}/agreements']){assert.deepEqual(api.paths[p].get.security,[{humanSession:[],academySelection:[]}]);assert.equal(api.paths[p].post,undefined);}assert.equal(api.paths[path].get.parameters.find((p:any)=>p.name==='limit').schema.maximum,50);assert.equal(api.paths[path+'/{enrollmentId}/agreements'].get.parameters.find((p:any)=>p.name==='limit').schema.maximum,20);assert.equal(api.paths[path].get.parameters.some((p:any)=>p.name==='signerId'||p.name==='admissionCleared'),false);
});

test('family receipt attachment contract is human-only and accepts no file copy source or recipient selection',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),op=api.paths['/api/v1/students/{id}/tuition-invoices/{invoiceId}/receipts/{receiptId}/attachment-download-link'].post;assert.deepEqual(op.security,[{humanSession:[],academySelection:[]}]);const s=op.requestBody.content['application/json'].schema;assert.deepEqual(s.properties,{});assert.equal(s.additionalProperties,false);assert.match(op.summary,/original upper-approved receipt attachment/);
});

test('family installment status documents only a bounded comparison date,not money or historical source overrides',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),path='/api/v1/students/{id}/tuition-invoices/{invoiceId}/installment-status',op=api.paths[path].get;assert.deepEqual(op.security,[{humanSession:[],academySelection:[]}]);assert.equal(api.paths[path].post,undefined);assert.deepEqual(op.parameters.filter((p:any)=>p.in==='query').map((p:any)=>p.name),['overdueOn']);assert.match(op.summary,/NOT a historical/);
});

test('family posted invoices and recorded payments are human-only bounded reads without paid overrides',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),path='/api/v1/students/{id}/tuition-invoices';for(const p of [path,path+'/{invoiceId}',path+'/{invoiceId}/receipts']){assert.deepEqual(api.paths[p].get.security,[{humanSession:[],academySelection:[]}]);assert.equal(api.paths[p].post,undefined);}for(const p of [path,path+'/{invoiceId}/receipts'])assert.equal(api.paths[p].get.parameters.find((p:any)=>p.name==='limit').schema.maximum,50);assert.deepEqual(api.paths[path+'/{invoiceId}/receipts'].get.parameters.find((p:any)=>p.name==='status').schema.enum,['recorded','reversed']);
});

test('family tuition API is human-only,bounded and cannot request staff history or set paid state',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),path='/api/v1/students/{id}/tuition-plans';for(const p of [path,path+'/{planId}']){assert.deepEqual(api.paths[p].get.security,[{humanSession:[],academySelection:[]}]);assert.equal(api.paths[p].post,undefined);}const params=api.paths[path].get.parameters;assert.equal(params.find((p:any)=>p.name==='limit').schema.maximum,50);assert.deepEqual(params.find((p:any)=>p.name==='state').schema.enum,['active','cancelled']);assert.equal(params.some((p:any)=>p.name==='version'||p.name==='paid'),false);assert.equal(api.paths[path+'/{planId}'].get.parameters.some((p:any)=>p.name==='version'),false);
});

test('invitation acceptance contract remains a private-token and verified-session operation without caller identity recipient or role overrides',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),op=api.paths['/api/auth/accept-invitation'].post;assert.deepEqual(op.security,[{humanSession:[]}]);const schema=op.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(schema.properties),['invitation']);assert.equal(schema.additionalProperties,false);assert.equal(schema.properties.invitation.maxLength,100);assert.ok(op.description.includes('SAME auth identity'));assert.ok(op.description.includes('expiry/revocation'));
});

test('account security contract provides one scoped metadata history and own aliases with strict bounded cursors and no contact-value editing',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));for(const path of ['/api/v1/me/account-security','/api/v1/people/{id}/account-security']){assert.ok(api.paths[path].get);assert.equal(api.paths[path].post,undefined);const params=api.paths[path].get.parameters;assert.equal(params.find((p:any)=>p.name==='limit').schema.maximum,50);assert.deepEqual(params.find((p:any)=>p.name==='field').schema.enum,['email','phone']);assert.ok(api.paths[path+'/{eventId}'].get);}assert.ok(api.paths['/api/v1/automations/events'].get.parameters.find((p:any)=>p.name==='sourceKind').schema.enum.includes('account_security'));
});

test('email replacement contract requires a signed session real password and separate strict request-bound proof stages',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));for(const [path,method] of [['','get'],['/request','post'],['/authorize','post'],['/confirm','post'],['/cancel','post']])assert.deepEqual(api.paths['/api/auth/email-change'+path][method].security,[{humanSession:[]}]);for(const suffix of ['authorize','confirm']){const s=api.paths['/api/auth/email-change/'+suffix].post.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(s.properties).sort(),['code','requestId']);assert.equal(s.properties.code.pattern,'^\\d{8}$');assert.equal(s.additionalProperties,false);}const s=api.paths['/api/auth/email-change/request'].post.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(s.properties).sort(),['email','password']);assert.equal(s.properties.email.maxLength,254);assert.equal(s.properties.password.maxLength,128);assert.equal(s.additionalProperties,false);assert.equal(api.paths['/api/auth/change-email'],undefined);
});

test('phone recovery contract binds private signed sessions and bounded password email code and request identity without client verification flags',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8'));for(const [path,method] of [['','get'],['/request','post'],['/authorize','post'],['/cancel','post']])assert.deepEqual(api.paths['/api/auth/phone-change'+path][method].security,[{humanSession:[]}]);const a=api.paths['/api/auth/phone-change/authorize'].post.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(a.properties).sort(),['code','requestId']);assert.equal(a.additionalProperties,false);assert.equal(a.properties.code.pattern,'^\\d{8}$');const r=api.paths['/api/auth/phone-change/request'].post.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(r.properties).sort(),['password','phoneNumber']);assert.equal(r.properties.password.maxLength,128);assert.equal(r.additionalProperties,false);assert.equal(api.paths['/api/auth/verify-password'],undefined);assert.equal(api.paths['/api/auth/change-email'],undefined);
});

test('self guardian onboarding contract is human-only self-targeted and cannot edit login verification or child associations',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),path='/api/v1/me/guardian-profile';for(const [suffix,method] of [['','get'],['/corrections','post'],['/corrections','get'],['/corrections/{requestId}/withdraw','post']])assert.deepEqual(api.paths[path+suffix][method].security,[{humanSession:[],academySelection:[]}]);const s=api.paths[path+'/corrections'].post.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(s.properties).sort(),['changes','expectedVersion','reason']);assert.equal(s.additionalProperties,false);assert.equal(s.properties.expectedVersion.minimum,0);assert.equal(s.properties.expectedVersion.maximum,2147483646);assert.deepEqual(Object.keys(s.properties.changes.properties).sort(),['legalName','wechatId']);assert.equal(s.properties.changes.additionalProperties,false);assert.equal(api.paths[path+'/corrections'].get.parameters.find((p:any)=>p.name==='limit').schema.maximum,50);assert.deepEqual(Object.keys(api.paths[path+'/corrections/{requestId}/withdraw'].post.requestBody.content['application/json'].schema.properties).sort(),['expectedVersion','reason']);
});

test('family care intake API is human-only with bounded own submission and audited-current-reading contracts',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),path='/api/v1/students/{id}/registration-data/care';for(const [suffix,method] of [['','get'],['/reveal','post'],['/submissions','get'],['/submissions','post'],['/submissions/{requestId}/reveal','post'],['/submissions/{requestId}/withdraw','post']])assert.deepEqual(api.paths[path+suffix][method].security,[{humanSession:[],academySelection:[]}]);const s=api.paths[path+'/submissions'].post.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(s.properties).sort(),['details','expectedVersion','purpose','reason','state']);assert.equal(s.additionalProperties,false);assert.equal(s.properties.expectedVersion.maximum,2147483646);for(const suffix of ['/reveal','/submissions/{requestId}/reveal'])assert.equal(api.paths[path+suffix].post.parameters.some((v:any)=>v.$ref==='#/components/parameters/idempotency'),false);assert.equal(api.paths[path+'/submissions'].get.parameters.find((p:any)=>p.name==='limit').schema.maximum,50);assert.deepEqual(Object.keys(api.paths[path+'/submissions/{requestId}/withdraw'].post.requestBody.content['application/json'].schema.properties).sort(),['expectedVersion','reason']);
});

test('student care API separates encrypted input metadata and audited human-only reveal without cached response retention',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),path='/api/v1/students/{id}/care',body=api.paths[path].post.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(body.properties).sort(),['details','expectedVersion','purpose','reason','state']);assert.equal(body.additionalProperties,false);assert.equal(body.properties.expectedVersion.minimum,0);assert.equal(body.properties.expectedVersion.maximum,2147483646);const details=body.properties.details.anyOf.find((v:any)=>v.type==='object');assert.deepEqual(Object.keys(details.properties).sort(),['allergies','considerations']);assert.equal(details.additionalProperties,false);for(const [suffix,method] of [['','get'],['','post'],['/history','get'],['/reveal','post'],['/proposal-reveal','post']])assert.deepEqual(api.paths[path+suffix][method].security,[{humanSession:[],academySelection:[]}]);for(const suffix of ['/reveal','/proposal-reveal'])assert.equal(api.paths[path+suffix].post.parameters.some((p:any)=>p.$ref==='#/components/parameters/idempotency'),false);
});

test('family registration API is human-only and cannot submit recruiter care finance identity flags or another actor',()=>{
 const reference=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),withdraw=reference.paths['/api/v1/students/{id}/registration-data/corrections/{correctionId}/withdraw'].post;assert.deepEqual(withdraw.security,[{humanSession:[],academySelection:[]}]);assert.deepEqual(Object.keys(withdraw.requestBody.content['application/json'].schema.properties).sort(),['expectedVersion','reason']);
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),path='/api/v1/students/{id}/registration-data';for(const [p,method] of [[path,'get'],[path+'/corrections','post'],[path+'/corrections','get']])assert.deepEqual(api.paths[p][method].security,[{humanSession:[],academySelection:[]}]);const s=api.paths[path+'/corrections'].post.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(s.properties).sort(),['changes','expectedVersion','reason']);assert.equal(s.additionalProperties,false);assert.equal(s.properties.expectedVersion.maximum,2147483646);assert.deepEqual(Object.keys(s.properties.changes.properties).sort(),['dateOfBirth','legalName','preferredName','shirtSize']);assert.equal(s.properties.changes.additionalProperties,false);
});

test('central profile moderation filters are explicit optional choices without default publication or status inference',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),parameters=api.paths['/api/v1/community/profiles'].get.parameters;for(const name of ['includeModeration','restricted']){const p=parameters.find((v:any)=>v.name===name);assert.equal(p.required,false);assert.deepEqual(p.schema.enum,['true','false']);assert.equal(Object.hasOwn(p.schema,'default'),false);}
});

test('profile moderation contract separates exact draft and moderation versions and private history from self authoring',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),p=api.paths['/api/v1/community/profiles/{id}/moderation'],s=p.post.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(s.properties).sort(),['expectedProfileVersion','expectedVersion','reason','restricted']);assert.equal(s.additionalProperties,false);assert.equal(s.properties.expectedVersion.minimum,0);assert.equal(s.properties.expectedVersion.maximum,2147483646);assert.equal(s.properties.expectedProfileVersion.exclusiveMinimum,0);assert.equal(s.properties.restricted.type,'boolean');assert.equal(Object.hasOwn(s.properties.restricted,'default'),false);const history=api.paths['/api/v1/community/profiles/{id}/moderation/history'].get;assert.equal(history.parameters.find((v:any)=>v.name==='limit').schema.maximum,20);
});

test('self avatar API requires a human session and only a bounded current profile edition',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),operation=api.paths['/api/v1/me/community-profile/avatar-download-link'].post,schema=operation.requestBody.content['application/json'].schema;assert.deepEqual(operation.security,[{humanSession:[],academySelection:[]}]);assert.deepEqual(Object.keys(schema.properties),['expectedProfileVersion']);assert.equal(schema.additionalProperties,false);assert.equal(schema.properties.expectedProfileVersion.exclusiveMinimum,0);assert.equal(schema.properties.expectedProfileVersion.maximum,2147483647);
});

test('self profile API is human-only strictly self-targeted and separately versioned without publication inputs',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),path=api.paths['/api/v1/me/community-profile'];for(const method of ['get','post'])assert.deepEqual(path[method].security,[{humanSession:[],academySelection:[]}]);const schema=path.post.requestBody.content['application/json'].schema;assert.deepEqual(Object.keys(schema.properties).sort(),['definition','expectedVersion']);assert.equal(schema.additionalProperties,false);assert.equal(schema.properties.expectedVersion.minimum,0);assert.equal(schema.properties.expectedVersion.maximum,2147483646);assert.equal(schema.properties.definition.additionalProperties,false);assert.equal(Object.hasOwn(schema.properties.definition.properties,'visibility'),false);assert.equal(path.get.parameters.length,0);
});

test('paid tax reporting partitions document complete bounded inputs and explicit source-prefill opt-in without changing legacy defaults',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),schema=api.paths['/api/v1/payroll/tax-profiles/{id}/payments/{paymentId}'].post.requestBody.content['application/json'].schema.properties.definition.anyOf.find((s:any)=>s.type==='object'),allocations=schema.properties.t4Allocations;
 assert.equal(schema.required.includes('t4Allocations'),false);assert.equal(allocations.minItems,1);assert.equal(allocations.maxItems,15);assert.equal(allocations.items.additionalProperties,false);assert.ok(allocations.items.properties.provinceOfEmployment.enum.includes('ON'));assert.equal(schema.properties.t4Order.maximum,1000000);const flag=api.paths['/api/v1/payroll/tax-profiles/{id}/payments/{paymentId}/calculated-draft'].get.parameters.find((p:any)=>p.name==='includeT4Allocations');assert.equal(flag.required,false);assert.deepEqual(flag.schema.enum,['true','false']);assert.equal(Object.hasOwn(flag.schema,'default'),false);
});

test('RP payment binding and explicit calculated prefill use optional bounded references without default assignment',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),d=api.paths['/api/v1/payroll/tax-profiles/{id}/payments/{paymentId}'].post.requestBody.content['application/json'].schema.properties.definition.anyOf.find((v:any)=>v.type==='object');assert.equal(d.required.includes('reportingAccount'),false);assert.equal(d.properties.reportingAccount.additionalProperties,false);assert.deepEqual(d.properties.reportingAccount.required,['id','version']);const p=api.paths['/api/v1/payroll/tax-profiles/{id}/payments/{paymentId}/prepare'].post.requestBody.content['application/json'].schema;assert.equal(p.required.includes('includeReportingAccount'),false);const flag=api.paths['/api/v1/payroll/tax-profiles/{id}/payments/{paymentId}/calculated-draft'].get.parameters.find((p:any)=>p.name==='includeReportingAccount');assert.equal(flag.required,false);assert.deepEqual(flag.schema.enum,['true','false']);assert.equal(Object.hasOwn(flag.schema,'default'),false);
});
test('worker tax profiles document optional explicit employer-account references without automatic historical assignment',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),d=api.paths['/api/v1/payroll/tax-profiles'].post.requestBody.content['application/json'].schema.properties.definition,ref=d.properties.reportingAccount;assert.equal(d.required.includes('reportingAccount'),false);assert.equal(ref.additionalProperties,false);assert.deepEqual(ref.required,['id','version']);assert.equal(ref.properties.version.exclusiveMinimum,0);assert.equal(ref.properties.version.maximum,2147483646);assert.equal(Object.hasOwn(ref,'default'),false);assert.match(ref.description,/not a historical payment assignment/i);
});
test('private employer reporting API has separate bounded routes and never accepts CRA credentials or money inputs',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),body=api.paths['/api/v1/payroll/employer-accounts'].post.requestBody.content['application/json'].schema;assert.equal(body.additionalProperties,false);assert.deepEqual(Object.keys(body.properties).sort(),['accountNumber','code','definition','effectiveOn','employer','reason']);assert.equal(body.properties.definition.additionalProperties,false);assert.equal(api.paths['/api/v1/payroll/employer-accounts/{id}/history'].get.parameters.find((p:any)=>p.name==='limit').schema.maximum,20);assert.ok(api.paths['/api/v1/payroll/employer-accounts/{id}/change'].post.requestBody.content['application/json'].schema.required.includes('expectedVersion'));
});
test('T4 supplemental API documents bounded explicit source allocations whole-dollar pension adjustments and private evidence',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),annual=api.paths['/api/v1/payroll/tax-profiles'].post.requestBody.content['application/json'].schema.properties.definition.properties.yearEndT4,extra=annual.properties.provincialSupplemental,item=extra.items;
 assert.equal(annual.required.includes('provincialSupplemental'),false);assert.equal(extra.minItems,1);assert.equal(extra.maxItems,100);assert.equal(item.additionalProperties,false);assert.equal(item.properties.deductionAllocations.maxItems,100);assert.deepEqual(item.properties.deductionAllocations.items.properties.reportingBox.enum,['20','44','46']);assert.equal(item.properties.pensionAdjustmentDollars.type,'string');assert.equal(item.properties.pensionAdjustmentDollars.pattern,'^(0|[1-9][0-9]*)$');for(const key of ['unionReceiptAgreementConfirmed','pensionAdjustmentEligibilityReviewed','sourceReference'])assert.ok(item.required.includes(key));assert.equal(Object.hasOwn(item.properties.pensionAdjustmentDollars,'default'),false);
});
test('T4 box28 API requires explicit per-province full-period marks with a private review source and no guessed defaults',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),annual=api.paths['/api/v1/payroll/tax-profiles'].post.requestBody.content['application/json'].schema.properties.definition.properties.yearEndT4,items=annual.properties.provincialExemptions;
 assert.equal(annual.required.includes('provincialExemptions'),false);assert.equal(items.minItems,1);assert.equal(items.maxItems,100);assert.equal(items.items.additionalProperties,false);assert.deepEqual(items.items.required,['provinceOfEmployment','cppQpp','ei','ppip','sourceReference']);for(const k of ['cppQpp','ei','ppip']){assert.equal(items.items.properties[k].type,'boolean');assert.equal(Object.hasOwn(items.items.properties[k],'default'),false);}
});
test('annual T4 dental API requires an explicit code and private source reference without a default no-coverage answer',()=>{
 const api=JSON.parse(readFileSync(new URL('../public/openapi.json',import.meta.url),'utf8')),definition=api.paths['/api/v1/payroll/tax-profiles'].post.requestBody.content['application/json'].schema.properties.definition,annual=definition.properties.yearEndT4;
 assert.equal(definition.required.includes('yearEndT4'),false);assert.equal(annual.additionalProperties,false);assert.deepEqual(annual.properties.dentalAccessCode.enum,['1','2','3','4','5']);assert.deepEqual(annual.required,['dentalAccessCode','dentalSourceReference']);assert.equal(Object.hasOwn(annual.properties.dentalAccessCode,'default'),false);
});

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

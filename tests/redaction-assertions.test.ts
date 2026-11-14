import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAuditEnvelope,assertGenericCriticalNotice,assertPrivateErrorEnvelope,assertPrivateNoticeEnvelope,assertPayStatementProjection } from './redaction-assertions.ts';

test('private errors accept a canonical request ID containing money-like digits but reject all private additions',()=>{
 const requestId='47fff1f6-f0bb-481c-a8b1-bdaa5412030d',code='REPORT_SOURCE_ACCESS_CHANGED',body={error:{code,requestId}};assert.match(requestId,/12030/);assert.doesNotThrow(()=>assertPrivateErrorEnvelope(body,code));for(const value of [{error:{...body.error,amount:12030}},{...body,sha256:'private'},{error:{...body.error,code:'PRIVATE'}},{error:{...body.error,requestId:'12030'}},{error:{...body.error,message:'PRIVATE source'}}])assert.throws(()=>assertPrivateErrorEnvelope(value,code));
});
test('multipart report errors accept the actual harmless2825 trace but reject hashes,counts,amounts and extra text',()=>{
 const requestId='76adc647-fc8d-4c94-8caa-2a8a2825aa7a',code='REPORT_SOURCE_ACCESS_CHANGED',body={error:{code,requestId}};
 assert.doesNotThrow(()=>assertPrivateErrorEnvelope(body,code));
 for(const value of [{...body,sha256:'private'},{...body,partCount:2},{...body,totalBytes:2825},{error:{...body.error,amount:2825}},{error:{...body.error,message:'PRIVATE'}}])assert.throws(()=>assertPrivateErrorEnvelope(value,code));
});

// The first ID is the actual harmless reference that triggered CI42010122277.
const id='c543000f-7702-4468-974b-4e6347f55f61',expected={version:2,severity:'critical',hasReason:true,effectiveOn:'2026-07-01',classificationCertified:false};
test('audit privacy accepts canonical approval references containing salary-like digits but rejects any extra field or altered value',()=>{
 assert.match(id,/3000/);
 assert.doesNotThrow(()=>assertAuditEnvelope({...expected,approvalId:id},expected));
 for(const value of [{...expected,approvalId:id,amount:'3000'},{...expected,approvalId:id,privateName:'Private legal worker'},{...expected,approvalId:id,taxReview:'Private tax facts'},{...expected,approvalId:'3000'},{...expected,approvalId:id,severity:'normal'}])assert.throws(()=>assertAuditEnvelope(value,expected));
});
test('generic critical notice privacy validates the whole message/envelope rather than matching digits in IDs or timestamps',()=>{
 const notice={id,title:'Critical activity recorded',body:'Open the linked approval record to review this activity. Reading this notification does not approve or resolve it.',severity:'critical',locale:'en',origin:'mandatory',source:{kind:'approval',id},eventId:id,createdAt:'2026-12-15T10:00:00.000Z',readAt:null,contentType:'text/plain',deliveryChannel:'portal'};
 assert.doesNotThrow(()=>assertGenericCriticalNotice(notice));for(const value of [{...notice,amount:'3000'},{...notice,payOn:'2026-12-15'},{...notice,body:'Private salary 3000'},{...notice,source:{...notice.source,definition:{classification:'T4'}}},{...notice,id:'3000'},{...notice,createdAt:'3000'},{...notice,readAt:'3000'}])assert.throws(()=>assertGenericCriticalNotice(value));
});
test('pay-statement notices and source projections accept the actual harmless CI reference containing 3000 but reject private fields and content',()=>{
 const postingId='c9efa342-6c2e-442e-b7b0-3bb8bfa3000f',basis={postingId,releaseVersion:1,statementVersion:1,state:'released' as const},projection={eventType:'pay-statement.released',entityId:postingId,hubId:null,actorId:null,actorKind:'system',severity:'critical',occurredAt:'2026-11-12T22:59:31.310Z',attributes:basis};
 assert.match(postingId,/3000/);assert.doesNotThrow(()=>assertPayStatementProjection(projection,basis));for(const p of [{...projection,amount:'3000'},{...projection,attributes:{...basis,workerName:'PRIVATE'}},{...projection,actorId:postingId}])assert.throws(()=>assertPayStatementProjection(p,basis));
 const expected={title:'Statement released',body:'Open your statement archive to review the released copy. This notice does not confirm payment.',severity:'critical',locale:'en',origin:'mandatory',source:{kind:'pay_statement',id:postingId,releaseVersion:1,state:'released',archivePath:'/api/v1/me/pay-statements/'+postingId+'?releaseVersion=1'},releaseStillCurrent:true,statementReadReceiptRecorded:false},notice={id:postingId,...expected,eventId:postingId,createdAt:'2026-11-12T22:59:31.310129Z',readAt:null,contentType:'text/plain',deliveryChannel:'portal'};
 assert.doesNotThrow(()=>assertPrivateNoticeEnvelope(notice,expected));for(const n of [{...notice,amount:'3350'},{...notice,body:'PRIVATE payroll 3000'},{...notice,source:{...expected.source,approvalId:postingId}}])assert.throws(()=>assertPrivateNoticeEnvelope(n,expected));
});

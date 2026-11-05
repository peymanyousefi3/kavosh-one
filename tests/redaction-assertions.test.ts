import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAuditEnvelope,assertGenericCriticalNotice } from './redaction-assertions.ts';

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

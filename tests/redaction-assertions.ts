import assert from 'node:assert/strict';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const instant=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
// Compare the entire allowed envelope, not money-like substrings inside random
// IDs. Extra private fields and changed public message text must still fail.
export function assertAuditEnvelope(value:unknown,expected:Record<string,unknown>){
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value));
 const {approvalId,...envelope}=value as Record<string,unknown>;
 assert.equal(typeof approvalId,'string');assert.match(approvalId as string,uuid);assert.deepEqual(envelope,expected);
}
export function assertGenericCriticalNotice(value:unknown){
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value));const n=value as Record<string,unknown>;
 assert.ok(n.source&&typeof n.source==='object'&&!Array.isArray(n.source));const source=n.source as Record<string,unknown>;
 for(const id of [n.id,n.eventId,source.id]){assert.equal(typeof id,'string');assert.match(id as string,uuid);}
 assert.equal(typeof n.createdAt,'string');assert.match(n.createdAt as string,instant);assert.ok(Number.isFinite(Date.parse(n.createdAt as string)));
 if(n.readAt!==null){assert.equal(typeof n.readAt,'string');assert.match(n.readAt as string,instant);assert.ok(Number.isFinite(Date.parse(n.readAt as string)));}
 assert.deepEqual(n,{id:n.id,title:'Critical activity recorded',body:'Open the linked approval record to review this activity. Reading this notification does not approve or resolve it.',severity:'critical',locale:'en',origin:'mandatory',source:{kind:'approval',id:source.id},eventId:n.eventId,createdAt:n.createdAt,readAt:n.readAt,contentType:'text/plain',deliveryChannel:'portal'});
}

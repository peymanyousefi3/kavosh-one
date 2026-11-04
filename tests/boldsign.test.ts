import assert from 'node:assert/strict';
import { createHmac,webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { verifyBoldSignSignature } from '../src/integrations/boldsign.ts';

const now=1700000000,secret='synthetic-webhook-secret',body=Buffer.from('{"event":{"id":"synthetic-event","eventType":"Completed","environment":"Test"}}');
// Independent OpenSSL fixture: HMAC-SHA256(secret, timestamp + '.' + raw bytes).
const digest='699f6864bef84092e8d734d537b363cbc2e0a5085fa23b728c57a69e7884831b',header=`t=${now}, s0=${digest}`;
const invalid={code:'INVALID_BOLDSIGN_SIGNATURE',status:401};
function sign(bytes:Uint8Array,key=secret,time=now){return createHmac('sha256',key).update(time+'.').update(bytes).digest('hex');}

test('BoldSign raw-byte verification matches independent OpenSSL and Web Crypto evidence, including Unicode',async()=>{
  assert.equal(verifyBoldSignSignature(body,header,[secret],now),now);
  const bytes=Buffer.from('{"message":"机器人 — Montréal","spacing":  true}\n'),key=await webcrypto.subtle.importKey('raw',Buffer.from(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Buffer.from(await webcrypto.subtle.sign('HMAC',key,Buffer.concat([Buffer.from(now+'.'),bytes]))).toString('hex');
  assert.equal(verifyBoldSignSignature(bytes,`t=${now},s0=${signature}`,[secret],now),now);
  assert.throws(()=>verifyBoldSignSignature(Buffer.from(JSON.stringify(JSON.parse(bytes.toString()))),`t=${now},s0=${signature}`,[secret],now),invalid,'re-serialization must not preserve authenticity');
  assert.throws(()=>verifyBoldSignSignature(Buffer.from(body.toString()+' '),header,[secret],now),invalid);
  assert.throws(()=>verifyBoldSignSignature(body,header,['different-test-secret'],now),invalid);
});
test('BoldSign callback time window rejects stale and future signatures without allowing tolerance disablement',()=>{
  for(const delta of [-300,0,300])assert.equal(verifyBoldSignSignature(body,`t=${now+delta},s0=${sign(body,secret,now+delta)}`,[secret],now),now+delta);
  for(const delta of [-301,301])assert.throws(()=>verifyBoldSignSignature(body,`t=${now+delta},s0=${sign(body,secret,now+delta)}`,[secret],now),invalid);
});
test('BoldSign rotation accepts configured current or previous keys but never unconfigured keys',()=>{
  const next='synthetic-next-secret',rotation=`t=${now}, s0=${sign(body,next)}, s1=${digest}`;
  for(const keys of [[next],[secret],[next,secret]])assert.equal(verifyBoldSignSignature(body,rotation,keys,now),now);
  assert.throws(()=>verifyBoldSignSignature(body,header,[next],now),invalid,'retiring the old key invalidates its otherwise fresh signature');
});
test('BoldSign signature grammar rejects duplicates, malformed hashes, unsupported fields and ambiguous timestamps',()=>{
  for(const value of [null,'',`t=${now}`,`s0=${digest}`,`t=${now},s1=${digest}`,header+',t='+now,header+',s0='+digest,header+',s1='+digest+',s1='+digest,
    header+',x=ignored',header+',',`t=0${now},s0=${digest}`,`t=+${now},s0=${digest}`,`t=${now}.0,s0=${digest}`,`t=1e9,s0=${digest}`,`t=99999999999999,s0=${digest}`,
    `t=${now},s0=${digest.slice(1)}`,`t=${now},s0=${digest}00`,`t=${now},s0=${'g'.repeat(64)}`,header+',s1=invalid',' '.repeat(1025)+header])
    assert.throws(()=>verifyBoldSignSignature(body,value,[secret],now),invalid,String(value));
  assert.equal(verifyBoldSignSignature(body,` t=${now} , s0=${digest.toUpperCase()} `,[secret],now),now);
});
test('BoldSign verification fails closed for missing configuration and never exposes supplied secrets',()=>{
  for(const keys of [[],[''],[secret,''],[secret,secret,secret],['x'.repeat(4097)]])assert.throws(()=>verifyBoldSignSignature(body,header,keys,now),{code:'BOLDSIGN_VERIFICATION_NOT_CONFIGURED',status:503});
  for(const time of [NaN,Infinity,-1,now+0.5])assert.throws(()=>verifyBoldSignSignature(body,header,[secret],time),{code:'BOLDSIGN_VERIFICATION_NOT_CONFIGURED',status:503});
  try{verifyBoldSignSignature(body,header,['wrong-secret'],now);assert.fail('must reject');}catch(error){assert.ok(!String(error).includes('wrong-secret'));assert.ok(!String(error).includes(digest));}
});

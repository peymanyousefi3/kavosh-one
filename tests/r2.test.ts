import assert from 'node:assert/strict';
import { createHash,createHmac } from 'node:crypto';
import { test } from 'node:test';
import { privateR2 } from '../src/integrations/r2.ts';
import type { R2Connection } from '../src/integrations/r2-config.ts';

const academy='8fbe4060-32ec-46a9-a97d-78ea54fe50e6',other='aa3135f8-3dfe-4e79-9b67-ab4098319728',file='73e6a708-ad23-484b-9b12-91db85854593';
const config:R2Connection={accountId:'a'.repeat(32),jurisdiction:'default',bucket:'synthetic-private-files',accessKeyId:'synthetic-access-id',secretAccessKey:'synthetic-r2-secret-not-a-real-key',maximumUploadBytes:1000000};
function fixture(c:R2Connection=config,a=academy) {
  let requests=0,destroyed=0;
  const store=privateR2(c,a,{async handle(){requests++;throw new Error('Tests must never contact storage');},destroy(){destroyed++;}});
  return {store,requests:()=>requests,destroyed:()=>destroyed};
}
// Independent SigV4 reference calculation, not the SDK presigner under test.
// It validates the exact HTTP method, object, query and required header binding.
function signature(url:string,method:string,headers:Record<string,string>) {
  const u=new URL(url),q=u.searchParams,encode=(v:string)=>encodeURIComponent(v).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  const pairs=[...q].filter(([k])=>k!=='X-Amz-Signature').map(([k,v])=>[encode(k),encode(v)]);
  pairs.sort(([a,av],[b,bv])=>a<b?-1:a>b?1:av<bv?-1:av>bv?1:0);
  const signed=q.get('X-Amz-SignedHeaders')!,values:Record<string,string>={host:u.host,...headers};
  const canonicalHeaders=signed.split(';').map(h=>h+':'+(values[h]??'').trim().replace(/\s+/g,' ')+'\n').join('');
  const canonical=[method,u.pathname,pairs.map(([k,v])=>k+'='+v).join('&'),canonicalHeaders,signed,'UNSIGNED-PAYLOAD'].join('\n');
  const scope=q.get('X-Amz-Credential')!.split('/').slice(1),date=q.get('X-Amz-Date')!;
  const hmac=(key:string|Uint8Array,data:string)=>createHmac('sha256',key).update(data).digest();
  let key:Uint8Array=Buffer.from('AWS4'+config.secretAccessKey);for(const part of scope)key=hmac(key,part);
  return createHmac('sha256',key).update(['AWS4-HMAC-SHA256',date,scope.join('/'),createHash('sha256').update(canonical).digest('hex')].join('\n')).digest('hex');
}
test('R2 quarantine upload links bind school, file, size, content type and first-write condition without contacting storage',async()=>{
  const f=fixture();try {
    const before=Date.now(),link=await f.store.quarantineUpload(file.toUpperCase(),{contentType:'video/mp4',bytes:42}),u=new URL(link.url);
    assert.equal(u.origin,`https://${config.accountId}.r2.cloudflarestorage.com`);assert.equal(u.pathname,`/${config.bucket}/academies/${academy}/quarantine/${file}`);
    assert.equal(link.method,'PUT');assert.deepEqual(link.headers,{'content-type':'video/mp4','content-length':'42','if-none-match':'*'});assert.equal(u.searchParams.get('X-Amz-Expires'),'300');
    for(const h of ['content-length','content-type','host','if-none-match'])assert.ok(u.searchParams.get('X-Amz-SignedHeaders')!.split(';').includes(h));
    assert.equal(signature(link.url,link.method,link.headers),u.searchParams.get('X-Amz-Signature'));
    assert.ok(Date.parse(link.expiresAt)>before+298000&&Date.parse(link.expiresAt)<=Date.now()+300000);assert.equal(f.requests(),0);
    assert.ok(!link.url.includes(config.secretAccessKey));assert.ok(!link.url.includes('filename'));
  }finally{f.store.close();}assert.equal(f.destroyed(),1);
});
test('independent verification detects altered upload method, size, type, first-write condition, object and expiry',async()=>{
  const f=fixture();try {
    const link=await f.store.quarantineUpload(file,{contentType:'application/pdf',bytes:100}),expected=new URL(link.url).searchParams.get('X-Amz-Signature');
    for(const headers of [{...link.headers,'content-length':'101'},{...link.headers,'content-type':'text/html'},{...link.headers,'if-none-match':''}])assert.notEqual(signature(link.url,'PUT',headers),expected);
    assert.notEqual(signature(link.url,'GET',link.headers),expected);
    for(const mutate of [(u:URL)=>{u.pathname=u.pathname.replace('/quarantine/','/clean/');},(u:URL)=>{u.pathname=u.pathname.replace(academy,other);},(u:URL)=>{u.searchParams.set('X-Amz-Expires','900');}]){
      const changed=new URL(link.url);mutate(changed);assert.notEqual(signature(changed.href,'PUT',link.headers),expected);
    }
  }finally{f.store.close();}
});
test('R2 clean downloads cannot address quarantine and force attachment, binary content, private caching and at most one-minute access',async()=>{
  const f=fixture({...config,jurisdiction:'eu'});try {
    const link=await f.store.cleanDownload(file),u=new URL(link.url);assert.equal(link.method,'GET');assert.equal(u.origin,`https://${config.accountId}.eu.r2.cloudflarestorage.com`);
    assert.equal(u.pathname,`/${config.bucket}/academies/${academy}/clean/${file}`);assert.equal(u.searchParams.get('X-Amz-Expires'),'60');
    assert.equal(u.searchParams.get('response-content-type'),'application/octet-stream');assert.equal(u.searchParams.get('response-content-disposition'),'attachment');assert.equal(u.searchParams.get('response-cache-control'),'private, no-store');
    assert.equal(signature(link.url,link.method,{}),u.searchParams.get('X-Amz-Signature'));assert.equal(f.requests(),0);
    const changed=new URL(link.url);changed.searchParams.set('response-content-disposition','inline');assert.notEqual(signature(changed.href,'GET',{}),u.searchParams.get('X-Amz-Signature'));
  }finally{f.store.close();}
});
test('conditional private downloads bind the measured object identity and original grant clock in independently verified signatures',async()=>{
 const f=fixture();try{const issuedAt=new Date(Math.floor(Date.now()/1000)*1000-5000).toISOString(),link=await f.store.cleanDownload(file,30,{issuedAt,ifMatch:'"measured-object-etag"'}),u=new URL(link.url);assert.deepEqual(link.headers,{'if-match':'"measured-object-etag"'});assert.equal(u.searchParams.get('X-Amz-Date'),issuedAt.replaceAll(/[-:]|\.000/g,''));assert.ok(u.searchParams.get('X-Amz-SignedHeaders')!.split(';').includes('if-match'));assert.equal(signature(link.url,'GET',link.headers!),u.searchParams.get('X-Amz-Signature'));assert.notEqual(signature(link.url,'GET',{'if-match':'"changed-object"'}),u.searchParams.get('X-Amz-Signature'));assert.notEqual(signature(link.url,'GET',{}),u.searchParams.get('X-Amz-Signature'));assert.equal(Date.parse(link.expiresAt),Date.parse(issuedAt)+30000);assert.equal(f.requests(),0);
  for(const bad of [{ifMatch:'*'},{ifMatch:'"bad\r\netag"'},{url:'https://localhost'},{issuedAt:'yesterday'}])await assert.rejects(f.store.cleanDownload(file,30,bad),{code:'INVALID_FILE_DOWNLOAD_CONDITION'});
 }finally{f.store.close();}
});
test('R2 config rejects missing credentials, untrusted endpoints and malformed account/bucket/tenant fields without leaking secrets',()=>{
  for(const c of [{...config,accountId:'localhost'},{...config,endpoint:'http://localhost'},{...config,jurisdiction:'unknown'},{...config,bucket:'../unsafe'},
    {...config,accessKeyId:''},{...config,accessKeyId:'bad\r\nkey'},{...config,secretAccessKey:''},{...config,maximumUploadBytes:0},{...config,maximumUploadBytes:4_294_967_297}])
    assert.throws(()=>privateR2(c as R2Connection,academy),{code:'R2_NOT_CONFIGURED',status:503});
  assert.throws(()=>privateR2(config,'../other-school'),{code:'R2_NOT_CONFIGURED',status:503});
});
test('R2 file IDs, size limits, signed-header metadata and expiries cannot be overridden or widened',async()=>{
  const f=fixture();try {
    for(const id of ['../clean/'+file,'https://localhost',file+'/extra',other+'/'+file,'']) {
      await assert.rejects(f.store.quarantineUpload(id,{contentType:'image/jpeg',bytes:1}),{code:'INVALID_FILE_ID',status:400});await assert.rejects(f.store.cleanDownload(id),{code:'INVALID_FILE_ID',status:400});
    }
    for(const input of [{contentType:'image/jpeg',bytes:1000001},{contentType:'image/jpeg',bytes:0},{contentType:'image/jpeg',bytes:1.5},{contentType:'text/html\r\nBad: yes',bytes:10},
      {contentType:'image/jpeg',bytes:1,Key:'clean/override'},{contentType:'image/jpeg',bytes:1,ACL:'public-read'}])
      await assert.rejects(f.store.quarantineUpload(file,input),{code:'INVALID_UPLOAD_METADATA',status:400});
    for(const value of [0,-1,301,Infinity,1.5])await assert.rejects(f.store.quarantineUpload(file,{contentType:'text/plain',bytes:1},value),{code:'INVALID_FILE_LINK_EXPIRY',status:400});
    for(const value of [0,-1,61,Infinity,1.5])await assert.rejects(f.store.cleanDownload(file,value),{code:'INVALID_FILE_LINK_EXPIRY',status:400});
    assert.equal(new URL((await f.store.quarantineUpload(file,{contentType:'image/jpeg',bytes:1},1)).url).searchParams.get('X-Amz-Expires'),'1');assert.equal(f.requests(),0);
  }finally{f.store.close();}
});
test('R2 tenant bindings stay separate and closed service handles cannot issue more grants',async()=>{
  const a=fixture(),b=fixture(config,other);try {
    assert.notEqual((await a.store.cleanDownload(file)).url,(await b.store.cleanDownload(file)).url);a.store.close();a.store.close();assert.equal(a.destroyed(),1);
    await assert.rejects(a.store.cleanDownload(file),{code:'R2_CONNECTION_CLOSED',status:503});await assert.rejects(a.store.quarantineUpload(file,{contentType:'image/png',bytes:1}),{code:'R2_CONNECTION_CLOSED',status:503});
  }finally{a.store.close();b.store.close();}
});
test('R2 upload grants can be reconstructed at an original whole-second issue time but cannot renew expired or future-dated intent',async()=>{
  const f=fixture();try {
    const now=Math.floor(Date.now()/1000)*1000,issuedAt=new Date(now-1000).toISOString(),metadata={contentType:'text/plain',bytes:10};
    const a=await f.store.quarantineUpload(file,metadata,300,issuedAt),b=await f.store.quarantineUpload(file,metadata,300,issuedAt);assert.deepEqual(a,b);assert.equal(a.expiresAt,new Date(now+299000).toISOString());
    assert.equal(signature(a.url,'PUT',a.headers),new URL(a.url).searchParams.get('X-Amz-Signature'));
    await assert.rejects(f.store.quarantineUpload(file,metadata,300,new Date(now-301000).toISOString()),{code:'FILE_LINK_EXPIRED',status:410});
    for(const value of ['invalid',new Date(now+60000).toISOString(),new Date(now+1).toISOString()])await assert.rejects(f.store.quarantineUpload(file,metadata,300,value),{code:'INVALID_FILE_LINK_EXPIRY',status:400});
    assert.equal(f.requests(),0);
  }finally{f.store.close();}
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { configuredR2Download,r2TargetId } from '../src/integrations/r2-config.ts';

const academy=randomUUID(),other=randomUUID(),source={accountId:'a'.repeat(32),jurisdiction:'default' as const,bucket:'synthetic-quarantine',accessKeyId:'synthetic-upload-key',secretAccessKey:'synthetic-not-real-upload-secret',maximumUploadBytes:33554432},reader={...source,bucket:'synthetic-private-reader',accessKeyId:'synthetic-read-only-key',secretAccessKey:'synthetic-not-real-reader-secret'},target=r2TargetId(reader);
const entry={academyId:academy,targetId:target,configuration:reader},env={R2_DOWNLOAD_LINKS_ENABLED:'true',R2_DOWNLOAD_CONNECTIONS:JSON.stringify([entry]),R2_UPLOAD_CONNECTIONS:JSON.stringify([{academyId:academy,configuration:source}])};
test('private download configuration defaults off and binds an explicit school,target and separate reader without SDK initialization',()=>{
 assert.equal(configuredR2Download(academy,target,{}),null);assert.equal(configuredR2Download(academy,target,{...env,R2_DOWNLOAD_LINKS_ENABLED:'false'}),null);assert.deepEqual(configuredR2Download(academy,target,env),reader);assert.equal(configuredR2Download(other,target,env),null);assert.equal(configuredR2Download(academy,'0'.repeat(64),env),null);
});
test('malformed,duplicate,target-mismatched or URL-selected reader settings fail closed without leaking secrets',()=>{
 for(const entries of [[entry,entry],[{...entry,targetId:'0'.repeat(64)}],[{...entry,configuration:{...reader,endpoint:'http://localhost'}}],[{...entry,configuration:{...reader,bucket:'../escape'}}],[{...entry,configuration:{...reader,secretAccessKey:''}}]])assert.throws(()=>configuredR2Download(academy,target,{...env,R2_DOWNLOAD_CONNECTIONS:JSON.stringify(entries)}),{code:'R2_DOWNLOAD_NOT_CONFIGURED'});
 assert.throws(()=>configuredR2Download(academy,target,{...env,R2_DOWNLOAD_CONNECTIONS:'PRIVATE invalid secret syntax'}),error=>{assert.doesNotMatch(String(error),/PRIVATE|secret syntax|synthetic-not-real/);return true;});
});
test('known quarantine credentials and buckets cannot be reused for readers,even when the upload switch is off',()=>{
 for(const c of [{...reader,accessKeyId:source.accessKeyId},{...source,accessKeyId:'different-key'},{...source,jurisdiction:'eu' as const,accessKeyId:'different-jurisdiction-key'}])assert.throws(()=>configuredR2Download(academy,r2TargetId(c),{...env,R2_UPLOAD_LINKS_ENABLED:'false',R2_DOWNLOAD_CONNECTIONS:JSON.stringify([{academyId:academy,targetId:r2TargetId(c),configuration:c}])}),{code:'R2_DOWNLOAD_NOT_CONFIGURED'});
});

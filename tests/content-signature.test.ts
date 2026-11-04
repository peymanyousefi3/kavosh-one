import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { detectContentSignature,maximumSignatureSampleBytes } from '../src/files/content-signature.ts';

test('isolated maintained detector reports measured signature hints, not filename, MIME claims or format validity',async()=>{
  const samples=[
    [Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6v9sAAAAASUVORK5CYII=','base64'),'image/png','png'],
    [Buffer.from('%PDF-1.7\nSynthetic signature only, not a valid document.\n'),'application/pdf','pdf'],
    [Buffer.from([0xff,0xd8,0xff,0xe0,0,16,...Buffer.from('JFIF\0'),...new Uint8Array(30)]),'image/jpeg','jpg']
  ] as const;
  for(const [sample,mime,extension] of samples) {
    const hint=await detectContentSignature(sample);assert.deepEqual(hint,{detector:'file-type@22.3.0',sampleBytes:sample.length,sampleSha256:createHash('sha256').update(sample).digest('hex'),mime,extension});assert.equal('safe' in hint,false);
  }
});
test('unknown and text content stays unknown rather than trusting an extension or treating it as safe plain text',async()=>{
  for(const sample of [Buffer.from('hello.txt'),Buffer.from('<svg onload="alert(1)"></svg>'),Buffer.from('<html>not an image</html>'),Buffer.alloc(100,0)]) {
    const hint=await detectContentSignature(sample);assert.equal(hint.mime,null);assert.equal(hint.extension,null);
  }
});
test('bounded sample copies only its selected bytes, not unrelated contents in the backing buffer',async()=>{
  const backing=Buffer.from('%PDF-1.7\nPRIVATE TRAILING SYNTHETIC CONTENT'),sample=backing.subarray(0,9);
  const hint=await detectContentSignature(sample);assert.equal(hint.sampleBytes,9);assert.equal(hint.sampleSha256,createHash('sha256').update(sample).digest('hex'));assert.equal(hint.mime,'application/pdf');
});
test('invalid samples and budgets, cancellation and a detector deadline fail closed',async()=>{
  for(const sample of [Buffer.alloc(0),Buffer.alloc(maximumSignatureSampleBytes+1),'not bytes' as unknown as Uint8Array])await assert.rejects(detectContentSignature(sample),/INVALID_CONTENT_SAMPLE/);
  const sample=Buffer.from('%PDF-1.7\n');for(const timeoutMs of [0,5001,1.5,NaN])await assert.rejects(detectContentSignature(sample,{timeoutMs}),/INVALID_CONTENT_DETECTION_TIMEOUT/);
  const pre=new AbortController();pre.abort();await assert.rejects(detectContentSignature(sample,{signal:pre.signal}),/CONTENT_SIGNATURE_CANCELLED/);
  const active=new AbortController(),pending=detectContentSignature(sample,{signal:active.signal});active.abort();await assert.rejects(pending,/CONTENT_SIGNATURE_CANCELLED/);
  await assert.rejects(detectContentSignature(sample,{timeoutMs:1}),/CONTENT_SIGNATURE_TIMEOUT/);
});

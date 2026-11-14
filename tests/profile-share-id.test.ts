import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { profileShareAlias,profileShareId } from '../src/profiles/share-id.ts';

test('short profile identifiers preserve the full native UUID without storing or granting a new identity',()=>{
 const ids=['123e4567-e89b-42d3-a456-426614174000','00000000-0000-0000-0000-000000000000',...Array.from({length:25},()=>randomUUID())];for(const id of ids){const short=profileShareAlias(id);assert.equal(short.length,22);assert.match(short,/^[A-Za-z0-9_-]+$/);assert.equal(profileShareId.parse(short),id);assert.equal(profileShareId.parse(id.toUpperCase()),id);assert.equal(profileShareAlias(id.toUpperCase()),short);}
});
test('short identifiers reject padding,ambiguous unused bits,malformed UUIDs,extra paths,Unicode and oversized input',()=>{
 const short=profileShareAlias('123e4567-e89b-42d3-a456-426614174000');for(const raw of [short+'=',short+'==',short.slice(0,-1)+'B',short+'/',short+'?x=1',' '+short,short+' ',short.slice(1),'0'.repeat(36),'é'.repeat(22),'x'.repeat(10000),null,42,{},[]])assert.equal(profileShareId.safeParse(raw).success,false,JSON.stringify(raw).slice(0,100));assert.throws(()=>profileShareAlias('not-a-UUID'));
});

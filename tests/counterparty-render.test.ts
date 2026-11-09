import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parse} from 'csv-parse/sync';
import {renderCounterpartyCaptureRows} from '../src/reports/counterparty-render.ts';
const id='11111111-1111-4111-8111-111111111111',frame={payeeId:id,from:'2026-11-01',through:'2026-11-30'},metadata={section:0,ordinal:0,payload:{snapshotAt:'2026-11-09T12:00:00Z',sourceFingerprint:'a'.repeat(64),sourceCount:1,entryCount:1,currencyCount:1,dayCount:1,validRange:true,denied:0,unknown:0,custodyIdentityBasis:'same_immutable_internal_hub_or_person_not_name_matching',sourceScope:{private:'DO NOT EXPOSE'},privateNote:'PRIVATE native note'}},currency={section:1,ordinal:1,payload:{currency_id:id,currencyCode:'CAD',scale:2,opening:'0',increases:'100.00',decreases:'0',closing:'100',manual_balance:'0',custody:'100',payable:'0'}},event={section:2,ordinal:1,payload:{journalId:id,lineNumber:0,postedOn:'2026-11-09',currencyId:id,currencyCode:'CAD',scale:2,family:'custody',category:'tuition_receipt',correctionOfId:null,change:'100.00',balance:'100'}},day={section:3,ordinal:1,payload:{currency_id:id,currencyCode:'CAD',scale:2,postedOn:'2026-11-09',change:'100',balance:'100'}},rows=[metadata,currency,event,day];
test('ordered fragments concatenate to one exact CSV with one BOM/header and no private native metadata',()=>{
 const whole=renderCounterpartyCaptureRows(frame,rows,{id}),parts=rows.map(r=>renderCounterpartyCaptureRows(frame,[r],{id}));assert.equal(parts.map(p=>p.body).join(''),whole.body);assert.equal(parts.reduce((n,p)=>n+p.bytes,0),whole.bytes);assert.equal(whole.body.split('\uFEFF').length,2);assert.equal(whole.body.split('"currency_id"').length,2);assert.doesNotMatch(whole.body,/DO NOT EXPOSE|PRIVATE|sourceScope|privateNote/);const parsed=parse(whole.body,{columns:true,bom:true});assert.equal(parsed.find((r:any)=>r.section==='event').amount,'1.00');assert.equal(parsed.find((r:any)=>r.field==='closing').minor,'100');assert.equal(whole.records,4);assert.deepEqual(whole.last,{section:3,ordinal:1});
});
test('large signed and integral-decimal minor units retain exact separate currency precision',()=>{
 const huge='-900719925474099312345678901234567890',r=structuredClone(event);r.payload.change=huge+'.00';r.payload.balance=huge;const parsed=parse(renderCounterpartyCaptureRows(frame,[r]).body)as string[][];assert.equal(parsed[0][12],huge);assert.equal(parsed[0][13],'-9007199254740993123456789012345678.90');r.payload.scale=0;assert.equal(parse(renderCounterpartyCaptureRows(frame,[r]).body)[0][13],huge);r.payload.scale=18;assert.equal(parse(renderCounterpartyCaptureRows(frame,[r]).body)[0][13],'-900719925474099312.345678901234567890');
});
test('private source rows,unknown output fields,duplicate or unordered rows and misplaced headers cannot render',()=>{
 for(const data of [[{section:4,ordinal:1,payload:['custody',id,0]}],[event,event],[day,event],[event,metadata],[{...metadata,ordinal:1}],[{...event,ordinal:0}],[{...event,payload:{...event.payload,privateNote:'secret'}}]])assert.throws(()=>renderCounterpartyCaptureRows(frame,data));
});
test('invalid money,dates,scales,currency codes and noncanonical source categories fail closed',()=>{
 for(const patch of [{change:'0.01'},{change:'1e6'},{change:1},{scale:19},{currencyCode:'=XSS'},{postedOn:'2026-10-31'},{postedOn:'2026-02-30'},{category:'=FORMULA()'}])assert.throws(()=>renderCounterpartyCaptureRows(frame,[{...event,payload:{...event.payload,...patch}}]));
 assert.throws(()=>renderCounterpartyCaptureRows(frame,[{...metadata,payload:{...metadata.payload,denied:1}}]));assert.throws(()=>renderCounterpartyCaptureRows({...frame,through:'2026-10-31'},rows));
});
test('page bounds and provenance limit reject oversized work rather than truncating it',()=>{
 assert.throws(()=>renderCounterpartyCaptureRows(frame,[]));assert.throws(()=>renderCounterpartyCaptureRows(frame,Array.from({length:1001},(_,i)=>({...event,ordinal:i+1}))));assert.throws(()=>renderCounterpartyCaptureRows(frame,[metadata],{note:'x'.repeat(16385)}),/PROVENANCE_INVALID/);
 const provenance={note:'= formula, "quoted"\n新しい'};const parsed=parse(renderCounterpartyCaptureRows(frame,[metadata],provenance).body,{columns:true,bom:true});assert.deepEqual(JSON.parse(parsed.find((r:any)=>r.field==='provenance').value),provenance);
});

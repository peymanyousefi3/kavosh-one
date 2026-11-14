import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateRevenueSharing,type SharingInput } from '../src/core/revenue-sharing.ts';
const academy='00000000-0000-4000-8000-000000000001',hub='00000000-0000-4000-8000-000000000002',recruiter='00000000-0000-4000-8000-000000000003';
const base:SharingInput={unitScale:2,netMinor:10000n,grossMinor:11300n,receivedGrossMinor:5650n,basis:'net_tuition',invoiceIssued:true,invoiceCredited:false,creditHandling:'retain_collections',allowOverAllocation:false,rules:[{payeeId:hub,kind:'hub',method:'percentage',value:'25',release:'proportional'},{payeeId:recruiter,kind:'person',method:'flat',value:'10',release:'proportional'}]};
test('percentage plus flat shares use explicit net/gross bases and conserve the academy residual',()=>{
 const r=calculateRevenueSharing(base);assert.deepEqual(r.rows.map(r=>[r.fullMinor,r.releasedMinor]),[[2500n,1250n],[1000n,500n]]);assert.equal(r.collectedBaseMinor,5000n);assert.equal(r.academyReleasedMinor,3250n);assert.equal(r.academyFullMinor,6500n);
 const gross=calculateRevenueSharing({...base,basis:'gross_tuition'});assert.equal(gross.rows[0].fullMinor,2825n);assert.equal(gross.rows[0].releasedMinor,1412n);
});
test('one-cent percentage ties are deterministic and never silently create an extra cent',()=>{
 const r=calculateRevenueSharing({...base,netMinor:1n,grossMinor:1n,receivedGrossMinor:1n,rules:[{payeeId:hub,kind:'hub',method:'percentage',value:'50',release:'proportional'},{payeeId:recruiter,kind:'person',method:'percentage',value:'50',release:'proportional'}]});assert.deepEqual(r.rows.map(r=>r.fullMinor),[1n,0n]);assert.equal(r.fullTotalMinor,1n);
 const reversed=calculateRevenueSharing({...base,netMinor:1n,grossMinor:1n,receivedGrossMinor:1n,rules:[{payeeId:recruiter,kind:'person',method:'percentage',value:'50',release:'proportional'},{payeeId:hub,kind:'hub',method:'percentage',value:'50',release:'proportional'}]});assert.equal(reversed.rows.find(r=>r.payeeId===hub)!.fullMinor,1n);
});
test('cumulative proportional releases are monotone, installment-order independent and complete at final payment',()=>{
 let previous=[0n,0n];for(const paid of [0n,1n,17n,1234n,5649n,5650n,11299n,11300n]){const r=calculateRevenueSharing({...base,receivedGrossMinor:paid});assert.ok(r.rows.every((r,i)=>r.releasedMinor>=previous[i]));assert.ok(r.rows.every(r=>r.releasedMinor<=r.fullMinor));previous=r.rows.map(r=>r.releasedMinor);}assert.deepEqual(previous,[2500n,1000n]);
});
test('first-collection, full-payment and invoice triggers remain distinct and expose cash coverage shortfalls',()=>{
 const r=calculateRevenueSharing({...base,receivedGrossMinor:1n,rules:[{...base.rules[0],release:'first_collection'},{...base.rules[1],release:'fully_collected'},{payeeId:academy,kind:'academy',method:'flat',value:'1',release:'on_invoice'}]});assert.deepEqual(r.rows.map(r=>r.releasedMinor),[2500n,0n,100n]);assert.equal(r.cashCoverageShortfallMinor,2500n);
 assert.equal(calculateRevenueSharing({...base,invoiceIssued:false,receivedGrossMinor:0n,rules:[{...base.rules[0],release:'on_invoice'}]}).releasedTotalMinor,0n);
});
test('configured credit handling does not silently assume fees are refundable',()=>{
 assert.equal(calculateRevenueSharing({...base,invoiceCredited:true}).releasedTotalMinor,1750n);const cancelled=calculateRevenueSharing({...base,invoiceCredited:true,creditHandling:'cancel_on_credit'});assert.equal(cancelled.releasedTotalMinor,0n);assert.equal(cancelled.cancelledByCredit,true);
});
test('explicit over-allocation is visible, not hidden by normalization or capped earnings',()=>{
 const rules=[{...base.rules[0],value:'100'},{...base.rules[1],value:'10'}];assert.throws(()=>calculateRevenueSharing({...base,rules}),/SHARING_EXCEEDS_TUITION_BASE/);const r=calculateRevenueSharing({...base,rules,allowOverAllocation:true});assert.equal(r.overAllocated,true);assert.equal(r.academyFullMinor,-1000n);
 assert.throws(()=>calculateRevenueSharing({...base,rules:[{...base.rules[0],value:'60'},{...base.rules[1],method:'percentage',value:'60'}],allowOverAllocation:true}),/SHARING_PERCENTAGES_EXCEED_100/);
});
test('zero tuition and very large values remain exact without inventing a zero-price payment',()=>{
 const zero=calculateRevenueSharing({...base,netMinor:0n,grossMinor:0n,receivedGrossMinor:0n,rules:[]});assert.equal(zero.academyFullMinor,0n);
 const huge=calculateRevenueSharing({...base,netMinor:99999999999999999999999999999999999999n,grossMinor:99999999999999999999999999999999999999n,receivedGrossMinor:99999999999999999999999999999999999999n,rules:[{...base.rules[0],value:'100'}]});assert.equal(huge.rows[0].releasedMinor,huge.baseMinor);
});
test('invalid values, duplicate payees and inexact percentages fail closed',()=>{
 for(const patch of [{receivedGrossMinor:11301n},{receivedGrossMinor:-1n},{unitScale:19},{rules:[base.rules[0],base.rules[0]]},{rules:[{...base.rules[0],value:'0.00001'}]}])assert.throws(()=>calculateRevenueSharing({...base,...patch} as SharingInput));
});

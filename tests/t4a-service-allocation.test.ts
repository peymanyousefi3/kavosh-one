import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectT4aServicePayment,t4aServiceAllocation } from '../src/core/t4a-service-allocation.ts';

const definition=()=>({income:[{box:'048',amount:'1000.00'}],gstHst:'130.00',pst:'0.00',incomeTaxDeducted:'0.00',otherExcluded:[],eligibilityReview:{canadianRecipient:true,nonEmployment:true,serviceReportingReviewed:true,sourceReference:'Synthetic reviewed status evidence'},review:'Synthetic exact payment review'});
const source=()=>({currencyCode:'CAD',unitScale:2,grossMinor:'113000',netMinor:'113000',incomeTaxDeductedMinor:'0'});
const field=(d:ReturnType<typeof projectT4aServicePayment>,box:string)=>d.fields.find(f=>f.box===box)!;
test('T4A service allocation excludes actual sales taxes without changing recorded money',()=>{
 const d=definition(),s=source(),before=JSON.stringify({d,s}),r=projectT4aServicePayment(d,s);assert.equal(field(r,'048').amount.amount,'1000.00');assert.equal(field(r,'020').printBlank,true);assert.equal(field(r,'022').printBlank,true);assert.equal(r.excludedGstHst.amount,'130.00');assert.equal(r.net.amount,'1130.00');assert.equal(r.monetarySourceReconciled,true);assert.equal(JSON.stringify({d,s}),before);
 for(const k of ['eligibilityVerified','yearToDateComplete','isOfficialT4A','readyToIssue','craFilingPerformed','additionalLedgerPosting','paymentExecuted'] as const)assert.equal(r[k],false);
});
test('T4A service and independent commissions are disjoint with exact source withholding',()=>{
 const r=projectT4aServicePayment({...definition(),income:[{box:'048',amount:'750.00'},{box:'020',amount:'250.00'}],gstHst:'50.00',pst:'80.00',incomeTaxDeducted:'100.00'},{...source(),netMinor:'103000',incomeTaxDeductedMinor:'10000'});assert.equal(field(r,'048').amount.minor,'75000');assert.equal(field(r,'020').amount.minor,'25000');assert.equal(field(r,'022').amount.minor,'10000');assert.equal(r.reportableIncome.minor,'100000');assert.equal(r.excludedPst.minor,'8000');
});
test('T4A partial recognition is explicit rather than proportional from an invoice total',()=>{
 const r=projectT4aServicePayment({...definition(),income:[{box:'048',amount:'333.33'}],gstHst:'43.33'},{...source(),grossMinor:'37666',netMinor:'37666'});assert.equal(field(r,'048').amount.amount,'333.33');assert.throws(()=>projectT4aServicePayment(definition(),{...source(),grossMinor:'37666',netMinor:'37666'}),/T4A_SERVICE_ALLOCATION_UNRECONCILED/);
});
test('T4A cannot include sales tax twice or lose a cent in rounding',()=>{
 for(const patch of [{income:[{box:'048',amount:'1130.00'}]},{gstHst:'129.99'},{gstHst:'130.01'}])assert.throws(()=>projectT4aServicePayment({...definition(),...patch},source()),/T4A_SERVICE_ALLOCATION_UNRECONCILED/);
});
test('T4A reviewed excluded components reconcile but private explanations are not projected',()=>{
 const r=projectT4aServicePayment({...definition(),otherExcluded:[{code:'GOODS',amount:'200.00',sourceReference:'PRIVATE synthetic separately reviewed goods'}],review:'PRIVATE synthetic review',eligibilityReview:{...definition().eligibilityReview,sourceReference:'PRIVATE synthetic eligibility'}},{...source(),grossMinor:'133000',netMinor:'133000'});assert.equal(r.otherExcluded.amount,'200.00');assert.equal(JSON.stringify(r).includes('PRIVATE'),false);assert.equal(JSON.stringify(r).includes('sourceReference'),false);assert.equal(r.eligibilityVerified,false);
});
test('T4A allocation requires explicit status reviews and rejects unsupported reporting boxes',()=>{
 for(const eligibilityReview of [{},{...definition().eligibilityReview,canadianRecipient:false},{...definition().eligibilityReview,nonEmployment:false},{...definition().eligibilityReview,serviceReportingReviewed:false},{...definition().eligibilityReview,sourceReference:''}])assert.equal(t4aServiceAllocation.safeParse({...definition(),eligibilityReview}).success,false);
 for(const income of [[{box:'028',amount:'1000.00'}],[{box:'048',amount:'500.00'},{box:'048',amount:'500.00'}],[{box:'048',amount:'0.00'}],[]])assert.equal(t4aServiceAllocation.safeParse({...definition(),income}).success,false);
});
test('T4A exact amounts reject floating point numbers negatives excess precision and extra fields',()=>{
 for(const amount of [1000,'-1.00','1e3','0.001','Infinity','NaN','1000\n'])assert.equal(t4aServiceAllocation.safeParse({...definition(),income:[{box:'048',amount}]}).success,false);
 for(const d of [{...definition(),invented:true},{...definition(),income:[{box:'048',amount:'1000.00',currency:'CAD'}]},{...definition(),otherExcluded:[{code:'GOODS',amount:'1.00',sourceReference:''}]},{...definition(),otherExcluded:[{code:'GOODS',amount:'1.00',sourceReference:'Synthetic'},{code:'GOODS',amount:'2.00',sourceReference:'Synthetic'}]}])assert.equal(t4aServiceAllocation.safeParse(d).success,false);
});
test('T4A source refuses non-CAD implicit FX malformed amounts zero net and mismatched withholding',()=>{
 for(const s of [{...source(),currencyCode:'USD'},{...source(),unitScale:3},{...source(),grossMinor:113000},{...source(),grossMinor:'1e5'},{...source(),netMinor:'-1'},{...source(),netMinor:'113000.01'},{...source(),grossMinor:'113000\n'},{...source(),extra:true}])assert.throws(()=>projectT4aServicePayment(definition(),s),/T4A_SERVICE_PAYMENT_SOURCE_INVALID/);
 for(const s of [{...source(),netMinor:'0'},{...source(),netMinor:'113001'}])assert.throws(()=>projectT4aServicePayment(definition(),s),/T4A_SERVICE_PAYMENT_SOURCE_UNRECONCILED/);
 assert.throws(()=>projectT4aServicePayment({...definition(),incomeTaxDeducted:'1.00'},source()),/T4A_SERVICE_WITHHOLDING_SOURCE_MISMATCH/);
});
test('T4A exact source amounts beyond JavaScript safe integers survive without loss',()=>{
 const n='900719925474099301',r=projectT4aServicePayment({...definition(),income:[{box:'048',amount:'9007199254740993.01'}],gstHst:'0.00'},{...source(),grossMinor:n+'.00',netMinor:n});assert.equal(field(r,'048').amount.minor,n);assert.equal(r.net.amount,'9007199254740993.01');
});

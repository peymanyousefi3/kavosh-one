import assert from 'node:assert/strict';
import { test } from 'node:test';
import { payrollHourlyPlan } from '../src/modules/payroll-hourly-plan.ts';
import type { priceRecordedHourlySources } from '../src/modules/recorded-work-report.ts';

type Priced=ReturnType<typeof priceRecordedHourlySources>['priced'][number];
const hour=3600000,at=(ms:number)=>new Date(ms).toISOString();
function source(key:string,start:number,end:number,rate=3000n,engagementId=key):Priced&{entry:Priced['entry']&{evidence_version:number|null;evidence_decision:string|null;evidence_current:boolean|null}}{
 return {key,start,end,rate,rule:{code:'TEACH',kind:'hourly',from:'1970-01-01',through:null,assignment:{id:'assignment-'+key,version:1},method:null,amount:'30',rounding:'none',excessToleranceMinutes:5},
  entry:{id:key,version:1,person_id:'worker',hub_id:'hub',class_id:'class-'+key,session_id:'session-'+key,assignment_id:'assignment-'+key,assignment_version:1,session_version:1,current_session_version:1,session_status:'scheduled',scheduled_start:at(start),scheduled_end:at(end),starts_at:at(start),ends_at:at(end),enrollment_on:'1970-01-01',enrolled:1,evidence_version:1,evidence_decision:'accepted',evidence_current:true},
  terms:{engagement_id:engagementId,person_id:'worker',version:1,effective_on:'1970-01-01',currency_id:'CAD',currency_code:'CAD',unit_scale:2,active:true,starts_on:'1970-01-01',ends_on:null,time_zone:'UTC',components:[]}};
}
const plan=(sources:ReturnType<typeof source>[],prior:{start:number;end:number}[]=[])=>payrollHourlyPlan(sources,{start:0,end:24*hour},2,prior);
function conserved(r:ReturnType<typeof plan>){for(const b of [r.actual,r.configured]){assert.equal(b.sourceAllocations.reduce((n,s)=>n+BigInt(s.gross.minor),0n).toString(),b.gross.minor);assert.equal(b.workAllocations.reduce((n,w)=>n+BigInt(w.gross.minor),0n).toString(),b.gross.minor);assert.equal(b.workAllocations.reduce((n,w)=>n+BigInt(w.milliseconds),0n).toString(),b.milliseconds);}}
test('hourly earning plan attributes the single highest-rate timeline to exact work and class source references',()=>{
 const inputs=[source('low',0,2*hour,2000n,'work-low'),source('high',hour,3*hour,3000n,'work-high')],before=structuredClone(inputs),r=plan(inputs);
 assert.equal(r.actual.gross.amount,'80.00');assert.deepEqual(r.actual.workAllocations.map(w=>[w.engagementId,w.gross.amount]),[['work-high','60.00'],['work-low','20.00']]);
 assert.equal(r.actual.sourceAllocations[0].entryId,'high');assert.equal(r.actual.sourceAllocations[0].classId,'class-high');assert.equal(r.actual.sourceAllocations[0].termsVersion,1);assert.equal(r.operationalReviewRequired,false);assert.equal(r.timeReviewRequired,false);conserved(r);
 assert.deepEqual(inputs,before);assert.deepEqual(plan([...inputs].reverse()),r);for(const flag of ['payoutReady','claimsPersisted','wagesAccrued','priorClaimsVerified','sourcesVerified','paymentExecuted'])assert.equal(r[flag as keyof typeof r],false);
});
test('work-level allocations group winning fragments without rerounding cents independently',()=>{
 const r=plan([source('b',0,hour/2,1n,'work'),source('a',hour/2,hour,1n,'work')]);assert.equal(r.actual.gross.minor,'1');assert.deepEqual(r.actual.sourceAllocations.map(s=>[s.key,s.gross.minor]),[['a','1'],['b','0']]);assert.equal(r.actual.workAllocations[0].gross.minor,'1');conserved(r);
 const huge=plan([source('huge',0,hour,90071992547409930001n)]);assert.equal(huge.actual.workAllocations[0].gross.minor,'90071992547409930001');conserved(huge);
});
test('a shadowed class retains its missing evidence and excess-hour flags without deleting actual earned-source amounts',()=>{
 const low=source('low',0,2*hour,2000n),high=source('high',0,2*hour);low.entry.evidence_decision=null;low.entry.evidence_current=false;low.entry.evidence_version=null;low.entry.scheduled_end=at(hour);
 const r=plan([low,high]);assert.equal(r.actual.gross.amount,'60.00');assert.deepEqual(r.actual.sourceAllocations.map(s=>s.key),['high']);assert.equal(r.sourceAssessments.length,2);const l=r.sourceAssessments.find(s=>s.key==='low')!;assert.equal(l.operationalReviewAccepted,false);assert.equal(l.durationExceedsScheduleTolerance,true);assert.equal(l.outsideScheduleMilliseconds,String(hour));assert.equal(r.operationalReviewRequired,true);assert.equal(r.timeReviewRequired,true);assert.equal(r.payoutReady,false);conserved(r);
});
test('accepted-but-stale evidence and changed or cancelled sessions require review without erasing recorded work',()=>{
 const s=source('work',0,hour);s.entry.evidence_current=false;s.entry.current_session_version=2;s.entry.session_status='cancelled';const r=plan([s]);assert.equal(r.actual.gross.amount,'30.00');assert.equal(r.sourceAssessments[0].reviewVersion,1);assert.equal(r.sourceAssessments[0].decision,'accepted');assert.equal(r.operationalReviewRequired,true);assert.equal(r.timeReviewRequired,true);assert.equal(r.sourceAssessments[0].scheduleChanged,true);
});
test('duration tolerance is strict above the threshold; shifted and shorter sessions remain accurately marked',()=>{
 const s=source('work',0,hour+300000);s.entry.scheduled_end=at(hour);let r=plan([s]);assert.equal(r.sourceAssessments[0].durationExceedsScheduleTolerance,false);s.end++;s.entry.ends_at=at(s.end);r=plan([s]);assert.equal(r.sourceAssessments[0].durationExceedsScheduleTolerance,true);
 const shifted=source('shifted',hour,2*hour);shifted.entry.scheduled_start=at(0);shifted.entry.scheduled_end=at(hour);r=plan([shifted]);assert.equal(r.sourceAssessments[0].durationExceedsScheduleTolerance,false);assert.equal(r.sourceAssessments[0].outsideScheduleMilliseconds,String(hour));assert.equal(r.timeReviewRequired,true);
 const shorter=source('shorter',0,hour/2);shorter.entry.scheduled_end=at(hour);r=plan([shorter]);assert.equal(r.timeReviewRequired,false);assert.equal(r.actual.gross.amount,'15.00');
});
test('prior worker-time claims exclude every work arrangement and leave exact surviving source allocations',()=>{
 const r=plan([source('low',0,2*hour,2000n),source('high',hour,3*hour)],[{start:0,end:2*hour}]);assert.equal(r.actual.gross.amount,'30.00');assert.deepEqual(r.actual.workAllocations.map(w=>w.engagementId),['high']);assert.deepEqual(r.actual.timeClaims,[{start:2*hour,end:3*hour}]);assert.equal(r.priorClaimsVerified,false);conserved(r);
});
test('rounded-to-zero work remains reviewable and configured claims are not mistaken for paid earnings',()=>{
 const s=source('short',0,120000);s.rule.rounding='nearest_5';const r=plan([s]);assert.equal(r.actual.gross.amount,'1.00');assert.equal(r.configured.gross.minor,'0');assert.deepEqual(r.configured.workAllocations,[]);assert.equal(r.sourceAssessments.length,1);assert.equal(r.sourceDurationReductionRequiresReview,true);assert.equal(r.configuredReductionRequiresReview,true);assert.deepEqual(r.configured.timeClaims,[{start:0,end:120000}]);conserved(r);
});
test('one worker/currency and compatible historical units are mandatory before attributing work',()=>{
 const a=source('a',0,hour),b=source('b',hour,2*hour);b.terms.unit_scale=1;b.rate=300n;const r=plan([a,b]);assert.equal(r.actual.gross.amount,'60.00');conserved(r);
 for(const mutate of [(s:typeof b)=>{s.entry.person_id='other';s.terms.person_id='other';},(s:typeof b)=>{s.terms.currency_id='USD';},(s:typeof b)=>{s.terms.unit_scale=3;},(s:typeof b)=>{s.terms.person_id='other';}]){const changed=structuredClone(b);mutate(changed);assert.throws(()=>plan([a,changed]),/INCOMPATIBLE_PAYROLL_HOURLY_SOURCES/);}
 assert.throws(()=>payrollHourlyPlan([a],{start:0,end:hour},19),/INVALID_CURRENCY_PRECISION/);assert.equal(plan([]).actual.gross.amount,'0.00');
});

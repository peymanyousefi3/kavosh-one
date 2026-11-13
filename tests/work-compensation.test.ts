import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCompensationRules,configuredCompensationPreview,highestHourlySegments,hourlyCompensationRate } from '../src/core/work-compensation.ts';

const base={from:'2026-01-01'},rules=validateCompensationRules([
 {...base,code:'SALARY',kind:'salary',amount:'3000',frequency:'month'},
 {...base,code:'LOW',kind:'hourly',amount:'20'},
 {...base,code:'HIGH',kind:'hourly',amount:'30'},
 {...base,code:'HEAD',kind:'headcount_hourly',amount:'25',minimumStudents:3,includedStudents:5,increment:'2.50',headcountBasis:'enrolled'},
 {...base,code:'PERCENT',kind:'tuition_percentage',percent:'12.5',basis:'session_net'},
 {...base,code:'PROJECT',kind:'project',amount:'125',projectCode:'ROBOT-COACHING'}
],2);
test('salary, percentage and project fees remain separate while overlapping hourly time is paid once at the highest configured rate',()=>{
 const r=configuredCompensationPreview(rules,[{key:'salary',componentCode:'SALARY'},{key:'low',componentCode:'LOW',startsAt:'2026-01-02T08:00:00Z',endsAt:'2026-01-02T10:00:00Z'},{key:'high',componentCode:'HIGH',startsAt:'2026-01-02T09:00:00Z',endsAt:'2026-01-02T11:00:00Z'},{key:'percent',componentCode:'PERCENT',tuitionAmount:'100'},{key:'project',componentCode:'PROJECT'}],2);
 assert.equal(r.actualHourly.milliseconds,'10800000');assert.equal(r.actualHourly.value.amount,'80.00');assert.equal(r.nonHourly.amount,'3137.50');assert.equal(r.configuredScenarioTotal.amount,'3217.50');assert.equal(r.payrollApproved,false);assert.equal(r.earnedEntitlementDetermined,false);assert.equal(r.statutoryDeductionsCalculated,false);
});
test('headcount thresholds/increments are exact and recorded five-minute rounding never hides actual time or reduced configured compensation',()=>{
 const preview=(headcount:number)=>configuredCompensationPreview(rules,[{key:'class',componentCode:'HEAD',headcount,startsAt:'2026-01-02T10:00:00Z',endsAt:'2026-01-02T11:00:00Z'}],2);
 assert.equal(preview(2).configuredScenarioTotal.amount,'0.00');assert.equal(preview(3).configuredScenarioTotal.amount,'25.00');assert.equal(preview(5).configuredScenarioTotal.amount,'25.00');assert.equal(preview(7).configuredScenarioTotal.amount,'30.00');
 const short=configuredCompensationPreview(rules,[{key:'round',componentCode:'HIGH',startsAt:'2026-01-02T10:00:00Z',endsAt:'2026-01-02T10:02:00Z',scheduledMilliseconds:'0'}],2);assert.equal(short.actualHourly.value.amount,'1.00');assert.equal(short.configuredHourly.value.amount,'0.00');assert.equal(short.configuredReductionRequiresReview,true);assert.equal(short.details[0].exceedsScheduleTolerance,false);
 const tie=configuredCompensationPreview(rules,[{key:'round',componentCode:'HIGH',startsAt:'2026-01-02T10:00:00Z',endsAt:'2026-01-02T10:02:30Z'}],2);assert.equal(tie.configuredHourly.milliseconds,'300000');assert.equal(tie.details[0].roundingDeltaMilliseconds,'150000');
});
test('hourly overlap selection is stable on equal rates and rounds the aggregate only once, independent of segment boundaries',()=>{
 const intervals=[{key:'b',start:0,end:60000,rateMinor:1n},{key:'a',start:30000,end:90000,rateMinor:1n}],r=highestHourlySegments(intervals);assert.equal(r.milliseconds,90000n);assert.equal(r.minor,0n);assert.equal(r.segments[1].key,'a');assert.deepEqual(highestHourlySegments([...intervals].reverse()),r);
 assert.throws(()=>highestHourlySegments([{key:'a',start:2,end:1,rateMinor:10n}]),/INVALID_HOURLY_INTERVALS/);
});
test('explicit bounded background hourly planning handles 2000 sources while ordinary payroll keeps its 200-source guard',()=>{
 const intervals=Array.from({length:2000},(_,i)=>({key:String(i).padStart(4,'0'),start:i*60000,end:(i+1)*60000,rateMinor:1n})),started=performance.now();
 assert.throws(()=>highestHourlySegments(intervals),/INVALID_HOURLY_INTERVALS/);
 const r=highestHourlySegments(intervals,{maximumIntervals:2000});assert.equal(r.minor,33n);assert.equal(r.milliseconds,120000000n);assert.equal(r.segments.length,2000);
 assert.deepEqual(highestHourlySegments([...intervals].reverse(),{maximumIntervals:2000}),r);
 const overlap=intervals.map(i=>({...i,start:0,end:3600000,rateMinor:9007199254740993n})),tied=highestHourlySegments(overlap,{maximumIntervals:2000});
 assert.equal(tied.minor,9007199254740993n);assert.equal(tied.milliseconds,3600000n);assert.equal(tied.segments.length,1);assert.equal(tied.segments[0].key,'0000');
 const clipped=highestHourlySegments(overlap,{maximumIntervals:2000,window:{start:0,end:1800000},excluded:[{start:0,end:900000}]});assert.equal(clipped.milliseconds,900000n);assert.equal(clipped.minor,2251799813685248n);
 for(const options of [{maximumIntervals:2001},{maximumIntervals:NaN},{maximumIntervals:null}])assert.throws(()=>highestHourlySegments([] ,options as never),/INVALID_HOURLY_INTERVALS/);
 assert.throws(()=>highestHourlySegments([...intervals,{...intervals[0],key:'overflow'}],{maximumIntervals:2000}),/INVALID_HOURLY_INTERVALS/);
 console.log(JSON.stringify({case:'bounded-2000-hourly-sources',elapsedMs:Math.ceil(performance.now()-started),productionCapacityTest:false}));
});
test('compensation definitions and scenarios reject ambiguous amounts, duplicate keys, unknown components and unused inputs',()=>{
 for(const invalid of [[{...base,code:'BAD',kind:'hourly',amount:'0.001'}],[{...base,code:'BAD',kind:'tuition_percentage',percent:'100.0001',basis:'session_net'}],[{...base,code:'BAD',kind:'hourly',amount:'1'},{...base,code:'BAD',kind:'hourly',amount:'2'}]])assert.throws(()=>validateCompensationRules(invalid,2));
 for(const s of [[{key:'a',componentCode:'UNKNOWN'}],[{key:'a',componentCode:'PERCENT'}],[{key:'a',componentCode:'SALARY',tuitionAmount:'1'}],[{key:'a',componentCode:'HIGH',startsAt:'2026-01-02T10:00:00Z',endsAt:'2026-01-02T10:00:00Z'}]])assert.throws(()=>configuredCompensationPreview(rules,s,2));
});
test('shared hourly rate calculation validates counts and preserves exact threshold/zero/maximum increments',()=>{
 const head=rules.find(r=>r.kind==='headcount_hourly')!,hourly=rules.find(r=>r.kind==='hourly')!;
 assert.equal(hourlyCompensationRate(head,2,2),0n);assert.equal(hourlyCompensationRate(head,2,3),2500n);assert.equal(hourlyCompensationRate(head,2,5),2500n);assert.equal(hourlyCompensationRate(head,2,7),3000n);assert.equal(hourlyCompensationRate(head,2,1000000),250001250n);
 for(const n of [-1,1.5,1000001,NaN,Infinity])assert.throws(()=>hourlyCompensationRate(head,2,n),/INVALID_HEADCOUNT/);
 assert.throws(()=>hourlyCompensationRate(head,2),/HEADCOUNT_REQUIRED/);assert.throws(()=>hourlyCompensationRate(hourly,2,0),/UNUSED_SCENARIO_INPUT/);
});

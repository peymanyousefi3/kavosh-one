import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportTiming,nextReportOccurrence } from '../src/core/report-timing.ts';
import { scopeFor,scopeContains,type Credential,type Grant } from '../src/core/policy.ts';
import { randomUUID } from 'node:crypto';

const timing=(patch:Record<string,unknown>={})=>reportTiming.parse({timeZone:'America/Toronto',localTime:'03:00',startsOn:'2026-01-01',cycle:{kind:'daily'},...patch});
test('report recurrence reuses civil pay-cycle rules without duplicate short-month slots or elapsed-day DST drift',()=>{
 const cases:[Record<string,unknown>,string,string|null][]=[
  [{},'2026-03-07T08:00:00.001Z','2026-03-08T07:00:00Z'],
  [{cycle:{kind:'monthly',day:31}},'2026-02-01T00:00:00Z','2026-02-28T08:00:00Z'],
  [{cycle:{kind:'semimonthly',days:[30,31]}},'2026-02-28T08:00:00.001Z','2026-03-30T07:00:00Z'],
  [{cycle:{kind:'weekly',weekday:1}},'2026-11-01T12:00:00Z','2026-11-02T08:00:00Z'],
  [{cycle:{kind:'biweekly',anchorOn:'2026-01-05'}},'2026-01-06T00:00:00Z','2026-01-19T08:00:00Z'],
  [{cycle:{kind:'custom',label:'Selected dates',dates:['2026-06-01','2026-04-01']}},'2026-03-31T23:00:00Z','2026-04-01T07:00:00Z'],
  [{cycle:{kind:'custom',label:'Exhausted',dates:['2026-01-01']}},'2026-06-01T00:00:00Z',null],
  [{endsOn:'2026-01-01'},'2026-01-02T00:00:00Z',null],
  [{startsOn:'2027-01-01'},'2026-06-01T00:00:00Z','2027-01-01T08:00:00Z']
 ];for(const [patch,after,expected]of cases)assert.equal(nextReportOccurrence(timing(patch),after)?.dueAt??null,expected,JSON.stringify({patch,after}));
});
test('spring gaps and autumn overlaps have explicit independent policies and one occurrence per civil day',()=>{
 const gap=timing({localTime:'02:30'}),shift=nextReportOccurrence(gap,'2026-03-08T00:00:00Z');assert.equal(shift?.dueAt,'2026-03-08T07:30:00Z');assert.equal(shift?.shiftedForGap,true);assert.equal(shift?.actualLocalTime,'03:30:00');assert.equal(nextReportOccurrence({...gap,gapPolicy:'skip'},'2026-03-08T00:00:00Z')?.dueAt,'2026-03-09T06:30:00Z');
 const fall=timing({localTime:'01:30'});assert.equal(nextReportOccurrence(fall,'2026-11-01T00:00:00Z')?.dueAt,'2026-11-01T05:30:00Z');assert.equal(nextReportOccurrence({...fall,overlapPolicy:'later'},'2026-11-01T00:00:00Z')?.dueAt,'2026-11-01T06:30:00Z');assert.equal(nextReportOccurrence(fall,'2026-11-01T05:30:00.001Z')?.dueAt,'2026-11-02T06:30:00Z');
});
test('report timing refuses malformed clocks,zones,unbounded delays,unknown controls and invalid effective ranges',()=>{
 for(const patch of [{localTime:'24:00'},{localTime:'03:00:01'},{timeZone:'+03:00'},{timeZone:'Invalid/Zone'},{maxDelayMinutes:10081},{gapPolicy:'guess'},{cycle:{kind:'daily',every:0}},{endsOn:'2025-12-31'},{enabled:true}])assert.throws(()=>timing(patch),JSON.stringify(patch));
 assert.equal(nextReportOccurrence(timing({timeZone:'Asia/Shanghai',localTime:'00:15'}),'2026-06-01T12:00:00Z')?.dueAt,'2026-06-01T16:15:00Z');
 assert.equal(timing({localTime:' 03:00\n'}).localTime,'03:00');
});
test('schedule capabilities preserve class/fixed-person grants,record-hub denials and finite machine ceilings',()=>{
 const hub=randomUUID(),other=randomUUID(),person=randomUUID(),classId=randomUUID();for(const capability of ['report-schedules.view','report-schedules.edit'] as const){const c:Credential={token_id:randomUUID(),academy_id:randomUUID(),person_id:randomUUID(),capabilities:[capability],all_hubs:true,hub_ids:[],allowed:true},g:Grant={capability,effect:'allow',allHubs:false,hubIds:[],classRefs:[{id:classId,hubId:hub}],personRefs:[{id:person,hubId:other}]},scope=scopeFor(c,[g],capability);assert.equal(scopeContains(scope,{all:false,hubs:[],classes:[{id:classId,hubId:hub}]}),true);assert.equal(scopeContains(scope,{all:false,hubs:[],people:[{id:person,hubId:hub}],workContext:{personId:person,hubId:hub}}),true);assert.equal(scopeContains(scopeFor({...c,all_hubs:false,hub_ids:[other]},[g],capability),{all:false,hubs:[],people:[{id:person,hubId:hub}],workContext:{personId:person,hubId:hub}}),false);assert.equal(scopeContains(scopeFor(c,[g,{capability,effect:'deny',allHubs:false,hubIds:[hub]}],capability),{all:false,hubs:[],people:[{id:person,hubId:hub}],workContext:{personId:person,hubId:hub}}),false);}
});

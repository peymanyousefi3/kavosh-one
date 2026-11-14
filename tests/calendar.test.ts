import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileSchedule } from '../src/modules/calendar.ts';
import { operationsFixture } from './operations-fixture.ts';
import { ApiError } from '../src/core/policy.ts';

const zone='America/Toronto';
const one=(start:string,end:string,disambiguation='reject')=>({oneOff:[{start,end,disambiguation}]});
function fails(raw:unknown,code:string,timeZone=zone){assert.throws(()=>compileSchedule(raw,timeZone),error=>error instanceof ApiError&&error.code===code);}
test('weekly local time remains stable while its UTC instant follows daylight saving changes',()=>{
  const result=compileSchedule({weekly:{from:'2027-03-07',through:'2027-03-21',weekdays:[7],startTime:'10:00',endTime:'11:30'}},zone);
  assert.deepEqual(result.sessions.map(s=>s.start),['2027-03-07T15:00:00Z','2027-03-14T14:00:00Z','2027-03-21T14:00:00Z']);
  assert.ok(result.sessions.every(s=>s.localStart.endsWith('T10:00')&&s.durationMinutes===90&&!s.adjustedForTimeZone));
});
test('DST nonexistent and repeated wall times require explicit resolution and preserve evidence',()=>{
  fails(one('2027-03-14T02:15','2027-03-14T04:00'),'INVALID_OR_AMBIGUOUS_LOCAL_TIME');
  const gap=compileSchedule(one('2027-03-14T02:15','2027-03-14T04:00','later'),zone).sessions[0];
  assert.equal(gap.requestedStart,'2027-03-14T02:15');assert.equal(gap.localStart,'2027-03-14T03:15');assert.equal(gap.adjustedForTimeZone,true);assert.equal(gap.durationMinutes,45);
  fails(one('2027-11-07T01:15','2027-11-07T02:15'),'INVALID_OR_AMBIGUOUS_LOCAL_TIME');
  const early=compileSchedule(one('2027-11-07T01:15','2027-11-07T02:15','earlier'),zone).sessions[0];
  const late=compileSchedule(one('2027-11-07T01:15','2027-11-07T02:15','later'),zone).sessions[0];
  assert.equal(early.durationMinutes,120);assert.equal(late.durationMinutes,60);assert.equal(early.startOffset,'-04:00');assert.equal(late.startOffset,'-05:00');assert.equal(early.disambiguation,'earlier');assert.equal(late.disambiguation,'later');
});
test('date exclusions retain their reasons and unmatched status without resolving nonexistent cancelled hours',()=>{
  const result=compileSchedule({weekly:{from:'2027-03-14',through:'2027-03-21',weekdays:[7],startTime:'02:15',endTime:'04:00'},
    exclude:[{date:'2027-03-14',reason:'Holiday'},{date:'2027-03-15',reason:'No classes normally'}]},zone);
  assert.equal(result.count,1);assert.deepEqual(result.excluded,[{date:'2027-03-14',reason:'Holiday',matched:true},{date:'2027-03-15',reason:'No classes normally',matched:false}]);
  assert.throws(()=>compileSchedule({oneOff:[],exclude:[]},zone));
});
test('fortnightly recurrence is ISO-week anchored and ordered irregular additions are supported',()=>{
  const result=compileSchedule({weekly:{from:'2027-01-06',through:'2027-01-26',weekdays:[1,3],startTime:'16:00',endTime:'17:00',everyWeeks:2},
    oneOff:[{start:'2027-01-12T09:00',end:'2027-01-12T10:00'}]},zone);
  assert.deepEqual(result.sessions.map(s=>s.localStart),['2027-01-06T16:00','2027-01-12T09:00','2027-01-18T16:00','2027-01-20T16:00']);
});
test('overnight sessions retain actual duration and fractional-offset zones',()=>{
  const result=compileSchedule({weekly:{from:'2027-01-01',through:'2027-01-01',weekdays:[5],startTime:'23:30',endTime:'01:00',endDayOffset:1}},'Asia/Kathmandu');
  assert.equal(result.sessions[0].durationMinutes,90);assert.equal(result.sessions[0].start,'2027-01-01T17:45:00Z');assert.equal(result.sessions[0].end,'2027-01-01T19:15:00Z');
});
test('duplicate, overlapping and nonpositive sessions fail; touching intervals remain valid',()=>{
  fails({oneOff:[{start:'2027-01-01T09:00',end:'2027-01-01T10:00'},{start:'2027-01-01T09:30',end:'2027-01-01T10:30'}]},'CLASS_SESSION_OVERLAP');
  fails(one('2027-01-01T10:00','2027-01-01T10:00'),'SESSION_DURATION_OUT_OF_RANGE');
  fails(one('2027-01-01T11:00','2027-01-01T10:00'),'SESSION_DURATION_OUT_OF_RANGE');
  fails(one('2027-01-01T10:00','2027-01-03T10:00'),'SESSION_DURATION_OUT_OF_RANGE');
  assert.equal(compileSchedule({oneOff:[{start:'2027-01-01T09:00',end:'2027-01-01T10:00'},{start:'2027-01-01T10:00',end:'2027-01-01T11:00'}]},zone).count,2);
});
test('calendar range, duplicate selectors, leap dates and payload counts are validated',()=>{
  const weekly={from:'2028-01-01',through:'2028-12-31',weekdays:[1,2,3,4,5,6,7],startTime:'10:00',endTime:'11:00'};
  assert.equal(compileSchedule({weekly},zone).count,366);
  fails({weekly:{...weekly,through:'2029-01-01'}},'SCHEDULE_RANGE_OUT_OF_BOUNDS');
  fails({weekly:{...weekly,through:'2027-12-31'}},'SCHEDULE_RANGE_OUT_OF_BOUNDS');
  fails({weekly:{...weekly,weekdays:[1,1]}},'DUPLICATE_WEEKDAY');
  fails({...one('2027-01-01T10:00','2027-01-01T11:00'),exclude:[{date:'2027-01-01',reason:'A'},{date:'2027-01-01',reason:'B'}]},'DUPLICATE_EXCLUSION_DATE');
  for(const raw of [one('2027-02-29T10:00','2027-02-29T11:00'),one('2027-01-01T24:00','2027-01-02T01:00'),{...one('2027-01-01T10:00','2027-01-01T11:00'),extra:true}])assert.throws(()=>compileSchedule(raw,zone));
  fails(one('2027-01-01T10:00','2027-01-01T11:00'),'INVALID_TIME_ZONE','Unknown/Zone');
  assert.throws(()=>compileSchedule({...one('2027-01-01T10:00','2027-01-01T11:00'),oneOff:Array(501).fill({start:'2027-01-01T10:00',end:'2027-01-01T11:00'})},zone));
});
test('preview API enforces hub scope, needs explicit time zone, and creates no domain records',async()=>{
  const f=await operationsFixture();
  try {
    const schedule=one('2027-01-01T10:00','2027-01-01T11:00');
    assert.equal((await f.request('calendar/preview',{hubId:f.hub,schedule},'manager')).response.status,409);
    await f.pg.query('UPDATE public.hubs SET time_zone=$2 WHERE id=$1',[f.hub,zone]);
    const result=await f.request('calendar/preview',{hubId:f.hub,schedule},'manager');assert.equal(result.response.status,200);assert.equal(result.body.persisted,false);assert.equal(result.body.data.count,1);
    assert.equal((await f.request('calendar/preview',{hubId:f.otherHub,schedule},'manager')).response.status,403);
    assert.equal((await f.request('calendar/preview',{hubId:f.foreignHub,schedule})).response.status,404);
    assert.equal((await f.request('calendar/preview')).response.status,405);
    await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);
    assert.equal((await f.request('calendar/preview',{hubId:f.hub,schedule},'manager')).response.status,200);
    assert.equal((await f.pg.query('SELECT * FROM public.request_keys')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.outbox_events')).rows.length,0);
  }finally{await f.pg.close();}
});

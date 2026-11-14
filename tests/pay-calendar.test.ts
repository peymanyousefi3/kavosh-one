import assert from 'node:assert/strict';
import { test } from 'node:test';
import { payCycle,payCalendarDays,payOccurrencesOn } from '../src/core/pay-calendar.ts';

function occurrences(cycle:unknown,from:string,through:string){const parsed=payCycle.parse(cycle);return payCalendarDays({from,through}).flatMap(d=>payOccurrencesOn(parsed,d));}
test('monthly and semimonthly pay dates clamp short months without silently losing a declared slot',()=>{
 assert.deepEqual(occurrences({kind:'monthly',day:31},'2028-01-01','2028-03-31'),[{on:'2028-01-31',slot:1},{on:'2028-02-29',slot:1},{on:'2028-03-31',slot:1}]);
 assert.deepEqual(occurrences({kind:'semimonthly',days:[30,31]},'2027-02-01','2027-02-28'),[{on:'2027-02-28',slot:1},{on:'2027-02-28',slot:2}]);
 assert.deepEqual(occurrences({kind:'monthly',day:31},'9999-12-01','9999-12-31'),[{on:'9999-12-31',slot:1}]);
});
test('weekly, anchored biweekly and explicit custom dates use civil days across DST and year boundaries',()=>{
 assert.deepEqual(occurrences({kind:'weekly',weekday:7},'2026-03-01','2026-03-22').map(d=>d.on),['2026-03-01','2026-03-08','2026-03-15','2026-03-22']);
 assert.deepEqual(occurrences({kind:'biweekly',anchorOn:'2027-01-08'},'2026-12-01','2027-01-31').map(d=>d.on),['2026-12-11','2026-12-25','2027-01-08','2027-01-22']);
 assert.deepEqual(occurrences({kind:'custom',label:'Custom agreement',dates:['2027-03-15','2027-01-01','2026-12-30']},'2027-01-01','2027-03-15').map(d=>d.on),['2027-01-01','2027-03-15']);
});
test('pay-date generation rejects ambiguous schedules and oversized ranges without partial dates',()=>{
 for(const cycle of [{kind:'semimonthly',days:[15,15]},{kind:'weekly',weekday:0},{kind:'monthly',day:32},{kind:'custom',label:'X',dates:['2027-01-01','2027-01-01']}])assert.throws(()=>payCycle.parse(cycle));
 assert.equal(payCalendarDays({from:'2028-01-01',through:'2028-12-31'}).length,366);
 assert.throws(()=>payCalendarDays({from:'2028-01-01',through:'2029-01-01'}),/PAY_CALENDAR_RANGE_TOO_LARGE/);
 assert.throws(()=>payCalendarDays({from:'2027-01-02',through:'2027-01-01'}));
});

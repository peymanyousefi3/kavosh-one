import { ApiError } from './policy.ts';
import { formatMoneyTotal,roundRatio } from './money.ts';
import { highestHourlySegments,type HourlyInterval,type HourlyWindow } from './work-compensation.ts';

export type PayrollHourlySource=HourlyInterval&{rounding:'none'|'nearest_5'};

// Internal gross calculation, not an HTTP input or an authorization boundary.
// The posting workflow must obtain the complete worker/currency source set,
// verify current terms/evidence, and lock/persist claims in the same transaction.
// Never treat caller-supplied exclusions as proof of durable consumption.
export function payrollHourlyEarnings(sources:PayrollHourlySource[],window:HourlyWindow,priorClaims:HourlyWindow[],unitScale:number){
 if(!Array.isArray(sources)||sources.some(s=>!s||!['none','nearest_5'].includes(s.rounding)||s.end<=s.start))throw new ApiError(400,'INVALID_PAYROLL_HOURLY_SOURCES');
 if(!window||!Array.isArray(priorClaims))throw new ApiError(400,'INVALID_HOURLY_WINDOW');
 // Validate original intervals before constructing rounded endpoints. Rounding
 // applies once to the entire recorded entry, before payroll-window clipping.
 const actual=highestHourlySegments(sources,{window,excluded:priorClaims});
 const configured=sources.map(s=>({...s,end:s.rounding==='none'?s.end:s.start+Number(roundRatio(BigInt(s.end-s.start),300000n,'half_away')*300000n)}));
 const rounded=highestHourlySegments(configured,{window,excluded:priorClaims});
 const value=(minor:bigint)=>({minor:minor.toString(),amount:formatMoneyTotal(minor,unitScale)});
 function earnings(result:ReturnType<typeof highestHourlySegments>){
  const numerators=new Map<string,bigint>();for(const s of result.segments)numerators.set(s.key,(numerators.get(s.key)??0n)+s.rateMinor*BigInt(s.end-s.start));
  const rows=[...numerators].map(([key,numerator])=>({key,numerator,minor:numerator/3600000n,remainder:numerator%3600000n}));
  // Allocate only the residual cents from the single aggregate rounding, not
  // independently rounded segments. Rank exact fractional remainders and use
  // the existing stable source-key tie policy; large numerators stay BigInt.
  const residual=result.minor-rows.reduce((sum,r)=>sum+r.minor,0n),ranked=[...rows].sort((a,b)=>a.remainder!==b.remainder?(a.remainder>b.remainder?-1:1):a.key<b.key?-1:a.key>b.key?1:0);
  for(let i=0;i<Number(residual);i++)ranked[i].minor++;
  return {milliseconds:result.milliseconds.toString(),gross:value(result.minor),sources:rows.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0).map(r=>({key:r.key,numerator:r.numerator.toString(),denominator:'3600000',gross:value(r.minor)})),segments:result.segments.map(s=>({...s,rateMinor:s.rateMinor.toString()}))};
 }
 function claims(segments:HourlyWindow[]){
  const merged:HourlyWindow[]=[];
  for(const s of [...segments].sort((a,b)=>a.start-b.start||a.end-b.end)){
   const last=merged.at(-1);if(last&&s.start<=last.end)last.end=Math.max(last.end,s.end);else merged.push({start:s.start,end:s.end});
  }
  return merged;
 }
 // The posting must choose a basis explicitly. Actual pay must not consume
 // unpaid rounded tails. Configured pay reserves both actual and rounded
 // coverage (including zero-rate work), avoiding a second claim via another
 // class or the tail. A reduction still needs review, never silent forfeiture.
 const sourceRounding=sources.map((s,i)=>({key:s.key,actualMilliseconds:String(s.end-s.start),configuredMilliseconds:String(configured[i].end-s.start),deltaMilliseconds:String(configured[i].end-s.end)})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 return {actual:{...earnings(actual),timeClaims:claims(actual.segments)},configured:{...earnings(rounded),timeClaims:claims([...actual.segments,...rounded.segments])},sourceRounding,sourceDurationReductionRequiresReview:sourceRounding.some(s=>BigInt(s.deltaMilliseconds)<0n),configuredReductionRequiresReview:rounded.minor<actual.minor,
  overlapPolicy:'highest_hourly_rate_stable_key_tie',roundingPolicy:'whole_source_before_window_clipping',claimBoundary:'half_open',
  sourcesVerified:false,claimsPersisted:false,wagesAccrued:false,statutoryDeductionsCalculated:false,paymentExecuted:false};
}

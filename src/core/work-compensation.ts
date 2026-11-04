import { z } from 'zod';
import { ApiError } from './policy.ts';
import { parseMoney,roundRatio,formatMoneyTotal } from './money.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),date=z.iso.date().refine(v=>v>='1900-01-01'&&v<='9999-12-31'),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),code=text.regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/),money=text.regex(/^\d+(?:\.\d+)?$/).max(80);
export const workReference=z.object({id:uuid,version:z.number().int().positive().max(2147483647)}).strict();
const common={code,from:date,through:date.nullable().default(null),assignment:workReference.nullable().default(null),method:workReference.nullable().default(null)};
const hourly={amount:money,rounding:z.enum(['none','nearest_5']).default('nearest_5'),excessToleranceMinutes:z.number().int().min(0).max(1440).default(5)};
const forecastAllocation=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('calendar_pay_dates'),proration:z.enum(['manual','none']).default('manual')}).strict(),
 z.object({kind:z.literal('fixed_divisor'),divisor:z.number().int().min(1).max(1000),proration:z.enum(['manual','none']).default('manual')}).strict()
]);
export const compensationRule=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('salary'),amount:money,frequency:z.enum(['month','year','pay_period']),forecastAllocation:forecastAllocation.optional()}).strict().refine(v=>v.frequency!=='pay_period'||v.forecastAllocation?.kind!=='calendar_pay_dates'),
 z.object({...common,kind:z.literal('hourly'),...hourly}).strict(),
 z.object({...common,kind:z.literal('headcount_hourly'),...hourly,minimumStudents:z.number().int().min(0).max(1000000).default(0),includedStudents:z.number().int().min(0).max(1000000),increment:money,headcountBasis:z.enum(['enrolled','present','eligible_present'])}).strict(),
 z.object({...common,kind:z.literal('tuition_percentage'),percent:money,basis:z.enum(['session_net','session_gross','course_net','course_gross','period_collected_net','period_collected_gross'])}).strict(),
 z.object({...common,kind:z.literal('project'),amount:money,projectCode:code}).strict()
]).refine(v=>v.through===null||v.through>=v.from);
export type CompensationRule=z.infer<typeof compensationRule>;
export type HourlyRule=Extract<CompensationRule,{kind:'hourly'|'headcount_hourly'}>;
export function hourlyCompensationRate(rule:HourlyRule,scale:number,headcount?:number){
 const base=parseMoney(rule.amount,scale);
 if(rule.kind==='hourly'){if(headcount!==undefined)throw new ApiError(400,'UNUSED_SCENARIO_INPUT');return base;}
 if(headcount===undefined)throw new ApiError(400,'HEADCOUNT_REQUIRED');
 if(!Number.isSafeInteger(headcount)||headcount<0||headcount>1000000)throw new ApiError(400,'INVALID_HEADCOUNT');
 return headcount<rule.minimumStudents?0n:base+BigInt(Math.max(0,headcount-rule.includedStudents))*parseMoney(rule.increment,scale);
}
export function validateCompensationRules(raw:unknown,scale:number){
 const rules=z.array(compensationRule).min(1).max(50).parse(raw);if(new Set(rules.map(r=>r.code)).size!==rules.length)throw new ApiError(400,'DUPLICATE_COMPENSATION_CODE');
 for(const r of rules){if(r.kind==='tuition_percentage'){if(parseMoney(r.percent,4)>1000000n)throw new ApiError(400,'INVALID_COMPENSATION_PERCENT');}else{parseMoney(r.amount,scale);if(r.kind==='headcount_hourly')parseMoney(r.increment,scale);}}
 return rules;
}
export type HourlyInterval={key:string;start:number;end:number;rateMinor:bigint};
export function highestHourlySegments(intervals:HourlyInterval[]){
 if(!Array.isArray(intervals)||intervals.length>200||new Set(intervals.map(i=>i.key)).size!==intervals.length||intervals.some(i=>typeof i.key!=='string'||!i.key.length||i.key.length>100||!Number.isSafeInteger(i.start)||!Number.isSafeInteger(i.end)||i.end<i.start||i.end-i.start>86400000||typeof i.rateMinor!=='bigint'||i.rateMinor<0n))throw new ApiError(400,'INVALID_HOURLY_INTERVALS');
 const points=[...new Set(intervals.flatMap(i=>[i.start,i.end]))].sort((a,b)=>a-b),segments:{start:number;end:number;key:string;rateMinor:bigint}[]=[];
 // ponytail: at most 200 intervals; this bounded scan avoids a custom heap.
 // Larger payroll periods need the planned background/chunked calculation.
 for(let p=0;p<points.length-1;p++){const start=points[p],end=points[p+1];let winner:HourlyInterval|undefined;
  for(const i of intervals)if(i.start<=start&&i.end>=end&&(!winner||i.rateMinor>winner.rateMinor||(i.rateMinor===winner.rateMinor&&i.key<winner.key)))winner=i;
  if(winner&&end>start){const previous=segments.at(-1);if(previous&&previous.end===start&&previous.key===winner.key)previous.end=end;else segments.push({start,end,key:winner.key,rateMinor:winner.rateMinor});}
 }
 // Group integer rate*time numerators before rounding once. Splitting an
 // overlap into more segments must not create or remove cents.
 const numerator=segments.reduce((sum,s)=>sum+s.rateMinor*BigInt(s.end-s.start),0n);return {segments,milliseconds:segments.reduce((sum,s)=>sum+BigInt(s.end-s.start),0n),minor:roundRatio(numerator,3600000n,'half_away')};
}
const instant=z.iso.datetime({offset:true}).max(40).refine(v=>!/[.]\d{4}/.test(v));
export const compensationScenario=z.object({key:text.min(1).max(100),componentCode:code,startsAt:instant.optional(),endsAt:instant.optional(),headcount:z.number().int().min(0).max(1000000).optional(),tuitionAmount:money.optional(),units:z.number().int().min(0).max(1000).default(1),scheduledMilliseconds:z.string().regex(/^\d{1,12}$/).optional()}).strict();
type Scenario=z.infer<typeof compensationScenario>;
export function configuredCompensationPreview(rules:CompensationRule[],raw:unknown,scale:number){
 const scenarios=z.array(compensationScenario).min(1).max(100).parse(raw);if(new Set(scenarios.map(s=>s.key)).size!==scenarios.length)throw new ApiError(400,'DUPLICATE_SCENARIO_KEY');
 const byCode=new Map(rules.map(r=>[r.code,r])),actual:HourlyInterval[]=[],configured:HourlyInterval[]=[],details:Record<string,unknown>[]=[];let other=0n;
 for(const s of scenarios){const r=byCode.get(s.componentCode);if(!r)throw new ApiError(404,'COMPENSATION_COMPONENT_NOT_FOUND');let minor=0n;
  if(r.kind==='hourly'||r.kind==='headcount_hourly'){
   if(!s.startsAt||!s.endsAt||s.units!==1||s.tuitionAmount!==undefined)throw new ApiError(400,'HOURLY_INTERVAL_REQUIRED');
   const start=Date.parse(s.startsAt),end=Date.parse(s.endsAt),duration=end-start;if(duration<=0||duration>86400000)throw new ApiError(400,'INVALID_HOURLY_INTERVALS');
   const rate=hourlyCompensationRate(r,scale,s.headcount);
   const rounded=r.rounding==='nearest_5'?roundRatio(BigInt(duration),300000n,'half_away')*300000n:BigInt(duration);
   actual.push({key:s.key,start,end,rateMinor:rate});configured.push({key:s.key,start,end:start+Number(rounded),rateMinor:rate});
   details.push({key:s.key,componentCode:r.code,kind:r.kind,actualMilliseconds:String(duration),configuredMilliseconds:rounded.toString(),roundingDeltaMilliseconds:(rounded-BigInt(duration)).toString(),rateMinor:rate.toString(),headcountBasis:r.kind==='headcount_hourly'?r.headcountBasis:null,
    exceedsScheduleTolerance:s.scheduledMilliseconds===undefined?null:BigInt(duration)>BigInt(s.scheduledMilliseconds)+BigInt(r.excessToleranceMinutes)*60000n});
  }else{
   if(s.startsAt!==undefined||s.endsAt!==undefined||s.headcount!==undefined||s.scheduledMilliseconds!==undefined)throw new ApiError(400,'UNUSED_SCENARIO_INPUT');
   if(r.kind==='tuition_percentage'){if(s.tuitionAmount===undefined||s.units!==1)throw new ApiError(400,'TUITION_BASIS_REQUIRED');minor=roundRatio(parseMoney(s.tuitionAmount,scale)*parseMoney(r.percent,4),1000000n,'half_away');}
   else{if(s.tuitionAmount!==undefined)throw new ApiError(400,'UNUSED_SCENARIO_INPUT');minor=parseMoney(r.amount,scale)*BigInt(s.units);}
   other+=minor;details.push({key:s.key,componentCode:r.code,kind:r.kind,minor:minor.toString(),basis:r.kind==='salary'?r.frequency:r.kind==='tuition_percentage'?r.basis:r.projectCode,units:s.units});
  }
 }
 const a=highestHourlySegments(actual),c=highestHourlySegments(configured),value=(n:bigint)=>({minor:n.toString(),amount:formatMoneyTotal(n,scale)}),segment=(s:typeof a.segments[number])=>({...s,rateMinor:s.rateMinor.toString()});
 return {details,actualHourly:{milliseconds:a.milliseconds.toString(),value:value(a.minor),segments:a.segments.map(segment)},configuredHourly:{milliseconds:c.milliseconds.toString(),value:value(c.minor),segments:c.segments.map(segment)},nonHourly:value(other),actualTimeScenarioTotal:value(a.minor+other),configuredScenarioTotal:value(c.minor+other),configuredReductionRequiresReview:c.minor<a.minor,
  overlapPolicy:'highest_hourly_rate_stable_key_tie',roundingPolicy:'per_input_interval_before_configured_overlap',nonHourlyComponentsDeduplicated:false,scenarioInputsVerified:false,payrollApproved:false,earnedEntitlementDetermined:false,statutoryDeductionsCalculated:false,paymentExecuted:false};
}

import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { parseMoney,formatMoneyTotal,allocateMoney } from '../core/money.ts';
import { highestHourlySegments,hourlyCompensationRate,type CompensationRule,type HourlyInterval } from '../core/work-compensation.ts';
import { payCalendarRange,payCalendarDays,payOccurrencesOn,type PayCycle } from '../core/pay-calendar.ts';
import { salaryAllocation } from '../core/salary-allocation.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const zone=z.string().min(1).max(100).refine(v=>{if(/^[+-]/.test(v))return false;try{Temporal.Now.instant().toZonedDateTimeISO(v);return true;}catch{return false;}});
const query=payCalendarRange.safeExtend({timeZone:zone,hubId:uuid.optional(),personId:uuid.optional(),currencyId:uuid.optional()});
type Terms={engagement_id:string;person_id:string;hub_id:string|null;version:number;effective_on:string;currency_id:string;currency_code:string;unit_scale:number;active:boolean;starts_on:string;ends_on:string|null;time_zone:string;pay_cycle:PayCycle;components:CompensationRule[]};
type Session={id:string;version:number;class_id:string;hub_id:string;time_zone:string;starts_at:string;ends_at:string;assignment_id:string;assignment_version:number;person_id:string;active:boolean;starts_on:string;ends_on:string|null;enrolled:number|null};
type Assignment={id:string;version:number;person_id:string};
const classTarget=`jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',c.id,'hubId',c.hub_id)))`;
// The one statement supplies all report sources at the same MVCC snapshot.
// Limits detect an oversized request; none is a truncating report page.
const sourcesSQL=`WITH visible AS MATERIALIZED(
 SELECT e.id,e.person_id,e.hub_id FROM public.work_engagements e
 WHERE public.work_scope_allows($1::jsonb,e.hub_id,e.person_id) AND public.work_scope_allows($2::jsonb,e.hub_id,e.person_id)
 AND($3::boolean OR e.hub_id=ANY($4::uuid[])) AND($5::uuid IS NULL OR e.hub_id=$5) AND($6::uuid IS NULL OR e.person_id=$6)
 ORDER BY e.id LIMIT 101
),terms AS MATERIALIZED(
 SELECT e.id AS engagement_id,e.person_id,e.hub_id,r.version,r.effective_on::text,r.currency_id,c.code AS currency_code,r.unit_scale,
 (r.definition->>'active')::boolean AS active,r.definition->>'startsOn' AS starts_on,r.definition->>'endsOn' AS ends_on,r.definition->>'timeZone' AS time_zone,r.definition->'payCycle' AS pay_cycle,r.components
 FROM visible e JOIN public.work_engagement_revisions r ON r.academy_id=current_setting('app.academy_id')::uuid AND r.engagement_id=e.id
 JOIN public.finance_currencies c ON c.academy_id=r.academy_id AND c.id=r.currency_id
 WHERE r.effective_on<=$7::date ORDER BY e.id,r.effective_on,r.version LIMIT 1001
),assignments AS MATERIALIZED(
 SELECT a.id,a.version,a.person_id FROM public.class_staff a JOIN public.classes c ON c.academy_id=a.academy_id AND c.id=a.class_id
 WHERE public.scope_contains($10::jsonb,${classTarget}) AND public.scope_contains($11::jsonb,${classTarget})
 AND EXISTS(SELECT 1 FROM terms t CROSS JOIN LATERAL jsonb_array_elements(t.components) component WHERE t.person_id=a.person_id AND component#>>'{assignment,id}'=a.id::text)
 ORDER BY a.id LIMIT 201
),sessions AS(
 SELECT s.id,s.version,s.class_id,s.hub_id,c.time_zone,s.starts_at::text,s.ends_at::text,a.id AS assignment_id,a.version AS assignment_version,a.person_id,a.active,a.starts_on::text,a.ends_on::text,
 CASE WHEN public.scope_contains($12::jsonb,${classTarget}) THEN(SELECT count(*)::integer FROM public.class_enrollments e WHERE e.class_id=c.id AND e.enabled AND e.joins_on<=(s.starts_at AT TIME ZONE c.time_zone)::date AND(e.leaves_on IS NULL OR e.leaves_on>=(s.starts_at AT TIME ZONE c.time_zone)::date)) ELSE NULL END AS enrolled
 FROM public.class_staff a JOIN public.classes c ON c.academy_id=a.academy_id AND c.id=a.class_id JOIN public.class_sessions s ON s.academy_id=a.academy_id AND s.class_id=c.id
 WHERE s.starts_at>=$8::timestamptz AND s.starts_at<$9::timestamptz AND s.status='scheduled' AND c.active
 AND public.scope_contains($10::jsonb,${classTarget}) AND public.scope_contains($11::jsonb,${classTarget})
 AND a.id IN(SELECT id FROM assignments)
 ORDER BY s.starts_at,s.id,a.id LIMIT 201
)
SELECT statement_timestamp()::text AS snapshot_at,(SELECT count(*)::integer FROM visible) AS engagement_count,
 coalesce((SELECT jsonb_agg(to_jsonb(terms) ORDER BY engagement_id,effective_on,version) FROM terms),'[]'::jsonb) AS terms,
 coalesce((SELECT jsonb_agg(to_jsonb(assignments) ORDER BY id) FROM assignments),'[]'::jsonb) AS assignments,
 coalesce((SELECT jsonb_agg(to_jsonb(sessions) ORDER BY starts_at,id,assignment_id) FROM sessions),'[]'::jsonb) AS sessions`;
const exact=(minor:bigint,scale:number)=>({minor:minor.toString(),amount:formatMoneyTotal(minor,scale)});
const activeOn=(t:Terms,on:string)=>t.active&&on>=t.starts_on&&(t.ends_on===null||on<=t.ends_on);
const componentOn=(r:CompensationRule,on:string)=>on>=r.from&&(r.through===null||on<=r.through);
const key=(...values:(string|number)[])=>createHash('sha256').update(JSON.stringify(values)).digest('hex');
function selected(terms:Terms[],on:(t:Terms)=>string){let winner:Terms|undefined;for(const t of terms)if(t.effective_on<=on(t)&&(!winner||t.effective_on>winner.effective_on||(t.effective_on===winner.effective_on&&t.version>winner.version)))winner=t;return winner;}

export async function payrollForecast(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/payroll/scheduled-costs')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const work=permissionScope(ctx,'work-pay.view'),reports=permissionScope(ctx,'financial-reports.view');if(!scopeNonempty(work)||!scopeNonempty(reports))throw new ApiError(403,'FORBIDDEN');
 const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),days=payCalendarDays({from:q.from,through:q.through});
 const first=days[0].toZonedDateTime(q.timeZone).toInstant(),last=days.at(-1)!.add({days:1}).toZonedDateTime(q.timeZone).toInstant();
 const sqlDate=(v:string)=>v.replace(/^\+0(?=\d{5}-)/,'');
 const result=(await ctx.db.query<{snapshot_at:string;engagement_count:number;terms:Terms[];assignments:Assignment[];sessions:Session[]}>(sourcesSQL,[JSON.stringify(work),JSON.stringify(reports),ctx.credential.all_hubs,ctx.credential.hub_ids,q.hubId??null,q.personId??null,sqlDate(days.at(-1)!.add({days:2}).toString()),sqlDate(first.toString()),sqlDate(last.toString()),...(['classes.view','staff.view','rosters.view'] as const).map(cap=>JSON.stringify(permissionScope(ctx,cap)))])).rows[0];
 if(result.engagement_count>100||result.terms.length>1000||result.assignments.length>200||result.sessions.length>200)throw new ApiError(422,'PAYROLL_FORECAST_REQUIRES_BACKGROUND_JOB');
 const groups=new Map<string,Terms[]>();for(const t of result.terms){const group=groups.get(t.engagement_id)??[];group.push(t);groups.set(t.engagement_id,group);}
 const scales=new Map<string,number>();for(const t of result.terms)scales.set(t.currency_id,Math.max(t.unit_scale,scales.get(t.currency_id)??0));
 const issues:{engagementId:string;termsVersion:number;componentCode:string;currencyId:string;reason:string;sessionId?:string}[]=[],issueKeys=new Set<string>();
 const issue=(t:Terms,r:CompensationRule,reason:string,sessionId?:string)=>{const k=key(t.engagement_id,t.version,r.code,reason,sessionId??'');if(issueKeys.has(k))return;if(issues.length>=2000)throw new ApiError(422,'PAYROLL_FORECAST_REQUIRES_BACKGROUND_JOB');issueKeys.add(k);issues.push({engagementId:t.engagement_id,termsVersion:t.version,componentCode:r.code,currencyId:t.currency_id,reason,...sessionId?{sessionId}:{}});};
 const intervals:{personId:string;currencyId:string;interval:HourlyInterval;source:{engagementId:string;termsVersion:number;componentCode:string;sessionId:string;sessionVersion:number;assignmentId:string;assignmentVersion:number;enrolled:number|null}}[]=[],fixed:{engagementId:string;termsVersion:number;componentCode:string;currencyId:string;on:string;slot:number;minor:bigint;allocation?:{kind:string;from:string;through:string;proration:string;divisor:number;rounding:string;fullReferencePeriodBudgetConserved:boolean}}[]=[];
 const salaryAllocations=new Map<string,ReturnType<typeof salaryAllocation>>();
 let salaryReferenceDays=0;
 for(const terms of groups.values()){
  const activeComponents=new Map<string,{t:Terms;r:CompensationRule}>();
  // Salary planning only uses unambiguous configured payment units. Other
  // allocation/proration policies remain explicit unpriced cases, never zero.
  for(const day of days){const on=day.toString(),t=selected(terms,()=>on);if(!t||!activeOn(t,on))continue;
   for(const r of t.components){if(!componentOn(r,on))continue;activeComponents.set(key(t.engagement_id,t.version,r.code),{t,r});
    if(r.kind==='project'||r.kind==='tuition_percentage'){issue(t,r,r.kind==='project'?'PROJECT_PAYMENT_DATE_REQUIRED':'TUITION_ALLOCATION_BASIS_REQUIRED');continue;}
    if(r.kind!=='salary')continue;const dates=payOccurrencesOn(t.pay_cycle,day);if(!dates.length)continue;
    if(r.assignment){issue(t,r,'SALARY_ASSIGNMENT_POLICY_REQUIRED');continue;}
    if(r.forecastAllocation){
     const reference=r.frequency==='year'?String(day.year):r.frequency==='month'?on.slice(0,7):on,cacheKey=key(t.engagement_id,t.version,r.code,reference);
     let allocation=salaryAllocations.get(cacheKey);if(!allocation){
      // ponytail: cap the aggregate reference-calendar walk, not just each
      // employee's dates; larger salary forecasts need background report jobs.
      if(r.forecastAllocation.kind==='calendar_pay_dates'){salaryReferenceDays+=r.frequency==='year'?day.daysInYear:day.daysInMonth;if(salaryReferenceDays>40000)throw new ApiError(422,'PAYROLL_FORECAST_REQUIRES_BACKGROUND_JOB');}
      allocation=salaryAllocation(r,t.pay_cycle,day,t.unit_scale);salaryAllocations.set(cacheKey,allocation);
     }
     if(allocation.proration==='manual'&&(t.starts_on>allocation.from||t.effective_on>allocation.from||r.from>allocation.from||(t.ends_on!==null&&t.ends_on<allocation.through)||(r.through!==null&&r.through<allocation.through))){issue(t,r,'SALARY_PRORATION_POLICY_REQUIRED');continue;}
     for(const d of dates){if(fixed.length>=2000)throw new ApiError(422,'PAYROLL_FORECAST_REQUIRES_BACKGROUND_JOB');const original=allocation.kind==='fixed_divisor'?allocation.perPayment:allocation.payments!.get(on+':'+d.slot);if(original===undefined)throw new Error('SALARY_ALLOCATION_SLOT_MISSING');fixed.push({engagementId:t.engagement_id,termsVersion:t.version,componentCode:r.code,currencyId:t.currency_id,on,slot:d.slot,minor:original*10n**BigInt(scales.get(t.currency_id)!-t.unit_scale),allocation:{kind:allocation.kind,from:allocation.from,through:allocation.through,proration:allocation.proration,divisor:allocation.kind==='fixed_divisor'?allocation.divisor:allocation.payments.size,rounding:allocation.kind==='fixed_divisor'?'half_away_per_payment':'largest_remainder',fullReferencePeriodBudgetConserved:allocation.referenceBudgetConserved}});}
     continue;
    }
    const monthStart=day.with({day:1}).toString(),endOfMonth=day.with({day:day.daysInMonth}).toString();
    if(r.frequency!=='pay_period'&&(r.frequency!=='month'||!['monthly','semimonthly'].includes(t.pay_cycle.kind))){issue(t,r,'SALARY_ALLOCATION_POLICY_REQUIRED');continue;}
    if(r.frequency==='month'&&(t.starts_on>monthStart||t.effective_on>monthStart||r.from>monthStart||(t.ends_on!==null&&t.ends_on<endOfMonth)||(r.through!==null&&r.through<endOfMonth))){issue(t,r,'SALARY_PRORATION_POLICY_REQUIRED');continue;}
    const scale=scales.get(t.currency_id)!,amount=parseMoney(r.amount,t.unit_scale)*10n**BigInt(scale-t.unit_scale),allocations=r.frequency==='month'&&t.pay_cycle.kind==='semimonthly'?allocateMoney(parseMoney(r.amount,t.unit_scale),[{key:'1',weight:1n},{key:'2',weight:1n}]):null;
    for(const d of dates){if(fixed.length>=2000)throw new ApiError(422,'PAYROLL_FORECAST_REQUIRES_BACKGROUND_JOB');fixed.push({engagementId:t.engagement_id,termsVersion:t.version,componentCode:r.code,currencyId:t.currency_id,on,slot:d.slot,minor:allocations?allocations[d.slot-1].amount*10n**BigInt(scale-t.unit_scale):amount});}
   }
  }
  for(const s of result.sessions){if(s.person_id!==terms[0].person_id)continue;
   const instant=Temporal.Instant.from(s.starts_at),t=selected(terms,t=>instant.toZonedDateTimeISO(t.time_zone).toPlainDate().toString());if(!t)continue;const on=instant.toZonedDateTimeISO(t.time_zone).toPlainDate().toString();if(!activeOn(t,on))continue;
   const classOn=instant.toZonedDateTimeISO(s.time_zone).toPlainDate().toString();
   for(const r of t.components){if(!['hourly','headcount_hourly'].includes(r.kind)||!componentOn(r,on))continue;
    if(!r.assignment){issue(t,r,'CLASS_ASSIGNMENT_REQUIRED');continue;}if(r.assignment.id!==s.assignment_id)continue;
    if(r.assignment.version!==s.assignment_version){issue(t,r,'STAFF_ASSIGNMENT_CHANGED',s.id);continue;}
    if(!s.active||classOn<s.starts_on||(s.ends_on!==null&&classOn>s.ends_on))continue;
    if(r.kind!=='hourly'&&r.kind!=='headcount_hourly')continue;
    if(r.kind==='headcount_hourly'&&(r.headcountBasis!=='enrolled'||s.enrolled===null)){issue(t,r,r.headcountBasis==='enrolled'?'ROSTER_SOURCE_NOT_AVAILABLE':'FUTURE_ATTENDANCE_NOT_KNOWN',s.id);continue;}
    let rate=hourlyCompensationRate(r,t.unit_scale,r.kind==='headcount_hourly'?s.enrolled!:undefined);
    rate*=10n**BigInt(scales.get(t.currency_id)!-t.unit_scale);
    intervals.push({personId:t.person_id,currencyId:t.currency_id,interval:{key:key(t.engagement_id,t.version,r.code,s.id),start:instant.epochMilliseconds,end:Temporal.Instant.from(s.ends_at).epochMilliseconds,rateMinor:rate},source:{engagementId:t.engagement_id,termsVersion:t.version,componentCode:r.code,sessionId:s.id,sessionVersion:s.version,assignmentId:s.assignment_id,assignmentVersion:s.assignment_version,enrolled:r.kind==='headcount_hourly'?s.enrolled:null}});
    if(intervals.length>200)throw new ApiError(422,'PAYROLL_FORECAST_REQUIRES_BACKGROUND_JOB');
   }
  }
  // A private/missing source must not turn a configured hourly commitment
  // into a silently complete zero-cost forecast.
  for(const {t,r} of activeComponents.values())if(r.kind==='hourly'||r.kind==='headcount_hourly'){
   const source=result.assignments.find(a=>a.person_id===t.person_id&&a.id===r.assignment?.id);
   if(!source)issue(t,r,'SCHEDULE_SOURCE_NOT_AVAILABLE');else if(source.version!==r.assignment!.version)issue(t,r,'STAFF_ASSIGNMENT_CHANGED');
  }
 }
 if(issues.length>2000||fixed.length>2000)throw new ApiError(422,'PAYROLL_FORECAST_REQUIRES_BACKGROUND_JOB');
 const ambiguousPeople=new Set<string>();for(let i=0;i<intervals.length;i++)for(let j=i+1;j<intervals.length;j++){const a=intervals[i],b=intervals[j];if(a.personId===b.personId&&a.currencyId!==b.currencyId&&a.interval.start<b.interval.end&&b.interval.start<a.interval.end)ambiguousPeople.add(a.personId);}
 const hourlyGroups=new Map<string,typeof intervals>();for(const row of intervals){const k=key(row.personId,row.currencyId),g=hourlyGroups.get(k)??[];g.push(row);hourlyGroups.set(k,g);}
 const currencies=[...scales].filter(([id])=>!q.currencyId||id===q.currencyId).map(([currencyId,unitScale])=>{
  let hourly=0n;const hourlyPlans:Record<string,unknown>[]=[];
  for(const group of hourlyGroups.values()){if(group[0].currencyId!==currencyId)continue;if(ambiguousPeople.has(group[0].personId)){for(const row of group){const t=result.terms.find(t=>t.engagement_id===row.source.engagementId&&t.version===row.source.termsVersion)!,r=t.components.find(c=>c.code===row.source.componentCode)!;issue(t,r,'OVERLAPPING_CURRENCIES_REQUIRE_FX_POLICY',row.source.sessionId);}continue;}
   const planned=highestHourlySegments(group.map(g=>g.interval));hourly+=planned.minor;const byKey=new Map(group.map(g=>[g.interval.key,g.source]));
   hourlyPlans.push({personId:group[0].personId,scheduledMilliseconds:planned.milliseconds.toString(),estimatedCost:exact(planned.minor,unitScale),segments:planned.segments.map(s=>({startsAt:new Date(s.start).toISOString(),endsAt:new Date(s.end).toISOString(),rateMinor:s.rateMinor.toString(),source:byKey.get(s.key)}))});
  }
  const salary=fixed.filter(f=>f.currencyId===currencyId),fixedTotal=salary.reduce((sum,f)=>sum+f.minor,0n),known=hourly+fixedTotal,unpriced=issues.filter(i=>i.currencyId===currencyId);
  return {currencyId,currencyCode:result.terms.find(t=>t.currency_id===currencyId)!.currency_code,unitScale,knownHourlySubtotal:exact(hourly,unitScale),knownSalarySubtotal:exact(fixedTotal,unitScale),knownSubtotal:exact(known,unitScale),estimatedTotal:unpriced.length?null:exact(known,unitScale),unpricedComponents:unpriced,hourlyPlans,salaryPayments:salary.map(({minor,...f})=>({...f,estimatedCost:exact(minor,unitScale)}))};
 });
 return {status:200,body:{data:{report:'configured_scheduled_work_costs',...q,snapshotAt:result.snapshot_at,coverage:'visible_configured_sources_only',completeAcademyForecast:false,historyBasis:'current_recorded_terms_and_schedule',sessionRangeBasis:'session_start_in_report_time_zone',rateDateBasis:'session_start_in_work_terms_time_zone',hourlyBasis:'unrounded_scheduled_time_highest_rate_once_per_person_currency',salaryBasis:'versioned_configured_payment_allocation_not_earned_entitlement',timingBasis:'salary_pay_dates_and_hourly_session_dates',cashFlowForecast:false,rounding:'hourly_per_person_currency_once_half_away',currencyConversion:'none',actualTimeOrAttendanceUsed:false,statutoryDeductionsCalculated:false,earnedEntitlementDetermined:false,payrollApproved:false,paymentExecuted:false,currencies}}};
}
export const payrollForecastContract=[{path:'/api/v1/reports/payroll/scheduled-costs',method:'get',summary:'Permission-intersected same-snapshot work-cost forecast from pinned compensation and current visible schedules; exact known subtotals and explicit unpriced cases, not earned payroll, actual cash or statutory certification',querySchema:query}] as const;

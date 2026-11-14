import { ApiError } from '../core/policy.ts';
import { Temporal } from '@js-temporal/polyfill';
import { payCalendarDays } from '../core/pay-calendar.ts';
import { formatMoneyTotal,parseMoney } from '../core/money.ts';
import { salaryServiceEarnings } from '../core/salary-service-earnings.ts';
import type { PayrollPreparationSource } from './payroll-preparations.ts';
import type { CompensationRule } from '../core/work-compensation.ts';

export type PayrollSalarySource=Pick<PayrollPreparationSource,'work'|'terms'|'periods'|'from'|'through'>;
// Authorized immutable service sources only. No client-provided amount,
// service period, rule or exclusion is priced; no hourly window is inferred.
export function payrollSalaryPlan(source:PayrollSalarySource){
 type Salary=Extract<CompensationRule,{kind:'salary'}>;
 type Terms=PayrollPreparationSource['terms'][number];
 type Issue={servicePeriodId:string|null;servicePeriodVersion:number|null;engagementId:string;termsVersion?:number;componentCode?:string;currencyId?:string;reason:string};
 const plans:{servicePeriodId:string;servicePeriodVersion:number;engagementId:string;workVersion:number;termsVersion:number;termsVersions:number[];componentCode:string;currencyId:string;currencyCode:string;unitScale:number;serviceFrom:string;serviceThrough:string;payOn:string;calculation:ReturnType<typeof salaryServiceEarnings>}[]=[],issues:Issue[]=[];
 const work=new Map(source.work.map(w=>[w.id,w])),groups=new Map<string,Terms[]>();
 for(const t of source.terms){const rows=groups.get(t.engagement_id)??[];rows.push(t);groups.set(t.engagement_id,rows);}
 for(const rows of groups.values())rows.sort((a,b)=>a.effective_on<b.effective_on?-1:a.effective_on>b.effective_on?1:a.version-b.version);
 let evaluatedDays=0;
 for(const p of source.periods){
  if(!(groups.get(p.engagement_id)??[]).some(t=>t.components.some(r=>r.kind==='salary')))continue;
  const d=p.definition as {from:string;through:string;payOn:string;active:boolean};if(!d.active)continue;
  const base={servicePeriodId:p.id,servicePeriodVersion:p.version,engagementId:p.engagement_id},issue=(reason:string,t?:Terms,r?:Salary)=>{if(issues.length>=2000)throw new ApiError(422,'PAYROLL_PREPARATION_REQUIRES_BACKGROUND_JOB');issues.push({...base,...t?{termsVersion:t.version,currencyId:t.currency_id}:{},...r?{componentCode:r.code}:{},reason});};
  if(work.get(p.engagement_id)?.version!==p.work_version){issue('SALARY_SERVICE_PERIOD_WORK_REVIEW_REQUIRED');continue;}
  const from=d.from>source.from?d.from:source.from,through=d.through<source.through?d.through:source.through;if(from>through)continue;
  const days=payCalendarDays({from,through});evaluatedDays+=days.length;if(evaluatedDays>40000)throw new ApiError(422,'PAYROLL_PREPARATION_REQUIRES_BACKGROUND_JOB');
  const terms=groups.get(p.engagement_id)??[],runs:{t:Terms;r:Salary;from:string;through:string;versions:number[]}[]=[];let cursor=0,current:Terms|undefined;
  const lastByCode=new Map<string,typeof runs[number]>();
  for(const day of days){const on=day.toString();while(cursor<terms.length&&terms[cursor].effective_on<=on)current=terms[cursor++];
   if(!current||!current.active||on<current.starts_on||current.ends_on!==null&&on>current.ends_on)continue;
   for(const r of current.components){if(r.kind!=='salary'||on<r.from||r.through!==null&&on>r.through)continue;
    const last=lastByCode.get(r.code),sameWholePrice=last&&r.earningBasis!==undefined&&r.earningBasis!=='calendar_days'&&last.r.earningBasis===r.earningBasis&&last.r.frequency===r.frequency&&last.t.currency_id===current.currency_id&&last.t.unit_scale===current.unit_scale&&parseMoney(last.r.amount,current.unit_scale)===parseMoney(r.amount,current.unit_scale);
    if(last&&(last.t===current||sameWholePrice)&&day.subtract({days:1}).toString()===last.through){last.through=on;if(!last.versions.includes(current.version))last.versions.push(current.version);}
    else{if(runs.length>=2000)throw new ApiError(422,'PAYROLL_PREPARATION_REQUIRES_BACKGROUND_JOB');const row={t:current,r,from:on,through:on,versions:[current.version]};runs.push(row);lastByCode.set(r.code,row);}
   }
  }
  for(const {t,r,from,through,versions} of runs){
   if(r.earningBasis==='whole_service_period'&&(from!==d.from||through!==d.through)){issue('SALARY_FULL_SERVICE_PERIOD_REQUIRED',t,r);continue;}
   try{const calculation=salaryServiceEarnings({...r,from,through},{from,through},t.unit_scale);if(plans.length>=2000)throw new ApiError(422,'PAYROLL_PREPARATION_REQUIRES_BACKGROUND_JOB');plans.push({...base,workVersion:p.work_version,termsVersion:t.version,termsVersions:versions,componentCode:r.code,currencyId:t.currency_id,currencyCode:t.currency_code,unitScale:t.unit_scale,serviceFrom:d.from,serviceThrough:d.through,payOn:d.payOn,calculation});}
   catch(e){if(e instanceof ApiError&&e.status===409){issue(e.code,t,r);continue;}throw e;}
  }
 }
 // Explicitly retain gaps between active service periods. A priced month in
 // one agreement must not make an unperiodized salary in another look paid.
 for(const [engagementId,terms] of groups){
  const coverage=source.periods.filter(p=>p.engagement_id===engagementId&&p.definition.active).map(p=>p.definition as {from:string;through:string}).sort((a,b)=>a.from<b.from?-1:a.from>b.from?1:0);
  for(let index=0;index<terms.length;index++){
   const t=terms[index],next=terms[index+1];if(!t.active||next?.effective_on===t.effective_on)continue;
   const until=next?Temporal.PlainDate.from(next.effective_on).subtract({days:1}).toString():source.through;
   for(const r of t.components){if(r.kind!=='salary')continue;
    const from=[source.from,t.effective_on,t.starts_on,r.from].sort().at(-1)!,through=[source.through,until,...t.ends_on?[t.ends_on]:[],...r.through?[r.through]:[]].sort()[0];if(from>through)continue;
    let cursor=from,covered=false;for(const c of coverage){if(c.through<cursor)continue;if(c.from>cursor)break;if(c.through>=through){covered=true;break;}cursor=Temporal.PlainDate.from(c.through).add({days:1}).toString();}
    if(!covered){if(issues.length>=2000)throw new ApiError(422,'PAYROLL_PREPARATION_REQUIRES_BACKGROUND_JOB');issues.push({servicePeriodId:null,servicePeriodVersion:null,engagementId,termsVersion:t.version,componentCode:r.code,currencyId:t.currency_id,reason:'SALARY_SERVICE_PERIOD_REQUIRED'});}
   }
  }
 }
 const currencies=[...new Set([...plans.map(p=>p.currencyId),...issues.flatMap(i=>i.currencyId?[i.currencyId]:[])])].sort().map(currencyId=>{
  const selected=plans.filter(p=>p.currencyId===currencyId),ts=source.terms.filter(t=>t.currency_id===currencyId&&(selected.some(p=>p.engagementId===t.engagement_id&&p.termsVersion===t.version)||issues.some(i=>i.engagementId===t.engagement_id&&i.termsVersion===t.version))),scale=Math.max(...ts.map(t=>t.unit_scale)),sum=selected.reduce((n,p)=>n+BigInt(p.calculation.gross.minor)*10n**BigInt(scale-p.unitScale),0n),known={minor:sum.toString(),amount:formatMoneyTotal(sum,scale)};
  return {currencyId,currencyCode:ts[0].currency_code,unitScale:scale,knownConfiguredSubtotal:known,configuredTotal:issues.some(i=>i.currencyId===currencyId||!i.currencyId)?null:known};
 });
 return {engine:'salary-service-v1',basis:'explicit_earning_policy_and_reviewed_civil_service_periods',plans,unpricedComponents:issues,currencies,completeSalaryCoverage:false,sourceCapacityVerified:false,claimsPersisted:false,wagesAccrued:false,earnedEntitlementDetermined:false,paymentExecuted:false};
}

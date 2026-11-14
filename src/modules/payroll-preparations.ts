import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeNonempty,type Capability } from '../core/policy.ts';
import { payCalendarRange,payCalendarDays } from '../core/pay-calendar.ts';
import { payrollHourlyCurrencyConflicts } from '../core/payroll-hourly-earnings.ts';
import { payrollHourlyPlan } from './payroll-hourly-plan.ts';
import { payrollSalaryPlan } from './payroll-salary-plan.ts';
import type { HourlyWindow } from '../core/work-compensation.ts';
import { priceRecordedHourlySources,type Entry,type Terms } from './recorded-work-report.ts';
import { sessionEvidenceCapabilities } from './session-evidence-report.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),zone=z.string().min(1).max(100).refine(v=>{if(/^[+-]/.test(v))return false;try{Temporal.Now.instant().toZonedDateTimeISO(v);return true;}catch{return false;}});
const create=payCalendarRange.safeExtend({personId:uuid,timeZone:zone,label:z.string().trim().min(1).max(200).refine(v=>v.isWellFormed()&&!v.includes('\0'))}),empty=z.object({}).strict(),query=z.object({personId:uuid.optional(),limit:z.coerce.number().int().min(1).max(100).default(25),after:uuid.optional()}).strict();
type Source={sourceVersion:1;personId:string;from:string;through:string;timeZone:string;windowStartMilliseconds:string;windowEndMilliseconds:string;oversized:boolean;work:{id:string;person_id:string;hub_id:string|null;version:number}[];terms:Terms[];entries:(Entry&{evidence_version:number|null;evidence_decision:string|null;evidence_current:boolean|null})[];periods:{id:string;engagement_id:string;version:number;work_version:number;definition:Record<string,unknown>}[]};
type Preparation={id:string;person_id:string;label:string;from_on:string;through_on:string;time_zone:string;captured_at:string;source_snapshot:Source};
function scopes(ctx:ApiContext,edit=false){
 const caps:Capability[]=['payroll-preparations.view','work-pay.view','pay-periods.view',...edit?['payroll-preparations.edit' as const]:[]],sessionCaps:Capability[]=[...sessionEvidenceCapabilities,'session-evidence.view'];
 const required=[...caps,...sessionCaps].map(c=>permissionScope(ctx,c));if(!required.every(scopeNonempty))throw new ApiError(403,'FORBIDDEN');
 const ceiling={all:ctx.credential.all_hubs,hubs:ctx.credential.hub_ids};return {work:[...caps.map(c=>permissionScope(ctx,c)),ceiling],sessions:[...sessionCaps.map(c=>permissionScope(ctx,c)),ceiling]};
}
async function allowed(ctx:ApiContext,s:Pick<Source,'personId'|'from'|'through'|'timeZone'|'work'|'entries'>,edit=false){const a=scopes(ctx,edit);if(!(await ctx.db.query<{ok:boolean}>('SELECT public.payroll_preparation_allows($1::jsonb,$2::jsonb,$3::jsonb) ok',[JSON.stringify(s),JSON.stringify(a.work),JSON.stringify(a.sessions)])).rows[0].ok)throw new ApiError(404,'NOT_FOUND');}
async function source(ctx:ApiContext,i:{personId:string;from:string;through:string;timeZone:string},edit=false){
 // Authorize the complete current worker universe before even reporting a
 // source-budget error; otherwise oversized hidden payroll is discoverable.
 await allowed(ctx,{...i,work:[],entries:[]},edit);
 const s=(await ctx.db.query<{source:Source|null}>('SELECT public.payroll_preparation_source($1,$2::date,$3::date,$4) source',[i.personId,i.from,i.through,i.timeZone])).rows[0].source;if(!s)throw new ApiError(404,'NOT_FOUND');if(s.oversized)throw new ApiError(422,'PAYROLL_PREPARATION_REQUIRES_BACKGROUND_JOB');if(!s.work.length)throw new ApiError(404,'NOT_FOUND');return s;
}
async function row(ctx:ApiContext,id:string){scopes(ctx);const r=(await ctx.db.query<Preparation>('SELECT id,person_id,label,from_on::text,through_on::text,time_zone,captured_at::text,source_snapshot FROM public.payroll_preparations WHERE id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');await allowed(ctx,r.source_snapshot);return r;}
function calculation(s:Source,priorClaims:HourlyWindow[]=[],includeSalary=true){
 let pricing:ReturnType<typeof priceRecordedHourlySources>;
 try{pricing=priceRecordedHourlySources(s.entries,s.terms);}catch(e){if(e instanceof ApiError&&e.code==='RECORDED_WORK_REPORT_REQUIRES_BACKGROUND_JOB')throw new ApiError(422,'PAYROLL_PREPARATION_REQUIRES_BACKGROUND_JOB');throw e;}
 // Use the exact saved database window, not a second timezone-data version
 // when revisiting an old preparation. Dates remain the operator's input.
 const {priced,issues,scales}=pricing,first=Number(s.windowStartMilliseconds),last=Number(s.windowEndMilliseconds);
 const conflicts=payrollHourlyCurrencyConflicts(priced.map(p=>({key:p.key,personId:p.entry.person_id,currencyId:p.terms.currency_id,start:p.start,end:p.end,rateMinor:p.rate,rounding:p.rule.rounding})),{start:first,end:last}),ambiguous=new Set(priced.filter(p=>conflicts.has(p.key)).map(p=>p.terms.currency_id));
 return {engine:'hourly-gross-v2',basis:'retained_sources_recomputed_by_current_engine',currencies:[...scales].map(([currencyId,c])=>({currencyId,currencyCode:c.code,unitScale:c.scale,requiresFXPolicy:ambiguous.has(currencyId),
  hourly:ambiguous.has(currencyId)?null:payrollHourlyPlan(priced.filter(p=>p.terms.currency_id===currencyId),{start:first,end:last},c.scale,priorClaims),
  sourceRefs:priced.filter(p=>p.terms.currency_id===currencyId).map(p=>({key:p.key,entryId:p.entry.id,entryVersion:p.entry.version,engagementId:p.terms.engagement_id,termsVersion:p.terms.version,componentCode:p.rule.code}))})),
  unpricedComponents:issues,nonHourlySources:s.terms.flatMap(t=>t.components.filter(r=>r.kind!=='hourly'&&r.kind!=='headcount_hourly').map(r=>({engagementId:t.engagement_id,termsVersion:t.version,componentCode:r.code,kind:r.kind,reason:includeSalary&&r.kind==='salary'?'SEE_SALARY_SERVICE_PLANS_AND_REVIEW_FLAGS':'EXPLICIT_NON_HOURLY_EARNING_BASIS_REQUIRED'}))),
  ...includeSalary?{salary:payrollSalaryPlan(s)}:{},
  sessionEvidence:s.entries.map(e=>({entryId:e.id,entryVersion:e.version,sessionId:e.session_id,reviewVersion:e.evidence_version,decision:e.evidence_decision,reviewedSourceCurrent:e.evidence_current,operationalReviewAccepted:e.evidence_decision==='accepted'&&e.evidence_current===true})),
  sessionEvidenceBasis:'captured_review_decision_and_source_freshness',completePayroll:false,claimsPersisted:false,wagesAccrued:false,earnedEntitlementDetermined:false,payrollApproved:false,statutoryDeductionsCalculated:false,paymentExecuted:false,mediaContentVerified:false};
}
async function detail(ctx:ApiContext,r:Preparation){
 const current=await source(ctx,{personId:r.person_id,from:r.from_on,through:r.through_on,timeZone:r.time_zone});await allowed(ctx,current);
 const fresh=(await ctx.db.query<{current:boolean}>('SELECT $1::jsonb=$2::jsonb current',[JSON.stringify(current),JSON.stringify(r.source_snapshot)])).rows[0].current;
 return {id:r.id,personId:r.person_id,label:r.label,from:r.from_on,through:r.through_on,timeZone:r.time_zone,capturedAt:r.captured_at,status:'prepared_draft',sourcesCurrent:fresh,workRefs:r.source_snapshot.work.map(w=>({id:w.id,version:w.version,hubId:w.hub_id})),periodRefs:r.source_snapshot.periods.map(p=>({id:p.id,version:p.version,engagementId:p.engagement_id,workVersion:p.work_version})),calculation:calculation(r.source_snapshot)};
}
export async function payrollPreparations(ctx:ApiContext):Promise<Reply|null>{
 const path=/^payroll\/preparations(?:\/([^/]+))?$/.exec(ctx.path);if(!path)return null;
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params),id=path[1]?uuid.parse(path[1]):null;
 if(ctx.request.method==='POST'){
  if(id)throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(q);const i=create.parse(await jsonBody(ctx.request));payCalendarDays({from:i.from,through:i.through});scopes(ctx,true);await lockFinanceBook(ctx);await lockAcademyTopology(ctx);scopes(ctx,true);
  return mutation(ctx,i,async()=>{const s=await source(ctx,i,true);await allowed(ctx,s,true);const newId=randomUUID();
   try{await ctx.db.query('INSERT INTO public.payroll_preparations(academy_id,id,person_id,label,from_on,through_on,time_zone,source_snapshot,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[ctx.credential.academy_id,newId,i.personId,i.label,i.from,i.through,i.timeZone,JSON.stringify(s),ctx.credential.person_id]);}
   catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code==='23514'&&'message'in e&&e.message==='PAYROLL_PREPARATION_SOURCE_CHANGED')throw new ApiError(409,'PAYROLL_SOURCES_CHANGED');throw e;}
   await record(ctx.db,ctx.credential,ctx.requestId,'work.preparation.created',newId,null,{severity:'critical',sourceVersion:1,status:'prepared_draft',wagesAccrued:false});return {status:201,body:{data:await detail(ctx,await row(ctx,newId))}};
  },async reply=>{const key=(reply.body as {data:{id:string}}).data.id;await allowed(ctx,(await row(ctx,key)).source_snapshot,true);});
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);
 if(id){empty.parse(q);return {status:200,body:{data:await detail(ctx,await row(ctx,id))}};}
 const p=query.parse(q),a=scopes(ctx),rows=(await ctx.db.query<{id:string;personId:string;label:string;from:string;through:string;timeZone:string;capturedAt:string}>(`SELECT id,person_id "personId",label,from_on::text "from",through_on::text "through",time_zone "timeZone",captured_at::text "capturedAt" FROM public.payroll_preparations WHERE($1::uuid IS NULL OR person_id=$1) AND($2::uuid IS NULL OR id>$2) AND public.payroll_preparation_allows(source_snapshot,$3::jsonb,$4::jsonb) ORDER BY id LIMIT $5`,[p.personId??null,p.after??null,JSON.stringify(a.work),JSON.stringify(a.sessions),p.limit+1])).rows;return {status:200,body:{data:rows.slice(0,p.limit).map(r=>({...r,status:'prepared_draft',payrollApproved:false})),nextCursor:rows.length>p.limit?rows[p.limit-1].id:null}};
}
export const payrollPreparationsContract=[
 {path:'/api/v1/payroll/preparations',method:'get',summary:'Source-scoped immutable payroll preparation directory; complete worker work/time authority including retained/current contexts before paging, not approved or paid payroll',querySchema:query},
 {path:'/api/v1/payroll/preparations',method:'post',summary:'Retain an exact bounded payroll source draft with crossing-window hours, effective work terms, reviewed service periods and evidence freshness; actual/configured hourly calculation plus explicit salary service-earning rules and unresolved non-hourly sources. No source consumption, wage accrual, payroll approval or payment.',schema:create},
 {path:'/api/v1/payroll/preparations/{id}',method:'get',summary:'Read immutable source-based payroll draft with current-source change flag, exact hourly/source allocations and salary plans pinned to reviewed service dates and explicit earning policies, missing-period/policy review flags, penny-conserving civil proration and per-currency totals; no durable claims, paystub or earned-entitlement determination'}
] as const;
export {scopes as payrollPreparationScopes,allowed as payrollPreparationAllowed,calculation as calculatePayrollPreparation};
export type {Source as PayrollPreparationSource};

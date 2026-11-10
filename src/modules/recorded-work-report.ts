import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { payCalendarDays,payCalendarRange } from '../core/pay-calendar.ts';
import { formatMoneyTotal,roundRatio,readMinorUnits } from '../core/money.ts';
import { csvRow,csvText } from '../core/csv.ts';
import type { ResolvedReportWindow } from '../core/report-window.ts';
import { highestHourlySegments,hourlyCompensationRate,type CompensationRule,type HourlyRule,type HourlyInterval } from '../core/work-compensation.ts';
import { payrollHourlyCurrencyConflicts } from '../core/payroll-hourly-earnings.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const zone=z.string().min(1).max(100).refine(v=>{if(/^[+-]/.test(v))return false;try{Temporal.Now.instant().toZonedDateTimeISO(v);return true;}catch{return false;}});
const query=payCalendarRange.safeExtend({timeZone:zone,hubId:uuid.optional(),classId:uuid.optional(),personId:uuid.optional(),currencyId:uuid.optional()});
export type Entry={id:string;version:number;person_id:string;hub_id:string;class_id:string;session_id:string;assignment_id:string;assignment_version:number;session_version:number;current_session_version:number;session_status:string;scheduled_start:string;scheduled_end:string;starts_at:string;ends_at:string;enrollment_on:string;enrolled:number|null;attendance?:{version:number|null;sessionVersion:number|null;current:boolean;present:number|null}|null};
export type Terms={engagement_id:string;person_id:string;version:number;effective_on:string;currency_id:string;currency_code:string;unit_scale:number;active:boolean;starts_on:string;ends_on:string|null;time_zone:string;components:CompensationRule[]};
const target=`jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',t.class_id,'hubId',t.hub_id)))`;
// One statement snapshot; all privacy predicates precede limits/aggregation.
// Historical cancellation or inactive staffing never deletes delivered time.
const sources=`WITH entries AS MATERIALIZED(
 SELECT t.id,t.version,t.person_id,t.hub_id,t.class_id,t.session_id,t.assignment_id,t.assignment_version,t.session_version,
 s.version AS current_session_version,s.status AS session_status,t.scheduled_start::text,t.scheduled_end::text,t.starts_at::text,t.ends_at::text,
 (t.scheduled_start AT TIME ZONE c.time_zone)::date::text AS enrollment_on,
 CASE WHEN public.scope_contains($11::jsonb,${target}) THEN(
  SELECT count(*)::integer FROM public.class_enrollments e WHERE e.academy_id=t.academy_id AND e.class_id=t.class_id AND e.enabled
  AND e.joins_on<=(t.scheduled_start AT TIME ZONE c.time_zone)::date AND(e.leaves_on IS NULL OR e.leaves_on>=(t.scheduled_start AT TIME ZONE c.time_zone)::date)
 ) ELSE NULL END AS enrolled,
 CASE WHEN public.scope_contains($11::jsonb,${target}) AND public.scope_contains($12::jsonb,${target})
 THEN public.payroll_attendance_headcount(t.session_id,t.session_version) ELSE NULL END AS attendance
 FROM public.session_time_entries t JOIN public.class_sessions s ON s.academy_id=t.academy_id AND s.id=t.session_id
 JOIN public.classes c ON c.academy_id=t.academy_id AND c.id=t.class_id
 WHERE public.work_scope_allows($1::jsonb,t.hub_id,t.person_id) AND public.work_scope_allows($2::jsonb,t.hub_id,t.person_id)
 AND public.scope_contains($3::jsonb,${target}) AND($4::boolean OR t.hub_id=ANY($5::uuid[]))
 AND t.starts_at>=$6::timestamptz AND t.starts_at<$7::timestamptz
 AND($8::uuid IS NULL OR t.hub_id=$8) AND($9::uuid IS NULL OR t.class_id=$9) AND($10::uuid IS NULL OR t.person_id=$10)
 ORDER BY t.starts_at,t.id LIMIT 201
),terms AS(
 SELECT e.id AS engagement_id,e.person_id,r.version,r.effective_on::text,r.currency_id,c.code AS currency_code,r.unit_scale,
 (r.definition->>'active')::boolean AS active,r.definition->>'startsOn' AS starts_on,r.definition->>'endsOn' AS ends_on,r.definition->>'timeZone' AS time_zone,r.components
 FROM public.work_engagements e JOIN public.work_engagement_revisions r ON r.academy_id=e.academy_id AND r.engagement_id=e.id
 JOIN public.finance_currencies c ON c.academy_id=r.academy_id AND c.id=r.currency_id
 WHERE EXISTS(SELECT 1 FROM entries t WHERE t.person_id=e.person_id)
 AND public.work_scope_allows($1::jsonb,e.hub_id,e.person_id) AND public.work_scope_allows($2::jsonb,e.hub_id,e.person_id)
 AND($4::boolean OR e.hub_id=ANY($5::uuid[]))
 ORDER BY e.id,r.effective_on,r.version LIMIT 1001
)
SELECT statement_timestamp()::text AS snapshot_at,
 coalesce((SELECT jsonb_agg(to_jsonb(entries) ORDER BY starts_at,id) FROM entries),'[]'::jsonb) AS entries,
 coalesce((SELECT jsonb_agg(to_jsonb(terms) ORDER BY engagement_id,effective_on,version) FROM terms),'[]'::jsonb) AS terms`;
const ms=(v:string)=>Temporal.Instant.from(v).epochMilliseconds;
const exact=(n:bigint,scale:number)=>({minor:n.toString(),amount:formatMoneyTotal(n,scale)});

export function priceRecordedHourlySources(entries:Entry[],terms:Terms[]){
 const oversized=()=>new ApiError(422,'RECORDED_WORK_REPORT_REQUIRES_BACKGROUND_JOB');
 if(entries.length>200||terms.length>1000)throw oversized();
 const groups=new Map<string,Terms[]>();for(const t of terms){const group=groups.get(t.engagement_id)??[];group.push(t);groups.set(t.engagement_id,group);}
 const issues:{entryId:string;engagementId?:string;termsVersion?:number;componentCode?:string;currencyId?:string;reason:string}[]=[];
 const issue=(e:Entry,reason:string,t?:Terms,r?:CompensationRule)=>{if(issues.length>=2000)throw oversized();issues.push({entryId:e.id,...t?{engagementId:t.engagement_id,termsVersion:t.version,currencyId:t.currency_id}:{},...r?{componentCode:r.code}:{},reason});};
 const scales=new Map<string,{scale:number;code:string}>();
 const priced:{entry:Entry;terms:Terms;rule:HourlyRule;rate:bigint;start:number;end:number;key:string}[]=[];
 for(const e of entries){let matched=false;
  for(const revisions of groups.values()){
   if(revisions[0].person_id!==e.person_id)continue;
   let selected:Terms|undefined;
   for(const t of revisions){const on=Temporal.Instant.from(e.scheduled_start).toZonedDateTimeISO(t.time_zone).toPlainDate().toString();if(t.effective_on<=on&&(!selected||t.effective_on>selected.effective_on||(t.effective_on===selected.effective_on&&t.version>selected.version)))selected=t;}
   if(!selected)continue;const t=selected,on=Temporal.Instant.from(e.scheduled_start).toZonedDateTimeISO(t.time_zone).toPlainDate().toString();
   if(!t.active||on<t.starts_on||(t.ends_on!==null&&on>t.ends_on))continue;
   for(const r of t.components){
    if(!r.assignment||r.assignment.id!==e.assignment_id||on<r.from||(r.through!==null&&on>r.through))continue;matched=true;
    const old=scales.get(t.currency_id);scales.set(t.currency_id,{scale:Math.max(old?.scale??0,t.unit_scale),code:t.currency_code});
    if(r.assignment.version!==e.assignment_version){issue(e,'RECORDED_ASSIGNMENT_VERSION_MISMATCH',t,r);continue;}
    if(r.kind!=='hourly'&&r.kind!=='headcount_hourly'){issue(e,'NON_HOURLY_BASIS_REQUIRED',t,r);continue;}
    let headcount:number|undefined;
    if(r.kind==='headcount_hourly'){
     if(r.headcountBasis==='eligible_present'){issue(e,'SIGNED_ADMISSION_HEADCOUNT_EVIDENCE_REQUIRED',t,r);continue;}
     const count=r.headcountBasis==='enrolled'?e.enrolled:e.attendance?.current===true?e.attendance.present:null;
     if(count==null||!Number.isInteger(count)||count<0||count>1000){issue(e,r.headcountBasis==='enrolled'?'ROSTER_SOURCE_NOT_AVAILABLE':'SESSION_HEADCOUNT_EVIDENCE_REQUIRED',t,r);continue;}
     headcount=count;
    }
    if(priced.length>=200)throw oversized();
    priced.push({entry:e,terms:t,rule:r,rate:hourlyCompensationRate(r,t.unit_scale,headcount),start:ms(e.starts_at),end:ms(e.ends_at),key:createHash('sha256').update(JSON.stringify([e.id,t.engagement_id,t.version,r.code])).digest('hex')});
   }
  }
  if(!matched)issue(e,'NO_VISIBLE_APPLICABLE_COMPENSATION');
 }
 return {priced,issues,scales,issue};
}

export function hourlyHeadcountDetails(p:ReturnType<typeof priceRecordedHourlySources>['priced'][number]){
 if(p.rule.kind!=='headcount_hourly')return {};
 return p.rule.headcountBasis==='enrolled'?{headcountBasis:'enrolled',enrolledCount:p.entry.enrolled,enrollmentOn:p.entry.enrollment_on}:
  {headcountBasis:'present',presentCount:p.entry.attendance!.present,attendanceVersion:p.entry.attendance!.version,attendanceSessionVersion:p.entry.attendance!.sessionVersion,attendanceCountBasis:'observed_present_and_late',admissionClearanceVerified:false};
}

export async function recordedWorkReport(ctx:ApiContext){
 if(ctx.path!=='reports/payroll/recorded-time')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 await lockApprovalWrites(ctx);const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const work=permissionScope(ctx,'work-pay.view'),reports=permissionScope(ctx,'financial-reports.view'),time=permissionScope(ctx,'session-time.view');
 if(![work,reports,time].every(scopeNonempty))throw new ApiError(403,'FORBIDDEN');
 const q=query.parse(Object.fromEntries(params)),days=payCalendarDays({from:q.from,through:q.through}),first=days[0].toZonedDateTime(q.timeZone).toInstant(),last=days.at(-1)!.add({days:1}).toZonedDateTime(q.timeZone).toInstant();
 const sqlDate=(v:string)=>v.replace(/^\+0(?=\d{5}-)/,'');
 const data=(await ctx.db.query<{snapshot_at:string;entries:Entry[];terms:Terms[]}>(sources,[JSON.stringify(work),JSON.stringify(reports),JSON.stringify(time),ctx.credential.all_hubs,ctx.credential.hub_ids,sqlDate(first.toString()),sqlDate(last.toString()),q.hubId??null,q.classId??null,q.personId??null,JSON.stringify(permissionScope(ctx,'rosters.view')),JSON.stringify(permissionScope(ctx,'attendance.view'))])).rows[0];
 const {priced,issues,scales,issue}=priceRecordedHourlySources(data.entries,data.terms);
 const source=(p:typeof priced[number])=>({entryId:p.entry.id,entryVersion:p.entry.version,agreementContextPath:`/api/v1/payroll/engagements/${p.terms.engagement_id}/recorded-time/${p.entry.id}/agreement-context?entryVersion=${p.entry.version}&termsVersion=${p.terms.version}`,engagementId:p.terms.engagement_id,termsVersion:p.terms.version,componentCode:p.rule.code,rounding:p.rule.rounding,excessToleranceMinutes:p.rule.excessToleranceMinutes,durationExceedsScheduleTolerance:p.end-p.start>ms(p.entry.scheduled_end)-ms(p.entry.scheduled_start)+p.rule.excessToleranceMinutes*60000,
  ...hourlyHeadcountDetails(p)});
 // Check complete worker coverage before currency filtering. Configured
 // claims reserve actual work even when that work rounds down to zero.
 const conflicts=payrollHourlyCurrencyConflicts(priced.map(p=>({key:p.key,personId:p.entry.person_id,currencyId:p.terms.currency_id,start:p.start,end:p.end,rateMinor:p.rate,rounding:p.rule.rounding}))),ambiguous=new Set(priced.filter(p=>conflicts.has(p.key)).map(p=>p.entry.person_id));
 for(const p of priced)if(ambiguous.has(p.entry.person_id))issue(p.entry,'OVERLAPPING_CURRENCIES_REQUIRE_FX_POLICY',p.terms,p.rule);
 const currencies=[...scales].filter(([id])=>!q.currencyId||id===q.currencyId).map(([currencyId,{scale,code}])=>{
  let actualTotal=0n,configuredTotal=0n;const workers:Record<string,unknown>[]=[];
  const people=[...new Set(priced.filter(p=>p.terms.currency_id===currencyId).map(p=>p.entry.person_id))];
  for(const personId of people){if(ambiguous.has(personId))continue;
   const rows=priced.filter(p=>p.entry.person_id===personId&&p.terms.currency_id===currencyId),actual:HourlyInterval[]=[],configured:HourlyInterval[]=[];
   for(const p of rows){const rate=p.rate*10n**BigInt(scale-p.terms.unit_scale),rounded=p.rule.rounding==='none'?BigInt(p.end-p.start):roundRatio(BigInt(p.end-p.start),300000n,'half_away')*300000n;
    actual.push({key:p.key,start:p.start,end:p.end,rateMinor:rate});configured.push({key:p.key,start:p.start,end:p.start+Number(rounded),rateMinor:rate});}
   const a=highestHourlySegments(actual),c=highestHourlySegments(configured),byKey=new Map(rows.map(p=>[p.key,p]));actualTotal+=a.minor;configuredTotal+=c.minor;
   const segments=(list:typeof a.segments)=>list.map(s=>({startsAt:new Date(s.start).toISOString(),endsAt:new Date(s.end).toISOString(),rateMinor:s.rateMinor.toString(),source:source(byKey.get(s.key)!)}));
   workers.push({personId,actualMilliseconds:a.milliseconds.toString(),configuredMilliseconds:c.milliseconds.toString(),actualCost:exact(a.minor,scale),configuredCost:exact(c.minor,scale),configuredReductionRequiresReview:c.minor<a.minor,actualSegments:segments(a.segments),configuredSegments:segments(c.segments)});
  }
  const unpriced=issues.filter(i=>i.currencyId===currencyId||i.currencyId===undefined);
  return {currencyId,currencyCode:code,unitScale:scale,knownActualHourlySubtotal:exact(actualTotal,scale),knownConfiguredHourlySubtotal:exact(configuredTotal,scale),actualHourlyTotal:unpriced.length?null:exact(actualTotal,scale),configuredHourlyTotal:unpriced.length?null:exact(configuredTotal,scale),unpricedComponents:unpriced,
   sourceAssessments:priced.filter(p=>p.terms.currency_id===currencyId).map(p=>({...source(p),personId:p.entry.person_id,rateMinor:(p.rate*10n**BigInt(scale-p.terms.unit_scale)).toString(),actualMilliseconds:String(p.end-p.start)})),workers};
 });
 return {status:200,body:{data:{report:'recorded_session_hourly_costs',...q,snapshotAt:data.snapshot_at,coverage:'visible_recorded_session_time_only',rangeBasis:'actual_start_in_report_time_zone_full_interval',rateDateBasis:'captured_scheduled_start_in_work_terms_time_zone',historyBasis:'current_recorded_time_and_effective_terms',roundingPolicy:'per_input_interval_before_configured_overlap',overlapPolicy:'highest_hourly_rate_stable_key_tie',currencyConversion:'none',completePayroll:false,payrollApproved:false,earnedEntitlementDetermined:false,statutoryDeductionsCalculated:false,paymentExecuted:false,sessionEvidenceReviewed:false,
  entries:data.entries.map(e=>({entryId:e.id,entryVersion:e.version,personId:e.person_id,hubId:e.hub_id,classId:e.class_id,sessionId:e.session_id,assignmentId:e.assignment_id,assignmentVersion:e.assignment_version,recordedMilliseconds:String(ms(e.ends_at)-ms(e.starts_at)),outsideScheduleMilliseconds:String(Math.max(0,ms(e.ends_at)-ms(e.starts_at)-Math.max(0,Math.min(ms(e.ends_at),ms(e.scheduled_end))-Math.max(ms(e.starts_at),ms(e.scheduled_start))))),scheduleChanged:e.session_version!==e.current_session_version,currentSessionStatus:e.session_status})),unpricedComponents:issues,currencies}}};
}
export const recordedWorkReportContract=[{path:'/api/v1/reports/payroll/recorded-time',method:'get',summary:'Same-snapshot saved teacher-hour costs with authorized captured-date enrollment or current complete observed-present-and-late attendance headcounts; missing/stale/unsigned eligibility remains unpriced, actual/configured rounding and highest overlap once. Never payroll approval, signed admission clearance or payment.',querySchema:query}] as const;

type RecordedData=NonNullable<Awaited<ReturnType<typeof recordedWorkReport>>>['body']['data'];
type Provenance={id:string;version:number;dateWindow?:ResolvedReportWindow&{overriddenFields?:string[]}};
export function recordedWorkCsv(data:RecordedData,provenance?:Provenance):Reply{
 if(data.report!=='recorded_session_hourly_costs'||data.entries.length>200||new Set(data.entries.map(e=>e.entryId)).size!==data.entries.length||new Set(data.currencies.map(c=>c.currencyId)).size!==data.currencies.length)throw new Error('RECORDED_WORK_EXPORT_INVALID');
 const header=['section','field','value','currency_id','currency_code','unit_scale','source_id','minor','amount','details_json'],rows:(string|number|undefined)[][]=[header],entryIds=new Set(data.entries.map(e=>e.entryId));
 const meta=(field:string,value:unknown)=>rows.push(['metadata',field,csvText(typeof value==='string'?value:JSON.stringify(value))]);
 for(const [field,value]of Object.entries(data))if(!['currencies','entries','unpricedComponents'].includes(field)&&value!==undefined)meta(field,value);
 meta('exportCompleteness','complete_permitted_report_within_source_and_output_limits');meta('numericPrecisionPolicy','money_minor_units_and_amounts_are_exact_strings');meta('textPolicy','Formula-like free text uses a visible text: prefix; stored records are unchanged.');
 if(provenance){meta('presetId',provenance.id);meta('presetVersion',provenance.version);if(provenance.dateWindow)meta('dateWindow',provenance.dateWindow);}
 for(const e of data.entries)rows.push(['entry','recorded_time','',undefined,undefined,undefined,e.entryId,'','',csvText(JSON.stringify(e))]);
 for(const e of data.unpricedComponents){if(!entryIds.has(e.entryId))throw new Error('RECORDED_WORK_EXPORT_SOURCE_INVALID');rows.push(['review',csvText(e.reason),'',e.currencyId,undefined,undefined,e.entryId,'','',csvText(JSON.stringify(e))]);}
 for(const c of data.currencies){
  const amount=(section:string,field:string,raw:unknown,source?:string,details?:unknown)=>{const m=raw as {minor:string;amount:string}|null;if(!m||typeof m.minor!=='string'||m.amount!==formatMoneyTotal(readMinorUnits(m.minor),c.unitScale))throw new Error('RECORDED_WORK_EXPORT_MONEY_INVALID');rows.push([section,field,'',c.currencyId,csvText(c.currencyCode),c.unitScale,source,m.minor,m.amount,details===undefined?undefined:csvText(JSON.stringify(details))]);return readMinorUnits(m.minor);};
  const actual=amount('currency_total','knownActualHourlySubtotal',c.knownActualHourlySubtotal),configured=amount('currency_total','knownConfiguredHourlySubtotal',c.knownConfiguredHourlySubtotal);
  for(const [field,known]of [['actualHourlyTotal',actual],['configuredHourlyTotal',configured]] as const){if((c[field]===null)!==Boolean(c.unpricedComponents.length))throw new Error('RECORDED_WORK_EXPORT_TOTAL_INVALID');if(c[field]===null)rows.push(['status',field,'unpriced_components_present',c.currencyId,csvText(c.currencyCode),c.unitScale]);else if(amount('currency_total',field,c[field])!==known)throw new Error('RECORDED_WORK_EXPORT_TOTAL_INVALID');}
  let actualSum=0n,configuredSum=0n;
  for(const worker of c.workers){const person=uuid.parse(worker.personId);let actualWorkerCost=0n;for(const [basis,costField,timeField,segmentField]of [['actual','actualCost','actualMilliseconds','actualSegments'],['configured','configuredCost','configuredMilliseconds','configuredSegments']] as const){const cost=amount('worker',costField,worker[costField],person,{configuredReductionRequiresReview:worker.configuredReductionRequiresReview,milliseconds:worker[timeField]}),segments=worker[segmentField];if(!Array.isArray(segments))throw new Error('RECORDED_WORK_EXPORT_SEGMENTS_INVALID');let milliseconds=0n,numerator=0n,last=-Infinity;
   for(const segment of segments){const start=Date.parse(segment.startsAt),end=Date.parse(segment.endsAt),rate=readMinorUnits(segment.rateMinor);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||start<last||rate<0n||!entryIds.has(segment.source?.entryId))throw new Error('RECORDED_WORK_EXPORT_SEGMENTS_INVALID');last=end;milliseconds+=BigInt(end-start);numerator+=rate*BigInt(end-start);rows.push([basis+'_segment','rate_and_pinned_source','',c.currencyId,csvText(c.currencyCode),c.unitScale,person,'','',csvText(JSON.stringify(segment))]);}
   if(milliseconds.toString()!==worker[timeField]||roundRatio(numerator,3600000n,'half_away')!==cost)throw new Error('RECORDED_WORK_EXPORT_SEGMENTS_INVALID');if(basis==='actual'){actualSum+=cost;actualWorkerCost=cost;}else{configuredSum+=cost;if(worker.configuredReductionRequiresReview!==(cost<actualWorkerCost))throw new Error('RECORDED_WORK_EXPORT_REVIEW_INVALID');}
  }}
  if(actualSum!==actual||configuredSum!==configured)throw new Error('RECORDED_WORK_EXPORT_TOTAL_INVALID');
  for(const e of c.sourceAssessments){if(!entryIds.has(e.entryId))throw new Error('RECORDED_WORK_EXPORT_SOURCE_INVALID');rows.push(['source_assessment','pricing_and_review','',c.currencyId,csvText(c.currencyCode),c.unitScale,e.entryId,'','',csvText(JSON.stringify(e))]);}
 }
 if(rows.length>10001)throw new ApiError(422,'RECORDED_WORK_REPORT_REQUIRES_BACKGROUND_JOB');const body='\uFEFF'+rows.map(row=>csvRow(Array.from({length:header.length},(_,i)=>row[i]))).join('\r\n')+'\r\n';if(Buffer.byteLength(body)>4_194_304)throw new ApiError(422,'RECORDED_WORK_REPORT_REQUIRES_BACKGROUND_JOB');return{status:200,body,csv:{filename:`recorded-work-${data.from}-${data.through}.csv`}};
}
export async function completeRecordedWorkExport(ctx:ApiContext,provenance?:Provenance){const reply=await recordedWorkReport(ctx);if(!reply||reply.status!==200)throw new Error('RECORDED_WORK_EXPORT_SOURCE_INVALID');return recordedWorkCsv(reply.body.data,provenance);}
export async function recordedWorkExport(ctx:ApiContext):Promise<Reply|null>{if(ctx.path!=='reports/payroll/recorded-time/export')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const path='reports/payroll/recorded-time',url=new URL(ctx.request.url);url.pathname='/api/v1/'+path;return completeRecordedWorkExport({...ctx,path,request:new Request(url,{method:'GET'})});}
export const recordedWorkExportContract=[{...recordedWorkReportContract[0],path:recordedWorkReportContract[0].path+'/export',summary:'Complete current-source-scoped recorded teaching time CSV:all visible entries,outside-schedule and changed-session flags,actual/configured currency and worker costs,pinned nonduplicated hourly segments,source assessments and unpriced cases. Reconciles exact time/rate/monetary totals;keeps review requirements and original coverage limitations. Not payroll approval,legal entitlement,attendance clearance or payment. Original200time-entry/1000terms source bounds plus10000output rows/4MiB fail without partial files. Saved preset provenance and resolved dates retained;no queued recorded-time export yet.',responseContentType:'text/csv' as const}] as const;

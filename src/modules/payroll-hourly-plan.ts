import { payrollHourlyEarnings } from '../core/payroll-hourly-earnings.ts';
import { createHash } from 'node:crypto';
import { formatMoneyTotal } from '../core/money.ts';
import { ApiError } from '../core/policy.ts';
import type { HourlyWindow } from '../core/work-compensation.ts';
import type { priceRecordedHourlySources } from './recorded-work-report.ts';

type Priced=ReturnType<typeof priceRecordedHourlySources>['priced'][number];
type Evidence={evidence_version?:number|null;evidence_decision?:string|null;evidence_current?:boolean|null};

// Consume the complete, authorized, one-worker/one-currency priced source set.
// The caller must rule out cross-currency overlaps before selecting a set.
// This is earning attribution for the posting workflow, not a source claim,
// legal wage determination or permission to pay an unreviewed session.
export function payrollHourlyPlan(priced:(Priced&{entry:Priced['entry']&Evidence})[],window:HourlyWindow,unitScale:number,priorClaims:HourlyWindow[]=[]){
 formatMoneyTotal(0n,unitScale);
 if(new Set(priced.map(p=>p.entry.person_id)).size>1||new Set(priced.map(p=>p.terms.currency_id)).size>1||priced.some(p=>p.entry.person_id!==p.terms.person_id||!Number.isInteger(p.terms.unit_scale)||p.terms.unit_scale<0||p.terms.unit_scale>unitScale))throw new ApiError(400,'INCOMPATIBLE_PAYROLL_HOURLY_SOURCES');
 const hourly=payrollHourlyEarnings(priced.map(p=>({key:p.key,start:p.start,end:p.end,rateMinor:p.rate*10n**BigInt(unitScale-p.terms.unit_scale),rounding:p.rule.rounding})),window,priorClaims,unitScale);
 const byKey=new Map(priced.map(p=>[p.key,p]));
 // Window-independent identity: a corrected time entry or retroactive rate
 // must not become a second earning just by moving outside old time claims.
 // Operational report/media review changes do not change this price identity.
 const identities=new Map<string,typeof priced>();for(const p of priced){const rows=identities.get(p.entry.id)??[];rows.push(p);identities.set(p.entry.id,rows);}
 const sourceIdentities=[...identities].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([entryId,rows])=>({entryId,entryVersion:rows[0].entry.version,pricingFingerprint:createHash('sha256').update(JSON.stringify([...rows].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0).map(p=>[p.key,p.rate.toString(),p.terms.unit_scale,p.rule.rounding]))).digest('hex')}));
 const source=(p:Priced)=>({key:p.key,entryId:p.entry.id,entryVersion:p.entry.version,personId:p.entry.person_id,hubId:p.entry.hub_id,classId:p.entry.class_id,sessionId:p.entry.session_id,assignmentId:p.entry.assignment_id,assignmentVersion:p.entry.assignment_version,engagementId:p.terms.engagement_id,termsVersion:p.terms.version,componentCode:p.rule.code});
 const allocations=(basis:typeof hourly.actual)=>{
  const milliseconds=new Map<string,bigint>();for(const s of basis.segments)milliseconds.set(s.key,(milliseconds.get(s.key)??0n)+BigInt(s.end-s.start));
  const sourceAllocations=basis.sources.map(s=>({...source(byKey.get(s.key)!),milliseconds:(milliseconds.get(s.key)??0n).toString(),gross:s.gross}));
  const work=new Map<string,{gross:bigint;milliseconds:bigint;sourceKeys:string[]}>();
  for(const s of sourceAllocations){const w=work.get(s.engagementId)??{gross:0n,milliseconds:0n,sourceKeys:[]};w.gross+=BigInt(s.gross.minor);w.milliseconds+=BigInt(s.milliseconds);w.sourceKeys.push(s.key);work.set(s.engagementId,w);}
  return {sourceAllocations,workAllocations:[...work].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([engagementId,w])=>({engagementId,sourceKeys:w.sourceKeys,milliseconds:w.milliseconds.toString(),gross:{minor:w.gross.toString(),amount:formatMoneyTotal(w.gross,unitScale)}}))};
 };
 // Assess every priced source, including a lower-rate class shadowed by a
 // concurrent class. Missing reports/media must not silently erase its work
 // or hide its review obligations merely because it loses the rate contest.
 const sourceAssessments=priced.map(p=>{
  const scheduledStart=Date.parse(p.entry.scheduled_start),scheduledEnd=Date.parse(p.entry.scheduled_end),duration=p.end-p.start;
  const overlap=Math.max(0,Math.min(p.end,scheduledEnd)-Math.max(p.start,scheduledStart));
  return {...source(p),outsideScheduleMilliseconds:String(duration-overlap),durationExceedsScheduleTolerance:duration>scheduledEnd-scheduledStart+p.rule.excessToleranceMinutes*60000,
   reviewVersion:p.entry.evidence_version??null,decision:p.entry.evidence_decision??null,reviewedSourceCurrent:p.entry.evidence_current??false,operationalReviewAccepted:p.entry.evidence_decision==='accepted'&&p.entry.evidence_current===true,
   scheduleChanged:p.entry.session_version!==p.entry.current_session_version,currentSessionStatus:p.entry.session_status};
 }).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 return {...hourly,actual:{...hourly.actual,...allocations(hourly.actual)},configured:{...hourly.configured,...allocations(hourly.configured)},sourceAssessments,sourceIdentities,
  operationalReviewRequired:sourceAssessments.some(s=>!s.operationalReviewAccepted),timeReviewRequired:sourceAssessments.some(s=>s.durationExceedsScheduleTolerance||BigInt(s.outsideScheduleMilliseconds)>0n||s.scheduleChanged||s.currentSessionStatus!=='scheduled'),
  humanReviewRequired:true,payoutReady:false,priorClaimsVerified:false};
}

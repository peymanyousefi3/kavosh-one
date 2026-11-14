import type {z} from 'zod';
import type {t4aRecordDefinition} from '../core/t4a-record-definition.ts';
import {projectT4aZeroNetSettlement,sumT4aAllocations} from '../core/t4a-service-allocation.ts';
import {ApiError} from '../core/policy.ts';
import {parseMoney} from '../core/money.ts';
import {settlementAuthoritySQL} from './payroll-settlement-report.ts';

type Row={postingId:string;version:number|null;settlementVersion:number|null;currentSettlementVersion:number|null;settlementState:string|null;state:string|null;recognizedOn:string|null;recognizedYear:number|null;settledOn:string|null;currencyCode:string;unitScale:number;sourceContextIssue:string|null;postingReversed:boolean;sourceCurrent:boolean;sourceIssue:string|null;grossMinor:string|null;nonTaxDeductedMinor:string|null;definition:z.infer<typeof t4aRecordDefinition>|null};
export type ZeroNetT4aRows={snapshotAt:string;candidates:number;authorized:number;lines:number;bytes:string;entries:Row[]};
// Same six bound selectors as the positive-payment report. Retained recognized
// years survive corrections. Undated Canadian contractor sources are expressly
// unresolved/unassigned,never guessed from their planned payroll date.
export const zeroNetT4aSql=`WITH candidates AS MATERIALIZED(
 SELECT p.id FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id
 LEFT JOIN public.zero_net_settlements s ON s.academy_id=p.academy_id AND s.posting_id=p.id LEFT JOIN public.zero_net_settlement_revisions sr ON sr.academy_id=s.academy_id AND sr.posting_id=s.posting_id AND sr.version=s.version
 WHERE g.person_id=$3 AND EXISTS(SELECT 1 FROM jsonb_array_elements(g.source_snapshot->'contexts') context WHERE context->>'employerId'=$4::uuid::text)
 AND p.plan#>>'{net,amounts,netMinor}'='0' AND(p.plan#>>'{net,amounts,grossMinor}')::numeric>0
 AND((sr.state='recorded' AND extract(year FROM((sr.definition->>'settledAt')::timestamptz AT TIME ZONE $6)::date)::integer=$5)
 OR EXISTS(SELECT 1 FROM public.zero_net_t4a_revisions history WHERE history.academy_id=p.academy_id AND history.posting_id=p.id AND history.source_snapshot#>>'{source,taxYear}'=$5::text)
 OR(p.reversal_id IS NULL AND sr.state IS DISTINCT FROM 'recorded' AND jsonb_array_length(g.source_snapshot->'contexts')=1 AND g.source_snapshot#>>'{contexts,0,countryCode}'='CA' AND g.source_snapshot#>>'{contexts,0,classification}'='contractor' AND g.source_snapshot#>>'{contexts,0,reportingForm}'='T4A')) ORDER BY p.id LIMIT 501
),permitted AS MATERIALIZED(
 SELECT c.id FROM candidates c JOIN public.payrun_net_postings p ON p.id=c.id JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id WHERE ${settlementAuthoritySQL}
),stats AS(
 SELECT count(*)::integer n,coalesce(sum(CASE WHEN r.state='recorded' THEN jsonb_array_length(r.definition#>'{allocation,income}')+jsonb_array_length(r.definition#>'{allocation,otherExcluded}')+jsonb_array_length(r.definition->'incomeTaxSources')+coalesce(jsonb_array_length(r.definition->'nonTaxDeductionSources'),0) ELSE 0 END),0)::integer lines,
 coalesce(sum(octet_length(r.definition::text)+octet_length(r.source_snapshot::text)),0)::bigint bytes
 FROM permitted c LEFT JOIN public.zero_net_t4a_records h ON h.posting_id=c.id LEFT JOIN public.zero_net_t4a_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version
),usable AS MATERIALIZED(SELECT * FROM permitted WHERE(SELECT n<=500 AND lines<=20000 AND bytes<=2097152 FROM stats)),plans AS MATERIALIZED(
 SELECT c.id,CASE WHEN r.state='recorded' THEN public.zero_net_t4a_plan(c.id,r.version,r.settlement_version,r.definition) END plan
 FROM usable c LEFT JOIN public.zero_net_t4a_records h ON h.posting_id=c.id LEFT JOIN public.zero_net_t4a_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version
),rows AS(
 SELECT p.id "postingId",r.version,r.settlement_version "settlementVersion",s.version "currentSettlementVersion",sr.state "settlementState",r.state,r.source_snapshot#>>'{source,recognizedOn}' "recognizedOn",(r.source_snapshot#>>'{source,taxYear}')::integer "recognizedYear",
 CASE WHEN sr.state='recorded' THEN(((sr.definition->>'settledAt')::timestamptz AT TIME ZONE $6)::date)::text END "settledOn",currency.code "currencyCode",g.unit_scale "unitScale",p.reversal_id IS NOT NULL "postingReversed",
 l.plan IS NOT NULL AND(l.plan-'before') IS NOT DISTINCT FROM(r.source_snapshot-'before') AND l.plan->>'unavailable' IS NULL "sourceCurrent",l.plan->>'unavailable' "sourceIssue",
 r.source_snapshot->>'grossMinor' "grossMinor",r.source_snapshot->>'nonTaxDeductedMinor' "nonTaxDeductedMinor",CASE WHEN r.state='recorded' THEN r.definition END definition,
 CASE WHEN jsonb_array_length(g.source_snapshot->'contexts')<>1 THEN 'T4A_SINGLE_LEGAL_CONTEXT_REVIEW_REQUIRED'
 WHEN g.source_snapshot#>>'{contexts,0,reportingForm}'='T4A_NR' THEN 'T4A_NONRESIDENT_REPORTING_CONTEXT'
 WHEN g.source_snapshot#>>'{contexts,0,classification}'='employee' AND g.source_snapshot#>>'{contexts,0,reportingForm}'='T4' THEN 'T4_EMPLOYEE_REPORTING_CONTEXT'
 WHEN g.source_snapshot#>>'{contexts,0,countryCode}' IS DISTINCT FROM 'CA' THEN 'T4A_CANADIAN_CONTEXT_REVIEW_REQUIRED'
 WHEN g.source_snapshot#>>'{contexts,0,classification}' IS DISTINCT FROM 'contractor' THEN 'T4A_CONTRACTOR_CONTEXT_REVIEW_REQUIRED'
 WHEN g.source_snapshot#>>'{contexts,0,reportingForm}' IS DISTINCT FROM 'T4A' THEN 'T4A_REPORTING_FORM_REVIEW_REQUIRED' ELSE NULL END "sourceContextIssue"
 FROM plans l JOIN public.payrun_net_postings p ON p.id=l.id JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id JOIN public.finance_currencies currency ON currency.academy_id=g.academy_id AND currency.id=g.currency_id
 LEFT JOIN public.zero_net_settlements s ON s.academy_id=p.academy_id AND s.posting_id=p.id LEFT JOIN public.zero_net_settlement_revisions sr ON sr.academy_id=s.academy_id AND sr.posting_id=s.posting_id AND sr.version=s.version
 LEFT JOIN public.zero_net_t4a_records h ON h.academy_id=p.academy_id AND h.posting_id=p.id LEFT JOIN public.zero_net_t4a_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version
)
SELECT statement_timestamp()::text "snapshotAt",(SELECT count(*)::integer FROM candidates) candidates,(SELECT n FROM stats) authorized,(SELECT lines FROM stats) lines,(SELECT bytes FROM stats) bytes,coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY "postingId") FROM rows r),'[]'::jsonb) entries`;
export function projectZeroNetT4aRows(taxYear:number,r:ZeroNetT4aRows){
 if(r.candidates!==r.authorized)throw new ApiError(403,'T4A_REPORT_SOURCE_ACCESS_REQUIRED');
 const sources:({sourceKind:'zero_net_settlement';postingId:string;recognitionVersion:number;settlementVersion:number;recognizedOn:string;reportingAccount:{id:string;version:number}}&ReturnType<typeof sumT4aAllocations>)[]=[],unresolved:{postingId:string;code:string}[]=[];let corrected=0;
 for(const e of r.entries){
  let code:string|null=null;
  if(e.postingReversed){if(e.state==='recorded')code='REVERSED_ZERO_NET_RECOGNITION_REQUIRES_WITHDRAWAL';else corrected++;}
  else if(e.state==='withdrawn'&&(e.settlementState!=='recorded'||Number(e.settledOn?.slice(0,4))!==taxYear))corrected++;
  else if(e.sourceContextIssue)code=e.sourceContextIssue;
  else if(e.currencyCode!=='CAD'||e.unitScale!==2)code='T4A_CAD_RECOGNITION_REQUIRED';
  else if(e.settlementState!=='recorded'||!e.settledOn)code='ZERO_NET_T4A_ACTUAL_SETTLEMENT_REQUIRED_UNASSIGNED_YEAR';
  else if(e.state!=='recorded'||!e.definition)code='ZERO_NET_T4A_RECOGNITION_REQUIRED';
  else if(e.recognizedOn!==e.settledOn||e.recognizedYear!==taxYear)code='ZERO_NET_T4A_TIME_ZONE_YEAR_REVIEW_REQUIRED';
  else if(!e.sourceCurrent||e.settlementVersion!==e.currentSettlementVersion)code='ZERO_NET_T4A_RECOGNITION_SOURCE_CHANGED';
  else{
   const projection=projectT4aZeroNetSettlement(e.definition.allocation,{currencyCode:'CAD',unitScale:2,grossMinor:e.grossMinor,netMinor:'0',incomeTaxDeductedMinor:parseMoney(e.definition.allocation.incomeTaxDeducted,2).toString(),nonTaxDeductedMinor:e.nonTaxDeductedMinor});
   sources.push({sourceKind:'zero_net_settlement',postingId:e.postingId,recognitionVersion:e.version!,settlementVersion:e.settlementVersion!,recognizedOn:e.recognizedOn!,reportingAccount:e.definition.reportingAccount,...sumT4aAllocations([{...projection,paymentCount:0}])});
  }
  if(code)unresolved.push({postingId:e.postingId,code});
 }
 return {sources,unresolved,corrected,postingIds:r.entries.map(e=>e.postingId),candidates:r.candidates,totals:sumT4aAllocations(sources)};
}

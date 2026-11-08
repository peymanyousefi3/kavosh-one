import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty,type Capability } from '../core/policy.ts';
import { exactReportMoney as exact } from '../core/aging.ts';
import { parseMoney,readMinorUnits } from '../core/money.ts';
import { csvRow,csvText } from '../core/csv.ts';
import { accountingDate } from './finance-periods.ts';
import { financialIds } from './financial-reports.ts';
import { lockAcademyTopology } from './academy.ts';
import { payrollSourceAuthoritySQL } from './payroll-settlement-report.ts';
import type { ResolvedReportWindow } from '../core/report-window.ts';

const query=z.object({from:accountingDate,through:accountingDate,personIds:financialIds.optional(),hubIds:financialIds.optional(),currencyIds:financialIds.optional(),countryIds:financialIds.optional(),regionIds:financialIds.optional(),cityIds:financialIds.optional()}).strict().refine(q=>q.from<=q.through&&(Date.parse(q.through)-Date.parse(q.from))/86400000<=3660,'Choose an ordered range of at most 3661 civil days.');
const bundleCaps:Capability[]=['financial-reports.view','payruns.view','payrun-net.view','payrun-postings.view'];
const sourceCaps:Capability[]=['work-pay.view','payroll-accruals.view','payroll-adjustments.view','accounts.view','journals.view'];
const measures=['gross','employeeDeductions','employerContributions','net','employerCost'] as const;
type Amounts=Record<(typeof measures)[number],ReturnType<typeof exact>>;
type RawLine={code:string;label:string;amount:string};
type Row={eventId:string;eventKind:'posting'|'reversal';postingId:string;runId:string;personId:string;currencyId:string;currencyCode:string;unitScale:number;reference:string;postedOn:string;netVersion:number;gross:string;deductions:string;employer:string;net:string;deductionLines:RawLine[];employerLines:RawLine[]};
// ponytail: synchronous complete register caps 2,000 signed events/20,000
// component lines/4MiB. Larger histories need queued, chunked generation.
export function assertPayrollRegisterBounds(events:number,lines:number,bytes=0){if(events>2000||lines>20000||bytes>4_194_304)throw new ApiError(422,'PAYROLL_REGISTER_REQUIRES_BACKGROUND_JOB');}
function scopes(ctx:ApiContext){const s=Object.fromEntries([...bundleCaps,...sourceCaps].map(c=>[c,permissionScope(ctx,c)]));if([...bundleCaps,'work-pay.view','accounts.view','journals.view'].some(c=>!scopeNonempty(s[c])))throw new ApiError(403,'FORBIDDEN');return s;}
// Corrections are signed events on their ORIGINAL ledger dates. Reversing a
// December posting in January must not erase December or manufacture January
// earnings. Pinned net versions, source rights and all aggregates share one
// statement; current statement edits never rewrite this retained register.
const sql=`WITH selected AS MATERIALIZED(
 SELECT p.id posting_id,p.run_id,p.plan#>'{net,amounts}' amounts,g.person_id,g.currency_id,c.code currency_code,g.unit_scale,g.reference,p.net_version,n.definition,e.id event_id,e.kind,e.posted_on
 FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id
 JOIN public.finance_currencies c ON c.academy_id=g.academy_id AND c.id=g.currency_id
 JOIN public.payrun_net_revisions n ON n.academy_id=p.academy_id AND n.run_id=p.run_id AND n.version=p.net_version
 LEFT JOIN public.payrun_net_posting_reversals v ON v.academy_id=p.academy_id AND v.id=p.reversal_id
 CROSS JOIN LATERAL(VALUES(p.id,'posting'::text,(p.input->>'postedOn')::date),(v.id,'reversal'::text,(v.input->>'postedOn')::date)) e(id,kind,posted_on)
 WHERE e.id IS NOT NULL AND e.posted_on BETWEEN $3::date AND $4::date
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(${bundleCaps.map(c=>`$1::jsonb->'${c}'`).join(',')},$2::jsonb)) s WHERE public.scope_contains(s,g.scope) IS NOT TRUE)
 AND ${payrollSourceAuthoritySQL}
 AND($5::uuid[] IS NULL OR g.person_id=ANY($5)) AND($7::uuid[] IS NULL OR g.currency_id=ANY($7))
 AND(($6::uuid[] IS NULL AND $8::uuid[] IS NULL AND $9::uuid[] IS NULL AND $10::uuid[] IS NULL) OR EXISTS(SELECT 1 FROM jsonb_array_elements(g.source_snapshot->'items') i JOIN public.hubs h ON h.academy_id=g.academy_id AND h.id=(i->>'hubId')::uuid LEFT JOIN public.cities ci ON ci.academy_id=h.academy_id AND ci.id=h.city_id LEFT JOIN public.regions r ON r.academy_id=ci.academy_id AND r.id=ci.region_id WHERE($6::uuid[] IS NULL OR h.id=ANY($6)) AND($8::uuid[] IS NULL OR r.country_id=ANY($8)) AND($9::uuid[] IS NULL OR r.id=ANY($9)) AND($10::uuid[] IS NULL OR ci.id=ANY($10))))
 ORDER BY e.id LIMIT 2001
),bounds AS(SELECT count(*)::integer events,coalesce(sum(jsonb_array_length(definition->'employeeDeductions')+jsonb_array_length(definition->'employerContributions')),0)::integer lines FROM selected),
 rows AS(SELECT event_id "eventId",kind "eventKind",posting_id "postingId",run_id "runId",person_id "personId",currency_id "currencyId",currency_code "currencyCode",unit_scale "unitScale",reference,posted_on::text "postedOn",net_version "netVersion",amounts->>'grossMinor' gross,amounts->>'employeeDeductionMinor' deductions,amounts->>'employerContributionMinor' employer,amounts->>'netMinor' net,
 coalesce((SELECT jsonb_agg(jsonb_build_object('code',l->>'code','label',l->>'label','amount',l->>'amount') ORDER BY l->>'code') FROM jsonb_array_elements(definition->'employeeDeductions') l),'[]'::jsonb) "deductionLines",
 coalesce((SELECT jsonb_agg(jsonb_build_object('code',l->>'code','label',l->>'label','amount',l->>'amount') ORDER BY l->>'code') FROM jsonb_array_elements(definition->'employerContributions') l),'[]'::jsonb) "employerLines"
 FROM selected CROSS JOIN bounds WHERE events<=2000 AND lines<=20000)
 SELECT statement_timestamp()::text "snapshotAt",b.events,b.lines,coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY "postedOn","eventId") FROM rows r),'[]'::jsonb) entries FROM bounds b`;

export async function payrollRegisterData(ctx:ApiContext){
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params));await lockAcademyTopology(ctx);
 const r=(await ctx.db.query<{snapshotAt:string;events:number;lines:number;entries:Row[]}>(sql,[JSON.stringify(scopes(ctx)),JSON.stringify({all:ctx.credential.all_hubs,hubs:ctx.credential.hub_ids}),q.from,q.through,q.personIds??null,q.hubIds??null,q.currencyIds??null,q.countryIds??null,q.regionIds??null,q.cityIds??null])).rows[0];assertPayrollRegisterBounds(r.events,r.lines);
 const entries=r.entries.map(({gross,deductions,employer,net,deductionLines,employerLines,...e})=>{
  const g=readMinorUnits(gross),d=readMinorUnits(deductions),er=readMinorUnits(employer),n=readMinorUnits(net),sign=e.eventKind==='posting'?1n:-1n;
  const lines=(list:RawLine[])=>list.map(({amount,...l})=>({...l,amount:exact(parseMoney(amount,e.unitScale)*sign,e.unitScale)})),employeeDeductionLines=lines(deductionLines),employerContributionLines=lines(employerLines);
  if(g<0n||d<0n||er<0n||n<0n||g-d!==n||employeeDeductionLines.reduce((s,l)=>s+readMinorUnits(l.amount.minor),0n)!==d*sign||employerContributionLines.reduce((s,l)=>s+readMinorUnits(l.amount.minor),0n)!==er*sign)throw new Error('PAYROLL_REGISTER_AMOUNTS_INCONSISTENT');
  return {...e,gross:exact(g*sign,e.unitScale),employeeDeductions:exact(d*sign,e.unitScale),employerContributions:exact(er*sign,e.unitScale),net:exact(n*sign,e.unitScale),employerCost:exact((g+er)*sign,e.unitScale),employeeDeductionLines,employerContributionLines};
 });
 const totals=(rows:typeof entries)=>{const scale=Math.max(...rows.map(e=>e.unitScale));return {currencyId:rows[0].currencyId,currencyCode:rows[0].currencyCode,unitScale:scale,eventCount:rows.length,...Object.fromEntries(measures.map(k=>[k,exact(rows.reduce((s,e)=>s+readMinorUnits(e[k].minor)*10n**BigInt(scale-e.unitScale),0n),scale)])) as Amounts};};
 const group=(key:(e:typeof entries[number])=>string)=>{const map=new Map<string,typeof entries>();for(const e of entries){const k=key(e),list=map.get(k)??[];list.push(e);map.set(k,list);}return [...map].sort(([a],[b])=>a.localeCompare(b)).map(([,rows])=>rows);};
 const components=new Map<string,{personId:string;currencyId:string;currencyCode:string;unitScale:number;kind:string;code:string;labels:Set<string>;minor:bigint;eventCount:number}>();
 for(const e of entries)for(const [kind,lines] of [['employee_deduction',e.employeeDeductionLines],['employer_contribution',e.employerContributionLines]] as const)for(const l of lines){const key=JSON.stringify([e.personId,e.currencyId,kind,l.code]),g=components.get(key)??{personId:e.personId,currencyId:e.currencyId,currencyCode:e.currencyCode,unitScale:e.unitScale,kind,code:l.code,labels:new Set<string>(),minor:0n,eventCount:0},scale=Math.max(g.unitScale,e.unitScale);g.minor=g.minor*10n**BigInt(scale-g.unitScale)+readMinorUnits(l.amount.minor)*10n**BigInt(scale-e.unitScale);g.unitScale=scale;g.labels.add(l.label);g.eventCount++;components.set(key,g);}
 const data={report:'recorded_payroll_register',...q,snapshotAt:r.snapshotAt,eventCount:entries.length,postingCount:new Set(entries.map(e=>e.postingId)).size,
  componentTotals:[...components].sort(([a],[b])=>a.localeCompare(b)).map(([,g])=>{const {minor,labels,...v}=g;return {...v,labels:[...labels].sort(),amount:exact(minor,g.unitScale)};}),
  currencies:group(e=>e.currencyId).map(totals),workers:group(e=>e.personId+':'+e.currencyId).map(rows=>({personId:rows[0].personId,...totals(rows)})),chartData:group(e=>e.postedOn.slice(0,7)+':'+e.currencyId).map(rows=>({month:rows[0].postedOn.slice(0,7),...totals(rows)})),entries,
  completeWithinBounds:true,coverage:'posted_manual_reviewed_net_statements_and_signed_ledger_corrections',effectiveDateBasis:'inclusive_original_posting_and_reversal_dates_not_payment_dates',correctionBasis:'signed_movements_in_range_not_restated_earlier_periods',statementBasis:'immutable_net_version_pinned_by_each_posting',selectionBasis:'whole_source_bundles_matching_source_hub_and_geography_not_allocated_hub_costs',sourceSnapshot:'single_statement',permissionsAppliedBeforeAggregation:true,currencyConversion:'none',unpostedEarningsIncluded:false,paymentsIncluded:false,statutoryRulesCalculated:false,authorityDocumentsVerified:false,taxYearIncomeDetermined:false,isOfficialPaystub:false,isT4OrT4A:false,moneyMovementPerformed:false};assertPayrollRegisterBounds(r.events,r.lines,Buffer.byteLength(JSON.stringify(data)));return data;
}
type Data=Awaited<ReturnType<typeof payrollRegisterData>>;
export async function completePayrollRegisterExport(ctx:ApiContext,provenance?:{id?:string;version?:number;dateWindow?:ResolvedReportWindow&{overriddenFields?:string[]}}):Promise<Reply>{
 const d=await payrollRegisterData(ctx),header=['section','field','value','event_id','posting_id','run_id','person_id','currency_id','currency_code','unit_scale','posted_on','event_kind','net_version','reference','component_kind','component_code','component_label','component_minor','component_amount',...measures.flatMap(k=>[k+'_minor',k+'_amount'])],rows:(string|number|boolean|null|undefined)[][]=[header];
 for(const [k,v] of Object.entries(d))if(!['currencies','workers','chartData','entries','componentTotals'].includes(k))rows.push(['metadata',k,csvText(typeof v==='string'?v:JSON.stringify(v))]);
 if(provenance)for(const [k,v] of Object.entries(provenance))rows.push(['metadata','preset_'+k,csvText(JSON.stringify(v))]);
 rows.push(['metadata','numericPrecisionPolicy','Exact decimal text; import amounts as text to avoid spreadsheet precision loss.']);
 const amounts=(e:Amounts)=>measures.flatMap(k=>[e[k].minor,e[k].amount]);
 for(const [section,groups] of [['currency_total',d.currencies],['worker_total',d.workers],['monthly_chart',d.chartData]] as const)for(const g of groups)rows.push([section,'','',null,null,null,'personId'in g?g.personId:null,g.currencyId,csvText(g.currencyCode),g.unitScale,'month'in g?g.month:null,null,null,null,null,null,null,null,null,...amounts(g)]);
 for(const g of d.componentTotals)rows.push(['component_total','','',null,null,null,g.personId,g.currencyId,csvText(g.currencyCode),g.unitScale,null,null,null,null,g.kind,csvText(g.code),csvText(JSON.stringify(g.labels)),g.amount.minor,g.amount.amount]);
 for(const e of d.entries){rows.push(['event','','',e.eventId,e.postingId,e.runId,e.personId,e.currencyId,csvText(e.currencyCode),e.unitScale,e.postedOn,e.eventKind,e.netVersion,csvText(e.reference),null,null,null,null,null,...amounts(e)]);for(const [kind,lines] of [['employee_deduction',e.employeeDeductionLines],['employer_contribution',e.employerContributionLines]] as const)for(const l of lines)rows.push(['component','','',e.eventId,e.postingId,e.runId,e.personId,e.currencyId,csvText(e.currencyCode),e.unitScale,e.postedOn,e.eventKind,e.netVersion,csvText(e.reference),kind,csvText(l.code),csvText(l.label),l.amount.minor,l.amount.amount]);}
 const body='\uFEFF'+rows.map(r=>csvRow(Array.from({length:header.length},(_,i)=>r[i]))).join('\r\n')+'\r\n';assertPayrollRegisterBounds(d.eventCount,0,Buffer.byteLength(body));return {status:200,body,csv:{filename:`payroll-register-${d.from}-${d.through}.csv`}};
}
export async function payrollRegister(ctx:ApiContext):Promise<Reply|null>{if(!['reports/payroll/register','reports/payroll/register/export'].includes(ctx.path))return null;if(ctx.path.endsWith('/export'))return completePayrollRegisterExport(ctx);return {status:200,body:{data:await payrollRegisterData(ctx)}};}
export const payrollRegisterContract=[{path:'/api/v1/reports/payroll/register',method:'get',summary:'Complete bounded payroll ledger register with worker/currency totals,monthly chart series and pinned deduction/employer components. Signed corrections retain their own ledger dates;whole-source permissions before one-statement selection. Supports configurable annual/YTD civil ranges;not payment-date tax income,T4/T4A or official paystub certification.',querySchema:query}] as const;
export const payrollRegisterExportContract=[{path:'/api/v1/reports/payroll/register/export',method:'get',summary:'Complete formula-safe payroll register CSV including exact totals,workers,monthly series,signed posting/reversal events and component details;current source permissions and 2,000event/20,000component/4MiB refusal limits. No authority references,private reviews,unposted pay or statutory certification.',querySchema:query,responseContentType:'text/csv' as const}] as const;

import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,scopeNonempty,type Capability } from '../core/policy.ts';
import { readMinorUnits } from '../core/money.ts';
import { exactReportMoney as exact } from '../core/aging.ts';
import { accountingDate } from './finance-periods.ts';
import { financialIds } from './financial-reports.ts';

const query=z.object({on:accountingDate,personIds:financialIds.optional(),hubIds:financialIds.optional(),currencyIds:financialIds.optional(),countryIds:financialIds.optional(),regionIds:financialIds.optional(),cityIds:financialIds.optional(),status:z.enum(['unsettled','partially_settled','settled','zero_net']).optional()}).strict();
const bundleCaps:Capability[]=['financial-reports.view','payruns.view','payrun-net.view','payrun-postings.view','payrun-payments.view'];
const sourceCaps:Capability[]=['work-pay.view','payroll-accruals.view','payroll-adjustments.view'];
const accountCaps:Capability[]=['accounts.view','journals.view'];
const maxPostings=2000,maxEvents=100000,maxBytes=4_194_304;
export function assertPayrollSettlementBounds(postings:number,events:number,bytes=0){if(postings>maxPostings||events>maxEvents||bytes>maxBytes)throw new ApiError(422,'PAYROLL_SETTLEMENT_REPORT_REQUIRES_BACKGROUND_JOB');}
const hubScope=(column:string)=>`CASE WHEN ${column} IS NULL THEN '{"all":true,"hubs":[]}'::jsonb ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(${column})) END`;
// All source rights, complete funding history and balances share ONE MVCC
// statement. A concurrent payment is either wholly included or wholly absent.
const sql=`WITH selected AS MATERIALIZED(
 SELECT p.id,p.run_id,p.plan#>'{net,amounts}' amounts,g.person_id,g.currency_id,c.code currency_code,g.unit_scale,g.reference,g.planned_pay_on
 FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id
 JOIN public.finance_currencies c ON c.academy_id=g.academy_id AND c.id=g.currency_id
 LEFT JOIN public.payrun_net_posting_reversals v ON v.academy_id=p.academy_id AND v.id=p.reversal_id
 WHERE(p.input->>'postedOn')::date<=$3::date AND(v.id IS NULL OR(v.input->>'postedOn')::date>$3::date)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(${bundleCaps.map(c=>`$1::jsonb->'${c}'`).join(',')},$2::jsonb)) s WHERE public.scope_contains(s,g.scope) IS NOT TRUE)
 AND public.payrun_net_source_allows(g.id,'work-pay.view',$1::jsonb->'work-pay.view') AND public.payrun_net_source_allows(g.id,'work-pay.view',$2::jsonb) AND public.payrun_net_source_allows(g.id,'work-pay.view',$1::jsonb->'financial-reports.view')
 AND(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g.source_snapshot->'items') i WHERE i->>'kind'<>'manual_bonus') OR public.payrun_net_source_allows(g.id,'payroll-accruals.view',$1::jsonb->'payroll-accruals.view'))
 AND(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g.source_snapshot->'items') i WHERE i->>'kind'='manual_bonus') OR public.payrun_net_source_allows(g.id,'payroll-adjustments.view',$1::jsonb->'payroll-adjustments.view'))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.plan->'accounts') a LEFT JOIN public.finance_accounts f ON f.academy_id=p.academy_id AND f.id=(a->>'id')::uuid CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array($1::jsonb->'accounts.view',$1::jsonb->'journals.view',$2::jsonb)) s WHERE f.id IS NULL OR public.scope_contains(s,${hubScope('f.hub_id')}) IS NOT TRUE)
 AND NOT EXISTS(SELECT 1 FROM public.payrun_payments pay LEFT JOIN public.finance_accounts f ON f.academy_id=pay.academy_id AND f.id=pay.funding_account LEFT JOIN public.finance_payment_methods m ON m.academy_id=pay.academy_id AND m.id=pay.method_id WHERE pay.posting_id=p.id AND(f.id IS NULL OR m.id IS NULL OR public.scope_contains($1::jsonb->'accounts.view',${hubScope('f.hub_id')}) IS NOT TRUE OR public.scope_contains($1::jsonb->'journals.view',${hubScope('f.hub_id')}) IS NOT TRUE OR public.scope_contains($2::jsonb,${hubScope('f.hub_id')}) IS NOT TRUE OR public.scope_contains($1::jsonb->'payment-methods.view',${hubScope('m.hub_id')}) IS NOT TRUE OR public.scope_contains($2::jsonb,${hubScope('m.hub_id')}) IS NOT TRUE))
 AND($4::uuid[] IS NULL OR g.person_id=ANY($4)) AND($6::uuid[] IS NULL OR g.currency_id=ANY($6))
 AND(($5::uuid[] IS NULL AND $7::uuid[] IS NULL AND $8::uuid[] IS NULL AND $9::uuid[] IS NULL) OR EXISTS(SELECT 1 FROM jsonb_array_elements(g.source_snapshot->'items') i JOIN public.hubs h ON h.academy_id=g.academy_id AND h.id=(i->>'hubId')::uuid LEFT JOIN public.cities ci ON ci.academy_id=h.academy_id AND ci.id=h.city_id LEFT JOIN public.regions r ON r.academy_id=ci.academy_id AND r.id=ci.region_id WHERE($5::uuid[] IS NULL OR h.id=ANY($5)) AND($7::uuid[] IS NULL OR r.country_id=ANY($7)) AND($8::uuid[] IS NULL OR r.id=ANY($8)) AND($9::uuid[] IS NULL OR ci.id=ANY($9))))
 ORDER BY p.id LIMIT ${maxPostings+1}
),usable AS MATERIALIZED(SELECT * FROM selected WHERE(SELECT count(*) FROM selected)<=${maxPostings}),
events AS MATERIALIZED(
 SELECT p.posting_id,p.amount_minor minor FROM usable u JOIN public.payrun_payments p ON p.posting_id=u.id WHERE p.posted_on<=$3::date
 UNION ALL SELECT p.posting_id,-p.amount_minor FROM usable u JOIN public.payrun_payments p ON p.posting_id=u.id JOIN public.payrun_payment_reversals v ON v.academy_id=p.academy_id AND v.payment_id=p.id WHERE v.posted_on<=$3::date
 LIMIT ${maxEvents+1}
),paid AS(SELECT posting_id,sum(minor) minor FROM events GROUP BY posting_id),rows AS(
 SELECT u.id "postingId",u.run_id "runId",u.person_id "personId",u.currency_id "currencyId",u.currency_code "currencyCode",u.unit_scale "unitScale",u.reference,u.planned_pay_on::text "plannedPayOn",u.amounts->>'grossMinor' gross,u.amounts->>'employeeDeductionMinor' deductions,u.amounts->>'employerContributionMinor' employer,u.amounts->>'netMinor' net,coalesce(p.minor,0)::text paid
 FROM usable u LEFT JOIN paid p ON p.posting_id=u.id WHERE(SELECT count(*) FROM events)<=${maxEvents}
) SELECT statement_timestamp()::text "snapshotAt",(SELECT count(*)::integer FROM selected) postings,(SELECT count(*)::integer FROM events) events,coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY "postingId") FROM rows r),'[]'::jsonb) entries`;
type Entry={postingId:string;runId:string;personId:string;currencyId:string;currencyCode:string;unitScale:number;reference:string;plannedPayOn:string;gross:string;deductions:string;employer:string;net:string;paid:string};
export async function payrollSettlementReport(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/payroll/settlements')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params));await lockApprovalWrites(ctx);
 const scopes=Object.fromEntries([...bundleCaps,...sourceCaps,...accountCaps,'payment-methods.view' as Capability].map(c=>[c,permissionScope(ctx,c)]));if([...bundleCaps,'work-pay.view',...accountCaps,'payment-methods.view'].some(c=>!scopeNonempty(scopes[c])))throw new ApiError(403,'FORBIDDEN');
 const r=(await ctx.db.query<{snapshotAt:string;postings:number;events:number;entries:Entry[]}>(sql,[JSON.stringify(scopes),JSON.stringify({all:ctx.credential.all_hubs,hubs:ctx.credential.hub_ids}),q.on,q.personIds??null,q.hubIds??null,q.currencyIds??null,q.countryIds??null,q.regionIds??null,q.cityIds??null])).rows[0];assertPayrollSettlementBounds(r.postings,r.events);
 const entries=r.entries.map(e=>{const net=readMinorUnits(e.net),paid=readMinorUnits(e.paid),remaining=net-paid,status=net===0n?'zero_net':remaining===0n?'settled':paid===0n?'unsettled':'partially_settled';if(paid<0n||remaining<0n)throw new Error('PAYROLL_SETTLEMENT_BALANCE_INCONSISTENT');return {postingId:e.postingId,runId:e.runId,personId:e.personId,currencyId:e.currencyId,currencyCode:e.currencyCode,unitScale:e.unitScale,reference:e.reference,plannedPayOn:e.plannedPayOn,status,gross:exact(e.gross,e.unitScale),employeeDeductions:exact(e.deductions,e.unitScale),employerContributions:exact(e.employer,e.unitScale),net:exact(net,e.unitScale),paid:exact(paid,e.unitScale),remaining:exact(remaining,e.unitScale),pastPlannedPay:exact(e.plannedPayOn<q.on?remaining:0n,e.unitScale)};}).filter(e=>q.status===undefined||e.status===q.status);
 const amounts=['gross','employeeDeductions','employerContributions','net','paid','remaining','pastPlannedPay'] as const;
 const totals=(rows:typeof entries)=>{const scale=Math.max(...rows.map(e=>e.unitScale));return {currencyId:rows[0].currencyId,currencyCode:rows[0].currencyCode,unitScale:scale,postingCount:rows.length,...Object.fromEntries(amounts.map(k=>[k,exact(rows.reduce((sum,e)=>sum+readMinorUnits(e[k].minor)*10n**BigInt(scale-e.unitScale),0n),scale)]))};};
 const currencies=[...new Set(entries.map(e=>e.currencyId))].sort().map(id=>totals(entries.filter(e=>e.currencyId===id)));
 const groups=new Map<string,typeof entries>();for(const e of entries){const key=e.currencyId+':'+e.status,group=groups.get(key)??[];group.push(e);groups.set(key,group);}const chartData=[...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,rows])=>({status:rows[0].status,...totals(rows)}));
 const data={report:'recorded_worker_net_settlements',on:q.on,snapshotAt:r.snapshotAt,filters:q,postingCount:entries.length,currencies,chartData,entries,completeWithinBounds:true,coverage:'permitted_net_postings_effective_at_cutoff_only',unpostedOrUngroupedEarningsIncluded:false,selectionBasis:'whole_worker_bundles_matching_any_one_source_hub_and_all_geography_filters',geographyBasis:'current_hub_location',amountsAllocatedToSelectedHubs:false,permissionsAppliedBeforeAggregation:true,sourceSnapshot:'single_statement',paymentDateBasis:'inclusive_ledger_posting_dates_not_external_bank_settlement',systemKnowledgeAsOf:false,currencyConversion:'none',bankVerified:false,moneyMovementPerformed:false,isOfficialPaystub:false,statutoryRulesCalculated:false,deductionAndEmployerRemittancesIncluded:false,pastPlannedPayIsLegalOverdueDetermination:false};assertPayrollSettlementBounds(r.postings,r.events,Buffer.byteLength(JSON.stringify(data)));return {status:200,body:{data}};
}
export const payrollSettlementReportContract=[{path:'/api/v1/reports/payroll/settlements',method:'get',summary:'Complete bounded multi-worker net-pay settlement report with worker/currency/status/hub/geography selectors,exact currency totals and status chart series at a ledger-date cutoff. Whole source bundles and all funding history authorized in one statement before aggregation;hub filters select whole bundles,not attributed hub amounts. Excludes unposted earnings,statutory remittances,bank verification and paystub certification.',querySchema:query}] as const;

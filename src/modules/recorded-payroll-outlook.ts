import type { ApiContext } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,type Scope } from '../core/policy.ts';
import { payrollSettlementScopes,settlementAuthoritySQL } from './payroll-settlement-report.ts';

export type RecordedPayrollEntry={id:string;personId:string;accountId:string;hubId:string|null;currencyId:string;currencyCode:string;scale:number;postedOn:string;payOn:string;notBefore:string;activeOn:boolean;activeThrough:boolean;budget:string;paidOn:string;paidThrough:string};
export type RecordedPayrollSource={postings:number;buckets:number;eventLines:number;entries:RecordedPayrollEntry[]};
export function assertRecordedPayrollOutlookBounds(r:RecordedPayrollSource){if(r.postings>2000||r.buckets>10000||r.eventLines>100000)throw new ApiError(422,'FINANCIAL_OUTLOOK_REQUIRES_BACKGROUND_JOB');}
// Keep the parent private as a whole,then attribute money to its actual original
// wage-liability buckets. Do not copy a whole mixed-hub run into each hub.
const sql=`WITH selected AS MATERIALIZED(
 SELECT p.id,g.person_id,g.currency_id,c.code currency_code,g.unit_scale,g.planned_pay_on,(p.input->>'postedOn')::date posted_on,(v.input->>'postedOn')::date reversed_on,p.plan->'origins' origins,p.plan->'wageDeductions' deductions
 FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id JOIN public.finance_currencies c ON c.academy_id=g.academy_id AND c.id=g.currency_id
 LEFT JOIN public.payrun_net_posting_reversals v ON v.academy_id=p.academy_id AND v.id=p.reversal_id
 WHERE(p.input->>'postedOn')::date<=$4::date AND(v.id IS NULL OR(v.input->>'postedOn')::date>$3::date)
 AND ${settlementAuthoritySQL} AND public.scope_contains($7::jsonb,g.scope) AND public.payrun_net_source_allows(g.id,'work-pay.view',$7::jsonb)
 AND($8::jsonb='[]'::jsonb OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements($8::jsonb) extra WHERE public.scope_contains(extra,g.scope) IS NOT TRUE OR public.payrun_net_source_allows(g.id,'work-pay.view',extra) IS NOT TRUE))
 AND($6::uuid IS NULL OR g.currency_id=$6)
 AND($5::uuid IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(p.plan->'origins') o JOIN public.finance_accounts a ON a.id=(o->>'accountId')::uuid WHERE a.hub_id=$5))
 ORDER BY p.id LIMIT 2001
),usable AS MATERIALIZED(SELECT * FROM selected WHERE(SELECT count(*) FROM selected)<=2000),
origins AS MATERIALIZED(SELECT p.id,a.id account_id,a.hub_id,sum((o->>'minor')::numeric) gross FROM usable p CROSS JOIN LATERAL jsonb_array_elements(p.origins) o JOIN public.finance_accounts a ON a.id=(o->>'accountId')::uuid WHERE($5::uuid IS NULL OR a.hub_id=$5) GROUP BY p.id,a.id,a.hub_id LIMIT 10001),
buckets AS MATERIALIZED(SELECT o.*,o.gross-coalesce((SELECT(d->>'minor')::numeric FROM usable p CROSS JOIN LATERAL jsonb_array_elements(p.deductions) d WHERE p.id=o.id AND(d->>'accountId')::uuid=o.account_id),0) budget FROM origins o WHERE(SELECT count(*) FROM origins)<=10000),
events AS MATERIALIZED(SELECT e.posting_id,e.account_id,e.posted_on,e.paid_minor FROM buckets b JOIN public.payrun_payment_events e ON e.posting_id=b.id AND e.account_id=b.account_id WHERE e.posted_on<=$4::date LIMIT 100001),
paid AS(SELECT posting_id,account_id,coalesce(sum(paid_minor) FILTER(WHERE posted_on<=$3::date),0) paid_on,sum(paid_minor) paid_through,max(posted_on) FILTER(WHERE paid_minor<0) reopened_on FROM events GROUP BY posting_id,account_id),
rows AS(SELECT p.id,p.person_id "personId",b.account_id "accountId",b.hub_id "hubId",p.currency_id "currencyId",p.currency_code "currencyCode",p.unit_scale scale,p.posted_on::text "postedOn",p.planned_pay_on::text "payOn",greatest(p.posted_on,e.reopened_on)::text "notBefore",p.posted_on<=$3::date AND(p.reversed_on IS NULL OR p.reversed_on>$3::date) "activeOn",p.reversed_on IS NULL OR p.reversed_on>$4::date "activeThrough",b.budget::text budget,coalesce(e.paid_on,0)::text "paidOn",coalesce(e.paid_through,0)::text "paidThrough"
 FROM buckets b JOIN usable p ON p.id=b.id LEFT JOIN paid e ON e.posting_id=b.id AND e.account_id=b.account_id WHERE(SELECT count(*) FROM events)<=100000)
SELECT(SELECT count(*)::integer FROM selected) postings,(SELECT count(*)::integer FROM origins) buckets,(SELECT count(*)::integer FROM events) "eventLines",coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY id,"accountId") FROM rows r),'[]'::jsonb) entries`;
export function recordedPayrollOutlookSource(ctx:ApiContext,q:{on:string;through:string;hubId?:string;currencyId?:string},additionalScopes:Scope[]=[]){return {sql,params:[JSON.stringify(payrollSettlementScopes(ctx)),JSON.stringify({all:ctx.credential.all_hubs,hubs:ctx.credential.hub_ids}),q.on,q.through,q.hubId??null,q.currencyId??null,JSON.stringify(permissionScope(ctx,'financial-outlook.view')),JSON.stringify(additionalScopes)]};}

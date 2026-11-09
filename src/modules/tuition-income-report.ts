import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { exactReportMoney as exact } from '../core/aging.ts';
import { accountingDate } from './finance-periods.ts';
import { financialIds } from './financial-reports.ts';
import { lockAcademyTopology } from './academy.ts';
import { attributionAuthorization,attributionReportScopes,tuitionInvoiceSelectionSQL,tuitionRecognitionSelectionSQL } from './financial-attribution-access.ts';

export const tuitionIncomeQuery=z.object({from:accountingDate,through:accountingDate,hubIds:financialIds.optional(),classIds:financialIds.optional(),studentIds:financialIds.optional(),accountIds:financialIds.optional().describe('Original invoice consideration account;also applies to associated earning and reversal events.'),billToIds:financialIds.optional(),currencyIds:financialIds.optional(),countryIds:financialIds.optional(),regionIds:financialIds.optional(),cityIds:financialIds.optional(),recognition:z.enum(['all','earned','deferred']).default('all').describe('Original immutable invoice policy,not current earning state.')}).strict().refine(q=>q.from<=q.through);
const dimensions=['hub','class','student','account','recognition','month','event'] as const,measures=['netBillings','earnedInvoiceRevenue','deferredBillings','chargedTax','grossBillings','subsequentlyEarnedRevenue','recognizedRevenue','netDeferredChange'] as const;
type Row={key:string|null;currencyId:string;currencyCode:string;unitScale:number;documentEvents:number;earningEvents:number;sourceEvents:number}&Record<typeof measures[number],string>;
// ponytail:10,000 source events/groups per dimension and4MiB. Larger
// selections require chunked aggregation,never an interactive-page sum.
export function assertTuitionIncomeBounds(events:number,groups:number[],bytes=0){if([events,...groups,bytes].some(n=>!Number.isSafeInteger(n)||n<0))throw new Error('TUITION_INCOME_REPORT_COUNTS_INVALID');if(events>10000||groups.some(n=>n>10000)||bytes>4_194_304)throw new ApiError(422,'TUITION_INCOME_REPORT_REQUIRES_BACKGROUND_JOB');}
const sql=`WITH owned AS NOT MATERIALIZED(
 SELECT i.*,p.currency_id,p.unit_scale,c.code currency_code,t.net_minor,t.tax_minor,t.gross_minor
 FROM public.tuition_invoices i
 JOIN public.tuition_plans p ON p.academy_id=i.academy_id AND p.id=i.plan_id JOIN public.tuition_plan_revisions t ON t.academy_id=i.academy_id AND t.plan_id=i.plan_id AND t.version=i.plan_version
 JOIN public.finance_currencies c ON c.academy_id=p.academy_id AND c.id=p.currency_id
 JOIN public.hubs h ON h.academy_id=i.academy_id AND h.id=i.hub_id LEFT JOIN public.cities ci ON ci.academy_id=h.academy_id AND ci.id=h.city_id LEFT JOIN public.regions r ON r.academy_id=ci.academy_id AND r.id=ci.region_id
 WHERE($14::boolean OR i.hub_id=ANY($15::uuid[]))
 AND ${tuitionInvoiceSelectionSQL('$3::jsonb','$4::jsonb')}
 AND($5::uuid[] IS NULL OR i.hub_id=ANY($5)) AND($6::uuid[] IS NULL OR i.class_id=ANY($6)) AND($7::uuid[] IS NULL OR i.student_id=ANY($7)) AND($8::uuid[] IS NULL OR i.consideration_account=ANY($8)) AND($9::uuid[] IS NULL OR i.bill_to_id=ANY($9)) AND($10::uuid[] IS NULL OR p.currency_id=ANY($10)) AND($11::uuid[] IS NULL OR r.country_id=ANY($11)) AND($12::uuid[] IS NULL OR r.id=ANY($12)) AND($13::uuid[] IS NULL OR ci.id=ANY($13)) AND($16='all' OR i.recognition=$16)
),events AS NOT MATERIALIZED(
 SELECT i.id,NULL::uuid recognition_id,i.student_id,i.class_id,i.hub_id,i.consideration_account,i.recognition,i.currency_id,i.unit_scale,i.currency_code,e.kind,e.event_on,i.net_minor*e.sign net,i.tax_minor*e.sign tax,i.gross_minor*e.sign gross,0::numeric subsequently_earned,1 document_event,0 earning_event
 FROM owned i JOIN public.billing_documents d ON d.academy_id=i.academy_id AND d.id=i.id LEFT JOIN public.billing_documents cd ON cd.academy_id=i.academy_id AND cd.id=i.credit_id
 CROSS JOIN LATERAL(VALUES(d.id,d.issued_on,'invoice'::text,1),(cd.id,cd.issued_on,'credit'::text,-1)) e(id,event_on,kind,sign)
 WHERE e.id IS NOT NULL AND e.event_on BETWEEN $1::date AND $2::date
 UNION ALL
 SELECT i.id,rel.id,i.student_id,i.class_id,i.hub_id,i.consideration_account,i.recognition,i.currency_id,rel.unit_scale,i.currency_code,e.kind,e.event_on,0::numeric,0::numeric,0::numeric,rel.amount_minor*e.sign,0,1
 FROM owned i JOIN public.tuition_recognitions rel ON rel.academy_id=i.academy_id AND rel.invoice_id=i.id LEFT JOIN public.tuition_recognition_voids v ON v.academy_id=rel.academy_id AND v.id=rel.void_id
 CROSS JOIN LATERAL(VALUES(rel.id,rel.posted_on,'recognition'::text,1),(v.id,v.posted_on,'recognition_reversal'::text,-1)) e(id,event_on,kind,sign)
 WHERE e.id IS NOT NULL AND e.event_on BETWEEN $1::date AND $2::date
 AND ${tuitionRecognitionSelectionSQL('$4::jsonb')}
),selected AS MATERIALIZED(SELECT * FROM events LIMIT 10001
),normalized AS MATERIALIZED(SELECT s.*,max(unit_scale) OVER(PARTITION BY currency_id) scale FROM selected s WHERE(SELECT count(*) FROM selected)<=10000),weighted AS MATERIALIZED(SELECT n.*,('1'||repeat('0',scale-unit_scale))::numeric factor FROM normalized n),expanded AS(
 SELECT w.*,d.dimension,d.key FROM weighted w CROSS JOIN LATERAL(VALUES('total',NULL::text),('hub',hub_id::text),('class',class_id::text),('student',student_id::text),('account',consideration_account::text),('recognition',recognition),('month',to_char(w.event_on,'YYYY-MM')),('event',kind)) d(dimension,key)
),groups AS(
 SELECT dimension,key,currency_id AS "currencyId",currency_code AS "currencyCode",scale AS "unitScale",count(*)::integer "sourceEvents",sum(document_event)::integer "documentEvents",sum(earning_event)::integer "earningEvents",sum(net*factor)::text "netBillings",sum(CASE WHEN recognition='earned' THEN net*factor ELSE 0 END)::text "earnedInvoiceRevenue",sum(CASE WHEN recognition='deferred' THEN net*factor ELSE 0 END)::text "deferredBillings",sum(tax*factor)::text "chargedTax",sum(gross*factor)::text "grossBillings",sum(subsequently_earned*factor)::text "subsequentlyEarnedRevenue",sum(((CASE WHEN recognition='earned' THEN net ELSE 0 END)+subsequently_earned)*factor)::text "recognizedRevenue",sum(((CASE WHEN recognition='deferred' THEN net ELSE 0 END)-subsequently_earned)*factor)::text "netDeferredChange" FROM expanded GROUP BY dimension,key,currency_id,currency_code,scale
),ranked AS(SELECT *,row_number() OVER(PARTITION BY dimension ORDER BY "currencyId",key NULLS FIRST) n FROM groups)
 SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "snapshotAt",(SELECT count(*)::integer FROM selected) events,
 CASE WHEN $17::boolean THEN jsonb_build_object('kind','tuition_attribution','invoices',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM(SELECT DISTINCT id FROM selected) sources),'[]'::jsonb),
  'recognitions',coalesce((SELECT jsonb_agg(recognition_id ORDER BY recognition_id) FROM(SELECT DISTINCT recognition_id FROM selected WHERE recognition_id IS NOT NULL) sources),'[]'::jsonb)) END "authorizationContext",
 coalesce((SELECT jsonb_object_agg(dimension,items) FROM(SELECT dimension,jsonb_agg(to_jsonb(r)-ARRAY['dimension','n'] ORDER BY "currencyId",key NULLS FIRST) items FROM ranked r WHERE n<=10001 GROUP BY dimension) x),'{}'::jsonb) series`;
export function tuitionIncomeReportStatement(ctx:ApiContext,q:z.infer<typeof tuitionIncomeQuery>,includeAuthorization=false){
 const scopes=attributionReportScopes(ctx,'finance.tuition-income');
 return {sql,parameters:[q.from,q.through,JSON.stringify(scopes.slice(0,2)),JSON.stringify(scopes.slice(1)),q.hubIds??null,q.classIds??null,q.studentIds??null,q.accountIds??null,q.billToIds??null,q.currencyIds??null,q.countryIds??null,q.regionIds??null,q.cityIds??null,ctx.credential.all_hubs,ctx.credential.hub_ids,q.recognition,includeAuthorization]};
}
export async function tuitionIncomeReport(ctx:ApiContext,includeAuthorization=false):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/tuition-income')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const p=new URL(ctx.request.url).searchParams;if([...p].length!==new Set(p.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=tuitionIncomeQuery.parse(Object.fromEntries(p));await lockAcademyTopology(ctx);
 const statement=tuitionIncomeReportStatement(ctx,q,includeAuthorization);
 const r=(await ctx.db.query<{snapshotAt:string;events:number;series:Record<string,Row[]>;authorizationContext:unknown}>(statement.sql,statement.parameters)).rows[0];assertTuitionIncomeBounds(r.events,Object.values(r.series).map(a=>a.length));
 const view=(row:Row)=>({key:row.key,currencyId:row.currencyId,currencyCode:row.currencyCode,unitScale:row.unitScale,documentEvents:row.documentEvents,earningEvents:row.earningEvents,sourceEvents:row.sourceEvents,...Object.fromEntries(measures.map(k=>[k,exact(row[k],row.unitScale)]))});
 const body={data:{report:'posted_tuition_invoice_attribution',snapshotAt:r.snapshotAt,filters:q,currencies:(r.series.total??[]).map(view),charts:Object.fromEntries(dimensions.map(d=>[d,(r.series[d]??[]).map(view)])),coverage:'complete_current_authorized_tuition_source_events_within_limits',sourceBasis:'pinned_tuition_terms_and_reviewed_recognition_workflow_events',dateBasis:'invoice_credit_issue_and_recognition_posting_dates',accountBasis:'original_invoice_consideration_account',recognitionFilterBasis:'original_invoice_policy',scopeMayOmitRecognitionEvents:true,geographyBasis:'current_hub_location',currencyConversion:'none',chargedTaxIsRevenue:false,paymentsIncluded:false,deferredBalanceDetermined:false,subsequentRecognitionJournalsIncluded:true,manualJournalsIncluded:false,otherIncomeIncluded:false,privateBodiesIncluded:false,profitDetermined:false,additionalLedgerPosting:false}};assertTuitionIncomeBounds(r.events,Object.values(r.series).map(a=>a.length),Buffer.byteLength(JSON.stringify(body)));return {status:200,body:includeAuthorization?{data:{...body.data,authorizationContext:attributionAuthorization.parse(r.authorizationContext)}}:body};
}
export const tuitionIncomeReportContract=[{path:'/api/v1/reports/finance/tuition-income',method:'get',summary:'Exact scoped tuition invoice/credit plus reviewed recognition/reversal attribution by student,class,hub,ORIGINAL invoice consideration account,original invoice policy,month and event. Original billings/tax stay separate from subsequent earned revenue,total recognized revenue and period net-deferred change;documents and earning events counted separately. All original and release account rights before counts/charts;receipt never creates income again. Not remaining deferred balance,all income or academy profit;10000source events/groups per dimension and4MiB bound.',querySchema:tuitionIncomeQuery}] as const;

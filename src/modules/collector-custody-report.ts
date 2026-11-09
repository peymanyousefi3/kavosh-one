import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,requireScope,type Capability } from '../core/policy.ts';
import { readMinorUnits,formatMoneyTotal } from '../core/money.ts';
import { csvRow,csvText } from '../core/csv.ts';
import { accountingDate } from './finance-periods.ts';
import { accountRow } from './finance.ts';
import { collectorRow } from './collectors.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const fields=z.object({collectorId:uuid,holdingAccountId:uuid,from:accountingDate,through:accountingDate,limit:z.coerce.number().int().min(1).max(100).default(50),afterDate:accountingDate.optional(),afterId:uuid.optional()}).strict();
const query=fields.refine(q=>q.from<=q.through&&Boolean(q.afterDate)===Boolean(q.afterId));
const exportQuery=fields.omit({limit:true,afterDate:true,afterId:true}).extend({limit:z.never().optional(),afterDate:z.never().optional(),afterId:z.never().optional()}).refine(q=>q.from<=q.through);
export const collectorCustodyEventLimit=200000;
const exportLimit=2000;
type Entry={journalId:string;postedOn:string;kind:string;correctionOfId:string|null;change:string;balance:string};
type Result={snapshotAt:string;sourceCount:number;entryCount:number;validRange:boolean;opening:string;increases:string;decreases:string;closing:string;unknownSources:number;entries:Entry[];days:{postedOn:string;change:string;balance:string}[]};
// One snapshot for opening,whole-window totals,chart and running balances.
// Select a single immutable currency bucket;never infer a counterparty from
// account names,or net a payable/loan/unassigned journal into collected tuition.
export const collectorCustodySQL=`WITH bucket AS MATERIALIZED(
 SELECT e.* FROM public.collector_fund_events e WHERE e.collector_id=$1 AND e.holding_account=$2 AND e.posted_on<=$4::date LIMIT ${collectorCustodyEventLimit+1}
),bound AS(SELECT count(*)::integer n FROM bucket),events AS MATERIALIZED(
 SELECT e.journal_id,e.posted_on,e.delta_minor,j.reverses_id,
 CASE WHEN r.id IS NOT NULL THEN 'tuition_receipt' WHEN m.id IS NOT NULL THEN 'remittance_'||m.direction WHEN p.id IS NOT NULL THEN 'noncash_offset' ELSE 'unknown' END||CASE WHEN j.reverses_id IS NULL THEN '' ELSE '_correction' END kind,
 sum(e.delta_minor) OVER(ORDER BY e.posted_on,e.journal_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) balance
 FROM bucket e CROSS JOIN bound b JOIN public.finance_journals j ON j.academy_id=e.academy_id AND j.id=e.journal_id
 LEFT JOIN public.tuition_receipts r ON r.academy_id=e.academy_id AND r.id=coalesce(j.reverses_id,j.id)
 LEFT JOIN public.collector_remittances m ON m.academy_id=e.academy_id AND m.id=coalesce(j.reverses_id,j.id)
 LEFT JOIN public.expense_payments p ON p.academy_id=e.academy_id AND p.id=coalesce(j.reverses_id,j.id) AND p.settlement_kind='collector_offset'
 WHERE b.n<=${collectorCustodyEventLimit}
),windowed AS MATERIALIZED(SELECT * FROM events WHERE posted_on>=$3::date),days AS(
 SELECT posted_on,sum(delta_minor) change FROM windowed GROUP BY posted_on
),daily AS(
 SELECT posted_on,change,coalesce((SELECT sum(delta_minor) FROM events WHERE posted_on<$3::date),0)+sum(change) OVER(ORDER BY posted_on) balance FROM days
),page AS(
 SELECT journal_id AS "journalId",posted_on::text AS "postedOn",kind,reverses_id AS "correctionOfId",delta_minor::text change,balance::text FROM windowed
 WHERE $5::date IS NULL OR(posted_on,journal_id)>($5::date,$6::uuid) ORDER BY posted_on,journal_id LIMIT $7
)
SELECT statement_timestamp()::text AS "snapshotAt",(SELECT n FROM bound) AS "sourceCount",(SELECT count(*)::integer FROM windowed) AS "entryCount",$4::date-$3::date<=3660 AS "validRange",
 coalesce((SELECT sum(delta_minor) FROM events WHERE posted_on<$3::date),0)::text opening,
 coalesce((SELECT sum(greatest(delta_minor,0)) FROM windowed),0)::text increases,coalesce((SELECT sum(greatest(-delta_minor,0)) FROM windowed),0)::text decreases,
 coalesce((SELECT sum(delta_minor) FROM events),0)::text closing,(SELECT count(*)::integer FROM events WHERE kind LIKE 'unknown%') AS "unknownSources",
 coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "postedOn","journalId") FROM page),'[]'::jsonb) entries,
 coalesce((SELECT jsonb_agg(jsonb_build_object('postedOn',posted_on::text,'change',change::text,'balance',balance::text) ORDER BY posted_on) FROM daily),'[]'::jsonb) days`;
async function read(ctx:ApiContext,complete=false){
 const search=new URL(ctx.request.url).searchParams;if([...search].length!==new Set(search.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const q=(complete?exportQuery:query).parse(Object.fromEntries(search)),c=await collectorRow(ctx,q.collectorId),a=await accountRow(ctx,q.holdingAccountId);
 for(const cap of ['financial-reports.view','ledger.view','remittances.view'] as Capability[])for(const hub of [c.hub_id,a.hubId])requireScope(permissionScope(ctx,cap),hub??undefined);
 if(c.custody!=='third_party'||a.operationalRole!=='collector_receivable'||(a.hubId!==null&&a.hubId!==c.hub_id))throw new ApiError(400,'COLLECTOR_CUSTODY_BUCKET_INVALID');
 const limit=complete?exportLimit:q.limit!,r=(await ctx.db.query<Result>(collectorCustodySQL,[c.id,a.id,q.from,q.through,q.afterDate??null,q.afterId??null,limit+1])).rows[0];
 if(!r.validRange)throw new ApiError(400,'REPORT_DATE_RANGE_TOO_LARGE');if(r.sourceCount>collectorCustodyEventLimit)throw new ApiError(422,'COLLECTOR_CUSTODY_REQUIRES_BACKGROUND_JOB');if(r.unknownSources)throw new ApiError(503,'COLLECTOR_CUSTODY_SOURCE_UNRECOGNIZED');if(complete&&r.entryCount>exportLimit)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');
 const exact=(s:string)=>({minor:readMinorUnits(s).toString(),amount:formatMoneyTotal(readMinorUnits(s),a.unitScale)}),{limit:_limit,afterDate:_afterDate,afterId:_afterId,...filters}=q;
 return {data:{report:'collector_custody_statement',snapshotAt:r.snapshotAt,filters,collectorId:c.id,holdingAccountId:a.id,currencyId:a.currencyId,currencyCode:a.currencyCode,unitScale:a.unitScale,opening:exact(r.opening),increases:exact(r.increases),decreases:exact(r.decreases),closing:exact(r.closing),entryCount:r.entryCount,sourceEventCount:r.sourceCount,entries:r.entries.slice(0,limit).map(e=>({...e,change:exact(e.change),balance:exact(e.balance)})),chartData:{days:r.days.map(d=>({...d,change:exact(d.change),balance:exact(d.balance)}))},coverage:'recorded_collector_custody_events_only',excludes:'unbilled_shares_payables_loans_opening_adjustments_and_unattributed_journals',balanceConvention:'positive_collector_owes_academy_negative_academy_owes_collector',ordering:'posted_day_then_immutable_journal_id_not_within_day_time',systemKnowledgeAsOf:'current_retained_records_not_a_past_system_snapshot',sourcePrivacy:'ledger_amounts_and_journal_ids_only_no_student_bill_evidence_or_authority_notes',permissionsRechecked:true,bankSettlementVerified:false,currencyConversion:'none',moneyMovementPerformed:false},nextCursor:r.entries.length>limit?{afterDate:r.entries[limit-1].postedOn,afterId:r.entries[limit-1].journalId}:null};
}
export async function collectorCustodyReport(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/collector-custody')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');return {status:200,body:await read(ctx)};
}
export async function completeCollectorCustodyExport(ctx:ApiContext,provenance?:unknown):Promise<Reply>{
 const {data:d,nextCursor}=await read(ctx,true);if(nextCursor||d.entries.length!==d.entryCount)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');
 const rows:(string|number|boolean|null)[][]=[['section','field','value','date','journal_id','kind','correction_of','minor','amount','balance_minor','balance_amount']];
 for(const field of ['report','snapshotAt','filters','collectorId','holdingAccountId','currencyId','currencyCode','unitScale','entryCount','coverage','excludes','balanceConvention','ordering','systemKnowledgeAsOf','sourcePrivacy','bankSettlementVerified','currencyConversion','moneyMovementPerformed'] as const)rows.push(['metadata',field,csvText(typeof d[field]==='string'?d[field]:JSON.stringify(d[field]))]);
 rows.push(['metadata','completeness','complete_selected_bucket_within_limits']);if(provenance)rows.push(['metadata','provenance',csvText(JSON.stringify(provenance))]);
 for(const field of ['opening','increases','decreases','closing'] as const)rows.push(['total',field,'','','','','',d[field].minor,d[field].amount]);
 for(const e of d.entries)rows.push(['event','','',e.postedOn,e.journalId,e.kind,e.correctionOfId,e.change.minor,e.change.amount,e.balance.minor,e.balance.amount]);
 for(const day of d.chartData.days)rows.push(['daily_chart','','',day.postedOn,'','','',day.change.minor,day.change.amount,day.balance.minor,day.balance.amount]);
 const body='\uFEFF'+rows.map(row=>csvRow(Array.from({length:11},(_,i)=>row[i]))).join('\r\n')+'\r\n';if(Buffer.byteLength(body)>4194304)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');return {status:200,body,csv:{filename:'collector-custody-'+d.filters.from+'-'+d.filters.through+'.csv'}};
}
export async function collectorCustodyExport(ctx:ApiContext):Promise<Reply|null>{if(ctx.path!=='reports/finance/collector-custody/export')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');return completeCollectorCustodyExport(ctx);}
export const collectorCustodyReportContract=[{path:'/api/v1/reports/finance/collector-custody',method:'get',summary:'Dated third-party collector custody statement: exact opening/movements/closing,running event balances and daily charts from one source snapshot. Requires collector/account,remittance,ledger and financial-report rights. Only ledger amounts/journal IDs;no student or private bill content. Not a full hub payable/loan statement;no guessed netting or FX. Bounded source fails closed rather than publishing partial totals.',querySchema:query}] as const;
export const collectorCustodyExportContract=[{path:'/api/v1/reports/finance/collector-custody/export',method:'get',summary:'Complete same-snapshot collector custody CSV with totals,every event,daily chart and explicit exclusions. No pagination inputs;2000event/4MiB export ceiling refuses partial files. Current original source permissions remain mandatory.',querySchema:exportQuery,responseContentType:'text/csv'}] as const;

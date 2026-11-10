import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { accountingDate } from './finance-periods.ts';
import { financialReportAccess,financialIds,financialAccountSelectionSQL } from './financial-reports.ts';
import { journalPointLookupSQL } from './finance-journals.ts';
import { formatMoneyTotal,readMinorUnits } from '../core/money.ts';
import { csvRow,csvText } from '../core/csv.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const query=z.object({from:accountingDate,through:accountingDate,hubIds:financialIds.optional(),currencyIds:financialIds.optional(),accountIds:financialIds.optional(),includeZero:z.enum(['true','false']).default('false').transform(v=>v==='true'),limit:z.coerce.number().int().min(1).max(100).default(50),afterCode:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/).optional(),afterId:uuid.optional()}).strict().refine(q=>q.from<=q.through&&Date.parse(q.through)-Date.parse(q.from)<=3660*86_400_000,'Choose an ordered interval of at most 3660 days.').refine(q=>(q.afterCode===undefined)===(q.afterId===undefined),'Provide both cursor fields.');
const keys=['openingBalance','openingAdjustments','closingAdjustments','receipts','payments','correctionReceipts','correctionPayments','internalReceipts','internalPayments','closingBalance'] as const;
const flows=keys.filter(k=>k!=='openingBalance'&&k!=='closingBalance');
const inWindow="posted_on>=$9::date",ordinary="purpose NOT IN('opening','closing')",external=`${ordinary} AND NOT internal`,predicates={openingBalance:'posted_on<$9::date',openingAdjustments:`${inWindow} AND purpose='opening'`,closingAdjustments:`${inWindow} AND purpose='closing'`,receipts:`${inWindow} AND ${external} AND reverses_id IS NULL AND side='debit'`,payments:`${inWindow} AND ${external} AND reverses_id IS NULL AND side='credit'`,correctionReceipts:`${inWindow} AND ${external} AND reverses_id IS NOT NULL AND side='debit'`,correctionPayments:`${inWindow} AND ${external} AND reverses_id IS NOT NULL AND side='credit'`,internalReceipts:`${inWindow} AND ${ordinary} AND internal AND side='debit'`,internalPayments:`${inWindow} AND ${ordinary} AND internal AND side='credit'`,closingBalance:'true'};
const signed=new Set(['openingBalance','openingAdjustments','closingAdjustments','closingBalance']);
const aggregates=keys.map(k=>`coalesce(sum(${signed.has(k)?"CASE side WHEN 'debit' THEN amount_minor ELSE -amount_minor END":'amount_minor'}) FILTER(WHERE ${predicates[k]}),0) AS "${k}"`).join(',');
// One MVCC snapshot; scoped account selection precedes balances, transfer
// elimination, totals and charts. Only a native, exactly linked transfer with
// BOTH permitted as-posted cash/bank legs is internal to this selection.
// ponytail: selected ledger history under the existing statement timeout;
// durable rollups/large export jobs are still needed beyond these report caps.
export const cashMovementSQL=`WITH selected AS MATERIALIZED (${financialAccountSelectionSQL}),source AS MATERIALIZED (
 SELECT l.account_id,j.id,j.posted_on,j.purpose,j.reverses_id,l.side,l.amount_minor,r.operational_role,
 EXISTS(SELECT 1 FROM public.finance_transfers t JOIN selected f ON f.id=t.from_account JOIN selected d ON d.id=t.to_account
  JOIN public.finance_account_revisions fr ON fr.academy_id=t.academy_id AND fr.account_id=t.from_account AND fr.version=t.from_version
  JOIN public.finance_account_revisions dr ON dr.academy_id=t.academy_id AND dr.account_id=t.to_account AND dr.version=t.to_version
  WHERE t.id=coalesce(j.reverses_id,j.id) AND fr.kind='asset' AND dr.kind='asset' AND fr.operational_role IN('cash','bank') AND dr.operational_role IN('cash','bank')) AS internal
 FROM selected s JOIN public.finance_journal_lines l ON l.account_id=s.id ${journalPointLookupSQL}
 JOIN public.finance_account_revisions r ON r.academy_id=l.academy_id AND r.account_id=l.account_id AND r.version=l.account_version
 WHERE j.posted_on<=$5::date AND r.kind='asset' AND r.operational_role IN('cash','bank','unclassified')
),cash AS MATERIALIZED(SELECT * FROM source WHERE operational_role IN('cash','bank')),amounts AS MATERIALIZED (
 SELECT account_id,${aggregates},count(*) FILTER(WHERE ${inWindow}) AS window_lines FROM cash GROUP BY account_id
),accounts AS MATERIALIZED (
 SELECT s.*,${keys.map(k=>`coalesce(m."${k}",0) AS "${k}"`).join(',')},coalesce(m.window_lines,0) AS window_lines
 FROM selected s LEFT JOIN amounts m ON m.account_id=s.id
 WHERE m.account_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.finance_account_revisions r WHERE r.account_id=s.id AND r.version=s.version AND r.kind='asset' AND r.operational_role IN('cash','bank'))
),normalized AS MATERIALIZED(SELECT a.*,max(unit_scale) OVER(PARTITION BY currency_id) AS scale FROM accounts a),totals AS (
 SELECT currency_id AS "currencyId",currency_code AS "currencyCode",scale AS "unitScale",${keys.map(k=>`sum("${k}"*('1'||repeat('0',scale-unit_scale))::numeric)::text AS "${k}"`).join(',')}
 FROM normalized GROUP BY currency_id,currency_code,scale
),monthly_amounts AS(
 SELECT c.*,s.currency_id,s.currency_code,s.unit_scale,n.scale,c.amount_minor*('1'||repeat('0',n.scale-s.unit_scale))::numeric AS normalized_minor
 FROM cash c JOIN selected s ON s.id=c.account_id JOIN (SELECT DISTINCT currency_id,scale FROM normalized) n ON n.currency_id=s.currency_id WHERE ${inWindow}
),months AS (
 SELECT to_char(posted_on,'YYYY-MM') AS month,currency_id AS "currencyId",currency_code AS "currencyCode",scale AS "unitScale",${keys.map(k=>`coalesce(sum(${signed.has(k)?"CASE side WHEN 'debit' THEN normalized_minor ELSE -normalized_minor END":'normalized_minor'}) FILTER(WHERE ${predicates[k]}),0)::text AS "${k}"`).join(',')}
 FROM monthly_amounts GROUP BY to_char(posted_on,'YYYY-MM'),currency_id,currency_code,scale
),shown AS MATERIALIZED(SELECT * FROM accounts WHERE $10::boolean OR window_lines>0 OR "openingBalance"<>0 OR "closingBalance"<>0),page AS(
 SELECT id AS "accountId",version AS "chartVersion",hub_id AS "hubId",code,name,translations,currency_id AS "currencyId",currency_code AS "currencyCode",unit_scale AS "unitScale",${keys.map(k=>`"${k}"::text AS "${k}"`).join(',')}
 FROM shown WHERE $11::text IS NULL OR(code,id)>($11,$12::uuid) ORDER BY code,id LIMIT $13
)
SELECT statement_timestamp()::text AS "snapshotAt",(SELECT count(*)::integer FROM shown) AS "accountCount",(SELECT count(*)::integer FROM totals) AS "currencyCount",(SELECT count(*)::integer FROM months) AS "monthCount",
 coalesce((SELECT jsonb_agg(DISTINCT hub_id) FROM selected),'[]'::jsonb) AS "authorizationHubs",
 (SELECT count(*)::text FROM source WHERE operational_role='unclassified' AND ${inWindow}) AS "unclassifiedAssetLineCount",
 (SELECT count(*)::text FROM cash WHERE purpose='legacy_unclassified' AND ${inWindow}) AS "legacyPurposeLineCount",
 coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY "currencyCode","currencyId") FROM(SELECT * FROM totals ORDER BY "currencyCode","currencyId" LIMIT 201)t),'[]'::jsonb) AS currencies,
 coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY month,"currencyCode","currencyId") FROM(SELECT * FROM months ORDER BY month,"currencyCode","currencyId" LIMIT 2001)m),'[]'::jsonb) AS months,
 coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY code,"accountId") FROM page p),'[]'::jsonb) AS entries`;
type Money={minor:string;amount:string};
type RawMetric=Record<typeof keys[number],string>&{unitScale:number};
function metrics(row:RawMetric){
 if(!Number.isInteger(row.unitScale)||row.unitScale<0||row.unitScale>18)throw new Error('CASH_MOVEMENT_SOURCE_INVALID');
 const values=Object.fromEntries(keys.map(k=>[k,readMinorUnits(row[k])])) as Record<typeof keys[number],bigint>;
 for(const key of ['receipts','payments','correctionReceipts','correctionPayments','internalReceipts','internalPayments'] as const)if(values[key]<0n)throw new Error('CASH_MOVEMENT_SOURCE_INVALID');
 const movement=values.openingAdjustments+values.closingAdjustments+values.receipts-values.payments+values.correctionReceipts-values.correctionPayments+values.internalReceipts-values.internalPayments;
 if(values.openingBalance+movement!==values.closingBalance)throw new Error('CASH_MOVEMENT_BRIDGE_INVALID');
 const exact=(n:bigint):Money=>({minor:n.toString(),amount:formatMoneyTotal(n,row.unitScale)});
 return {...Object.fromEntries(keys.map(k=>[k,exact(values[k])])) as Record<typeof keys[number],Money>,netMovement:exact(movement),balanced:true};
}
export async function cashMovements(ctx:ApiContext,exportLimit?:number):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/cash-movements')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const access=financialReportAccess(ctx),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params));if(exportLimit!==undefined){if(!Number.isInteger(exportLimit)||exportLimit<1||exportLimit>10000)throw new Error('INVALID_EXPORT_LIMIT');q.limit=exportLimit;}
 const result=(await ctx.db.query<{snapshotAt:string;authorizationHubs:(string|null)[];accountCount:number;currencyCount:number;monthCount:number;unclassifiedAssetLineCount:string;legacyPurposeLineCount:string;currencies:(RawMetric&{currencyId:string;currencyCode:string})[];months:(RawMetric&{month:string;currencyId:string;currencyCode:string})[];entries:(RawMetric&{accountId:string;chartVersion:number;hubId:string|null;code:string;name:string;translations:Record<string,string>;currencyId:string;currencyCode:string})[]}>(cashMovementSQL,[access.all,access.hubs,access.excluded,access.global,q.through,q.hubIds??null,q.currencyIds??null,q.accountIds??null,q.from,q.includeZero,q.afterCode??null,q.afterId??null,q.limit+1])).rows[0];
 if(!result||result.currencyCount>200||result.monthCount>2000)throw new ApiError(409,'REPORT_REQUIRES_NARROWER_FILTER');
 if([result.accountCount,result.currencyCount,result.monthCount].some(n=>!Number.isInteger(n)||n<0)||result.currencyCount!==result.currencies.length||result.monthCount!==result.months.length||result.entries.length>q.limit+1||result.accountCount<result.entries.length)throw new Error('CASH_MOVEMENT_SOURCE_INVALID');
 const byCurrency=new Map(result.currencies.map(c=>[c.currencyId,c]));if(byCurrency.size!==result.currencies.length||result.currencies.some(c=>!Number.isInteger(c.unitScale)||c.unitScale<0||c.unitScale>18))throw new Error('CASH_MOVEMENT_SOURCE_INVALID');
 const chartSums=new Map<string,Record<string,bigint>>(),chartKeys=new Set<string>();
 for(const month of result.months){const currency=byCurrency.get(month.currencyId),key=month.currencyId+':'+month.month;if(!currency||currency.currencyCode!==month.currencyCode||currency.unitScale!==month.unitScale||!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month.month)||chartKeys.has(key))throw new Error('CASH_MOVEMENT_SOURCE_INVALID');chartKeys.add(key);const sums=chartSums.get(month.currencyId)??{};for(const field of flows)sums[field]=(sums[field]??0n)+readMinorUnits(month[field]);chartSums.set(month.currencyId,sums);}
 for(const currency of result.currencies)for(const field of flows)if((chartSums.get(currency.currencyId)?.[field]??0n)!==readMinorUnits(currency[field]))throw new Error('CASH_MOVEMENT_SOURCE_INVALID');
 if(!q.afterId&&result.entries.length===result.accountCount){
  const sums=new Map<string,Record<string,bigint>>(),accountIds=new Set<string>();
  for(const entry of result.entries){const currency=byCurrency.get(entry.currencyId);if(!currency||currency.currencyCode!==entry.currencyCode||!Number.isInteger(entry.unitScale)||entry.unitScale<0||entry.unitScale>currency.unitScale||accountIds.has(entry.accountId))throw new Error('CASH_MOVEMENT_SOURCE_INVALID');accountIds.add(entry.accountId);const sum=sums.get(entry.currencyId)??{},factor=10n**BigInt(currency.unitScale-entry.unitScale);for(const field of keys)sum[field]=(sum[field]??0n)+readMinorUnits(entry[field])*factor;sums.set(entry.currencyId,sum);}
  for(const currency of result.currencies)for(const field of keys)if((sums.get(currency.currencyId)?.[field]??0n)!==readMinorUnits(currency[field]))throw new Error('CASH_MOVEMENT_SOURCE_INVALID');
 }
 const complete=access.global&&!q.hubIds&&!q.accountIds,next=result.entries.length>q.limit?result.entries[q.limit-1]:null;
 const values=<T extends RawMetric>(r:T)=>({...Object.fromEntries(Object.entries(r).filter(([k])=>!keys.includes(k as typeof keys[number]))),...metrics(r)});
 return {status:200,body:{data:{report:'posted_cash_movements',from:q.from,through:q.through,snapshotAt:result.snapshotAt,classificationBasis:'as_posted_asset_cash_bank_roles',labelBasis:'current_account_metadata',transferTreatment:'only_native_linked_two_cash_legs_inside_selected_scope',basis:'posted_ledger_not_bank_verified',incomeDetermined:false,profitDetermined:false,formalCashFlowStatement:false,operatingInvestingFinancingClassification:false,currencyConversion:'none',coverage:complete?'complete_selected_currencies':'scoped_selected_accounts',scopeMayOmitCounterparties:!complete,...(exportLimit===undefined?{}:{authorizationContext:{hubIds:result.authorizationHubs.filter((h):h is string=>h!==null),includesGlobal:result.authorizationHubs.includes(null)}}),unclassifiedAssetLineCount:result.unclassifiedAssetLineCount,legacyPurposeLineCount:result.legacyPurposeLineCount,requiresClassificationReview:result.unclassifiedAssetLineCount!=='0'||result.legacyPurposeLineCount!=='0',accountCount:result.accountCount,currencies:result.currencies.map(values),charts:{monthlyMovements:result.months.map(r=>{const v=values(r);return {month:r.month,currencyId:r.currencyId,currencyCode:r.currencyCode,unitScale:r.unitScale,...Object.fromEntries(([...flows,'netMovement'] as const).map(k=>[k,v[k]]))};})},entries:result.entries.slice(0,q.limit).map(values)},nextCursor:next?{afterCode:next.code,afterId:next.accountId}:null}};
}
export async function completeCashMovementReport(ctx:ApiContext,entryLimit=2000){
 const url=new URL(ctx.request.url);for(const key of ['limit','afterCode','afterId'])url.searchParams.delete(key);
 const reply=await cashMovements({...ctx,path:'reports/finance/cash-movements',request:new Request(url)},entryLimit),body=reply!.body as {data:Record<string,any>;nextCursor:unknown};
 if(body.nextCursor||body.data.entries.length!==body.data.accountCount||body.data.entries.length>entryLimit)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');return body.data;
}
export function cashMovementCsv(data:Record<string,any>,provenance?:{id?:string;version?:number;dateWindow?:unknown;scheduledOccurrence?:unknown;retryOfJobId?:string}):Reply{
 if(data.report!=='posted_cash_movements'||!Number.isInteger(data.accountCount)||data.entries.length!==data.accountCount)throw new Error('CASH_MOVEMENT_INCOMPLETE');const body={data};
 // Version2 keeps totals/month rows and their original columns, but writes
 // each account ONCE with exact metric columns,not eleven repeated UUID/name
 // rows. This reduces bytes/cells and keeps useful archives Excel-convertible.
 const metricKeys=[...keys,'netMovement'] as const,header=['section','field','value','account_id','account_code','account_name','currency_id','currency_code','unit_scale','month','amount_minor','amount',...metricKeys.flatMap(k=>[k+'_minor',k+'_amount'])],rows:string[][]=[];
 const add=(section:string,field:string,value:string,entry:Record<string,any>={},money?:Money)=>rows.push([section,field,csvText(value),entry.accountId??'',csvText(entry.code??''),csvText(entry.name??''),entry.currencyId??'',csvText(entry.currencyCode??''),String(entry.unitScale??''),entry.month??'',money?.minor??'',money?.amount??'',...metricKeys.flatMap(key=>{if(section!=='account')return ['',''];const m=entry[key] as Money|undefined;if(!m||typeof m.minor!=='string'||typeof m.amount!=='string')throw new Error('CASH_MOVEMENT_MONEY_MISSING');return [m.minor,m.amount];})]);
 for(const [key,value]of Object.entries(body.data))if(!['entries','currencies','charts','authorizationContext'].includes(key))add('metadata',key,String(value));
 add('metadata','exportCompleteness','complete_permitted_report_within_limits');add('metadata','numericPrecisionPolicy','money_minor_units_and_amounts_are_exact_strings');
 add('metadata','exportSchemaVersion','2');add('metadata','accountRowLayout','one_account_per_row_with_exact_metric_columns');
 if(provenance?.id)add('metadata','presetId',provenance.id);if(provenance?.version!==undefined)add('metadata','presetVersion',String(provenance.version));if(provenance?.dateWindow!==undefined)add('metadata','dateWindow',JSON.stringify(provenance.dateWindow));
 if(provenance?.scheduledOccurrence!==undefined)add('metadata','scheduledOccurrence',JSON.stringify(provenance.scheduledOccurrence));if(provenance?.retryOfJobId!==undefined)add('metadata','retryOfJobId',provenance.retryOfJobId);
 for(const entry of body.data.entries)add('account','','',entry);
 for(const [section,entries]of [['currency_total',body.data.currencies],['month',body.data.charts.monthlyMovements]] as const)for(const entry of entries)for(const key of metricKeys)if(entry[key])add(section,key,'',entry,entry[key]);
 const csv='\uFEFF'+[header,...rows].map(csvRow).join('\r\n')+'\r\n';if(Buffer.byteLength(csv)>4_194_304)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');return {status:200,body:csv,csv:{filename:'cash-movements.csv'}};
}
export async function cashMovementExport(ctx:ApiContext,provenance?:{id?:string;version?:number;dateWindow?:unknown}):Promise<Reply>{return cashMovementCsv(await completeCashMovementReport(ctx),provenance);}
export async function cashMovementExports(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/cash-movements/export')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=Object.fromEntries(new URL(ctx.request.url).searchParams);if(['limit','afterCode','afterId'].some(k=>k in q))throw new ApiError(400,'INVALID_QUERY');return cashMovementExport(ctx);
}
export const cashMovementsContract=[{path:'/api/v1/reports/finance/cash-movements',method:'get',summary:'Same-snapshot exact posted cash/bank movement bridge,opening/closing adjustments,ordinary receipts/payments,corrections,scoped native transfers and monthly chart values. Loan proceeds are not labelled income. As-posted cash roles only;unknown asset roles warn,not guessed. Not bank verification or a formal operating/investing/financing cash-flow statement. Maximum3660days,200currencies,2000monthly points;no silent truncation.',querySchema:query}] as const;
export const cashMovementExportContract=[{...cashMovementsContract[0],path:cashMovementsContract[0].path+'/export',querySchema:(query as z.ZodObject).safeExtend({limit:z.never().optional(),afterCode:z.never().optional(),afterId:z.never().optional()}),summary:'Complete permitted cash movement CSV schema2(one account row with exact metric columns;original total/month columns retained),not one screen page;2000account/4MiB limits fail without partial output. Exact strings,separate currencies,current source permissions and all bridge/review warnings retained.',responseContentType:'text/csv' as const}];

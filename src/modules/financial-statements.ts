import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { formatMoneyTotal,readMinorUnits } from '../core/money.ts';
import { accountingDate } from './finance-periods.ts';
import { financialReportAccess,financialIds,financialKinds,financialAccountSelectionSQL } from './financial-reports.ts';
import { journalPointLookupSQL } from './finance-journals.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const fields={through:accountingDate,hubIds:financialIds.optional(),currencyIds:financialIds.optional(),accountIds:financialIds.optional(),limit:z.coerce.number().int().min(1).max(100).default(50),
  afterKind:z.enum(financialKinds).optional(),afterCode:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/).optional(),afterId:uuid.optional()};
const paired=(v:{afterKind?:string;afterCode?:string;afterId?:string})=>[v.afterKind,v.afterCode,v.afterId].filter(v=>v!==undefined).length%3===0;
const profitQuery=z.object({...fields,from:accountingDate}).strict().refine(v=>v.from<=v.through).refine(paired,'Provide all three cursor fields together.');
const sheetQuery=z.object(fields).strict().refine(paired,'Provide all three cursor fields together.');
type Kind=typeof financialKinds[number];
type Entry={accountId:string;chartVersion:number;hubId:string|null;code:string;name:string;translations:Record<string,string>;kind:Kind;currentKind:Kind;currencyId:string;currencyVersion:number;currencyCode:string;unitScale:number;debitNetMinor:string;sort:number};
type Total={currencyId:string;currencyCode:string;unitScale:number;assetMinor:string;liabilityMinor:string;equityMinor:string;incomeMinor:string;expenseMinor:string};
export const financialStatementSQL=`WITH selected AS MATERIALIZED (${financialAccountSelectionSQL}),movements AS (
 SELECT s.*,m.posted_kind,m.debit_net_minor,m.unclassified_lines FROM selected s CROSS JOIN LATERAL (
  SELECT r.kind AS posted_kind,sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END) AS debit_net_minor,
   count(*) FILTER(WHERE j.purpose='legacy_unclassified') AS unclassified_lines
  FROM public.finance_journal_lines l ${journalPointLookupSQL}
  JOIN public.finance_account_revisions r ON r.academy_id=l.academy_id AND r.account_id=l.account_id AND r.version=l.account_version
  WHERE l.account_id=s.id AND j.posted_on<=$5::date AND ($9::date IS NULL OR j.posted_on>=$9) AND ($10::boolean OR(r.kind IN ('income','expense') AND j.purpose IN ('activity','legacy_unclassified'))) GROUP BY r.kind
 ) m
),shown AS (
 SELECT m.*,CASE posted_kind WHEN 'asset' THEN 0 WHEN 'liability' THEN 1 WHEN 'equity' THEN 2 WHEN 'income' THEN 3 ELSE 4 END AS sort
 FROM movements m WHERE debit_net_minor<>0
),normalized AS (
 SELECT b.*,max(unit_scale) OVER(PARTITION BY currency_id) AS scale FROM shown b
),weighted AS (
 SELECT n.*,debit_net_minor*('1'||repeat('0',scale-unit_scale))::numeric AS normalized_minor FROM normalized n
),totals AS (
 SELECT currency_id AS "currencyId",currency_code AS "currencyCode",scale AS "unitScale",
  coalesce(sum(normalized_minor) FILTER(WHERE posted_kind='asset'),0)::text AS "assetMinor",
  coalesce(sum(-normalized_minor) FILTER(WHERE posted_kind='liability'),0)::text AS "liabilityMinor",
  coalesce(sum(-normalized_minor) FILTER(WHERE posted_kind='equity'),0)::text AS "equityMinor",
  coalesce(sum(-normalized_minor) FILTER(WHERE posted_kind='income'),0)::text AS "incomeMinor",
  coalesce(sum(normalized_minor) FILTER(WHERE posted_kind='expense'),0)::text AS "expenseMinor"
 FROM weighted GROUP BY currency_id,currency_code,scale
),page AS (
 SELECT id AS "accountId",version AS "chartVersion",hub_id AS "hubId",code,name,translations,posted_kind AS kind,kind AS "currentKind",
  currency_id AS "currencyId",currency_version AS "currencyVersion",currency_code AS "currencyCode",unit_scale AS "unitScale",debit_net_minor::text AS "debitNetMinor",sort
 FROM shown WHERE $11::integer IS NULL OR(sort,code,id)>($11::integer,$12::text,$13::uuid) ORDER BY sort,code,id LIMIT $14
)
SELECT statement_timestamp()::text AS "snapshotAt",(SELECT coalesce(sum(unclassified_lines),0)::text FROM movements) AS "unclassifiedLineCount",(SELECT count(DISTINCT id)::integer FROM shown) AS "accountCount",(SELECT count(*)::integer FROM shown) AS "rowCount",
 coalesce((SELECT jsonb_agg(to_jsonb(totals) ORDER BY "currencyCode","currencyId") FROM totals),'[]'::jsonb) AS currencies,
 coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY sort,code,"accountId") FROM page),'[]'::jsonb) AS entries`;
function exact(value:bigint,scale:number){return {minor:value.toString(),amount:formatMoneyTotal(value,scale)};}
export async function financialStatements(ctx:ApiContext,exportEntryLimit?:number):Promise<Reply|null>{
  const match=/^reports\/finance\/(profit-loss|balance-sheet)$/.exec(ctx.path);if(!match)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  const sheet=match[1]==='balance-sheet',access=financialReportAccess(ctx),q=(sheet?sheetQuery:profitQuery).parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),from='from' in q?q.from:null;
  if(exportEntryLimit!==undefined){if(!Number.isInteger(exportEntryLimit)||exportEntryLimit<1||exportEntryLimit>10000)throw new Error('INVALID_REPORT_EXPORT_LIMIT');q.limit=exportEntryLimit;}
  // Classify using each line's immutable account revision, not today's chart
  // kind. One account can legitimately have multiple as-posted kind groups.
  const result=(await ctx.db.query<{snapshotAt:string;unclassifiedLineCount:string;accountCount:number;rowCount:number;currencies:Total[];entries:Entry[]}>(financialStatementSQL,[access.all,access.hubs,access.excluded,access.global,q.through,q.hubIds??null,q.currencyIds??null,q.accountIds??null,from,sheet,q.afterKind===undefined?null:financialKinds.indexOf(q.afterKind),q.afterCode??null,q.afterId??null,q.limit+1])).rows[0];
  const currencies=result.currencies.map(c=>{
    const income=readMinorUnits(c.incomeMinor),expenses=readMinorUnits(c.expenseMinor),net=income-expenses,base={currencyId:c.currencyId,currencyCode:c.currencyCode,unitScale:c.unitScale};
    if(!sheet)return {...base,income:exact(income,c.unitScale),expenses:exact(expenses,c.unitScale),netResult:exact(net,c.unitScale)};
    const assets=readMinorUnits(c.assetMinor),liabilities=readMinorUnits(c.liabilityMinor),equity=readMinorUnits(c.equityMinor),rhs=liabilities+equity+net;
    return {...base,assets:exact(assets,c.unitScale),liabilities:exact(liabilities,c.unitScale),equity:exact(equity,c.unitScale),unclosedPostedResult:exact(net,c.unitScale),liabilitiesEquityAndResult:exact(rhs,c.unitScale),difference:exact(assets-rhs,c.unitScale),balanced:assets===rhs};
  });
  const next=result.entries.length>q.limit?result.entries[q.limit-1]:null,complete=access.global&&!q.hubIds&&!q.accountIds;
  return {status:200,body:{data:{report:sheet?'posted_balance_sheet':'posted_profit_loss',from,through:q.through,snapshotAt:result.snapshotAt,postingBasis:sheet?'all_posted_account_lines':'posted_operating_activity',journalPurposeTreatment:sheet?'all_posted_purposes':'activity_and_legacy_excluding_opening_closing',unclassifiedLineCount:result.unclassifiedLineCount,requiresPurposeReview:result.unclassifiedLineCount!=='0',classificationBasis:'as_posted_account_revision',labelBasis:'current_account_metadata',currencyConversion:'none',
    coverage:complete?'complete_selected_currencies':'scoped_selected_accounts',scopeMayOmitCounterparties:!complete,accountCount:result.accountCount,rowCount:result.rowCount,currencies,
    entries:result.entries.slice(0,q.limit).map(({sort,debitNetMinor,...a})=>{const net=readMinorUnits(debitNetMinor),section=sheet?(a.kind==='asset'?'assets':a.kind==='liability'?'liabilities':a.kind==='equity'?'equity':'unclosed_result'):(a.kind==='income'?'income':'expenses');
      const value=sheet?(a.kind==='asset'?net:-net):(a.kind==='income'?-net:net);return {...a,section,debitNet:exact(net,a.unitScale),amount:exact(value,a.unitScale)};})},
    nextCursor:next?{afterKind:next.kind,afterCode:next.code,afterId:next.accountId}:null}};
}
export const financialStatementsContract=[
  {path:'/api/v1/reports/finance/profit-loss',method:'get',summary:'Exact operating income, expense and net result excluding opening/closing entries; legacy unclassified lines stay included with scoped review warnings, not certified statements',querySchema:profitQuery},
  {path:'/api/v1/reports/finance/balance-sheet',method:'get',summary:'Exact posted assets, liabilities, equity and explicitly unclosed posted result at a date; per-currency equation checks and scope limitations, not invented closing entries or FX',querySchema:sheetQuery}
] as const;

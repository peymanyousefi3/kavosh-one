import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { formatMoneyTotal,readMinorUnits } from '../core/money.ts';
import { accountingDate } from './finance-periods.ts';
import { journalPointLookupSQL } from './finance-journals.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),kinds=['asset','liability','equity','income','expense'] as const;
const ids=z.string().max(8000).transform(v=>v.split(',')).pipe(z.array(uuid).min(1).max(200)).refine(v=>new Set(v).size===v.length,'Select each record once.').describe('Comma-separated unique UUIDs, at most 200 records; selecting records never grants access.');
const query=z.object({through:accountingDate,hubIds:ids.optional(),currencyIds:ids.optional(),accountIds:ids.optional(),includeZero:z.enum(['true','false']).default('false').transform(v=>v==='true'),
  limit:z.coerce.number().int().min(1).max(100).default(50),afterKind:z.enum(kinds).optional(),afterCode:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/).optional(),afterId:uuid.optional()}).strict()
  .refine(v=>[v.afterKind,v.afterCode,v.afterId].filter(v=>v!==undefined).length%3===0,'Provide all three cursor fields together.');
type Entry={accountId:string;chartVersion:number;hubId:string|null;code:string;name:string;translations:Record<string,string>;kind:typeof kinds[number];normalBalance:'debit'|'credit';currencyId:string;currencyVersion:number;currencyCode:string;unitScale:number;closingMinor:string;sort:number};
type CurrencyTotal={currencyId:string;currencyCode:string;unitScale:number;debitMinor:string;creditMinor:string};
function authority(ctx:ApiContext){
  const scopes=(['financial-reports.view','ledger.view','accounts.view'] as const).map(cap=>permissionScope(ctx,cap));
  if(scopes.some(s=>!scopeNonempty(s)))throw new ApiError(403,'FORBIDDEN');
  const all=scopes.every(s=>s.all),excluded=[...new Set(scopes.flatMap(s=>s.excludedHubs??[]))];
  const hubs=all?[]:scopes.find(s=>!s.all)!.hubs.filter(h=>scopes.every(s=>(s.all||s.hubs.includes(h))&&!s.excludedHubs?.includes(h)));
  const global=all&&!excluded.length&&!scopes.some(s=>s.excludedAreas?.length);
  return {all,hubs,excluded,global};
}
export const financialAccountSelectionSQL=`SELECT a.id,a.version,a.hub_id,a.code,a.name,a.translations,a.kind,a.normal_balance,a.currency_id,a.currency_version,a.currency_code,a.unit_scale
 FROM public.finance_account_catalogue a
 WHERE ((a.hub_id IS NULL AND $4::boolean) OR(a.hub_id IS NOT NULL AND ($1::boolean OR a.hub_id=ANY($2::uuid[])) AND NOT a.hub_id=ANY($3::uuid[])))
  AND ($6::uuid[] IS NULL OR a.hub_id=ANY($6)) AND ($7::uuid[] IS NULL OR a.currency_id=ANY($7)) AND ($8::uuid[] IS NULL OR a.id=ANY($8))`;
// Correlated aggregation reads each account's indexed entries. Joining a
// separately grouped CTE let native PostgreSQL rescan that aggregate 5,000
// times on fresh statistics (12.5 million rejected pairs at 5,000 accounts).
export const trialBalanceSQL=`WITH selected AS MATERIALIZED (${financialAccountSelectionSQL}),balances AS (
 SELECT s.*,coalesce(l.closing_minor,0) AS closing_minor FROM selected s CROSS JOIN LATERAL (
  SELECT sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END) AS closing_minor
  FROM public.finance_journal_lines l ${journalPointLookupSQL}
  WHERE l.account_id=s.id AND j.posted_on<=$5::date
 ) l
),shown AS (
 SELECT b.*,CASE kind WHEN 'asset' THEN 0 WHEN 'liability' THEN 1 WHEN 'equity' THEN 2 WHEN 'income' THEN 3 ELSE 4 END AS sort
 FROM balances b WHERE $9::boolean OR closing_minor<>0
),normalized AS (
 SELECT s.*,max(unit_scale) OVER(PARTITION BY currency_id) AS scale FROM shown s
),currency_totals AS (
 SELECT b.currency_id AS "currencyId",b.currency_code AS "currencyCode",b.scale AS "unitScale",
  sum(greatest(b.closing_minor,0)*('1'||repeat('0',b.scale-b.unit_scale))::numeric)::text AS "debitMinor",
  sum(greatest(-b.closing_minor,0)*('1'||repeat('0',b.scale-b.unit_scale))::numeric)::text AS "creditMinor"
 FROM normalized b GROUP BY b.currency_id,b.currency_code,b.scale
),page AS (
 SELECT id AS "accountId",version AS "chartVersion",hub_id AS "hubId",code,name,translations,kind,normal_balance AS "normalBalance",
  currency_id AS "currencyId",currency_version AS "currencyVersion",currency_code AS "currencyCode",unit_scale AS "unitScale",closing_minor::text AS "closingMinor",sort
 FROM shown WHERE $10::integer IS NULL OR(sort,code,id)>($10::integer,$11::text,$12::uuid) ORDER BY sort,code,id LIMIT $13
)
SELECT statement_timestamp()::text AS "snapshotAt",(SELECT count(*)::integer FROM shown) AS "accountCount",
 coalesce((SELECT jsonb_agg(to_jsonb(currency_totals) ORDER BY "currencyCode","currencyId") FROM currency_totals),'[]'::jsonb) AS currencies,
 coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY sort,code,"accountId") FROM page),'[]'::jsonb) AS entries`;
function exact(minor:bigint,scale:number){return {minor:minor.toString(),amount:formatMoneyTotal(minor,scale)};}
export async function financialReports(ctx:ApiContext):Promise<Reply|null>{
  if(ctx.path!=='reports/finance/trial-balance')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  const access=authority(ctx),q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  // Account rights intersect report and ledger rights before both totals and
  // pagination. Never infer a whole-school balance from a narrower hub view.
  const result=(await ctx.db.query<{snapshotAt:string;accountCount:number;currencies:CurrencyTotal[];entries:Entry[]}>(trialBalanceSQL,[access.all,access.hubs,access.excluded,access.global,q.through,q.hubIds??null,q.currencyIds??null,q.accountIds??null,q.includeZero,q.afterKind===undefined?null:kinds.indexOf(q.afterKind),q.afterCode??null,q.afterId??null,q.limit+1])).rows[0];
  const currencies=result.currencies.map(c=>{const debit=readMinorUnits(c.debitMinor),credit=readMinorUnits(c.creditMinor);return {currencyId:c.currencyId,currencyCode:c.currencyCode,unitScale:c.unitScale,debit:exact(debit,c.unitScale),credit:exact(credit,c.unitScale),difference:exact(debit-credit,c.unitScale),balanced:debit===credit};});
  const next=result.entries.length>q.limit?result.entries[q.limit-1]:null,complete=access.global&&!q.hubIds&&!q.accountIds;
  return {status:200,body:{data:{report:'posted_trial_balance',through:q.through,snapshotAt:result.snapshotAt,postingBasis:'all_posted_account_lines',chartBasis:'current_account_metadata',currencyConversion:'none',
    coverage:complete?'complete_selected_currencies':'scoped_selected_accounts',scopeMayOmitCounterparties:!complete,accountCount:result.accountCount,currencies,
    entries:result.entries.slice(0,q.limit).map(({sort,closingMinor,...a})=>{const minor=readMinorUnits(closingMinor);return {...a,closing:exact(minor,a.unitScale),debit:exact(minor>0n?minor:0n,a.unitScale),credit:exact(minor<0n?-minor:0n,a.unitScale)};})},
    nextCursor:next?{afterKind:next.kind,afterCode:next.code,afterId:next.accountId}:null}};
}
export const financialReportsContract=[{path:'/api/v1/reports/finance/trial-balance',method:'get',summary:'Same-snapshot posted trial balance with intersected account/ledger/report rights, exact per-currency totals and explicit scoped coverage; not financial certification or FX conversion',querySchema:query}] as const;
export { authority as financialReportAccess,ids as financialIds,kinds as financialKinds };

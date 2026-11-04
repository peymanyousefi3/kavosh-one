import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,requireScope } from '../core/policy.ts';
import { formatMoneyTotal,readMinorUnits,maximumMinorUnits } from '../core/money.ts';
import { journalPointLookupSQL } from './finance-journals.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),snapshot:hash.optional(),afterCode:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,31}$/).optional(),afterId:uuid.optional(),afterKind:z.enum(['income','expense']).optional()}).strict()
 .refine(q=>[q.afterCode,q.afterId,q.afterKind].filter(v=>v!==undefined).length%3===0,'Provide all three cursor fields together.')
 .refine(q=>q.afterId===undefined||q.snapshot!==undefined,'A closing-source cursor requires its snapshot.');
export type Entry={accountId:string;chartVersion:number;hubId:string|null;code:string;name:string;translations:Record<string,string>;postedKind:'income'|'expense';currentKind:string;active:boolean;currencyId:string;currencyVersion:number;currencyCode:string;unitScale:number;netMinor:string};
type Currency={currencyId:string;currencyCode:string;unitScale:number;debitMinor:string;creditMinor:string};
export type Source={periodId:string;periodVersion:number;periodState:string;startsOn:string;through:string;activeCloseThrough:string|null;snapshotAt:string;sourceJournalCount:string;chartVersionSum:string;periodVersionSum:string;sourceLineCount:string;unclassifiedLineCount:string;inactiveGroups:string;reclassifiedGroups:string;otherOpenPeriodCount:string;temporaryGroupCount:string;entries:Entry[];currencies:Currency[]};
// This is a source-validation report, not a write/close or proof of certified
// accounts. All counters, amounts and the page are read in one SQL snapshot.
export const closingSourceSQL=`WITH p AS MATERIALIZED(SELECT id,version,state,starts_on,ends_on FROM public.finance_periods WHERE id=$1),positions AS MATERIALIZED(
 SELECT a.id,a.version,a.hub_id,a.code,a.name,a.translations,a.kind,a.active,a.currency_id,a.currency_version,a.currency_code,a.unit_scale,m.*
 FROM public.finance_account_catalogue a CROSS JOIN LATERAL(
  SELECT r.kind AS posted_kind,sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END) AS net_minor,
   count(*) AS source_lines,count(*) FILTER(WHERE j.purpose='legacy_unclassified') AS legacy_lines
  FROM public.finance_journal_lines l ${journalPointLookupSQL}
  JOIN public.finance_account_revisions r ON r.academy_id=l.academy_id AND r.account_id=l.account_id AND r.version=l.account_version
  WHERE l.academy_id=a.academy_id AND l.account_id=a.id AND j.posted_on<=(SELECT ends_on FROM p) GROUP BY r.kind
 ) m
),targets AS(SELECT * FROM positions WHERE posted_kind IN ('income','expense') AND net_minor<>0),normalized AS(
 SELECT x.*,max(unit_scale) OVER(PARTITION BY currency_id) AS scale FROM positions x
),totals AS(
 SELECT currency_id AS "currencyId",currency_code AS "currencyCode",scale AS "unitScale",
  sum(greatest(net_minor,0)*('1'||repeat('0',scale-unit_scale))::numeric)::text AS "debitMinor",
  sum(greatest(-net_minor,0)*('1'||repeat('0',scale-unit_scale))::numeric)::text AS "creditMinor"
 FROM normalized GROUP BY currency_id,currency_code,scale
),page AS(
 SELECT id AS "accountId",version AS "chartVersion",hub_id AS "hubId",code,name,translations,posted_kind AS "postedKind",kind AS "currentKind",active,
  currency_id AS "currencyId",currency_version AS "currencyVersion",currency_code AS "currencyCode",unit_scale AS "unitScale",net_minor::text AS "netMinor"
 FROM targets WHERE $2::text IS NULL OR(code,id,posted_kind)>($2::text,$3::uuid,$4::text) ORDER BY code,id,posted_kind LIMIT $5
)
SELECT p.id AS "periodId",p.version AS "periodVersion",p.state AS "periodState",p.starts_on::text AS "startsOn",p.ends_on::text AS through,statement_timestamp()::text AS "snapshotAt",
 (SELECT max(ends_on)::text FROM public.finance_periods WHERE active_closing_run_id IS NOT NULL AND state='closed') AS "activeCloseThrough",
 (SELECT count(*)::text FROM public.finance_journals j WHERE j.posted_on<=p.ends_on) AS "sourceJournalCount",
 (SELECT coalesce(sum(version),0)::text FROM public.finance_accounts) AS "chartVersionSum",
 (SELECT coalesce(sum(version),0)::text FROM public.finance_periods) AS "periodVersionSum",
 (SELECT coalesce(sum(source_lines),0)::text FROM positions) AS "sourceLineCount",(SELECT coalesce(sum(legacy_lines),0)::text FROM positions) AS "unclassifiedLineCount",
 (SELECT count(*)::text FROM targets WHERE NOT active) AS "inactiveGroups",(SELECT count(*)::text FROM targets WHERE posted_kind<>kind) AS "reclassifiedGroups",
 (SELECT count(*)::text FROM public.finance_periods o WHERE o.id<>p.id AND o.state='open' AND o.starts_on<=p.ends_on) AS "otherOpenPeriodCount",
 (SELECT count(*)::text FROM targets) AS "temporaryGroupCount",
 coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY code,"accountId","postedKind") FROM page),'[]'::jsonb) AS entries,
 coalesce((SELECT jsonb_agg(to_jsonb(totals) ORDER BY "currencyCode","currencyId") FROM totals),'[]'::jsonb) AS currencies FROM p`;
const exact=(minor:bigint,scale:number)=>({minor:minor.toString(),amount:formatMoneyTotal(minor,scale)});
export function closingAuthority(ctx:ApiContext,edit=false){
 for(const cap of ['closing.view','periods.view','accounts.view','journals.view','ledger.view','financial-reports.view',...(edit?['closing.edit','periods.edit','journals.edit'] as const:[])] as const)requireScope(permissionScope(ctx,cap));
}
export function closingSnapshot(ctx:ApiContext,r:Source){
 const sourceStamp={journals:readMinorUnits(r.sourceJournalCount).toString(),chartVersions:readMinorUnits(r.chartVersionSum).toString(),periodVersions:readMinorUnits(r.periodVersionSum).toString()};
 return {sourceStamp,snapshot:createHash('sha256').update(JSON.stringify([1,ctx.credential.academy_id,r.periodId,r.periodVersion,r.periodState,r.startsOn,r.through,sourceStamp])).digest('hex')};
}
export function closingBlockers(r:Source){
 const blockers:string[]=[];if(r.periodState!=='open')blockers.push('PERIOD_NOT_OPEN');
 if(r.activeCloseThrough&&r.activeCloseThrough>=r.through)blockers.push('LATER_FINANCIAL_CLOSE_ACTIVE');
 for(const [count,code] of [[r.unclassifiedLineCount,'LEGACY_PURPOSE_REVIEW_REQUIRED'],[r.inactiveGroups,'INACTIVE_TEMPORARY_ACCOUNT'],[r.reclassifiedGroups,'HISTORICAL_KIND_REVIEW_REQUIRED'],[r.otherOpenPeriodCount,'EARLIER_OPEN_PERIOD']] as const)if(readMinorUnits(count)>0n)blockers.push(code);
 if(r.currencies.some(c=>readMinorUnits(c.debitMinor)!==readMinorUnits(c.creditMinor)))blockers.push('SOURCE_CURRENCY_UNBALANCED');return blockers;
}
export async function financeClosing(ctx:ApiContext):Promise<Reply|null>{
 const match=/^finance\/periods\/([^/]+)\/closing-preview$/.exec(ctx.path);if(!match)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 // A complete closing source cannot silently omit another hub or a denied
 // currency/account. A full grant for each feature is required, including bots.
 closingAuthority(ctx);
 const id=uuid.parse(match[1]),q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
 const r=(await ctx.db.query<Source>(closingSourceSQL,[id,q.afterCode??null,q.afterId??null,q.afterKind??null,q.limit+1])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');
 // Native immutability/no-delete and strictly increasing catalogue/period
 // versions make this bounded stamp monotonic: even cancelling postings or
 // metadata changed back to its old value invalidate it. It is not an auth
 // token; a future writer must reauthorize and lock/recheck before applying.
 // Extend/version the stamp when new mutable financial source types appear.
 const {sourceStamp,snapshot}=closingSnapshot(ctx,r);
 if(q.snapshot&&q.snapshot!==snapshot)throw new ApiError(409,'CLOSING_SOURCE_CHANGED');
 const currencies=r.currencies.map(c=>{const debit=readMinorUnits(c.debitMinor),credit=readMinorUnits(c.creditMinor);return {currencyId:c.currencyId,currencyCode:c.currencyCode,unitScale:c.unitScale,debit:exact(debit,c.unitScale),credit:exact(credit,c.unitScale),difference:exact(debit-credit,c.unitScale),balanced:debit===credit};});
 const blockers=closingBlockers(r);
 const next=r.entries.length>q.limit?r.entries[q.limit-1]:null;
 return {status:200,body:{data:{report:'closing_source_preview',operation:'read_only_source_validation',periodId:r.periodId,periodVersion:r.periodVersion,periodState:r.periodState,startsOn:r.startsOn,through:r.through,sourceBasis:'all_posted_history_through_period_end',snapshotAt:r.snapshotAt,snapshot,sourceStamp,sourceLineCount:r.sourceLineCount,unclassifiedLineCount:r.unclassifiedLineCount,temporaryGroupCount:r.temporaryGroupCount,otherOpenPeriodCount:r.otherOpenPeriodCount,blockers,currencies,
  entries:r.entries.slice(0,q.limit).map(({netMinor,...e})=>{const net=readMinorUnits(netMinor),amount=net<0n?-net:net;return {...e,debitNet:exact(net,e.unitScale),closingSide:net>0n?'credit':'debit',closingAmount:exact(amount,e.unitScale),requiresSplit:amount>maximumMinorUnits};})},
  nextCursor:next?{afterCode:next.code,afterId:next.accountId,afterKind:next.postedKind,snapshot}:null}};
}
export const closingContract=[{path:'/api/v1/finance/periods/{id}/closing-preview',method:'get',summary:'Read-only complete-school closing-source validation, exact all-history balances and stale-source-detecting cursor; no entries generated or period closed',querySchema:query}] as const;

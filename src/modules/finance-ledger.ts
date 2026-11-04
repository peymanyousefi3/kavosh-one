import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,requireScope } from '../core/policy.ts';
import { formatMoneyTotal } from '../core/money.ts';
import { accountingDate } from './finance-periods.ts';
import { accountRow } from './finance.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const dates={from:accountingDate.optional(),through:accountingDate};
const balanceQuery=z.object(dates).strict().refine(v=>!v.from||v.from<=v.through);
const ledgerQuery=z.object({...dates,limit:z.coerce.number().int().min(1).max(100).default(50),afterPostedOn:accountingDate.optional(),afterJournalId:uuid.optional(),afterLine:z.coerce.number().int().min(1).max(200).optional()}).strict()
  .refine(v=>!v.from||v.from<=v.through).refine(v=>[v.afterPostedOn,v.afterJournalId,v.afterLine].filter(v=>v!==undefined).length%3===0,'Provide all three cursor fields together.');
type Totals={openingDebits:string;openingCredits:string;debits:string;credits:string;lineCount:number;journalCount:number};
type Line={postedOn:string;journalId:string;lineNumber:number;accountVersion:number;side:'debit'|'credit';amountMinor:string};
const totals=`SELECT coalesce(sum(l.amount_minor) FILTER(WHERE l.side='debit' AND j.posted_on<$2::date),0)::text AS "openingDebits",
 coalesce(sum(l.amount_minor) FILTER(WHERE l.side='credit' AND j.posted_on<$2::date),0)::text AS "openingCredits",
 coalesce(sum(l.amount_minor) FILTER(WHERE l.side='debit' AND ($2::date IS NULL OR j.posted_on>=$2)),0)::text AS debits,
 coalesce(sum(l.amount_minor) FILTER(WHERE l.side='credit' AND ($2::date IS NULL OR j.posted_on>=$2)),0)::text AS credits,
 count(*) FILTER(WHERE $2::date IS NULL OR j.posted_on>=$2)::integer AS "lineCount",count(DISTINCT j.id) FILTER(WHERE $2::date IS NULL OR j.posted_on>=$2)::integer AS "journalCount"
 FROM public.finance_journal_lines l JOIN public.finance_journals j ON j.academy_id=l.academy_id AND j.id=l.journal_id
 WHERE l.account_id=$1 AND j.posted_on<=$3::date`;
function balances(row:Totals,unitScale:number){
  const opening=BigInt(row.openingDebits)-BigInt(row.openingCredits),movement=BigInt(row.debits)-BigInt(row.credits);
  const exact=(minor:bigint)=>({minor:minor.toString(),amount:formatMoneyTotal(minor,unitScale)});
  return {basis:'posted_account_lines' as const,netConvention:'debits_minus_credits' as const,opening:exact(opening),debits:exact(BigInt(row.debits)),credits:exact(BigInt(row.credits)),movement:exact(movement),closing:exact(opening+movement),lineCount:row.lineCount,journalCount:row.journalCount};
}
export async function financeLedger(ctx:ApiContext):Promise<Reply|null>{
  const match=/^finance\/accounts\/([^/]+)\/(balance|ledger)$/.exec(ctx.path);if(!match)return null;
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  const id=uuid.parse(match[1]),account=await accountRow(ctx,id);requireScope(permissionScope(ctx,'ledger.view'),account.hubId??undefined);
  const q=(match[2]==='balance'?balanceQuery:ledgerQuery).parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const basis={accountId:id,currencyId:account.currencyId,currencyVersion:account.currencyVersion,unitScale:account.unitScale,from:q.from??null,through:q.through};
  if(match[2]==='balance'){
    const row=(await ctx.db.query<Totals>(totals,[id,q.from??null,q.through])).rows[0];return {status:200,body:{data:{...basis,...balances(row,account.unitScale)}}};
  }
  const paging=ledgerQuery.parse(q);
  // One SQL snapshot binds summary and page despite concurrent insertions.
  // This permission grants this account's amounts, not a mixed-hub journal's
  // description, counterparties, notes or private approval payload.
  const result=(await ctx.db.query<Totals&{entries:Line[]}>(`WITH totals AS (${totals}),page AS (
   SELECT j.posted_on::text AS "postedOn",j.id AS "journalId",l.line_number AS "lineNumber",l.account_version AS "accountVersion",l.side,l.amount_minor::text AS "amountMinor"
   FROM public.finance_journal_lines l JOIN public.finance_journals j ON j.academy_id=l.academy_id AND j.id=l.journal_id
   WHERE l.account_id=$1 AND ($2::date IS NULL OR j.posted_on>=$2) AND j.posted_on<=$3::date
    AND ($4::date IS NULL OR (j.posted_on,j.id,l.line_number)>($4::date,$5::uuid,$6::smallint))
   ORDER BY j.posted_on,j.id,l.line_number LIMIT $7)
   SELECT totals.*,coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "postedOn","journalId","lineNumber") FROM page),'[]'::jsonb) AS entries FROM totals`,[id,q.from??null,q.through,paging.afterPostedOn??null,paging.afterJournalId??null,paging.afterLine??null,paging.limit+1])).rows[0];
  const rows=result.entries,next=rows.length>paging.limit?rows[paging.limit-1]:null;
  return {status:200,body:{data:{...basis,...balances(result,account.unitScale),entries:rows.slice(0,paging.limit).map(l=>({...l,amount:formatMoneyTotal(BigInt(l.amountMinor),account.unitScale)}))},nextCursor:next?{afterPostedOn:next.postedOn,afterJournalId:next.journalId,afterLine:next.lineNumber}:null}};
}
export const ledgerContract=[
  {path:'/api/v1/finance/accounts/{id}/balance',method:'get',summary:'Exact opening/movement/closing balance at an explicit date from every authorized account posting, not a bank balance or FX conversion',querySchema:balanceQuery},
  {path:'/api/v1/finance/accounts/{id}/ledger',method:'get',summary:'Same-snapshot account totals and chronological line page; separate ledger rights do not disclose counterparties or private journal content',querySchema:ledgerQuery}
] as const;

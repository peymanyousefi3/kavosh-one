import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import type { ApiContext,Reply } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,requireScope,type Capability } from '../core/policy.ts';
import { readMinorUnits,formatMoneyTotal } from '../core/money.ts';
import { accountRow } from './finance.ts';
import { accountingDate } from './finance-periods.ts';
import { accountTotalsSQL,accountBalances } from './finance-ledger.ts';
import { journalPointLookupSQL } from './finance-journals.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const query=z.object({accountId:uuid,from:accountingDate,through:accountingDate,snapshot:z.string().regex(/^[a-f0-9]{64}$/).optional(),openingObservationId:uuid.optional(),closingObservationId:uuid.optional(),
 status:z.enum(['unresolved','all','matched','non_activity']).default('unresolved'),periodOnly:z.enum(['true','false']).transform(v=>v==='true').default(false),limit:z.coerce.number().int().min(1).max(100).default(50),
 statementAfterPostedOn:accountingDate.optional(),statementAfterImportId:uuid.optional(),statementAfterLine:z.coerce.number().int().min(1).max(500).optional(),
 ledgerAfterPostedOn:accountingDate.optional(),ledgerAfterJournalId:uuid.optional(),ledgerAfterLine:z.coerce.number().int().min(1).max(200).optional()}).strict()
 .refine(v=>v.from<=v.through).refine(v=>[v.statementAfterPostedOn,v.statementAfterImportId,v.statementAfterLine].filter(x=>x!==undefined).length%3===0)
 .refine(v=>[v.ledgerAfterPostedOn,v.ledgerAfterJournalId,v.ledgerAfterLine].filter(x=>x!==undefined).length%3===0)
 .refine(v=>v.snapshot!==undefined||(v.statementAfterImportId===undefined&&v.ledgerAfterJournalId===undefined),'Report cursors require their source snapshot.');
type Page={postedOn:string;debitNetMinor:string;status:string;matchId:string|null;beforePeriod:boolean};
type BankPage=Page&{importId:string;line:number;description:string;reference:string;possibleDuplicate:boolean};
type BookPage=Page&{journalId:string;lineNumber:number;purpose:string;accountVersion:number;reversedById:string|null};
type Summary={totalCount:number;matchedCount:number;unmatchedCount:number;cutoffPendingCount:number;priorUnresolvedCount:number;unresolvedNetMinor:string;periodCount:number;periodNetMinor:string;nonActivityCount:number;legacyCount:number};
type Observation={id:string;as_of:string;state:string;balance_minor:string|null;normal_balance:string;currency_id:string;unit_scale:number;superseded_by:string|null};
type Result=Parameters<typeof accountBalances>[0]&{source_stamp:{accountVersion:number;imports:string;voids:string;lines:string;groups:string;releases:string};snapshot_at:string;bank_summary:Summary;book_summary:Summary;bank_page:BankPage[];book_page:BookPage[];observations:Observation[];cutoff_groups:number;nonactivity_matches:number};

// All totals, links, selected balance observations and both independent pages
// share one MVCC statement snapshot. Money is never summed from a page.
const sql=`WITH ledger_totals AS(${accountTotalsSQL}),active_groups AS MATERIALIZED(
 SELECT m.id FROM public.finance_statement_matches m WHERE m.account_id=$1 AND NOT EXISTS(SELECT 1 FROM public.finance_statement_match_releases r WHERE r.academy_id=m.academy_id AND r.match_id=m.id)
),group_dates AS MATERIALIZED(
 SELECT g.id,min(d.posted_on) AS first_date,max(d.posted_on) AS last_date FROM active_groups g CROSS JOIN LATERAL(
  SELECT r.posted_on FROM public.finance_statement_match_rows x JOIN public.finance_statement_rows r ON r.academy_id=x.academy_id AND r.import_id=x.import_id AND r.line=x.line WHERE x.match_id=g.id
  UNION ALL SELECT j.posted_on FROM public.finance_statement_match_lines x JOIN public.finance_journal_lines l ON l.academy_id=x.academy_id AND l.journal_id=x.journal_id AND l.line_number=x.line_number ${journalPointLookupSQL} WHERE x.match_id=g.id
 ) d GROUP BY g.id
),active_rows AS MATERIALIZED(
 SELECT x.import_id,x.line,x.match_id,g.last_date>$3::date AS cutoff_pending FROM public.finance_statement_match_rows x JOIN group_dates g ON g.id=x.match_id
),active_lines AS MATERIALIZED(
 SELECT x.journal_id,x.line_number,x.match_id,g.last_date>$3::date AS cutoff_pending FROM public.finance_statement_match_lines x JOIN group_dates g ON g.id=x.match_id
),bank AS MATERIALIZED(
 SELECT r.*,x.match_id,CASE WHEN x.match_id IS NULL THEN 'unmatched' WHEN x.cutoff_pending THEN 'cutoff_pending' ELSE 'matched' END AS status
 FROM public.finance_statement_rows r JOIN public.finance_statement_imports i ON i.academy_id=r.academy_id AND i.id=r.import_id
 LEFT JOIN active_rows x ON x.import_id=r.import_id AND x.line=r.line
 WHERE r.account_id=$1 AND r.posted_on<=$3::date AND NOT EXISTS(SELECT 1 FROM public.finance_statement_voids v WHERE v.academy_id=i.academy_id AND v.import_id=i.id)
),book AS MATERIALIZED(
 SELECT l.*,j.posted_on,j.purpose,(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END) AS debit_net_minor,x.match_id,
 CASE WHEN j.purpose NOT IN('activity','legacy_unclassified') THEN 'non_activity' WHEN x.match_id IS NULL THEN 'unmatched' WHEN x.cutoff_pending THEN 'cutoff_pending' ELSE 'matched' END AS status
 FROM public.finance_journal_lines l ${journalPointLookupSQL} LEFT JOIN active_lines x ON x.journal_id=l.journal_id AND x.line_number=l.line_number
 WHERE l.account_id=$1 AND j.posted_on<=$3::date
),bank_page AS(
 SELECT r.import_id AS "importId",r.line,r.posted_on::text AS "postedOn",r.debit_net_minor::text AS "debitNetMinor",r.description,r.reference,r.status,r.match_id AS "matchId",r.posted_on<$2::date AS "beforePeriod",
 EXISTS(SELECT 1 FROM public.finance_statement_rows other JOIN public.finance_statement_imports i ON i.academy_id=other.academy_id AND i.id=other.import_id WHERE other.account_id=r.account_id AND other.posted_on=r.posted_on AND other.debit_net_minor=r.debit_net_minor AND other.description=r.description AND other.reference=r.reference AND(other.import_id<>r.import_id OR other.line<>r.line) AND NOT EXISTS(SELECT 1 FROM public.finance_statement_voids v WHERE v.academy_id=i.academy_id AND v.import_id=i.id)) AS "possibleDuplicate"
 FROM bank r WHERE($7::text='all' OR($7='unresolved' AND r.status IN('unmatched','cutoff_pending')) OR r.status=$7)
 AND(NOT $14::boolean OR r.posted_on>=$2::date) AND($8::date IS NULL OR(r.posted_on,r.import_id,r.line)>($8::date,$9::uuid,$10::integer)) ORDER BY r.posted_on,r.import_id,r.line LIMIT $6
),book_page AS(
 SELECT l.journal_id AS "journalId",l.line_number AS "lineNumber",l.posted_on::text AS "postedOn",l.account_version AS "accountVersion",l.purpose,l.debit_net_minor::text AS "debitNetMinor",l.status,l.match_id AS "matchId",l.posted_on<$2::date AS "beforePeriod",
 (SELECT j.id FROM public.finance_journals j WHERE j.reverses_id=l.journal_id) AS "reversedById"
 FROM book l WHERE($7::text='all' OR($7='unresolved' AND l.status IN('unmatched','cutoff_pending')) OR l.status=$7)
 AND(NOT $14::boolean OR l.posted_on>=$2::date) AND($11::date IS NULL OR(l.posted_on,l.journal_id,l.line_number)>($11::date,$12::uuid,$13::smallint)) ORDER BY l.posted_on,l.journal_id,l.line_number LIMIT $6
),observations AS(
 SELECT o.id,o.as_of::text,o.state,o.balance_minor::text,o.normal_balance,o.currency_id,o.unit_scale,(SELECT c.id FROM public.finance_balance_observations c WHERE c.supersedes_id=o.id) AS superseded_by
 FROM public.finance_balance_observations o WHERE o.account_id=$1 AND o.id IN($4::uuid,$5::uuid)
)
SELECT ledger_totals.*,statement_timestamp()::text AS snapshot_at,
 jsonb_build_object('accountVersion',(SELECT version FROM public.finance_accounts WHERE id=$1),
  'imports',(SELECT count(*)::text FROM public.finance_statement_imports WHERE account_id=$1),
  'voids',(SELECT count(*)::text FROM public.finance_statement_voids v JOIN public.finance_statement_imports i ON i.academy_id=v.academy_id AND i.id=v.import_id WHERE i.account_id=$1),
  'lines',(SELECT count(*)::text FROM public.finance_journal_lines WHERE account_id=$1),
  'groups',(SELECT count(*)::text FROM public.finance_statement_matches WHERE account_id=$1),
  'releases',(SELECT count(*)::text FROM public.finance_statement_match_releases r JOIN public.finance_statement_matches m ON m.academy_id=r.academy_id AND m.id=r.match_id WHERE m.account_id=$1)) AS source_stamp,
 (SELECT jsonb_build_object('totalCount',count(*)::integer,'matchedCount',count(*) FILTER(WHERE status='matched')::integer,'unmatchedCount',count(*) FILTER(WHERE status='unmatched')::integer,'cutoffPendingCount',count(*) FILTER(WHERE status='cutoff_pending')::integer,
  'priorUnresolvedCount',count(*) FILTER(WHERE posted_on<$2::date AND status IN('unmatched','cutoff_pending'))::integer,'unresolvedNetMinor',coalesce(sum(debit_net_minor) FILTER(WHERE status IN('unmatched','cutoff_pending')),0)::text,
  'periodCount',count(*) FILTER(WHERE posted_on>=$2::date)::integer,'periodNetMinor',coalesce(sum(debit_net_minor) FILTER(WHERE posted_on>=$2::date),0)::text,'nonActivityCount',0,'legacyCount',0) FROM bank) AS bank_summary,
 (SELECT jsonb_build_object('totalCount',count(*)::integer,'matchedCount',count(*) FILTER(WHERE status='matched')::integer,'unmatchedCount',count(*) FILTER(WHERE status='unmatched')::integer,'cutoffPendingCount',count(*) FILTER(WHERE status='cutoff_pending')::integer,
  'priorUnresolvedCount',count(*) FILTER(WHERE posted_on<$2::date AND status IN('unmatched','cutoff_pending'))::integer,'unresolvedNetMinor',coalesce(sum(debit_net_minor) FILTER(WHERE status IN('unmatched','cutoff_pending')),0)::text,
  'periodCount',count(*) FILTER(WHERE posted_on>=$2::date)::integer,'periodNetMinor',coalesce(sum(debit_net_minor) FILTER(WHERE posted_on>=$2::date),0)::text,'nonActivityCount',count(*) FILTER(WHERE status='non_activity')::integer,'legacyCount',count(*) FILTER(WHERE purpose='legacy_unclassified')::integer) FROM book) AS book_summary,
 (SELECT count(*)::integer FROM group_dates WHERE first_date<=$3::date AND last_date>$3::date) AS cutoff_groups,
 (SELECT count(*)::integer FROM book WHERE status='non_activity' AND match_id IS NOT NULL) AS nonactivity_matches,
 coalesce((SELECT jsonb_agg(to_jsonb(bank_page) ORDER BY "postedOn","importId",line) FROM bank_page),'[]'::jsonb) AS bank_page,
 coalesce((SELECT jsonb_agg(to_jsonb(book_page) ORDER BY "postedOn","journalId","lineNumber") FROM book_page),'[]'::jsonb) AS book_page,
 coalesce((SELECT jsonb_agg(to_jsonb(observations) ORDER BY id) FROM observations),'[]'::jsonb) AS observations FROM ledger_totals`;

export async function bankReconciliationReport(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/bank-reconciliation')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),a=await accountRow(ctx,q.accountId);
 const capabilities:Capability[]=['financial-reports.view','ledger.view','bank-statements.view','bank-matches.view',...(q.openingObservationId||q.closingObservationId?['bank-balances.view' as const]:[])];
 for(const cap of capabilities)requireScope(permissionScope(ctx,cap),a.hubId??undefined);
 const result=(await ctx.db.query<Result>(sql,[a.id,q.from,q.through,q.openingObservationId??null,q.closingObservationId??null,q.limit+1,q.status,q.statementAfterPostedOn??null,q.statementAfterImportId??null,q.statementAfterLine??null,q.ledgerAfterPostedOn??null,q.ledgerAfterJournalId??null,q.ledgerAfterLine??null,q.periodOnly])).rows[0];
 // Native sources cannot be updated/deleted or extended after commit; these
 // counts only increase, even after void/release/rematch or net-neutral posts.
 // Account versions increase too. Selected observations include their current
 // successor IDs. Future-dated account changes conservatively invalidate the
 // cursor; this is a stale-source detector, not an authorization/freeze token.
 if(result.source_stamp.accountVersion!==a.version)throw new ApiError(409,'RECONCILIATION_SOURCE_CHANGED');
 const snapshot=createHash('sha256').update(JSON.stringify([1,ctx.credential.academy_id,a.id,q.from,q.through,q.openingObservationId??null,q.closingObservationId??null,result.source_stamp,result.observations])).digest('hex');
 if(q.snapshot&&q.snapshot!==snapshot)throw new ApiError(409,'RECONCILIATION_SOURCE_CHANGED');
 const money=(v:bigint|string)=>{const n=typeof v==='bigint'?v:readMinorUnits(v);return {minor:n.toString(),amount:formatMoneyTotal(n,a.unitScale)};};
 const observation=(id:string|undefined,on:string)=>{
  if(!id)return null;const o=result.observations.find(o=>o.id===id);if(!o)throw new ApiError(404,'BALANCE_OBSERVATION_NOT_FOUND');if(o.as_of!==on)throw new ApiError(409,'BALANCE_OBSERVATION_DATE_MISMATCH');
  const problem=o.superseded_by?'observation_superseded':o.state!=='recorded'||o.balance_minor===null?'observation_void':o.currency_id!==a.currencyId||o.unit_scale!==a.unitScale?'currency_or_precision_mismatch':null;
  return {id:o.id,asOf:o.as_of,inputNormalBalance:o.normal_balance,usable:problem===null,problem,supersededBy:o.superseded_by,debitNet:problem===null?money(readMinorUnits(o.balance_minor!)*(o.normal_balance==='credit'?-1n:1n)):null,externallyVerified:false};
 };
 const previous=Temporal.PlainDate.from(q.from).subtract({days:1}).toString(),opening=observation(q.openingObservationId,previous),closing=observation(q.closingObservationId,q.through),book=accountBalances(result,a.unitScale),bookClosing=readMinorUnits(book.closing.minor),bankUnresolved=readMinorUnits(result.bank_summary.unresolvedNetMinor),bookUnresolved=readMinorUnits(result.book_summary.unresolvedNetMinor),bankPeriod=readMinorUnits(result.bank_summary.periodNetMinor);
 const closingMinor=closing?.debitNet?readMinorUnits(closing.debitNet.minor):null,openingMinor=opening?.debitNet?readMinorUnits(opening.debitNet.minor):null,adjustedBank=closingMinor===null?null:closingMinor+bookUnresolved,adjustedBook=bookClosing+bankUnresolved;
 const summarize=({unresolvedNetMinor,periodNetMinor,...s}:Summary)=>({...s,unresolvedNet:money(unresolvedNetMinor),periodNet:money(periodNetMinor)}),bankNext=result.bank_page.length>q.limit?result.bank_page[q.limit-1]:null,bookNext=result.book_page.length>q.limit?result.book_page[q.limit-1]:null;
 return {status:200,body:{data:{report:'current_recorded_bank_reconciliation_review',accountId:a.id,currencyId:a.currencyId,unitScale:a.unitScale,currencyConversion:'none',from:q.from,through:q.through,status:q.status,periodOnly:q.periodOnly,snapshotAt:result.snapshot_at,snapshot,snapshotBasis:'account_wide_append_only_sources_and_selected_observations',matchingBasis:'current_active_groups_all_member_dates_at_or_before_cutoff',balanceConvention:'debits_minus_credits',coverage:'all_current_active_import_rows_and_posted_account_lines_through_cutoff',pageDateBasis:q.periodOnly?'period_only':'all_through_cutoff_with_before_period_flags',bookUnresolvedBasis:'activity_and_legacy_unclassified_excluding_opening_and_closing',
  ledger:book,statement:summarize(result.bank_summary),bookTransactions:summarize(result.book_summary),openingObservation:opening,closingObservation:closing,
  comparison:{closingDifference:closingMinor===null?null:money(closingMinor-bookClosing),statementPeriodMovementDifference:openingMinor===null||closingMinor===null?null:money(closingMinor-openingMinor-bankPeriod),provisionalAdjustedBank:adjustedBank===null?null:money(adjustedBank),provisionalAdjustedBook:money(adjustedBook),provisionalResidual:adjustedBank===null?null:money(adjustedBank-adjustedBook)},
  review:{cutoffSpanningGroups:result.cutoff_groups,nonActivityMatchedLines:result.nonactivity_matches,legacyPurposeReviewRequired:result.book_summary.legacyCount>0,statementCoverageVerified:false,adjustmentsPosted:false,finalized:false,externallyVerified:false,reconciled:false},
  statementItems:result.bank_page.slice(0,q.limit).map(({debitNetMinor,...r})=>({...r,debitNet:money(debitNetMinor)})),ledgerItems:result.book_page.slice(0,q.limit).map(({debitNetMinor,...r})=>({...r,debitNet:money(debitNetMinor)})),
  nextStatementCursor:bankNext?{statementAfterPostedOn:bankNext.postedOn,statementAfterImportId:bankNext.importId,statementAfterLine:bankNext.line,snapshot}:null,nextLedgerCursor:bookNext?{ledgerAfterPostedOn:bookNext.postedOn,ledgerAfterJournalId:bookNext.journalId,ledgerAfterLine:bookNext.lineNumber,snapshot}:null}}};
}
export const bankReconciliationReportContract=[{path:'/api/v1/reports/finance/bank-reconciliation',method:'get',summary:'Same-snapshot current matching review, prior outstanding and cutoff-spanning groups, independent source-snapshot-required cursors and optional explicitly selected manual opening/closing observations; account-wide source changes invalidate cursors, provisional arithmetic only, not finalized or externally verified reconciliation',querySchema:query}] as const;

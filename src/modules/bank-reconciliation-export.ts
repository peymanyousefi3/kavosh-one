import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { accountingDate } from './finance-periods.ts';
import { reconciliationReportData,reconciliationExportRowLimit,reconciliationExportByteLimit } from './bank-reconciliation-report.ts';
import { csvText as reconciliationCsvText,csvRow } from '../core/csv.ts';
import { lockAcademyTopology } from './academy.ts';
import type { ResolvedReportWindow } from '../core/report-window.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const query=z.object({accountId:uuid,from:accountingDate,through:accountingDate,snapshot:z.string().regex(/^[a-f0-9]{64}$/).optional(),openingObservationId:uuid.optional(),closingObservationId:uuid.optional(),status:z.enum(['unresolved','all','matched','non_activity']).default('all'),periodOnly:z.enum(['true','false']).default('false').transform(v=>v==='true')}).strict().refine(v=>v.from<=v.through);
// A visible literal prefix, rather than a spreadsheet-specific invisible escape,
// keeps dangerous free text distinguishable from the original source. Quoting
// alone does not stop formula interpretation. Never apply this to exact,
// code-generated signed numeric amounts. CSV is not a round-trip source format.
export { reconciliationCsvText };
export type ReconciliationCsvReport=Omit<Awaited<ReturnType<typeof reconciliationReportData>>,'snapshotAt'|'review'>&{snapshotAt?:string;review:Record<string,string|number|boolean>};
type Archive={id:string;approvalId:string;capturedAt:string;supersedesId:string|null;supersededBy:string|null;reference:string;coverageAttestation:string;outstanding:{journalId:string;lineNumber:number;kind:string;reason:string}[]};
type Provenance={id:string;version:number;dateWindow?:ResolvedReportWindow&{overriddenFields?:string[]}};
export function assertReconciliationExportSources(statementRows:number,ledgerRows:number){if(statementRows>reconciliationExportRowLimit||ledgerRows>reconciliationExportRowLimit)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');}
export function reconciliationCsv(d:ReconciliationCsvReport,archive?:Archive,provenance?:Provenance):Reply{
 if(d.nextStatementCursor||d.nextLedgerCursor||d.statementItems.length>reconciliationExportRowLimit||d.ledgerItems.length>reconciliationExportRowLimit)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');
 const rows:(string|number|boolean|null)[][]=[['section','field','value','posted_on','source_id','line','status','debit_net_minor','debit_net_amount','before_period','match_id','possible_duplicate','description','reference','purpose','account_version','reversed_by_id']];
 const meta=(field:string,value:string|number|boolean|null)=>rows.push(['metadata',field,value]);
 meta('export_basis',archive?'immutable_captured_record':'current_recorded_sources');
 meta('row_status_filter',d.status);meta('rows_period_only',d.periodOnly);meta('row_date_basis',d.pageDateBasis);meta('filter_scope','Rows only;summary totals and comparisons retain the entire authorized source context.');meta('exported_statement_rows',d.statementItems.length);meta('exported_ledger_rows',d.ledgerItems.length);
 if(provenance){meta('preset_id',provenance.id);meta('preset_version',provenance.version);if(provenance.dateWindow)meta('date_window',reconciliationCsvText(JSON.stringify(provenance.dateWindow)));}
 if(archive){meta('record_id',archive.id);meta('approval_id',archive.approvalId);meta('captured_at',archive.capturedAt);meta('record_state','finalized');meta('record_active',archive.supersededBy===null);meta('supersedes_id',archive.supersedesId);meta('superseded_by',archive.supersededBy);meta('record_reference',reconciliationCsvText(archive.reference));meta('coverage_attestation',reconciliationCsvText(archive.coverageAttestation));meta('current_source_validated',false);}
 meta('numeric_precision_policy','Amounts and minor units are exact CSV text. Import as text to preserve long values; spreadsheet automatic numeric conversion can lose precision.');
 meta('report',d.report);meta('account_id',d.accountId);meta('currency_id',d.currencyId);meta('unit_scale',d.unitScale);meta('currency_conversion',d.currencyConversion);meta('from',d.from);meta('through',d.through);if(!archive)meta('snapshot_at',d.snapshotAt??null);meta('snapshot',d.snapshot);meta('snapshot_basis',d.snapshotBasis);meta('coverage',d.coverage);meta('balance_convention',d.balanceConvention);meta('matching_basis',d.matchingBasis);meta('book_unresolved_basis',d.bookUnresolvedBasis);meta('text_policy','Formula-like free text has a visible text: prefix; original source is unchanged. Treat CSV as data, not trusted formulas.');meta('unknown_policy','Missing comparisons and observations are explicitly marked unknown, never zero.');
 for(const [field,value] of Object.entries(d.review))meta(field,value);
 for(const [field,value] of Object.entries(d.ledger))if(typeof value==='object'){meta('ledger_'+field+'_minor',value.minor);meta('ledger_'+field+'_amount',value.amount);}else meta('ledger_'+field,value);
 for(const [section,summary] of [['statement',d.statement],['book',d.bookTransactions]] as const)for(const [field,value] of Object.entries(summary))if(typeof value==='object'){meta(section+'_'+field+'_minor',value.minor);meta(section+'_'+field+'_amount',value.amount);}else meta(section+'_'+field,value);
 for(const [field,value] of Object.entries(d.comparison)){meta(field+'_known',value!==null);if(value){meta(field+'_minor',value.minor);meta(field+'_amount',value.amount);}}
 for(const [name,o] of [['opening',d.openingObservation],['closing',d.closingObservation]] as const){meta(name+'_observation_selected',o!==null);if(o){meta(name+'_observation_id',o.id);meta(name+'_observation_as_of',o.asOf);meta(name+'_observation_input_normal_balance',o.inputNormalBalance);meta(name+'_observation_usable',o.usable);meta(name+'_observation_problem',o.problem);meta(name+'_observation_superseded_by',o.supersededBy);if(o.debitNet){meta(name+'_observation_debit_net_minor',o.debitNet.minor);meta(name+'_observation_debit_net_amount',o.debitNet.amount);}}}
 for(const r of d.statementItems)rows.push(['statement','','',r.postedOn,r.importId,r.line,r.status,r.debitNet.minor,r.debitNet.amount,r.beforePeriod,r.matchId,r.possibleDuplicate,reconciliationCsvText(r.description),reconciliationCsvText(r.reference)]);
 for(const r of d.ledgerItems)rows.push(['ledger','','',r.postedOn,r.journalId,r.lineNumber,r.status,r.debitNet.minor,r.debitNet.amount,r.beforePeriod,r.matchId,null,'','',r.purpose,r.accountVersion,r.reversedById]);
 if(archive){const lines=new Map(d.ledgerItems.map(r=>[r.journalId+':'+r.lineNumber,r]));for(const n of archive.outstanding){const r=lines.get(n.journalId+':'+n.lineNumber);if(!r)throw new ApiError(409,'RECONCILIATION_ARCHIVE_INVALID');rows.push(['reviewed_outstanding',n.kind,reconciliationCsvText(n.reason),r.postedOn,r.journalId,r.lineNumber,r.status,r.debitNet.minor,r.debitNet.amount,r.beforePeriod,r.matchId]);}}
 const csv='\uFEFF'+rows.map(row=>csvRow(Array.from({length:17},(_,i)=>row[i]))).join('\r\n')+'\r\n';
 if(Buffer.byteLength(csv,'utf8')>reconciliationExportByteLimit)throw new ApiError(409,'REPORT_REQUIRES_BACKGROUND_JOB');
 return {status:200,body:csv,csv:{filename:archive?`bank-reconciliation-record-${archive.id}.csv`:`bank-reconciliation-${d.accountId}-${d.from}-${d.through}.csv`}};
}
export async function bankReconciliationExport(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/bank-reconciliation/export')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 return completeBankReconciliationExport(ctx);
}
export async function completeBankReconciliationExport(ctx:ApiContext,provenance?:Provenance){
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(params));await lockAcademyTopology(ctx);
 // ponytail: bounded in-memory export, 1,000 rows per side and 4 MiB UTF-8;
 // larger reports need the queued export worker, never pages from live snapshots.
 const data=await reconciliationReportData(ctx,{...q,limit:reconciliationExportRowLimit});
 // Duplicate detection and summaries require the whole source context,even
 // if a filter selects fewer rows. Never label unexamined duplicates false.
 assertReconciliationExportSources(data.statement.totalCount,data.bookTransactions.totalCount);return reconciliationCsv(data,undefined,provenance);
}
export const bankReconciliationExportContract=[{path:'/api/v1/reports/finance/bank-reconciliation/export',method:'get',summary:'Complete selected reconciliation rows as UTF-8 CSV;defaults to all statuses/prior outstanding,optional status/period-only filters change rows not whole-context summaries/comparisons;current source rights and one snapshot,1,000whole source rows per side/4MiB bound even filtered output;not finalized or externally verified',querySchema:query,responseContentType:'text/csv' as const}] as const;

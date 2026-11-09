import {z} from 'zod';
import {csvRow,csvText} from '../core/csv.ts';
import {formatMoneyTotal,readMinorUnits} from '../core/money.ts';
import {accountingDate} from '../modules/finance-periods.ts';
import {counterpartyReportAuthorization} from '../modules/counterparty-statement-access.ts';

const uuid=z.string().uuid(),count=z.number().int().min(0).max(200000),scale=z.number().int().min(0).max(18),code=z.string().regex(/^[A-Z]{3}$/);
// PostgreSQL SUM(numeric) can retain .00. Validate,never round it or use Number.
const minor=z.string().max(100).refine(v=>/^-?\d+(?:\.0+)?$/.test(v));
const currency=z.object({currency_id:uuid,currencyCode:code,scale,opening:minor,increases:minor,decreases:minor,closing:minor,manual_balance:minor,custody:minor,payable:minor}).strict();
const event=z.object({journalId:uuid,lineNumber:z.number().int().min(0).max(200),postedOn:accountingDate,currencyId:uuid,currencyCode:code,scale,family:z.enum(['manual_balance','custody','payable']),category:z.string().regex(/^[a-z_]{1,100}$/),correctionOfId:uuid.nullable(),change:minor,balance:minor}).strict();
const day=z.object({currency_id:uuid,currencyCode:code,scale,postedOn:accountingDate,change:minor,balance:minor}).strict();
// Explicit public projection. Private sourceScope or future native metadata
// fields are deliberately NOT copied into the CSV.
const metadata=z.object({snapshotAt:z.string().min(1).max(100),sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/),sourceCount:count,entryCount:count,currencyCount:z.number().int().min(0).max(1000),dayCount:z.number().int().min(0).max(10000),validRange:z.literal(true),denied:z.literal(0),unknown:z.literal(0),custodyIdentityBasis:z.enum(['same_immutable_internal_hub_or_person_not_name_matching','explicit_immutable_organization_payee_link_at_collector_creation'])});
const row=z.object({section:z.number().int().min(0).max(3),ordinal:z.number().int().min(0).max(200000),payload:z.unknown()}).strict();
const header=['section','field','value','currency_id','currency_code','unit_scale','date','journal_id','line_number','source','category','correction_of','minor','amount','balance_minor','balance_amount'];
type Cell=string|number|boolean|null|undefined;
const money=(raw:string,s:number)=>{const n=readMinorUnits(raw);return [n.toString(),formatMoneyTotal(n,s)] as const;};

// One bounded ordered fragment of ONE CSV. Only section0 includes BOM/header;
// subsequent pages concatenate byte-for-byte,without repeating the header or
// publishing private section4 membership. The persistence layer owns cross-page
// cursor/completion checks;this renderer does not claim a partial page is final.
export function renderCounterpartyCaptureRows(frameRaw:unknown,rawRows:unknown,provenance?:unknown){
 const frame=counterpartyReportAuthorization.shape.frame.parse(frameRaw),rows=z.array(row).min(1).max(1000).parse(rawRows),output:Cell[][]=[];
 for(let i=0;i<rows.length;i++){
  const r=rows[i],previous=rows[i-1];if(previous&&(r.section<previous.section||(r.section===previous.section&&r.ordinal!==previous.ordinal+1)))throw Error('REPORT_CAPTURE_ROW_ORDER_INVALID');
  if(r.section===0){
   if(i!==0||r.ordinal!==0)throw Error('REPORT_CAPTURE_METADATA_POSITION_INVALID');const m=metadata.parse(r.payload);output.push(header);
   const publicMetadata={report:'recorded_counterparty_statement',snapshotAt:m.snapshotAt,sourceFingerprint:m.sourceFingerprint,sourceFingerprintBasis:'selected_recorded_events_filters_party_and_original_contexts_v1',filters:frame,payeeId:frame.payeeId,currencyConversion:'none',entryCount:m.entryCount,sourceEventCount:m.sourceCount,
    coverage:'explicit_manual_balances_typed_collector_custody_and_posted_payee_bills',balanceConvention:'positive_counterparty_owes_academy_negative_academy_owes_counterparty',custodyIdentityBasis:m.custodyIdentityBasis,unlinkedOrganizationCustodyExcluded:true,unattributedManualJournalsExcluded:true,unbilledSharingExcluded:true,originalHiddenSourceExclusion:'refuse_whole_statement_never_publish_partial_net',permissionsAppliedBeforeAggregation:true,nettingPerformed:false,legalSetoffAuthorityVerified:false,bankSettlementVerified:false,moneyMovementPerformed:false};
   for(const [key,value]of Object.entries(publicMetadata))output.push(['metadata',key,csvText(typeof value==='string'?value:JSON.stringify(value))]);
   output.push(['metadata','completeness','complete_selected_recorded_sources_within_limits']);
   if(provenance!==undefined){const value=JSON.stringify(provenance);if(typeof value!=='string'||Buffer.byteLength(value)>16384)throw Error('REPORT_CAPTURE_PROVENANCE_INVALID');output.push(['metadata','provenance',csvText(value)]);}
  }else{
   if(r.ordinal<1)throw Error('REPORT_CAPTURE_ROW_ORDER_INVALID');
   if(r.section===1){const c=currency.parse(r.payload);for(const field of ['opening','increases','decreases','closing'] as const)output.push(['currency_total',field,'',c.currency_id,c.currencyCode,c.scale,'','','','','','',...money(c[field],c.scale)]);for(const [field,key]of [['manualBalances','manual_balance'],['collectorCustody','custody'],['signedPayables','payable']] as const)output.push(['component',field,'',c.currency_id,c.currencyCode,c.scale,'','','','','','',...money(c[key],c.scale)]);}
   else if(r.section===2){const e=event.parse(r.payload);if(e.postedOn<frame.from||e.postedOn>frame.through)throw Error('REPORT_CAPTURE_EVENT_OUTSIDE_FRAME');output.push(['event','','',e.currencyId,e.currencyCode,e.scale,e.postedOn,e.journalId,e.lineNumber,e.family,e.category,e.correctionOfId,...money(e.change,e.scale),...money(e.balance,e.scale)]);}
   else{const d=day.parse(r.payload);if(d.postedOn<frame.from||d.postedOn>frame.through)throw Error('REPORT_CAPTURE_EVENT_OUTSIDE_FRAME');output.push(['daily_chart','','',d.currency_id,d.currencyCode,d.scale,d.postedOn,'','','','','',...money(d.change,d.scale),...money(d.balance,d.scale)]);}
  }
 }
 const body=(rows[0].section===0?'\uFEFF':'')+output.map(c=>csvRow(Array.from({length:16},(_,i)=>c[i]))).join('\r\n')+'\r\n',bytes=Buffer.byteLength(body);
 if(bytes>1048576)throw Error('REPORT_CAPTURE_PART_LIMIT_EXCEEDED');return {body,bytes,records:rows.length,last:{section:rows.at(-1)!.section,ordinal:rows.at(-1)!.ordinal}};
}

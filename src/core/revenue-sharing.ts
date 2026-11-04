import { allocateMoney,parseMoney,roundRatio,maximumMinorUnits } from './money.ts';
import { ApiError } from './policy.ts';

export type ShareRelease='proportional'|'first_collection'|'fully_collected'|'on_invoice';
export type ShareRule={payeeId:string;kind:'academy'|'hub'|'person'|'organization';method:'percentage'|'flat';value:string;release:ShareRelease};
export type SharingInput={unitScale:number;netMinor:bigint;grossMinor:bigint;receivedGrossMinor:bigint;basis:'net_tuition'|'gross_tuition';invoiceIssued:boolean;invoiceCredited:boolean;creditHandling:'retain_collections'|'cancel_on_credit';allowOverAllocation:boolean;rules:ShareRule[]};

// Percentages are not weights to be silently normalized. The explicit residual
// belongs to the academy; flat fees are added after the percentage split.
export function calculateRevenueSharing(input:SharingInput){
 const {netMinor,grossMinor,receivedGrossMinor}=input;
 if(!Number.isInteger(input.unitScale)||input.unitScale<0||input.unitScale>18||[netMinor,grossMinor,receivedGrossMinor].some(v=>typeof v!=='bigint'||v<0n||v>maximumMinorUnits)||netMinor>grossMinor||receivedGrossMinor>grossMinor
  ||!['net_tuition','gross_tuition'].includes(input.basis)||!['retain_collections','cancel_on_credit'].includes(input.creditHandling)||typeof input.invoiceIssued!=='boolean'||typeof input.invoiceCredited!=='boolean'||typeof input.allowOverAllocation!=='boolean'||(input.invoiceCredited&&!input.invoiceIssued)
  ||!Array.isArray(input.rules)||input.rules.length>100||new Set(input.rules.map(r=>r.payeeId)).size!==input.rules.length)throw new ApiError(400,'INVALID_SHARING_INPUT');
 const base=input.basis==='net_tuition'?netMinor:grossMinor;
 const rules=input.rules.map(r=>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.payeeId)||!['academy','hub','person','organization'].includes(r.kind)||!['percentage','flat'].includes(r.method)||!['proportional','first_collection','fully_collected','on_invoice'].includes(r.release))throw new ApiError(400,'INVALID_SHARING_RULE');
  const value=parseMoney(r.value,r.method==='percentage'?4:input.unitScale);if(value<0n||(r.method==='percentage'&&value>1000000n))throw new ApiError(400,'INVALID_SHARING_RULE');return {...r,valueMinor:value};
 });
 const percentageTotal=rules.reduce((s,r)=>s+(r.method==='percentage'?r.valueMinor:0n),0n);if(percentageTotal>1000000n)throw new ApiError(400,'SHARING_PERCENTAGES_EXCEED_100');
 const percentAmounts=new Map(allocateMoney(base,[...rules.filter(r=>r.method==='percentage').map(r=>({key:'p:'+r.payeeId,weight:r.valueMinor})),{key:'r:academy',weight:1000000n-percentageTotal}]).map(r=>[r.key,r.amount]));
 const cancelled=input.invoiceCredited&&input.creditHandling==='cancel_on_credit';
 const rows=rules.map(r=>{
  const full=r.method==='flat'?r.valueMinor:percentAmounts.get('p:'+r.payeeId)!;
  // Cumulative floor of a fixed full entitlement is monotone and independent
  // of installment sizes/order. Re-apportioning each payment can move cents
  // backwards between recipients (the largest-remainder allocation paradox).
  const released=cancelled?0n:r.release==='on_invoice'?(input.invoiceIssued?full:0n):r.release==='first_collection'?(receivedGrossMinor>0n?full:0n):r.release==='fully_collected'?(grossMinor>0n&&receivedGrossMinor===grossMinor?full:0n):grossMinor>0n?roundRatio(full*receivedGrossMinor,grossMinor,'floor'):0n;
  return {payeeId:r.payeeId,kind:r.kind,method:r.method,valueMinor:r.valueMinor,release:r.release,fullMinor:full,releasedMinor:released};
 });
 const fullTotal=rows.reduce((s,r)=>s+r.fullMinor,0n),releasedTotal=rows.reduce((s,r)=>s+r.releasedMinor,0n),overAllocated=fullTotal>base;
 if(overAllocated&&!input.allowOverAllocation)throw new ApiError(400,'SHARING_EXCEEDS_TUITION_BASE');
 const collectedBase=cancelled?0n:grossMinor>0n?roundRatio(base*receivedGrossMinor,grossMinor,'floor'):0n;
 const externalFull=rows.filter(r=>r.kind!=='academy').reduce((s,r)=>s+r.fullMinor,0n),externalReleased=rows.filter(r=>r.kind!=='academy').reduce((s,r)=>s+r.releasedMinor,0n);
 return {baseMinor:base,collectedBaseMinor:collectedBase,percentageTotal,rows,fullTotalMinor:fullTotal,releasedTotalMinor:releasedTotal,unassignedFullMinor:base-fullTotal,
  academyFullMinor:base-externalFull,academyReleasedMinor:collectedBase-externalReleased,overAllocated,cashCoverageShortfallMinor:externalReleased>collectedBase?externalReleased-collectedBase:0n,cancelledByCredit:cancelled};
}

import {ApiError} from '../core/policy.ts';
import {formatMoneyTotal,readMinorUnits} from '../core/money.ts';
import {sumReferenceMinor} from '../core/exchange.ts';
import {requireReferenceCurrency,type ReferenceCurrencySource} from './reference-currency.ts';

export const outlookBaseMeasures=['openingCash','receivable','customerCredit','payable','supplierCredit','undatedReceivable','overdueReceivable','overduePayable','recordedCashChange','recordedHorizonReceivable','recordedHorizonCustomerCredit','recordedHorizonPayable','recordedHorizonSupplierCredit','horizonUnscheduledReceivable','horizonUnscheduledPayable','expectedReceipts','expectedBillPayments','unmatchedPlannedCosts','knownScenarioClosingCash'] as const;
export const outlookPayrollMeasures=['currentRecordedPayrollUnpaid','horizonRecordedPayrollUnpaid','expectedNetPayrollPayments','horizonUnscheduledPayroll','pastPlannedPayrollPay','payrollDueBeyondHorizon'] as const;
export const outlookFlows=['recordedCashChange','expectedReceipts','expectedBillPayments','unmatchedPlannedCosts'] as const;
export type OutlookQuote={id:string;baseCurrencyId:string;on:string;state:'recorded'|'void';rate:string|null;numerator:string|null;denominator:string|null;baseVersion:number;quoteVersion:number;source:string;reference:string};
export type OutlookReferenceSource={selection:ReferenceCurrencySource;neededCount:number;quotes:OutlookQuote[]};
type Money={minor:string;amount:string};
type Currency={currencyId:string;currencyCode:string;unitScale:number}&Record<string,unknown>;
type Source={on:string;through:string;snapshotAt:string;currencies:Currency[];chartData:Record<string,unknown>[];payrollIncludedInCashScenario:boolean;scheduledPayroll:{snapshotAt:string;currencies:{currencyId:string;currencyCode:string;unitScale:number;knownHourlySubtotal:Money;knownSalarySubtotal:Money;knownSubtotal:Money;estimatedTotal:Money|null}[]}};
export function outlookReferenceValuation(d:Source,raw:OutlookReferenceSource,rateOn:string){
 if(raw.neededCount>1000||raw.quotes.length>1000||d.currencies.length>1000||d.scheduledPayroll.currencies.length>1000||d.chartData.length>10000)throw new ApiError(422,'FINANCIAL_OUTLOOK_REQUIRES_BACKGROUND_JOB');
 if(d.scheduledPayroll.snapshotAt!==d.snapshotAt||new Set(d.currencies.map(c=>c.currencyId)).size!==d.currencies.length||new Set(d.scheduledPayroll.currencies.map(c=>c.currencyId)).size!==d.scheduledPayroll.currencies.length)throw Error('OUTLOOK_REFERENCE_SOURCE_INVALID');
 const target=requireReferenceCurrency(raw.selection),quotes=new Map(raw.quotes.map(q=>[q.baseCurrencyId,q]));if(quotes.size!==raw.quotes.length)throw Error('OUTLOOK_REFERENCE_SOURCE_INVALID');
 const sourceCurrencies=new Map<string,Currency>();for(const c of [...d.currencies,...d.scheduledPayroll.currencies]){const prior=sourceCurrencies.get(c.currencyId);if(prior&&prior.currencyCode!==c.currencyCode)throw Error('OUTLOOK_REFERENCE_SOURCE_INVALID');sourceCurrencies.set(c.currencyId,c);}
 if(sourceCurrencies.size>1000)throw new ApiError(422,'FINANCIAL_OUTLOOK_REQUIRES_BACKGROUND_JOB');
 const ratio=(id:string)=>{if(id===target.id)return {numerator:1n,denominator:1n};const q=quotes.get(id);return q?.state==='recorded'?{numerator:readMinorUnits(q.numerator!),denominator:readMinorUnits(q.denominator!)}:null;};
 const money=(v:unknown,scale:number):Money=>{const m=v as Money;if(!m||typeof m.minor!=='string'||m.amount!==formatMoneyTotal(readMinorUnits(m.minor),scale))throw Error('OUTLOOK_REFERENCE_MONEY_INVALID');return m;};
 const allMissing=new Set<string>();
 const convert=(rows:{currencyId:string;unitScale:number;value:unknown}[])=>{
  const missing=new Set<string>(),terms:Parameters<typeof sumReferenceMinor>[0]=[];
  for(const r of rows){const m=money(r.value,r.unitScale),rate=ratio(r.currencyId);if(rate)terms.push({minor:m.minor,sourceScale:r.unitScale,rate});else if(readMinorUnits(m.minor)!==0n){missing.add(r.currencyId);allMissing.add(r.currencyId);}}
  const knownSubtotal=sumReferenceMinor(terms,target.unitScale);return {complete:missing.size===0,total:missing.size?null:knownSubtotal,knownSubtotal,missingCurrencyIds:[...missing].sort()};
 };
 const fields=[...outlookBaseMeasures,...d.payrollIncludedInCashScenario?outlookPayrollMeasures:[]],totals=Object.fromEntries(fields.map(field=>[field,convert(d.currencies.map(c=>({currencyId:c.currencyId,unitScale:c.unitScale,value:c[field]})))]));
 const byDay=new Map<string,Map<string,Record<string,unknown>>>();for(const p of d.chartData){if(typeof p.on!=='string'||p.on<=d.on||p.on>d.through||typeof p.currencyId!=='string'||!d.currencies.some(c=>c.currencyId===p.currencyId&&c.unitScale===p.unitScale))throw Error('OUTLOOK_REFERENCE_CHART_INVALID');const day=byDay.get(p.on)??new Map();if(day.has(p.currencyId))throw Error('OUTLOOK_REFERENCE_CHART_INVALID');day.set(p.currencyId,p);byDay.set(p.on,day);}
 const balances=new Map(d.currencies.map(c=>[c.currencyId,money(c.openingCash,c.unitScale)])),flows=[...outlookFlows,...d.payrollIncludedInCashScenario?['expectedNetPayrollPayments']:[]];
 // ponytail: original report bounds cap1000currencies/10000source points and
 // a366-day horizon. Larger valuation/output must use background jobs.
 const chartData=[...byDay].sort(([a],[b])=>a.localeCompare(b)).map(([on,points])=>{
  for(const c of d.currencies){const point=points.get(c.currencyId);if(point)balances.set(c.currencyId,money(point.knownScenarioCash,c.unitScale));}
  return {on,...Object.fromEntries(flows.map(field=>[field,convert(d.currencies.map(c=>({currencyId:c.currencyId,unitScale:c.unitScale,value:points.get(c.currencyId)?.[field]??{minor:'0',amount:formatMoneyTotal(0n,c.unitScale)}})))])),knownScenarioCash:convert(d.currencies.map(c=>({currencyId:c.currencyId,unitScale:c.unitScale,value:balances.get(c.currencyId)})))};
 });
 const scheduledFields=['knownHourlySubtotal','knownSalarySubtotal','knownSubtotal'] as const,scheduledGross=Object.fromEntries(scheduledFields.map(field=>[field,convert(d.scheduledPayroll.currencies.map(c=>({currencyId:c.currencyId,unitScale:c.unitScale,value:c[field]})))])),unpriced=d.scheduledPayroll.currencies.some(c=>c.estimatedTotal===null),estimate=convert(d.scheduledPayroll.currencies.map(c=>({currencyId:c.currencyId,unitScale:c.unitScale,value:c.estimatedTotal??c.knownSubtotal})));
 const estimatedTotal={...estimate,complete:estimate.complete&&!unpriced,total:unpriced?null:estimate.total,unpricedSourceComponentsPresent:unpriced};
 return {rateOn,snapshotAt:d.snapshotAt,targetCurrency:target,targetSource:raw.selection.source,defaultsVersion:raw.selection.defaults_version,maximumAgeDays:raw.selection.maximum_age_days,maximumAgeSource:raw.selection.age_source,complete:allMissing.size===0,completenessBasis:'known_source_values_only_unpriced_work_remains_unpriced',missingCurrencyIds:[...allMissing].sort(),totals,chartData,scheduledGross:{...scheduledGross,estimatedTotal},rates:[...sourceCurrencies].sort(([a],[b])=>a.localeCompare(b)).map(([currencyId,c])=>({currencyId,currencyCode:c.currencyCode,sameCurrencyIdentity:currencyId===target.id,quote:currencyId===target.id?null:quotes.get(currencyId)??null})),roundingPolicy:'half_even_exact_cross_currency_sum_once_per_measure_and_day_not_sum_of_displayed_roundings',originalCurrencyAmountsRetained:true,scheduledGrossAddedToCashScenario:false,futureExchangeRatesPredicted:false,sourceIndependentlyVerified:false,ledgerAdjusted:false,paymentExecuted:false};
}

import {z} from 'zod';
import type {ApiContext,Reply} from '../core/api.ts';
import {ApiError} from '../core/policy.ts';
import {formatMoneyTotal,readMinorUnits} from '../core/money.ts';
import {convertReferenceMinor,sumReferenceMinor} from '../core/exchange.ts';
import {csvRow,csvText} from '../core/csv.ts';
import {financialAccountSelectionSQL,financialReportAccess,financialIds} from './financial-reports.ts';
import {journalPointLookupSQL} from './finance-journals.ts';
import {exchangeRateAuthority} from './exchange-rates.ts';
import {accountingDate} from './finance-periods.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const query=z.object({through:accountingDate,targetCurrencyId:uuid.optional(),rateOn:accountingDate.optional(),maximumAgeDays:z.coerce.number().int().min(0).max(3660).optional(),hubIds:financialIds.optional(),currencyIds:financialIds.optional(),accountIds:financialIds.optional(),includeZero:z.enum(['true','false']).default('false')}).strict();
type Rate={id:string;on:string;state:'recorded'|'void';rate:string|null;numerator:string|null;denominator:string|null;baseVersion:number;quoteVersion:number;source:string;reference:string};
type Entry={accountId:string;chartVersion:number;hubId:string|null;code:string;name:string;kind:'asset';normalBalance:'debit'|'credit';currencyId:string;currencyVersion:number;currencyCode:string;unitScale:number;closingMinor:string;rate:Rate|null};
type Result={snapshotAt:string;sourceCount:number;targetSource:'explicit'|'hub'|'school'|'unconfigured';defaultsVersion:number;maximumAgeDays:number;maximumAgeSource:'explicit'|'school'|'zero_days';target:{id:string;version:number;code:string;unitScale:number;active:boolean}|null;entries:Entry[]};
// Permissions and explicit account filters apply BEFORE source counts and
// indexed balance lookup. Quotes,target precision and original posted balances
// share ONE statement snapshot. More than2000selected accounts fails closed.
// ponytail: synchronous ceiling is2000accounts;larger complete valuations
// must use requester-bound report jobs rather than truncation or a longer wait.
const sql=`WITH settings AS MATERIALIZED(SELECT version,currency_id,maximum_rate_age_days FROM public.finance_reporting_preferences ORDER BY version DESC LIMIT 1),hub_default AS MATERIALIZED(
 SELECT h.currency FROM public.hubs h WHERE cardinality($6::uuid[])=1 AND h.id=($6::uuid[])[1] AND($1::boolean OR h.id=ANY($2::uuid[])) AND NOT h.id=ANY($3::uuid[])
),resolved AS MATERIALIZED(
 SELECT CASE WHEN $9::uuid IS NOT NULL THEN $9::uuid WHEN(SELECT currency FROM hub_default) IS NOT NULL THEN(SELECT id FROM public.finance_currency_catalogue WHERE code=(SELECT currency FROM hub_default)) ELSE(SELECT currency_id FROM settings) END currency_id,
 CASE WHEN $9::uuid IS NOT NULL THEN 'explicit' WHEN(SELECT currency FROM hub_default) IS NOT NULL THEN 'hub' WHEN EXISTS(SELECT 1 FROM settings) THEN 'school' ELSE 'unconfigured' END source,
 coalesce((SELECT version FROM settings),0) defaults_version,coalesce($11::integer,(SELECT maximum_rate_age_days FROM settings),0) maximum_age_days,
 CASE WHEN $11::integer IS NOT NULL THEN 'explicit' WHEN EXISTS(SELECT 1 FROM settings) THEN 'school' ELSE 'zero_days' END age_source
),selected AS MATERIALIZED(${financialAccountSelectionSQL} AND a.kind='asset'),bounded AS MATERIALIZED(SELECT * FROM selected ORDER BY code,id LIMIT 2001),balances AS(
 SELECT a.*,coalesce(l.closing_minor,0) closing_minor FROM bounded a CROSS JOIN LATERAL(
  SELECT sum(CASE WHEN l.side='debit' THEN l.amount_minor ELSE -l.amount_minor END) closing_minor FROM public.finance_journal_lines l ${journalPointLookupSQL} WHERE l.account_id=a.id AND j.posted_on<=$5::date
 ) l
),valued AS(
 SELECT a.id "accountId",a.version "chartVersion",a.hub_id "hubId",a.code,a.name,a.kind,a.normal_balance "normalBalance",a.currency_id "currencyId",a.currency_version "currencyVersion",a.currency_code "currencyCode",a.unit_scale "unitScale",a.closing_minor::text "closingMinor",
 (SELECT jsonb_build_object('id',r.id,'on',r.rate_on,'state',r.state,'rate',r.rate,'numerator',r.rate_numerator::text,'denominator',r.rate_denominator::text,'baseVersion',r.base_currency_version,'quoteVersion',r.quote_currency_version,'source',r.source,'reference',r.reference)
  FROM public.finance_exchange_rates r WHERE r.base_currency_id=a.currency_id AND r.quote_currency_id=(SELECT currency_id FROM resolved) AND r.rate_on BETWEEN $10::date-(SELECT maximum_age_days FROM resolved) AND $10::date AND NOT EXISTS(SELECT 1 FROM public.finance_exchange_rates c WHERE c.academy_id=r.academy_id AND c.supersedes_id=r.id) ORDER BY r.rate_on DESC,r.id LIMIT 1) rate
 FROM balances a WHERE $12::boolean OR a.closing_minor<>0
)
SELECT statement_timestamp()::text "snapshotAt",(SELECT count(*)::integer FROM selected) "sourceCount",(SELECT source FROM resolved) "targetSource",(SELECT defaults_version FROM resolved) "defaultsVersion",(SELECT maximum_age_days FROM resolved) "maximumAgeDays",(SELECT age_source FROM resolved) "maximumAgeSource",
 (SELECT jsonb_build_object('id',id,'version',version,'code',code,'unitScale',unit_scale,'active',active) FROM public.finance_currency_catalogue WHERE id=(SELECT currency_id FROM resolved)) target,
 coalesce((SELECT jsonb_agg(to_jsonb(valued) ORDER BY code,"accountId") FROM valued),'[]'::jsonb) entries`;
async function data(ctx:ApiContext){
 exchangeRateAuthority(ctx);const access=financialReportAccess(ctx,['currency-valuation.view','financial-reports.view','ledger.view','accounts.view']),p=new URL(ctx.request.url).searchParams;
 if(new Set(p.keys()).size!==[...p.keys()].length)throw new ApiError(400,'DUPLICATE_QUERY');const q=query.parse(Object.fromEntries(p)),rateOn=q.rateOn??q.through;
 const r=(await ctx.db.query<Result>(sql,[access.all,access.hubs,access.excluded,access.global,q.through,q.hubIds??null,q.currencyIds??null,q.accountIds??null,q.targetCurrencyId??null,rateOn,q.maximumAgeDays??null,q.includeZero==='true'])).rows[0];
 if(!r.target)throw new ApiError(q.targetCurrencyId?404:409,q.targetCurrencyId?'NOT_FOUND':r.targetSource==='hub'?'HUB_REPORTING_CURRENCY_NOT_CONFIGURED':'REPORTING_CURRENCY_NOT_CONFIGURED');if(!r.target.active&&r.targetSource!=='explicit')throw new ApiError(409,'DEFAULT_REPORTING_CURRENCY_RETIRED');if(r.sourceCount>2000)throw new ApiError(422,'REFERENCE_VALUATION_SOURCE_LIMIT');const target=r.target;
 const terms:Parameters<typeof sumReferenceMinor>[0]=[],missing=new Set<string>();
 const entries=r.entries.map(e=>{const same=e.currencyId===target.id,ratio=same?{numerator:1n,denominator:1n}:e.rate?.state==='recorded'?{numerator:readMinorUnits(e.rate.numerator!),denominator:readMinorUnits(e.rate.denominator!)}:null;
  // Zero assets contribute exactly zero without requiring a price. Nonzero
  // missing/withdrawn rates never become a guessed zero or an inverse quote.
  const zero=readMinorUnits(e.closingMinor)===0n,issue=ratio||zero?null:e.rate?'REFERENCE_RATE_WITHDRAWN':'REFERENCE_RATE_MISSING',converted=ratio?convertReferenceMinor(e.closingMinor,e.unitScale,target.unitScale,ratio):zero?convertReferenceMinor('0',e.unitScale,target.unitScale,{numerator:1n,denominator:1n}):null;
  if(issue)missing.add(e.currencyId);if(ratio)terms.push({minor:e.closingMinor,sourceScale:e.unitScale,rate:ratio});
  const {closingMinor,rate,...a}=e;return {...a,closing:{minor:readMinorUnits(closingMinor).toString(),amount:formatMoneyTotal(readMinorUnits(closingMinor),e.unitScale)},converted,issue,sameCurrencyIdentity:same,zeroBalanceNeedsNoRate:zero&&!ratio,rate:same?null:rate};
 });
 const knownSubtotal=sumReferenceMinor(terms,target.unitScale),complete=missing.size===0,whole=access.global&&!q.hubIds&&!q.accountIds&&!q.currencyIds;
 return {report:'posted_asset_reference_valuation',snapshotAt:r.snapshotAt,through:q.through,rateOn,maximumAgeDays:r.maximumAgeDays,maximumAgeSource:r.maximumAgeSource,targetSource:r.targetSource,defaultsVersion:r.defaultsVersion,targetCurrency:target,coverage:whole?'all_permitted_asset_accounts':'scoped_selected_asset_accounts',schoolWide:whole,sourceCount:r.sourceCount,accountCount:entries.length,complete,missingCurrencyIds:[...missing].sort(),total:complete?knownSubtotal:null,knownSubtotal,entries,
  postingBasis:'signed_debit_minus_credit_all_posted_lines_through_date',chartBasis:'current_asset_account_classification',roundingPolicy:'half_even_consolidated_exact_total_once_individual_rounded_rows_may_not_sum',referenceOnly:true,sourceIndependentlyVerified:false,ledgerAdjusted:false,moneyMovementPerformed:false,fxGainLossPosted:false,inventoryPurchaseCostAdded:false,formalBalanceSheet:false};
}
export async function assetCurrencyValuation(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/asset-valuation')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');return {status:200,body:{data:await data(ctx)}};
}
export async function completeAssetCurrencyValuationExport(ctx:ApiContext,provenance?:unknown):Promise<Reply>{
 const d=await data(ctx),rows:string[]=[];
 const row=(...v:Parameters<typeof csvRow>[0])=>rows.push(csvRow(Array.from({length:26},(_,i)=>v[i]))),meta=(key:string,v:string|number|boolean|null)=>row('metadata',key,typeof v==='string'?csvText(v):v);
 row('section','field_or_accountId','value_or_hubId','code','name','chartVersion','currencyId','currencyVersion','currencyCode','unitScale','closingMinor','closingAmount','convertedMinor','convertedAmount','issue','rateId','rateOn','majorUnitRate','rateNumerator','rateDenominator','rateBaseVersion','rateQuoteVersion','source','reference','sameCurrencyIdentity','zeroBalanceNeedsNoRate');
 meta('targetCurrencyVersion',d.targetCurrency.version);meta('missingCurrencyIds',JSON.stringify(d.missingCurrencyIds));
 meta('targetSource',d.targetSource);meta('defaultsVersion',d.defaultsVersion);meta('maximumAgeSource',d.maximumAgeSource);
 meta('report',d.report);meta('snapshotAt',d.snapshotAt);meta('through',d.through);meta('rateOn',d.rateOn);meta('maximumAgeDays',d.maximumAgeDays);meta('targetCurrency',d.targetCurrency.code);meta('targetCurrencyId',d.targetCurrency.id);meta('targetUnitScale',d.targetCurrency.unitScale);meta('coverage',d.coverage);meta('sourceCount',d.sourceCount);meta('accountCount',d.accountCount);meta('complete',d.complete);meta('roundingPolicy',d.roundingPolicy);meta('referenceOnly',true);meta('ledgerAdjusted',false);meta('fxGainLossPosted',false);meta('inventoryPurchaseCostAdded',false);meta('sourceIndependentlyVerified',false);meta('numericPolicy','Exact decimal text;import as text to avoid spreadsheet precision loss.');
 row('summary','completeTotalMinor','completeTotalAmount','knownSubtotalMinor','knownSubtotalAmount','totalExactNumerator','totalExactDenominator','subtotalExactNumerator','subtotalExactDenominator');row('summary',d.total?.minor,d.total?.amount,d.knownSubtotal.minor,d.knownSubtotal.amount,d.total?.exact.numerator,d.total?.exact.denominator,d.knownSubtotal.exact.numerator,d.knownSubtotal.exact.denominator);
 if(provenance)meta('provenance',JSON.stringify(provenance));
 row('account','accountId','hubId','code','name','chartVersion','currencyId','currencyVersion','currencyCode','unitScale','closingMinor','closingAmount','convertedMinor','convertedAmount','issue','rateId','rateOn','majorUnitRate','rateNumerator','rateDenominator','rateBaseVersion','rateQuoteVersion','source','reference','sameCurrencyIdentity','zeroBalanceNeedsNoRate');
 for(const e of d.entries)row('account',e.accountId,e.hubId,csvText(e.code),csvText(e.name),e.chartVersion,e.currencyId,e.currencyVersion,e.currencyCode,e.unitScale,e.closing.minor,e.closing.amount,e.converted?.minor,e.converted?.amount,e.issue,e.rate?.id,e.rate?.on,e.rate?.rate,e.rate?.numerator,e.rate?.denominator,e.rate?.baseVersion,e.rate?.quoteVersion,e.rate?csvText(e.rate.source):null,e.rate?csvText(e.rate.reference):null,e.sameCurrencyIdentity,e.zeroBalanceNeedsNoRate);
 const body='\uFEFF'+rows.join('\r\n')+'\r\n';if(Buffer.byteLength(body,'utf8')>4*1024*1024)throw new ApiError(422,'REFERENCE_VALUATION_EXPORT_SIZE_LIMIT');return {status:200,csv:{filename:'asset-reference-valuation-'+d.through+'.csv'},body};
}
export async function assetCurrencyValuationExport(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/finance/asset-valuation/export')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');return completeAssetCurrencyValuationExport(ctx);
}
const summary='One-snapshot permitted posted ASSET balances,original currency precision,current chart classification and approved DIRECT reference prices in an explicitly selected target currency. Intersect valuation/report/ledger/account scopes before counts and totals;global reference-rate/currency rights also required. Signed debit-minus-credit balances,half-even rounding of exact consolidated total ONCE. Missing or withdrawn nonzero prices give incomplete/null total,never invented conversion. Not all-school net worth,formal balance sheet,market verification,trade,posted FX gain/loss or additional expensed-inventory assets. Refuses more than2000selected source accounts;no partial paging.';
const defaultsSummary=' Optional targetCurrencyId resolves explicit selection,then an explicitly selected single permitted hub\u2019s existing currency,then reviewed school defaults;unconfigured/retired defaults fail explicitly,never guessed CAD. Optional maximumAgeDays uses explicit input,then reviewed school setting,then zero. Settings,hub selection,currency precision,quotes and balances share the same statement snapshot. Defaults never grant source access.';
export const assetCurrencyValuationContract=[{path:'/api/v1/reports/finance/asset-valuation',method:'get',summary:summary+defaultsSummary,querySchema:query}] as const;
export const assetCurrencyValuationExportContract=[{path:'/api/v1/reports/finance/asset-valuation/export',method:'get',summary:summary+defaultsSummary+' Complete CSV of the same bounded report;4MiB ceiling refuses a partial file,source free text is formula-protected and numeric text stays exact.',querySchema:query,responseContentType:'text/csv'}] as const;

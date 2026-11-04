import { ApiError } from './policy.ts';

// Exact fixed-point values; never route posted money through Number/parseFloat.
// Currency precision and rounding rules must be explicit, versioned settings.
export const maximumMinorUnits=10n**38n-1n;
const absolute=(value:bigint)=>value<0n?-value:value;
function precision(scale:number){if(!Number.isInteger(scale)||scale<0||scale>18)throw new ApiError(400,'INVALID_CURRENCY_PRECISION');}
function amount(value:bigint){if(typeof value!=='bigint'||absolute(value)>maximumMinorUnits)throw new ApiError(400,'INVALID_MONEY_AMOUNT');}
// PostgreSQL numeric retains scale: the valid integral value 100.00 must not
// make BigInt conversion fail. Never round fractional minor units or accept
// Numbers, exponent notation or corrupt stored values. Aggregate sums may
// exceed the separate per-posting bound enforced by parseMoney/database CHECK.
export function readMinorUnits(value:string):bigint {
  if(typeof value!=='string'||!/^-?\d+(?:\.0+)?$/.test(value))throw new Error('INVALID_STORED_MINOR_UNITS');
  return BigInt(value.replace(/\.0+$/,''));
}
export function parseMoney(value:string,scale:number):bigint {
  precision(scale);if(typeof value!=='string'||value.length>80||!/^[-]?\d+(?:\.\d+)?$/.test(value))throw new ApiError(400,'INVALID_MONEY_AMOUNT');
  const negative=value.startsWith('-'),[whole,fraction='']=(negative?value.slice(1):value).split('.'),exact=fraction.replace(/0+$/,'');
  if(exact.length>scale)throw new ApiError(400,'MONEY_PRECISION_EXCEEDED');
  const result=BigInt(whole+exact.padEnd(scale,'0'))*(negative?-1n:1n);amount(result);return result;
}
export function formatMoney(value:bigint,scale:number):string {
  amount(value);return formatMoneyTotal(value,scale);
}
// A sum of valid posted lines can exceed the per-line 38-digit bound. Keep
// aggregates exact as well; this does not relax parseMoney's posting limit.
export function formatMoneyTotal(value:bigint,scale:number):string {
  precision(scale);if(typeof value!=='bigint')throw new ApiError(400,'INVALID_MONEY_AMOUNT');
  const digits=absolute(value).toString().padStart(scale+1,'0'),sign=value<0n?'-':'';
  return sign+(scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits);
}
export const roundingModes=['toward_zero','away_from_zero','floor','ceil','half_away','half_even'] as const;
export type RoundingMode=typeof roundingModes[number];
export function roundRatio(numerator:bigint,denominator:bigint,mode:RoundingMode):bigint {
  if(typeof numerator!=='bigint'||typeof denominator!=='bigint'||denominator<=0n||!roundingModes.includes(mode))throw new ApiError(400,'INVALID_MONEY_RATIO');
  // BigInt division truncates towards zero; handle signed ties explicitly.
  // https://tc39.es/ecma262/#sec-numeric-types-bigint-divide
  const quotient=numerator/denominator,remainder=numerator%denominator,sign=numerator<0n?-1n:1n;
  if(remainder===0n||mode==='toward_zero')return quotient;
  if(mode==='away_from_zero'||(mode==='floor'&&sign<0n)||(mode==='ceil'&&sign>0n))return quotient+sign;
  if(mode==='floor'||mode==='ceil')return quotient;
  const twice=absolute(remainder)*2n;
  return twice>denominator||(twice===denominator&&(mode==='half_away'||quotient%2n!==0n))?quotient+sign:quotient;
}
// Inventory purchase-cost shares can be fractional minor units. Sum reduced
// ratios before rounding, rather than losing pennies on every stock row.
// Each denominator is a stored lot quantity (at most one billion); reducing
// only against the small shared factors avoids growing-integer GCD loops.
export const maximumSynchronousInventoryValueTerms=1000;
export function sumInventoryValueRatios(terms:{numerator:bigint;denominator:bigint}[]){
  if(!Array.isArray(terms)||terms.length>maximumSynchronousInventoryValueTerms)throw new ApiError(422,'REPORT_REQUIRES_BACKGROUND_JOB');
  const gcd=(a:bigint,b:bigint):bigint=>{while(b){const r=a%b;a=b;b=r;}return a;};
  let numerator=0n,denominator=1n;
  for(const t of terms){
    if(!t||typeof t.numerator!=='bigint'||typeof t.denominator!=='bigint'||t.numerator<0n||t.denominator<1n||t.denominator>1000000000n||t.numerator.toString().length>100)throw new ApiError(400,'INVALID_MONEY_RATIO');
    if(t.numerator===0n)continue;
    const reduced=gcd(t.numerator,t.denominator),n=t.numerator/reduced,d=t.denominator/reduced,shared=gcd(denominator,d);
    const next=numerator*(d/shared)+n*(denominator/shared),cancel=gcd(next,shared);
    numerator=next/cancel;denominator=(denominator/shared)*(d/cancel);
  }
  return {numerator,denominator};
}
export function taxAmounts(value:bigint,rateMillionths:bigint,pricing:'tax_inclusive'|'tax_exclusive'|'not_applicable') {
  amount(value);
  if(typeof rateMillionths!=='bigint'||rateMillionths<0n||rateMillionths>1000000n||!['tax_inclusive','tax_exclusive','not_applicable'].includes(pricing)
    ||(pricing==='not_applicable'&&rateMillionths!==0n))throw new ApiError(400,'INVALID_TAX_CALCULATION');
  const tax=roundRatio(value*rateMillionths,pricing==='tax_inclusive'?1000000n+rateMillionths:1000000n,'half_away');
  const net=pricing==='tax_inclusive'?value-tax:value,gross=pricing==='tax_inclusive'?value:value+tax;
  amount(net);amount(tax);amount(gross);return {net,tax,gross};
}
export function allocateMoney(total:bigint,weights:{key:string;weight:bigint}[]):{key:string;amount:bigint}[] {
  amount(total);
  if(!Array.isArray(weights)||weights.length<1||weights.length>1000||weights.some(w=>!w||typeof w.key!=='string'||w.key.length<1||w.key.length>100||!w.key.isWellFormed()||w.key.includes('\0')||typeof w.weight!=='bigint'||w.weight<0n||w.weight>maximumMinorUnits)||new Set(weights.map(w=>w.key)).size!==weights.length)throw new ApiError(400,'INVALID_MONEY_ALLOCATION');
  const denominator=weights.reduce((sum,w)=>sum+w.weight,0n);if(denominator===0n)throw new ApiError(400,'INVALID_MONEY_ALLOCATION');
  const magnitude=absolute(total),sign=total<0n?-1n:1n;
  const rows=weights.map(w=>({key:w.key,amount:magnitude*w.weight/denominator,remainder:magnitude*w.weight%denominator}));
  const residual=magnitude-rows.reduce((sum,r)=>sum+r.amount,0n);
  const ranked=[...rows].sort((a,b)=>a.remainder!==b.remainder?(a.remainder>b.remainder?-1:1):a.key<b.key?-1:a.key>b.key?1:0);
  // Largest remainders conserve every minor unit; residual is strictly less
  // than the bounded row count. Stable keys make ties input-order independent.
  for(let i=0;i<Number(residual);i++)ranked[i].amount++;
  return rows.map(r=>({key:r.key,amount:r.amount*sign}));
}

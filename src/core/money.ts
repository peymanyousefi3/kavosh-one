import { ApiError } from './policy.ts';

// Exact fixed-point values; never route posted money through Number/parseFloat.
// Currency precision and rounding rules must be explicit, versioned settings.
export const maximumMinorUnits=10n**38n-1n;
const absolute=(value:bigint)=>value<0n?-value:value;
function precision(scale:number){if(!Number.isInteger(scale)||scale<0||scale>18)throw new ApiError(400,'INVALID_CURRENCY_PRECISION');}
function amount(value:bigint){if(typeof value!=='bigint'||absolute(value)>maximumMinorUnits)throw new ApiError(400,'INVALID_MONEY_AMOUNT');}
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

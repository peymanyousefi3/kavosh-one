import {readMinorUnits,formatMoneyTotal,roundRatio} from './money.ts';

// Reference prices are major currency units,never minor-unit multipliers.
// Keep decimal prices and signed aggregate money out of binary floating point.
export function exchangeRatio(rate:string){
 if(typeof rate!=='string'||!/^(0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(rate))throw Error('INVALID_EXCHANGE_RATE');
 const [whole,raw='']=rate.split('.'),fraction=raw.replace(/0+$/,''),numerator=BigInt(whole+fraction),denominator=10n**BigInt(fraction.length);
 if(numerator<=0n)throw Error('INVALID_EXCHANGE_RATE');return {numerator,denominator};
}
export function convertReferenceMinor(minor:string,sourceScale:number,targetScale:number,rate:{numerator:bigint;denominator:bigint}){
 for(const scale of [sourceScale,targetScale])if(!Number.isInteger(scale)||scale<0||scale>18)throw Error('INVALID_CURRENCY_PRECISION');
 if(typeof rate.numerator!=='bigint'||typeof rate.denominator!=='bigint'||rate.numerator<=0n||rate.numerator>=10n**36n||rate.denominator>10n**18n||!/^10*$/.test(rate.denominator.toString()))throw Error('INVALID_EXCHANGE_RATE');
 const numerator=readMinorUnits(minor)*rate.numerator*10n**BigInt(targetScale),denominator=rate.denominator*10n**BigInt(sourceScale),rounded=roundRatio(numerator,denominator,'half_even');
 return {minor:rounded.toString(),amount:formatMoneyTotal(rounded,targetScale),exact:{numerator:numerator.toString(),denominator:denominator.toString()},rounding:'half_even' as const,rounded:numerator!==rounded*denominator};
}
// Decimal prices and currency scales give power-of-ten denominators. Align
// them exactly;round the consolidated signed total once,not each account.
export function sumReferenceMinor(terms:{minor:string;sourceScale:number;rate:{numerator:bigint;denominator:bigint}}[],targetScale:number){
 if(terms.length>2000)throw Error('REFERENCE_VALUATION_SOURCE_LIMIT');
 let numerator=0n,denominator=1n;
 for(const t of terms){const v=convertReferenceMinor(t.minor,t.sourceScale,targetScale,t.rate),n=BigInt(v.exact.numerator),d=BigInt(v.exact.denominator);if(d>denominator){numerator*=d/denominator;denominator=d;}numerator+=n*(denominator/d);}
 const minor=roundRatio(numerator,denominator,'half_even');return {minor:minor.toString(),amount:formatMoneyTotal(minor,targetScale),exact:{numerator:numerator.toString(),denominator:denominator.toString()},rounding:'half_even' as const,rounded:numerator!==minor*denominator};
}

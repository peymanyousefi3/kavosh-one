import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMoney,formatMoney,roundRatio,roundingModes,allocateMoney,maximumMinorUnits } from '../src/core/money.ts';

test('money parses exact decimals beyond floating-point safety with explicit currency precision and no silent rounding',()=>{
  assert.equal(parseMoney('9007199254740993.01',2),900719925474099301n);assert.equal(formatMoney(900719925474099301n,2),'9007199254740993.01');
  for(const [text,scale,minor,display] of [['0001.2000',2,120n,'1.20'],['-0.00',2,0n,'0.00'],['123.000',0,123n,'123'],['-0.001',3,-1n,'-0.001'],['0.000000000000000001',18,1n,'0.000000000000000001']] as const){assert.equal(parseMoney(text,scale),minor);assert.equal(formatMoney(minor,scale),display);}
  assert.throws(()=>parseMoney('1.001',2),/MONEY_PRECISION_EXCEEDED/);assert.throws(()=>parseMoney('0.1',0),/MONEY_PRECISION_EXCEEDED/);
});
test('money rejects numbers, non-decimal forms, overflow and invalid precision rather than losing cents or guessing locale',()=>{
  for(const value of ['','1e2','0x10','NaN','Infinity','1,000.00',' 1.00','$1.00','.5','1.','+1','--1','1\n',1 as unknown as string])assert.throws(()=>parseMoney(value,2),/INVALID_MONEY_AMOUNT/);
  for(const scale of [-1,19,1.5,NaN,Infinity]){assert.throws(()=>parseMoney('1',scale),/INVALID_CURRENCY_PRECISION/);assert.throws(()=>formatMoney(1n,scale),/INVALID_CURRENCY_PRECISION/);}
  assert.equal(parseMoney(maximumMinorUnits.toString(),0),maximumMinorUnits);assert.throws(()=>parseMoney((maximumMinorUnits+1n).toString(),0),/INVALID_MONEY_AMOUNT/);assert.throws(()=>formatMoney(maximumMinorUnits+1n,2),/INVALID_MONEY_AMOUNT/);assert.throws(()=>formatMoney(1 as unknown as bigint,2),/INVALID_MONEY_AMOUNT/);
  for(let scale=0;scale<=18;scale++)for(const minor of [maximumMinorUnits,-maximumMinorUnits,1n,-1n,0n])assert.equal(parseMoney(formatMoney(minor,scale),scale),minor);
});
test('rational rounding has explicit signed tie, floor, ceiling and truncation behavior with no default financial policy',()=>{
  const expected={toward_zero:[2n,-2n],away_from_zero:[3n,-3n],floor:[2n,-3n],ceil:[3n,-2n],half_away:[3n,-3n],half_even:[2n,-2n]};
  for(const mode of roundingModes){assert.equal(roundRatio(5n,2n,mode),expected[mode][0]);assert.equal(roundRatio(-5n,2n,mode),expected[mode][1]);assert.equal(roundRatio(6n,2n,mode),3n);}
  assert.equal(roundRatio(7n,2n,'half_even'),4n);assert.equal(roundRatio(-7n,2n,'half_even'),-4n);assert.equal(roundRatio(1n,3n,'half_away'),0n);assert.equal(roundRatio(-2n,3n,'half_even'),-1n);
  for(const denominator of [0n,-1n])assert.throws(()=>roundRatio(1n,denominator,'half_even'),/INVALID_MONEY_RATIO/);assert.throws(()=>roundRatio(1n,2n,'guess' as typeof roundingModes[number]),/INVALID_MONEY_RATIO/);
});
test('largest-remainder allocation conserves positive and negative totals and resolves ties by stable key, not input order',()=>{
  const weights=[{key:'b',weight:1n},{key:'a',weight:1n},{key:'c',weight:1n}];
  assert.deepEqual(allocateMoney(100n,weights),[{key:'b',amount:33n},{key:'a',amount:34n},{key:'c',amount:33n}]);
  assert.deepEqual(allocateMoney(-100n,weights),[{key:'b',amount:-33n},{key:'a',amount:-34n},{key:'c',amount:-33n}]);
  for(let total=-100;total<=100;total++)for(let count=1;count<=10;count++) {
    const entries=Array.from({length:count},(_,i)=>({key:String(i).padStart(3,'0'),weight:BigInt(i+1)})),a=allocateMoney(BigInt(total),entries),b=allocateMoney(BigInt(total),entries.toReversed()).toReversed();
    assert.deepEqual(a,b);assert.equal(a.reduce((sum,r)=>sum+r.amount,0n),BigInt(total));
  }
  assert.deepEqual(allocateMoney(1n,[{key:'zero',weight:0n},{key:'one',weight:2n}]),[{key:'zero',amount:0n},{key:'one',amount:1n}]);
  const large=allocateMoney(maximumMinorUnits,[{key:'a',weight:maximumMinorUnits},{key:'b',weight:maximumMinorUnits}]);assert.equal(large[0].amount,(maximumMinorUnits+1n)/2n);assert.equal(large[0].amount+large[1].amount,maximumMinorUnits);
});
test('invalid or unbounded allocation inputs fail before calculating shares',()=>{
  for(const weights of [[],[{key:'a',weight:0n}],[{key:'a',weight:-1n}],[{key:'a',weight:1n},{key:'a',weight:2n}],[{key:'',weight:1n}],Array.from({length:1001},(_,i)=>({key:String(i),weight:1n}))])assert.throws(()=>allocateMoney(100n,weights),/INVALID_MONEY_ALLOCATION/);
  assert.throws(()=>allocateMoney(maximumMinorUnits+1n,[{key:'a',weight:1n}]),/INVALID_MONEY_AMOUNT/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expenseBillAmounts,type ExpenseLineInput } from '../src/core/expense-bill.ts';

const line:ExpenseLineInput={amount:'100',pricing:'tax_exclusive',classification:'taxable',ratePercent:'13',recoverablePercent:'100'};
test('expense bills distinguish charged tax, declared input credit and nonrecoverable cost with exact balanced totals',()=>{
 const full=expenseBillAmounts(2,[line]);assert.deepEqual(full.totals,{net:10000n,tax:1300n,gross:11300n,recoverable:1300n,nonrecoverable:0n,expense:10000n});
 const half=expenseBillAmounts(2,[{...line,recoverablePercent:'50'}]);assert.equal(half.totals.expense,10650n);assert.equal(half.totals.recoverable,650n);assert.equal(half.totals.expense+half.totals.recoverable,half.totals.gross);
 const none=expenseBillAmounts(2,[{...line,recoverablePercent:'0'}]);assert.equal(none.totals.expense,11300n);assert.equal(none.totals.recoverable,0n);
});
test('inclusive and explicit zero-tax expense lines never create an automatic input credit or tax exemption',()=>{
 const inclusive=expenseBillAmounts(2,[{...line,amount:'113',pricing:'tax_inclusive'}]);assert.equal(inclusive.totals.net,10000n);assert.equal(inclusive.totals.tax,1300n);
 for(const classification of ['zero_rated','exempt','out_of_scope'] as const){const result=expenseBillAmounts(2,[{...line,classification,ratePercent:'0',pricing:classification==='zero_rated'?'tax_exclusive':'not_applicable'}]);assert.equal(result.totals.gross,10000n);assert.equal(result.totals.recoverable,0n);}
});
test('per-line rounding conserves gross and remains exact beyond floating-point safety',()=>{
 const small=expenseBillAmounts(2,[{...line,amount:'0.05',recoverablePercent:'50'},{...line,amount:'0.05',recoverablePercent:'0'}]);assert.equal(small.lines[0].tax,1n);assert.equal(small.lines[0].recoverable,1n);assert.equal(small.totals.expense+small.totals.recoverable,small.totals.gross);
 const large=expenseBillAmounts(2,[{...line,amount:'9007199254740993.01',recoverablePercent:'33.3333'}]);assert.equal(large.totals.net,900719925474099301n);assert.equal(large.totals.expense+large.totals.recoverable,large.totals.gross);
});
test('invalid, empty, oversized, inexact and contradictory expense inputs fail rather than silently changing tax',()=>{
 for(const input of [[],Array.from({length:51},()=>line),[{...line,amount:'0'}],[{...line,amount:'-1'}],[{...line,amount:'1.001'}],[{...line,recoverablePercent:'100.0001'}],[{...line,recoverablePercent:'0.00001'}],[{...line,classification:'exempt',pricing:'tax_exclusive'}],[{...line,ratePercent:'0'}],[{...line,pricing:'not_applicable'}]] as ExpenseLineInput[][])assert.throws(()=>expenseBillAmounts(2,input));
 assert.throws(()=>expenseBillAmounts(19,[line]));assert.throws(()=>expenseBillAmounts(2,[{...line,amount:'999999999999999999999999999999999999',ratePercent:'100'},{...line,amount:'999999999999999999999999999999999999',ratePercent:'100'}]));
 const large:ExpenseLineInput={...line,amount:'6'+'0'.repeat(35),classification:'exempt',ratePercent:'0',recoverablePercent:'0',pricing:'not_applicable'};assert.equal(expenseBillAmounts(2,[large]).totals.gross,6n*10n**37n);assert.throws(()=>expenseBillAmounts(2,[large,large]),/EXPENSE_BILL_TOO_LARGE/);
});

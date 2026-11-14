import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBankStatement } from '../src/core/bank-statement.ts';
const mapping={dateColumn:'Date',dateFormat:'YYYY-MM-DD',amount:{kind:'signed',column:'Amount',positiveSide:'debit'},descriptionColumn:'Memo',referenceColumn:'Ref'};
test('bank CSV parsing preserves quoted commas, multiline UTF-8/BOM and exact amounts without evaluating formulas',()=>{
 const result=parseBankStatement({mapping,csv:'\ufeffDate,Amount,Memo,Ref\r\n2026-01-01,9007199254740993.01,"家長, payment",R1\r\n2026-01-02,(10.25),"line one\nline two","=HYPERLINK(""x"")"\r\n'},2);
 assert.equal(result.rows[0].debitNetMinor,'900719925474099301');assert.equal(result.rows[0].description,'家長, payment');assert.equal(result.rows[1].debitNetMinor,'-1025');assert.equal(result.rows[1].description,'line one\nline two');assert.equal(result.rows[1].spreadsheetUnsafeText,true);assert.equal(result.sourceVerified,false);assert.equal(result.rows.length,2);
});
test('explicit European decimal/group/date mappings and split debit/credit columns never infer a locale or net two active columns',()=>{
 const result=parseBankStatement({mapping:{delimiter:';',dateColumn:'Date',dateFormat:'DD/MM/YYYY',decimalSeparator:',',groupSeparator:'.',amount:{kind:'split',positiveColumn:'In',negativeColumn:'Out'}},csv:'Date;In;Out\n03/02/2026;1.234,56;\n04/02/2026;;2,01\n'},2);
 assert.equal(result.rows[0].postedOn,'2026-02-03');assert.equal(result.rows[0].debitNetMinor,'123456');assert.equal(result.totals.net.amount,'1232.55');
 assert.throws(()=>parseBankStatement({mapping:{...result.mapping},csv:'Date;In;Out\n03/02/2026;1,00;2,00\n'},2),/INVALID_STATEMENT_ROW_1/);
 const inverse=parseBankStatement({mapping:{dateColumn:'Date',dateFormat:'MM/DD/YYYY',amount:{kind:'signed',column:'Amount',positiveSide:'credit'}},csv:'Date,Amount\n03/02/2026,5\n'},2);assert.equal(inverse.rows[0].postedOn,'2026-03-02');assert.equal(inverse.rows[0].debitNetMinor,'-500');
});
test('malformed quotes, duplicate headers, invalid dates/numbers and excessive/ambiguous inputs fail without copying bank text into errors',()=>{
 for(const csv of ['Date,Amount,Memo,Ref\n2026-01-01,1,"private unclosed,R1','Date,Date,Amount,Memo,Ref\n2026-01-01,x,1,m,r','Date,Amount,Memo,Ref\n2026-02-30,1,private,r','Date,Amount,Memo,Ref\n2026-01-01,1.001,private,r','Date,Amount,Memo,Ref\n2026-01-01,1e2,private,r','Date,Amount,Memo,Ref\n2026-01-01,0,private,r']){
  try{parseBankStatement({csv,mapping},2);assert.fail('Invalid CSV accepted');}catch(error){assert.doesNotMatch(String(error),/private|unclosed/);}
 }
 assert.throws(()=>parseBankStatement({csv:'Date,Amount\n'+Array(501).fill('2026-01-01,1').join('\n'),mapping:{dateColumn:'Date',dateFormat:'YYYY-MM-DD',amount:mapping.amount}},2),/1_TO_500_ROWS/);
 assert.throws(()=>parseBankStatement({csv:'x'.repeat(262145),mapping},2));
 assert.throws(()=>parseBankStatement({csv:'Date,Amount\n2026-01-01,1',mapping:{...mapping,decimalSeparator:',',groupSeparator:','}},2));
});
test('identical legitimate transaction rows remain distinct while exact raw source and mapping fingerprints are stable',()=>{
 const csv='Date,Amount,Memo,Ref\n2026-01-01,1,Same,Same\n2026-01-01,1,Same,Same\n',a=parseBankStatement({csv,mapping},2),b=parseBankStatement({csv,mapping},2);assert.deepEqual(a,b);assert.equal(a.rows.length,2);assert.equal(a.rows[0].line,1);assert.equal(a.rows[1].line,2);
 const opposite=parseBankStatement({csv,mapping:{...mapping,amount:{...mapping.amount,positiveSide:'credit'}}},2);assert.equal(opposite.sourceHash,a.sourceHash);assert.notEqual(opposite.importHash,a.importHash);
});

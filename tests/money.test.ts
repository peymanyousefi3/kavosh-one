import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMoney,formatMoney,roundRatio,roundingModes,allocateMoney,maximumMinorUnits,readMinorUnits,taxAmounts } from '../src/core/money.ts';
import { calculateNetPay } from '../src/core/net-pay-plan.ts';
import { calculateCanadianContributions } from '../src/core/canadian-payroll-contributions.ts';

const contributionInput=()=>({taxYear:2026,currency:'CAD',provinceOfEmployment:'ON',paymentKind:'regular_salary_or_wages',payPeriodsPerYear:52,cppPensionableMonths:12,pensionableEarnings:'1000.00',pensionableEarningsYtd:'0.00',employeeCppYtd:'0.00',employeeCpp2Ytd:'0.00',insurableEarnings:'550.00',employeeEiYtd:'0.00',employerEiPlan:'standard_1_4',noQuebecTransfer:true,sameEmployerYtdConfirmed:true,eligibilityReview:'Synthetic explicitly reviewed same-employer inputs,not legal certification'});
test('2026 Canadian contribution arithmetic follows CRA exemption truncation and published EI example without calculating income tax',()=>{
 const r=calculateCanadianContributions(contributionInput());assert.equal(r.cppBasicExemption,'67.30');assert.deepEqual(r.employee,{cpp:'55.50',cpp2:'0.00',ei:'8.97',total:'64.47'});assert.deepEqual(r.employer,{cpp:'55.50',cpp2:'0.00',ei:'12.56',total:'68.06'});for(const k of ['incomeTaxCalculated','fullPayrollCalculated','eligibilityVerified','yearToDateVerified','statutoryCertification','paymentExecuted','additionalLedgerPosting'] as const)assert.equal(r[k],false);
 const monthly=calculateCanadianContributions({...contributionInput(),payPeriodsPerYear:12,pensionableEarnings:'5000.00',insurableEarnings:'5000.00'});assert.equal(monthly.cppBasicExemption,'291.66');assert.deepEqual(monthly.employee,{cpp:'280.15',cpp2:'0.00',ei:'81.50',total:'361.65'});assert.deepEqual(monthly.employer,{cpp:'280.15',cpp2:'0.00',ei:'114.10',total:'394.25'});
 const bonus=calculateCanadianContributions({...contributionInput(),paymentKind:'standalone_non_periodic',insurableEarnings:'1000.00'});assert.equal(bonus.cppBasicExemption,'0.00');assert.equal(bonus.employee.cpp,'59.50');assert.equal(bonus.employee.ei,'16.30');
});
test('2026 Canadian contributions cap exact YTD amounts and start CPP2 only at the prorated earnings threshold',()=>{
 const cap=calculateCanadianContributions({...contributionInput(),pensionableEarningsYtd:'74600.00',employeeCppYtd:'4230.40',employeeCpp2Ytd:'415.99',employeeEiYtd:'1123.05'});assert.deepEqual(cap.employee,{cpp:'0.05',cpp2:'0.01',ei:'0.02',total:'0.08'});assert.equal(cap.employer.ei,'0.03');
 const crossed=calculateCanadianContributions({...contributionInput(),pensionableEarningsYtd:'74599.99',pensionableEarnings:'0.02'});assert.equal(crossed.employee.cpp2,'0.00');const crossedDollar=calculateCanadianContributions({...contributionInput(),pensionableEarningsYtd:'74000.00'});assert.equal(crossedDollar.employee.cpp2,'16.00');
 const noCpp=calculateCanadianContributions({...contributionInput(),cppPensionableMonths:0});assert.equal(noCpp.employee.cpp,'0.00');assert.equal(noCpp.employee.cpp2,'0.00');assert.equal(noCpp.employee.ei,'8.97');
 const partial=calculateCanadianContributions({...contributionInput(),cppPensionableMonths:1,pensionableEarnings:'100000.00'});assert.equal(partial.employee.cpp,'352.54');assert.equal(partial.employee.cpp2,'34.67');const over=calculateCanadianContributions({...contributionInput(),employeeCppYtd:'5000.00',employeeCpp2Ytd:'500.00',employeeEiYtd:'2000.00'});assert.deepEqual(over.employee,{cpp:'0.00',cpp2:'0.00',ei:'0.00',total:'0.00'});assert.deepEqual(over.ytdExceedsProratedLimits,{cpp:true,cpp2:true,ei:true});
});
test('2026 contribution inputs reject wrong years currencies Quebec transfers unreviewed scope and imprecise money',()=>{
 for(const patch of [{taxYear:2025},{taxYear:2027},{currency:'USD'},{provinceOfEmployment:'QC'},{noQuebecTransfer:false},{sameEmployerYtdConfirmed:false},{employerEiPlan:'reduced'},{eligibilityReview:''},{cppPensionableMonths:13},{cppPensionableMonths:1.5},{payPeriodsPerYear:0},{payPeriodsPerYear:2001},{pensionableEarnings:'-1'},{employeeCppYtd:'0.001'},{insurableEarnings:550},{employeeEiYtd:'1e3'},{published:true}])assert.throws(()=>calculateCanadianContributions({...contributionInput(),...patch}));
 const huge=calculateCanadianContributions({...contributionInput(),pensionableEarnings:'9007199254740993.01',insurableEarnings:'9007199254740993.01'});assert.deepEqual(huge.employee,{cpp:'4230.45',cpp2:'416.00',ei:'1123.07',total:'5769.52'});assert.equal(huge.employer.ei,'1572.30');
});

const netDefinition=()=>({employeeDeductions:[{code:'EMPLOYEE',label:'Recorded employee deduction',amount:'350.25',authorityKind:'statute',authorityReference:'Review record 1'}],employerContributions:[{code:'EMPLOYER',label:'Recorded employer obligation',amount:'120.30',obligationReference:'Review record 2'}],taxReview:'Manual amount review; statutory calculation is separate.'});
test('net-pay arithmetic separates employee deductions and employer cost without posting or claiming statutory clearance',()=>{
 const r=calculateNetPay(335025n,2,netDefinition());
 assert.deepEqual(r.amounts,{gross:'3350.25',employeeDeductions:'350.25',employerContributions:'120.30',net:'3000.00',employerCost:'3470.55'});
 assert.equal(r.netMinor,300000n);assert.equal(r.employerCostMinor,347055n);assert.equal(r.definition.calculationBasis,'manual_reviewed');
 for(const flag of ['statutoryRulesCalculated','authorityDocumentsVerified','approvalDetermined','additionalLedgerPosting','isOfficialPaystub','paymentExecuted'] as const)assert.equal(r[flag],false);
 const d=netDefinition();d.employeeDeductions[0].amount='000350.2500';assert.equal(calculateNetPay(335025n,2,d).definition.employeeDeductions[0].amount,'350.25');assert.equal(d.employeeDeductions[0].amount,'000350.2500');
});
test('net-pay amounts conserve every minor unit across all supported currency scales without floating-point conversion',()=>{
 for(let scale=0;scale<=18;scale++){
  const unit=10n**BigInt(scale),gross=9007199254740993n*unit+7n;
  const d=netDefinition();d.employeeDeductions[0].amount=formatMoney(3n,scale);d.employerContributions[0].amount=formatMoney(9n,scale);
  const r=calculateNetPay(gross,scale,d);assert.equal(r.netMinor+ r.employeeDeductionMinor,gross);assert.equal(r.netMinor,gross-3n);assert.equal(r.employerCostMinor,gross+9n);
 }
 const empty={employeeDeductions:[],employerContributions:[],taxReview:'Explicit no deductions review, not an exemption determination.'};
 assert.equal(calculateNetPay(0n,2,empty).amounts.net,'0.00');assert.equal(calculateNetPay(10n,2,empty).netMinor,10n);
 for(const scale of [-1,19,0.5,NaN])assert.throws(()=>calculateNetPay(0n,scale,empty),/INVALID_CURRENCY_PRECISION/);
});
test('net-pay rejects over-deductions, bad money, unreviewed authority, duplicates and unbounded or unexpected input',()=>{
 assert.throws(()=>calculateNetPay(35024n,2,netDefinition()),/DEDUCTIONS_EXCEED_GROSS_PAY/);assert.equal(calculateNetPay(35025n,2,netDefinition()).netMinor,0n);
 for(const gross of [-1n,1 as unknown as bigint])assert.throws(()=>calculateNetPay(gross,2,netDefinition()),/INVALID_GROSS_PAY/);
 for(const amount of ['-1','1e2','NaN','1,000',' 1','1.001',1 as unknown as string,(maximumMinorUnits+1n).toString()]){const d=netDefinition();d.employeeDeductions[0].amount=amount;assert.throws(()=>calculateNetPay(maximumMinorUnits,2,d));d.employeeDeductions=[];d.employerContributions[0].amount=amount;assert.throws(()=>calculateNetPay(maximumMinorUnits,2,d));}
 for(const change of [
  (d:ReturnType<typeof netDefinition>)=>{d.taxReview=' ';},
  (d:ReturnType<typeof netDefinition>)=>{d.employeeDeductions[0].authorityKind='unknown';},
  (d:ReturnType<typeof netDefinition>)=>{d.employeeDeductions[0].authorityReference='';},
  (d:ReturnType<typeof netDefinition>)=>{d.employerContributions[0].obligationReference='';},
  (d:ReturnType<typeof netDefinition>)=>{d.employeeDeductions.push({...d.employeeDeductions[0]});},
  (d:ReturnType<typeof netDefinition>)=>{d.employerContributions.push({...d.employerContributions[0]});},
  (d:ReturnType<typeof netDefinition>)=>{d.employeeDeductions[0].label='unsafe\u0000text';},
  (d:ReturnType<typeof netDefinition>)=>{d.taxReview='unpaired\ud800';},
  (d:ReturnType<typeof netDefinition>)=>{d.employeeDeductions=Array.from({length:101},(_,i)=>({...d.employeeDeductions[0],code:'D'+i}));}
 ]){const d=netDefinition();change(d);assert.throws(()=>calculateNetPay(maximumMinorUnits,2,d));}
 assert.throws(()=>calculateNetPay(1n,2,{...netDefinition(),approved:true}));assert.throws(()=>calculateNetPay(1n,2,{...netDefinition(),calculationBasis:'automatic'}));
});
test('net-pay aggregate totals may exceed posting bounds but every individual line remains bounded and codes are unique per side',()=>{
 const d=netDefinition(),amount=maximumMinorUnits.toString();d.employeeDeductions=[{...d.employeeDeductions[0],code:'SAME',amount},{...d.employeeDeductions[0],code:'OTHER',amount}];d.employerContributions=[{...d.employerContributions[0],code:'SAME',amount},{...d.employerContributions[0],code:'OTHER',amount}];
 const r=calculateNetPay(maximumMinorUnits*3n,0,d);assert.equal(r.employeeDeductionMinor,maximumMinorUnits*2n);assert.equal(r.netMinor,maximumMinorUnits);assert.equal(r.employerCostMinor,maximumMinorUnits*5n);assert.equal(r.amounts.employerContributions,(maximumMinorUnits*2n).toString());
});

test('shared tax arithmetic conserves signed units, ties and posting bounds without guessing a legal classification',()=>{
 assert.deepEqual(taxAmounts(11300n,130000n,'tax_inclusive'),{net:10000n,tax:1300n,gross:11300n});
 assert.deepEqual(taxAmounts(-5n,1000000n,'tax_inclusive'),{net:-2n,tax:-3n,gross:-5n});
 assert.deepEqual(taxAmounts(5n,130000n,'tax_exclusive'),{net:5n,tax:1n,gross:6n});
 assert.deepEqual(taxAmounts(5n,0n,'not_applicable'),{net:5n,tax:0n,gross:5n});
 for(const rate of [-1n,1000001n,1 as unknown as bigint])assert.throws(()=>taxAmounts(1n,rate,'tax_exclusive'),/INVALID_TAX_CALCULATION/);
 assert.throws(()=>taxAmounts(1n,1n,'not_applicable'),/INVALID_TAX_CALCULATION/);assert.throws(()=>taxAmounts(1n,0n,'unknown' as 'tax_exclusive'),/INVALID_TAX_CALCULATION/);
 assert.throws(()=>taxAmounts(maximumMinorUnits,1000000n,'tax_exclusive'),/INVALID_MONEY_AMOUNT/);
});

test('stored integer minor units retain exact value despite numeric scale without relaxing posting bounds or rounding fractions',()=>{
  for(const [value,expected] of [['100.00',100n],['-100.000',-100n],['-0.00',0n],['0001.000',1n],[(2n*maximumMinorUnits).toString()+'.00',2n*maximumMinorUnits]] as const)assert.equal(readMinorUnits(value),expected);
  for(const value of ['1.001','1e2','Infinity','NaN','','.0','+1','1.','1\n',1 as unknown as string])assert.throws(()=>readMinorUnits(value),/INVALID_STORED_MINOR_UNITS/);
  assert.throws(()=>parseMoney((2n*maximumMinorUnits).toString(),0),/INVALID_MONEY_AMOUNT/);
});

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

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsFixture } from './operations-fixture.ts';

export async function invoiceFixture(options:{throughSchema?:number}={}){
 const f=await operationsFixture(options),country=randomUUID(),region=randomUUID(),city=randomUUID();
 await f.pg.query("INSERT INTO public.countries(academy_id,id,code,name) VALUES($1,$2,'CA','Canada')",[f.a,country]);
 await f.pg.query("INSERT INTO public.regions(academy_id,id,country_id,code,name) VALUES($1,$2,$3,'ON','Ontario')",[f.a,region,country]);
 await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Toronto')",[f.a,city,region]);
 await f.pg.query("UPDATE public.hubs SET city_id=$2,time_zone='America/Toronto',currency='CAD' WHERE academy_id=$1",[f.a,city]);
 const made=async(path:string,input:unknown)=>{const r=await f.request(path,input);assert.equal(r.response.status,201,JSON.stringify({path,body:r.body}));return r.body.data;};
 const currency=await made('finance/currencies',{code:'CAD',name:'Canadian dollar',unitScale:2,reason:'Synthetic currency'}),course=await made('courses',{code:'INV',name:'Invoice test curriculum'});
 const c=await made('classes',{hubId:f.hub,courseId:course.id,courseVersion:1,name:'Invoice class',mode:'in_person',schedule:{oneOff:[{start:'2027-01-05T10:00',end:'2027-01-05T11:00',disambiguation:'reject'}]}});
 const student=await made('people',{name:'Adult learner',hubId:f.hub});await made('students',{personId:student.id,legalName:'Private adult legal name',dateOfBirth:'1990-01-01',recruiter:{kind:'academy'}});
 const e=await made('classes/'+c.id+'/enrollments',{studentId:student.id,studentProfileVersion:1,joinsOn:'2027-01-01',reason:'Synthetic enrollment'});
 const tax=await made('finance/tax-codes',{code:'HST',name:'Synthetic tax',hubId:f.hub,countryCode:'CA',classification:'taxable',ratePercent:'13',startsOn:'2026-01-01',legalBasis:'Synthetic configured example only',reason:'Synthetic tax'}),method=await made('finance/payment-methods',{hubId:f.hub,code:'ET',name:'Synthetic transfer',category:'e_transfer',reason:'Synthetic method'});
 const planInput={enrollmentVersion:1,currencyId:currency.id,currencyVersion:1,taxCodeId:tax.id,taxCodeVersion:1,supplyOn:'2027-01-05',originalAmount:'120',agreedAmount:'100',pricing:'tax_exclusive',installments:[{dueOn:'2026-12-01',amount:'50',methodId:method.id,methodVersion:1},{dueOn:'2027-01-01',amount:'63',methodId:method.id,methodVersion:1}],reason:'Synthetic tuition'};
 const plan=await made('enrollments/'+e.id+'/tuition-plan',planInput),period=await made('finance/periods',{name:'2026',startsOn:'2026-01-01',endsOn:'2026-12-31',reason:'Synthetic year'});
 const account=async(code:string,kind:string,operationalRole:string)=>made('finance/accounts',{code,name:'Synthetic '+code,kind,operationalRole,hubId:f.hub,currencyId:currency.id,currencyVersion:1,reason:'Explicit synthetic control role'});
 const ar=await account('1100','asset','receivable'),deferred=await account('2300','liability','deferred_revenue'),income=await account('4000','income','revenue'),taxPayable=await account('2200','liability','tax_payable'),cash=await account('1000','asset','cash');
 const definition={legalName:'Synthetic Academy Inc.',address:'1 Synthetic Street, Toronto, ON',countryCode:'CA',taxRegistrations:[{scheme:'GST_HST',id:'999999999RT0001'}]},issuer=await made('finance/invoice-issuers',{hubId:f.hub,prefix:'SYN',definition,reason:'Synthetic issuer; registration is not real or verified'});
 const base={planVersion:1,issuerId:issuer.id,issuerVersion:1,billToId:student.id,issuedAt:'2026-11-05T12:00:00Z',periodId:period.id,periodVersion:1,description:'Synthetic course tuition',recognition:'deferred',accounts:{receivable:{id:ar.id,version:1},consideration:{id:deferred.id,version:1},tax:{id:taxPayable.id,version:1}},taxTimingReview:'Synthetic invoice-date example with no earlier receipt; accountant review remains required',reason:'Private accounting review'};
 const issue=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/tuition-plans/'+plan.id+'/invoice',{...base,...patch},as,{key});
 const credit=(id:string,patch:Record<string,unknown>={},as='master')=>f.request('finance/invoices/'+id+'/credit',{issuedAt:'2026-11-06T12:00:00Z',periodId:period.id,periodVersion:1,description:'Full cancellation credit',taxTimingReview:'Synthetic full reversal review',reason:'Private credit approval reason',...patch},as);
 return {...f,made,currency,student,e,c,plan,planInput,period,ar,deferred,income,taxPayable,cash,definition,issuer,base,issue,credit,method};
}

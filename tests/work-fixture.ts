import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { invoiceFixture } from './invoice-fixture.ts';

export async function workFixture(options:Parameters<typeof invoiceFixture>[0]={}){const f=await invoiceFixture(options);try{
 const employer=await f.made('finance/payees',{kind:'academy',code:'EMPLOYER',name:'Synthetic academy',legalName:'Synthetic Academy Inc.',reason:'Configured legal employer'}),payee=await f.made('finance/payees',{kind:'person',personId:f.actors.staff.person,code:'EMPLOYEE',name:'Synthetic worker',legalName:'Private legal worker',reason:'Configured worker payee'}),assignment=await f.made('classes/'+f.c.id+'/staff',{personId:f.actors.staff.person,role:'teacher',startsOn:'2026-01-01',reason:'Accepted class staff assignment'});
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['work-pay.view','work-pay.edit','staff.view','payees.view','payment-methods.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,role,cap]);
 const labels=await f.made('roles',{name:'Currency labels only',permissions:[{capability:'currencies.view',effect:'allow'}]});for(const person of [f.actors.staff.person,f.actors.manager.person,f.bot])await f.pg.query('INSERT INTO public.role_assignments(academy_id,id,person_id,role_id,all_hubs) VALUES($1,$2,$3,$4,true)',[f.a,randomUUID(),person,labels.id]);
 const shared={from:'2026-01-01',assignment:{id:assignment.id,version:1},method:{id:f.method.id,version:1}},components=[{code:'ADMIN',kind:'salary',from:'2026-01-01',amount:'3000',frequency:'month'},{...shared,code:'TEACH',kind:'hourly',amount:'20'},{...shared,code:'HEAD',kind:'headcount_hourly',amount:'25',minimumStudents:3,includedStudents:5,increment:'2.50',headcountBasis:'enrolled'},{...shared,code:'FEE',kind:'tuition_percentage',percent:'12.5',basis:'session_net'},{code:'PROJECT',kind:'project',from:'2026-01-01',amount:'125',projectCode:'COACHING'}];
 const definition={legalWorkerName:'Private legal worker',jobTitle:'Teaching and administration',classification:'employee',workPattern:'part_time',countryCode:'CA',region:'Ontario',timeZone:'America/Toronto',startsOn:'2026-01-01',reportingForm:'T4',classificationBasis:'Declared facts require employment-status review',taxReview:'Configured choice is not a CRA determination',payCycle:{kind:'monthly',day:31}};
 const input={personId:f.actors.staff.person,hubId:f.hub,code:'WORK-ON',effectiveOn:'2026-01-01',currency:{id:f.currency.id,version:1},employer:{id:employer.id,version:1},payee:{id:payee.id,version:1},definition,components,reason:'Private work terms and rate review'};
 const create=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('payroll/engagements',{...input,...patch},as,{key});
 const amend=(id:string,patch:Record<string,unknown>={},as='master',key?:string)=>{const {personId,hubId,code,...body}=input;return f.request('payroll/engagements/'+id+'/change',{...body,expectedVersion:1,...patch},as,{key});};
 return {...f,employer,payee,assignment,input,components,definition,create,amend};
}catch(error){await f.pg.close();throw error;}}


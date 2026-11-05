import { randomUUID } from 'node:crypto';
import { homeworkAnswerFixture } from './homework-fixture.ts';

export async function pollFixture(throughSchema?:number){
 const f=await homeworkAnswerFixture(throughSchema);if(throughSchema!==81)for(const role of [f.staffRole,f.managerRole])for(const cap of ['polls.view','polls.edit','polls.publish','poll-recipients.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const definition={title:'PRIVATE class feedback',description:'PRIVATE parent questions',locale:'en',questions:[{id:randomUUID(),kind:'single',prompt:'PRIVATE preferred activity?',required:true,options:[{id:randomUUID(),label:'Building'},{id:randomUUID(),label:'Programming'}]},{id:randomUUID(),kind:'multiple',prompt:'PRIVATE suitable topics?',required:false,maxSelections:2,options:[{id:randomUUID(),label:'Robots'},{id:randomUUID(),label:'AI'}]},{id:randomUUID(),kind:'text',prompt:'PRIVATE any notes?',required:false,maxLength:2000}]};
 const input={expectedVersion:0,anchor:{kind:'class',id:f.c.id},state:'draft',definition,responseUnit:'student_family',respondentMode:'guardians',audienceEffectiveAt:'2026-01-03T04:30:00Z',opensAt:null,closesAt:null,recipients:f.taskInput.recipients,reason:'PRIVATE poll administration'},create=(i:unknown=input,as='master',key?:string)=>f.request('polls',i,as,key?{key}:{}),change=(id:string,i:unknown,as='master',key?:string)=>f.request('polls/'+id+'/change',i,as,key?{key}:{}),withdraw=(id:string,expectedVersion:number,as='master')=>f.request('polls/'+id+'/withdraw',{expectedVersion,reason:'PRIVATE poll withdrawal'},as);
 async function parent(){const role=await f.parent();await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'received-polls.view','allow')",[f.a,role]);return role;}
 const received=(id?:string,as='manager',query='')=>f.request('students/'+f.student+'/polls'+(id?'/'+id:'')+query,undefined,as);
 return {...f,pollDefinition:definition,pollInput:input,createPoll:create,changePoll:change,withdrawPoll:withdraw,pollParent:parent,receivedPoll:received};
}

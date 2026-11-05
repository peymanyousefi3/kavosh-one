import assert from 'node:assert/strict';
import { pollFixture } from './poll-fixture.ts';

export async function pollResponseFixture(options:{responseUnit?:string;respondentMode?:string;opensAt?:string;closesAt?:string;anchor?:{kind:'academy'}}={}){
 const f=await pollFixture();
 await f.pollParent();await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'received-polls.respond','allow')",[f.a,(await f.pg.query<{id:string}>("SELECT id FROM public.roles WHERE name='Own child submitted answers'")).rows[0].id]);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'poll-responses.view','allow')",[f.a,f.staffRole]);
 const made=await f.createPoll({...f.pollInput,state:'published',...options});assert.equal(made.response.status,200,JSON.stringify(made.body));const poll=made.body.data,path='students/'+f.student+'/polls/'+poll.id+'/response';
 const answer=[{questionId:f.pollDefinition.questions[0].id,kind:'single',optionId:f.pollDefinition.questions[0].options![0].id},{questionId:f.pollDefinition.questions[1].id,kind:'multiple',optionIds:[f.pollDefinition.questions[1].options![0].id]},{questionId:f.pollDefinition.questions[2].id,kind:'text',text:'PRIVATE parent response\n  preserve spacing'}];
 return {...f,poll,path,answer,submit:(i:unknown={expectedVersion:0,formVersion:1,answers:answer},as='manager',key?:string)=>f.request(path,i,as,key?{key}:{}),response:(suffix='',as='manager')=>f.request(path+suffix,undefined,as),withdrawResponse:(expectedVersion:number,formVersion=1,as='manager')=>f.request(path+'/withdraw',{expectedVersion,formVersion},as)};
}

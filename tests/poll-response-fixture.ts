import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PollAnswers } from '../src/modules/poll-answer.ts';
import { pollFixture } from './poll-fixture.ts';

// Historical-schema upgrade evidence uses that schema's real runtime protocol,
// not a current API that now requires later projection tables. This is not an
// identity transport test or a production administrator bypass.
export async function persistNativePollResponse(f:Awaited<ReturnType<typeof pollFixture>>,pollId:string,answers:PollAnswers){
 const id=randomUUID();await f.pg.exec('BEGIN');try{
  await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
  const source=(await f.pg.query<{source:{poll:{version:number;formVersion:number};recipient:{classId:string;hubId:string;on:string}}}>('SELECT public.poll_response_source($1,$2) source',[pollId,f.student])).rows[0].source;assert.ok(source);
  await f.pg.query("INSERT INTO public.poll_responses(academy_id,id,poll_id,form_version,student_id,respondent_key,class_id,hub_id,posted_on,poll_version,state,answers,context,created_by,changed_by) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,'submitted',$10::jsonb,$11::jsonb,$12,$12)",[f.a,id,pollId,source.poll.formVersion,f.student,source.recipient.classId,source.recipient.hubId,source.recipient.on,source.poll.version,JSON.stringify(answers),JSON.stringify(source),f.guardian]);
  await f.pg.query('INSERT INTO public.poll_response_revisions(academy_id,response_id,version,definition) SELECT academy_id,id,version,to_jsonb(r) FROM public.poll_responses r WHERE id=$1',[id]);await f.pg.exec('COMMIT');return id;
 }catch(error){await f.pg.exec('ROLLBACK');throw error;}
}

export async function pollResponseFixture(options:{responseUnit?:string;respondentMode?:string;opensAt?:string;closesAt?:string;anchor?:{kind:'academy'}}={}){
 const f=await pollFixture();
 await f.pollParent();await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'received-polls.respond','allow')",[f.a,(await f.pg.query<{id:string}>("SELECT id FROM public.roles WHERE name='Own child submitted answers'")).rows[0].id]);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'poll-responses.view','allow')",[f.a,f.staffRole]);
 const made=await f.createPoll({...f.pollInput,state:'published',...options});assert.equal(made.response.status,200,JSON.stringify(made.body));const poll=made.body.data,path='students/'+f.student+'/polls/'+poll.id+'/response';
 const answer=[{questionId:f.pollDefinition.questions[0].id,kind:'single',optionId:f.pollDefinition.questions[0].options![0].id},{questionId:f.pollDefinition.questions[1].id,kind:'multiple',optionIds:[f.pollDefinition.questions[1].options![0].id]},{questionId:f.pollDefinition.questions[2].id,kind:'text',text:'PRIVATE parent response\n  preserve spacing'}];
 return {...f,poll,path,answer,submit:(i:unknown={expectedVersion:0,formVersion:1,answers:answer},as='manager',key?:string)=>f.request(path,i,as,key?{key}:{}),response:(suffix='',as='manager')=>f.request(path+suffix,undefined,as),withdrawResponse:(expectedVersion:number,formVersion=1,as='manager')=>f.request(path+'/withdraw',{expectedVersion,formVersion},as)};
}

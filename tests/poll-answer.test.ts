import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { pollAnswers,pollAnswersMatch } from '../src/modules/poll-answer.ts';
import type { PollDefinition } from '../src/modules/poll-definition.ts';

test('poll answers preserve text and exact choice IDs without accepting missing, duplicated or invented questions',()=>{
 const one=randomUUID(),many=randomUUID(),text=randomUUID(),a=randomUUID(),b=randomUUID();
 const definition:PollDefinition={title:'Feedback',description:'',locale:'en',questions:[{id:one,kind:'single',prompt:'Choice',required:true,options:[{id:a,label:'One'},{id:b,label:'Two'}]},{id:many,kind:'multiple',prompt:'More',required:false,maxSelections:1,options:[{id:a,label:'One'},{id:b,label:'Two'}]},{id:text,kind:'text',prompt:'Notes',required:false,maxLength:20}]};
 const valid=pollAnswers.parse([{questionId:one,kind:'single',optionId:a},{questionId:many,kind:'multiple',optionIds:[b]},{questionId:text,kind:'text',text:'  Keep\nspacing  '}]);
 assert.equal(pollAnswersMatch(definition,valid),true);assert.equal(valid[2].kind==='text'&&valid[2].text,'  Keep\nspacing  ');
 for(const answers of [[],[{questionId:one,kind:'single',optionId:randomUUID()}],valid.map(a=>a.questionId===many?{...a,optionIds:[a.kind==='multiple'?a.optionIds[0]:b,b]}:a),valid.map(a=>a.kind==='text'?{...a,text:'x'.repeat(21)}:a),[...valid,{questionId:randomUUID(),kind:'text',text:'Unknown'}]])assert.equal(pollAnswersMatch(definition,answers as typeof valid),false);
 for(const answers of [[valid[0],valid[0]],[{questionId:many,kind:'multiple',optionIds:[a,a]}],[{questionId:text,kind:'text',text:' \n '}],[{...valid[0],actorId:randomUUID()}]])assert.equal(pollAnswers.safeParse(answers).success,false);
});

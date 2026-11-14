import { z } from 'zod';
import type { PollDefinition } from './poll-definition.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const pollAnswers=z.array(z.discriminatedUnion('kind',[
 z.object({questionId:uuid,kind:z.literal('single'),optionId:uuid}).strict(),
 z.object({questionId:uuid,kind:z.literal('multiple'),optionIds:z.array(uuid).min(1).max(20).refine(v=>new Set(v).size===v.length,'Duplicate choice')}).strict(),
 z.object({questionId:uuid,kind:z.literal('text'),text:z.string().min(1).max(4000).refine(v=>v.isWellFormed()&&!v.includes('\0')&&Boolean(v.trim()))}).strict()
])).max(20).refine(v=>new Set(v.map(a=>a.questionId)).size===v.length,'Duplicate question answer')
 .refine(v=>Buffer.byteLength(JSON.stringify(v),'utf8')<=65536,'Answers exceed 64 KiB');
export type PollAnswers=z.infer<typeof pollAnswers>;

export function pollAnswersMatch(definition:PollDefinition,answers:PollAnswers){
 const questions=new Map(definition.questions.map(q=>[q.id,q]));
 return definition.questions.every(q=>!q.required||answers.some(a=>a.questionId===q.id))&&answers.every(a=>{
  const q=questions.get(a.questionId);if(!q||q.kind!==a.kind)return false;
  if(q.kind==='text'&&a.kind==='text')return a.text.length<=q.maxLength;
  if(q.kind==='single'&&a.kind==='single')return q.options.some(o=>o.id===a.optionId);
  return q.kind==='multiple'&&a.kind==='multiple'&&a.optionIds.length<=q.maxSelections&&a.optionIds.every(id=>q.options.some(o=>o.id===id));
 });
}

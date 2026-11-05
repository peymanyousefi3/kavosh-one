import { z } from 'zod';
import type { Scope } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const option=z.object({id:uuid,label:text.pipe(z.string().trim().min(1).max(200))}).strict();
const options=z.array(option).min(2).max(20).refine(v=>new Set(v.map(o=>o.id)).size===v.length,'Duplicate option ID');
const fields={id:uuid,prompt:text.pipe(z.string().trim().min(1).max(2000)),required:z.boolean()};
const question=z.discriminatedUnion('kind',[
 z.object({...fields,kind:z.literal('single'),options}).strict(),
 z.object({...fields,kind:z.literal('multiple'),options,maxSelections:z.number().int().min(1).max(20)}).strict().refine(v=>v.maxSelections<=v.options.length,'Selection limit exceeds available options'),
 z.object({...fields,kind:z.literal('text'),maxLength:z.number().int().min(1).max(4000)}).strict()
]);
export const pollDefinition=z.object({title:text.pipe(z.string().trim().min(1).max(200)),description:text.max(4000),locale:z.enum(['en','fr','zh-CN']),questions:z.array(question).min(1).max(20).refine(v=>new Set(v.map(q=>q.id)).size===v.length,'Duplicate question ID')}).strict().refine(v=>Buffer.byteLength(JSON.stringify(v),'utf8')<=65536,'Poll definition exceeds 64 KiB');
export const pollAnchor=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('academy')}).strict(),z.object({kind:z.literal('hub'),id:uuid}).strict(),z.object({kind:z.literal('class'),id:uuid}).strict()
]);
export const pollResponseUnit=z.enum(['student_family','guardian_per_student']);
export const pollRespondentMode=z.enum(['guardians','students','both']);
export type PollDefinition=z.infer<typeof pollDefinition>;
export function pollOwnerScope(a:z.infer<typeof pollAnchor>,hubId:string|null):Scope{return a.kind==='academy'?{all:true,hubs:[]}:a.kind==='hub'?{all:false,hubs:[a.id]}:{all:false,hubs:[],classes:[{id:a.id,hubId:hubId!}]};}
// Code-owned alias p is shared by the poll, template and reporting directories.
export const pollOwnerSQL=`CASE WHEN p.anchor->>'kind'='academy' THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) WHEN p.class_id IS NOT NULL THEN jsonb_build_object('all',false,'hubs','[]'::jsonb,'classes',jsonb_build_array(jsonb_build_object('id',p.class_id,'hubId',p.hub_id))) ELSE jsonb_build_object('all',false,'hubs',jsonb_build_array(p.hub_id)) END`;

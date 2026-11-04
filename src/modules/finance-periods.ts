import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope } from '../core/policy.ts';
import { mergeLabels } from './academy.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),name=text.trim().min(1).max(200),reason=text.trim().min(1).max(2000);
export const accountingDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{try{return v>='0001-01-01'&&Temporal.PlainDate.from(v,{overflow:'reject'}).toString()===v;}catch{return false;}});
const translations=z.object({en:name.optional(),fr:name.optional(),'zh-CN':name.optional()}).strict();
const labelsPatch=z.object({en:name.nullable().optional(),fr:name.nullable().optional(),'zh-CN':name.nullable().optional()}).strict();
const create=z.object({name,startsOn:accountingDate,endsOn:accountingDate,translations:translations.default({}),reason}).strict().refine(v=>v.startsOn<=v.endsOn,'The inclusive end date cannot precede the start.');
const change=z.object({expectedVersion:version,name:name.optional(),translations:labelsPatch.optional(),state:z.enum(['open','closed','void']).optional(),reason}).strict().refine(v=>['name','translations','state'].some(k=>Object.hasOwn(v,k)));
const paging={limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()};
const query=z.object({...paging,state:z.enum(['open','closed','void']).optional(),on:accountingDate.optional()}).strict();
const historyQuery=z.object({limit:paging.limit,afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
type Period={id:string;startsOn:string;endsOn:string;state:'open'|'closed'|'void';version:number;name:string;translations:Record<string,string>};
const columns='id,starts_on::text AS "startsOn",ends_on::text AS "endsOn",state,version,name,translations,created_by AS "createdBy",created_at AS "createdAt",revised_at AS "revisedAt"';
function authority(ctx:ApiContext,edit=false){requireScope(permissionScope(ctx,'periods.view'));if(edit)requireScope(permissionScope(ctx,'periods.edit'));}
async function row(ctx:ApiContext,id:string,edit=false,lock=false):Promise<Period>{
  authority(ctx,edit);if(lock)await ctx.db.query('SELECT id FROM public.finance_periods WHERE id=$1 FOR UPDATE',[id]);
  const found=(await ctx.db.query<Period>('SELECT '+columns+' FROM public.finance_period_catalogue WHERE id=$1',[id])).rows[0];if(!found)throw new ApiError(404,'NOT_FOUND');return found;
}
async function validate(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
  authority(ctx,true);await lockFinanceBook(ctx);
  if(creating)create.parse(raw);
  else{
    const input=change.parse(raw),before=await row(ctx,id,true,true);if(before.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
    if(before.state==='void'||(input.state==='void'&&before.state!=='closed'))throw new ApiError(409,'PERIOD_TRANSITION_INVALID');
    if(input.state==='void'&&(await ctx.db.query('SELECT 1 FROM public.finance_journals WHERE period_id=$1 LIMIT 1',[id])).rows.length)throw new ApiError(409,'PERIOD_HAS_POSTINGS');
  }
  return {all:true,hubs:[]};
}
async function dependencies(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
  const current=(await ctx.db.query('SELECT id,version,state FROM public.finance_periods WHERE id=$1',[id])).rows[0]??null;
  const input=creating?create.parse(raw):null;
  return {current,overlaps:input?(await ctx.db.query("SELECT id,version,state FROM public.finance_periods WHERE state<>'void' AND daterange(starts_on,ends_on,'[]') && daterange($1::date,$2::date,'[]') ORDER BY id",[input.startsOn,input.endsOn])).rows:null,
    hasPostings:!creating&&change.parse(raw).state==='void'?(await ctx.db.query('SELECT 1 FROM public.finance_journals WHERE period_id=$1 LIMIT 1',[id])).rows.length>0:null};
}
async function apply(ctx:ApiContext,p:Proposal){
  if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
  const creating=p.action==='finance.period.create',input=creating?create.parse(p.payload):change.parse(p.payload),before=creating?null:await row(ctx,p.target_id,true,true);
  if(before&&(before.version!==p.target_version||!('expectedVersion' in input)||before.version!==input.expectedVersion))throw new ApiError(409,'TARGET_CHANGED');
  const next=before?before.version+1:1,state='state' in input?input.state??before!.state:before?.state??'open',title=input.name??before!.name,labels=mergeLabels(before?.translations,input.translations);
  try{
    if(before)await ctx.db.query('UPDATE public.finance_periods SET version=$2,state=$3 WHERE id=$1',[p.target_id,next,state]);
    else if('startsOn' in input)await ctx.db.query('INSERT INTO public.finance_periods(academy_id,id,starts_on,ends_on,created_by) VALUES($1,$2,$3,$4,$5)',[ctx.credential.academy_id,p.target_id,input.startsOn,input.endsOn,ctx.credential.person_id]);
    await ctx.db.query('INSERT INTO public.finance_period_revisions(academy_id,period_id,version,name,state,translations,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)',[ctx.credential.academy_id,p.target_id,next,title,state,JSON.stringify(labels),ctx.credential.person_id,p.id,input.reason]);
  }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23P01')throw new ApiError(409,'PERIOD_OVERLAP');throw error;}
  await record(ctx.db,ctx.credential,ctx.requestId,creating?'finance.period.created':'finance.period.updated',p.target_id,null,{beforeVersion:before?.version??null,afterVersion:next,previousState:before?.state??null,state,approvalId:p.id,severity:'critical',hasReason:true});return row(ctx,p.target_id);
}
export const periodActions:ApprovalRegistry={
  'finance.period.create':{requestCapability:'periods.edit',privacyCapability:'periods.edit',policyChange:true,createdStatus:201,validate:(ctx,id,input)=>validate(ctx,true,id,input),dependencies:(ctx,id,input)=>dependencies(ctx,true,id,input),apply},
  'finance.period.update':{requestCapability:'periods.edit',privacyCapability:'periods.edit',policyChange:true,validate:(ctx,id,input)=>validate(ctx,false,id,input),dependencies:(ctx,id,input)=>dependencies(ctx,false,id,input),apply}
};
export async function financePeriods(ctx:ApiContext,registry:ApprovalRegistry=periodActions):Promise<Reply|null>{
  const match=/^finance\/periods(?:\/([^/]+)(?:\/(change|history))?)?$/.exec(ctx.path);if(!match)return null;
  const id=match[1]?uuid.parse(match[1]):null,section=match[2];
  if(ctx.request.method==='POST'){
    z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));authority(ctx,true);
    if(!id)return propose(ctx,registry,'finance.period.create',null,0,create.parse(await jsonBody(ctx.request)));
    if(section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=change.parse(await jsonBody(ctx.request));return propose(ctx,registry,'finance.period.update',id,input.expectedVersion,input);
  }
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');authority(ctx);
  if(id){
    const found=await row(ctx,id,section==='history');
    if(section==='history'){const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const rows=(await ctx.db.query<{version:number}>('SELECT version,name,state,translations,changed_by AS "changedBy",approval_id AS "approvalId",reason,created_at AS "createdAt" FROM public.finance_period_revisions WHERE period_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
    if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:found}};
  }
  const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{id:string}>('SELECT '+columns+' FROM public.finance_period_catalogue WHERE ($1::uuid IS NULL OR id>$1) AND ($2::text IS NULL OR state=$2) AND ($3::date IS NULL OR $3::date BETWEEN starts_on AND ends_on) ORDER BY id LIMIT $4',[q.after??null,q.state??null,q.on??null,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const periodsContract=[
  {path:'/api/v1/finance/periods',method:'get',summary:'School-wide accounting periods with inclusive date bounds and current state',querySchema:query},
  {path:'/api/v1/finance/periods',method:'post',summary:'Request a non-overlapping open accounting period with explicit dates',schema:create},
  {path:'/api/v1/finance/periods/{id}',method:'get',summary:'Read a current accounting period'},
  {path:'/api/v1/finance/periods/{id}/change',method:'post',summary:'Request reviewed close/reopen or correction; only closed empty periods may later be voided',schema:change},
  {path:'/api/v1/finance/periods/{id}/history',method:'get',summary:'Editor-only append-only period revisions and private reasons',querySchema:historyQuery}
] as const;

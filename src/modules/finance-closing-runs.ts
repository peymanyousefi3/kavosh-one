import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { lockClosingBook } from '../core/finance-lock.ts';
import { maximumMinorUnits,readMinorUnits } from '../core/money.ts';
import { closingAuthority,closingSourceSQL,closingSnapshot,closingBlockers,type Source } from './finance-closing.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_646);
const mapping=z.object({currencyId:uuid,sourceHubId:uuid.nullable(),accountId:uuid,accountVersion:version}).strict();
const key=(currency:string,hub:string|null)=>JSON.stringify([currency,hub]);
const request=z.object({expectedPeriodVersion:version,snapshot:z.string().regex(/^[a-f0-9]{64}$/),equityMappings:z.array(mapping).max(1000).default([]).refine(v=>new Set(v.map(m=>key(m.currencyId,m.sourceHubId))).size===v.length,'Select one equity destination per currency/source hub.'),reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict();
const payload=request.extend({periodId:uuid});
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()}).strict();
type Input=z.infer<typeof payload>;
type Equity={id:string;version:number;kind:string;active:boolean;currencyId:string;currencyVersion:number;unitScale:number};
type Line={journalId:string;lineNumber:number;accountId:string;accountVersion:number;side:'debit'|'credit';amountMinor:string};
const columns=`r.id,r.period_id AS "periodId",r.open_period_version AS "openPeriodVersion",r.open_period_version+1 AS "closedPeriodVersion",r.through::text,r.source_snapshot AS "sourceSnapshot",r.source_stamp AS "sourceStamp",r.equity_mappings AS "equityMappings",r.journal_count AS "journalCount",r.pair_count AS "pairCount",r.created_by AS "createdBy",r.approval_id AS "approvalId",r.created_at AS "createdAt",coalesce(p.active_closing_run_id=r.id,false) AS active,p.version AS "currentPeriodVersion",true AS "hasReason"`;
async function read(ctx:ApiContext,id:string){
 closingAuthority(ctx);const r=(await ctx.db.query('SELECT '+columns+' FROM public.finance_closing_runs r JOIN public.finance_periods p ON p.academy_id=r.academy_id AND p.id=r.period_id WHERE r.id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');return r;
}
async function facts(ctx:ApiContext,input:Input){
 closingAuthority(ctx,true);await lockClosingBook(ctx);
 const source=(await ctx.db.query<Source>(closingSourceSQL,[input.periodId,null,null,null,10001])).rows[0]??null;
 const accounts=(await ctx.db.query<Equity>('SELECT id,version,kind,active,currency_id AS "currencyId",currency_version AS "currencyVersion",unit_scale AS "unitScale" FROM public.finance_account_catalogue WHERE id=ANY($1::uuid[]) ORDER BY id',[[...new Set(input.equityMappings.map(m=>m.accountId))].sort()])).rows;
 return {source,accounts};
}
function plan(ctx:ApiContext,input:Input,f:Awaited<ReturnType<typeof facts>>){
 const r=f.source;if(!r)throw new ApiError(404,'NOT_FOUND');
 if(r.periodVersion!==input.expectedPeriodVersion)throw new ApiError(409,'PERIOD_CHANGED');
 const stamp=closingSnapshot(ctx,r);if(stamp.snapshot!==input.snapshot)throw new ApiError(409,'CLOSING_SOURCE_CHANGED');
 const blockers=closingBlockers(r);if(blockers.length)throw new ApiError(409,blockers[0]);
 // ponytail: bounded synchronous close; larger runs require the queued close
 // executor, not partial posting or silently omitted source accounts.
 if(readMinorUnits(r.temporaryGroupCount)>10000n)throw new ApiError(409,'CLOSING_JOB_REQUIRED');
 const accounts=new Map(f.accounts.map(a=>[a.id,a])),destinations=new Map<string,Equity>();
 for(const m of input.equityMappings){const a=accounts.get(m.accountId);if(!a)throw new ApiError(404,'NOT_FOUND');if(a.version!==m.accountVersion||!a.active||a.kind!=='equity'||a.currencyId!==m.currencyId)throw new ApiError(409,'CLOSING_EQUITY_CHANGED');destinations.set(key(m.currencyId,m.sourceHubId),a);}
 const journals:{id:string;lineCount:number}[]=[],lines:Line[]=[];
 for(const target of r.entries){
  const a=destinations.get(key(target.currencyId,target.hubId));if(!a)throw new ApiError(400,'CLOSING_EQUITY_MAPPING_REQUIRED');
  const net=readMinorUnits(target.netMinor);let remaining=net<0n?-net:net;
  const quantum=target.unitScale>a.unitScale?10n**BigInt(target.unitScale-a.unitScale):1n;
  if(remaining%quantum!==0n)throw new ApiError(409,'CLOSING_EQUITY_PRECISION_REQUIRED');
  const multiplier=a.unitScale>target.unitScale?10n**BigInt(a.unitScale-target.unitScale):1n;
  const cap=(maximumMinorUnits/multiplier)/quantum*quantum;
  while(remaining>0n){
   const amount=remaining<cap?remaining:cap;
   if(lines.length>=200000)throw new ApiError(409,'CLOSING_JOB_REQUIRED');
   let journal=journals.at(-1);if(!journal||journal.lineCount===200){journal={id:randomUUID(),lineCount:0};journals.push(journal);}
   const equityAmount=amount/quantum*multiplier,side=net>0n?'credit':'debit';
   lines.push({journalId:journal.id,lineNumber:journal.lineCount+1,accountId:target.accountId,accountVersion:target.chartVersion,side,amountMinor:amount.toString()},
    {journalId:journal.id,lineNumber:journal.lineCount+2,accountId:a.id,accountVersion:a.version,side:side==='credit'?'debit':'credit',amountMinor:equityAmount.toString()});
   journal.lineCount+=2;remaining-=amount;
  }
 }
 return {source:r,stamp,journals,lines};
}
async function dependencies(ctx:ApiContext,raw:unknown,purpose:'request'|'review'){
 const input=payload.parse(raw),f=await facts(ctx,input);if(purpose==='request')plan(ctx,input,f);
 return {closingProtocolVersion:1,source:f.source?{snapshot:closingSnapshot(ctx,f.source).snapshot,temporaryGroupCount:f.source.temporaryGroupCount,sourceLineCount:f.source.sourceLineCount,currencies:f.source.currencies,blockers:closingBlockers(f.source)}:null,equityAccounts:f.accounts};
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 const input=payload.parse(p.payload),prepared=plan(ctx,input,await facts(ctx,input)),{source:r,stamp,journals,lines}=prepared;
 await ctx.db.query('SELECT id FROM public.finance_periods WHERE id=$1 FOR UPDATE',[input.periodId]);
 const period=(await ctx.db.query<{name:string;translations:Record<string,string>}>('SELECT name,translations FROM public.finance_period_catalogue WHERE id=$1',[input.periodId])).rows[0];
 await ctx.db.query(`INSERT INTO public.finance_closing_runs(academy_id,id,period_id,open_period_version,through,source_snapshot,source_stamp,equity_mappings,journal_count,pair_count,created_by,approval_id,reason)
 VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)`,[ctx.credential.academy_id,p.target_id,input.periodId,r.periodVersion,r.through,stamp.snapshot,JSON.stringify(stamp.sourceStamp),JSON.stringify(input.equityMappings),journals.length,lines.length/2,ctx.credential.person_id,p.id,input.reason]);
 if(journals.length){
  await ctx.db.query(`INSERT INTO public.finance_journals(academy_id,id,period_id,period_version,posted_on,description,line_count,posted_by,approval_id,purpose,closing_run_id)
   SELECT $1,(j->>'id')::uuid,$2,$3,$4,'Reviewed closing run '||$5::text,(j->>'lineCount')::smallint,$6,$7,'closing',$5::uuid FROM jsonb_array_elements($8::jsonb) j`,[ctx.credential.academy_id,input.periodId,r.periodVersion,r.through,p.target_id,ctx.credential.person_id,p.id,JSON.stringify(journals)]);
  await ctx.db.query(`INSERT INTO public.finance_journal_lines(academy_id,journal_id,line_number,account_id,account_version,side,amount_minor)
   SELECT $1,(l->>'journalId')::uuid,(l->>'lineNumber')::smallint,(l->>'accountId')::uuid,(l->>'accountVersion')::integer,l->>'side',(l->>'amountMinor')::numeric FROM jsonb_array_elements($2::jsonb) l`,[ctx.credential.academy_id,JSON.stringify(lines)]);
 }
 await ctx.db.query("UPDATE public.finance_periods SET version=version+1,state='closed',active_closing_run_id=$2 WHERE id=$1",[input.periodId,p.target_id]);
 await ctx.db.query("INSERT INTO public.finance_period_revisions(academy_id,period_id,version,name,state,translations,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,'closed',$5::jsonb,$6,$7,$8)",[ctx.credential.academy_id,input.periodId,r.periodVersion+1,period.name,JSON.stringify(period.translations),ctx.credential.person_id,p.id,'Reviewed financial closing run '+p.target_id]);
 // Run all native completeness checks before returning/recording success,
 // including when this action is applied inside the approval savepoint.
 await ctx.db.query('SET CONSTRAINTS finance_closing_complete,finance_journal_complete,finance_journal_purpose_complete IMMEDIATE');
 await ctx.db.query('SET CONSTRAINTS finance_closing_complete,finance_journal_complete,finance_journal_purpose_complete DEFERRED');
 await record(ctx.db,ctx.credential,ctx.requestId,'finance.closing.completed',p.target_id,null,{periodId:input.periodId,openPeriodVersion:r.periodVersion,closedPeriodVersion:r.periodVersion+1,journalCount:journals.length,pairCount:lines.length/2,approvalId:p.id,severity:'critical',hasReason:true});
 return read(ctx,p.target_id);
}
export const closingActions:ApprovalRegistry={
 'finance.closing.post':{requestCapability:'closing.edit',privacyCapability:'closing.edit',policyChange:true,createdStatus:201,
  authorizeReviewer:ctx=>{closingAuthority(ctx,true);return Promise.resolve();},
  validate:async(ctx,_id,raw)=>{closingAuthority(ctx,true);payload.parse(raw);await lockClosingBook(ctx);return {all:true,hubs:[]};},
  dependencies:(ctx,_id,input,purpose)=>dependencies(ctx,input,purpose),apply}
};
export async function financeClosingRuns(ctx:ApiContext,registry:ApprovalRegistry=closingActions):Promise<Reply|null>{
 const periodPath=/^finance\/periods\/([^/]+)\/closing-runs$/.exec(ctx.path),runPath=/^finance\/closing-runs\/([^/]+)(?:\/(journals))?$/.exec(ctx.path);if(!periodPath&&!runPath)return null;
 if(ctx.request.method==='POST'&&periodPath){closingAuthority(ctx,true);z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const input={...request.parse(await jsonBody(ctx.request,262144)),periodId:uuid.parse(periodPath[1])};return propose(ctx,registry,'finance.closing.post',null,input.expectedPeriodVersion,input);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');closingAuthority(ctx);
 if(runPath){const id=uuid.parse(runPath[1]),found=await read(ctx,id);if(!runPath[2]){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:found}};}
  const q=paging.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{id:string}>('SELECT id,posted_on::text AS "postedOn",line_count AS "lineCount",created_at AS "createdAt" FROM public.finance_journals WHERE closing_run_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[id,q.after??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 const id=uuid.parse(periodPath![1]),q=paging.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));if(!(await ctx.db.query('SELECT 1 FROM public.finance_periods WHERE id=$1',[id])).rows.length)throw new ApiError(404,'NOT_FOUND');
 const rows=(await ctx.db.query<{id:string}>('SELECT '+columns+' FROM public.finance_closing_runs r JOIN public.finance_periods p ON p.academy_id=r.academy_id AND p.id=r.period_id WHERE r.period_id=$1 AND ($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT $3',[id,q.after??null,q.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const closingRunsContract=[
 {path:'/api/v1/finance/periods/{id}/closing-runs',method:'post',summary:'Request upper-human-reviewed exact closing entries and atomic period closure against a pinned source snapshot; explicit equity destinations by currency/source hub',schema:request},
 {path:'/api/v1/finance/periods/{id}/closing-runs',method:'get',summary:'Permission-protected immutable financial closing-run directory for a period, ordered by run ID',querySchema:paging},
 {path:'/api/v1/finance/closing-runs/{id}',method:'get',summary:'Read immutable close source/mapping evidence and current activation; free-text reason remains in editor-only approval history'},
 {path:'/api/v1/finance/closing-runs/{id}/journals',method:'get',summary:'Bounded linked closing journal directory; full journal reads retain their own permissions',querySchema:paging}
] as const;

import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ApiContext } from '../core/api.ts';
import { permissionScope,master,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,type Capability } from '../core/policy.ts';
import { payeeSelection } from './payees.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const journalCounterpartyLines=z.array(z.object({lineNumber:z.number().int().min(1).max(200),payee:z.object({id:uuid,version:z.number().int().positive().max(2147483647)}).strict(),category:z.enum(['loan_advance','loan_repayment','opening_balance','balance_adjustment'])}).strict()).min(1).max(200).refine(a=>new Set(a.map(l=>l.lineNumber)).size===a.length).transform(a=>a.sort((x,y)=>x.lineNumber-y.lineNumber));
type Tag=z.infer<typeof journalCounterpartyLines>;
type Account={id:string;hubId:string|null;kind:string;operationalRole:string};
type Line={accountId:string};
export async function retainedJournalCounterparties(ctx:ApiContext,journalId:string):Promise<Tag|undefined>{
 // Old ordinary journals do not depend on this later schema. Only an original
 // standalone posting that explicitly requested links may have retained links.
 const r=(await ctx.db.query<{id:string;tags:unknown}>("SELECT o.id,p.payload->'counterpartyLines' tags FROM public.finance_journals j JOIN public.finance_journals o ON o.academy_id=j.academy_id AND o.id=coalesce(j.reverses_id,j.id) JOIN public.approval_requests p ON p.academy_id=o.academy_id AND p.id=o.approval_id WHERE j.id=$1 AND p.action='finance.journal.post' AND p.payload ? 'counterpartyLines'",[journalId])).rows[0];if(!r)return undefined;
 const expected=journalCounterpartyLines.parse(r.tags),actual=(await ctx.db.query<Tag[number]>('SELECT line_number AS "lineNumber",jsonb_build_object(\'id\',payee_id,\'version\',payee_version) payee,category FROM public.finance_journal_counterparties WHERE journal_id=$1 ORDER BY line_number',[r.id])).rows;
 if(!isDeepStrictEqual(actual,expected))throw new ApiError(503,'JOURNAL_COUNTERPARTY_LINKS_INCOMPLETE');return actual;
}
export async function prepareJournalCounterparties(ctx:ApiContext,tags:Tag|undefined,accounts:Account[],lines:Line[],purpose:string,edit:boolean,checkState:boolean,retained=false){
 if(!tags)return undefined;
 const targets=new Map((await payeeSelection(ctx,[...new Map(tags.map(t=>[t.payee.id+':'+t.payee.version,t.payee])).values()])).map(p=>[p.id+':'+p.version,p]));
 const hubs=new Set(accounts.map(a=>a.hubId)),byId=new Map(accounts.map(a=>[a.id,a]));
 for(const a of accounts)for(const cap of ['counterparty-balances.view',...edit?['counterparty-balances.edit']:[]] as Capability[])requireScope(permissionScope(ctx,cap),a.hubId??undefined);
 const payees=[];
 for(const tag of tags){
  const p=targets.get(tag.payee.id+':'+tag.payee.version);if(!p)throw new ApiError(404,'NOT_FOUND');if(p.kind==='academy')throw new ApiError(400,'EXTERNAL_COUNTERPARTY_REQUIRED');
  if(p.hub_id!==null){hubs.add(p.hub_id);for(const cap of ['counterparty-balances.view','journals.view',...edit?['counterparty-balances.edit','journals.edit']:[]] as Capability[])requireScope(permissionScope(ctx,cap),p.hub_id);}
  if(!retained){const line=lines[tag.lineNumber-1],a=line?byId.get(line.accountId):null;if(!a||!['asset','liability'].includes(a.kind)||!['unclassified','other'].includes(a.operationalRole))throw new ApiError(400,'COUNTERPARTY_BALANCE_ACCOUNT_REQUIRED');if((tag.category==='opening_balance')!==(purpose==='opening')||purpose==='closing')throw new ApiError(400,'COUNTERPARTY_PURPOSE_INVALID');if(checkState&&(!p.active||!p.currentActive||p.version!==p.currentVersion))throw new ApiError(409,'COUNTERPARTY_CHANGED');}
  payees.push({id:p.id,version:p.version,currentVersion:p.currentVersion,active:p.active,currentActive:p.currentActive,hubId:p.hub_id,personId:p.person_id,kind:p.kind});
 }
 return {tags,payees,hubs:[...hubs].sort(),scope:hubs.has(null)?{all:true,hubs:[]}:{all:false,hubs:[...hubs].filter((h):h is string=>h!==null).sort()}};
}
export async function counterpartyJournalReviewer(ctx:ApiContext,p:Proposal){
 if(await master(ctx))return;const input=z.object({reversesId:uuid.optional(),counterpartyLines:journalCounterpartyLines.optional()}).passthrough().parse(p.payload),tags=p.action==='finance.journal.reverse'?await retainedJournalCounterparties(ctx,input.reversesId!):input.counterpartyLines;
 if(tags&&(await payeeSelection(ctx,tags.map(t=>t.payee))).some(v=>v.person_id===ctx.credential.person_id))throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');
}
export async function insertJournalCounterparties(ctx:ApiContext,p:Proposal,tags:Tag|undefined){
 if(!tags)return;if(p.action!=='finance.journal.post')throw new ApiError(400,'STANDALONE_COUNTERPARTY_POSTING_REQUIRED');
 await ctx.db.query("INSERT INTO public.finance_journal_counterparties(academy_id,journal_id,line_number,payee_id,payee_version,category,approval_id,created_by) SELECT $1,$2,(t->>'lineNumber')::smallint,(t#>>'{payee,id}')::uuid,(t#>>'{payee,version}')::integer,t->>'category',$3,$4 FROM jsonb_array_elements($5::jsonb) t",[ctx.credential.academy_id,p.target_id,p.id,ctx.credential.person_id,JSON.stringify(tags)]);
}

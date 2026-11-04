import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { parseBankStatement,statementInput } from '../core/bank-statement.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { accountRow } from './finance.ts';
import { accountingDate } from './finance-periods.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),reason=text.trim().min(1).max(2000);
const requestInput=statementInput.extend({accountId:uuid,accountVersion:z.number().int().positive().max(2147483647),sourceName:text.trim().min(1).max(200),reason});
const payload=requestInput.extend({normalized:z.unknown()}),voidInput=z.object({reason}).strict(),voidPayload=voidInput.extend({importId:uuid});
const listQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),includeVoided:z.enum(['true','false']).transform(v=>v==='true').default(false)}).strict();
const rowQuery=z.object({limit:listQuery.shape.limit,afterLine:z.coerce.number().int().min(0).max(500).default(0),from:accountingDate.optional(),through:accountingDate.optional()}).strict().refine(v=>!v.from||!v.through||v.from<=v.through);
type Batch={id:string;account_id:string;account_version:number;currency_id:string;unit_scale:number;source_name:string;source_hash:string;import_hash:string;mapping:unknown;row_count:number;approval_id:string;created_at:Date|string;void_id:string|null};
const fields='i.id,i.account_id,i.account_version,i.currency_id,i.unit_scale,i.source_name,i.source_hash,i.import_hash,i.mapping,i.row_count,i.approval_id,i.created_at,v.id AS void_id';
const from='public.finance_statement_imports i LEFT JOIN public.finance_statement_voids v ON v.academy_id=i.academy_id AND v.import_id=i.id';
function allowed(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
async function account(ctx:ApiContext,id:string,edit=false){const a=await accountRow(ctx,id);requireScope(allowed(ctx,'bank-statements.view'),a.hubId??undefined);if(edit)requireScope(allowed(ctx,'bank-statements.edit'),a.hubId??undefined);return a;}
async function batch(ctx:ApiContext,id:string,edit=false){allowed(ctx,'bank-statements.view');const b=(await ctx.db.query<Batch>('SELECT '+fields+' FROM '+from+' WHERE i.id=$1',[id])).rows[0];if(!b)throw new ApiError(404,'NOT_FOUND');try{return {b,a:await account(ctx,b.account_id,edit)};}catch(error){if(error instanceof ApiError&&error.status===403)throw new ApiError(404,'NOT_FOUND');throw error;}}
function view(b:Batch){return {id:b.id,accountId:b.account_id,accountVersion:b.account_version,currencyId:b.currency_id,unitScale:b.unit_scale,sourceName:b.source_name,sourceHash:b.source_hash,importHash:b.import_hash,mapping:b.mapping,rowCount:b.row_count,approvalId:b.approval_id,createdAt:b.created_at,state:b.void_id?'void':'imported',voidId:b.void_id,sourceVerified:false,reconciled:false,ledgerAdjusted:false,moneyMovementPerformed:false};}
async function locked(ctx:ApiContext,id:string){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.finance_accounts WHERE id=$1 FOR UPDATE',[id]);}
async function basis(ctx:ApiContext,raw:unknown,lock=false,checkState=true){
 const v=payload.parse(raw);let a=await account(ctx,v.accountId,true);if(lock){await locked(ctx,a.id);a=await account(ctx,a.id,true);}
 const normalized=parseBankStatement({csv:v.csv,mapping:v.mapping},a.unitScale);if(!isDeepStrictEqual(normalized,v.normalized))throw new ApiError(409,'STATEMENT_NORMALIZATION_CHANGED');
 if(checkState&&(a.version!==v.accountVersion||!a.active||!['cash','bank','credit_card'].includes(a.operationalRole)))throw new ApiError(409,'STATEMENT_ACCOUNT_CHANGED');
 if(!(await ctx.db.query<{valid:boolean}>("SELECT $1::date<=(clock_timestamp() AT TIME ZONE 'UTC'+interval '14 hours')::date AS valid",[normalized.through])).rows[0].valid)throw new ApiError(400,'FUTURE_STATEMENT_ROWS_FORBIDDEN');
 if(checkState&&(await ctx.db.query(`SELECT i.id FROM ${from} WHERE i.account_id=$1 AND i.import_hash=$2 AND v.id IS NULL`,[a.id,normalized.importHash])).rows.length)throw new ApiError(409,'STATEMENT_ALREADY_IMPORTED');
 return {a,normalized,accounts:[{id:a.id,version:a.version,hubId:a.hubId,currencyId:a.currencyId,unitScale:a.unitScale,active:a.active,operationalRole:a.operationalRole}]};
}
async function voidBasis(ctx:ApiContext,raw:unknown,lock=false,checkState=true){const v=voidPayload.parse(raw);let current=await batch(ctx,v.importId,true);if(lock){await locked(ctx,current.a.id);current=await batch(ctx,v.importId,true);}if(checkState&&current.b.void_id)throw new ApiError(409,'STATEMENT_ALREADY_VOID');return {...current,accounts:[{id:current.a.id,version:current.a.version,hubId:current.a.hubId}],importId:current.b.id,voidId:current.b.void_id};}
async function dependencies(ctx:ApiContext,raw:unknown,reversing:boolean,purpose:'request'|'review'){
 try{const b=reversing?await voidBasis(ctx,raw):await basis(ctx,raw);return JSON.parse(JSON.stringify({accounts:b.accounts,...'importId'in b?{importId:b.importId,voidId:b.voidId}:{importHash:b.normalized.importHash}}));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[400,403,404,409].includes(error.status))return {unavailable:error.code};throw error;}
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 if(p.action==='finance.statement.void'){const b=await voidBasis(ctx,p.payload,true);await ctx.db.query('INSERT INTO public.finance_statement_voids(academy_id,id,import_id,approval_id,created_by) VALUES($1,$2,$3,$4,$5)',[ctx.credential.academy_id,p.target_id,b.importId,p.id,ctx.credential.person_id]);await record(ctx.db,ctx.credential,ctx.requestId,'finance.statement.voided',b.importId,b.a.hubId,{approvalId:p.id,severity:'critical',hasReason:true,ledgerAdjusted:false});return {importId:b.importId,voidId:p.target_id,ledgerAdjusted:false};}
 const v=payload.parse(p.payload),b=await basis(ctx,v,true);
 await ctx.db.query(`INSERT INTO public.finance_statement_imports(academy_id,id,account_id,account_version,currency_id,unit_scale,source_name,source_hash,import_hash,mapping,row_count,approval_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,[ctx.credential.academy_id,p.target_id,b.a.id,b.a.version,b.a.currencyId,b.a.unitScale,v.sourceName,b.normalized.sourceHash,b.normalized.importHash,JSON.stringify(v.mapping),b.normalized.rows.length,p.id,ctx.credential.person_id]);
 await ctx.db.query(`INSERT INTO public.finance_statement_rows(academy_id,import_id,account_id,line,posted_on,debit_net_minor,description,reference,spreadsheet_unsafe_text)
  SELECT $1,$2,$3,x.line,x."postedOn",x."debitNetMinor",x.description,x.reference,x."spreadsheetUnsafeText" FROM jsonb_to_recordset($4::jsonb) AS x(line integer,"postedOn" date,"debitNetMinor" numeric,description text,reference text,"spreadsheetUnsafeText" boolean)`,[ctx.credential.academy_id,p.target_id,b.a.id,JSON.stringify(b.normalized.rows)]);
 await record(ctx.db,ctx.credential,ctx.requestId,'finance.statement.imported',p.target_id,b.a.hubId,{approvalId:p.id,rowCount:b.normalized.rows.length,severity:'critical',hasReason:true,ledgerAdjusted:false});return view((await batch(ctx,p.target_id)).b);
}
export const statementImportActions:ApprovalRegistry=Object.fromEntries(['finance.statement.import','finance.statement.void'].map(action=>[action,{requestCapability:'bank-statements.edit' as const,privacyCapability:'bank-statements.edit' as const,createdStatus:201 as const,
 async validate(ctx:ApiContext,_id:string,raw:unknown){const b=action==='finance.statement.void'?await voidBasis(ctx,raw,true,false):await basis(ctx,raw,true,false);return b.a.hubId?{all:false,hubs:[b.a.hubId]}:{all:true,hubs:[]};},
 dependencies:(ctx:ApiContext,_id:string,raw:unknown,purpose:'request'|'review')=>dependencies(ctx,raw,action==='finance.statement.void',purpose),apply
}]));
export async function statementImports(ctx:ApiContext,registry:ApprovalRegistry=statementImportActions):Promise<Reply|null>{
 const list=/^finance\/accounts\/([^/]+)\/statement-imports$/.exec(ctx.path),item=/^finance\/statement-imports\/([^/]+)(?:\/(rows|void))?$/.exec(ctx.path),create=ctx.path==='finance/statement-imports',preview=ctx.path==='finance/statement-imports/preview';
 if(!list&&!item&&!create&&!preview)return null;
 if(create||preview){if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const v=requestInput.parse(await jsonBody(ctx.request,786432)),a=await account(ctx,v.accountId,true),normalized=parseBankStatement({csv:v.csv,mapping:v.mapping},a.unitScale);
  if(preview)return {status:200,body:{data:normalized,persisted:false}};
  return propose(ctx,registry,'finance.statement.import',null,0,{...v,normalized});
 }
 if(item?.[2]==='void'&&ctx.request.method==='POST'){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const v=voidInput.parse(await jsonBody(ctx.request)),id=uuid.parse(item[1]);await batch(ctx,id,true);return propose(ctx,registry,'finance.statement.void',null,0,{...v,importId:id});}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(list){const id=uuid.parse(list[1]);await account(ctx,id);const q=listQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<Batch>(`SELECT ${fields} FROM ${from} WHERE i.account_id=$1 AND($2::uuid IS NULL OR i.id>$2) AND($3::boolean OR v.id IS NULL) ORDER BY i.id LIMIT $4`,[id,q.after??null,q.includeVoided,q.limit+1])).rows;return {status:200,body:{accountId:id,data:rows.slice(0,q.limit).map(view),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};}
 const {b}=await batch(ctx,uuid.parse(item![1]));if(!item![2]){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:view(b)}};}if(item![2]!=='rows')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const q=rowQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{line:number}>(`SELECT r.line,r.posted_on::text AS "postedOn",r.debit_net_minor::text AS "debitNetMinor",r.description,r.reference,r.spreadsheet_unsafe_text AS "spreadsheetUnsafeText",
 EXISTS(SELECT 1 FROM public.finance_statement_rows other JOIN public.finance_statement_imports i ON i.academy_id=other.academy_id AND i.id=other.import_id WHERE other.account_id=r.account_id AND other.posted_on=r.posted_on AND other.debit_net_minor=r.debit_net_minor AND other.description=r.description AND other.reference=r.reference AND(other.import_id<>r.import_id OR other.line<>r.line) AND NOT EXISTS(SELECT 1 FROM public.finance_statement_voids v WHERE v.academy_id=i.academy_id AND v.import_id=i.id)) AS "possibleDuplicate"
 FROM public.finance_statement_rows r WHERE r.import_id=$1 AND r.line>$2 AND($3::date IS NULL OR r.posted_on>=$3) AND($4::date IS NULL OR r.posted_on<=$4) ORDER BY r.line LIMIT $5`,[b.id,q.afterLine,q.from??null,q.through??null,q.limit+1])).rows;
 return {status:200,body:{importId:b.id,state:b.void_id?'void':'imported',data:rows.slice(0,q.limit),nextLine:rows.length>q.limit?rows[q.limit-1].line:null,duplicateCandidatesAreNotDecisions:true,reconciled:false,ledgerAdjusted:false}};
}
export const statementImportsContract=[
 {path:'/api/v1/finance/statement-imports/preview',method:'post',summary:'Bounded explicit-map CSV normalization without persistence; counts/amounts are unverified and never posted',schema:requestInput,readOnly:true},
 {path:'/api/v1/finance/statement-imports',method:'post',summary:'Request reviewed private CSV import with exact source hash, mapping and retained rows; no bank connection, tax decision or accounting posting',schema:requestInput},
 {path:'/api/v1/finance/accounts/{id}/statement-imports',method:'get',summary:'Scoped current import directory with optional retained voided batches',querySchema:listQuery},
 {path:'/api/v1/finance/statement-imports/{id}',method:'get',summary:'Private immutable reviewed CSV import metadata, not the original sensitive source text'},
 {path:'/api/v1/finance/statement-imports/{id}/rows',method:'get',summary:'Private dated/pageable statement rows and non-destructive possible-duplicate flags, not reconciliation',querySchema:rowQuery},
 {path:'/api/v1/finance/statement-imports/{id}/void',method:'post',summary:'Request a retained import void without deleting rows or reversing/posting any ledger amount',schema:voidInput}
] as const;

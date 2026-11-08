import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,propose,master,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeNonempty,type Capability,type Scope } from '../core/policy.ts';
import { calculateNetPay,netPayDefinition,type NetPayDefinition } from '../core/net-pay-plan.ts';
import { formatMoneyTotal,readMinorUnits,parseMoney } from '../core/money.ts';
import { canadianContributionsInput,calculateCanadianContributions } from '../core/canadian-payroll-contributions.ts';
import { authorizedPayrun,authorizePayrunSources } from './payruns.ts';
export { run as authorizedNetPayRun };

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(0).max(2147483646);
const change=z.object({expectedVersion:version,state:z.enum(['prepared','withdrawn']).default('prepared'),definition:netPayDefinition,reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict();
const read=z.object({version:z.coerce.number().int().positive().max(2147483647).optional()}).strict(),history=z.object({limit:z.coerce.number().int().min(1).max(10).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
const directory=z.object({personId:uuid.optional(),hubId:uuid.optional(),currencyId:uuid.optional(),state:z.enum(['prepared','withdrawn']).optional(),runStatus:z.enum(['gross_grouped','cancelled']).optional(),limit:z.coerce.number().int().min(1).max(100).default(25),after:uuid.optional()}).strict();
type Source={runId:string;personId:string;currencyId:string;unitScale:number;grossMinor:string;scope:Scope;cancellationId:string|null;recordedSourcesCurrent:boolean;runSourceSha256:string};
type Basis={source:Source;before:{version:number;state:string;definition:NetPayDefinition;amounts:Record<string,string>}|null;activePosting?:boolean};
type Revision={version:number;latest_version:number;state:'prepared'|'withdrawn';definition:NetPayDefinition;amounts:Record<string,string>;source_snapshot:Basis;changed_by:string;approval_id:string;reason:string;created_at:string};
async function run(ctx:ApiContext,id:string,edit=false){
 const r=await authorizedPayrun(ctx,id);for(const cap of ['payrun-net.view',...edit?['payrun-net.edit']:[]] as Capability[]){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');if(!(await ctx.db.query<{ok:boolean}>('SELECT public.scope_contains($1::jsonb,$2::jsonb) ok',[JSON.stringify(s),JSON.stringify(r.scope)])).rows[0].ok)throw new ApiError(404,'NOT_FOUND');}
 await authorizePayrunSources(ctx,r.source_snapshot.items,false);return r;
}
async function basis(ctx:ApiContext,id:string,raw:unknown){
 const i=change.parse(raw);await run(ctx,id,true);const h=(await ctx.db.query<{version:number}>('SELECT version FROM public.payrun_net_statements WHERE run_id=$1',[id])).rows[0];if((h?.version??0)!==i.expectedVersion)throw new ApiError(409,'PAYRUN_NET_VERSION_CHANGED');
 const b=(await ctx.db.query<{basis:Basis|null}>('SELECT public.payrun_net_basis($1,$2) basis',[id,i.expectedVersion])).rows[0].basis;if(!b)throw new ApiError(404,'NOT_FOUND');
 if(b.activePosting)throw new ApiError(409,'PAYRUN_NET_POSTING_REVERSAL_REQUIRED');
 if(i.expectedVersion===0&&i.state!=='prepared')throw new ApiError(400,'INITIAL_NET_STATEMENT_MUST_BE_PREPARED');
 if(i.state==='prepared'&&(b.source.cancellationId||!b.source.recordedSourcesCurrent))throw new ApiError(409,'PAYRUN_NET_SOURCE_UNAVAILABLE');
 calculateNetPay(readMinorUnits(b.source.grossMinor),b.source.unitScale,i.definition);return b;
}
async function saved(ctx:ApiContext,id:string,v?:number){const r=(await ctx.db.query<Revision>(`SELECT r.version,h.version latest_version,r.state,r.definition,r.amounts,r.source_snapshot,r.changed_by,r.approval_id,r.reason,r.created_at::text FROM public.payrun_net_revisions r JOIN public.payrun_net_statements h ON h.academy_id=r.academy_id AND h.run_id=r.run_id WHERE r.run_id=$1 AND r.version=coalesce($2,h.version)`,[id,v??null])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');return r;}
function displayAmounts(a:Record<string,string>,scale:number){return {gross:formatMoneyTotal(readMinorUnits(a.grossMinor),scale),employeeDeductions:formatMoneyTotal(readMinorUnits(a.employeeDeductionMinor),scale),employerContributions:formatMoneyTotal(readMinorUnits(a.employerContributionMinor),scale),net:formatMoneyTotal(readMinorUnits(a.netMinor),scale),employerCost:formatMoneyTotal(readMinorUnits(a.employerCostMinor),scale)};}
function output(id:string,r:Revision,s:Source){
 const a=r.amounts,scale=r.source_snapshot.source.unitScale,current=r.version===r.latest_version&&r.state==='prepared'&&s.cancellationId===null&&s.recordedSourcesCurrent&&s.runSourceSha256===r.source_snapshot.source.runSourceSha256;
 return {runId:id,version:r.version,state:r.state,definition:r.definition,personId:s.personId,currencyId:s.currencyId,unitScale:scale,amounts:displayAmounts(a,scale),preparedSourceCurrent:current,runCancelled:s.cancellationId!==null,retained:true,statementReviewed:true,statutoryRulesCalculated:false,authorityDocumentsVerified:false,additionalLedgerPosting:false,isOfficialPaystub:false,paymentExecuted:false,payoutReady:false,createdAt:r.created_at};
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=change.parse(p.payload),b=await basis(ctx,p.target_id,i);if(!isDeepStrictEqual(b,p.review_context))throw new ApiError(409,'PAYRUN_NET_SOURCES_CHANGED');
 if(i.expectedVersion===0)await ctx.db.query('INSERT INTO public.payrun_net_statements(academy_id,run_id) VALUES($1,$2)',[ctx.credential.academy_id,p.target_id]);else if(!(await ctx.db.query('UPDATE public.payrun_net_statements SET version=version+1 WHERE run_id=$1 AND version=$2 RETURNING run_id',[p.target_id,i.expectedVersion])).rows.length)throw new ApiError(409,'PAYRUN_NET_VERSION_CHANGED');
 await ctx.db.query('INSERT INTO public.payrun_net_revisions(academy_id,run_id,version,state,definition,source_snapshot,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)',[ctx.credential.academy_id,p.target_id,i.expectedVersion+1,i.state,JSON.stringify(i.definition),JSON.stringify(b),ctx.credential.person_id,p.id,i.reason]);
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,null,{version:i.expectedVersion+1,state:i.state,severity:'critical',approvalId:p.id,paymentExecuted:false,additionalLedgerPosting:false});return output(p.target_id,await saved(ctx,p.target_id),b.source);
}
export const payrunNetActions:ApprovalRegistry={'work.payrun-net.change':{
 requestCapability:'payrun-net.edit',privacyCapability:'payrun-net.view',
 async validate(ctx,id,raw){const r=await run(ctx,id,true);await ctx.db.query('SELECT public.lock_hourly_worker($1)',[r.person_id]);return r.scope;},
 async dependencies(ctx,id,raw,purpose){try{return await basis(ctx,id,raw);}catch(e){if(purpose==='review'&&e instanceof ApiError&&[400,403,404,409,422].includes(e.status))return {unavailable:e.code};throw e;}},
 async authorizeReviewer(ctx,p){const r=await run(ctx,p.target_id,true);if(r.person_id===ctx.credential.person_id&&!await master(ctx))throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},apply
}};
export async function payrunNet(ctx:ApiContext,registry:ApprovalRegistry=payrunNetActions):Promise<Reply|null>{
 if(ctx.path==='payroll/net-statements')return netDirectory(ctx);
 const m=/^payroll\/payruns\/([^/]+)\/net(?:\/(history|contributions-preview))?$/.exec(ctx.path);if(!m)return null;const id=uuid.parse(m[1]),params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params);
 if(m[2]==='contributions-preview'){
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(q);const input=canadianContributionsInput.parse(await jsonBody(ctx.request,16384));await lockApprovalWrites(ctx);const r=await run(ctx,id);await ctx.db.query('SELECT public.lock_hourly_worker($1)',[r.person_id]);
  const s=(await ctx.db.query<{source:Source}>('SELECT public.payrun_net_source($1) source',[id])).rows[0].source;if(!s||s.cancellationId||!s.recordedSourcesCurrent)throw new ApiError(409,'PAYRUN_CONTRIBUTION_SOURCE_UNAVAILABLE');
  const currency=(await ctx.db.query<{code:string}>('SELECT code FROM public.finance_currencies WHERE id=$1',[s.currencyId])).rows[0];if(currency?.code!=='CAD'||s.unitScale!==2)throw new ApiError(409,'CAD_PAYRUN_REQUIRED');if(!r.planned_pay_on.startsWith('2026-'))throw new ApiError(409,'PAYRUN_CONTRIBUTION_YEAR_UNSUPPORTED');
  const gross=readMinorUnits(s.grossMinor);if(parseMoney(input.pensionableEarnings,2)>gross||parseMoney(input.insurableEarnings,2)>gross)throw new ApiError(400,'CONTRIBUTION_EARNINGS_EXCEED_RECORDED_GROSS');
  return {status:200,body:{data:{runId:id,sourceSha256:s.runSourceSha256,plannedPayOn:r.planned_pay_on,gross:formatMoneyTotal(gross,2),...calculateCanadianContributions(input),employmentClassificationVerified:false,periodCompletenessVerified:false,cppExemptionAlreadyUsedThisPayPeriodChecked:false,nonCashBenefitsSupported:false,actualPaymentDateVerified:false,inputBasis:'explicit_reviewed_scenario_not_persisted_ytd_or_tax_profile',netStatementPrepared:false}}};
 }
 if(ctx.request.method==='POST'){if(m[2])throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(q);const i=change.parse(await jsonBody(ctx.request,65536));return propose(ctx,registry,'work.payrun-net.change',id,i.expectedVersion,i);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);await run(ctx,id,!!m[2]);
 if(m[2]){const i=history.parse(q),rows=(await ctx.db.query<Revision>('SELECT version,state,definition,amounts,changed_by,approval_id,reason,created_at::text FROM public.payrun_net_revisions WHERE run_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,i.afterVersion,i.limit+1])).rows;return {status:200,body:{data:rows.slice(0,i.limit),nextVersion:rows.length>i.limit?rows[i.limit-1].version:null}};}
 const i=read.parse(q),r=await saved(ctx,id,i.version),s=(await ctx.db.query<{source:Source}>('SELECT public.payrun_net_source($1) source',[id])).rows[0].source;return {status:200,body:{data:output(id,r,s)}};
}
async function netDirectory(ctx:ApiContext):Promise<Reply>{
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const i=directory.parse(Object.fromEntries(params));await lockApprovalWrites(ctx);
 const caps:Capability[]=['payruns.view','payrun-net.view','work-pay.view','payroll-accruals.view','payroll-adjustments.view'],s=Object.fromEntries(caps.map(c=>[c,permissionScope(ctx,c)]));if(!scopeNonempty(s['payruns.view'])||!scopeNonempty(s['payrun-net.view']))throw new ApiError(403,'FORBIDDEN');const ceiling={all:ctx.credential.all_hubs,hubs:ctx.credential.hub_ids};
 const rows=(await ctx.db.query<{runId:string;personId:string;currencyId:string;unitScale:number;reference:string;serviceFrom:string;serviceThrough:string;plannedPayOn:string;version:number;state:string;runCancelled:boolean;amounts:Record<string,string>;recordedAt:string}>(`SELECT x.id "runId",x.person_id "personId",x.currency_id "currencyId",x.unit_scale "unitScale",x.reference,x.service_from::text "serviceFrom",x.service_through::text "serviceThrough",x.planned_pay_on::text "plannedPayOn",r.version,r.state,x.cancellation_id IS NOT NULL "runCancelled",r.amounts,r.created_at::text "recordedAt"
 FROM public.payrun_net_statements h JOIN public.payrun_net_revisions r ON r.academy_id=h.academy_id AND r.run_id=h.run_id AND r.version=h.version JOIN public.payrun_groups x ON x.academy_id=h.academy_id AND x.id=h.run_id
 WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array($1::jsonb->'payruns.view',$1::jsonb->'payrun-net.view',$2::jsonb)) p WHERE public.scope_contains(p,x.scope) IS NOT TRUE)
 AND public.payrun_net_source_allows(x.id,'work-pay.view',$1::jsonb->'work-pay.view') AND public.payrun_net_source_allows(x.id,'work-pay.view',$2::jsonb)
 AND(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(x.source_snapshot->'items') v WHERE v->>'kind'<>'manual_bonus') OR public.payrun_net_source_allows(x.id,'payroll-accruals.view',$1::jsonb->'payroll-accruals.view'))
 AND(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(x.source_snapshot->'items') v WHERE v->>'kind'='manual_bonus') OR public.payrun_net_source_allows(x.id,'payroll-adjustments.view',$1::jsonb->'payroll-adjustments.view'))
 AND($3::uuid IS NULL OR x.person_id=$3) AND($4::uuid IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(x.scope->'workContexts') v WHERE v->>'hubId'=$4::uuid::text)) AND($5::uuid IS NULL OR x.currency_id=$5) AND($6::text IS NULL OR r.state=$6) AND($7::text IS NULL OR(x.cancellation_id IS NULL)=($7='gross_grouped')) AND($8::uuid IS NULL OR x.id>$8)
 ORDER BY x.id LIMIT $9`,[JSON.stringify(s),JSON.stringify(ceiling),i.personId??null,i.hubId??null,i.currencyId??null,i.state??null,i.runStatus??null,i.after??null,i.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,i.limit).map(({amounts,...r})=>({...r,amounts:displayAmounts(amounts,r.unitScale),retained:true,statementReviewed:true,payoutReady:false,paymentExecuted:false,isOfficialPaystub:false})),nextCursor:rows.length>i.limit?rows[i.limit-1].runId:null,coverage:'permitted_current_manual_statement_revisions_only',statutoryRulesCalculated:false,additionalLedgerPosting:false}};
}
export const payrunNetContract=[
 {path:'/api/v1/payroll/payruns/{id}/net/contributions-preview',method:'post',summary:'Source-authorized read-only 2026 CPP/CPP2 and standard EI salary/wage scenario outside Quebec: exact cents,explicit reviewed same-employer YTD and pensionable months,regular versus standalone non-periodic exemption;current CAD2 gross/year/source bound. No income tax,classification certification,persisted YTD,automatic statement,ledger posting or payment.',schema:canadianContributionsInput,readOnly:true},
 {path:'/api/v1/payroll/net-statements',method:'get',summary:'Current private net-statement directory with worker/hub/currency/state/run-status filters and whole-source permissions applied before pagination. Summaries exclude review definitions and legal authority references;not a payment register or statutory/paystub certification.',querySchema:directory},
 {path:'/api/v1/payroll/payruns/{id}/net',method:'get',summary:'Private current or historical reviewed manual net-pay statement;source-current status is not statutory validation,paystub or payment clearance',querySchema:read},
 {path:'/api/v1/payroll/payruns/{id}/net',method:'post',summary:'Upper-human-reviewed manual net statement preparation,correction or withdrawal;exact source pins and immutable history without additional ledger posting or payment execution',schema:change},
 {path:'/api/v1/payroll/payruns/{id}/net/history',method:'get',summary:'Source-authorized editor-only immutable manual net-statement definitions and review history',querySchema:history}
] as const;

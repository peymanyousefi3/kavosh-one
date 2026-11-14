import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,propose,master,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeNonempty,type Capability,type Scope } from '../core/policy.ts';
import { formatMoneyTotal,readMinorUnits } from '../core/money.ts';
import { accountingDate } from './finance-periods.ts';
import { payrunReadiness,payrunRecordedSources } from './payrun-readiness.ts';
import { calculateNetPay,netPayDefinition } from '../core/net-pay-plan.ts';
export { row as authorizedPayrun,sourceAuthority as authorizePayrunSources };

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'));
const kind=z.enum(['hourly','salary','project','manual_bonus','tuition_course','tuition_session','tuition_collection']);
const earning=z.object({kind,sourceId:uuid,allocationId:uuid}).strict();
const key=(r:z.infer<typeof earning>)=>[r.kind,r.sourceId,r.allocationId].join(':');
const create=z.object({personId:uuid,currencyId:uuid,reference:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/),serviceFrom:accountingDate,serviceThrough:accountingDate,plannedPayOn:accountingDate,earnings:z.array(earning).min(1).max(200).refine(v=>new Set(v.map(key)).size===v.length).transform(v=>v.sort((a,b)=>key(a).localeCompare(key(b)))),earningReview:reason,taxReview:reason,reason}).strict().refine(v=>v.serviceFrom>='1900-01-01'&&v.plannedPayOn>='1900-01-01'&&v.serviceThrough>=v.serviceFrom&&(Date.parse(v.serviceThrough)-Date.parse(v.serviceFrom))/86400000<=365);
const cancel=z.object({reason}).strict(),cancelInput=cancel.extend({runId:uuid}),empty=z.object({}).strict();
const paging=z.object({personId:uuid.optional(),currencyId:uuid.optional(),sourceKind:kind.optional(),sourceId:uuid.optional(),status:z.enum(['gross_grouped','cancelled']).optional(),limit:z.coerce.number().int().min(1).max(100).default(25),after:uuid.optional()}).strict().refine(v=>(v.sourceKind===undefined)===(v.sourceId===undefined));
const candidates=z.object({personId:uuid,currencyId:uuid,through:accountingDate,kind:kind.optional(),afterKind:kind.optional(),afterId:uuid.optional(),afterAllocationId:uuid.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().refine(v=>[v.afterKind,v.afterId,v.afterAllocationId].filter(x=>x!==undefined).length%3===0);
type Item={kind:z.infer<typeof kind>;sourceId:string;allocationId:string;personId:string;hubId:string|null;currencyId:string;unitScale:number;minor:string;postedOn:string;dueOn:string;from:string;through:string;voidId:string|null;claimed:boolean;termsVersions:number[];legacyDateReviewRequired:boolean;offPeriodSource:boolean};
type Source={items:Item[];terms:Record<string,unknown>[];contexts:Record<string,unknown>[];unitScale:number;grossMinor:string;scope:Scope;unavailable:string|null};
type Run={id:string;person_id:string;currency_id:string;unit_scale:number;gross_minor:string;reference:string;service_from:string;service_through:string;planned_pay_on:string;cancellation_id:string|null;created_at:string;scope:Scope;source_snapshot:Source};
const columns='x.id,x.person_id,x.currency_id,x.unit_scale,x.gross_minor::text,x.reference,x.service_from::text,x.service_through::text,x.planned_pay_on::text,x.cancellation_id,x.created_at::text,x.scope,x.source_snapshot';
function scopes(ctx:ApiContext,edit=false){return ['payruns.view',...edit?['payruns.edit']:[]].map(c=>{const s=permissionScope(ctx,c as Capability);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;});}
const ceiling=(ctx:ApiContext)=>({all:ctx.credential.all_hubs,hubs:ctx.credential.hub_ids});
async function visible(ctx:ApiContext,scope:Scope,edit=false){for(const s of [...scopes(ctx,edit),ceiling(ctx)])if(!(await ctx.db.query<{ok:boolean}>('SELECT public.scope_contains($1::jsonb,$2::jsonb) ok',[JSON.stringify(s),JSON.stringify(scope)])).rows[0].ok)throw new ApiError(404,'NOT_FOUND');}
async function row(ctx:ApiContext,id:string,edit=false){scopes(ctx,edit);const r=(await ctx.db.query<Run>('SELECT '+columns+' FROM public.payrun_groups x WHERE id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');await visible(ctx,r.scope,edit);return r;}
type AccessItem=Pick<Item,'kind'|'sourceId'|'allocationId'|'personId'|'hubId'>;
async function sourceAuthority(ctx:ApiContext,items:AccessItem[],edit=true){
 const caps:Capability[]=['payruns.view','payruns.edit','work-pay.view','payroll-accruals.view','payroll-adjustments.view'],s=Object.fromEntries(caps.map(c=>[c,c==='payruns.edit'&&!edit?{all:true,hubs:[]}:permissionScope(ctx,c)]));
 const ok=(await ctx.db.query<{ok:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) v CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array($2::jsonb->'payruns.view',$2::jsonb->'payruns.edit',$2::jsonb->'work-pay.view',CASE WHEN v->>'kind'='manual_bonus' THEN $2::jsonb->'payroll-adjustments.view' ELSE $2::jsonb->'payroll-accruals.view' END,$3::jsonb)) p WHERE public.work_scope_allows(p,(v->>'hubId')::uuid,(v->>'personId')::uuid) IS NOT TRUE)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) v LEFT JOIN public.payroll_hourly_accruals h ON h.id=(v->>'sourceId')::uuid WHERE v->>'kind'='hourly' AND(h.id IS NULL OR public.payroll_preparation_allows(h.source_snapshot->'payroll',jsonb_build_array($2::jsonb->'work-pay.view',$2::jsonb->'payroll-accruals.view',$3::jsonb),'[{"all":true,"hubs":[]}]'::jsonb) IS NOT TRUE)) ok`,[JSON.stringify(items),JSON.stringify(s),JSON.stringify(ceiling(ctx))])).rows[0].ok;
 if(!ok)throw new ApiError(404,'NOT_FOUND');
}
async function access(ctx:ApiContext,cancelling:boolean,raw:unknown){
 scopes(ctx,true);
 if(cancelling){const r=await row(ctx,cancelInput.parse(raw).runId,true);await ctx.db.query('SELECT public.lock_hourly_worker($1)',[r.person_id]);return r.scope;}
 const i=create.parse(raw),items=(await ctx.db.query<AccessItem>(`SELECT c.kind,c.source_id "sourceId",c.allocation_id "allocationId",c.person_id "personId",c.hub_id "hubId" FROM jsonb_to_recordset($1::jsonb) r(kind text,"sourceId" uuid,"allocationId" uuid) JOIN public.payrun_earning_catalogue c ON c.kind=r.kind AND c.source_id=r."sourceId" AND c.allocation_id=r."allocationId"`,[JSON.stringify(i.earnings)])).rows;
 await sourceAuthority(ctx,items);if(items.length!==i.earnings.length)throw new ApiError(404,'NOT_FOUND');
 await ctx.db.query('SELECT public.lock_hourly_worker($1)',[i.personId]);for(const id of [...new Set(items.map(v=>v.allocationId))].sort())await ctx.db.query('SELECT public.lock_pay_period_work($1)',[id]);
 return(await ctx.db.query<{scope:Scope}>('SELECT public.payrun_scope($1::jsonb) scope',[JSON.stringify(items)])).rows[0].scope;
}
async function basis(ctx:ApiContext,cancelling:boolean,raw:unknown){
 scopes(ctx,true);
 if(cancelling){const i=cancelInput.parse(raw);await row(ctx,i.runId,true);const s=(await ctx.db.query<{source:Record<string,unknown>|null}>('SELECT public.payrun_cancel_source($1) source',[i.runId])).rows[0].source;if(!s)throw new ApiError(404,'NOT_FOUND');if(s.cancellationId)throw new ApiError(409,'PAYRUN_ALREADY_CANCELLED');if(s.netPostingActive)throw new ApiError(409,'PAYRUN_NET_POSTING_REVERSAL_REQUIRED');if(s.taxPeriodReservationActive)throw new ApiError(409,'TAX_PERIOD_RESERVATION_RELEASE_REQUIRED');return s;}
 const i=create.parse(raw),s=(await ctx.db.query<{source:Source}>('SELECT public.payrun_group_source($1::jsonb) source',[JSON.stringify(i)])).rows[0].source;
 await sourceAuthority(ctx,s.items??[]);if(s.unavailable)throw new ApiError(s.unavailable==='PAYRUN_SOURCE_NOT_FOUND'?404:s.unavailable==='PAYRUN_REQUIRES_BACKGROUND_JOB'?422:409,s.unavailable);await visible(ctx,s.scope,true);if(Buffer.byteLength(JSON.stringify(s))>500000)throw new ApiError(422,'PAYRUN_REQUIRES_BACKGROUND_JOB');return s;
}
function output(r:Run){return {id:r.id,personId:r.person_id,currencyId:r.currency_id,unitScale:r.unit_scale,grossAmount:formatMoneyTotal(readMinorUnits(r.gross_minor),r.unit_scale),reference:r.reference,serviceFrom:r.service_from,serviceThrough:r.service_through,plannedPayOn:r.planned_pay_on,status:r.cancellation_id?'cancelled':'gross_grouped',cancellationId:r.cancellation_id,createdAt:r.created_at,sourceCount:new Set(r.source_snapshot.items.map(v=>v.kind+':'+v.sourceId)).size,allocationCount:r.source_snapshot.items.length,
 earnings:r.source_snapshot.items.map(({minor,claimed,voidId,termsVersions,...v})=>({...v,grossAmount:formatMoneyTotal(readMinorUnits(minor),v.unitScale)})),
 sourceOwnershipPersisted:true,claimsReleased:r.cancellation_id!==null,additionalLedgerPosting:false,completePayroll:false,netPayCalculated:false,statutoryDeductionsCalculated:false,employerContributionsCalculated:false,salesTaxTreatmentDetermined:false,payoutReadinessDetermined:false,paymentExecuted:false,paymentStatus:'not_paid_by_this_workflow',coverage:'explicit_selected_recorded_gross_allocations_only',periodCompletenessVerified:false};}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const cancelling=p.action==='work.payrun.cancel',s=await basis(ctx,cancelling,p.payload);if(!isDeepStrictEqual(s,p.review_context))throw new ApiError(409,'PAYRUN_SOURCES_CHANGED');let id=p.target_id;
 if(cancelling){const i=cancelInput.parse(p.payload);id=i.runId;await ctx.db.query('INSERT INTO public.payrun_group_cancellations(academy_id,id,run_id,input,source_snapshot,approval_id,created_by) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)',[ctx.credential.academy_id,p.target_id,id,JSON.stringify(i),JSON.stringify(s),p.id,ctx.credential.person_id]);await ctx.db.query('UPDATE public.payrun_groups SET cancellation_id=$2 WHERE id=$1',[id,p.target_id]);await ctx.db.query('UPDATE public.payrun_earning_claims SET released_by=$2 WHERE run_id=$1',[id,p.target_id]);}
 else{await ctx.db.query('INSERT INTO public.payrun_groups(academy_id,id,input,source_snapshot,approval_id,created_by) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6)',[ctx.credential.academy_id,id,JSON.stringify(create.parse(p.payload)),JSON.stringify(s),p.id,ctx.credential.person_id]);await ctx.db.query(`INSERT INTO public.payrun_earning_claims(academy_id,run_id,kind,source_id,allocation_id) SELECT $1,$2,v->>'kind',(v->>'sourceId')::uuid,(v->>'allocationId')::uuid FROM jsonb_array_elements($3::jsonb) v`,[ctx.credential.academy_id,id,JSON.stringify((s as Source).items)]);}
 const r=await row(ctx,id);await record(ctx.db,ctx.credential,ctx.requestId,p.action,id,null,{severity:'critical',approvalId:p.id,additionalLedgerPosting:false,paymentExecuted:false});return output(r);
}
export const payrunActions:ApprovalRegistry=Object.fromEntries([false,true].map(cancelling=>[cancelling?'work.payrun.cancel':'work.payrun.group',{
 requestCapability:'payruns.edit',privacyCapability:'payruns.view',createdStatus:201,
 async validate(ctx:ApiContext,id:string,raw:unknown){return access(ctx,cancelling,raw);},
 async dependencies(ctx:ApiContext,id:string,raw:unknown,purpose:'request'|'review'){try{return await basis(ctx,cancelling,raw);}catch(e){if(purpose==='review'&&e instanceof ApiError&&[400,403,404,409,422].includes(e.status))return {unavailable:e.code};throw e;}},
 async authorizeReviewer(ctx:ApiContext,p:Proposal){if(await master(ctx))return;const id=cancelling?(await row(ctx,cancelInput.parse(p.payload).runId,true)).person_id:create.parse(p.payload).personId;if(id===ctx.credential.person_id)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');if(!cancelling)await sourceAuthority(ctx,(p.review_context as Source).items);},apply
}])) as ApprovalRegistry;
export async function payruns(ctx:ApiContext,registry:ApprovalRegistry=payrunActions):Promise<Reply|null>{
 const match=/^payroll\/payruns(?:\/([^/]+)(?:\/(cancel|readiness|net-preview))?)?$/.exec(ctx.path);if(!match)return null;
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const q=Object.fromEntries(params);
 if(match[1]==='candidates'){
  if(ctx.request.method!=='GET'||match[2])throw new ApiError(405,'METHOD_NOT_ALLOWED');const i=candidates.parse(q);await lockApprovalWrites(ctx);const s=scopes(ctx,true),required=[permissionScope(ctx,'work-pay.view'),permissionScope(ctx,'payroll-accruals.view')],manual=permissionScope(ctx,'payroll-adjustments.view');
  const rows=(await ctx.db.query<any>(`SELECT c.kind,c.source_id "sourceId",c.allocation_id "allocationId",c.person_id "personId",c.hub_id "hubId",c.currency_id "currencyId",c.unit_scale "unitScale",c.amount_minor::text minor,c.posted_on::text "postedOn",c.due_on::text "dueOn",c.from_on::text "from",c.through_on::text "through",c.legacy_date_review "legacyDateReviewRequired"
   FROM public.payrun_earning_catalogue c WHERE c.person_id=$1 AND c.currency_id=$2 AND c.void_id IS NULL AND c.posted_on<=$3::date
   AND NOT EXISTS(SELECT 1 FROM public.payrun_earning_claims z WHERE z.academy_id=c.academy_id AND z.kind=c.kind AND z.source_id=c.source_id AND z.allocation_id=c.allocation_id AND z.released_by IS NULL)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) p WHERE public.work_scope_allows(p,c.hub_id,c.person_id) IS NOT TRUE)
   AND public.work_scope_allows($5::jsonb,c.hub_id,c.person_id) AND public.work_scope_allows(CASE WHEN c.kind='manual_bonus' THEN $7::jsonb ELSE $6::jsonb END,c.hub_id,c.person_id)
   AND(c.kind<>'hourly' OR EXISTS(SELECT 1 FROM public.payroll_hourly_accruals h WHERE h.academy_id=c.academy_id AND h.id=c.source_id AND public.payroll_preparation_allows(h.source_snapshot->'payroll',jsonb_build_array($5::jsonb,$6::jsonb,$8::jsonb),'[{"all":true,"hubs":[]}]'::jsonb)))
   AND($9::text IS NULL OR c.kind=$9) AND($10::text IS NULL OR(c.kind,c.source_id,c.allocation_id)>($10::text,$11::uuid,$12::uuid)) ORDER BY c.kind,c.source_id,c.allocation_id LIMIT $13`,[i.personId,i.currencyId,i.through,JSON.stringify([...s,ceiling(ctx)]),JSON.stringify(required[0]),JSON.stringify(required[1]),JSON.stringify(manual),JSON.stringify(ceiling(ctx)),i.kind??null,i.afterKind??null,i.afterId??null,i.afterAllocationId??null,i.limit+1])).rows;
  const page=rows.slice(0,i.limit),last=page.at(-1);return {status:200,body:{data:page.map(({minor,...v})=>({...v,grossAmount:formatMoneyTotal(readMinorUnits(minor),v.unitScale)})),nextCursor:rows.length>i.limit&&last?{afterKind:last.kind,afterId:last.sourceId,afterAllocationId:last.allocationId}:null,coverage:'permitted_unclaimed_recorded_allocations_only',payoutReadinessDetermined:false}};
 }
 const id=match[1]?uuid.parse(match[1]):null;
 if(match[2]==='net-preview'){
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(q);await lockApprovalWrites(ctx);
  let r=await row(ctx,id!);await sourceAuthority(ctx,r.source_snapshot.items,false);
  const definition=netPayDefinition.parse(await jsonBody(ctx.request,65536));
  // Use the same worker lock as cancellation/source corrections, then re-read.
  // This is a current preview, never a retained clearance to release payment.
  await ctx.db.query('SELECT public.lock_hourly_worker($1)',[r.person_id]);r=await row(ctx,id!);
  if(r.cancellation_id)throw new ApiError(409,'PAYRUN_ALREADY_CANCELLED');
  const checks=await payrunRecordedSources(ctx,r);
  if(!checks.length||checks.length!==r.source_snapshot.items.length||checks.some(v=>!v.sourceCurrent||!v.claimCurrent))throw new ApiError(409,'PAYRUN_SOURCES_CHANGED');
  const result=calculateNetPay(readMinorUnits(r.gross_minor),r.unit_scale,definition);
  return {status:200,body:{data:{runId:r.id,personId:r.person_id,currencyId:r.currency_id,unitScale:r.unit_scale,definition:result.definition,amounts:result.amounts,calculationBasis:result.calculationBasis,exactArithmetic:true,recordedSourcesCurrent:true,retained:false,approved:false,statutoryRulesCalculated:false,authorityDocumentsVerified:false,additionalLedgerPosting:false,isOfficialPaystub:false,paymentExecuted:false,payoutReady:false,scope:'current_recorded_gross_and_submitted_manual_amounts_only'}}};
 }
 if(ctx.request.method==='POST'){empty.parse(q);if(!id)return propose(ctx,registry,'work.payrun.group',null,0,create.parse(await jsonBody(ctx.request,65536)));if(match[2]!=='cancel')throw new ApiError(405,'METHOD_NOT_ALLOWED');await row(ctx,id,true);return propose(ctx,registry,'work.payrun.cancel',null,0,{...cancel.parse(await jsonBody(ctx.request)),runId:id});}
 if(ctx.request.method!=='GET'||match[2]==='cancel')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);if(id){empty.parse(q);const r=await row(ctx,id);if(match[2]==='readiness'){await sourceAuthority(ctx,r.source_snapshot.items,false);return {status:200,body:{data:await payrunReadiness(ctx,r)}};}return {status:200,body:{data:output(r)}};}
 const i=paging.parse(q),s=[...scopes(ctx),ceiling(ctx)],rows=(await ctx.db.query<Run>(`SELECT ${columns} FROM public.payrun_groups x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) p WHERE public.scope_contains(p,x.scope) IS NOT TRUE) AND($2::uuid IS NULL OR x.person_id=$2) AND($3::uuid IS NULL OR x.currency_id=$3) AND($4::text IS NULL OR(x.cancellation_id IS NULL)=($4='gross_grouped')) AND($5::uuid IS NULL OR x.id>$5) AND($7::text IS NULL OR EXISTS(SELECT 1 FROM public.payrun_earning_claims c WHERE c.academy_id=x.academy_id AND c.run_id=x.id AND c.kind=$7 AND c.source_id=$8)) ORDER BY x.id LIMIT $6`,[JSON.stringify(s),i.personId??null,i.currencyId??null,i.status??null,i.after??null,i.limit+1,i.sourceKind??null,i.sourceId??null])).rows;
 return {status:200,body:{data:rows.slice(0,i.limit).map(output),nextCursor:rows.length>i.limit?rows[i.limit-1].id:null}};
}
export const payrunContract=[
 {path:'/api/v1/payroll/payruns/{id}/net-preview',method:'post',readOnly:true,summary:'Private read-only exact net-pay preview from a current gross run and explicit manual deductions/employer contributions. Rechecks whole-run/source permissions and live claims under worker lock;no retained approval,statutory calculation,authority-document verification,ledger posting,paystub or payment. Submitted review content is not retained.',schema:netPayDefinition},
 {path:'/api/v1/payroll/payruns/candidates',method:'get',summary:'Permitted unclaimed recorded gross earning allocations, before pagination; not payout readiness or complete-period certification',querySchema:candidates},
 {path:'/api/v1/payroll/payruns',method:'get',summary:'Worker-private retained gross payrun groups with full-bundle scopes and currency/status filters',querySchema:paging},
 {path:'/api/v1/payroll/payruns',method:'post',summary:'Upper-human-reviewed grouping of real salary/hourly/project/manual/course/session/collection gross allocations for one worker,currency and immutable declared legal context. Exact native source ownership and conserved amounts; no duplicate expense,net calculation,payment or paystub.',schema:create},
 {path:'/api/v1/payroll/payruns/{id}',method:'get',summary:'Read retained gross payrun without private HR terms,parent receipt facts or review notes'},
 {path:'/api/v1/payroll/payruns/{id}/readiness',method:'get',summary:'Current source-private class-input checklist for a permitted gross group. Rechecks durable earning claims,all priced hourly parent sources including shadowed classes,explicit session tuition,shared attendance/report/media-reference review and each worker\u0027s retained/current time. Authorized reversible report/media exceptions are respected;no attendance/time bypass. No wage erasure,teacher-agreement or safe-file certification,net pay,payment approval or retained payout clearance.'},
 {path:'/api/v1/payroll/payruns/{id}/cancel',method:'post',summary:'Upper-human-reviewed immutable cancellation releases only this run\u0027s gross allocation claims; no ledger inverse or payment/refund',schema:cancel}
] as const;

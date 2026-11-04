import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,master,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeNonempty,type Scope } from '../core/policy.ts';
import { parseMoney,readMinorUnits,formatMoney,taxAmounts } from '../core/money.ts';
import { accountingDate } from './finance-periods.ts';
import { enrollment } from './enrollments.ts';
import { currencyRow } from './finance.ts';
import { taxCodeRow } from './finance-taxes.ts';
import { paymentMethodSelection } from './payment-methods.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const money=z.string().min(1).max(80),reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'));
const installment=z.object({dueOn:accountingDate,amount:money,methodId:uuid,methodVersion:version}).strict();
const terms=z.object({enrollmentVersion:version,currencyId:uuid,currencyVersion:version,taxCodeId:uuid,taxCodeVersion:version,supplyOn:accountingDate,
 originalAmount:money,agreedAmount:money,pricing:z.enum(['tax_inclusive','tax_exclusive','not_applicable']),installments:z.array(installment).max(1000),reason}).strict();
const createPayload=terms.extend({enrollmentId:uuid}),replace=terms.extend({expectedVersion:version}),cancel=z.object({expectedVersion:version,reason}).strict();
const paging={limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()};
const query=z.object({...paging,hubId:uuid.optional(),classId:uuid.optional(),studentId:uuid.optional(),state:z.enum(['active','cancelled']).optional(),dueFrom:accountingDate.optional(),dueThrough:accountingDate.optional()}).strict()
 .refine(v=>!v.dueFrom||!v.dueThrough||v.dueFrom<=v.dueThrough);
const historyQuery=z.object({limit:paging.limit,afterVersion:z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict();
interface Plan {id:string;enrollment_id:string;student_id:string;class_id:string;hub_id:string;currency_id:string;unit_scale:number;version:number}
function allowed(ctx:ApiContext,edit=false){const s=permissionScope(ctx,edit?'tuition.edit':'tuition.view');if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
function authority(ctx:ApiContext,p:Pick<Plan,'student_id'|'class_id'|'hub_id'>,edit=false):Scope {
 const s=allowed(ctx,edit),hub=p.hub_id;
 if((!ctx.credential.all_hubs&&!ctx.credential.hub_ids.includes(hub))||s.excludedHubs?.includes(hub)||s.excludedClasses?.some(c=>c.id===p.class_id)||s.excludedPeople?.some(c=>c.id===p.student_id))throw new ApiError(404,'NOT_FOUND');
 const recordContext={hubId:hub,classId:p.class_id,studentId:p.student_id};
 if(s.all||s.hubs.includes(hub))return {all:false,hubs:[hub],recordContext};
 if(s.classes?.some(c=>c.id===p.class_id))return {all:false,hubs:[],classes:[{id:p.class_id,hubId:hub}],recordContext};
 if(s.people?.some(pick=>pick.id===p.student_id))return {all:false,hubs:[],people:[{id:p.student_id,hubId:hub}],recordContext};
 throw new ApiError(404,'NOT_FOUND');
}
async function plan(ctx:ApiContext,id:string,edit=false,lock=false):Promise<Plan>{
 allowed(ctx);const p=(await ctx.db.query<Plan>('SELECT * FROM public.tuition_plans WHERE id=$1',[id])).rows[0];if(!p)throw new ApiError(404,'NOT_FOUND');authority(ctx,p);if(edit)authority(ctx,p,true);
 if(lock){await ctx.db.query('SELECT id FROM public.tuition_plans WHERE id=$1 FOR UPDATE',[id]);return plan(ctx,id,edit);}return p;
}
async function basis(ctx:ApiContext,input:z.infer<typeof createPayload>,before:Plan|null){
 const {row:e,c}=await enrollment(ctx,input.enrollmentId);authority(ctx,e);authority(ctx,e,true);
 if(!e.enabled||!c.active||!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1 AND active',[e.hub_id])).rows.length)throw new ApiError(409,'ACTIVE_ENROLLMENT_REQUIRED');
 if(input.enrollmentVersion!==e.version)throw new ApiError(409,'ENROLLMENT_CHANGED');
 const currency=await currencyRow(ctx,input.currencyId),tax=await taxCodeRow(ctx,input.taxCodeId);
 if(currency.version!==input.currencyVersion||tax.version!==input.taxCodeVersion)throw new ApiError(409,'TUITION_SOURCE_CHANGED');
 if(!currency.active||!tax.active||input.supplyOn<tax.startsOn||(tax.endsOn&&input.supplyOn>tax.endsOn))throw new ApiError(409,'ACTIVE_EFFECTIVE_TAX_AND_CURRENCY_REQUIRED');
 if(tax.hubId!==null&&tax.hubId!==e.hub_id)throw new ApiError(409,'TUITION_TAX_HUB_MISMATCH');
 if(before&&(before.currency_id!==input.currencyId||before.unit_scale!==currency.unitScale))throw new ApiError(409,'TUITION_CURRENCY_UNIT_CHANGE_FORBIDDEN');
 if((tax.classification==='exempt'||tax.classification==='out_of_scope')!==(input.pricing==='not_applicable'))throw new ApiError(400,'TAX_PRICING_CLASSIFICATION_MISMATCH');
 const original=parseMoney(input.originalAmount,currency.unitScale),agreed=parseMoney(input.agreedAmount,currency.unitScale);if(original<0n||agreed<0n)throw new ApiError(400,'NONNEGATIVE_TUITION_REQUIRED');
 const amounts=taxAmounts(agreed,parseMoney(tax.ratePercent,4),input.pricing),methods=await paymentMethodSelection(ctx,[...new Set(input.installments.map(i=>i.methodId))]),byId=new Map(methods.map(m=>[m.id,m]));
 const installments=input.installments.map((i,index)=>{
  const method=byId.get(i.methodId);if(!method)throw new ApiError(404,'PAYMENT_METHOD_NOT_FOUND');
  if(method.version!==i.methodVersion||!method.active)throw new ApiError(409,'PAYMENT_METHOD_CHANGED');if(method.hubId!==null&&method.hubId!==e.hub_id)throw new ApiError(409,'TUITION_METHOD_HUB_MISMATCH');
  const amount=parseMoney(i.amount,currency.unitScale);if(amount<=0n)throw new ApiError(400,'POSITIVE_INSTALLMENT_REQUIRED');
  return {ordinal:index+1,dueOn:i.dueOn,amountMinor:amount.toString(),methodId:method.id,methodVersion:method.version};
 });
 if(installments.reduce((sum,i)=>sum+BigInt(i.amountMinor),0n)!==amounts.gross||(amounts.gross===0n&&installments.length))throw new ApiError(400,'TUITION_SCHEDULE_MISMATCH');
 return {enrollmentId:e.id,enrollmentVersion:e.version,studentId:e.student_id,classId:e.class_id,hubId:e.hub_id,currencyId:currency.id,currencyVersion:currency.version,unitScale:currency.unitScale,
  taxCodeId:tax.id,taxCodeVersion:tax.version,supplyOn:input.supplyOn,originalMinor:original.toString(),agreedMinor:agreed.toString(),netMinor:amounts.net.toString(),taxMinor:amounts.tax.toString(),grossMinor:amounts.gross.toString(),pricing:input.pricing,installments,
  sourceSnapshot:{classCode:c.code,className:c.name,classVersion:c.version,courseId:c.course_id,courseVersion:c.course_version,studentProfileVersion:e.student_profile_version},
  methodSources:methods.map(m=>({id:m.id,version:m.version,hubId:m.hubId,name:m.name,category:m.category})).sort((a,b)=>a.id.localeCompare(b.id))};
}
async function validate(ctx:ApiContext,action:string,id:string,raw:unknown){
 await lockAcademyTopology(ctx);const creating=action==='finance.tuition.create',before=creating?null:await plan(ctx,id,true,true);
 if(!creating){const input=(action==='finance.tuition.cancel'?cancel:replace).parse(raw);if(input.expectedVersion!==before!.version)throw new ApiError(409,'TARGET_CHANGED');}
 if(action==='finance.tuition.cancel')return authority(ctx,before!,true);
 const input=creating?createPayload.parse(raw):{...replace.parse(raw),enrollmentId:before!.enrollment_id};
 const b=await basis(ctx,input,before);return authority(ctx,{student_id:b.studentId,class_id:b.classId,hub_id:b.hubId},true);
}
async function dependencies(ctx:ApiContext,action:string,id:string,raw:unknown,purpose:'request'|'review'){
 try {
 const before=action==='finance.tuition.create'?null:await plan(ctx,id,true);
 if(action==='finance.tuition.cancel')return {before};
 const input=action==='finance.tuition.create'?createPayload.parse(raw):{...replace.parse(raw),enrollmentId:before!.enrollment_id};
 return {before,basis:await basis(ctx,input,before),existing:(await ctx.db.query('SELECT id,version FROM public.tuition_plans WHERE enrollment_id=$1',[input.enrollmentId])).rows[0]??null};
 }catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}
}
const publicColumns=`r.version,r.enrollment_version AS "enrollmentVersion",r.currency_version AS "currencyVersion",c.code AS "currencyCode",r.tax_code_id AS "taxCodeId",r.tax_code_version AS "taxCodeVersion",t.classification,t.rate_millionths AS "rateMillionths",r.supply_on::text AS "supplyOn",r.pricing,r.state,r.original_minor::text AS "originalMinor",r.agreed_minor::text AS "agreedMinor",r.net_minor::text AS "netMinor",r.tax_minor::text AS "taxMinor",r.gross_minor::text AS "grossMinor",r.source_snapshot AS "sourceSnapshot",r.created_at AS "createdAt"`;
function formatted(r:Record<string,unknown>,scale:number){
 const result={...r};for(const [key,label] of [['originalMinor','originalAmount'],['agreedMinor','agreedAmount'],['netMinor','net'],['taxMinor','tax'],['grossMinor','plannedGross']] as const)result[label]=formatMoney(readMinorUnits(String(r[key])),scale);
 return {...result,planningOnly:true,posted:false,paymentStatus:'not_tracked_here'};
}
async function detail(ctx:ApiContext,p:Plan,selectedVersion=p.version){
 const r=(await ctx.db.query<Record<string,unknown>>('SELECT '+publicColumns+' FROM public.tuition_plan_revisions r JOIN public.finance_currencies c ON c.academy_id=r.academy_id AND c.id=r.currency_id JOIN public.finance_tax_code_revisions t ON t.academy_id=r.academy_id AND t.tax_code_id=r.tax_code_id AND t.version=r.tax_code_version WHERE r.plan_id=$1 AND r.version=$2',[p.id,selectedVersion])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');
 const items=(await ctx.db.query<Record<string,unknown>>(`SELECT i.ordinal,i.due_on::text AS "dueOn",i.amount_minor::text AS "amountMinor",i.method_id AS "methodId",i.method_version AS "methodVersion",m.code AS "methodCode",m.category AS "methodCategory",v.name AS "methodName" FROM public.tuition_installments i JOIN public.finance_payment_methods m ON m.academy_id=i.academy_id AND m.id=i.method_id JOIN public.finance_payment_method_revisions v ON v.academy_id=i.academy_id AND v.method_id=i.method_id AND v.version=i.method_version WHERE i.plan_id=$1 AND i.version=$2 ORDER BY i.ordinal`,[p.id,selectedVersion])).rows;
 return {...formatted(r,p.unit_scale),id:p.id,enrollmentId:p.enrollment_id,studentId:p.student_id,classId:p.class_id,hubId:p.hub_id,currencyId:p.currency_id,unitScale:p.unit_scale,
  installments:items.map(i=>({...i,amount:formatMoney(readMinorUnits(String(i.amountMinor)),p.unit_scale)}))};
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 const creating=p.action==='finance.tuition.create',cancelling=p.action==='finance.tuition.cancel',before=creating?null:await plan(ctx,p.target_id,true,true),input=cancelling?cancel.parse(p.payload):creating?createPayload.parse(p.payload):replace.parse(p.payload);
 if(before&&(!('expectedVersion' in input)||before.version!==input.expectedVersion||before.version!==p.target_version))throw new ApiError(409,'TARGET_CHANGED');
 const next=before?before.version+1:1;
 try {
  if(cancelling){
   const current=(await ctx.db.query<{state:string}>('SELECT state FROM public.tuition_plan_revisions WHERE plan_id=$1 AND version=$2',[p.target_id,before!.version])).rows[0];if(current.state==='cancelled')throw new ApiError(409,'TUITION_ALREADY_CANCELLED');
   await ctx.db.query('UPDATE public.tuition_plans SET version=$2 WHERE id=$1',[p.target_id,next]);
   await ctx.db.query(`INSERT INTO public.tuition_plan_revisions(academy_id,plan_id,version,enrollment_id,enrollment_version,currency_id,currency_version,tax_code_id,tax_code_version,supply_on,original_minor,agreed_minor,net_minor,tax_minor,gross_minor,pricing,state,source_snapshot,changed_by,approval_id,reason)
    SELECT academy_id,plan_id,$3,enrollment_id,enrollment_version,currency_id,currency_version,tax_code_id,tax_code_version,supply_on,original_minor,agreed_minor,net_minor,tax_minor,gross_minor,pricing,'cancelled',source_snapshot,$4,$5,$6 FROM public.tuition_plan_revisions WHERE plan_id=$1 AND version=$2`,[p.target_id,before!.version,next,ctx.credential.person_id,p.id,input.reason]);
   await ctx.db.query('INSERT INTO public.tuition_installments(academy_id,plan_id,version,ordinal,due_on,amount_minor,method_id,method_version) SELECT academy_id,plan_id,$3,ordinal,due_on,amount_minor,method_id,method_version FROM public.tuition_installments WHERE plan_id=$1 AND version=$2',[p.target_id,before!.version,next]);
  }else{
   const requested=creating?createPayload.parse(input):{...replace.parse(input),enrollmentId:before!.enrollment_id},b=await basis(ctx,requested,before);
   const expected=(p.review_context as {basis?:unknown}).basis;if(!isDeepStrictEqual(JSON.parse(JSON.stringify(b)),expected))throw new ApiError(409,'TUITION_SOURCE_CHANGED');
   if(before)await ctx.db.query('UPDATE public.tuition_plans SET version=$2 WHERE id=$1',[p.target_id,next]);
   else await ctx.db.query('INSERT INTO public.tuition_plans(academy_id,id,enrollment_id,student_id,class_id,hub_id,currency_id,unit_scale,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ctx.credential.academy_id,p.target_id,b.enrollmentId,b.studentId,b.classId,b.hubId,b.currencyId,b.unitScale,ctx.credential.person_id]);
   await ctx.db.query(`INSERT INTO public.tuition_plan_revisions(academy_id,plan_id,version,enrollment_id,enrollment_version,currency_id,currency_version,tax_code_id,tax_code_version,supply_on,original_minor,agreed_minor,net_minor,tax_minor,gross_minor,pricing,state,source_snapshot,changed_by,approval_id,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active',$17::jsonb,$18,$19,$20)`,[ctx.credential.academy_id,p.target_id,next,b.enrollmentId,b.enrollmentVersion,b.currencyId,b.currencyVersion,b.taxCodeId,b.taxCodeVersion,b.supplyOn,b.originalMinor,b.agreedMinor,b.netMinor,b.taxMinor,b.grossMinor,b.pricing,JSON.stringify(b.sourceSnapshot),ctx.credential.person_id,p.id,input.reason]);
   if(b.installments.length)await ctx.db.query(`INSERT INTO public.tuition_installments(academy_id,plan_id,version,ordinal,due_on,amount_minor,method_id,method_version)
    SELECT $1,$2,$3,i.ordinal,i."dueOn"::date,i."amountMinor"::numeric,i."methodId"::uuid,i."methodVersion" FROM jsonb_to_recordset($4::jsonb) AS i(ordinal integer,"dueOn" text,"amountMinor" text,"methodId" text,"methodVersion" integer)`,[ctx.credential.academy_id,p.target_id,next,JSON.stringify(b.installments)]);
  }
 }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new ApiError(409,'TUITION_PLAN_EXISTS');throw error;}
 const after=await plan(ctx,p.target_id);await record(ctx.db,ctx.credential,ctx.requestId,cancelling?'finance.tuition.cancelled':creating?'finance.tuition.created':'finance.tuition.replaced',p.target_id,after.hub_id,{beforeVersion:before?.version??null,afterVersion:next,approvalId:p.id,severity:'critical',hasReason:true});return detail(ctx,after);
}
async function authorizeReviewer(ctx:ApiContext,p:Proposal){
 if(await master(ctx))return;const studentId=p.action==='finance.tuition.create'?(await enrollment(ctx,createPayload.parse(p.payload).enrollmentId)).row.student_id:(await plan(ctx,p.target_id)).student_id;
 if(ctx.credential.person_id===studentId||(await ctx.db.query('SELECT 1 FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2 LIMIT 1',[studentId,ctx.credential.person_id])).rows.length)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');
}
export const tuitionActions:ApprovalRegistry=Object.fromEntries(['finance.tuition.create','finance.tuition.replace','finance.tuition.cancel'].map(action=>[action,{
 requestCapability:'tuition.edit',privacyCapability:'tuition.edit',policyChange:true,...action==='finance.tuition.create'?{createdStatus:201 as const}:{},
 validate:(c:ApiContext,id:string,i:unknown)=>validate(c,action,id,i),dependencies:(c:ApiContext,id:string,i:unknown,purpose:'request'|'review')=>dependencies(c,action,id,i,purpose),authorizeReviewer,apply
}]));
export async function tuition(ctx:ApiContext,registry:ApprovalRegistry=tuitionActions):Promise<Reply|null>{
 const creation=/^enrollments\/([^/]+)\/tuition-plan$/.exec(ctx.path),item=/^finance\/tuition-plans(?:\/([^/]+)(?:\/(change|cancel|history))?)?$/.exec(ctx.path);if(!creation&&!item)return null;
 if(creation){
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const input={...terms.parse(await jsonBody(ctx.request,262144)),enrollmentId:uuid.parse(creation[1])},{row:e}=await enrollment(ctx,input.enrollmentId);authority(ctx,e);authority(ctx,e,true);return propose(ctx,registry,'finance.tuition.create',null,0,input);
 }
 const id=item![1]?uuid.parse(item![1]):null,section=item![2];
 if(ctx.request.method==='POST'){
  if(!id||!['change','cancel'].includes(section??''))throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const input=(section==='cancel'?cancel:replace).parse(await jsonBody(ctx.request,262144));await plan(ctx,id,true);return propose(ctx,registry,section==='cancel'?'finance.tuition.cancel':'finance.tuition.replace',id,input.expectedVersion,input);
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(id){const p=await plan(ctx,id,section==='history');
  if(section==='history'){const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{version:number}>('SELECT version,state,reason,changed_by AS "changedBy",approval_id AS "approvalId",created_at AS "createdAt" FROM public.tuition_plan_revisions WHERE plan_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
  if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=z.object({version:z.coerce.number().int().positive().max(2147483647).optional()}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));if(q.version!==undefined)authority(ctx,p,true);return {status:200,body:{data:await detail(ctx,p,q.version)}};
 }
 const q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),s=allowed(ctx),rows=(await ctx.db.query<Plan&{state:string;gross_minor:string;currency_code:string}>(`SELECT p.id,p.enrollment_id,p.student_id,p.class_id,p.hub_id,p.currency_id,p.unit_scale,p.version,r.state,r.gross_minor::text,c.code AS currency_code FROM public.tuition_plans p JOIN public.tuition_plan_revisions r ON r.academy_id=p.academy_id AND r.plan_id=p.id AND r.version=p.version JOIN public.finance_currencies c ON c.academy_id=p.academy_id AND c.id=p.currency_id
  WHERE ($1::boolean OR p.hub_id=ANY($2::uuid[]) OR p.class_id=ANY($3::uuid[]) OR p.student_id=ANY($4::uuid[])) AND NOT p.hub_id=ANY($5::uuid[]) AND NOT p.class_id=ANY($6::uuid[]) AND NOT p.student_id=ANY($7::uuid[]) AND ($8::boolean OR p.hub_id=ANY($9::uuid[]))
  AND ($10::uuid IS NULL OR p.id>$10) AND ($11::uuid IS NULL OR p.hub_id=$11) AND ($12::uuid IS NULL OR p.class_id=$12) AND ($13::uuid IS NULL OR p.student_id=$13) AND ($14::text IS NULL OR r.state=$14)
  AND (($15::date IS NULL AND $16::date IS NULL) OR EXISTS(SELECT 1 FROM public.tuition_installments i WHERE i.academy_id=p.academy_id AND i.plan_id=p.id AND i.version=p.version AND ($15::date IS NULL OR i.due_on>=$15) AND ($16::date IS NULL OR i.due_on<=$16))) ORDER BY p.id LIMIT $17`,
  [s.all,s.hubs,(s.classes??[]).map(c=>c.id),(s.people??[]).map(p=>p.id),s.excludedHubs??[],(s.excludedClasses??[]).map(c=>c.id),(s.excludedPeople??[]).map(p=>p.id),ctx.credential.all_hubs,ctx.credential.hub_ids,q.after??null,q.hubId??null,q.classId??null,q.studentId??null,q.state??null,q.dueFrom??null,q.dueThrough??null,q.limit+1])).rows;
 return {status:200,body:{data:rows.slice(0,q.limit).map(p=>({...p,plannedGross:formatMoney(readMinorUnits(p.gross_minor),p.unit_scale),planningOnly:true,posted:false,paymentStatus:'not_tracked_here'})),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const tuitionContract=[
 {path:'/api/v1/enrollments/{id}/tuition-plan',method:'post',summary:'Request an exact reviewed tuition/installment plan before signing or admission; not an invoice, receipt or journal posting',schema:terms},
 {path:'/api/v1/finance/tuition-plans',method:'get',summary:'Scope-filtered tuition plans and expected gross amounts; no actual payment or receivable balance implied',querySchema:query},
 {path:'/api/v1/finance/tuition-plans/{id}',method:'get',summary:'Read own permitted current terms/installments; explicit historical versions require current tuition editing',querySchema:z.object({version:version.optional()}).strict()},
 {path:'/api/v1/finance/tuition-plans/{id}/change',method:'post',summary:'Upper-reviewed complete replacement terms; preserve prior versions and currency units, without changing received money',schema:replace},
 {path:'/api/v1/finance/tuition-plans/{id}/cancel',method:'post',summary:'Cancel future planning without erasing old terms, issuing a refund or reversing a journal',schema:cancel},
 {path:'/api/v1/finance/tuition-plans/{id}/history',method:'get',summary:'Editor-only tuition revision/approval reasons; retrieve full pinned historical terms with version query',querySchema:historyQuery}
] as const;

import { Temporal } from '@js-temporal/polyfill';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,permissionScope,master,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { formatMoney,readMinorUnits } from '../core/money.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { tuitionPlan,tuitionDetail,financialRecordAuthority } from './tuition.ts';
import { accountRow } from './finance.ts';
import { prepareJournal,journalDependencies,applyJournal } from './finance-journals.ts';
import { permittedPerson } from './students.ts';
import { agreementRequiresGuardian } from './agreement-packages.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),name=text.trim().min(1).max(200),reason=text.trim().min(1).max(2000);
const registration=z.object({scheme:text.trim().min(1).max(50),id:text.trim().min(1).max(100)}).strict().refine(v=>v.scheme!=='GST_HST'||/^[0-9]{9}RT[0-9]{4}$/.test(v.id));
const issuerDefinition=z.object({legalName:name,address:text.trim().min(1).max(1000),countryCode:z.string().regex(/^[A-Z]{2}$/),contactEmail:z.email().max(254).nullable().default(null),taxRegistrations:z.array(registration).max(8).default([])}).strict()
 .refine(v=>new Set(v.taxRegistrations.map(r=>r.scheme)).size===v.taxRegistrations.length);
const issuerCreate=z.object({hubId:uuid.nullable().default(null),prefix:z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/),padding:z.number().int().min(1).max(12).default(8),definition:issuerDefinition,active:z.boolean().default(true),reason}).strict();
const issuerReplace=z.object({expectedVersion:version,definition:issuerDefinition,active:z.boolean(),reason}).strict();
const ref=z.object({id:uuid,version}).strict(),issuedAt=z.iso.datetime({offset:true}).max(100);
const issue=z.object({planVersion:version,issuerId:uuid,issuerVersion:version,billToId:uuid,issuedAt,periodId:uuid,periodVersion:version,
 description:reason,recognition:z.enum(['earned','deferred']),accounts:z.object({receivable:ref,consideration:ref,tax:ref.nullable().default(null)}).strict(),taxTimingReview:reason,reason}).strict();
const issuePayload=issue.extend({planId:uuid});
const credit=z.object({issuedAt,periodId:uuid,periodVersion:version,description:reason,taxTimingReview:reason,reason}).strict(),creditPayload=credit.extend({invoiceId:uuid});
const paging={limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()};
const listQuery=z.object({...paging,hubId:uuid.optional(),studentId:uuid.optional(),classId:uuid.optional(),status:z.enum(['issued','credited']).optional()}).strict();
const issuerQuery=z.object({...paging,active:z.enum(['true','false']).transform(v=>v==='true').optional()}).strict();
const issuerHistoryQuery=z.object({limit:paging.limit,afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
type Issuer={id:string;hub_id:string|null;prefix:string;padding:number;next_number:string;version:number;definition:z.infer<typeof issuerDefinition>;active:boolean};
type Invoice={id:string;plan_id:string;plan_version:number;student_id:string;class_id:string;hub_id:string;bill_to_id:string;bill_to_name:string;journal_id:string|null;credit_id:string|null;issuer_id:string;issuer_version:number;issued_at:Date|string;issued_on:string;number:string};
function allowed(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
async function issuer(ctx:ApiContext,id:string,edit=false):Promise<Issuer>{
 const s=allowed(ctx,'invoice-issuers.view'),r=(await ctx.db.query<Issuer>('SELECT i.*,r.definition,r.active FROM public.invoice_issuers i JOIN public.invoice_issuer_revisions r ON r.academy_id=i.academy_id AND r.issuer_id=i.id AND r.version=i.version WHERE i.id=$1',[id])).rows[0];
 if(!r||(r.hub_id!==null&&(!s.all&&!s.hubs.includes(r.hub_id)||s.excludedHubs?.includes(r.hub_id))))throw new ApiError(404,'NOT_FOUND');
 if(edit)requireScope(allowed(ctx,'invoice-issuers.edit'),r.hub_id??undefined);return r;
}
function issuerDestination(ctx:ApiContext,hubId:string|null){requireScope(allowed(ctx,'invoice-issuers.view'),hubId??undefined);requireScope(allowed(ctx,'invoice-issuers.edit'),hubId??undefined);return hubId?{all:false,hubs:[hubId]}:{all:true,hubs:[]};}
async function validateIssuer(ctx:ApiContext,creating:boolean,id:string,raw:unknown){
 const input=creating?issuerCreate.parse(raw):issuerReplace.parse(raw),before=creating?null:await issuer(ctx,id,true),hubId=before?before.hub_id:('hubId' in input?input.hubId:null);
 const s=issuerDestination(ctx,hubId);await lockAcademyTopology(ctx);if(hubId&&!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1 AND active',[hubId])).rows.length)throw new ApiError(409,'ACTIVE_HUB_REQUIRED');return s;
}
async function issuerDependencies(ctx:ApiContext,creating:boolean,id:string,raw:unknown,purpose:'request'|'review'){
 const input=creating?issuerCreate.parse(raw):issuerReplace.parse(raw),before=creating?null:await issuer(ctx,id,true);
 if(before&&purpose==='request'&&'expectedVersion' in input&&input.expectedVersion!==before.version)throw new ApiError(409,'TARGET_CHANGED');
 return {before:before?{id:before.id,version:before.version,hubId:before.hub_id}:null,prefixOwner:creating&&'prefix' in input?(await ctx.db.query('SELECT id FROM public.invoice_issuers WHERE prefix=$1',[input.prefix])).rows[0]??null:null};
}
async function applyIssuer(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const creating=p.action==='finance.invoice-issuer.create',input=creating?issuerCreate.parse(p.payload):issuerReplace.parse(p.payload),before=creating?null:await issuer(ctx,p.target_id,true),next=before?before.version+1:1;
 if(before&&(!('expectedVersion' in input)||input.expectedVersion!==before.version||p.target_version!==before.version))throw new ApiError(409,'TARGET_CHANGED');
 try{if(before)await ctx.db.query('UPDATE public.invoice_issuers SET version=$2 WHERE id=$1',[p.target_id,next]);else if('prefix' in input)await ctx.db.query('INSERT INTO public.invoice_issuers(academy_id,id,hub_id,prefix,padding,created_by) VALUES($1,$2,$3,$4,$5,$6)',[ctx.credential.academy_id,p.target_id,input.hubId,input.prefix,input.padding,ctx.credential.person_id]);
  await ctx.db.query('INSERT INTO public.invoice_issuer_revisions(academy_id,issuer_id,version,definition,active,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',[ctx.credential.academy_id,p.target_id,next,JSON.stringify(input.definition),input.active,ctx.credential.person_id,p.id,input.reason]);
 }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new ApiError(409,'INVOICE_PREFIX_EXISTS');throw error;}
 const result=await issuer(ctx,p.target_id);await record(ctx.db,ctx.credential,ctx.requestId,creating?'finance.invoice-issuer.created':'finance.invoice-issuer.replaced',p.target_id,result.hub_id,{beforeVersion:before?.version??null,afterVersion:next,severity:'critical',hasReason:true});return result;
}
async function invoice(ctx:ApiContext,id:string,edit=false):Promise<Invoice>{
 allowed(ctx,'invoices.view');const r=(await ctx.db.query<Invoice>('SELECT i.*,d.issuer_id,d.issuer_version,d.issued_at,d.issued_on::text,d.number FROM public.tuition_invoices i JOIN public.billing_documents d ON d.academy_id=i.academy_id AND d.id=i.id WHERE i.id=$1',[id])).rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');financialRecordAuthority(ctx,r,'invoices.view');if(edit)financialRecordAuthority(ctx,r,'invoices.edit');return r;
}
async function recipient(ctx:ApiContext,p:Awaited<ReturnType<typeof tuitionPlan>>,billToId:string,at:string,on:string,lock=false){
 await permittedPerson(ctx,p.student_id,'students.view',lock);const student=(await ctx.db.query<{version:number;legal_name:string;date_of_birth:string}>('SELECT version,legal_name,date_of_birth::text FROM public.student_profiles WHERE person_id=$1'+(lock?' FOR SHARE':''),[p.student_id])).rows[0];if(!student)throw new ApiError(404,'NOT_FOUND');
 if(!agreementRequiresGuardian(student.date_of_birth,on)){if(billToId!==p.student_id)throw new ApiError(409,'ADULT_STUDENT_RECIPIENT_REQUIRED');return {kind:'student',name:student.legal_name,profileVersion:student.version,relationshipId:null,relationshipVersion:null};}
 await permittedPerson(ctx,p.student_id,'families.view',lock);await permittedPerson(ctx,billToId,'guardians.view',lock);
 const guardian=(await ctx.db.query<{legal_name:string;version:number}>('SELECT legal_name,version FROM public.guardian_profiles WHERE person_id=$1'+(lock?' FOR SHARE':''),[billToId])).rows[0],relationship=(await ctx.db.query<{id:string;version:number}>("SELECT id,version FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2 AND state='approved' AND relationship IN ('parent','legal_guardian') AND valid_from<=$3::timestamptz AND (valid_until IS NULL OR valid_until>$3::timestamptz)"+(lock?' FOR SHARE':''),[p.student_id,billToId,at])).rows[0];
 if(!guardian||!relationship)throw new ApiError(409,'LEGAL_GUARDIAN_REQUIRED');return {kind:'guardian',name:guardian.legal_name,profileVersion:guardian.version,relationshipId:relationship.id,relationshipVersion:relationship.version};
}
async function issueBasis(ctx:ApiContext,input:z.infer<typeof issuePayload>,lock=false){
 const p=await tuitionPlan(ctx,input.planId);const auth=financialRecordAuthority(ctx,p,'invoices.edit');financialRecordAuthority(ctx,p,'invoices.view');
 if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.tuition_plans WHERE id=$1 FOR UPDATE',[p.id]);}
 if(p.version!==input.planVersion)throw new ApiError(409,'TUITION_PLAN_CHANGED');const terms=await tuitionDetail(ctx,p);if(terms.state!=='active')throw new ApiError(409,'ACTIVE_TUITION_PLAN_REQUIRED');
 const currentIssuer=await issuer(ctx,input.issuerId);if(!currentIssuer.active||currentIssuer.version!==input.issuerVersion)throw new ApiError(409,'INVOICE_ISSUER_CHANGED');if(currentIssuer.hub_id!==null&&currentIssuer.hub_id!==p.hub_id)throw new ApiError(409,'INVOICE_ISSUER_HUB_MISMATCH');
 const c=(await ctx.db.query<{time_zone:string}>('SELECT time_zone FROM public.classes WHERE id=$1',[p.class_id])).rows[0],on=Temporal.Instant.from(input.issuedAt).toZonedDateTimeISO(c.time_zone).toPlainDate().toString();
 const billTo=await recipient(ctx,p,input.billToId,input.issuedAt,on,lock),gross=readMinorUnits(String(terms.grossMinor)),net=readMinorUnits(String(terms.netMinor)),tax=readMinorUnits(String(terms.taxMinor));
 if(tax>0n&&terms.classification==='taxable'&&(await ctx.db.query<{country_code:string}>('SELECT country_code FROM public.finance_tax_code_revisions WHERE tax_code_id=$1 AND version=$2',[terms.taxCodeId,terms.taxCodeVersion])).rows[0].country_code==='CA'
  &&!currentIssuer.definition.taxRegistrations.some(r=>r.scheme==='GST_HST'))throw new ApiError(409,'CANADIAN_TAX_REGISTRATION_REQUIRED');
 const mappings=[input.accounts.receivable,input.accounts.consideration,...input.accounts.tax?[input.accounts.tax]:[]],accounts=[];
 if(new Set(mappings.map(m=>m.id)).size!==mappings.length)throw new ApiError(400,'DISTINCT_INVOICE_ACCOUNTS_REQUIRED');
 for(const ref of mappings){const a=await accountRow(ctx,ref.id);if(a.version!==ref.version||!a.active)throw new ApiError(409,'ACCOUNT_CHANGED');if(a.currencyId!==p.currency_id||a.unitScale!==p.unit_scale||(a.hubId!==null&&a.hubId!==p.hub_id))throw new ApiError(400,'INVOICE_ACCOUNT_UNIT_OR_HUB_MISMATCH');accounts.push(a);}
 if(accounts[0].operationalRole!=='receivable'||accounts[1].operationalRole!==(input.recognition==='earned'?'revenue':'deferred_revenue')||(input.accounts.tax&&accounts[2].operationalRole!=='tax_payable')||(tax>0n&&!input.accounts.tax))throw new ApiError(400,'INVOICE_ACCOUNT_MAPPING_INVALID');
 const lines=[{accountId:input.accounts.receivable.id,accountVersion:input.accounts.receivable.version,side:'debit' as const,amount:formatMoney(gross,p.unit_scale)},
  ...net>0n?[{accountId:input.accounts.consideration.id,accountVersion:input.accounts.consideration.version,side:'credit' as const,amount:formatMoney(net,p.unit_scale)}]:[],
  ...tax>0n?[{accountId:input.accounts.tax!.id,accountVersion:input.accounts.tax!.version,side:'credit' as const,amount:formatMoney(tax,p.unit_scale)}]:[]];
 const journal={periodId:input.periodId,periodVersion:input.periodVersion,postedOn:on,description:'Tuition invoice posting',reference:'',purpose:'activity' as const,reason:input.reason,lines};
 requireScope(permissionScope(ctx,'periods.view'));
 const period=(await ctx.db.query<{version:number;state:string;starts_on:string;ends_on:string}>('SELECT version,state,starts_on::text,ends_on::text FROM public.finance_periods WHERE id=$1',[input.periodId])).rows[0];
 if(!period||period.version!==input.periodVersion||period.state!=='open'||on<period.starts_on||on>period.ends_on)throw new ApiError(409,'OPEN_INVOICE_PERIOD_REQUIRED');
 const prepared=gross>0n?await prepareJournal(ctx,false,journal,lock):null;
 return {auth,plan:p,terms,issuer:{id:currentIssuer.id,version:currentIssuer.version,hubId:currentIssuer.hub_id,definition:currentIssuer.definition},billTo,on,journal,posting:prepared?await journalDependencies(ctx,false,journal,'review'):null,
  existing:(await ctx.db.query('SELECT id FROM public.tuition_invoices WHERE plan_id=$1 AND credit_id IS NULL',[p.id])).rows[0]??null};
}
async function creditBasis(ctx:ApiContext,input:z.infer<typeof creditPayload>,lock=false){
 const i=await invoice(ctx,input.invoiceId,true);if(lock){await lockFinanceBook(ctx);await lockAcademyTopology(ctx);await ctx.db.query('SELECT id FROM public.tuition_invoices WHERE id=$1 FOR UPDATE',[i.id]);}
 if(i.credit_id)throw new ApiError(409,'INVOICE_ALREADY_CREDITED');const p=await tuitionPlan(ctx,i.plan_id),c=(await ctx.db.query<{time_zone:string}>('SELECT time_zone FROM public.classes WHERE id=$1',[i.class_id])).rows[0];
 const on=Temporal.Instant.from(input.issuedAt).toZonedDateTimeISO(c.time_zone).toPlainDate().toString();if(Temporal.Instant.compare(input.issuedAt,i.issued_at instanceof Date?i.issued_at.toISOString():i.issued_at)<0)throw new ApiError(400,'CREDIT_PRECEDES_INVOICE');
 requireScope(permissionScope(ctx,'periods.view'));
 const period=(await ctx.db.query<{version:number;state:string;starts_on:string;ends_on:string}>('SELECT version,state,starts_on::text,ends_on::text FROM public.finance_periods WHERE id=$1',[input.periodId])).rows[0];
 if(!period||period.version!==input.periodVersion||period.state!=='open'||on<period.starts_on||on>period.ends_on)throw new ApiError(409,'OPEN_INVOICE_PERIOD_REQUIRED');
 const journal={periodId:input.periodId,periodVersion:input.periodVersion,postedOn:on,description:'Full tuition invoice credit',reference:i.number,reason:input.reason,reversesId:i.journal_id};
 if(i.journal_id)await prepareJournal(ctx,true,journal,lock);
 return {invoice:i,plan:p,on,journal,posting:i.journal_id?await journalDependencies(ctx,true,journal,'review'):null};
}
async function document(ctx:ApiContext,p:Proposal,issuerId:string,issuerVersion:number,kind:'invoice'|'credit_note',at:string,on:string){
 const n=(await ctx.db.query<{sequence:string;prefix:string;padding:number}>('UPDATE public.invoice_issuers SET next_number=next_number+1 WHERE id=$1 AND next_number<999999999999 RETURNING (next_number-1)::text AS sequence,prefix,padding',[issuerId])).rows[0];if(!n)throw new ApiError(409,'INVOICE_NUMBER_CAPACITY_REACHED');
 const number=n.prefix+'-'+n.sequence.padStart(n.padding,'0');await ctx.db.query('INSERT INTO public.billing_documents(academy_id,id,issuer_id,issuer_version,sequence,number,kind,issued_at,issued_on,created_by,approval_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[ctx.credential.academy_id,p.target_id,issuerId,issuerVersion,n.sequence,number,kind,at,on,ctx.credential.person_id,p.id]);return number;
}
async function detail(ctx:ApiContext,i:Invoice){
 // Invoice authorization already covers this exact immutable student/class/hub
 // tuple. Reading its pinned terms must not require broader tuition access.
 const p=(await ctx.db.query<Awaited<ReturnType<typeof tuitionPlan>>>('SELECT * FROM public.tuition_plans WHERE id=$1',[i.plan_id])).rows[0];
 const terms=await tuitionDetail(ctx,p,i.plan_version),d=(await ctx.db.query<{definition:unknown;description:string;recognition:string}>('SELECT r.definition,i.description,i.recognition FROM public.tuition_invoices i JOIN public.billing_documents d ON d.academy_id=i.academy_id AND d.id=i.id JOIN public.invoice_issuer_revisions r ON r.academy_id=d.academy_id AND r.issuer_id=d.issuer_id AND r.version=d.issuer_version WHERE i.id=$1',[i.id])).rows[0];
 const credit=i.credit_id?(await ctx.db.query('SELECT d.id,d.number,d.issued_at AS "issuedAt",d.issued_on::text AS "issuedOn",c.description FROM public.tuition_invoice_credits c JOIN public.billing_documents d ON d.academy_id=c.academy_id AND d.id=c.id WHERE c.id=$1',[i.credit_id])).rows[0]:null;
 return {id:i.id,number:i.number,issuedAt:i.issued_at,issuedOn:i.issued_on,planId:i.plan_id,planVersion:i.plan_version,studentId:i.student_id,classId:i.class_id,hubId:i.hub_id,billToId:i.bill_to_id,billToName:i.bill_to_name,
  issuer:d.definition,description:d.description,recognition:d.recognition,status:i.credit_id?'credited':'issued',currencyId:terms.currencyId,currencyCode:terms.currencyCode,unitScale:terms.unitScale,classification:terms.classification,rateMillionths:terms.rateMillionths,net:terms.net,tax:terms.tax,gross:terms.plannedGross,installments:terms.installments,sourceSnapshot:terms.sourceSnapshot,
  accountingPosted:i.journal_id!==null,paymentStatus:'not_tracked_here',refundPerformed:false,creditNote:credit};
}
async function validateInvoice(ctx:ApiContext,crediting:boolean,raw:unknown){return crediting?financialRecordAuthority(ctx,(await creditBasis(ctx,creditPayload.parse(raw),true)).invoice,'invoices.edit'):(await issueBasis(ctx,issuePayload.parse(raw),true)).auth;}
async function invoiceDependencies(ctx:ApiContext,crediting:boolean,raw:unknown,purpose:'request'|'review'){
 try{const b=crediting?await creditBasis(ctx,creditPayload.parse(raw)):await issueBasis(ctx,issuePayload.parse(raw));if(!crediting&&purpose==='request'&&'existing' in b&&b.existing)throw new ApiError(409,'TUITION_ALREADY_INVOICED');return JSON.parse(JSON.stringify(b));}
 catch(error){if(purpose==='review'&&error instanceof ApiError&&[400,403,404,409].includes(error.status))return {unavailable:error.code};throw error;}
}
async function applyInvoice(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 const crediting=p.action==='finance.invoice.credit',input=crediting?creditPayload.parse(p.payload):issuePayload.parse(p.payload);
 const actual=await invoiceDependencies(ctx,crediting,p.payload,'request');if(!isDeepStrictEqual(actual,p.review_context))throw new ApiError(409,'INVOICE_SOURCE_CHANGED');
 let result:Invoice;
 if(crediting&&'invoiceId' in input){const b=await creditBasis(ctx,input,true),i=b.invoice;await document(ctx,p,i.issuer_id,i.issuer_version,'credit_note',input.issuedAt,b.on);
  await ctx.db.query('INSERT INTO public.tuition_invoice_credits(academy_id,id,invoice_id,journal_id,description,reason) VALUES($1,$2,$3,$4,$5,$6)',[ctx.credential.academy_id,p.target_id,i.id,i.journal_id?p.target_id:null,input.description,input.reason]);
  if(i.journal_id)await applyJournal(ctx,{...p,payload:b.journal},true);
  await ctx.db.query('UPDATE public.tuition_invoices SET credit_id=$2 WHERE id=$1',[i.id,p.target_id]);result=await invoice(ctx,i.id);
 }else if('planId' in input){const b=await issueBasis(ctx,input,true);if(b.existing)throw new ApiError(409,'TUITION_ALREADY_INVOICED');await document(ctx,p,input.issuerId,input.issuerVersion,'invoice',input.issuedAt,b.on);
  const gross=readMinorUnits(String(b.terms.grossMinor));await ctx.db.query(`INSERT INTO public.tuition_invoices(academy_id,id,plan_id,plan_version,student_id,class_id,hub_id,bill_to_id,bill_to_name,bill_to_snapshot,description,recognition,tax_timing_review,period_id,period_version,journal_id,receivable_account,receivable_version,consideration_account,consideration_version,tax_account,tax_version)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,[ctx.credential.academy_id,p.target_id,b.plan.id,b.plan.version,b.plan.student_id,b.plan.class_id,b.plan.hub_id,input.billToId,b.billTo.name,JSON.stringify(b.billTo),input.description,input.recognition,input.taxTimingReview,input.periodId,input.periodVersion,gross>0n?p.target_id:null,input.accounts.receivable.id,input.accounts.receivable.version,input.accounts.consideration.id,input.accounts.consideration.version,input.accounts.tax?.id??null,input.accounts.tax?.version??null]);
  if(gross>0n)await applyJournal(ctx,{...p,payload:b.journal},false);result=await invoice(ctx,p.target_id);
 }else throw new ApiError(400,'INVALID_INVOICE_ACTION');
 await record(ctx.db,ctx.credential,ctx.requestId,crediting?'finance.invoice.credited':'finance.invoice.issued',result.id,result.hub_id,{approvalId:p.id,documentId:p.target_id,severity:'critical',hasReason:true});return detail(ctx,result);
}
async function reviewer(ctx:ApiContext,p:Proposal){if(await master(ctx))return;const studentId=p.action==='finance.invoice.credit'?(await invoice(ctx,creditPayload.parse(p.payload).invoiceId)).student_id:(await tuitionPlan(ctx,issuePayload.parse(p.payload).planId)).student_id;
 if(ctx.credential.person_id===studentId||(await ctx.db.query('SELECT 1 FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2 LIMIT 1',[studentId,ctx.credential.person_id])).rows.length)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');}
export const invoiceActions:ApprovalRegistry={
 'finance.invoice-issuer.create':{requestCapability:'invoice-issuers.edit',privacyCapability:'invoice-issuers.edit',policyChange:true,createdStatus:201,validate:(c,id,i)=>validateIssuer(c,true,id,i),dependencies:(c,id,i,p)=>issuerDependencies(c,true,id,i,p),apply:applyIssuer},
 'finance.invoice-issuer.replace':{requestCapability:'invoice-issuers.edit',privacyCapability:'invoice-issuers.edit',policyChange:true,validate:(c,id,i)=>validateIssuer(c,false,id,i),dependencies:(c,id,i,p)=>issuerDependencies(c,false,id,i,p),apply:applyIssuer},
 'finance.invoice.issue':{requestCapability:'invoices.edit',privacyCapability:'invoices.edit',policyChange:true,createdStatus:201,validate:(c,id,i)=>validateInvoice(c,false,i),dependencies:(c,id,i,p)=>invoiceDependencies(c,false,i,p),authorizeReviewer:reviewer,apply:applyInvoice},
 'finance.invoice.credit':{requestCapability:'invoices.edit',privacyCapability:'invoices.edit',policyChange:true,createdStatus:201,validate:(c,id,i)=>validateInvoice(c,true,i),dependencies:(c,id,i,p)=>invoiceDependencies(c,true,i,p),authorizeReviewer:reviewer,apply:applyInvoice}
};
export async function invoices(ctx:ApiContext,registry:ApprovalRegistry=invoiceActions):Promise<Reply|null>{
 const issuers=/^finance\/invoice-issuers(?:\/([^/]+)(?:\/(change|history))?)?$/.exec(ctx.path),issuePath=/^finance\/tuition-plans\/([^/]+)\/invoice$/.exec(ctx.path),invoices=/^finance\/invoices(?:\/([^/]+)(?:\/(credit))?)?$/.exec(ctx.path);if(!issuers&&!issuePath&&!invoices)return null;
 if(issuers){const id=issuers[1]?uuid.parse(issuers[1]):null,section=issuers[2];
  if(ctx.request.method==='POST'){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));if(!id){const input=issuerCreate.parse(await jsonBody(ctx.request));issuerDestination(ctx,input.hubId);return propose(ctx,registry,'finance.invoice-issuer.create',null,0,input);}if(section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const input=issuerReplace.parse(await jsonBody(ctx.request));await issuer(ctx,id,true);return propose(ctx,registry,'finance.invoice-issuer.replace',id,input.expectedVersion,input);}
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(id){const data=await issuer(ctx,id,section==='history');
   if(section==='history'){const q=issuerHistoryQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{version:number}>('SELECT version,definition,active,reason,changed_by AS "changedBy",approval_id AS "approvalId" FROM public.invoice_issuer_revisions WHERE issuer_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
   if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data}};}
  const q=issuerQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),s=allowed(ctx,'invoice-issuers.view'),rows=(await ctx.db.query<{id:string}>('SELECT i.id,i.hub_id,i.prefix,i.padding,i.version,r.definition,r.active FROM public.invoice_issuers i JOIN public.invoice_issuer_revisions r ON r.academy_id=i.academy_id AND r.issuer_id=i.id AND r.version=i.version WHERE (i.hub_id IS NULL OR (($1::boolean OR i.hub_id=ANY($2::uuid[])) AND NOT i.hub_id=ANY($3::uuid[]))) AND ($4::uuid IS NULL OR i.id>$4) AND ($5::boolean IS NULL OR r.active=$5) ORDER BY i.id LIMIT $6',[s.all,s.hubs,s.excludedHubs??[],q.after??null,q.active??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 if(issuePath){if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));const input={...issue.parse(await jsonBody(ctx.request)),planId:uuid.parse(issuePath[1])};financialRecordAuthority(ctx,await tuitionPlan(ctx,input.planId),'invoices.edit');return propose(ctx,registry,'finance.invoice.issue',null,0,input);}
 const id=invoices![1]?uuid.parse(invoices![1]):null,section=invoices![2];if(id){
  if(ctx.request.method==='POST'&&section==='credit'){z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));await invoice(ctx,id,true);const input={...credit.parse(await jsonBody(ctx.request)),invoiceId:id};return propose(ctx,registry,'finance.invoice.credit',null,0,input);}
  if(ctx.request.method!=='GET'||section)throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:await detail(ctx,await invoice(ctx,id))}};
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=listQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),s=allowed(ctx,'invoices.view'),rows=(await ctx.db.query<{id:string}>(`SELECT i.id,d.number,d.issued_on::text AS "issuedOn",i.student_id AS "studentId",i.class_id AS "classId",i.hub_id AS "hubId",i.credit_id AS "creditId",CASE WHEN i.credit_id IS NULL THEN 'issued' ELSE 'credited' END AS status FROM public.tuition_invoices i JOIN public.billing_documents d ON d.academy_id=i.academy_id AND d.id=i.id
  WHERE ($1::boolean OR i.hub_id=ANY($2::uuid[]) OR i.class_id=ANY($3::uuid[]) OR i.student_id=ANY($4::uuid[])) AND NOT i.hub_id=ANY($5::uuid[]) AND NOT i.class_id=ANY($6::uuid[]) AND NOT i.student_id=ANY($7::uuid[]) AND ($8::boolean OR i.hub_id=ANY($9::uuid[])) AND ($10::uuid IS NULL OR i.id>$10) AND ($11::uuid IS NULL OR i.hub_id=$11) AND ($12::uuid IS NULL OR i.student_id=$12) AND ($13::uuid IS NULL OR i.class_id=$13) AND ($14::text IS NULL OR (i.credit_id IS NULL)=($14='issued')) ORDER BY i.id LIMIT $15`,[s.all,s.hubs,(s.classes??[]).map(c=>c.id),(s.people??[]).map(p=>p.id),s.excludedHubs??[],(s.excludedClasses??[]).map(c=>c.id),(s.excludedPeople??[]).map(p=>p.id),ctx.credential.all_hubs,ctx.credential.hub_ids,q.after??null,q.hubId??null,q.studentId??null,q.classId??null,q.status??null,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const invoicesContract=[
 {path:'/api/v1/finance/invoice-issuers',method:'get',summary:'Scoped issuer profiles; shared school issuer details are selectable with this feature permission',querySchema:issuerQuery},
 {path:'/api/v1/finance/invoice-issuers',method:'post',summary:'Request reviewed issuer identity, public tax registration metadata and unique number prefix; registration is format-checked, not independently verified',schema:issuerCreate},
 {path:'/api/v1/finance/invoice-issuers/{id}',method:'get',summary:'Read a permitted invoice issuer profile'},
 {path:'/api/v1/finance/invoice-issuers/{id}/change',method:'post',summary:'Request a full issuer revision without rewriting old invoices or resetting document numbers',schema:issuerReplace},
 {path:'/api/v1/finance/invoice-issuers/{id}/history',method:'get',summary:'Editor-only paginated issuer revisions and private review reasons',querySchema:issuerHistoryQuery},
 {path:'/api/v1/finance/tuition-plans/{id}/invoice',method:'post',summary:'Request an immutable tuition invoice and exact reviewed receivable/deferred-or-earned/tax journal; not payment, legal eligibility or tax filing',schema:issue},
 {path:'/api/v1/finance/invoices',method:'get',summary:'Scope-filtered family invoice directory; issued does not mean paid',querySchema:listQuery},
 {path:'/api/v1/finance/invoices/{id}',method:'get',summary:'Read permitted immutable issuer/recipient/tuition/instalment snapshots and any full credit note, without private account mappings or review notes'},
 {path:'/api/v1/finance/invoices/{id}/credit',method:'post',summary:'Request a full credit note and exact inverse journal in an open period; no cash refund or CRA deduction eligibility decision',schema:credit}
] as const;
export { invoice as invoiceRow };

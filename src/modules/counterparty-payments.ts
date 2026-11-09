import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,type ApiContext,type Reply } from '../core/api.ts';
import { propose,master,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { readMinorUnits } from '../core/money.ts';
import { accountRow } from './finance.ts';
import { accountingDate } from './finance-periods.ts';
import { paymentMethodRow } from './payment-methods.ts';
import { permittedPerson } from './students.ts';
import { permittedFile } from './files.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647),ref=z.object({id:uuid,version}).strict(),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),reason=text.trim().min(1).max(2000);
const detailFields={method:ref,transferredAt:z.iso.datetime({offset:true}).max(100),handledById:uuid.nullable().default(null),evidence:ref.nullable().default(null),missingEvidenceReason:text.trim().max(2000).default(''),taxTreatment:z.literal('principal_only_no_tax_posting')};
export const counterpartyPayment=z.object({treasuryLineNumber:z.number().int().min(1).max(2),...detailFields}).strict().refine(v=>v.evidence!==null||v.missingEvidenceReason.length>0);
type Payment=z.infer<typeof counterpartyPayment>;
const create=z.object({payee:ref,balanceAccount:ref,treasuryAccount:ref,direction:z.enum(['to_counterparty','from_counterparty']),category:z.enum(['loan_advance','loan_repayment']),amount:text.min(1).max(80),period:ref,postedOn:accountingDate,reference:text.trim().max(200).default(''),...detailFields,reason}).strict().refine(v=>v.evidence!==null||v.missingEvidenceReason.length>0);
type Account={id:string;hubId:string|null;kind:string;operationalRole:string;currencyId:string;unitScale:number};
type Line={accountId:string;side:'debit'|'credit';amountMinor:string};
type Parties={tags:{lineNumber:number;payee:{id:string;version:number};category:string}[]};
export async function retainedCounterpartyPayment(ctx:ApiContext,journalId:string):Promise<Payment|undefined>{
 const r=(await ctx.db.query<{id:string;input:unknown}>("SELECT o.id,p.payload->'counterpartyPayment' input FROM public.finance_journals j JOIN public.finance_journals o ON o.academy_id=j.academy_id AND o.id=coalesce(j.reverses_id,j.id) JOIN public.approval_requests p ON p.academy_id=o.academy_id AND p.id=o.approval_id WHERE j.id=$1 AND p.action='finance.journal.post' AND p.payload ? 'counterpartyPayment'",[journalId])).rows[0];if(!r)return undefined;
 const expected=counterpartyPayment.parse(r.input),actual=(await ctx.db.query<{input:Payment}>("SELECT jsonb_build_object('treasuryLineNumber',treasury_line,'method',jsonb_build_object('id',method_id,'version',method_version),'transferredAt',transferred_at_input,'handledById',handled_by,'evidence',CASE WHEN evidence_file IS NULL THEN NULL ELSE jsonb_build_object('id',evidence_file,'version',evidence_version) END,'missingEvidenceReason',missing_evidence_reason,'taxTreatment',tax_treatment) input FROM public.counterparty_payments WHERE journal_id=$1",[r.id])).rows[0];
 if(!actual||!isDeepStrictEqual(expected,actual.input))throw new ApiError(503,'COUNTERPARTY_PAYMENT_INCOMPLETE');return expected;
}
export async function prepareCounterpartyPayment(ctx:ApiContext,input:Payment|undefined,accounts:Account[],lines:Line[],parties:Parties|undefined,purpose:string,postedOn:string,reference:string,checkState:boolean,retained=false){
 if(!input)return undefined;
 if(!parties||parties.tags.length!==1||lines.length!==2||input.treasuryLineNumber===parties.tags[0].lineNumber||purpose!=='activity'||!['loan_advance','loan_repayment'].includes(parties.tags[0].category))throw new ApiError(400,'PRINCIPAL_PAYMENT_SHAPE_INVALID');
 const principal=lines[parties.tags[0].lineNumber-1],treasury=lines[input.treasuryLineNumber-1],balance=accounts.find(a=>a.id===principal.accountId)!,funding=accounts.find(a=>a.id===treasury.accountId)!;
 if(!retained){if(balance.id===funding.id||!['cash','bank','credit_card'].includes(funding.operationalRole)||balance.currencyId!==funding.currencyId||balance.unitScale!==funding.unitScale||principal.side===treasury.side||readMinorUnits(principal.amountMinor)!==readMinorUnits(treasury.amountMinor))throw new ApiError(400,'PRINCIPAL_PAYMENT_ACCOUNT_OR_UNIT_INVALID');const side=(parties.tags[0].category==='loan_advance')===(balance.kind==='asset')?'debit':'credit';if(principal.side!==side)throw new ApiError(400,'PRINCIPAL_PAYMENT_DIRECTION_INVALID');}
 const method=await paymentMethodRow(ctx,input.method.id);if(checkState&&!retained&&(!method.active||method.version!==input.method.version))throw new ApiError(409,'PAYMENT_METHOD_CHANGED');if(!retained&&method.hubId!==null&&!accounts.some(a=>a.hubId===method.hubId))throw new ApiError(400,'PAYMENT_METHOD_OWNER_MISMATCH');
 const handler=input.handledById?await permittedPerson(ctx,input.handledById,'people.view'):null;if(handler&&checkState&&!retained&&handler.status!=='active')throw new ApiError(409,'ACTIVE_HUMAN_HANDLER_REQUIRED');
 const evidence=input.evidence?await permittedFile(ctx,input.evidence.id):null;if(evidence&&(!retained&&(evidence.domain!=='finance_private'||(evidence.anchor_kind!=='academy'&&!(evidence.anchor_kind==='hub'&&accounts.some(a=>a.hubId===evidence.hub_id))))||checkState&&!retained&&(evidence.archived||evidence.version!==input.evidence!.version)))throw new ApiError(409,'PRINCIPAL_PAYMENT_EVIDENCE_INVALID');
 const referenceState=(await ctx.db.query<{source:{inUse:boolean;activity:string;sourceStamp:string}}>('SELECT public.counterparty_payment_reference($1,$2,$3,$4,$5) source',[parties.tags[0].payee.id,funding.id,input.method.id,reference,postedOn])).rows[0].source;if(checkState&&!retained&&referenceState.inUse)throw new ApiError(409,'COUNTERPARTY_PAYMENT_REFERENCE_EXISTS');
 return {input,principalLineNumber:parties.tags[0].lineNumber,payeeId:parties.tags[0].payee.id,treasuryAccountId:funding.id,method:{id:method.id,version:method.version,active:method.active,hubId:method.hubId,category:method.category},handler:handler?{id:handler.id,status:handler.status,hubId:handler.hub_id}:null,evidence:evidence?{id:evidence.id,version:evidence.version,archived:evidence.archived}:null,referenceState};
}
export async function insertCounterpartyPayment(ctx:ApiContext,p:Proposal,state:Awaited<ReturnType<typeof prepareCounterpartyPayment>>,reference:string){
 if(!state)return;if(p.action!=='finance.journal.post')throw new ApiError(400,'STANDALONE_PRINCIPAL_PAYMENT_REQUIRED');const i=state.input;
 try{await ctx.db.query('INSERT INTO public.counterparty_payments(academy_id,journal_id,principal_line,treasury_line,payee_id,treasury_account,method_id,method_version,transferred_at,transferred_at_input,handled_by,evidence_file,evidence_version,missing_evidence_reason,tax_treatment,reference,approval_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',[ctx.credential.academy_id,p.target_id,state.principalLineNumber,i.treasuryLineNumber,state.payeeId,state.treasuryAccountId,i.method.id,i.method.version,i.transferredAt,i.transferredAt,i.handledById,i.evidence?.id??null,i.evidence?.version??null,i.missingEvidenceReason,i.taxTreatment,reference,p.id,ctx.credential.person_id]);}
 catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw new ApiError(409,'COUNTERPARTY_PAYMENT_REFERENCE_EXISTS');throw error;}
}
export async function counterpartyPaymentReviewer(ctx:ApiContext,p:Proposal){
 if(await master(ctx))return;const raw=z.object({reversesId:uuid.optional(),counterpartyPayment:counterpartyPayment.optional()}).passthrough().parse(p.payload),i=p.action==='finance.journal.reverse'?await retainedCounterpartyPayment(ctx,raw.reversesId!):raw.counterpartyPayment;if(i?.handledById===ctx.credential.person_id)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');
}
export function counterpartyPaymentOutput(i:Payment){return {method:i.method,transferredAt:i.transferredAt,handledById:i.handledById,evidence:i.evidence?{...i.evidence,storedContentVerified:false}:null,hasEvidenceReference:i.evidence!==null,missingEvidenceException:i.evidence===null,taxTreatment:i.taxTreatment,interestOrTaxCalculated:false,externallyVerified:false,moneyMovementPerformed:false};}
export async function counterpartyPayments(ctx:ApiContext,registry:ApprovalRegistry):Promise<Reply|null>{
 if(ctx.path!=='finance/counterparty-transactions')return null;if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');const search=new URL(ctx.request.url).searchParams;z.object({}).strict().parse(Object.fromEntries(search));
 const i=create.parse(await jsonBody(ctx.request)),balance=await accountRow(ctx,i.balanceAccount.id),out=i.direction==='to_counterparty',side=out?'debit' as const:'credit' as const;
 // Account kind determines borrowing versus lending;the requested category
 // must agree. Existing journal validation pins versions,units and scope.
 if((i.category==='loan_advance')!==(out===(balance.kind==='asset')))throw new ApiError(400,'PRINCIPAL_PAYMENT_DIRECTION_INVALID');
 const payload={periodId:i.period.id,periodVersion:i.period.version,postedOn:i.postedOn,purpose:'activity',description:'Recorded external principal '+i.category,reference:i.reference,reason:i.reason,lines:[{accountId:i.balanceAccount.id,accountVersion:i.balanceAccount.version,side,amount:i.amount},{accountId:i.treasuryAccount.id,accountVersion:i.treasuryAccount.version,side:out?'credit':'debit',amount:i.amount}],counterpartyLines:[{lineNumber:1,payee:i.payee,category:i.category}],counterpartyPayment:{treasuryLineNumber:2,method:i.method,transferredAt:i.transferredAt,handledById:i.handledById,evidence:i.evidence,missingEvidenceReason:i.missingEvidenceReason,taxTreatment:i.taxTreatment}};
 return propose(ctx,registry,'finance.journal.post',null,0,payload);
}
export const counterpartyPaymentsContract=[{path:'/api/v1/finance/counterparty-transactions',method:'post',summary:'Request a human-reviewed recorded loan advance or repayment with explicit named payee,balance/treasury accounts,method,handler,time and finance-private evidence or reason. Reuses ONE immutable balanced journal and explicit principal links;no duplicate liability/expense,interest/tax calculation or externally executed bank/card transfer. Currency units and borrowing/lending direction must agree. Exact correction is the original journal reversal workflow.',schema:create}] as const;

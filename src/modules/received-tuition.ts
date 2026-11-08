import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { lockApprovalWrites,permissionScope } from '../core/approvals.ts';
import { ApiError,scopeNonempty } from '../core/policy.ts';
import { formatMoney,readMinorUnits } from '../core/money.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),empty=z.object({}).strict();
const query=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),after:uuid.optional(),state:z.enum(['active','cancelled']).optional()}).strict();
type Terms={id:string;enrollmentId:string;studentId:string;classId:string;hubId:string;currencyId:string;unitScale:number;version:number;state:string;currencyCode:string;originalMinor:string;agreedMinor:string;netMinor:string;taxMinor:string;grossMinor:string;[key:string]:unknown};
export async function receivedTuition(ctx:ApiContext):Promise<Reply|null>{
 const m=/^students\/([^/]+)\/tuition-plans(?:\/([^/]+))?$/.exec(ctx.path);if(!m)return null;
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const studentId=uuid.parse(m[1]),id=m[2]?uuid.parse(m[2]):null,params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const q=id?(empty.parse(Object.fromEntries(params)),null):query.parse(Object.fromEntries(params));
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_RECIPIENT_REQUIRED');
 await lockApprovalWrites(ctx);const scope=permissionScope(ctx,'received-tuition.view');if(!scopeNonempty(scope))throw new ApiError(403,'FORBIDDEN');
 // Registration authority intentionally includes pending child accounts:
 // guardians must review tuition before signing/admission or a child login.
 if(!(await ctx.db.query<{v:boolean}>('SELECT public.registration_data_basis($1,$2) IS NOT NULL v',[studentId,ctx.credential.person_id])).rows[0].v)throw new ApiError(404,'NOT_FOUND');
 // Scope and live family checks precede paging in the same statement snapshot.
 // One canonical plan;no copied family ledger,staff notes or historical payload.
 const rows=(await ctx.db.query<Terms>(`WITH recipient AS MATERIALIZED(SELECT public.registration_data_basis($1,$2) IS NOT NULL allowed)
 SELECT p.id,p.enrollment_id "enrollmentId",p.student_id "studentId",p.class_id "classId",p.hub_id "hubId",p.currency_id "currencyId",p.unit_scale "unitScale",p.version,r.state,
 c.code "currencyCode",r.original_minor::text "originalMinor",r.agreed_minor::text "agreedMinor",r.net_minor::text "netMinor",r.tax_minor::text "taxMinor",r.gross_minor::text "grossMinor",r.pricing,r.supply_on::text "supplyOn",
 e.joins_on::text "joinsOn",e.leaves_on::text "leavesOn",e.enabled "enrollmentEnabled",k.name "className",k.code "classCode",k.time_zone "timeZone"
 FROM public.tuition_plans p JOIN public.tuition_plan_revisions r ON r.academy_id=p.academy_id AND r.plan_id=p.id AND r.version=p.version
 JOIN public.finance_currencies c ON c.academy_id=p.academy_id AND c.id=p.currency_id
 JOIN public.class_enrollments e ON e.academy_id=p.academy_id AND e.id=p.enrollment_id
 JOIN public.classes k ON k.academy_id=p.academy_id AND k.id=p.class_id CROSS JOIN recipient
 WHERE p.student_id=$1 AND recipient.allowed AND public.scope_contains($3::jsonb,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',p.student_id,'hubId',p.hub_id)),'recordContext',jsonb_build_object('hubId',p.hub_id,'classId',p.class_id,'studentId',p.student_id)))
 AND($4::uuid IS NULL OR p.id=$4) AND($5::uuid IS NULL OR p.id>$5) AND($6::text IS NULL OR r.state=$6) ORDER BY p.id LIMIT $7`,[studentId,ctx.credential.person_id,JSON.stringify(scope),id,q?.after??null,q?.state??null,id?1:q!.limit+1])).rows;
 const view=(r:Terms)=>{const {originalMinor,agreedMinor,netMinor,taxMinor,grossMinor,...safe}=r;return {...safe,originalAmount:formatMoney(readMinorUnits(originalMinor),r.unitScale),agreedAmount:formatMoney(readMinorUnits(agreedMinor),r.unitScale),net:formatMoney(readMinorUnits(netMinor),r.unitScale),tax:formatMoney(readMinorUnits(taxMinor),r.unitScale),plannedGross:formatMoney(readMinorUnits(grossMinor),r.unitScale),planningOnly:true,posted:false,paymentStatus:'not_tracked_here',admissionGranted:false};};
 if(id){const r=rows[0];if(!r)throw new ApiError(404,'NOT_FOUND');
  const items=(await ctx.db.query<{ordinal:number;dueOn:string;amountMinor:string;methodId:string;methodVersion:number;methodName:string;methodCategory:string}>(`SELECT i.ordinal,i.due_on::text "dueOn",i.amount_minor::text "amountMinor",i.method_id "methodId",i.method_version "methodVersion",v.name "methodName",m.category "methodCategory" FROM public.tuition_installments i JOIN public.finance_payment_method_revisions v ON v.academy_id=i.academy_id AND v.method_id=i.method_id AND v.version=i.method_version JOIN public.finance_payment_methods m ON m.academy_id=i.academy_id AND m.id=i.method_id WHERE i.plan_id=$1 AND i.version=$2 ORDER BY i.ordinal`,[id,r.version])).rows;
  return {status:200,body:{data:{...view(r),installments:items.map(({amountMinor,...i})=>({...i,amount:formatMoney(readMinorUnits(amountMinor),r.unitScale)}))},privateFamilyOnly:true}};
 }
 return {status:200,body:{studentId,data:rows.slice(0,q!.limit).map(view),nextCursor:rows.length>q!.limit?rows[q!.limit-1].id:null,privateFamilyOnly:true}};
}
export const receivedTuitionContract=[
 {path:'/api/v1/students/{id}/tuition-plans',method:'get',humanOnly:true,summary:'Own/current approved parent or legal guardian current tuition terms under separate configurable received-tuition.view; native exact student/class/hub scope before bounded paging. No peer finances,staff review notes,recruiter shares or general finance access. Planned amounts are not actual cash or outstanding balances.',querySchema:query},
 {path:'/api/v1/students/{id}/tuition-plans/{planId}',method:'get',humanOnly:true,summary:'Current canonical family tuition terms and exact pinned installment method labels,including cancelled terms without forgiving debt. No historical-version bypass,administrative source,receipt/payment claim or automatic admission.',querySchema:empty}
] as const;

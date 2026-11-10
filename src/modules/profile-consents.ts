import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { lockAcademyTopology } from './academy.ts';
import { assertSchemaReady } from '../core/database.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),purpose=z.enum(['public_profile','verified_member_profile']),empty=z.object({}).strict();
const input=z.object({reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f-\u009f]/.test(v)).default('Profile sharing withdrawn')}).strict();
const history=z.object({afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0),limit:z.coerce.number().int().min(1).max(20).default(10)}).strict();
const consentReason=z.enum(['profile_consent_missing','profile_owner_inactive','profile_consent_time_zone_required','profile_consent_identity_unverified','profile_consent_needs_review','profile_consent_withdrawn','profile_consent_identity_changed','profile_consent_current_guardian_required','profile_consent_adult_self_required','profile_consent_signer_unverified','profile_consent_live_source_required','profile_consent_declined']);
export const profileConsentEligibilitySchema=z.object({eligible:z.boolean(),reason:consentReason.nullable(),purpose,requiresGuardian:z.boolean().nullable(),evidenceId:uuid.nullable(),reviewVersion:z.number().int().positive().nullable(),providerFreshlyChecked:z.literal(false),legalValidityCertified:z.literal(false)}).strict()
 .refine(v=>v.eligible?v.reason===null&&v.evidenceId!==null&&v.reviewVersion!==null&&v.requiresGuardian!==null:v.reason!==null&&v.evidenceId===null&&v.reviewVersion===null);
type Basis={studentId:string;actorId:string;hubId:string|null;studentProfileVersion:number;authority:'self'|'current_guardian';relationshipId:string|null;relationshipVersion:number|null;timeZone:string|null};
async function family(ctx:ApiContext,id:string){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_PRIVACY_ACTION_REQUIRED');await assertSchemaReady(ctx.db);await lockAcademyTopology(ctx);
 const b=(await ctx.db.query<{b:Basis|null}>('SELECT public.profile_consent_actor_basis($1,$2) b',[id,ctx.credential.person_id])).rows[0]?.b;if(!b)throw new ApiError(404,'NOT_FOUND');return b;
}
export async function profileConsents(ctx:ApiContext):Promise<Reply|null>{
 const m=/^students\/([^/]+)\/profile-consents(?:\/([^/]+)\/(withdraw|withdrawals))?$/.exec(ctx.path);if(!m)return null;
 const id=uuid.parse(m[1]),kind=m[2]?purpose.parse(m[2]):null,params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');const raw=Object.fromEntries(params);
 if(ctx.request.method==='POST'&&m[3]==='withdraw'){
  empty.parse(raw);const i=input.parse(await jsonBody(ctx.request));await lockApprovalWrites(ctx,true);const b=await family(ctx,id);
  return mutation(ctx,i,async()=>{
   const row=(await ctx.db.query<{version:number;withdrawnAt:string}>('INSERT INTO public.profile_consent_withdrawals(academy_id,student_id,purpose,version,actor_id,session_id,request_id,source_basis,reason) SELECT $1,$2,$3,coalesce(max(version),0)+1,$4,$5,$6,$7::jsonb,$8 FROM public.profile_consent_withdrawals WHERE academy_id=$1 AND student_id=$2 AND purpose=$3 RETURNING version,withdrawn_at AS "withdrawnAt"',[ctx.credential.academy_id,id,kind,ctx.credential.person_id,ctx.credential.token_id,ctx.requestId,JSON.stringify(b),i.reason])).rows;
   if(row.length!==1)throw new Error('PROFILE_CONSENT_WITHDRAWAL_MISSING');const r=row[0];
   await record(ctx.db,ctx.credential,ctx.requestId,'profile-consent.withdraw',id,b.hubId,{purpose:kind,version:r.version,severity:'critical',privateContentRedacted:true});
   return{status:200,body:{data:{studentId:id,purpose:kind,version:r.version,withdrawnAt:r.withdrawnAt,requiresNewConsentDocument:true,upperApprovalRequired:false},consentGranted:false}};
  },async()=>{await family(ctx,id);});
 }
 if(ctx.request.method!=='GET'||m[3]==='withdraw')throw new ApiError(405,'METHOD_NOT_ALLOWED');await lockApprovalWrites(ctx);const b=await family(ctx,id);
 if(kind){const q=history.parse(raw),rows=(await ctx.db.query<{version:number}>('SELECT version,actor_id=$4 AS "withdrawnByYou",withdrawn_at AS "withdrawnAt" FROM public.profile_consent_withdrawals WHERE student_id=$1 AND purpose=$2 AND version>$3 ORDER BY version LIMIT $5',[id,kind,q.afterVersion,ctx.credential.person_id,q.limit+1])).rows;await record(ctx.db,ctx.credential,ctx.requestId,'profile-consent.withdrawal.read',id,b.hubId,{purpose:kind,kind:'history',rows:Math.min(rows.length,q.limit)});return{status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null,privateReasonsIncluded:false}};}
 empty.parse(raw);const rows=(await ctx.db.query('SELECT DISTINCT ON(purpose) purpose,version,withdrawn_at AS "lastWithdrawnAt" FROM public.profile_consent_withdrawals WHERE student_id=$1 ORDER BY purpose,version DESC',[id])).rows;
 const evaluated=(await ctx.db.query<{purpose:string;eligibility:unknown}>('SELECT p AS purpose,public.student_profile_consent($1,p) AS eligibility FROM unnest($2::text[]) p',[id,purpose.options])).rows;
 if(evaluated.length!==2||new Set(evaluated.map(r=>r.purpose)).size!==2)throw new ApiError(503,'PROFILE_CONSENT_UNAVAILABLE');
 const states=evaluated.map(r=>{const parsed=profileConsentEligibilitySchema.safeParse(r.eligibility);if(!parsed.success||parsed.data.purpose!==r.purpose)throw new ApiError(503,'PROFILE_CONSENT_UNAVAILABLE');const s=parsed.data;return{purpose:s.purpose,consentEligible:s.eligible,consentReason:s.reason,requiresGuardian:s.requiresGuardian};});
 await record(ctx.db,ctx.credential,ctx.requestId,'profile-consent.withdrawal.read',id,b.hubId,{kind:'summary',rows:rows.length});return{status:200,body:{studentId:id,data:purpose.options.map(p=>({...states.find(r=>r.purpose===p)!,...rows.find(r=>r.purpose===p)??{version:0,lastWithdrawnAt:null}})),consentGrantEvaluated:true,publicationEvaluated:false,providerFreshlyChecked:false,legalValidityCertified:false}};
}
export const profileConsentsContract=[
 {path:'/api/v1/students/{id}/profile-consents',method:'get',humanOnly:true,summary:'Verified self/current under18 legal family reads purpose-specific withdrawal and native consent-evidence eligibility. Requires selected optional choice,accepted original-bound Live-registry evidence,current legal identity/guardian/age and post-withdrawal dispatch. No source IDs,private signer data,public publication or legal/provider certification.'},
 {path:'/api/v1/students/{id}/profile-consents/{purpose}/withdraw',method:'post',humanOnly:true,pathSchemas:{purpose},summary:'Immediate self/current-guardian privacy withdrawal,no upper approval or editable clocks. Purpose is public_profile or verified_member_profile;empty body is sufficient. Allowed in read-only school. Old signed-document replay cannot clear the immutable withdrawal cutoff. Enrollment is unchanged.',schema:input},
 {path:'/api/v1/students/{id}/profile-consents/{purpose}/withdrawals',method:'get',humanOnly:true,pathSchemas:{purpose},summary:'Current verified self/legal family reads bounded withdrawal history,without private reasons or another guardian identity',querySchema:history}
] as const;

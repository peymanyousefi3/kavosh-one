import { Temporal } from '@js-temporal/polyfill';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,master,permissionScope,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,scopeAllowsRef } from '../core/policy.ts';
import { lockAcademyTopology } from './academy.ts';
import { classRow } from './classes.ts';
import { enrollment } from './enrollments.ts';
import { template } from './agreements.ts';
import { permittedPerson } from './students.ts';
import { permittedFile } from './files.ts';
import { signatureConnectionTarget } from '../integrations/boldsign-webhook-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2_147_483_647);
const inputSchema=z.object({enrollmentVersion:version,templateId:uuid,templateVersion:version,signerId:uuid,relationshipId:uuid.nullable().default(null),
 connectionId:uuid,locale:z.enum(['en','fr','zh-CN']),reason:z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'))}).strict();
const payloadSchema=inputSchema.extend({enrollmentId:uuid});
type Input=z.infer<typeof payloadSchema>;

// Age uses civil dates, never elapsed UTC milliseconds. For a leap-day birth,
// retain guardian protection through February 28 in a non-leap anniversary year.
export function agreementRequiresGuardian(birth:string,on:string) {
 const b=Temporal.PlainDate.from(birth),d=Temporal.PlainDate.from(on);
 if(Temporal.PlainDate.compare(d,b)<0)throw new ApiError(409,'AGREEMENT_DATE_BEFORE_BIRTH');
 return d.year-b.year-(on.slice(5)<birth.slice(5)?1:0)<18;
}
export interface AgreementPackageRow extends Record<string,unknown> {id:string;enrollment_id:string;template_id:string;template_version:number;template_hash:string;locale:string;signer_id:string;student_id:string;hub_id:string;class_id:string;approval_id:string;created_by:string;connection_id:string;connection_target:string}
export async function permittedAgreementPackage(ctx:ApiContext,id:string,editing=false) {
 const row=(await ctx.db.query<AgreementPackageRow>('SELECT * FROM public.agreement_packages WHERE id=$1',[id])).rows[0];if(!row)throw new ApiError(404,'NOT_FOUND');
 await sources(ctx,{enrollmentId:row.enrollment_id,templateId:row.template_id,signerId:row.signer_id},editing);
 const link=(await ctx.db.query<{id:string;file_id:string}>(`SELECT l.id,b.file_id FROM public.agreement_package_contents l JOIN public.agreement_content_bindings b ON b.academy_id=l.academy_id AND b.id=l.binding_id WHERE l.package_id=$1`,[id])).rows[0];
 if(link)await permittedFile(ctx,link.file_id);
 return {...row,contentAttachmentId:link?.id??null,contentAttached:Boolean(link),readyToSend:false};
}
export async function currentAgreementPackage(ctx:ApiContext,id:string) {
 const row=await permittedAgreementPackage(ctx,id,true),prepared=(await ctx.db.query<{payload:unknown;review_context:Record<string,unknown>;status:string;action:string;target_id:string;reviewer_id:string}>('SELECT payload,review_context,status,action,target_id,reviewer_id FROM public.approval_requests WHERE id=$1',[row.approval_id])).rows[0];
 if(!prepared||prepared.status!=='applied'||prepared.action!=='agreement.prepare'||prepared.target_id!==row.id||prepared.reviewer_id!==row.created_by)throw new ApiError(409,'PACKAGE_PREPARATION_REQUIRED');
 const {preparedOn:currentDay,...current}=await basis(ctx,payloadSchema.parse(prepared.payload));
 const {preparedOn:originalDay,...original}=prepared.review_context;
 // Do not expire a valid preparation merely at midnight. basis still checks
 // current civil age/guardian authority, parties, contacts and all revisions.
 if(!isDeepStrictEqual(JSON.parse(JSON.stringify(current)),JSON.parse(JSON.stringify(original))))throw new ApiError(409,'PACKAGE_SOURCES_CHANGED');
 return {row,basis:current};
}
async function sources(ctx:ApiContext,input:Pick<Input,'enrollmentId'|'templateId'|'signerId'>,editing=false) {
 const {row:e,c}=await enrollment(ctx,input.enrollmentId);
 await classRow(ctx,c.id,'signatures.view');if(editing)await classRow(ctx,c.id,'signatures.edit');
 const student=await permittedPerson(ctx,e.student_id,'students.view');
 const t=await template(ctx,input.templateId);if(t.definition.kind!=='unified_enrollment')throw new ApiError(409,'ENROLLMENT_AGREEMENT_REQUIRED');
 if(t.hub_id!==null&&t.hub_id!==e.hub_id)throw new ApiError(409,'AGREEMENT_HUB_MISMATCH');
 let signer=student;
 if(input.signerId!==e.student_id) {
  await permittedPerson(ctx,e.student_id,'families.view');
  signer=await permittedPerson(ctx,input.signerId,'guardians.view');
 }
 for(const person of [student,signer])for(const cap of editing?['signatures.view','signatures.edit'] as const:['signatures.view'] as const)
  if(!scopeAllowsRef(permissionScope(ctx,cap),{id:person.id,hubId:person.hub_id},'people'))throw new ApiError(404,'NOT_FOUND');
 return {e,c,t,student,signer};
}
async function basis(ctx:ApiContext,input:Input) {
 const {e,c,t,student,signer}=await sources(ctx,input,true);
 if(!e.enabled||!c.active||!(await ctx.db.query('SELECT 1 FROM public.hubs WHERE id=$1 AND active',[e.hub_id])).rows.length)throw new ApiError(409,'ACTIVE_ENROLLMENT_REQUIRED');
 if(e.version!==input.enrollmentVersion)throw new ApiError(409,'ENROLLMENT_CHANGED');
 if(t.version!==input.templateVersion||!t.available||!t.definition.provider)throw new ApiError(409,'AGREEMENT_NOT_READY');
 if(!t.definition.languages.some(l=>l.locale===input.locale))throw new ApiError(409,'AGREEMENT_LANGUAGE_UNAVAILABLE');
 const profile=(await ctx.db.query<{version:number;date_of_birth:string}>('SELECT version,date_of_birth::text FROM public.student_profiles WHERE person_id=$1',[e.student_id])).rows[0];
 if(!profile||profile.version!==e.student_profile_version)throw new ApiError(409,'STUDENT_PROFILE_CHANGED');
 // A child profile need not have a login before its verified legal guardian
 // signs. The signer remains active/verified;age and relationship checks below
 // still forbid an adult substitute,minor self-signing or disabled child.
 if(!['active','pending'].includes(student.status)||signer.status!=='active')throw new ApiError(409,'ACTIVE_PARTIES_REQUIRED');
 const now=(await ctx.db.query<{at:Date|string}>('SELECT clock_timestamp() AS at')).rows[0].at;
 const on=Temporal.Instant.from(now instanceof Date?now.toISOString():now).toZonedDateTimeISO(c.time_zone).toPlainDate().toString();
 if(e.leaves_on!==null&&e.leaves_on<on)throw new ApiError(409,'ENROLLMENT_ENDED');
 const minor=agreementRequiresGuardian(profile.date_of_birth,on);
 let guardianVersion:number|null=null,relationship:Record<string,unknown>|null=null;
 if(minor) {
  if(input.signerId===e.student_id||!input.relationshipId)throw new ApiError(409,'LEGAL_GUARDIAN_REQUIRED');
  const g=(await ctx.db.query<{version:number}>('SELECT version FROM public.guardian_profiles WHERE person_id=$1',[input.signerId])).rows[0];
  if(!g)throw new ApiError(409,'LEGAL_GUARDIAN_REQUIRED');guardianVersion=g.version;
  relationship=(await ctx.db.query(`SELECT id,version,relationship,valid_from,valid_until FROM public.family_relationships
   WHERE id=$1 AND student_id=$2 AND guardian_id=$3 AND state='approved' AND relationship IN ('parent','legal_guardian')
   AND valid_from<=$4::timestamptz AND (valid_until IS NULL OR valid_until>$4::timestamptz)`,[input.relationshipId,e.student_id,input.signerId,now])).rows[0]??null;
  if(!relationship)throw new ApiError(409,'LEGAL_GUARDIAN_REQUIRED');
 }else if(input.signerId!==e.student_id||input.relationshipId!==null)throw new ApiError(409,'ADULT_STUDENT_SIGNER_REQUIRED');
 const contact=(await ctx.db.query<{contact_fingerprint:string;email_verified:boolean;phone_verified:boolean;account_active:boolean}>('SELECT * FROM public.signer_verification_status($1)',[input.signerId])).rows[0];
 if(!contact?.account_active||!contact.email_verified||!contact.phone_verified)throw new ApiError(409,'VERIFIED_SIGNER_REQUIRED');
 const connection=(await ctx.db.query<{id:string;academy_id:string;region:'US'|'CA'|'EU'|'AU';environment:'Test'|'Live';client_id:string|null;enabled:boolean}>('SELECT * FROM public.signature_connection_status($1)',[input.connectionId])).rows[0];
 if(!connection?.enabled||connection.region!==t.definition.provider.region)throw new ApiError(409,'SIGNATURE_CONNECTION_UNAVAILABLE');
 return {enrollmentId:e.id,enrollmentVersion:e.version,classId:c.id,classVersion:c.version,hubId:e.hub_id,studentId:e.student_id,
  studentProfileVersion:profile.version,studentHubId:student.hub_id,signerHubId:signer.hub_id,templateId:t.id,templateVersion:t.version,templateHash:t.definition_hash,
  provider:t.definition.provider,locale:input.locale,signerId:input.signerId,guardianProfileVersion:guardianVersion,relationship,
  connectionId:connection.id,connectionTarget:signatureConnectionTarget({connectionId:connection.id,academyId:connection.academy_id,region:connection.region,environment:connection.environment,clientId:connection.client_id}),
  contactFingerprint:contact.contact_fingerprint,preparedOn:on};
}
async function validate(ctx:ApiContext,_id:string,raw:unknown) {
 // Exclusive policy lock (declared in the registry) serializes existing family
 // suspension/enrollment approval paths. Topology protects source ownership.
 await lockAcademyTopology(ctx);const input=payloadSchema.parse(raw),s=await sources(ctx,input,true);
 return s.t.hub_id===null?{all:true,hubs:[]}:{all:false,hubs:[],classes:[{id:s.c.id,hubId:s.e.hub_id}],
  people:[{id:s.student.id,hubId:s.student.hub_id},...s.signer.id!==s.student.id?[{id:s.signer.id,hubId:s.signer.hub_id}]:[]]};
}
async function apply(ctx:ApiContext,p:Proposal) {
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');
 const input=payloadSchema.parse(p.payload),b=await basis(ctx,input);
 if(!isDeepStrictEqual(JSON.parse(JSON.stringify(b)),JSON.parse(JSON.stringify(p.review_context))))throw new ApiError(409,'SIGNATURE_BASIS_CHANGED');
 const row=(await ctx.db.query(`INSERT INTO public.agreement_packages(academy_id,id,hub_id,class_id,enrollment_id,enrollment_version,
  student_id,student_profile_version,template_id,template_version,template_hash,locale,signer_id,guardian_profile_version,relationship_id,relationship_version,
  connection_id,connection_target,contact_fingerprint,prepared_on,prepared_at,created_by,approval_id,reason)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,clock_timestamp(),$21,$22,$23)
  RETURNING id,enrollment_id,template_id,template_version,locale,prepared_on::text,prepared_at`,[ctx.credential.academy_id,p.target_id,b.hubId,b.classId,b.enrollmentId,b.enrollmentVersion,
  b.studentId,b.studentProfileVersion,b.templateId,b.templateVersion,b.templateHash,b.locale,b.signerId,b.guardianProfileVersion,b.relationship?.id??null,b.relationship?.version??null,
  b.connectionId,b.connectionTarget,b.contactFingerprint,b.preparedOn,ctx.credential.person_id,p.id,input.reason])).rows[0];
 await record(ctx.db,ctx.credential,ctx.requestId,'agreement.package.prepared',p.target_id,b.hubId,{enrollmentId:b.enrollmentId,severity:'critical',hasReason:true});
 return {...row,state:'prepared',admissionCleared:false};
}
export async function authorizeAgreementPackageReviewer(ctx:ApiContext,input:Pick<Input,'enrollmentId'|'templateId'|'signerId'>) {
 if(await master(ctx))return;const {e}=await sources(ctx,input);
 if(ctx.credential.person_id===e.student_id||ctx.credential.person_id===input.signerId||(await ctx.db.query('SELECT 1 FROM public.family_relationships WHERE student_id=$1 AND guardian_id=$2 LIMIT 1',[e.student_id,ctx.credential.person_id])).rows.length)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');
}
export const packageActions:ApprovalRegistry={'agreement.prepare':{requestCapability:'signatures.edit',privacyCapability:'signatures.view',policyChange:true,createdStatus:201,
 validate,async dependencies(ctx,_id,raw,purpose) {
  try{return await basis(ctx,payloadSchema.parse(raw));}
  catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}
 },
 async authorizeReviewer(ctx,p) {
  await authorizeAgreementPackageReviewer(ctx,payloadSchema.parse(p.payload));
 },apply}};
export async function agreementPackages(ctx:ApiContext,registry:ApprovalRegistry=packageActions):Promise<Reply|null> {
 const create=/^enrollments\/([^/]+)\/agreement-packages$/.exec(ctx.path),item=/^agreement-packages\/([^/]+)$/.exec(ctx.path);
 if(!create&&!item)return null;z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
 if(create) {
  if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  const input=payloadSchema.parse({...inputSchema.parse(await jsonBody(ctx.request)),enrollmentId:uuid.parse(create[1])});
  await sources(ctx,input,true);return propose(ctx,registry,'agreement.prepare',null,0,input);
 }
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const row=await permittedAgreementPackage(ctx,uuid.parse(item![1]));
 // Current permissions, not old preparation authority, protect history. Do not
 // require historical sources to still be enabled to inspect an old receipt.
 return {status:200,body:{data:{...row,state:'prepared',admissionCleared:false}}};
}
export const packagesContract=[
 {path:'/api/v1/enrollments/{id}/agreement-packages',method:'post',summary:'Prepare an immutable reviewed agreement package for an active verified adult student or current active verified legal guardian. A pending minor profile needs no child login;this never activates that child,weakens signer verification,allows a disabled party or grants provider send/admission clearance.',schema:inputSchema},
 {path:'/api/v1/agreement-packages/{id}',method:'get',summary:'Read a private preparation receipt under current enrollment, signature, student, guardian/family and agreement permissions; not completed signature evidence'}
] as const;

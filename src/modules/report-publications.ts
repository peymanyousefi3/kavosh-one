import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,master,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,type Capability } from '../core/policy.ts';
import { classRow,sessionRow } from './classes.ts';
import { authorizeLearningRecipient,receivedLearningQuery as receivedQuery,receivedLearningSelection } from './learning-recipients.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647),reason=z.string().trim().min(1).max(2000).refine(v=>v.isWellFormed()&&!v.includes('\0'));
const input=z.object({reportVersion:version,priorId:uuid.nullable().default(null),allowMissingMedia:z.boolean().default(false),classAudienceReviewed:z.literal(true),reason}).strict(),publishPayload=input.extend({sessionId:uuid});
const withdrawInput=z.object({reason}).strict(),withdrawPayload=withdrawInput.extend({publicationId:uuid}),empty=z.object({}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(20).default(10),after:uuid.optional()}).strict();
type Document={title:string;locale:string;blocks:({id:string;kind:'text';text:string}|{id:string;kind:'media';fileId:string;fileVersion:number;mediaKind:string;caption:string})[]};
type Report={session_id:string;class_id:string;hub_id:string;changed_by:string;document:Document;[key:string]:unknown};
type Publication={id:string;session_id:string;class_id:string;hub_id:string;report_version:number;context:{report:Report;source:{session:{on:string;timeZone:string}}};[key:string]:unknown};
const hasMedia=(d:Document)=>d.blocks.some(b=>b.kind==='media');
async function authority(ctx:ApiContext,classId:string,document:Document,edit=false){await classRow(ctx,classId,'report-publications.view');await classRow(ctx,classId,'session-reports.view');if(edit)await classRow(ctx,classId,'report-publications.edit');if(hasMedia(document))await classRow(ctx,classId,'files.view');}
async function frozenReport(ctx:ApiContext,id:string,v:number){
 const row=(await ctx.db.query<{definition:Report}>('SELECT definition FROM public.session_report_revisions WHERE session_id=$1 AND version=$2',[id,v])).rows[0]?.definition;
 if(!row)throw new ApiError(404,'NOT_FOUND');return row;
}
async function publication(ctx:ApiContext,id:string,edit=false){const p=(await ctx.db.query<Publication>('SELECT * FROM public.report_publications WHERE id=$1',[id])).rows[0];if(!p)throw new ApiError(404,'NOT_FOUND');try{await authority(ctx,p.class_id,p.context.report.document,edit);}catch(error){if(error instanceof ApiError&&[403,404].includes(error.status))throw new ApiError(404,'NOT_FOUND');throw error;}return p;}
async function validate(ctx:ApiContext,action:string,raw:unknown){
 await lockAcademyTopology(ctx);let classId:string,hubId:string;
 if(action==='report.publish'){const i=publishPayload.parse(raw),r=await frozenReport(ctx,i.sessionId,i.reportVersion);await authority(ctx,r.class_id,r.document,true);if(i.allowMissingMedia)await classRow(ctx,r.class_id,'report-publications.override');classId=r.class_id;hubId=r.hub_id;}
 else{const p=await publication(ctx,withdrawPayload.parse(raw).publicationId,true);classId=p.class_id;hubId=p.hub_id;}
 return {all:false,hubs:[],classes:[{id:classId,hubId}]};
}
async function dependencies(ctx:ApiContext,action:string,raw:unknown){
 const i=action==='report.publish'?publishPayload.parse(raw):null;
 const source=(await ctx.db.query<{source:Record<string,unknown>|null}>(i?'SELECT public.report_publication_source($1,$2,$3,$4) source':'SELECT public.report_withdrawal_source($1) source',i?[i.sessionId,i.reportVersion,i.priorId,i.allowMissingMedia]:[withdrawPayload.parse(raw).publicationId])).rows[0].source;
 if(!source)throw new ApiError(409,'REPORT_PUBLICATION_SOURCE_CHANGED');return source;
}
async function apply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');let r:{id:string;hub_id:string}&Record<string,unknown>;
 try{
  if(p.action==='report.publish'){const i=publishPayload.parse(p.payload),report=(p.review_context as unknown as {report:Report}).report;
   r=(await ctx.db.query<{id:string;hub_id:string}&Record<string,unknown>>(`INSERT INTO public.report_publications(academy_id,id,session_id,class_id,hub_id,report_version,prior_id,allow_missing_media,audience_reviewed,context,created_by,approval_id,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13) RETURNING id,session_id,hub_id,report_version`,[ctx.credential.academy_id,p.target_id,i.sessionId,report.class_id,report.hub_id,i.reportVersion,i.priorId,i.allowMissingMedia,i.classAudienceReviewed,JSON.stringify(p.review_context),ctx.credential.person_id,p.id,i.reason])).rows[0];
  }else{const i=withdrawPayload.parse(p.payload);r=(await ctx.db.query<{id:string;hub_id:string}&Record<string,unknown>>('INSERT INTO public.report_publication_withdrawals(academy_id,id,publication_id,created_by,approval_id,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,publication_id,(SELECT hub_id FROM public.report_publications WHERE id=publication_id) hub_id',[ctx.credential.academy_id,p.target_id,i.publicationId,ctx.credential.person_id,p.id,i.reason])).rows[0];}
 }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'&&'message' in error&&error.message==='REPORT_PUBLICATION_EXACT_APPROVAL_REQUIRED')throw new ApiError(409,'REPORT_PUBLICATION_SOURCE_CHANGED');throw error;}
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,r.hub_id,{severity:'critical',hasReason:true,externalMessageSent:false,mediaServingEnabled:false,payrollApproved:false});return {...r,state:p.action==='report.publish'?'published':'withdrawn',externalMessageSent:false,mediaServingEnabled:false,payrollApproved:false};
}
export const reportPublicationActions:ApprovalRegistry=Object.fromEntries(['report.publish','report.withdraw'].map(action=>[action,{
 requestCapability:'report-publications.edit',privacyCapability:'report-publications.view',policyChange:true,createdStatus:201,
 validate:(ctx:ApiContext,_id:string,raw:unknown)=>validate(ctx,action,raw),
 async dependencies(ctx:ApiContext,_id:string,raw:unknown,purpose:'request'|'review'){try{return await dependencies(ctx,action,raw);}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx:ApiContext,p:Proposal){if(action==='report.withdraw'||await master(ctx))return;const i=publishPayload.parse(p.payload),r=await frozenReport(ctx,i.sessionId,i.reportVersion);if(r.changed_by===ctx.credential.person_id)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},apply
}])) as ApprovalRegistry;

function parentDocument(d:Document){return {title:d.title,locale:d.locale,blocks:d.blocks.map(b=>b.kind==='text'?{id:b.id,kind:'text',text:b.text}:{id:b.id,kind:'media',mediaKind:b.mediaKind,caption:b.caption,availability:'unavailable'})};}
async function received(ctx:ApiContext,studentId:string,id?:string):Promise<Reply>{
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_RECIPIENT_REQUIRED');
 const params=Object.fromEntries(new URL(ctx.request.url).searchParams),q=id?(empty.parse(params),null):receivedQuery.parse(params);
 // Shared policy lock keeps API family/access/enrollment/withdrawal changes
 // from committing halfway through this authorized response construction.
 const {s}=await authorizeLearningRecipient(ctx,studentId);
 const rows=(await ctx.db.query<{id:string;document?:Document;on:string}&Record<string,unknown>>(`SELECT p.id,p.session_id,p.report_version,p.created_at,c.name AS class_name,p.context#>>'{source,session,on}' AS on,p.context#>>'{source,session,timeZone}' AS time_zone,
  p.context#>>'{report,document,title}' AS title,p.context#>>'{report,document,locale}' AS locale${id?",p.context#>'{report,document}' AS document":''}
  FROM public.report_publications p JOIN public.classes c ON c.academy_id=p.academy_id AND c.id=p.class_id
  WHERE public.report_publication_active(p.id) AND ${receivedLearningSelection}
  ORDER BY (p.context#>>'{source,session,on}')::date DESC,p.id DESC LIMIT $7`,[studentId,ctx.credential.person_id,id??null,JSON.stringify(s),q?.beforeOn??null,q?.after??null,id?1:q!.limit+1])).rows;
 if(id){if(!rows[0])throw new ApiError(404,'NOT_FOUND');const {document,...header}=rows[0];return {status:200,body:{data:{...header,document:parentDocument(document!),mediaServingEnabled:false,externalDeliveryVerified:false,payrollApproved:false}}};}
 return {status:200,body:{studentId,data:rows.slice(0,q!.limit),nextCursor:rows.length>q!.limit?{beforeOn:rows[q!.limit-1].on,after:rows[q!.limit-1].id}:null}};
}
export async function reportPublications(ctx:ApiContext,registry:ApprovalRegistry=reportPublicationActions):Promise<Reply|null>{
 const parent=/^students\/([^/]+)\/published-reports(?:\/([^/]+))?$/.exec(ctx.path);if(parent)return received(ctx,uuid.parse(parent[1]),parent[2]?uuid.parse(parent[2]):undefined);
 const collection=/^sessions\/([^/]+)\/report\/publications$/.exec(ctx.path),item=/^report-publications\/([^/]+)(?:\/(withdraw))?$/.exec(ctx.path);if(!collection&&!item)return null;
 const params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(collection){const sessionId=uuid.parse(collection[1]);if(ctx.request.method==='POST'){empty.parse(params);return propose(ctx,registry,'report.publish',null,0,{...input.parse(await jsonBody(ctx.request)),sessionId});}
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const q=paging.parse(params),s=await sessionRow(ctx,sessionId,'report-publications.view');await classRow(ctx,s.class_id,'session-reports.view');let files=true;try{await classRow(ctx,s.class_id,'files.view');}catch(error){if(error instanceof ApiError&&[403,404].includes(error.status))files=false;else throw error;}
  const rows=(await ctx.db.query<{id:string}>('SELECT p.id,p.session_id,p.report_version,p.prior_id,p.allow_missing_media,p.created_at,public.report_publication_active(p.id) active FROM public.report_publications p WHERE p.session_id=$1 AND($2::uuid IS NULL OR p.id>$2) AND($3::boolean OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.context#>\'{report,document,blocks}\') b WHERE b->>\'kind\'=\'media\')) ORDER BY p.id LIMIT $4',[sessionId,q.after??null,files,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 const id=uuid.parse(item![1]);if(item![2]==='withdraw'){if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(params);return propose(ctx,registry,'report.withdraw',null,0,{...withdrawInput.parse(await jsonBody(ctx.request)),publicationId:id});}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');empty.parse(params);const p=await publication(ctx,id),active=(await ctx.db.query<{active:boolean}>('SELECT public.report_publication_active($1) active',[id])).rows[0].active;return {status:200,body:{data:{...p,active,mediaServingEnabled:false,externalDeliveryVerified:false,payrollApproved:false}}};
}
export const reportPublicationsContract=[
 {path:'/api/v1/sessions/{id}/report/publications',method:'post',summary:'Upper-reviewed publication of an exact frozen class-audience report; media is unavailable, no external delivery/payroll proof',schema:input},
 {path:'/api/v1/sessions/{id}/report/publications',method:'get',summary:'Private source-permission-filtered publication chain history',querySchema:paging},
 {path:'/api/v1/report-publications/{id}',method:'get',summary:'Private frozen publication/context and current active state, separate from mutable drafts'},
 {path:'/api/v1/report-publications/{id}/withdraw',method:'post',summary:'Upper-reviewed immutable withdrawal blocks subsequent received-report access without deleting evidence',schema:withdrawInput},
 {path:'/api/v1/students/{id}/published-reports',method:'get',summary:'Current verified human self/parent/guardian recipient plus scoped student and dated membership; no peer rosters or drafts',querySchema:receivedQuery},
 {path:'/api/v1/students/{id}/published-reports/{publicationId}',method:'get',summary:'Read active frozen report text/captions for eligible student; media identifiers/claims/private context omitted'}
] as const;

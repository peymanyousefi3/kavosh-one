import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { propose,master,lockApprovalWrites,type ApprovalRegistry,type Proposal } from '../core/approvals.ts';
import { ApiError,type Capability } from '../core/policy.ts';
import { classRow,sessionRow,sessionLocalDate } from './classes.ts';
import { lockAcademyTopology } from './academy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().min(1).max(2147483647);
const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0'));
const block=z.discriminatedUnion('kind',[
 z.object({id:uuid,kind:z.literal('text'),text:text.pipe(z.string().trim().min(1).max(10000))}).strict(),
 z.object({id:uuid,kind:z.literal('media'),fileId:uuid,fileVersion:version,mediaKind:z.enum(['image','video']),caption:text.max(2000).default('')}).strict()
]);
const document=z.object({title:text.pipe(z.string().trim().min(1).max(200)),locale:z.enum(['en','fr','zh-CN']),blocks:z.array(block).min(1).max(100)
 .refine(v=>new Set(v.map(b=>b.id)).size===v.length,'Duplicate block ID')
 .refine(v=>{const media=v.filter(b=>b.kind==='media');return media.length<=20&&new Set(media.map(b=>b.fileId)).size===media.length;},'At most twenty unique media files')}).strict();
const correction=z.object({expectedVersion:z.number().int().min(0).max(2147483647),sessionVersion:version,document,reason:text.pipe(z.string().trim().min(1).max(2000))}).strict();
export { document as sessionReportDocument };
const ownInput=correction.extend({assignmentId:uuid,assignmentVersion:version});
const historyQuery=z.object({limit:z.coerce.number().int().min(1).max(10).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict(),empty=z.object({}).strict();
type Document=z.infer<typeof document>;type Input=z.infer<typeof correction>;
interface Source {session:{id:string;classId:string;hubId:string;version:number;classVersion:number;classActive:boolean;status:string;startsAt:string;on:string;timeZone:string};media:Record<string,unknown>[]}
interface Report {session_id:string;class_id:string;hub_id:string;version:number;session_version:number;document:Document;context:Source;changed_by:string;approval_id:string|null;[key:string]:unknown}
const hasMedia=(d:Document)=>d.blocks.some(b=>b.kind==='media');
async function access(ctx:ApiContext,id:string,cap:Capability='session-reports.view',lock=false){const s=await sessionRow(ctx,id,cap,lock);if(cap!=='session-reports.view')await classRow(ctx,s.class_id,'session-reports.view');return s;}
async function fileAccess(ctx:ApiContext,classId:string,d:Document){if(hasMedia(d))await classRow(ctx,classId,'files.view');}
async function report(ctx:ApiContext,id:string){return(await ctx.db.query<{report:Report}>('SELECT to_jsonb(r) report FROM public.session_reports r WHERE session_id=$1',[id])).rows[0]?.report??null;}
async function source(ctx:ApiContext,id:string,d:Document){return(await ctx.db.query<{source:Source|null}>('SELECT public.session_report_source($1,$2::jsonb) source',[id,JSON.stringify(d)])).rows[0].source;}
function view(r:Report){return {...r,state:'draft',hasReportText:r.document.blocks.some(b=>b.kind==='text'),mediaReferenceCount:r.document.blocks.filter(b=>b.kind==='media').length,
 mediaContentVerified:false,mediaServingEnabled:false,publishedToParents:false,sessionEvidenceApproved:false,payrollApproved:false};}
async function basis(ctx:ApiContext,id:string,i:Input,cap:Capability){
 if(Buffer.byteLength(JSON.stringify(i.document),'utf8')>100000)throw new ApiError(413,'SESSION_REPORT_TOO_LARGE');
 const s=await access(ctx,id,cap,true),c=await classRow(ctx,s.class_id,cap),on=sessionLocalDate(s,c.time_zone),current=await report(ctx,id);
 if(current)await fileAccess(ctx,s.class_id,current.document);await fileAccess(ctx,s.class_id,i.document);
 if((current?.version??0)!==i.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');if(s.version!==i.sessionVersion)throw new ApiError(409,'SESSION_CHANGED');
 const actual=await source(ctx,id,i.document);if(!actual)throw new ApiError(409,'SESSION_REPORT_SOURCE_UNAVAILABLE');
 if(!(await ctx.db.query<{started:boolean}>('SELECT starts_at<=clock_timestamp() started FROM public.class_sessions WHERE id=$1',[id])).rows[0].started)throw new ApiError(409,'FUTURE_REPORT_FORBIDDEN');
 return {s,on,current,source:actual};
}
async function persist(ctx:ApiContext,id:string,i:Input,b:Awaited<ReturnType<typeof basis>>,assignment:{id:string;version:number}|null,approvalId:string|null){
 const params=[id,i.sessionVersion,JSON.stringify(i.document),JSON.stringify(b.source),ctx.credential.person_id,assignment?.id??null,assignment?.version??null,approvalId,i.reason];
 try{
  if(b.current)await ctx.db.query('UPDATE public.session_reports SET version=version+1,session_version=$2,document=$3::jsonb,context=$4::jsonb,changed_by=$5,assignment_id=$6,assignment_version=$7,approval_id=$8,reason=$9 WHERE session_id=$1',params);
  else await ctx.db.query('INSERT INTO public.session_reports(session_id,session_version,document,context,changed_by,assignment_id,assignment_version,approval_id,reason,academy_id,class_id,hub_id) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)',[...params,ctx.credential.academy_id,b.s.class_id,b.s.hub_id]);
 }catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'&&'message' in error&&/^REPORT_/.test(String(error.message)))throw new ApiError(409,'SESSION_REPORT_SOURCE_CHANGED');throw error;}
 const after=(await report(ctx,id))!;
 await ctx.db.query('INSERT INTO public.session_report_revisions(academy_id,session_id,version,definition) SELECT academy_id,session_id,version,to_jsonb(r) FROM public.session_reports r WHERE session_id=$1',[id]);
 await record(ctx.db,ctx.credential,ctx.requestId,approvalId?'session-report.correct':'session.report.recorded',id,b.s.hub_id,{version:after.version,hasReason:true,severity:approvalId?'critical':'notification',payrollApproved:false,publishedToParents:false});return view(after);
}
export const sessionReportActions:ApprovalRegistry={'session-report.correct':{
 requestCapability:'session-reports.edit',privacyCapability:'session-reports.view',
 async validate(ctx,id,raw){await lockAcademyTopology(ctx);const b=await basis(ctx,id,correction.parse(raw),'session-reports.edit');return {all:false,hubs:[],classes:[{id:b.s.class_id,hubId:b.s.hub_id}]};},
 async dependencies(ctx,id,raw,purpose){try{const b=await basis(ctx,id,correction.parse(raw),'session-reports.edit');return {report:b.current,source:b.source};}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx,p){if(await master(ctx))return;const before=await report(ctx,p.target_id);if(before?.changed_by===ctx.credential.person_id)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');},
 async apply(ctx,p:Proposal){if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const i=correction.parse(p.payload),b=await basis(ctx,p.target_id,i,'session-reports.edit');return persist(ctx,p.target_id,i,b,null,p.id);}
}};
export async function sessionReports(ctx:ApiContext,registry:ApprovalRegistry=sessionReportActions):Promise<Reply|null>{
 const path=/^sessions\/([^/]+)\/report(?:\/(history|change))?$/.exec(ctx.path);if(!path)return null;
 const id=uuid.parse(path[1]),section=path[2],method=ctx.request.method,params=Object.fromEntries(new URL(ctx.request.url).searchParams);
 if(method==='POST'){
  empty.parse(params);if(section==='change'){const i=correction.parse(await jsonBody(ctx.request,131072));return propose(ctx,registry,'session-report.correct',id,i.expectedVersion,i);}
  if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_STAFF_RECORD_REQUIRED');const i=ownInput.parse(await jsonBody(ctx.request,131072));
  await lockApprovalWrites(ctx);await lockAcademyTopology(ctx);const selected=await access(ctx,id,'session-reports.record'),old=await report(ctx,id);
  if(old)await fileAccess(ctx,selected.class_id,old.document);await fileAccess(ctx,selected.class_id,i.document);
  return mutation(ctx,i,async()=>{
   const b=await basis(ctx,id,i,'session-reports.record');if(b.s.status!=='scheduled'||!b.source.session.classActive)throw new ApiError(409,'INACTIVE_SESSION_REPORT_REQUIRES_REVIEW');
   const a=(await ctx.db.query<{id:string;version:number}>('SELECT id,version FROM public.class_staff WHERE id=$1 AND class_id=$2 AND person_id=$3 AND active AND starts_on<=$4::date AND(ends_on IS NULL OR ends_on>=$4::date) FOR SHARE',[i.assignmentId,b.s.class_id,ctx.credential.person_id,b.on])).rows[0];if(!a||a.version!==i.assignmentVersion)throw new ApiError(409,'STAFF_ASSIGNMENT_CHANGED');
   const data=await persist(ctx,id,i,b,a,null);return {status:b.current?200:201,body:{data}};
  });
 }
 if(method!=='GET'||section==='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const s=await access(ctx,id);
 if(section==='history'){
  const q=historyQuery.parse(params);let filesAllowed=true;try{await classRow(ctx,s.class_id,'files.view');}catch(error){if(error instanceof ApiError&&[403,404].includes(error.status))filesAllowed=false;else throw error;}
  // Every permitted media anchor is this same immutable class/general domain.
  // Filter private media revisions BEFORE pagination, including removed media.
  const rows=(await ctx.db.query<{version:number;definition:Report}>(`SELECT version,definition,recorded_at FROM public.session_report_revisions WHERE session_id=$1 AND version>$2
   AND($4::boolean OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(definition#>'{document,blocks}') b WHERE b->>'kind'='media')) ORDER BY version LIMIT $3`,[id,q.afterVersion,q.limit+1,filesAllowed])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit).map(r=>({...r,definition:view(r.definition)})),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};
 }
 empty.parse(params);const current=await report(ctx,id);if(!current)return {status:200,body:{data:null,publishedToParents:false,payrollApproved:false}};
 await fileAccess(ctx,s.class_id,current.document);const actual=await source(ctx,id,current.document);
 return {status:200,body:{data:view(current),recordedSourcesCurrent:actual?(await ctx.db.query<{current:boolean}>('SELECT $1::jsonb=$2::jsonb current',[JSON.stringify(current.context),JSON.stringify(actual)])).rows[0].current:false}};
}
export const sessionReportsContract=[
 {path:'/api/v1/sessions/{id}/report',method:'get',summary:'Read private shared report draft; pinned media claims are not uploaded, scanned, served or published evidence'},
 {path:'/api/v1/sessions/{id}/report',method:'post',summary:'Assigned human saves one shared versioned text/media draft; no parent publication or payroll approval',schema:ownInput},
 {path:'/api/v1/sessions/{id}/report/history',method:'get',summary:'Immutable report drafts; current class/file permission filtering before bounded version paging',querySchema:historyQuery},
 {path:'/api/v1/sessions/{id}/report/change',method:'post',summary:'Upper-reviewed initial draft or correction with exact current source and removed-media privacy bindings',schema:correction}
] as const;

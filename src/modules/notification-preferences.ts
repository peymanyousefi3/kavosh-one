import { z } from 'zod';
import { jsonBody,mutation,record,type ApiContext,type Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';

const expectedVersion=z.number().int().min(0).max(2147483646);
const change=z.object({expectedVersion,emailEnabled:z.boolean(),smsEnabled:z.boolean(),locale:z.enum(['en','fr','zh-CN']),acknowledgedNoticeVersion:z.literal(1)}).strict();
const disable=z.object({expectedVersion}).strict();
const paging=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),beforeVersion:z.coerce.number().int().positive().max(2147483647).optional()}).strict();
const notice={version:1,purpose:'operational_academy_notifications',text:'Choose whether to receive operational academy notices at your current verified email address and phone number. You can disable either channel at any time. Carrier messaging charges may apply. Critical portal notices and authentication/security verification remain separate. This is not marketing consent.'};
type Identity={ownerEpoch:string;emailEpoch:string;phoneEpoch:string};
type Preference={version:number;email_enabled:boolean;sms_enabled:boolean;locale:'en'|'fr'|'zh-CN';email_epoch:string|null;phone_epoch:string|null;notice_version:1;changed_at:string};
function view(p:Preference|undefined,i:Identity){return {version:p?.version??0,locale:p?.locale??'en',email:{enabled:p?.email_enabled??false,effective:!!p?.email_enabled&&p.email_epoch===i.emailEpoch,renewalRequired:!!p?.email_enabled&&p.email_epoch!==i.emailEpoch},sms:{enabled:p?.sms_enabled??false,effective:!!p?.sms_enabled&&p.phone_epoch===i.phoneEpoch,renewalRequired:!!p?.sms_enabled&&p.phone_epoch!==i.phoneEpoch},changedAt:p?.changed_at??null};}
const flags={selfOnly:true,portalNoticesMandatory:true,authenticationDeliveryAffected:false,marketingConsentGranted:false,externalDeliveryEnabled:false,externalDeliveryVerified:false,alreadyInFlightMessagesMayStillArrive:true};
export async function notificationPreferences(ctx:ApiContext):Promise<Reply|null>{
 const m=/^me\/notification-preferences(?:\/(history|disable))?$/.exec(ctx.path);if(!m)return null;
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_ACCOUNT_REQUIRED');
 const action=m[1];if(action==='history'?ctx.request.method!=='GET':action==='disable'?ctx.request.method!=='POST':!['GET','POST'].includes(ctx.request.method))throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const params=new URL(ctx.request.url).searchParams;if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const q=action==='history'?paging.parse(Object.fromEntries(params)):(z.object({}).strict().parse(Object.fromEntries(params)),null);
 const {db,credential:c}=ctx,identity=(await db.query<{identity:Identity|null}>('SELECT public.notification_preference_identity($1,$2) identity',[c.person_id,c.token_id])).rows[0]?.identity;
 if(!identity)throw new ApiError(401,'UNAUTHORIZED');
 if(action==='history'){
  const rows=(await db.query<{version:number;emailEnabled:boolean;smsEnabled:boolean;locale:string;noticeVersion:number;changedAt:string}>(`SELECT version,(definition->>'email_enabled')::boolean "emailEnabled",(definition->>'sms_enabled')::boolean "smsEnabled",definition->>'locale' locale,(definition->>'notice_version')::integer "noticeVersion",definition->>'changed_at' "changedAt" FROM public.notification_preference_revisions WHERE person_id=$1 AND owner_epoch=$2 AND($3::integer IS NULL OR version<$3) ORDER BY version DESC LIMIT $4`,[c.person_id,identity.ownerEpoch,q!.beforeVersion??null,q!.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q!.limit),nextCursor:rows.length>q!.limit?rows[q!.limit-1].version:null,...flags}};
 }
 if(ctx.request.method==='GET'){
  const p=(await db.query<Preference>('SELECT * FROM public.notification_preferences WHERE person_id=$1 AND owner_epoch=$2',[c.person_id,identity.ownerEpoch])).rows[0];return {status:200,body:{data:view(p,identity),notice,...flags}};
 }
 const raw=await jsonBody(ctx.request),input=action==='disable'?{kind:'disable' as const,...disable.parse(raw)}:{kind:'change' as const,...change.parse(raw)};
 return mutation(ctx,input,async()=>{
  const old=(await db.query<Preference>('SELECT * FROM public.notification_preferences WHERE person_id=$1 AND owner_epoch=$2 FOR UPDATE',[c.person_id,identity.ownerEpoch])).rows[0];
  if((old?.version??0)!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
  const next=input.kind==='change'?input:{emailEnabled:false,smsEnabled:false,locale:old?.locale??'en'};
  const values=[c.academy_id,c.person_id,identity.ownerEpoch,(old?.version??0)+1,next.emailEnabled,next.smsEnabled,next.locale,next.emailEnabled?identity.emailEpoch:null,next.smsEnabled?identity.phoneEpoch:null];
  const p=(await db.query<Preference>(old?`UPDATE public.notification_preferences SET version=$4,email_enabled=$5,sms_enabled=$6,locale=$7,email_epoch=$8,phone_epoch=$9 WHERE academy_id=$1 AND person_id=$2 AND owner_epoch=$3 AND version=$4-1 RETURNING *`:`INSERT INTO public.notification_preferences(academy_id,person_id,owner_epoch,version,email_enabled,sms_enabled,locale,email_epoch,phone_epoch,notice_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1) ON CONFLICT DO NOTHING RETURNING *`,values)).rows[0];
  if(!p)throw new ApiError(409,'TARGET_CHANGED');
  await db.query('INSERT INTO public.notification_preference_revisions SELECT academy_id,person_id,owner_epoch,version,to_jsonb(p) FROM public.notification_preferences p WHERE person_id=$1 AND owner_epoch=$2',[c.person_id,identity.ownerEpoch]);
  const hash=(await db.query<{hash:string}>("SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') hash FROM public.notification_preferences p WHERE person_id=$1 AND owner_epoch=$2",[c.person_id,identity.ownerEpoch])).rows[0].hash;
  await record(db,c,ctx.requestId,'notification-preferences.changed',c.person_id,null,{version:p.version,revisionSha256:hash,operationalOnly:true,externalDeliveryEnabled:false});
  return {status:old?200:201,body:{data:view(p,identity),notice,...flags}};
 },async reply=>{
  const receipt=z.object({data:z.object({version:z.number().int().positive()})}).parse(reply.body),current=(await db.query<Preference>('SELECT * FROM public.notification_preferences WHERE person_id=$1 AND owner_epoch=$2',[c.person_id,identity.ownerEpoch])).rows[0];
  if(!current||current.version!==receipt.data.version||(current.email_enabled&&current.email_epoch!==identity.emailEpoch)||(current.sms_enabled&&current.phone_epoch!==identity.phoneEpoch))throw new ApiError(409,'PREFERENCE_RECEIPT_SUPERSEDED');
 });
}
export const notificationPreferencesContract=[
 {path:'/api/v1/me/notification-preferences',method:'get',humanOnly:true,summary:'Own operational email/SMS preferences;default off,mandatory portal/security notices unchanged. Effective choices are bound to current verified contact generations;replacement identities do not inherit history. No contact values,marketing consent or actual external delivery.'},
 {path:'/api/v1/me/notification-preferences',method:'post',humanOnly:true,summary:'Explicit versioned self-only operational channel choices with notice acknowledgement,exact immutable history and human-session audit/outbox. Neither administrator nor bot may opt in another person. Contact changes require renewed choice;no provider send or marketing consent.',schema:change},
 {path:'/api/v1/me/notification-preferences/disable',method:'post',humanOnly:true,summary:'Disable both optional external channels with exact version and idempotency,including read-only academies. Cannot enable a channel or suppress critical portal/authentication delivery.',schema:disable},
 {path:'/api/v1/me/notification-preferences/history',method:'get',humanOnly:true,summary:'Own current-identity preference history only,bounded newest-first;no identity/contact-generation tokens or another user history.',querySchema:paging}
] as const;

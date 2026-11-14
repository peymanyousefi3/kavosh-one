import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { master,permissionScope } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const paging=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),afterOccurredAt:z.iso.datetime({offset:true}).optional(),afterId:uuid.optional(),field:z.enum(['email','phone']).optional()}).strict().refine(v=>(v.afterOccurredAt===undefined)===(v.afterId===undefined));
const empty=z.object({}).strict();
type Event={id:string;personId:string;field:'email'|'phone';occurredAt:string;publishedAt:string};
function view(e:Event){return {...e,actorAttributed:false,contactValuesIncluded:false,source:'native_contact_change',externalDeliveryVerified:false};}
export async function accountSecurity(ctx:ApiContext):Promise<Reply|null>{
 const m=/^(?:people\/([^/]+)|me)\/account-security(?:\/([^/]+))?$/.exec(ctx.path);if(!m)return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 if(!m[1]&&ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_ACCOUNT_REQUIRED');
 const personId=m[1]?uuid.parse(m[1]):ctx.credential.person_id,id=m[2]?uuid.parse(m[2]):null,params=new URL(ctx.request.url).searchParams;
 if([...params].length!==new Set(params.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
 const q=id?(empty.parse(Object.fromEntries(params)),null):paging.parse(Object.fromEntries(params));
 const person=(await ctx.db.query<{id:string;hub_id:string|null}>("SELECT id,hub_id FROM public.people WHERE id=$1 AND kind='human'",[personId])).rows[0];if(!person)throw new ApiError(404,'NOT_FOUND');
 const scope=permissionScope(ctx,'account-security.view'),own=ctx.credential.kind==='human'&&personId===ctx.credential.person_id;
 if(!own&&!await master(ctx)&&!(await ctx.db.query<{ok:boolean}>('SELECT public.work_scope_allows($1::jsonb,$2,$3) ok',[JSON.stringify(scope),person.hub_id,personId])).rows[0]?.ok)throw new ApiError(404,'NOT_FOUND');
 const fields=`id,person_id "personId",field,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "occurredAt",to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "publishedAt"`;
 const predicate=`FROM public.account_security_events WHERE person_id=$1 AND public.account_security_notice_allows(id,$2,$3::jsonb)`;
 if(id){const row=(await ctx.db.query<Event>('SELECT '+fields+' '+predicate+' AND id=$4',[personId,ctx.credential.person_id,JSON.stringify(scope),id])).rows[0];if(!row)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:view(row)}};}
 const rows=(await ctx.db.query<Event>('SELECT '+fields+' '+predicate+` AND($4::timestamptz IS NULL OR(occurred_at,id)<($4::timestamptz,$5::uuid)) AND($6::text IS NULL OR field=$6) ORDER BY occurred_at DESC,id DESC LIMIT $7`,[personId,ctx.credential.person_id,JSON.stringify(scope),q!.afterOccurredAt??null,q!.afterId??null,q!.field??null,q!.limit+1])).rows,tail=rows[q!.limit-1];
 return {status:200,body:{data:rows.slice(0,q!.limit).map(view),nextCursor:rows.length>q!.limit?{afterOccurredAt:tail.occurredAt,afterId:tail.id}:null,contactValuesIncluded:false,publication:'background_worker',workerLiveness:'not_observed'}};
}
export const accountSecurityContract=[
 {path:'/api/v1/people/{id}/account-security',method:'get',summary:'Own or explicitly scoped account-security metadata;current human/master/finite bot permissions filter native email/phone-change history before paging. No old/new contacts,identity IDs or claimed operator attribution.',querySchema:paging},
 {path:'/api/v1/people/{id}/account-security/{eventId}',method:'get',summary:'Read one currently authorized native account-change observation linked from the existing notification centre;not an approval or reversal.',querySchema:empty},
 {path:'/api/v1/me/account-security',method:'get',humanOnly:true,summary:'Current verified human account contact-change history in this academy;implicit self access does not expose another identity previously attached to this person.',querySchema:paging},
 {path:'/api/v1/me/account-security/{eventId}',method:'get',humanOnly:true,summary:'Read own current-authorized account-security record without access to private authentication tables.',querySchema:empty}
] as const;

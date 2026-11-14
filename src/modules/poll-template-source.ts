import type { ApiContext } from '../core/api.ts';
import { permissionScope } from '../core/approvals.ts';
import { ApiError,scopeContains,type Capability } from '../core/policy.ts';
import { pollOwnerScope,type pollAnchor,type PollDefinition } from './poll-definition.ts';
import type { z } from 'zod';

export type PollTemplate={id:string;anchor:z.infer<typeof pollAnchor>;hub_id:string|null;class_id:string|null;version:number;active:boolean;definition:PollDefinition;response_unit:'student_family'|'guardian_per_student';respondent_mode:'guardians'|'students'|'both';[key:string]:unknown};
export function pollTemplateAuthority(ctx:ApiContext,t:Pick<PollTemplate,'anchor'|'hub_id'>,edit=false){for(const cap of ['poll-templates.view',...edit?['poll-templates.edit']:[]] as Capability[])if(!scopeContains(permissionScope(ctx,cap),pollOwnerScope(t.anchor,t.hub_id)))throw new ApiError(404,'NOT_FOUND');}
export async function pollTemplate(ctx:ApiContext,id:string,edit=false){const t=(await ctx.db.query<{template:PollTemplate}>('SELECT to_jsonb(t) template FROM public.poll_templates t WHERE id=$1',[id])).rows[0]?.template;if(!t)throw new ApiError(404,'NOT_FOUND');pollTemplateAuthority(ctx,t,edit);return t;}
export async function pollTemplatePollSource(ctx:ApiContext,ref:{id:string;version:number}){await pollTemplate(ctx,ref.id);const s=(await ctx.db.query<{source:{definition:PollDefinition;responseUnit:string;respondentMode:string}|null}>('SELECT public.poll_template_poll_source($1,$2) source',[ref.id,ref.version])).rows[0].source;if(!s)throw new ApiError(409,'POLL_TEMPLATE_SOURCE_CHANGED');return s;}

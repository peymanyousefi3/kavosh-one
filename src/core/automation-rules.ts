import { z } from 'zod';
import { ApiError } from './policy.ts';

const text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),uuid=z.string().uuid().transform(v=>v.toLowerCase());
const scalar=z.union([text.max(2000),z.number().finite(),z.boolean(),z.null()]);
const forbidden=new Set(['__proto__','prototype','constructor']);
const field=text.max(200).refine(v=>/^(eventType|entityId|hubId|actorId|actorKind|severity|occurredAt|attributes(?:\.[A-Za-z0-9_-]+){1,7})$/.test(v)&&v.split('.').every(s=>!forbidden.has(s)));
export const conditionOperators=['eq','neq','in','not_in','exists','missing','contains','starts_with','ends_with','decimal_eq','decimal_gt','decimal_gte','decimal_lt','decimal_lte','before','after'] as const;
type Scalar=z.infer<typeof scalar>;
type Leaf={op:typeof conditionOperators[number];field:string;value?:Scalar|Scalar[]};
export type RuleCondition=Leaf|{op:'all'|'any';conditions:RuleCondition[]}|{op:'not';condition:RuleCondition};
const leaf=z.object({op:z.enum(conditionOperators),field,value:z.union([scalar,z.array(scalar).min(1).max(100)]).optional()}).strict();
const decimal=/^-?\d+(?:\.\d{1,18})?$/;
const instant=z.iso.datetime({offset:true}).max(40).refine(v=>!v.startsWith('0000-')&&!/[.]\d{4}/.test(v)&&!/[+-](1[6-9]|2[0-3]):\d{2}$/.test(v)&&Number.isFinite(Date.parse(v)));
function failure():never{throw new ApiError(400,'INVALID_RULE_CONDITION');}
export function parseCondition(raw:unknown):RuleCondition{
 // Validate breadth/depth before recursive schema/evaluation work. No regex,
 // script, SQL, eval, external lookup or user code is ever executed.
 const stack=[{v:raw,depth:1}],seen=new Set<object>();let nodes=0;
 while(stack.length){const {v,depth}=stack.pop()!;if(++nodes>200||depth>8||!v||typeof v!=='object'||Array.isArray(v)||seen.has(v))failure();seen.add(v);
  const op=(v as {op?:unknown}).op;
  if(op==='all'||op==='any'){const p=z.object({op:z.enum(['all','any']),conditions:z.array(z.unknown()).min(1).max(32)}).strict().safeParse(v);if(!p.success)failure();stack.push(...p.data.conditions.map(v=>({v,depth:depth+1})));}
  else if(op==='not'){const p=z.object({op:z.literal('not'),condition:z.unknown()}).strict().safeParse(v);if(!p.success||!Object.hasOwn(v,'condition'))failure();stack.push({v:p.data.condition,depth:depth+1});}
  else{const p=leaf.safeParse(v);if(!p.success)failure();const {op,value}=p.data;
   if(op==='exists'||op==='missing'){if(Object.hasOwn(v,'value'))failure();}
   else if(value===undefined)failure();
   else if(op==='in'||op==='not_in'){if(!Array.isArray(value))failure();}
   else if(Array.isArray(value))failure();
   else if(op.startsWith('decimal_')){if(typeof value!=='string'||value.length>80||!decimal.test(value))failure();}
   else if(op==='before'||op==='after'){if(!instant.safeParse(value).success)failure();}
   else if(['contains','starts_with','ends_with'].includes(op)&&typeof value!=='string')failure();
  }
 }
 if(Buffer.byteLength(JSON.stringify(raw),'utf8')>16000)throw new ApiError(400,'RULE_CONDITION_TOO_LARGE');
 return raw as RuleCondition;
}
export const conditionInput=z.unknown().transform(parseCondition).describe('Bounded condition AST: all/any/not or an operator+field+value leaf; at most 200 nodes, depth 8. Decimal operands are exact strings. Missing/type-invalid comparison inputs stay unknown, including under NOT.');
function attributes(raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ApiError(400,'INVALID_RULE_SAMPLE');const stack=[{v:raw,depth:0}],seen=new Set<object>();let count=0;
 while(stack.length){const {v,depth}=stack.pop()!;if(++count>1000||depth>8)throw new ApiError(400,'RULE_SAMPLE_TOO_LARGE');if(v&&typeof v==='object'){if(seen.has(v))throw new ApiError(400,'INVALID_RULE_SAMPLE');seen.add(v);const entries=Object.entries(v);if(entries.length>100||entries.some(([k])=>forbidden.has(k)))throw new ApiError(400,'INVALID_RULE_SAMPLE');stack.push(...entries.map(([,v])=>({v,depth:depth+1})));}else if(!scalar.safeParse(v).success)throw new ApiError(400,'INVALID_RULE_SAMPLE');}
 return raw as Record<string,unknown>;
}
export const ruleSample=z.object({eventType:text.regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/).max(160),entityId:uuid,hubId:uuid.nullable(),actorId:uuid.nullable(),actorKind:z.enum(['human','bot','system']),severity:z.enum(['normal','critical']),occurredAt:instant,attributes:z.unknown().default({}).transform(attributes)}).strict();
export type RuleSample=z.infer<typeof ruleSample>;
function lookup(sample:RuleSample,path:string){let v:unknown=sample;for(const k of path.split('.')){if(!v||typeof v!=='object'||!Object.hasOwn(v,k))return {exists:false,value:undefined};v=(v as Record<string,unknown>)[k];}return {exists:true,value:v};}
function decimalParts(v:string){const negative=v.startsWith('-'),[whole,fraction='']=(negative?v.slice(1):v).split('.');return {n:BigInt(whole+fraction)*(negative?-1n:1n),scale:fraction.length};}
function compareDecimal(a:string,b:string){const x=decimalParts(a),y=decimalParts(b),scale=Math.max(x.scale,y.scale),left=x.n*10n**BigInt(scale-x.scale),right=y.n*10n**BigInt(scale-y.scale);return left<right?-1:left>right?1:0;}
export function evaluateCondition(raw:unknown,input:unknown){const root=parseCondition(raw),sample=ruleSample.parse(input),unknownFields=new Set<string>();
 const evaluate=(node:RuleCondition):boolean|null=>{
  if(node.op==='not'){const result=evaluate(node.condition);return result===null?null:!result;}
  if(node.op==='all'||node.op==='any'){const results=node.conditions.map(evaluate);return node.op==='all'?results.includes(false)?false:results.includes(null)?null:true:results.includes(true)?true:results.includes(null)?null:false;}
  const n=node as Leaf,{exists,value}=lookup(sample,n.field);if(n.op==='exists')return exists;if(n.op==='missing')return !exists;
  const unknown=()=>{unknownFields.add(n.field);return null;};if(!exists||!scalar.safeParse(value).success)return unknown();
  if(n.op==='eq')return value===n.value;if(n.op==='neq')return value!==n.value;
  if(n.op==='in'||n.op==='not_in'){const found=(n.value as Scalar[]).some(v=>v===value);return n.op==='in'?found:!found;}
  if(n.op.startsWith('decimal_')){if(typeof value!=='string'||value.length>80||!decimal.test(value))return unknown();const c=compareDecimal(value,n.value as string);return n.op==='decimal_eq'?c===0:n.op==='decimal_gt'?c>0:n.op==='decimal_gte'?c>=0:n.op==='decimal_lt'?c<0:c<=0;}
  if(n.op==='before'||n.op==='after'){if(!instant.safeParse(value).success)return unknown();return n.op==='before'?Date.parse(value as string)<Date.parse(n.value as string):Date.parse(value as string)>Date.parse(n.value as string);}
  if(typeof value!=='string')return unknown();return n.op==='contains'?value.includes(n.value as string):n.op==='starts_with'?value.startsWith(n.value as string):value.endsWith(n.value as string);
 };
 const result=evaluate(root);return {matched:result===true,result:result===null?'unknown':result?'true':'false',unknownFields:[...unknownFields].sort()};
}
const tokens=['eventType','entityId','hubId','actorId','actorKind','severity','occurredAt'] as const;
function validTemplate(v:string){const rest=v.replace(/{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g,(_m,k:string)=>tokens.includes(k as typeof tokens[number])?'':'{{invalid}}');return !rest.includes('{{')&&!rest.includes('}}');}
const template=(max:number)=>text.min(1).max(max).refine(v=>v.trim().length>0&&(max!==200||!/[\r\n]/.test(v))).refine(validTemplate,'Only registered envelope tokens are allowed; templates are plain text, never scripts or HTML.');
const localized=(max:number)=>z.object({en:template(max),fr:template(max).optional(),'zh-CN':template(max).optional()}).strict();
const audience=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('school_master')}).strict(),z.object({kind:z.literal('actor_supervisors')}).strict(),
 z.object({kind:z.literal('session_guardians')}).strict(),z.object({kind:z.literal('session_staff')}).strict(),
 z.object({kind:z.literal('people'),personIds:z.array(uuid).min(1).max(100).refine(v=>new Set(v).size===v.length)}).strict()
]);
const action=z.object({kind:z.literal('notify'),channels:z.array(z.enum(['portal','email','sms'])).min(1).max(3).refine(v=>new Set(v).size===v.length),audience,severity:z.enum(['inherit','normal','critical']).default('inherit'),title:localized(200),body:localized(2000)}).strict();
export const automationDefinition=z.object({name:text.trim().min(1).max(200),enabled:z.boolean().default(false),startsAt:instant.nullable().default(null),endsAt:instant.nullable().default(null),
 sessionReminder:z.object({minutesBefore:z.number().int().min(1).max(43200),maxDelayMinutes:z.number().int().min(1).max(1440)}).strict().optional(),
 trigger:z.object({kind:z.literal('domain_event'),eventTypes:z.array(text.max(160).refine(v=>v==='*'||/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(v)||/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*\.\*$/.test(v))).min(1).max(50).refine(v=>new Set(v).size===v.length)}).strict(),condition:conditionInput,actions:z.array(action).min(1).max(10),
 execution:z.object({mode:z.enum(['dry_run','approval_required','automatic']).default('dry_run'),maxRecipientsPerEvent:z.number().int().min(1).max(1000).default(100),maxDailyDeliveries:z.number().int().min(1).max(10000).default(100),maxDailySms:z.number().int().min(0).max(1000).default(0),cooldownSeconds:z.number().int().min(0).max(604800).default(0),maxChainDepth:z.number().int().min(1).max(3).default(1)}).strict().default({mode:'dry_run',maxRecipientsPerEvent:100,maxDailyDeliveries:100,maxDailySms:0,cooldownSeconds:0,maxChainDepth:1})
}).strict().refine(v=>v.startsAt===null||v.endsAt===null||Date.parse(v.endsAt)>=Date.parse(v.startsAt));
export type AutomationDefinition=z.infer<typeof automationDefinition>;
export function simulateRule(definition:AutomationDefinition,hubId:string|null,sample:RuleSample,locale:'en'|'fr'|'zh-CN'='en'){
 const triggerMatched=(hubId===null||sample.hubId===hubId)&&definition.trigger.eventTypes.some(t=>t==='*'||t===sample.eventType||(t.endsWith('.*')&&sample.eventType.startsWith(t.slice(0,-1))));
 const windowMatched=(definition.startsAt===null||Date.parse(sample.occurredAt)>=Date.parse(definition.startsAt))&&(definition.endsAt===null||Date.parse(sample.occurredAt)<=Date.parse(definition.endsAt));
 const condition=evaluateCondition(definition.condition,sample),render=(labels:Record<string,string|undefined>)=>(labels[locale]??labels.en!).replace(/{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g,(_m,k:string)=>String(sample[k as keyof RuleSample]??''));
 return {configurationEnabled:definition.enabled,triggerMatched,windowMatched,condition,eligibleByConfiguration:definition.enabled&&triggerMatched&&windowMatched&&condition.matched,
  actions:definition.actions.map(a=>({kind:a.kind,channels:a.channels,audience:a.audience,effectiveSeverity:sample.severity==='critical'||a.severity==='critical'?'critical':a.severity==='normal'?'normal':sample.severity,title:render(a.title),body:render(a.body),contentType:'text/plain'})),execution:definition.execution,
  sampleSource:'caller_supplied_unverified',recipientSelectionResolved:false,recipientAuthorizationChecked:false,budgetsConsumed:false,workerActive:false,queued:false,delivered:false,externalRequestMade:false};
}
export const automationLanguage={reportJobIssues:{sourceKind:'report_job',eventTypes:['report-job.failed','report-job.cancelled'],conditionFields:['attributes.status','attributes.reasonCode'],sourceVerification:'native_terminal_report_job_state_not_owner_action',observationTimeIsNotReconstructedFailureTime:true,mandatoryPortalFloor:true,intentionalCancellationIsNotFailure:true,access:'same_owner_or_school_master_with_current_report_rights'},reportScheduleIssues:{sourceKind:'report_schedule',eventTypes:['report-schedule.paused','report-schedule.attempts_exhausted'],conditionFields:['attributes.reasonCode','attributes.scheduleVersion','attributes.controlVersion'],sourceVerification:'current_native_scheduler_state_not_owner_action',mandatoryPortalFloor:true,customRulesRequireCurrentIssue:true,observationTimeIsNotReconstructedFailureTime:true},sessionReminders:{eventType:'session.reminder_due',timing:'elapsed_minutes_before_actual_session_start',minutesBefore:{min:1,max:43200},maxDelayMinutes:{min:1,max:1440},deliveryStopsAt:'earlier_of_session_start_or_late_window_end',requiresApprovedActiveWatcher:true,presets:[{code:'PARENT_24_HOURS',sessionReminder:{minutesBefore:1440,maxDelayMinutes:120},audience:{kind:'session_guardians'}},{code:'TEACHER_ONE_HOUR',sessionReminder:{minutesBefore:60,maxDelayMinutes:30},audience:{kind:'session_staff'}}],presetsAreConfigurationFragments:true},conditionOperators,logicalOperators:['all','any','not'],maximumNodes:200,maximumDepth:8,maximumConditionBytes:16000,comparisonMissingBehavior:'unknown_even_under_not',decimalFormat:'signed_decimal_string_max80chars_max18fraction_digits_no_exponents',templateTokens:tokens,templateContentType:'text/plain',registeredActionKinds:['notify'],registeredTriggerKinds:['domain_event'],autonomousEventFanoutEnabled:false,workerLiveness:'not_observed'};

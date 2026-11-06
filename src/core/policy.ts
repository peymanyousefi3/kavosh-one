export const capabilities = ['hubs.view', 'hubs.edit', 'people.view', 'people.edit', 'audit.view', 'credentials.revoke', 'signature-dispatch.execute'] as const;
export type Capability = 'received-calendar.view' | 'work-files.view' | 'work-files.edit' | 'work-files.upload' | 'work-signatures.view' | 'work-signatures.edit' | 'business-calendars.view' | 'business-calendars.edit' | 'payruns.view' | 'payruns.edit' | typeof capabilities[number] | 'tuition-sessions.view' | 'tuition-sessions.edit' | 'payroll-accruals.view' | 'payroll-accruals.edit' | 'payroll-adjustments.view' | 'payroll-adjustments.edit' | 'payroll-preparations.view' | 'payroll-preparations.edit' | 'pay-periods.view' | 'pay-periods.edit' | 'financial-outlook.view' | 'expense-commitment-links.view' | 'expense-commitment-links.edit' | 'expense-commitments.view' | 'expense-commitments.edit' | 'payables-reports.view' | 'receivables-reports.view' | 'session-staff-feedback.view' | 'session-evidence.view' | 'session-evidence.edit' | 'session-evidence.override' | 'poll-templates.view' | 'poll-templates.edit' | 'poll-responses.moderate' | 'poll-results.view' | 'received-polls.respond' | 'poll-responses.view' | 'polls.view' | 'polls.edit' | 'polls.publish' | 'poll-recipients.view' | 'received-polls.view' | 'report-comments.view' | 'report-comments.write' | 'report-comments.moderate' | 'received-comments.view' | 'received-comments.write' | 'homework-solutions.view' | 'homework-solutions.record' | 'homework-solutions.edit' | 'homework-solutions.publish' | 'received-solutions.view' | 'homework-grades.view' | 'homework-grades.record' | 'homework-grades.edit' | 'homework-grades.publish' | 'received-grades.view' | 'homework-submissions.view' | 'homework-submissions.drafts' | 'homework-submissions.submit' | 'received-submissions.view' | 'received-submissions.drafts' | 'homeworks.view' | 'homeworks.record' | 'homeworks.edit' | 'homeworks.publish' | 'homework-recipients.view' | 'received-homework.view' | 'student-feedback.view' | 'student-feedback.record' | 'student-feedback.edit' | 'student-feedback.publish' | 'assessment-rubrics.view' | 'assessment-rubrics.edit' | 'report-publications.view' | 'report-publications.edit' | 'report-publications.override' | 'received-reports.view' | 'session-reports.view' | 'session-reports.record' | 'session-reports.edit' | 'attendance.view' | 'attendance.record' | 'attendance.edit' | 'signature-sends.view' | 'signature-sends.edit' | 'signature-sends.execute' | 'bank-reconciliations.view' | 'bank-reconciliations.edit' | 'roles.view' | 'roles.edit' | 'access.view' | 'access.edit' | 'approvals.view' | 'approvals.review' | 'locations.view' | 'locations.edit' | 'courses.view' | 'courses.edit' | 'classes.view' | 'classes.edit' | 'sessions.request' | 'staff.view' | 'staff.edit' | 'students.view' | 'students.edit' | 'guardians.view' | 'guardians.edit' | 'families.view' | 'families.edit' | 'registrations.view' | 'enrollments.view' | 'enrollments.edit' | 'rosters.view' | 'agreements.view' | 'agreements.edit' | 'signatures.view' | 'signatures.edit' | 'files.view' | 'files.edit' | 'files.upload' | 'storage.view' | 'storage.edit' | 'currencies.view' | 'currencies.edit' | 'accounts.view' | 'accounts.edit' | 'periods.view' | 'periods.edit' | 'journals.view' | 'journals.edit' | 'ledger.view' | 'financial-reports.view' | 'closing.view' | 'closing.edit' | 'tax-codes.view' | 'tax-codes.edit' | 'payment-methods.view' | 'payment-methods.edit' | 'tuition.view' | 'tuition.edit' | 'invoices.view' | 'invoices.edit' | 'invoice-issuers.view' | 'invoice-issuers.edit' | 'collectors.view' | 'collectors.edit' | 'receipts.view' | 'receipts.edit' | 'allocations.view' | 'allocations.edit' | 'remittances.view' | 'remittances.edit' | 'financial-files.view' | 'financial-files.edit' | 'payees.view' | 'payees.edit' | 'share-rules.view' | 'share-rules.edit' | 'bank-matches.view' | 'bank-matches.edit' | 'bank-statements.view' | 'bank-statements.edit' | 'bank-balances.view' | 'bank-balances.edit' | 'transfers.view' | 'transfers.edit' | 'expenses.view' | 'expenses.edit' | 'expense-payments.view' | 'expense-payments.edit' | 'session-time.record' | 'session-time.view' | 'session-time.edit' | 'inventory.view' | 'inventory.edit' | 'inventory-reports.view' | 'work-pay.view' | 'work-pay.edit' | 'automations.view' | 'automations.edit' | 'automations.execute';
export interface ResourceRef {id:string;hubId:string|null}
export interface AreaRef {kind:'country'|'region'|'city';id:string;countryId:string;regionId:string|null;cityId:string|null}
export interface Grant { capability: Capability; effect: 'allow' | 'deny'; allHubs: boolean; hubIds: string[];classRefs?:ResourceRef[];personRefs?:ResourceRef[];areaRefs?:AreaRef[];areaHubIds?:string[] }
export interface Credential { token_id: string; academy_id: string; person_id: string; capabilities: Capability[]; all_hubs: boolean; hub_ids: string[]; allowed: boolean; kind?: 'human' | 'bot' }
export interface Scope { workContexts?:ResourceRef[]; all: boolean; hubs: string[]; excludedHubs?: string[];classes?:ResourceRef[];people?:ResourceRef[];excludedClasses?:ResourceRef[];excludedPeople?:ResourceRef[];areas?:AreaRef[];excludedAreas?:AreaRef[];recordHubIds?:string[];workContext?:{hubId:string|null;personId:string};recordContext?:{hubId:string;classId:string;studentId:string} }
const academyCapabilities=new Set<Capability>(['roles.view','roles.edit','credentials.revoke','locations.edit','storage.view','storage.edit','currencies.view','currencies.edit','periods.view','periods.edit','closing.view','closing.edit']);
const classCapabilities=new Set<Capability>(['tuition-sessions.view','tuition-sessions.edit','receivables-reports.view','session-staff-feedback.view','session-evidence.view','session-evidence.edit','session-evidence.override','poll-templates.view','poll-templates.edit','poll-responses.moderate','poll-results.view','poll-responses.view','polls.view','polls.edit','polls.publish','poll-recipients.view','report-comments.view','report-comments.write','report-comments.moderate','homework-solutions.view','homework-solutions.record','homework-solutions.edit','homework-solutions.publish','homework-grades.view','homework-grades.record','homework-grades.edit','homework-grades.publish','homework-submissions.view','homework-submissions.drafts','homework-submissions.submit','homeworks.view','homeworks.record','homeworks.edit','homeworks.publish','homework-recipients.view','student-feedback.view','student-feedback.record','student-feedback.edit','student-feedback.publish','report-publications.view','report-publications.edit','report-publications.override','session-reports.view','session-reports.record','session-reports.edit','attendance.view','attendance.record','attendance.edit','signature-sends.view','signature-sends.edit','signature-sends.execute','session-time.record','session-time.view','session-time.edit','classes.view','classes.edit','sessions.request','staff.view','staff.edit','enrollments.view','enrollments.edit','rosters.view','signatures.view','signatures.edit','files.view','files.edit','files.upload','financial-files.view','financial-files.edit','approvals.view','approvals.review','tuition.view','tuition.edit','invoices.view','invoices.edit','receipts.view','receipts.edit','allocations.view','allocations.edit','share-rules.view','share-rules.edit']);
const personCapabilities=new Set<Capability>(['work-files.view','work-files.edit','work-files.upload','work-signatures.view','work-signatures.edit','payruns.view','payruns.edit','tuition-sessions.view','tuition-sessions.edit','payroll-accruals.view','payroll-accruals.edit','payroll-adjustments.view','payroll-adjustments.edit','payroll-preparations.view','payroll-preparations.edit','pay-periods.view','pay-periods.edit','receivables-reports.view','poll-responses.moderate','poll-results.view','received-polls.respond','poll-responses.view','polls.view','poll-recipients.view','received-polls.view','report-comments.view','report-comments.write','report-comments.moderate','received-comments.view','received-comments.write','received-solutions.view','homework-grades.view','homework-grades.record','homework-grades.edit','homework-grades.publish','received-grades.view','homework-submissions.view','homework-submissions.drafts','homework-submissions.submit','received-submissions.view','received-submissions.drafts','homework-recipients.view','received-homework.view','student-feedback.view','student-feedback.record','student-feedback.edit','student-feedback.publish','received-reports.view','signature-sends.view','signature-sends.edit','signature-sends.execute','work-pay.view','work-pay.edit','people.view','people.edit','students.view','students.edit','guardians.view','guardians.edit','families.view','families.edit','registrations.view','signatures.view','signatures.edit','files.view','files.edit','files.upload','financial-files.view','financial-files.edit','approvals.view','approvals.review','tuition.view','tuition.edit','invoices.view','invoices.edit','receipts.view','receipts.edit','allocations.view','allocations.edit','share-rules.view','share-rules.edit']);
classCapabilities.add('signature-dispatch.execute');
personCapabilities.add('signature-dispatch.execute');
personCapabilities.add('received-calendar.view');
export function featureScope(scope:Scope,capability:Capability):Scope {
  if(academyCapabilities.has(capability)&&!scope.all)return {all:false,hubs:[]};
  const {classes,people,excludedClasses,excludedPeople,...base}=scope;
  return {...base,...classCapabilities.has(capability)?{classes,excludedClasses}:{},...personCapabilities.has(capability)?{people,excludedPeople}:{}};
}
export function areaContains(a:AreaRef,b:AreaRef){return a.id===(a.kind==='country'?b.countryId:a.kind==='region'?b.regionId:b.cityId);}
export function areaAllowsNewRecord(scope:Scope,area:AreaRef) {
  return !scope.excludedAreas?.some(a=>areaContains(a,area))&&(scope.all||Boolean(scope.areas?.some(a=>areaContains(a,area))));
}
export function scopeAllowsRef(source:Scope,ref:ResourceRef,kind:'classes'|'people') {
  const denied=kind==='classes'?source.excludedClasses:source.excludedPeople;
  return !source.excludedHubs?.includes(ref.hubId??'')&&!denied?.some(r=>r.id===ref.id)&&(
    Boolean(source[kind]?.some(r=>r.id===ref.id))||Boolean(ref.hubId&&source.hubs.includes(ref.hubId))||
    (source.all&&(ref.hubId!==null||!source.excludedHubs?.length)));
}
export function scopeContains(source:Scope,target:Scope):boolean {
  const sameRefs=(a:ResourceRef[],b:ResourceRef[]|undefined)=>a.length===b?.length&&a.every((r,i)=>r.id===b[i].id&&r.hubId===b[i].hubId);
  if(source.workContexts&&!sameRefs(source.workContexts,target.workContexts))return false;
  if(target.workContexts){
    if(source.recordContext||source.workContext||Object.keys(target).some(k=>!["all","hubs","people","workContexts"].includes(k))||target.all||target.hubs.length||!target.workContexts.length||target.workContexts.length>200||!sameRefs(target.workContexts,target.people))return false;
    const {workContexts:_,...base}=source;
    return target.workContexts.every(r=>scopeContains(base,{all:false,hubs:[],people:[r],workContext:{personId:r.id,hubId:r.hubId}}));
  }
  const work=target.workContext;
  if(source.workContext&&(!work||source.workContext.hubId!==work.hubId||source.workContext.personId!==work.personId))return false;
  if(work){
    if(source.recordContext||target.recordContext||target.recordHubIds||target.all||target.hubs.length||target.classes?.length||target.areas?.length||target.excludedHubs?.length||target.excludedAreas?.length||target.excludedPeople?.length||target.excludedClasses?.length||target.people?.length!==1||target.people[0].id!==work.personId||target.people[0].hubId!==work.hubId)return false;
    if(source.recordHubIds&&(work.hubId===null||!source.recordHubIds.includes(work.hubId)))return false;
    if(source.excludedHubs?.includes(work.hubId??'')||source.excludedPeople?.some(p=>p.id===work.personId))return false;
    return Boolean(source.people?.some(p=>p.id===work.personId))||(work.hubId!==null?(source.all||source.hubs.includes(work.hubId)):(source.all&&!source.excludedHubs?.length&&!source.excludedAreas?.length));
  }
  if(source.recordHubIds&&(target.all||target.areas?.length||target.people?.length||target.hubs.some(h=>!source.recordHubIds!.includes(h))))return false;
  const context=target.recordContext;
  if(source.recordContext&&(!context||Object.keys(source.recordContext).some(k=>source.recordContext![k as keyof typeof context]!==context[k as keyof typeof context])))return false;
  if(context&&(source.excludedHubs?.includes(context.hubId)||source.excludedClasses?.some(c=>c.id===context.classId)||source.excludedPeople?.some(p=>p.id===context.studentId)))return false;
  // A canonical recordContext narrows this scope to ONE immutable financial
  // tuple. Its original positive facet is not an extra grant requirement.
  // Never apply this shortcut to a whole hub or a bundle of other records.
  if(context&&!target.all&&!target.areas?.length&&!target.excludedAreas?.length&&!target.excludedHubs?.length&&!target.excludedClasses?.length&&!target.excludedPeople?.length
    &&target.hubs.length<=1&&(target.classes?.length??0)<=1&&(target.people?.length??0)<=1
    &&target.hubs.every(h=>h===context.hubId)&&(target.classes??[]).every(c=>c.id===context.classId&&c.hubId===context.hubId)&&(target.people??[]).every(p=>p.id===context.studentId&&p.hubId===context.hubId)
    &&target.hubs.length+(target.classes?.length??0)+(target.people?.length??0)>0)
    return source.all||source.hubs.includes(context.hubId)||Boolean(source.classes?.some(c=>c.id===context.classId))||Boolean(source.people?.some(p=>p.id===context.studentId));
  if(source.recordContext)return false;
  if(target.areas?.some(a=>!source.all&&!source.areas?.some(s=>areaContains(s,a))))return false;
  if((target.all||target.areas?.length)&&source.excludedAreas?.some(e=>!target.excludedAreas?.some(t=>areaContains(t,e))))return false;
  if(target.areas?.length) {
    if(source.excludedHubs?.some(h=>!target.excludedHubs?.includes(h)))return false;
    for(const k of ['excludedClasses','excludedPeople'] as const)if(source[k]?.some(e=>!target[k]?.some(t=>t.id===e.id)))return false;
  }
  const blocked=new Set(source.excludedHubs),targetBlocked=new Set(target.excludedHubs),hubs=new Set(source.hubs);
  const broad=(hub:string|null)=>hub!==null&&(target.all||target.hubs.includes(hub))&&!targetBlocked.has(hub);
  if(target.all&&(!source.all||[...blocked].some(h=>!targetBlocked.has(h))))return false;
  if(!target.hubs.every(h=>targetBlocked.has(h)||((source.all||hubs.has(h))&&!blocked.has(h))))return false;
  for(const [kind,excluded] of [['classes','excludedClasses'],['people','excludedPeople']] as const) {
    const denied=new Set(source[excluded]?.map(r=>r.id)),targetDenied=new Set(target[excluded]?.map(r=>r.id)),allowed=new Set(source[kind]?.map(r=>r.id));
    if(source[excluded]?.some(r=>!targetDenied.has(r.id)&&!targetBlocked.has(r.hubId??'')&&(target.all||broad(r.hubId))))return false;
    for(const ref of target[kind]??[]) {
      if(targetDenied.has(ref.id)||targetBlocked.has(ref.hubId??''))continue;
      if(blocked.has(ref.hubId??'')||denied.has(ref.id)||!(allowed.has(ref.id)||(ref.hubId!==null&&hubs.has(ref.hubId))||(source.all&&(ref.hubId!==null||!blocked.size))))return false;
    }
  }
  return true;
}
export function scopeNonempty(scope:Scope){return scope.all||scope.hubs.length>0||Boolean(scope.classes?.length)||Boolean(scope.people?.length)||Boolean(scope.areas?.length);}

export function scopeFor(credential: Credential, grants: Grant[], capability: Capability): Scope {
  const relevant = grants.filter(g => g.capability === capability);
  if (!credential.capabilities.includes(capability) || relevant.some(g => g.effect === 'deny' && g.allHubs)) return { all: false, hubs: [] };
  const allowed = relevant.filter(g => g.effect === 'allow');
  const denied = new Set(relevant.filter(g=>g.effect==='deny').flatMap(g=>[...g.hubIds,...g.areaHubIds??[]]));
  const roleAll = allowed.some(g => g.allHubs);
  const roleHubs = new Set(allowed.flatMap(g => [...g.hubIds,...g.areaHubIds??[]]));
  const result:Scope=roleAll&&credential.all_hubs?{all:true,hubs:[],...(denied.size?{excludedHubs:[...denied]}:{})}:
    {all:false,hubs:(roleAll?credential.hub_ids:[...roleHubs]).filter(h=>!denied.has(h)&&(credential.all_hubs||credential.hub_ids.includes(h)))};
  for(const [grantKey,scopeKey,deniedKey,supported] of [['classRefs','classes','excludedClasses',classCapabilities],['personRefs','people','excludedPeople',personCapabilities]] as const) {
    if(!supported.has(capability))continue;
    const negative=[...new Map(relevant.filter(g=>g.effect==='deny').flatMap(g=>g[grantKey]??[]).map(r=>[r.id,r])).values()]
      .filter(r=>credential.all_hubs||Boolean(r.hubId&&credential.hub_ids.includes(r.hubId)));
    const negativeIds=new Set(negative.map(r=>r.id));
    const positive=[...new Map(allowed.flatMap(g=>g[grantKey]??[]).map(r=>[r.id,r])).values()].filter(r=>!negativeIds.has(r.id)&&!denied.has(r.hubId??'')&&(credential.all_hubs||Boolean(r.hubId&&credential.hub_ids.includes(r.hubId))));
    if(positive.length)result[scopeKey]=positive;
    if(negative.length)result[deniedKey]=negative;
  }
  if(credential.all_hubs) {
    const negative=[...new Map(relevant.filter(g=>g.effect==='deny').flatMap(g=>g.areaRefs??[]).map(a=>[a.kind+':'+a.id,a])).values()];
    const positive=[...new Map(allowed.flatMap(g=>g.areaRefs??[]).map(a=>[a.kind+':'+a.id,a])).values()].filter(a=>!negative.some(n=>areaContains(n,a)));
    if(positive.length){result.areas=positive;if(denied.size)result.excludedHubs=[...denied];}
    if(negative.length)result.excludedAreas=negative;
  }
  // Selected students can have registrations outside their primary hub. Keep
  // record-hub denials even when the positive grant selects only that person.
  if(['received-calendar.view','poll-responses.moderate','poll-results.view','received-polls.respond','poll-responses.view','polls.view','poll-recipients.view','received-polls.view','report-comments.view','report-comments.write','report-comments.moderate','received-comments.view','received-comments.write','received-solutions.view','homework-grades.view','homework-grades.record','homework-grades.edit','homework-grades.publish','received-grades.view','homework-submissions.view','homework-submissions.drafts','homework-submissions.submit','received-submissions.view','received-submissions.drafts','homework-recipients.view','received-homework.view','student-feedback.view','student-feedback.record','student-feedback.edit','student-feedback.publish','registrations.view','received-reports.view','tuition.view','tuition.edit','invoices.view','invoices.edit','receipts.view','receipts.edit','allocations.view','allocations.edit','share-rules.view','share-rules.edit'].includes(capability)&&denied.size)result.excludedHubs=[...denied].filter(h=>credential.all_hubs||credential.hub_ids.includes(h));
  if(academyCapabilities.has(capability)&&(!result.all||result.excludedHubs?.length||result.excludedAreas?.length))return {all:false,hubs:[]};
  if(['work-files.view','work-files.edit','work-files.upload','work-signatures.view','work-signatures.edit','payruns.view','payruns.edit','work-pay.view','work-pay.edit','payroll-accruals.view','payroll-accruals.edit','payroll-adjustments.view','payroll-adjustments.edit','payroll-preparations.view','payroll-preparations.edit','pay-periods.view','pay-periods.edit'].includes(capability)){
    // Work ownership is not a person's mutable primary hub. Keep selected
    // people, but apply finite machine ceilings to actual engagement hubs.
    const people=[...new Map(relevant.filter(g=>g.effect==='deny').flatMap(g=>g.personRefs??[]).map(p=>[p.id,p])).values()];
    if(people.length)result.excludedPeople=people;
    const positive=[...new Map(allowed.flatMap(g=>g.personRefs??[]).map(p=>[p.id,p])).values()].filter(p=>!people.some(d=>d.id===p.id));
    if(positive.length)result.people=positive;
    if(denied.size)result.excludedHubs=[...denied];
    if(!credential.all_hubs)result.recordHubIds=[...credential.hub_ids];
  }
  return result;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function requireScope(scope: Scope, hub?: string) {
  if ((scope.all && (hub?!scope.excludedHubs?.includes(hub):!scope.excludedHubs?.length&&!scope.excludedAreas?.length)) || (hub && scope.hubs.includes(hub))) return;
  throw new ApiError(403, 'FORBIDDEN');
}

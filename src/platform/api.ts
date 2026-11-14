import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { jsonBody } from '../core/api.ts';
import { assertSchemaReady,type Connection,type Database } from '../core/database.ts';
import { ApiError } from '../core/policy.ts';
import {operationalHealthStatus} from '../operations/health-status.ts';
import {accountingDate} from '../modules/finance-periods.ts';
import {openStudentCareData,studentCarePayload} from '../modules/student-care.ts';
import type {PayrollPrivateVault} from '../core/payroll-private-data.ts';

const id=z.string().uuid().transform(v=>v.toLowerCase()),name=z.string().trim().min(1).max(200),reason=z.string().trim().min(1).max(2000);
const provision=z.object({name,masterName:name,masterEmail:z.string().email().max(254).transform(v=>v.toLowerCase()),reason}).strict();
const change=z.object({expectedVersion:z.number().int().positive().max(2147483647),name:name.optional(),status:z.enum(['provisioning','active','read_only','suspended']).optional(),reason}).strict().refine(v=>v.name!==undefined||v.status!==undefined);
const paging=z.object({limit:z.coerce.number().int().min(1).max(100).optional(),after:id.optional()}).strict();
const accountLedgerQuery=z.object({from:accountingDate,through:accountingDate,limit:z.coerce.number().int().min(1).max(100).default(50),afterPostedOn:accountingDate.optional(),afterJournalId:id.optional(),afterLineNumber:z.coerce.number().int().min(1).max(200).optional()}).strict().refine(v=>v.from<=v.through).refine(v=>[v.afterPostedOn,v.afterJournalId,v.afterLineNumber].filter(v=>v!==undefined).length%3===0).refine(v=>v.afterPostedOn===undefined||(v.afterPostedOn>=v.from&&v.afterPostedOn<=v.through));
const directoryCollection=z.enum(['hubs','people','courses','classes','students','finance-accounts','finance-journals','sessions','class-staff','enrollments','roles','role-assignments','tuition-invoices','tuition-receipts','payroll-runs','payroll-postings','payroll-payments','expense-bills','expense-payments','inventory-catalogue','inventory-lots','inventory-movements']);
const directoryPaging=paging.extend({classId:id.optional()});
const learningHistoryQuery=z.object({record:z.enum(['report','attendance']),limit:z.coerce.number().int().min(1).max(5).default(5),afterVersion:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict();
const homeworkPaging=paging.extend({limit:z.coerce.number().int().min(1).max(20).default(10)}).strict();
const homeworkHistoryQuery=learningHistoryQuery.omit({record:true});
const careReveal=z.object({version:z.number().int().positive().max(2147483647)}).strict();
const homeworkRecordCollection=z.enum(['submissions','grades','solutions']);
const accessPurpose=z.string().refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v)).trim().min(1).max(500);
function readAccessPurpose(request:Request){
 const value=z.string().max(6005).parse(request.headers.get('x-access-purpose'));let decoded=value;
 // Fetch headers cannot carry arbitrary Unicode directly. Keep existing raw
 // ASCII clients; the reserved utf8: prefix carries encodeURIComponent(text).
 if(/^utf8:/i.test(value))try{decoded=decodeURIComponent(value.slice(5));}catch{throw new ApiError(400,'INVALID_INPUT');}
 return accessPurpose.parse(decoded);
}
const invitation=z.object({expectedVersion:z.number().int().positive().max(2147483647),reason}).strict();
const revokeInvitation=invitation.extend({invitationRequestKey:id}).strict();
const planDefinition=z.object({name,description:z.string().max(2000),currencyCode:z.string().regex(/^[A-Z]{3}$/),unitScale:z.number().int().min(0).max(18),amountMinor:z.string().regex(/^(0|[1-9][0-9]{0,37})$/),periodMonths:z.number().int().min(1).max(36),graceDays:z.number().int().min(0).max(365),active:z.boolean()}).strict();
const planCreate=z.object({definition:planDefinition,reason}).strict();
const planChange=planCreate.extend({expectedVersion:z.number().int().positive().max(2147483647)}).strict();
const planDuplicate=invitation.extend({name}).strict();
const planHistory=z.object({limit:z.coerce.number().int().min(1).max(100).optional(),beforeVersion:z.coerce.number().int().positive().max(2147483647).optional()}).strict();
const subscriptionAssignment=z.object({expectedVersion:z.number().int().min(0).max(2147483647),planId:id,planVersion:z.number().int().positive().max(2147483647),startsAt:z.string().datetime({precision:3}).regex(/^[12]/),expiresAt:z.string().datetime({precision:3}).regex(/^[12]/).nullable(),reason}).strict();
const freeExemption=z.object({expectedVersion:z.number().int().min(1).max(2147483647),confirmAcademyId:id,permanent:z.literal(true),reason}).strict();
const cancellationRequest=z.object({expectedVersion:z.number().int().min(0).max(2147483647),reason}).strict();
const cancellationWithdrawal=z.object({expectedVersion:z.literal(1),reason}).strict();
const cancellationConfirmation=cancellationWithdrawal.extend({expectedSubscriptionVersion:z.number().int().min(0).max(2147483647),confirmAcademyId:id}).strict();
const holdReason=reason.refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v));
const legalHoldCreate=z.object({caseReference:name.refine(v=>v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v)),reason:holdReason}).strict();
const legalHoldRelease=z.object({expectedVersion:z.literal(1),confirmAcademyId:id,reason:holdReason}).strict();
const retentionDecision=z.object({relation:z.string().regex(/^public\.[A-Za-z_][A-Za-z0-9_$]{0,62}$/),decision:z.enum(['retain','eligible']),basis:holdReason.max(500),eligibleOn:z.iso.date().nullable()}).strict().refine(v=>v.decision==='retain'?v.eligibleOn===null:v.eligibleOn!==null);
const dispositionReview=z.object({expectedAcademyVersion:z.number().int().positive().max(2147483647),expectedSubscriptionVersion:z.number().int().min(0).max(2147483647),retentionDecisions:z.array(retentionDecision).min(1).max(2000),reviewReference:holdReason.max(500),reviewTimeZone:z.string().min(1).max(100),reason:holdReason}).strict();
const dispositionConfirmation=z.object({confirmAcademyId:id,expectedSourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/),confirmScope:z.literal('delete_reviewed_candidates'),reason:holdReason}).strict();
const ownerInbox=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),afterCreatedAt:z.iso.datetime({offset:true}).optional(),afterId:id.optional(),unread:z.enum(['true','false']).transform(v=>v==='true').optional()}).strict().refine(v=>(v.afterCreatedAt===undefined)===(v.afterId===undefined));
const empty=z.object({}).strict();
const cancellationQueue=z.object({limit:z.coerce.number().int().min(1).max(100).default(50),academyId:id.optional(),readiness:z.enum(['all','waiting','ready']).default('all'),afterReviewAfter:z.iso.datetime({offset:true}).optional(),afterId:id.optional()}).strict().refine(v=>(v.afterReviewAfter===undefined)===(v.afterId===undefined));
function invitationToken(secret:string,userId:string,academyId:string,key:string){return 'kvi_'+createHmac('sha256',secret).update(JSON.stringify(['platform-master-invitation:v1',userId,academyId,key])).digest('base64url');}
export type PlatformSession={userId:string;sessionId:string};
export const platformContract=[
 {path:'/api/platform/v1/academies/{id}/subscription/cancellations/{cancellationId}/disposition-reviews/{reviewId}/confirm',method:'post',schema:dispositionConfirmation,accepted:true,summary:'Verified MFA owner explicitly confirms the exact school and reviewed source fingerprint. Rechecks confirmed30-day cancellation,current versions,retention dates,holds and the full native content snapshot before recording a24-hour intent. One active intent/review,exact retries and immutable audit/receipt acknowledgement. Returns202 queued,not deletion or completed execution. Offline operator still requires backup inclusion and transaction-time source checks;no runtime destructive database privilege or provider changes.'},
 {path:'/api/platform/v1/academies/{id}/subscription/cancellations/{cancellationId}/disposition-reviews',method:'post',schema:dispositionReview,summary:'Verified MFA platform owner records explicit retention decisions for EVERY current school relation after confirmed native30-day cancellation,with exact current academy/subscription versions. Bound1MiB JSON;no caller SQL or primary-key export. Retained relations and all their native referenced parents stay protected. Unknown,duplicate or omitted classifications,future eligibility,active legal holds and unsafe source permissions reject atomically. Immutable review links exact native source manifest and audit,with exact retries. Review reference is owner-supplied evidence,not statutory-compliance certification. No deletion,execution grant,provider change or source-copy cleanup.'},
 {path:'/api/platform/v1/academies/{id}/subscription/cancellations/{cancellationId}/disposition-reviews/{reviewId}',method:'get',summary:'Verified MFA owner reads one immutable school/cancellation-bound retention review with recorded decisions and source/audit references. Source freshness is explicitly not rechecked;historical review is never current execution authority. Read is privately audited;no raw records,keys or provider access.'},
 {path:'/api/platform/v1/academies/{id}/students/{studentId}/care',method:'get',accessPurposeRequired:true,summary:'Verified MFA platform owner reads one exact school/student current care edition metadata with privately audited purpose. Unrecorded is version0/state null. No care text,envelope,commitment,student impersonation or business changes.'},
 {path:'/api/platform/v1/academies/{id}/students/{studentId}/care/history',method:'get',accessPurposeRequired:true,querySchema:homeworkHistoryQuery,summary:'Verified MFA owner reads only immutable care edition metadata under exact school/student binding and private purpose audit. Ascending version cursor,at most5records;no allergies,considerations,encrypted envelope,commitment or modification.'},
 {path:'/api/platform/v1/academies/{id}/students/{studentId}/care/reveal',method:'post',readOnly:true,accessPurposeRequired:true,schema:careReveal,summary:'Verified MFA owner explicitly reveals one exact original encrypted care edition under school/student/version binding and private purpose. Uses the existing authenticated care vault and commitment validation without school-user impersonation. Critical private-content-redacted access audit commits atomically before any plaintext response. No idempotency cache,publication,medical verification,source mutation or external delivery;missing keys or corrupt evidence fail closed. Historical information is not silently restored as current.'},
 {path:'/api/platform/v1/academies/{id}/learning/homeworks/{homeworkId}/records/{collection}',method:'get',pathSchemas:{collection:homeworkRecordCollection},accessPurposeRequired:true,querySchema:homeworkPaging,summary:'Verified MFA platform owner reads exact school/homework-bound submission,grade or solution headers,including private drafts and withdrawn editions. Required privately audited purpose;UUID keyset pages at most20rows. No answer,feedback,solution text,school-user impersonation,business changes,publication or binary access.'},
 {path:'/api/platform/v1/academies/{id}/learning/homeworks/{homeworkId}/records/{collection}/{recordId}',method:'get',pathSchemas:{collection:homeworkRecordCollection},accessPurposeRequired:true,summary:'Verified MFA platform owner reads one exact current immutable internal submission,grade or solution edition. Required school,homework,collection and record binding plus private access purpose. Original content,source context and publication state are retained,not reinterpreted as current family eligibility. Bounded2MiB;no mutation,publication or binary-download authority. Audit excludes private content.'},
 {path:'/api/platform/v1/academies/{id}/learning/homeworks/{homeworkId}/records/{collection}/{recordId}/history',method:'get',pathSchemas:{collection:homeworkRecordCollection},accessPurposeRequired:true,querySchema:homeworkHistoryQuery,summary:'Verified MFA platform owner reads original immutable answer,grade or solution revisions under exact school/homework/collection/record binding. Private purpose audit;ascending version cursor,at most5records and byte-bounded2MiB complete prefix. Continue nextVersion even on shorter pages. No source mutation,student impersonation,family publication or binary-download grant.'},
 {path:'/api/platform/v1/academies/{id}/learning/homeworks/{homeworkId}/history',method:'get',accessPurposeRequired:true,querySchema:homeworkHistoryQuery,summary:'Verified MFA platform owner reads original immutable homework editions with required private purpose and exact school/homework binding. Ascending version cursor,at most5records and byte-bounded2MiB complete prefix;continue nextVersion even if fewer than limit returned. Retains original instructions,recipients,source snapshots,publication state and private reason,not current family eligibility. No mutation,submissions,grades,solutions or binary download authorization. Audit excludes private homework content.'},
 {path:'/api/platform/v1/academies/{id}/learning/sessions/{sessionId}/homeworks',method:'get',accessPurposeRequired:true,querySchema:homeworkPaging,summary:'Verified MFA platform owner reads a school/session-bound private homework directory,including drafts and withdrawn work. Required private purpose;fixed header projection,at most20rows and UUID keyset pagination. No instructions,recipient roster,submissions,grades,solutions,publication or binary download authority.'},
 {path:'/api/platform/v1/academies/{id}/learning/homeworks/{homeworkId}',method:'get',accessPurposeRequired:true,summary:'Verified MFA platform owner reads one fixed-projection current internal homework,including exact structured instructions,private source context and selected recipients. Required private purpose;one statement snapshot retains pinned session version alongside current session status and version. Bounded2MiB,no source mutation,student impersonation,family publication,submissions,grades,solutions or binary download authorization. Audit excludes private homework content.'},
 {path:'/api/platform/v1/academies/{id}/learning/sessions/{sessionId}/history',method:'get',accessPurposeRequired:true,querySchema:learningHistoryQuery,summary:'Verified MFA platform owner reads retained report or attendance revisions for one school-bound session. Required private purpose;ascending immutable version cursor,at most5records and byte-bounded1MiB complete prefix per page. Continue nextVersion even when fewer than limit returned. Original documents,private notes and pinned source snapshots are not rewritten into current eligibility or family publication. No mutation,media download authorization or school-user impersonation.'},
 {path:'/api/platform/v1/academies/{id}/learning/sessions/{sessionId}',method:'get',accessPurposeRequired:true,summary:'Verified MFA platform owner reads one school-bound session and its current internal attendance/report records in one statement snapshot. Required private access purpose;bounded1MiB fixed projection,pinned source versions,private notes and original structured report content. Missing records remain null. Not published-family editions,history,media download authorization,attendance clearance or payroll approval. Audit metadata excludes private learning content. No school-user impersonation or business writes.'},
 {path:'/api/platform/v1/academies/{id}/finance/accounts/{accountId}/ledger',method:'get',accessPurposeRequired:true,querySchema:accountLedgerQuery,summary:'Verified MFA platform owner inspects one school/account posted ledger. Required private purpose audit;exact opening debit-net,whole-window debit/credit and closing debit-net minor-unit strings share ONE statement snapshot with each bounded date/journal/line keyset page. Totals are never page sums. Pinned account currency precision,current chart label and historical line labels retained;reversals remain separate dated postings. Each page is a live read,not a frozen export. No bank verification,FX,counterparty detail,master impersonation,posting or payment authority.'},
 {path:'/api/platform/v1/academies/{id}/finance/journals/{journalId}',method:'get',accessPurposeRequired:true,summary:'Verified MFA platform owner reads one immutable school-bound posted journal and ALL2to200lines,with historical account labels and pinned currency units. Monetary minor units are exact decimal strings;no FX,netting or balance inference. Required private purpose audit;no school-master impersonation,posting,payment,credentials or counterparty detail.'},
 {path:'/api/platform/v1/academies/{id}/records/{collection}',method:'get',pathSchemas:{collection:directoryCollection},accessPurposeRequired:true,querySchema:directoryPaging,summary:'Verified MFA platform owner inspects exact school directories: hubs,people,courses,classes,students,finance-accounts,finance-journals,sessions,class-staff,enrollments,roles,role-assignments,tuition-invoices,tuition-receipts,payroll-runs,payroll-postings,payroll-payments,expense-bills,expense-payments,inventory-catalogue,inventory-lots or inventory-movements. Inventory catalogue shows current item/location editions;lots and movements keep original item/location labels,source quantities,cost/serial/buyer references,disposal/restoration links and corrected purchase flags. These are retained sources,not computed usable stock,current asset value or a new expense. Inventory does not accept classId. Expenses retain original supplier name,all cost lines,declared tax/recoverability,dated attested payment/funding/evidence and void/reversal references. Class-filter matches any original cost line but preserves the WHOLE bill/payment without prorating. No private approval/tax review text or computed balance. Payroll retains original run gross and currency precision,posting net version/amounts,cancellation/reversal references and attested payment dates/funding/method/evidence references;zero net never implies a fabricated cash payment. No private tax/review/identity content,computed settlement balance,bank verification or execution authority. Roles include complete configured allow/deny definitions;assignments retain academy-wide or all six original configured selector types,not a computed effective authorization decision. Tuition keeps pinned invoice amounts,precision,billing name,complete original installments and current retained receipt allocation editions;minor amounts are exact strings,reversed receipts remain explicit and no balance or bank verification is inferred. File evidence is references only,never binary or provider access. Optional classId only for sessions,class-staff,enrollments,tuition-invoices,tuition-receipts,expense-bills,expense-payments;all periods,statuses and pinned versions retained,not an attendance or signing-eligibility decision. Required X-Access-Purpose is privately audited and disclosure fails if its audit is missing;bounded keyset pages,explicit school predicates and RLS. At most20000nested permission/scope/installment/allocation entries and2MiB per page;oversized pages return422 for a smaller page,never partial records. Account definitions and journal headers are not balances/payment proof. Fixed projections exclude identity secrets and care vaults;not complete business browsing. No master impersonation,new membership,permission change or external action.'},
 {path:'/api/platform/v1/operations/health',method:'get',summary:'Verified MFA platform owner only: bounded read-only operational health,with stale observations critical. Twelve fixed required worker process states are checked;legacy samples without worker observations remain warning. The copy-only signing worker is additionally observed only with its separate operator monitoring flag;monitoring never activates it or requires it in unconfigured deployments. Same-VPS evidence,not independent uptime or delivered external alerts. Queue progress is not verified. No credentials,service control or school business data.'},
 {path:'/api/platform/v1/academies/{id}/retention',method:'get',summary:'Verified platform-owner-only current school preservation status,active legal-hold count and live database deletion/bulk-clearing guard coverage with explicit operational exceptions. Missing or disabled guards remain visible. Identity and external storage are outside this coverage;no deletion authorization or statutory retention certification.'},
 {path:'/api/platform/v1/academies/{id}/legal-holds',method:'get',summary:'Verified owner-only bounded immutable academy-wide legal-hold and release history;no school subscription or access change',querySchema:paging},
 {path:'/api/platform/v1/academies/{id}/legal-holds',method:'post',summary:'Verified MFA owner records an academy-wide preservation hold with private case reference and reason,immutable audit and exact retries. No automatic expiry,deletion or external storage certification.',schema:legalHoldCreate},
 {path:'/api/platform/v1/academies/{id}/legal-holds/{holdId}',method:'get',summary:'Verified owner reads one school-bound private preservation case with immutable original basis and current release state'},
 {path:'/api/platform/v1/academies/{id}/legal-holds/{holdId}/release',method:'post',summary:'Verified MFA owner explicitly releases only the exact active school-bound legal hold after matching school confirmation. Other active cases continue preservation;release never authorizes deletion or bypasses statutory retention.',schema:legalHoldRelease},
 {path:'/api/platform/v1/notifications',method:'get',summary:'Verified owner-only unified durable internal cancellation and operational failure/recovery alerts; current source/actionability rechecked on read. Recurrences retain separate history. Reading never confirms a case,resolves a fault or removes its review evidence. Missing/stale monitor data cannot prove recovery. No external delivery or queue-progress claim.',querySchema:ownerInbox},
 {path:'/api/platform/v1/notifications/{id}/read',method:'post',summary:'Owner marks one globally identified internal cancellation or operational alert read idempotently,without cancelling,confirming,resolving or deleting its source',schema:empty},
 {path:'/api/platform/v1/subscription-cancellations',method:'get',summary:'Verified platform-owner review queue of pending school cancellations ordered by original review deadline/id; native clock readiness,optional school and bounded paired cursor. Live queue,not a snapshot or automatic confirmation,charge or deletion.',querySchema:cancellationQueue},
 {path:'/api/platform/v1/academies/{id}/subscription/cancellations/{cancellationId}/confirm',method:'post',summary:'Verified owner confirms only after the original native30-day wait and explicitly reviews the current subscription version; restrict operation to read-only without overriding suspension; preserves records and never deletes,cancels provider payments or issues refunds',schema:cancellationConfirmation},
 {path:'/api/platform/v1/academies/{id}/subscription/cancellations',method:'get',summary:'Owner-only bounded cancellation request and withdrawal history; requests do not cancel access or delete data',querySchema:paging},
 {path:'/api/platform/v1/academies/{id}/subscription/cancellations',method:'post',summary:'Record one pending request against the exact school subscription version,including unassigned version0; reviewAfter uses the native clock plus720hours; no backdating,access change,cancellation or deletion',schema:cancellationRequest},
 {path:'/api/platform/v1/academies/{id}/subscription/cancellations/{cancellationId}',method:'get',summary:'Read one school-bound cancellation case with its original recorded waiting period'},
 {path:'/api/platform/v1/academies/{id}/subscription/cancellations/{cancellationId}/withdraw',method:'post',summary:'Withdraw an exact still-pending request with protected history; never rewrite its waiting clock or cancel a replacement request',schema:cancellationWithdrawal},
 {path:'/api/platform/v1/academies/{id}/subscription/free-exemption',method:'get',summary:'Owner-only proof of the explicitly registered primary free academy; never infer an exemption from a school name'},
 {path:'/api/platform/v1/academies/{id}/subscription/free-exemption',method:'post',summary:'Permanently bind Kavosh’s one primary free academy to an explicitly confirmed ID and current active non-expiring zero-price assignment; cannot transfer or remove; later paid,expiring or future-start assignments are blocked; does not charge or activate',schema:freeExemption},
 {path:'/api/platform/v1/academies/{id}/subscription',method:'get',summary:'Read pinned school subscription and current native-clock access status; does not verify payment'},
 {path:'/api/platform/v1/academies/{id}/subscription/history',method:'get',summary:'Bounded immutable school subscription editions',querySchema:planHistory},
 {path:'/api/platform/v1/academies/{id}/subscription/assign',method:'post',summary:'Owner assigns exact current active plan terms; expectedVersion=0 for first assignment; null expiry only for a zero-price plan; expired/scheduled schools become read-only without overriding manual suspension; no charge or payment proof',schema:subscriptionAssignment},
 {path:'/api/platform/v1/plans',method:'get',summary:'Owner-only subscription reference-price catalogue; does not charge or grant school access',querySchema:paging},
 {path:'/api/platform/v1/plans',method:'post',summary:'Create a subscription plan with exact money units and immutable edition history; zero-priced plans supported',schema:planCreate},
 {path:'/api/platform/v1/plans/{id}',method:'get',summary:'Read current platform subscription plan terms'},
 {path:'/api/platform/v1/plans/{id}/history',method:'get',summary:'Read bounded immutable subscription plan editions',querySchema:planHistory},
 {path:'/api/platform/v1/plans/{id}/change',method:'post',summary:'Version-checked subscription plan edit or archive through active=false; never reprice existing agreements',schema:planChange},
 {path:'/api/platform/v1/plans/{id}/duplicate',method:'post',summary:'Duplicate an exact current plan edition under a new name, retaining source history',schema:planDuplicate},
 {path:'/api/platform/v1/academies',method:'get',summary:'Audited platform-owner school directory',querySchema:paging},
 {path:'/api/platform/v1/academies',method:'post',summary:'Provision a school with one pending master; does not bypass verified invitation onboarding',schema:provision},
 {path:'/api/platform/v1/academies/{id}',method:'get',summary:'Audited platform-owner school and master directory details'},
 {path:'/api/platform/v1/academies/{id}/change',method:'post',summary:'Version-checked school name or operational status change; master cannot be transferred',schema:change},
 {path:'/api/platform/v1/academies/{id}/master-invitation',method:'post',summary:'Issue a private 48-hour invitation for the school’s existing pending master; never activate or send',schema:invitation},
 {path:'/api/platform/v1/academies/{id}/master-invitation/revoke',method:'post',summary:'Cancel one exact unused initial-master invitation under current platform-owner MFA; never cancel a replacement or change accounts; pre-tracking invitations require reissue',schema:revokeInvitation},
 {path:'/api/platform/v1/audit',method:'get',summary:'Read immutable platform access and change history',querySchema:paging}
] as const;

export async function assertPlatformRole(db:Connection){
 const result=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND pg_has_role(current_user,'kavosh_platform_service','member')
 AND NOT has_schema_privilege(current_user,'public','create')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('identity','auth_private') AND has_schema_privilege(current_user,n.oid,'usage'))
 AND NOT EXISTS(SELECT 1 FROM pg_roles e WHERE(e.rolsuper OR e.rolbypassrls OR e.rolname IN('kavosh_platform_policy','kavosh_runtime','kavosh_file_worker','kavosh_file_policy','kavosh_identity','kavosh_delivery','kavosh_identity_policy','kavosh_signature_ingest','kavosh_signature_policy','kavosh_signature_result_worker','kavosh_signature_result_policy','kavosh_automation_worker','kavosh_automation_policy','kavosh_event_policy')) AND pg_has_role(current_user,e.oid,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN('public','identity','auth_private','platform_private') AND pg_has_role(current_user,n.nspowner,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND c.relkind IN('r','p','v','m','f') AND (pg_has_role(current_user,c.relowner,'member') OR has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND p.prosecdef AND has_schema_privilege(current_user,n.oid,'usage') AND has_function_privilege(current_user,p.oid,'execute') AND p.oid NOT IN('platform_private.consume_request_budget(uuid,uuid)'::regprocedure,'platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure,'platform_private.issue_master_invitation(uuid,uuid,uuid,uuid,integer,text,text)'::regprocedure,'platform_private.revoke_master_invitation(uuid,uuid,uuid,uuid,integer,uuid,text,text)'::regprocedure)) AS safe FROM pg_roles r WHERE r.rolname=current_user`);
 if(result.rows[0]?.safe!==true)throw new Error('UNSAFE_PLATFORM_DATABASE_ROLE');
}

export function createPlatformApi(database:Database,resolve:(request:Request)=>Promise<PlatformSession|null>,enabled=false,options:{invitationSecret?:string;readOperationalHealth?:()=>Promise<unknown>;studentCareVault?:()=>PayrollPrivateVault}={}){
 return async(request:Request,path:string)=>{
  const headers={'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  let db:Connection|undefined,transaction=false,destroy=false;
  try{
   if(!enabled)throw new ApiError(404,'NOT_FOUND');
   if(request.headers.has('authorization'))throw new ApiError(401,'HUMAN_SESSION_REQUIRED');
   const session=await resolve(request);if(!session)throw new ApiError(401,'HUMAN_SESSION_REQUIRED');
   id.parse(session.userId);id.parse(session.sessionId);
   const target=/^academies\/([a-f0-9-]{36})(\/(?:change|master-invitation(?:\/revoke)?))?$/.exec(path);
   const planTarget=/^plans\/([a-f0-9-]{36})(\/(?:change|duplicate|history))?$/.exec(path);
   const subscriptionTarget=/^academies\/([a-f0-9-]{36})\/subscription(?:\/(history|assign|free-exemption))?$/.exec(path);
   const cancellationTarget=/^academies\/([a-f0-9-]{36})\/subscription\/cancellations(?:\/([a-f0-9-]{36})(?:\/(withdraw|confirm))?)?$/.exec(path);
   const dispositionTarget=/^academies\/([a-f0-9-]{36})\/subscription\/cancellations\/([a-f0-9-]{36})\/disposition-reviews(?:\/([a-f0-9-]{36})(\/confirm)?)?$/.exec(path);
   const noticeTarget=/^notifications\/([a-f0-9-]{36})\/read$/.exec(path);
   const holdTarget=/^academies\/([a-f0-9-]{36})\/(retention|legal-holds)(?:\/([a-f0-9-]{36})(\/release)?)?$/.exec(path);
   const directoryTarget=/^academies\/([a-f0-9-]{36})\/records\/([^/]+)$/.exec(path);
   const journalTarget=/^academies\/([a-f0-9-]{36})\/finance\/journals\/([a-f0-9-]{36})$/.exec(path);
   const accountLedgerTarget=/^academies\/([a-f0-9-]{36})\/finance\/accounts\/([a-f0-9-]{36})\/ledger$/.exec(path);
   const learningSessionTarget=/^academies\/([a-f0-9-]{36})\/learning\/sessions\/([a-f0-9-]{36})(\/history)?$/.exec(path);
   const homeworkListTarget=/^academies\/([a-f0-9-]{36})\/learning\/sessions\/([a-f0-9-]{36})\/homeworks$/.exec(path),homeworkTarget=/^academies\/([a-f0-9-]{36})\/learning\/homeworks\/([a-f0-9-]{36})(\/history)?$/.exec(path);
   const homeworkRecordTarget=/^academies\/([a-f0-9-]{36})\/learning\/homeworks\/([a-f0-9-]{36})\/records\/([^/]+)(?:\/([a-f0-9-]{36})(\/history)?)?$/.exec(path);
   const careTarget=/^academies\/([a-f0-9-]{36})\/students\/([a-f0-9-]{36})\/care(?:\/(history|reveal))?$/.exec(path);
   let operation:string,input:unknown,key:string|null=null,privateInvitation:string|undefined,inviteInput:{academyId:string;expectedVersion:number;reason:string;tokenHash:string}|undefined,revokeInput:{academyId:string;expectedVersion:number;invitationRequestKey:string;reason:string;tokenHash:string}|undefined;
   const url=new URL(request.url);
   if(careTarget){
    const mode=careTarget[3]??'current',pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');
    if(request.method!==(mode==='reveal'?'POST':'GET'))throw new ApiError(405,'METHOD_NOT_ALLOWED');if(mode!=='history'&&url.search)throw new ApiError(400,'INVALID_QUERY');
    input={...(mode==='history'?homeworkHistoryQuery.parse(Object.fromEntries(pairs)):mode==='reveal'?careReveal.parse(await jsonBody(request,4096)):{}),academyId:id.parse(careTarget[1]),studentId:id.parse(careTarget[2]),mode,purpose:readAccessPurpose(request)};operation='academies.student-care';
   }else if(homeworkRecordTarget){
    if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');
    const mode=homeworkRecordTarget[5]?'history':homeworkRecordTarget[4]?'detail':'list';if(mode==='detail'&&url.search)throw new ApiError(400,'INVALID_QUERY');
    input={...(mode==='list'?homeworkPaging.parse(Object.fromEntries(pairs)):mode==='history'?homeworkHistoryQuery.parse(Object.fromEntries(pairs)):{}),academyId:id.parse(homeworkRecordTarget[1]),homeworkId:id.parse(homeworkRecordTarget[2]),collection:homeworkRecordCollection.parse(homeworkRecordTarget[3]),mode,...homeworkRecordTarget[4]?{recordId:id.parse(homeworkRecordTarget[4])}:{},purpose:readAccessPurpose(request)};operation='academies.homework-records';
   }else if(homeworkListTarget||homeworkTarget){
    if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');
    if(homeworkTarget){if(!homeworkTarget[3]&&url.search)throw new ApiError(400,'INVALID_QUERY');input={...(homeworkTarget[3]?homeworkHistoryQuery.parse(Object.fromEntries(pairs)):{}),academyId:id.parse(homeworkTarget[1]),homeworkId:id.parse(homeworkTarget[2]),purpose:readAccessPurpose(request)};operation=homeworkTarget[3]?'academies.homework-history':'academies.homework';}
    else{input={...homeworkPaging.parse(Object.fromEntries(pairs)),academyId:id.parse(homeworkListTarget![1]),sessionId:id.parse(homeworkListTarget![2]),purpose:readAccessPurpose(request)};operation='academies.homeworks';}
   }else if(learningSessionTarget){
    if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');if(!learningSessionTarget[3]&&url.search)throw new ApiError(400,'INVALID_QUERY');input={...(learningSessionTarget[3]?learningHistoryQuery.parse(Object.fromEntries(pairs)):{}),academyId:id.parse(learningSessionTarget[1]),sessionId:id.parse(learningSessionTarget[2]),purpose:readAccessPurpose(request)};operation=learningSessionTarget[3]?'academies.learning-session-history':'academies.learning-session';
   }else if(accountLedgerTarget){
    if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');
    input={...accountLedgerQuery.parse(Object.fromEntries(pairs)),academyId:id.parse(accountLedgerTarget[1]),accountId:id.parse(accountLedgerTarget[2]),purpose:readAccessPurpose(request)};operation='academies.account-ledger';
   }else if(journalTarget){
    if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(url.search)throw new ApiError(400,'INVALID_QUERY');input={academyId:id.parse(journalTarget[1]),journalId:id.parse(journalTarget[2]),purpose:readAccessPurpose(request)};operation='academies.journal';
   }else if(directoryTarget){
    if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');
    const collection=directoryCollection.parse(directoryTarget[2]),query=directoryPaging.parse(Object.fromEntries(pairs));if(query.classId&&!['sessions','class-staff','enrollments','tuition-invoices','tuition-receipts','expense-bills','expense-payments'].includes(collection))throw new ApiError(400,'INVALID_QUERY');
    input={...query,academyId:id.parse(directoryTarget[1]),collection,purpose:readAccessPurpose(request)};operation='academies.directory';
   }else if(path==='operations/health'){
    if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(url.search)throw new ApiError(400,'INVALID_QUERY');input={};operation='operations.health';
   }else if(holdTarget){
    const academyId=id.parse(holdTarget[1]),holdId=holdTarget[3]?id.parse(holdTarget[3]):undefined;if(holdTarget[2]==='retention'){
     if(holdId)throw new ApiError(404,'NOT_FOUND');if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(url.search)throw new ApiError(400,'INVALID_QUERY');input={academyId};operation='retention.get';
    }else if(request.method==='GET'&&!holdTarget[4]){
     const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');if(holdId){if(pairs.length)throw new ApiError(400,'INVALID_QUERY');input={academyId,holdId};operation='holds.get';}else{input={...paging.parse(Object.fromEntries(pairs)),academyId};operation='holds.list';}
    }else if(request.method==='POST'&&(!holdId||holdTarget[4])){
     if(url.search)throw new ApiError(400,'INVALID_QUERY');key=id.parse(request.headers.get('idempotency-key'));const body=await jsonBody(request);input=holdId?{...legalHoldRelease.parse(body),academyId,holdId}:{...legalHoldCreate.parse(body),academyId};operation=holdId?'holds.release':'holds.create';
    }else throw new ApiError(405,'METHOD_NOT_ALLOWED');
   }else if(path==='notifications'||noticeTarget){
    if(path==='notifications'&&request.method==='GET'){const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');input=ownerInbox.parse(Object.fromEntries(pairs));operation='notifications.list';}
    else if(noticeTarget&&request.method==='POST'){if(url.search)throw new ApiError(400,'INVALID_QUERY');empty.parse(await jsonBody(request));key=id.parse(request.headers.get('idempotency-key'));input={notificationId:id.parse(noticeTarget[1])};operation='notifications.mark-read';}
    else throw new ApiError(405,'METHOD_NOT_ALLOWED');
   }else if(path==='subscription-cancellations'){
    if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');input=cancellationQueue.parse(Object.fromEntries(pairs));operation='cancellations.queue';
   }else if(dispositionTarget){
    if(url.search)throw new ApiError(400,'INVALID_QUERY');const academyId=id.parse(dispositionTarget[1]),cancellationId=id.parse(dispositionTarget[2]);
    if(request.method==='POST'&&!dispositionTarget[3]){key=id.parse(request.headers.get('idempotency-key'));input={...dispositionReview.parse(await jsonBody(request,1048576)),academyId,cancellationId};operation='disposition.prepare';}
    else if(request.method==='POST'&&dispositionTarget[3]&&dispositionTarget[4]){key=id.parse(request.headers.get('idempotency-key'));input={...dispositionConfirmation.parse(await jsonBody(request)),academyId,cancellationId,reviewId:id.parse(dispositionTarget[3])};operation='disposition.confirm';}
    else if(request.method==='GET'&&dispositionTarget[3]&&!dispositionTarget[4]){input={academyId,cancellationId,reviewId:id.parse(dispositionTarget[3])};operation='disposition.get';}
    else throw new ApiError(405,'METHOD_NOT_ALLOWED');
   }else if(cancellationTarget){
    const academyId=id.parse(cancellationTarget[1]),cancellationId=cancellationTarget[2]?id.parse(cancellationTarget[2]):undefined;
    if(request.method==='GET'&&!cancellationTarget[3]){
     if(cancellationId){if(url.search)throw new ApiError(400,'INVALID_QUERY');input={academyId,cancellationId};operation='cancellations.get';}
     else{const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');input={...paging.parse(Object.fromEntries(pairs)),academyId};operation='cancellations.list';}
    }else if(request.method==='POST'&&(!cancellationId||cancellationTarget[3]==='withdraw'||cancellationTarget[3]==='confirm')){
     if(url.search)throw new ApiError(400,'INVALID_QUERY');key=id.parse(request.headers.get('idempotency-key'));const raw=await jsonBody(request);
     input=cancellationId?{...(cancellationTarget[3]==='confirm'?cancellationConfirmation.parse(raw):cancellationWithdrawal.parse(raw)),academyId,cancellationId}:{...cancellationRequest.parse(raw),academyId};operation=cancellationId?(cancellationTarget[3]==='confirm'?'cancellations.confirm':'cancellations.withdraw'):'cancellations.request';
    }else throw new ApiError(405,'METHOD_NOT_ALLOWED');
   }else if(subscriptionTarget){
    const academyId=id.parse(subscriptionTarget[1]),suffix=subscriptionTarget[2];
    if(request.method==='GET'&&suffix!=='assign'){
     const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');
     if(suffix==='free-exemption'){if(url.search)throw new ApiError(400,'INVALID_QUERY');input={academyId};operation='subscriptions.free-exemption.get';}
     else if(suffix==='history'){input={...planHistory.parse(Object.fromEntries(pairs)),academyId};operation='subscriptions.history';}
     else{if(url.search)throw new ApiError(400,'INVALID_QUERY');input={academyId};operation='subscriptions.get';}
    }else if(request.method==='POST'&&suffix==='assign'){
     if(url.search)throw new ApiError(400,'INVALID_QUERY');key=id.parse(request.headers.get('idempotency-key'));input={...subscriptionAssignment.parse(await jsonBody(request)),academyId};operation='subscriptions.assign';
    }else if(request.method==='POST'&&suffix==='free-exemption'){
     if(url.search)throw new ApiError(400,'INVALID_QUERY');key=id.parse(request.headers.get('idempotency-key'));input={...freeExemption.parse(await jsonBody(request)),academyId};operation='subscriptions.free-exemption.bind';
    }else throw new ApiError(405,'METHOD_NOT_ALLOWED');
   }else if(request.method==='GET'&&(path==='plans'||planTarget)){
    const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');
    if(path==='plans'){input=paging.parse(Object.fromEntries(pairs));operation='plans.list';}
    else if(planTarget![2]==='/history'){input={...planHistory.parse(Object.fromEntries(pairs)),planId:id.parse(planTarget![1])};operation='plans.history';}
    else if(!planTarget![2]){if(url.search)throw new ApiError(400,'INVALID_QUERY');input={planId:id.parse(planTarget![1])};operation='plans.get';}
    else throw new ApiError(405,'METHOD_NOT_ALLOWED');
   }else if(request.method==='POST'&&(path==='plans'||planTarget)){
    if(url.search)throw new ApiError(400,'INVALID_QUERY');key=id.parse(request.headers.get('idempotency-key'));const body=await jsonBody(request);
    if(path==='plans'){input=planCreate.parse(body);operation='plans.create';}
    else if(planTarget![2]==='/change'){input={...planChange.parse(body),planId:id.parse(planTarget![1])};operation='plans.change';}
    else if(planTarget![2]==='/duplicate'){input={...planDuplicate.parse(body),planId:id.parse(planTarget![1])};operation='plans.duplicate';}
    else throw new ApiError(405,'METHOD_NOT_ALLOWED');
   }else if(request.method==='GET'&&(path==='academies'||path==='audit')){
    const pairs=[...url.searchParams];if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new ApiError(400,'INVALID_QUERY');
    input=paging.parse(Object.fromEntries(pairs));operation=path==='audit'?'audit.list':'academies.list';
   }else if(request.method==='GET'&&target&&!target[2]){
    if(url.search)throw new ApiError(400,'INVALID_QUERY');input={academyId:id.parse(target[1])};operation='academies.get';
   }else if(request.method==='POST'&&(path==='academies'||target?.[2])){
    if(url.search)throw new ApiError(400,'INVALID_QUERY');
    key=id.parse(request.headers.get('idempotency-key'));
    const body=await jsonBody(request);
    if(target?.[2]==='/master-invitation'||target?.[2]==='/master-invitation/revoke'){
     const revoking=target[2].endsWith('/revoke'),parsed=revoking?revokeInvitation.parse(body):invitation.parse(body),academyId=id.parse(target[1]);
     if(!options.invitationSecret||options.invitationSecret.length<32)throw new Error('INVITATION_SECRET_NOT_CONFIGURED');
     // PRF-derived secret permits exact retries without storing a plaintext token.
     const token=invitationToken(options.invitationSecret,session.userId,academyId,revoking?(parsed as z.infer<typeof revokeInvitation>).invitationRequestKey:key),tokenHash=createHmac('sha256',options.invitationSecret).update(token).digest('hex');
     if(revoking){revokeInput={...parsed as z.infer<typeof revokeInvitation>,academyId,tokenHash};input=revokeInput;operation='academies.master-invitation.revoke';}
     else{privateInvitation=token;inviteInput={...parsed,academyId,tokenHash};input=inviteInput;operation='academies.master-invitation';}
    }else{input=path==='academies'?provision.parse(body):{...change.parse(body),academyId:id.parse(target![1])};operation=path==='academies'?'academies.provision':'academies.change';}
   }else throw new ApiError(path==='plans'||planTarget||path==='academies'||path==='audit'||target?405:404,path==='plans'||planTarget||path==='academies'||path==='audit'||target?'METHOD_NOT_ALLOWED':'NOT_FOUND');
   db=await database.connect();await assertSchemaReady(db);await assertPlatformRole(db);
   if((await db.query<{allowed:boolean}>('SELECT platform_private.consume_request_budget($1,$2) AS allowed',[session.userId,session.sessionId])).rows[0]?.allowed!==true)throw new ApiError(429,'RATE_LIMITED');
   await db.query('BEGIN');transaction=true;
   await db.query("SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true)");
   const result=revokeInput?(await db.query<{result:unknown}>('SELECT platform_private.revoke_master_invitation($1,$2,$3,$4,$5,$6,$7,$8) AS result',[session.userId,session.sessionId,key,revokeInput.academyId,revokeInput.expectedVersion,revokeInput.invitationRequestKey,revokeInput.tokenHash,revokeInput.reason])).rows[0]?.result:inviteInput?(await db.query<{result:unknown}>('SELECT platform_private.issue_master_invitation($1,$2,$3,$4,$5,$6,$7) AS result',[session.userId,session.sessionId,key,inviteInput.academyId,inviteInput.expectedVersion,inviteInput.reason,inviteInput.tokenHash])).rows[0]?.result:(await db.query<{result:unknown}>('SELECT platform_private.request($1,$2,$3,$4,$5::jsonb) AS result',[session.userId,session.sessionId,operation,key,JSON.stringify(input)])).rows[0]?.result;
   const parsed=z.object({status:z.union([z.literal(200),z.literal(201),z.literal(202)]),body:z.unknown()}).strict().safeParse(result);
   if(!parsed.success)throw new Error('INVALID_PLATFORM_RESULT');const value=parsed.data;
   if((value.status===202)!==(operation==='disposition.confirm'))throw new Error('INVALID_PLATFORM_RESULT');
   let responseBody=value.body;
   if(operation==='academies.student-care'&&careTarget?.[3]==='reveal'){
    const result=z.object({academyId:id,studentId:id,data:z.object({studentId:id,version:z.number().int().positive(),state:z.enum(['recorded','withdrawn']),changedBy:id,approvalId:id,recordedAt:z.string(),sealed:studentCarePayload}).strict(),nextVersion:z.null(),scope:z.literal('platform_owner_read_only'),privateFieldsIncluded:z.literal(true)}).strict().parse(value.body);
    if(result.academyId!==careTarget[1]||result.studentId!==careTarget[2]||result.data.studentId!==result.studentId||result.data.version!==(input as z.infer<typeof careReveal>).version)throw new Error('INVALID_PLATFORM_RESULT');
    if(!options.studentCareVault)throw new ApiError(503,'STUDENT_CARE_DATA_UNAVAILABLE');const {sealed,...metadata}=result.data;
    const opened=openStudentCareData(options.studentCareVault(),{academyId:result.academyId,personId:result.studentId,version:metadata.version},sealed);
    responseBody={...result,data:{...metadata,details:opened.details,reason:opened.reason,readAuditRecorded:true,responseRetainedInIdempotencyCache:false}};
   }
   if(privateInvitation){
    const body=z.object({data:z.object({academyId:id,masterPersonId:id,email:z.string().email(),expiresAt:z.string(),externalDeliveryPerformed:z.literal(false),activationPerformed:z.literal(false),invitationRequestKey:id.optional(),issuedAcademyVersion:z.number().int().positive().optional()}).strict()}).strict().safeParse(value.body);
    if(!body.success||body.data.data.academyId!==inviteInput!.academyId||(body.data.data.invitationRequestKey!==undefined&&body.data.data.invitationRequestKey!==key))throw new Error('INVALID_PLATFORM_RESULT');
    responseBody={data:{...body.data.data,privateInvitation}};
   }
   await db.query('COMMIT');transaction=false;
   if(operation==='operations.health'){
    // The database gateway rechecks live owner/MFA authority and commits an
    // immutable access record before the bounded metadata file is read.
    if(!z.object({operationalHealthAccessGranted:z.literal(true)}).strict().safeParse(value.body).success)throw new Error('INVALID_PLATFORM_RESULT');
    if(!options.readOperationalHealth)throw new ApiError(503,'OPERATIONAL_HEALTH_UNAVAILABLE');
    try{responseBody={data:operationalHealthStatus(await options.readOperationalHealth())};}catch{throw new ApiError(503,'OPERATIONAL_HEALTH_UNAVAILABLE');}
   }
   return Response.json(responseBody,{status:value.status,headers});
  }catch(error){
   if(transaction)try{await db!.query('ROLLBACK');}catch{destroy=true;}
   let status=503,code='PLATFORM_UNAVAILABLE';
   if(error instanceof ApiError){status=error.status;code=error.code;}
   else if(error instanceof z.ZodError){status=400;code='INVALID_INPUT';}
   else if(error&&typeof error==='object'&&'message' in error){
    const message=String(error.message);
    if(message==='PLATFORM_OWNER_REQUIRED'){status=403;code=message;}
    else if(message==='PLATFORM_ACADEMY_NOT_FOUND'||message==='PLATFORM_PLAN_NOT_FOUND'||message==='PLATFORM_RECORD_NOT_FOUND'){status=404;code=message;}
    else if(message==='PLATFORM_PLAN_VERSION_CHANGED'){status=409;code=message;}
    else if(message==='PLATFORM_DIRECTORY_OUTPUT_LIMIT'){status=422;code=message;}
    else if(message==='PLATFORM_CANCELLATION_NOT_FOUND'||message==='PLATFORM_NOTIFICATION_NOT_FOUND'||message==='PLATFORM_HOLD_NOT_FOUND'){status=404;code=message;}
    else if(message==='PLATFORM_HOLD_ALREADY_ACTIVE'||message==='PLATFORM_HOLD_ALREADY_RELEASED'){status=409;code=message;}
    else if(['PLATFORM_CANCELLATION_ALREADY_PENDING','PLATFORM_CANCELLATION_ALREADY_DECIDED','PLATFORM_CANCELLATION_WAITING_PERIOD'].includes(message)){status=409;code=message;}
    else if(['PLATFORM_SUBSCRIPTION_VERSION_CHANGED','PLATFORM_SUBSCRIPTION_UNCHANGED','PLATFORM_PLAN_NOT_CURRENT'].includes(message)){status=409;code=message;}
    else if(['PLATFORM_FREE_ACADEMY_PROTECTED','PLATFORM_FREE_ACADEMY_ALREADY_BOUND','PLATFORM_FREE_ACADEMY_ACTIVE_FREE_REQUIRED'].includes(message)){status=409;code=message;}
    else if(['PLATFORM_IDEMPOTENCY_CONFLICT','PLATFORM_ACADEMY_VERSION_CHANGED','PLATFORM_MASTER_VERIFICATION_REQUIRED','PLATFORM_PROVISIONING_REENTRY_FORBIDDEN','PLATFORM_MASTER_INVITATION_UNAVAILABLE','PLATFORM_INVITATION_NO_LONGER_CURRENT','PLATFORM_INVITATION_REISSUE_REQUIRED'].includes(message)){status=409;code=message;}
    else if(message==='PLATFORM_DISPOSITION_NOT_FOUND'){status=404;code=message;}
    else if(['PLATFORM_DISPOSITION_RETENTION_PENDING','PLATFORM_DISPOSITION_CLASSIFICATION_INCOMPLETE','PLATFORM_DISPOSITION_CANCELLATION_REQUIRED','PLATFORM_DISPOSITION_SOURCE_CHANGED','PLATFORM_DISPOSITION_ALREADY_QUEUED','ACADEMY_LEGAL_HOLD_ACTIVE'].includes(message)){status=409;code=message;}
    else if(['DISPOSITION_RETENTION_LIMIT_EXCEEDED','DISPOSITION_MANIFEST_LIMIT_EXCEEDED'].includes(message)){status=422;code=message;}
    else if(message==='INVALID_PLATFORM_INPUT'){status=400;code=message;}
   }
   return Response.json({error:{code}},{status,headers:{...headers,...(status===429?{'Retry-After':'60'}:{})}});
  }finally{db?.release(destroy);}
 };
}

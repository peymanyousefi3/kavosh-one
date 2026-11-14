import { createHash, randomUUID } from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import { z } from 'zod';
import type { Database, Connection } from './database.ts';
import { assertRuntimeRole } from './database.ts';
import { ApiError, requireScope, scopeFor,scopeNonempty, type Capability, type Credential, type Grant, type Scope,type ResourceRef,type AreaRef } from './policy.ts';
import { hashToken, parseBearer } from './tokens.ts';
import type { PayrollPrivateVault } from './payroll-private-data.ts';
import { videoRangeSchema,isVideoReadPath,type VideoRange } from '../files/video-range.ts';
import { reportSpreadsheet,spreadsheetMime } from '../reports/spreadsheet.ts';
import { profileQrReplySchema,profileQrTarget,profileQrFilename,renderProfileQr } from '../profiles/qr.ts';
import { profileShareId } from '../profiles/share-id.ts';
import {auditDiff} from './audit-diff.ts';

const id = z.string().uuid().transform(s => s.toLowerCase());
const name = z.string().trim().min(1).max(200);
const hubInput = z.object({ name, city: z.string().trim().min(1).max(100), countryCode: z.string().regex(/^[A-Z]{2}$/) }).strict();
const personInput = z.object({ name, email: z.string().email().max(254).optional(), hubId: id }).strict();
const paging = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), after: id.optional() }).strict();
// Keep shared worker imports dependency-light. Date provides exact integer
// milliseconds;retain the remaining3digits for PostgreSQL microsecond bounds.
function auditEpochMicros(value:string){const ms=Date.parse(value),fraction=value.match(/\.(\d+)/)?.[1]??'',year=new Date(ms).getUTCFullYear();if(!Number.isFinite(ms)||year<1900||year>9999||fraction.length>6)return null;return BigInt(ms)*1000n+BigInt(fraction.padEnd(6,'0').slice(3));}
const auditInstant=z.iso.datetime({offset:true}).max(100).refine(v=>auditEpochMicros(v)!==null);
const auditQuery=paging.extend({actorId:id.optional(),entityId:id.optional(),requestId:id.optional(),action:z.string().regex(/^[a-z][a-z0-9_.-]{0,149}$/).optional(),actorKind:z.enum(['human','bot']).optional(),from:auditInstant.optional(),through:auditInstant.optional()}).strict().refine(q=>{if(!q.from||!q.through)return true;const from=auditEpochMicros(q.from),through=auditEpochMicros(q.through);return from!==null&&through!==null&&from<=through;},'Choose an ordered inclusive timestamp interval.');
const profileImageReplySchema=z.object({profileId:id,version:z.number().int().positive().max(2147483647),number:z.number().int().min(1).max(100),bytes:z.number().int().positive().max(4194304),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type Reply = { status: number; body: unknown; qr?:{profileId:string;academyId:string;origin:string};csv?:{filename:string};xlsx?:{filename:string};image?:{profileId:string;version:number;number:number;bytes:number;fingerprint:string;open:(reauthorize:()=>Promise<boolean>)=>Promise<ReadableStream<Uint8Array>>};video?:{mime:'video/mp4'|'video/quicktime'|'video/webm';plan:VideoRange;open:()=>Promise<ReadableStream<Uint8Array>|null>} };
export interface ApiContext { db:Connection; credential:Credential; grants:Grant[]; request:Request; path:string; requestId:string; policyLock?:'shared'|'exclusive';financeBookLocked?:boolean;financeBookExclusive?:boolean;collectorFundLocks?:Set<string>;expenseSettlementSnapshot?:boolean;notificationJobId?:string;payrollPrivateVault?:()=>PayrollPrivateVault;studentCareVault?:()=>PayrollPrivateVault }
export type ApiExtension = (context:ApiContext)=>Promise<Reply|null>;
export const coreContract=[{path:'/api/v1/people/{id}',method:'get',summary:'Read a basic person record within current hub or selected-person permissions'},
 {path:'/api/v1/audit-events',method:'get',querySchema:auditQuery,summary:'Current audit.view school/hub intersection before exact actor,entity,request,action,actor-kind and inclusive offset timestamp filters and UUID cursor pagination. Explicit area/hub denials exclude global events. Immutable redacted change metadata only;no credential/session IDs,automatic diff,private-source reveal or additional authority. Timestamp precision at most6fractional digits.'},
 {path:'/api/v1/audit-events/{id}',method:'get',summary:'Read one exact retained change-history event under the same current audit scope,tenant isolation,explicit denials and private approval-reason redaction as its directory. Unknown or out-of-scope events return404.'},
 {path:'/api/v1/audit-events/{id}/diff',method:'get',summary:'Bounded field-by-field comparison of this already-authorized redacted event before/after snapshots only. Missing snapshots are not_recorded;over100fields/64KiB/depth12 is limit_exceeded,never a partial complete diff. Arrays are atomic;presence distinguishes missing from null. No current-record lookup or additional private source access.'}] as const;

export async function jsonBody(request: Request,maximumBytes=16_384) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new ApiError(415, 'JSON_REQUIRED');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_JSON');
  // One total budget,not a fresh timeout per chunk. Cancellation itself may
  // never settle (including a cloned request);never wait on it to free work.
  const chunks: Uint8Array[] = []; let size = 0,finished=false;
  let reject!: (error:ApiError)=>void;
  const stopped=new Promise<never>((_resolve,r)=>{reject=r;});
  const abort=()=>reject(new ApiError(408,'JSON_BODY_ABORTED'));
  const timer=setTimeout(()=>reject(new ApiError(408,'JSON_BODY_TIMEOUT')),10_000);
  request.signal.addEventListener('abort',abort,{once:true});
  const read=async()=>{
    while (true) {
      const { value, done } = await reader.read();
      if (done) {finished=true;break;}
      if(!(value instanceof Uint8Array))throw new ApiError(400,'INVALID_JSON');
      size += value.byteLength;
      if (size > maximumBytes) throw new ApiError(413, 'BODY_TOO_LARGE');
      chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))) as unknown; }
    catch { throw new ApiError(400, 'INVALID_JSON'); }
  };
  try {
    if(request.signal.aborted)throw new ApiError(408,'JSON_BODY_ABORTED');
    return await Promise.race([read(),stopped]);
  } finally {
    clearTimeout(timer);request.signal.removeEventListener('abort',abort);
    if(!finished)void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

export async function loadGrants(db: Connection, c:Credential): Promise<Grant[]> {
  if(c.kind==='human' && (await db.query('SELECT 1 FROM public.academies WHERE master_person_id=$1',[c.person_id])).rows.length) {
    return (await db.query<{name:Capability}>('SELECT name FROM public.capability_catalog')).rows.map(row=>({capability:row.name,effect:'allow',allHubs:true,hubIds:[]}));
  }
  return (await assignmentGrantsForPeople(db,[c.person_id])).get(c.person_id)??[];
}
// Same assignment expansion for a single actor and a bounded recipient batch.
// Master grants are intentionally supplied separately by loadGrants/the caller.
export async function assignmentGrantsForPeople(db:Connection,personIds:string[]):Promise<Map<string,Grant[]>> {
  if(personIds.length>1000)throw new ApiError(422,'PERSON_BATCH_TOO_LARGE');
  const result = await db.query<{ person_id:string;permissions:{capability:Capability;effect:'allow'|'deny'}[]; all_hubs: boolean; hub_ids: string[];class_refs:ResourceRef[];person_refs:ResourceRef[];area_refs:AreaRef[];geo_hubs:string[];geo_deny_hubs:string[] }>(`
    SELECT a.person_id,jsonb_agg(jsonb_build_object('capability',p.capability,'effect',p.effect) ORDER BY p.capability) AS permissions,a.all_hubs,
      ARRAY(SELECT h.hub_id FROM public.assignment_hubs h WHERE h.academy_id=a.academy_id AND h.assignment_id=a.id) AS hub_ids,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'hubId',c.hub_id) ORDER BY c.id) FROM public.assignment_classes x
        JOIN public.classes c ON c.academy_id=x.academy_id AND c.id=x.class_id WHERE x.academy_id=a.academy_id AND x.assignment_id=a.id),'[]'::jsonb) AS class_refs,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'hubId',v.hub_id) ORDER BY v.id) FROM public.assignment_people x
        JOIN public.people v ON v.academy_id=x.academy_id AND v.id=x.person_id WHERE x.academy_id=a.academy_id AND x.assignment_id=a.id),'[]'::jsonb) AS person_refs,
      coalesce((SELECT jsonb_agg(g.ref ORDER BY g.kind,g.id) FROM public.assignment_geography g WHERE g.academy_id=a.academy_id AND g.assignment_id=a.id),'[]'::jsonb) AS area_refs,
      ARRAY(SELECT g.id FROM public.assignment_geographic_hubs g WHERE g.academy_id=a.academy_id AND g.assignment_id=a.id AND g.strict_match ORDER BY g.id) AS geo_hubs,
      ARRAY(SELECT g.id FROM public.assignment_geographic_hubs g WHERE g.academy_id=a.academy_id AND g.assignment_id=a.id ORDER BY g.id) AS geo_deny_hubs
    FROM public.role_assignments a JOIN public.role_permissions p
      ON p.academy_id=a.academy_id AND p.role_id=a.role_id WHERE a.person_id=ANY($1::uuid[]) GROUP BY a.academy_id,a.id`, [personIds]);
  // Read each assignment's selectors once, not once per feature permission.
  const grants=new Map<string,Grant[]>();for(const r of result.rows){const own=grants.get(r.person_id)??[];own.push(...r.permissions.map(p=>({ capability:p.capability,effect:p.effect,allHubs:r.all_hubs,hubIds:r.hub_ids,
    ...(r.class_refs.length?{classRefs:r.class_refs}:{}),...(r.person_refs.length?{personRefs:r.person_refs}:{}),
    ...(r.area_refs.length?{areaRefs:r.area_refs,areaHubIds:p.effect==='deny'?r.geo_deny_hubs:r.geo_hubs}:{}) })));grants.set(r.person_id,own);}return grants;
}

export async function record(db: Connection, c: Credential, requestId: string, action: string, entityId: string, hubId: string | null, changes: unknown) {
  const auditId=randomUUID(),outboxId=randomUUID();
  // A literal acknowledgement needs no additional SELECT privileges on either
  // protected table,and works through adapters that do not expose command tags.
  const audit=c.kind==='human'?await db.query<{recorded:number}>(`INSERT INTO public.audit_events (academy_id,id,actor_id,session_id,actor_kind,request_id,action,entity_id,hub_id,changes)
    VALUES ($1,$2,$3,$4,'human',$5,$6,$7,$8,$9::jsonb) RETURNING 1 AS recorded`, [c.academy_id, auditId, c.person_id, c.token_id, requestId, action, entityId, hubId, JSON.stringify(changes)]):await db.query<{recorded:number}>(`INSERT INTO public.audit_events (academy_id,id,actor_id,credential_id,request_id,action,entity_id,hub_id,changes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING 1 AS recorded`, [c.academy_id, auditId, c.person_id, c.token_id, requestId, action, entityId, hubId, JSON.stringify(changes)]);
  if(audit.rows.length!==1||audit.rows[0].recorded!==1)throw new Error('AUDIT_PERSISTENCE_REQUIRED');
  const outbox=await db.query<{recorded:number}>(`INSERT INTO public.outbox_events (academy_id,id,event_type,entity_id,request_id) VALUES ($1,$2,$3,$4,$5) RETURNING 1 AS recorded`, [c.academy_id, outboxId, action, entityId, requestId]);
  if(outbox.rows.length!==1||outbox.rows[0].recorded!==1)throw new Error('OUTBOX_PERSISTENCE_REQUIRED');
}

export async function mutation(context:ApiContext,input:unknown,work:()=>Promise<Reply>,authorizeReplay?:(reply:Reply)=>Promise<void>):Promise<Reply> {
  const {db,credential:c,request,path}=context;
  if(new URL(request.url).search)throw new ApiError(400,'INVALID_QUERY');
  const key=id.parse(request.headers.get('idempotency-key'));
  const fingerprint=createHash('sha256').update(JSON.stringify([request.method,path,input])).digest('hex');
  const inserted=await db.query(`INSERT INTO public.request_keys(academy_id,credential_id,key,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING key`,[c.academy_id,c.token_id,key,fingerprint]);
  if(!inserted.rows.length) {
    const prior=(await db.query<{request_hash:string;status_code:number;response:unknown}>('SELECT request_hash,status_code,response FROM public.request_keys WHERE credential_id=$1 AND key=$2 FOR UPDATE',[c.token_id,key])).rows[0];
    if(!prior||prior.request_hash!==fingerprint)throw new ApiError(409,'IDEMPOTENCY_CONFLICT');
    const reply={status:prior.status_code,body:prior.response};
    await authorizeReplay?.(reply);
    return reply;
  }
  const reply=await work();
  await db.query('UPDATE public.request_keys SET status_code=$3,response=$4::jsonb WHERE credential_id=$1 AND key=$2',[c.token_id,key,reply.status,JSON.stringify(reply.body)]);
  return reply;
}

function permit(scope: Scope) {
  if (!scopeNonempty(scope)) throw new ApiError(403, 'FORBIDDEN');
}

async function operation(db: Connection, c: Credential, grants: Grant[], request: Request, path: string, requestId: string): Promise<Reply> {
  const url = new URL(request.url);
  const isRead = request.method === 'GET';
  const personPath=/^people\/([^/]+)$/.exec(path),personId=personPath&&isRead?id.parse(personPath[1]):null,auditPath=/^audit-events(?:\/([^/]+)(\/diff)?)?$/.exec(path),auditId=auditPath?.[1]&&isRead?id.parse(auditPath[1]):null;
  let capability: Capability;
  if (path === 'hubs') capability = isRead ? 'hubs.view' : 'hubs.edit';
  else if (path === 'people'||personId) capability = isRead ? 'people.view' : 'people.edit';
  else if (auditPath) capability = 'audit.view';
  else if (/^credentials\/[^/]+\/revoke$/.test(path) && request.method === 'POST') capability = 'credentials.revoke';
  else throw new ApiError(404, 'NOT_FOUND');
  if (!['GET','POST'].includes(request.method) || (auditPath && !isRead)) throw new ApiError(405, 'METHOD_NOT_ALLOWED');
  if(!isRead) {
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,8))',[c.academy_id]);
    await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,9))',[c.academy_id]);
    grants=await loadGrants(db,c);
  }
  const scope = scopeFor(c, grants, capability);
  permit(scope);
  if(isRead&&auditPath){
    if([...url.searchParams].length!==new Set(url.searchParams.keys()).size)throw new ApiError(400,'DUPLICATE_QUERY');
    const q:z.infer<typeof auditQuery>=auditId?(z.object({}).strict().parse(Object.fromEntries(url.searchParams)),{limit:1}):auditQuery.parse(Object.fromEntries(url.searchParams));
    const rows=(await db.query(`SELECT id,actor_id,actor_kind AS "actorKind",request_id,action,entity_id,hub_id,
      CASE WHEN changes?'reason' AND action LIKE 'approval.%' AND EXISTS(SELECT 1 FROM public.approval_requests private_case WHERE private_case.academy_id=public.audit_events.academy_id AND private_case.id=public.audit_events.entity_id AND private_case.privacy_capability IS NOT NULL)
      THEN(changes-'reason')||'{"hasReason":true}'::jsonb ELSE changes END changes,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM public.audit_events WHERE((hub_id IS NULL AND $1::boolean) OR(hub_id IS NOT NULL AND($2::boolean OR hub_id=ANY($3::uuid[])) AND NOT hub_id=ANY($4::uuid[])))
      AND($5::uuid IS NULL OR id=$5) AND($6::uuid IS NULL OR id>$6) AND($7::uuid IS NULL OR actor_id=$7) AND($8::uuid IS NULL OR entity_id=$8) AND($9::uuid IS NULL OR request_id=$9)
      AND($10::text IS NULL OR action=$10) AND($11::text IS NULL OR actor_kind=$11) AND($12::timestamptz IS NULL OR created_at>=$12) AND($13::timestamptz IS NULL OR created_at<=$13) ORDER BY id LIMIT $14`,
      [scope.all&&!scope.excludedHubs?.length&&!scope.excludedAreas?.length,scope.all,scope.hubs,scope.excludedHubs??[],auditId,q.after??null,q.actorId??null,q.entityId??null,q.requestId??null,q.action??null,q.actorKind??null,q.from??null,q.through??null,q.limit+1])).rows;
    if(auditId){if(!rows.length)throw new ApiError(404,'NOT_FOUND');const event=rows[0];return {status:200,body:{data:auditPath[2]?{eventId:event.id,entityId:event.entity_id,action:event.action,...auditDiff(event.changes)}:event}};}
    return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
  }
  if (isRead) {
    const { limit, after } = personId?(z.object({}).strict().parse(Object.fromEntries(url.searchParams)),{limit:1,after:undefined}):paging.parse(Object.fromEntries(url.searchParams));
    // Identifiers are constants selected here, never request-controlled SQL.
    const table = path === 'hubs' ? 'hubs' : 'people';
    const hubColumn = path === 'hubs' ? 'id' : 'hub_id';
    const fields = path === 'hubs' ? 'id,name,city,country_code,created_at' : 'id,name,email,hub_id,status,created_at';
    const rows = await db.query(`SELECT ${fields} FROM public.${table}
      WHERE (($1::boolean AND (cardinality($5::uuid[])=0 OR ${hubColumn} IS NOT NULL)) OR ${hubColumn}=ANY($2::uuid[]) OR id=ANY($6::uuid[]))
      AND NOT coalesce(${hubColumn}=ANY($5::uuid[]),false) AND NOT id=ANY($7::uuid[]) AND ($3::uuid IS NULL OR id>$3::uuid)
      AND ($8::uuid IS NULL OR id=$8) ORDER BY id LIMIT $4`, [scope.all, scope.hubs, after ?? null, limit + 1,scope.excludedHubs??[],
        table==='people'?(scope.people??[]).map(r=>r.id):[],table==='people'?(scope.excludedPeople??[]).map(r=>r.id):[],personId]);
    if(personId){if(!rows.rows.length)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:rows.rows[0]}};}
    const more = rows.rows.length > limit;
    const data = rows.rows.slice(0, limit);
    return { status: 200, body: { data, nextCursor: more ? data.at(-1)?.id : null } };
  }
  if (url.search) throw new ApiError(400, 'INVALID_QUERY');
  const raw = await jsonBody(request);
  let input: unknown;
  let hubId: string | null = null;
  let revokeId: string | undefined;
  if (path === 'hubs') { requireScope(scope); input = hubInput.parse(raw); }
  else if (path === 'people') {
    const person = personInput.parse(raw); requireScope(scope, person.hubId);
    hubId = person.hubId; input = person;
  } else {
    requireScope(scope); z.object({}).strict().parse(raw);
    revokeId = id.parse(path.split('/')[1]);
    if (revokeId === c.token_id) throw new ApiError(409, 'SELF_REVOCATION_REQUIRES_ANOTHER_CREDENTIAL');
    input = {};
  }
  return mutation({db,credential:c,grants,request,path,requestId},input,async()=>{
  let reply: Reply;
  if (path === 'hubs') {
    const value = hubInput.parse(input); const entityId = randomUUID();
    const result = await db.query(`INSERT INTO public.hubs (academy_id,id,name,city,country_code) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,city,country_code`, [c.academy_id, entityId, value.name, value.city, value.countryCode]);
    await record(db, c, requestId, 'hub.created', entityId, entityId, { before: null, after: result.rows[0] });
    reply = { status: 201, body: { data: result.rows[0] } };
  } else if (path === 'people') {
    const value = personInput.parse(input); const entityId = randomUUID();
    const result = await db.query(`INSERT INTO public.people (academy_id,id,kind,name,email,hub_id,status) VALUES ($1,$2,'human',$3,$4,$5,'pending') RETURNING id,name,email,hub_id,status`, [c.academy_id, entityId, value.name, value.email ?? null, value.hubId]);
    await record(db, c, requestId, 'person.created', entityId, hubId, { before: null, after: result.rows[0] });
    reply = { status: 201, body: { data: result.rows[0] } };
  } else {
    const result = await db.query<{ revoked: boolean }>('SELECT public.revoke_bot($1) AS revoked', [revokeId]);
    if (!result.rows[0]?.revoked) throw new ApiError(404, 'NOT_FOUND');
    await record(db, c, requestId, 'credential.revoked', revokeId!, null, { revoked: true });
    reply = { status: 200, body: { revoked: true } };
  }
  return reply;
  });
}

export interface HumanSession { userId:string; sessionId:string; academyId:string }
export function createApi(database: Database, resolveHuman?: (request:Request)=>Promise<HumanSession|null>,extension?:ApiExtension) {
  return async (request: Request, path: string) => {
    const requestId = randomUUID(); let db: Connection | undefined; let transaction = false; let destroyConnection = false;
    const headers = { 'Cache-Control': 'no-store', 'X-Request-Id': requestId, 'X-Content-Type-Options': 'nosniff' };
    try {
      const token = parseBearer(request.headers.get('authorization'));
      // Never fall back to a cookie when an invalid Authorization header was sent.
      const human = !token && !request.headers.has('authorization') && request.headers.has('cookie') && resolveHuman ? await resolveHuman(request) : null;
      if (!token && !human) throw new ApiError(401, 'UNAUTHORIZED');
      const videoHead=request.method==='HEAD'&&isVideoReadPath(path);if(request.method==='HEAD'&&!videoHead)throw new ApiError(405,'METHOD_NOT_ALLOWED');
      db = await database.connect();
      await assertRuntimeRole(db);
      // Autocommitted before domain work so failed requests still consume quota.
      const result = human
        ? await db.query<Credential>('SELECT * FROM public.authenticate_human($1,$2,$3)', [human.sessionId,human.userId,human.academyId])
        : await db.query<Credential>('SELECT * FROM public.authenticate_bot($1)', [hashToken(token!)]);
      const c = result.rows[0];
      if (!c) throw new ApiError(401, 'UNAUTHORIZED');
      if(human)c.kind='human';
      if (!c.allowed) throw new ApiError(429, 'RATE_LIMITED');
      await db.query('BEGIN'); transaction = true;
      // Separate from permission locks: no shared-to-exclusive policy upgrade.
      // Freeze subscription terms before identity locks or any status decision.
      await db.query("SELECT set_config('app.academy_id',$1,true),set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true),pg_advisory_xact_lock_shared(hashtextextended($1,310))", [c.academy_id]);
      // Freeze geography before identity row locks. This avoids reading records
      // using a hub list expanded before a concurrent move across area boundaries.
      const readOnlyPreview=request.method==='POST'&&(/^(?:students\/[0-9a-f-]{36}\/homework\/[0-9a-f-]{36}\/submission|homework-submissions\/[0-9a-f-]{36})\/versions\/[1-9][0-9]{0,9}\/attachments\/(?:[1-9]|1[0-9]|20)\/download-link$/i.test(path)||/^students\/[0-9a-f-]{36}\/(?:published-reports|homework)\/[0-9a-f-]{36}\/media\/[0-9a-f-]{36}\/download-link$/i.test(path)||/^students\/[0-9a-f-]{36}\/homework\/[0-9a-f-]{36}\/solutions\/[0-9a-f-]{36}\/(?:media\/[0-9a-f-]{36}|attachments\/(?:[1-9]|1[0-9]|20))\/download-link$/i.test(path)||/^students\/[0-9a-f-]{36}\/achievements\/[0-9a-f-]{36}\/assets\/(?:[1-9]|10)\/download-link$/i.test(path)||/^signature-send-requests\/[0-9a-f-]{36}\/completion-evidence\/[0-9a-f-]{36}\/(?:document|audit)\/download-link$/i.test(path)||/^students\/[0-9a-f-]{36}\/tuition-invoices\/[0-9a-f-]{36}\/receipts\/[0-9a-f-]{36}\/attachment-download-link$/i.test(path)||/^students\/[0-9a-f-]{36}\/registration-data\/care\/(?:reveal|submissions\/[0-9a-f-]{36}\/reveal)$/i.test(path)||/^students\/[0-9a-f-]{36}\/care\/(?:reveal|proposal-reveal)$/i.test(path)||/^reports\/payroll\/(?:t4|t4a(?:-consolidated)?)-working-paper\/(?:private-package|form-draft)$/i.test(path)||path==='me/community-profile/avatar-download-link'||/^payroll\/private-identities\/[0-9a-f-]{36}\/(?:reveal|proposal-reveal)$/i.test(path)||/^files\/[0-9a-f-]{36}\/download-link$/i.test(path)||/^community\/profiles\/[0-9a-f-]{36}\/avatar-download-link$/i.test(path)||/^payroll\/payruns\/[0-9a-f-]{36}\/net\/(?:contributions-preview|source-contributions-preview)$/i.test(path)||/^payroll\/tax-periods\/[0-9a-f-]{36}\/(?:contributions-preview|taxes-preview)$/i.test(path)||path==='calendar/preview'||/^automations\/rules\/[0-9a-f-]{36}\/(?:preview|event-preview)$/i.test(path)||/^payroll\/engagements\/[0-9a-f-]{36}\/preview$/i.test(path)||/^finance\/tax-codes\/[0-9a-f-]{36}\/preview$/i.test(path)||/^finance\/receipts\/[0-9a-f-]{36}\/allocations\/preview$/i.test(path)||/^finance\/tuition-plans\/[0-9a-f-]{36}\/sharing\/preview$/i.test(path));
      if(request.method==='GET'||videoHead||readOnlyPreview){
        // Match policy writers/domain workers:policy before geography before
        // identity. Taking geography first can deadlock a queued policy writer.
        await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,8))',[c.academy_id]);
        await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,9))',[c.academy_id]);
      }
      const lock = human
        ? await db.query<{ valid: boolean;revision:number }>('SELECT public.lock_human($1,$2) AS valid,public.schema_revision() AS revision',[human.sessionId,human.userId])
        : await db.query<{ valid: boolean;revision:number }>('SELECT public.lock_bot($1) AS valid,public.schema_revision() AS revision', [c.token_id]);
      if (!lock.rows[0]?.valid) throw new ApiError(401, 'UNAUTHORIZED');
      // Legacy schemas have no subscription terms to enforce. Select their
      // actual revision,not a failed-query fallback;310+ must use the native gate.
      if(!Number.isInteger(lock.rows[0].revision))throw new Error('INVALID_SCHEMA_REVISION');
      const academy = await db.query<{ status: string }>(lock.rows[0].revision>=310?'SELECT public.effective_academy_status(status,subscription_terms) AS status FROM public.academies WHERE id=$1':'SELECT status FROM public.academies WHERE id=$1', [c.academy_id]);
      const status = academy.rows[0]?.status;
      if (!status || ['provisioning', 'suspended'].includes(status)) throw new ApiError(403, 'ACADEMY_UNAVAILABLE');
      let securityRevocation = request.method === 'POST' && (/^credentials\/[^/]+\/revoke$/.test(path)||/^invitations\/[0-9a-f-]{36}\/revoke$/i.test(path));
      if(status==='read_only'&&request.method==='POST'&&/^people\/[0-9a-f-]{36}\/work-guardians\/[0-9a-f-]{36}$/i.test(path))securityRevocation=z.object({state:z.literal('suspended')}).passthrough().safeParse(await jsonBody(request.clone())).success;
      if(request.method==='POST'&&path==='me/notification-preferences/disable')securityRevocation=true;
      if(request.method==='POST'&&/^(?:me\/privacy-requests(?:\/[0-9a-f-]{36}\/(?:withdraw|clarifications))?|privacy-requests(?:\/[0-9a-f-]{36}\/review)?)$/i.test(path))securityRevocation=true;
      if(request.method==='POST'&&/^(?:(?:students|people)\/[0-9a-f-]{36}|me)\/profile-consents\/(?:public_profile|verified_member_profile)\/withdraw$/i.test(path))securityRevocation=true;
      if(status==='read_only'&&request.method==='POST'&&/^(?:(?:students|people)\/[0-9a-f-]{36}|me)\/profile-visibility$/i.test(path))securityRevocation=z.object({audience:z.literal('members')}).passthrough().safeParse(await jsonBody(request.clone())).success;
      if(status==='read_only'&&request.method==='POST'&&/^community\/profiles\/[0-9a-f-]{36}\/publication$/i.test(path))securityRevocation=z.object({audience:z.literal('unpublished')}).passthrough().safeParse(await jsonBody(request.clone())).success;
      if(status==='read_only'&&request.method==='POST'&&/^community\/profiles\/[0-9a-f-]{36}\/academic-release$/i.test(path))securityRevocation=z.object({state:z.literal('withdrawn'),awards:z.array(z.never()).max(0)}).passthrough().safeParse(await jsonBody(request.clone())).success;
      if(status==='read_only'&&request.method==='POST'&&/^community\/profiles\/[0-9a-f-]{36}\/image-release$/i.test(path))securityRevocation=z.object({state:z.literal('withdrawn'),selection:z.array(z.never()).max(0)}).passthrough().safeParse(await jsonBody(request.clone())).success;
      if(request.method==='POST'&&/^academy\/subscription\/cancellations(?:\/[0-9a-f-]{36}\/withdraw)?$/i.test(path))securityRevocation=true;
      if(status==='read_only'&&request.method==='POST'&&/^approvals\/[0-9a-f-]{36}\/withdraw$/i.test(path))securityRevocation=(await db.query("SELECT 1 FROM public.approval_requests WHERE id=$1 AND action IN('academy.subscription.cancel-request','academy.subscription.cancel-withdraw')",[id.parse(path.split('/')[1])])).rows.length===1;
      if(status==='read_only'&&request.method==='POST'&&path==='automations/delivery-policy'){
        const pause=z.object({expectedVersion:z.number().int().positive(),definition:z.object({enabled:z.literal(false)}).passthrough(),reason:z.string()}).strict().safeParse(await jsonBody(request.clone()));
        if(pause.success)securityRevocation=(await db.query("SELECT 1 FROM public.operational_send_policies h JOIN public.operational_send_policy_revisions r ON r.academy_id=h.academy_id AND r.policy_id=h.id AND r.version=h.version WHERE h.version=$1 AND r.definition-'enabled'=$2::jsonb-'enabled'",[pause.data.expectedVersion,JSON.stringify(pause.data.definition)])).rows.length===1;
      }
      if(request.method==='POST'&&/^bots\/[0-9a-f-]{36}\/credentials\/[0-9a-f-]{36}\/revoke$/i.test(path))securityRevocation=true;
      if(request.method==='POST'&&/^me\/guardian-profile\/corrections\/[0-9a-f-]{36}\/withdraw$/i.test(path))securityRevocation=true;
      if(request.method==='POST'&&/^students\/[0-9a-f-]{36}\/registration-data\/care\/submissions\/[0-9a-f-]{36}\/withdraw$/i.test(path))securityRevocation=true;
      if(request.method==='POST'&&/^students\/[0-9a-f-]{36}\/registration-data\/corrections\/[0-9a-f-]{36}\/withdraw$/i.test(path))securityRevocation=true;
      if(status==='read_only'&&request.method==='POST'&&/^community\/profiles\/[0-9a-f-]{36}\/moderation$/i.test(path))securityRevocation=z.object({restricted:z.literal(true)}).passthrough().safeParse(await jsonBody(request.clone())).success;
      if(status==='read_only'&&request.method==='POST'&&/^people\/[0-9a-f-]{36}\/status$/i.test(path))securityRevocation=z.object({enabled:z.literal(false)}).passthrough().safeParse(await jsonBody(request.clone())).success;
      // Read-only schools may cancel access secrets,not issue new invitations
      // or apply unrelated approvals. Select the stored action,never a body flag.
      const readOnlyDecision=status==='read_only'&&request.method==='POST'?/^approvals\/([0-9a-f-]{36})\/decide$/i.exec(path):null;
      if(readOnlyDecision){
        const approvalId=id.parse(readOnlyDecision[1]);securityRevocation=(await db.query("SELECT 1 FROM public.approval_requests WHERE id=$1 AND(action IN('academy.subscription.cancel-request','academy.subscription.cancel-withdraw','human-invitation.revoke') OR(action='person.status' AND payload->'enabled'='false'::jsonb) OR(action='community-profile.moderate' AND payload->'restricted'='true'::jsonb))",[approvalId])).rows.length===1;
        if(!securityRevocation){
          // Resolve the actual new action before referring to its schema,so
          // old-schema recovery/moderation decisions keep their original flow.
          const pause=(await db.query<{target_id:string;target_version:number;definition:unknown}>("SELECT target_id,target_version,payload->'definition' definition FROM public.approval_requests WHERE id=$1 AND action='notification.delivery-policy.change' AND payload#>'{definition,enabled}'='false'::jsonb",[approvalId])).rows[0];
          if(pause)securityRevocation=(await db.query("SELECT 1 FROM public.operational_send_policies h JOIN public.operational_send_policy_revisions r ON r.academy_id=h.academy_id AND r.policy_id=h.id AND r.version=h.version WHERE h.id=$1 AND h.version=$2 AND r.definition-'enabled'=$3::jsonb-'enabled'",[pause.target_id,pause.target_version,JSON.stringify(pause.definition)])).rows.length===1;
        }
      }
      if(readOnlyDecision&&!securityRevocation)securityRevocation=(await db.query("SELECT 1 FROM public.approval_requests WHERE id=$1 AND action='work.guardian.change' AND payload->>'state'='suspended'",[id.parse(readOnlyDecision[1])])).rows.length===1;
      if(readOnlyDecision&&!securityRevocation)securityRevocation=(await db.query("SELECT 1 FROM public.approval_requests WHERE id=$1 AND action='privacy.request.review'",[id.parse(readOnlyDecision[1])])).rows.length===1;
      if(readOnlyDecision&&!securityRevocation)securityRevocation=(await db.query("SELECT 1 FROM public.approval_requests WHERE id=$1 AND action IN('community-profile.publish','student-profile.publish','worker-profile.publish') AND payload->>'audience'='unpublished'",[id.parse(readOnlyDecision[1])])).rows.length===1;
      if(readOnlyDecision&&!securityRevocation)securityRevocation=(await db.query("SELECT 1 FROM public.approval_requests WHERE id=$1 AND action='academic-profile.publish' AND payload->>'state'='withdrawn' AND payload->'awards'='[]'::jsonb",[id.parse(readOnlyDecision[1])])).rows.length===1;
      if(readOnlyDecision&&!securityRevocation)securityRevocation=(await db.query("SELECT 1 FROM public.approval_requests WHERE id=$1 AND action='profile-images.publish' AND payload->>'state'='withdrawn' AND payload->'selection'='[]'::jsonb",[id.parse(readOnlyDecision[1])])).rows.length===1;
      if (status === 'read_only' && request.method !== 'GET'&&!videoHead && !securityRevocation&&!readOnlyPreview) throw new ApiError(403, 'ACADEMY_READ_ONLY');
      const actor = await db.query<{ kind: string; status: string }>('SELECT kind,status FROM public.people WHERE id=$1', [c.person_id]);
      if (actor.rows[0]?.kind !== (human?'human':'bot') || actor.rows[0]?.status !== 'active') throw new ApiError(401, 'UNAUTHORIZED');
      const grants=await loadGrants(db,c);
      const reply = await extension?.({db,credential:c,grants,request,path,requestId}) ?? await operation(db,c,grants,request,path,requestId);
      if(reply.image){const match=/^community\/published-profiles\/([^/]+)\/images\/([1-9][0-9]{0,9})\/([1-9][0-9]{0,2})$/.exec(path),{open,...binding}=reply.image,parsed=profileImageReplySchema.safeParse(binding),profile=profileShareId.safeParse(match?.[1]);if(request.method!=='GET'||reply.status!==200||reply.body!==null||reply.csv||reply.xlsx||reply.video||reply.qr||typeof open!=='function'||!parsed.success||!profile.success||parsed.data.profileId!==profile.data||parsed.data.version!==Number(match?.[2])||parsed.data.number!==Number(match?.[3]))throw Error('INVALID_PROFILE_IMAGE_REPLY');}
      // Attachments are code-owned GET results only. Do not let a formatter
      // choose arbitrary headers, MIME types, filenames or cache policies.
      if(reply.csv&&(request.method!=='GET'||reply.status!==200||typeof reply.body!=='string'||typeof reply.csv.filename!=='string'||!/^[-a-z0-9_.]{1,160}\.csv$/.test(reply.csv.filename)||Buffer.byteLength(reply.body,'utf8')>4_194_304))throw new Error('INVALID_CSV_REPLY');
      if(reply.xlsx&&(reply.csv||reply.video||request.method!=='GET'||!(/^reports\/.+\/export\.xlsx$/.test(path)||/^reports\/jobs\/[^/]+\/download\.xlsx$/.test(path))||reply.status!==200||typeof reply.body!=='string'||typeof reply.xlsx.filename!=='string'||!/^[-a-z0-9_.]{1,160}\.xlsx$/.test(reply.xlsx.filename)||Buffer.byteLength(reply.body)>4_194_304))throw new Error('INVALID_XLSX_REPLY');
      if(reply.video&&(reply.csv||reply.body!==null||!isVideoReadPath(path)||!['GET','HEAD'].includes(request.method)||!['video/mp4','video/quicktime','video/webm'].includes(reply.video.mime)||typeof reply.video.open!=='function'||!videoRangeSchema.safeParse(reply.video.plan).success||reply.status!==reply.video.plan.status||videoHead&&reply.status!==200))throw new Error('INVALID_VIDEO_REPLY');
      if(reply.qr){const match=/^community\/published-profiles\/([^/]+)\/qr\.png$/.exec(path),parsed=profileQrReplySchema.safeParse(reply.qr),selected=profileShareId.safeParse(match?.[1]);if(request.method!=='GET'||reply.status!==200||reply.body!==null||reply.csv||reply.xlsx||reply.video||!parsed.success||!selected.success||parsed.data.profileId!==selected.data||parsed.data.academyId!==c.academy_id)throw new Error('INVALID_PROFILE_QR_REPLY');profileQrTarget(parsed.data.origin,parsed.data.profileId,'members',c.academy_id);}
      await db.query('COMMIT'); transaction = false;
      if(reply.image){
        const connection=db;db=undefined;connection.release();const image=reply.image,{open,...binding}=image;
        // Reuse the whole verified-human,current membership/grant/denial/source
        // pipeline after storage IO. The private probe wrapper returns no binary
        // or descriptor,so it cannot recursively open another image transfer.
        const reauthorize=async()=>{const response=await createApi(database,resolveHuman,async context=>{const current=await extension?.(context)??await operation(context.db,context.credential,context.grants,context.request,context.path,context.requestId);if(!current.image)return{status:404,body:null};const {open:_,...now}=current.image,checked=profileImageReplySchema.safeParse(now);return{status:checked.success&&isDeepStrictEqual(checked.data,binding)?200:404,body:null};})(request,path);return response.status===200;};
        const body=await open(reauthorize);if(!(body instanceof ReadableStream))throw Error('INVALID_PROFILE_IMAGE_BODY');try{return new Response(body,{headers:{...headers,'Cache-Control':'private, no-store','Content-Type':'image/webp','Content-Length':String(image.bytes),'Content-Disposition':'inline; filename="kavosh-profile-image.webp"','Accept-Ranges':'none','Cross-Origin-Resource-Policy':'same-origin','Referrer-Policy':'no-referrer','Content-Security-Policy':"sandbox; default-src 'none'"}});}catch(error){await body.cancel().catch(()=>{});throw error;}
      }
      if(reply.qr){const connection=db;db=undefined;connection.release();const bytes=await renderProfileQr(reply.qr.origin,reply.qr.profileId,'members',request.signal,c.academy_id);return new Response(bytes,{status:200,headers:{...headers,'Cache-Control':'private, no-store','Content-Type':'image/png','Content-Length':String(bytes.byteLength),'Content-Disposition':`attachment; filename="${profileQrFilename(reply.qr.profileId)}"`,'Cross-Origin-Resource-Policy':'same-origin','Referrer-Policy':'no-referrer','Content-Security-Policy':"sandbox; default-src 'none'"}});}
      if(reply.xlsx){
        const connection=db;db=undefined;connection.release();
        const bytes=await reportSpreadsheet(reply.body as string,c.academy_id+':'+c.person_id,request.signal);
        return new Response(bytes,{status:200,headers:{...headers,'Cache-Control':'private, no-store','Content-Type':spreadsheetMime,'Content-Length':String(bytes.byteLength),'Content-Disposition':`attachment; filename="${reply.xlsx.filename}"`,'Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"sandbox; default-src 'none'"}});
      }
      if(reply.video){
        // Never retain an authenticated DB connection/row lock during storage
        // IO or a slow viewer's stream. No caller-controlled response headers.
        const connection=db;db=undefined;connection.release();const v=reply.video,p=v.plan;
        const body=p.status===416?null:await v.open();
        if(videoHead&&body!==null||!videoHead&&p.status!==416&&!(body instanceof ReadableStream)){if(body instanceof ReadableStream)void body.cancel().catch(()=>{});throw new Error('INVALID_VIDEO_BODY');}
        return new Response(body,{status:p.status,headers:{...headers,'Cache-Control':'private, no-store','Content-Type':v.mime,'Content-Disposition':'inline','Content-Length':String(p.status===416?0:videoHead?p.total:p.length),'Accept-Ranges':'bytes','ETag':p.etag,'Cross-Origin-Resource-Policy':'same-origin','Referrer-Policy':'no-referrer','Content-Security-Policy':"sandbox; default-src 'none'",...p.status===206?{'Content-Range':`bytes ${p.start}-${p.end}/${p.total}`}:{},...p.status===416?{'Content-Range':`bytes */${p.total}`}:{}}});
      }
      if(reply.csv)return new Response(reply.body as string,{status:200,headers:{...headers,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${reply.csv.filename}"`,'Content-Security-Policy':"sandbox; default-src 'none'"}});
      return Response.json(reply.body, { status: reply.status, headers });
    } catch (error) {
      if (db && transaction) { try { await db.query('ROLLBACK'); } catch { destroyConnection = true; } }
      let status = 503; let code = 'SERVICE_UNAVAILABLE';
      if (error instanceof ApiError) { status = error.status; code = error.code; }
      else if (error instanceof z.ZodError) { status = 400; code = 'INVALID_INPUT'; }
      else if (error && typeof error === 'object' && 'code' in error && error.code === '23503') { status = 400; code = 'INVALID_REFERENCE'; }
      else if (error && typeof error === 'object' && 'code' in error && error.code === '23505') { status = 409; code = 'CONFLICT'; }
      else if (error && typeof error === 'object' && 'code' in error && error.code === '23P01') { status = 409; code = 'SESSION_OVERLAP'; }
      else if (error && typeof error === 'object' && 'code' in error && error.code === '23514' && 'message' in error && ['PAYRUN_CANCEL_BEFORE_SOURCE_CORRECTION','REVERSE_TUITION_RECOGNITION_BEFORE_CREDIT','TUITION_CREDIT_BEFORE_RECOGNITION_CORRECTION','TUITION_RECOGNITION_CORRECTION_WORKFLOW_REQUIRED'].includes(String(error.message))) { status=409;code=String(error.message); }
      else if (error && typeof error === 'object' && 'code' in error && error.code === '23514') { status = 400; code = 'INVALID_INPUT'; }
      return Response.json({ error: { code, requestId } }, { status, headers: { ...headers, ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
    } finally { db?.release(destroyConnection); }
  };
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './database.ts';
import { createApi } from '../src/core/api.ts';
import { capabilities, scopeFor, type Credential } from '../src/core/policy.ts';
import { mintToken, hashToken } from '../src/core/tokens.ts';
import type { Database } from '../src/core/database.ts';
import { postgresOptions } from '../src/core/postgres-config.ts';

async function fixture() {
  const pg = await testDatabase();
  try {
  for(const file of (await readdir(new URL('../db/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())
    await pg.exec(await readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
  const a = randomUUID(), b = randomUUID(), master = randomUUID(), masterB = randomUUID(), bot = randomUUID(), botB = randomUUID();
  const hub = randomUUID(), otherHub = randomUUID(), foreignHub = randomUUID(), role = randomUUID(), assignment = randomUUID();
  const credential = randomUUID(), credentialB = randomUUID(), secondCredential = randomUUID();
  const token = mintToken(), tokenB = mintToken(), secondToken = mintToken();
  await pg.exec('BEGIN');
  for (const [academy, human, machine] of [[a, master, bot],[b, masterB, botB]]) {
    await pg.query("INSERT INTO public.academies (id,name,status,master_person_id) VALUES ($1,'Synthetic academy','active',$2)",[academy,human]);
    await pg.query("INSERT INTO public.people (academy_id,id,kind,name) VALUES ($1,$2,'human','Synthetic master'),($1,$3,'bot','Synthetic bot')",[academy,human,machine]);
  }
  await pg.exec('COMMIT');
  for (const [academy,h] of [[a,hub],[a,otherHub],[b,foreignHub]]) await pg.query("INSERT INTO public.hubs (academy_id,id,name,city,country_code) VALUES ($1,$2,'Synthetic hub','Toronto','CA')",[academy,h]);
  await pg.query("INSERT INTO public.roles VALUES ($1,$2,'Operations')",[a,role]);
  for (const c of capabilities) await pg.query("INSERT INTO public.role_permissions VALUES ($1,$2,$3,'allow')",[a,role,c]);
  await pg.query('INSERT INTO public.role_assignments VALUES ($1,$2,$3,$4,true)',[a,assignment,bot,role]);
  for (const [key, academy, actor, value] of [[credential,a,bot,token],[credentialB,b,botB,tokenB],[secondCredential,a,bot,secondToken]]) {
    await pg.query("INSERT INTO auth_private.credentials (id,academy_id,person_id,token_hash,capabilities,all_hubs,expires_at) VALUES ($1,$2,$3,$4,$5,true,now()+interval '1 hour')", [key,academy,actor,hashToken(value), [...capabilities]]);
  }
  const database: Database = pg.runtime ?? {
    async connect() {
      await pg.exec('SET ROLE kavosh_runtime');
      return {
        async query<Row>(sql: string, params?: unknown[]) {
          const result = await pg.query(sql, params);
          return { rows: result.rows as Row[], rowCount: result.affectedRows };
        },
        release() { /* reset explicitly after each test API request below */ }
      };
    }
  };
  const api = createApi(database);
  async function request(path: string, options: { method?: string; body?: unknown; token?: string; key?: string; headers?: Record<string,string> } = {}) {
    try {
      return await api(new Request(`https://academy.example/api/v1/${path}`, {
        method: options.method ?? 'GET',
        headers: { authorization: `Bearer ${options.token ?? token}`, 'content-type':'application/json', 'idempotency-key':options.key ?? randomUUID(), ...options.headers },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
      }), path.split('?')[0]);
    } finally { await pg.exec('RESET ROLE'); }
  }
  return { pg, a,b,master,bot,hub,otherHub,foreignHub,role,assignment,credential,credentialB,secondCredential,secondToken,token,tokenB,request,api,database };
  } catch(error) { await pg.close(); throw error; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function check(name: string, run: (f: Fixture) => Promise<void>) {
  test(name, async () => { const f = await fixture(); try { await run(f); } finally { await f.pg.close(); } });
}

test('credential permissions intersect roles and explicit denial wins', () => {
  const c: Credential = { token_id:'x',academy_id:'a',person_id:'p',capabilities:['people.view'],all_hubs:false,hub_ids:['one'],allowed:true };
  const grant = { capability:'people.view' as const,effect:'allow' as const,allHubs:true,hubIds:[] };
  assert.deepEqual(scopeFor(c,[grant],'people.view'),{all:false,hubs:['one']});
  assert.deepEqual(scopeFor(c,[grant,{...grant,effect:'deny'}],'people.view'),{all:false,hubs:[]});
  assert.deepEqual(scopeFor(c,[grant],'people.edit'),{all:false,hubs:[]});
});
test('TLS validation cannot be disabled in production or overridden by URL parameters', () => {
  assert.throws(()=>postgresOptions('postgresql://example/db?sslmode=no-verify',{}),/USE_DATABASE_SSL_MODE/);
  assert.throws(()=>postgresOptions('postgresql://example/db?ssl=false',{}),/USE_DATABASE_SSL_MODE/);
  assert.throws(()=>postgresOptions('postgresql://example/db',{NODE_ENV:'production',DATABASE_SSL_MODE:'disable'}),/TLS_REQUIRED/);
  assert.deepEqual(postgresOptions('postgresql://example/db',{}).ssl,{rejectUnauthorized:true});
});

check('rejects missing, malformed, unknown, expired and revoked credentials', async f => {
  assert.equal((await f.request('hubs',{ headers:{authorization:''} })).status,401);
  assert.equal((await f.request('hubs',{token:mintToken()})).status,401);
  await f.pg.query('UPDATE auth_private.credentials SET expires_at=now()-interval \'1 second\' WHERE id=$1',[f.credential]);
  assert.equal((await f.request('hubs')).status,401);
  await f.pg.query('UPDATE auth_private.credentials SET expires_at=now()+interval \'1 hour\',revoked_at=now() WHERE id=$1',[f.credential]);
  assert.equal((await f.request('hubs')).status,401);
});
check('RLS prevents cross-tenant reads and fails closed without tenant context', async f => {
  await f.pg.exec('SET ROLE kavosh_runtime');
  assert.equal((await f.pg.query('SELECT * FROM public.hubs')).rows.length,0);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  assert.equal((await f.pg.query('SELECT * FROM public.hubs')).rows.length,2);
  assert.equal((await f.pg.query('SELECT * FROM public.hubs WHERE id=$1',[f.foreignHub])).rows.length,0);
  await assert.rejects(f.pg.query("INSERT INTO public.hubs (academy_id,id,name,city,country_code) VALUES ($1,$2,'Bad','Bad','CA')",[f.b,randomUUID()]),/row-level security/);
  await f.pg.exec('RESET ROLE');
});
check('composite foreign keys reject cross-tenant relationships', async f => {
  await assert.rejects(f.pg.query("INSERT INTO public.people (academy_id,id,kind,name,hub_id) VALUES ($1,$2,'human','Invalid',$3)",[f.a,randomUUID(),f.foreignHub]),/foreign key/);
});
check('requires exactly one human master and refuses master transfers', async f => {
  await assert.rejects(f.pg.query('UPDATE public.academies SET master_person_id=$1 WHERE id=$2',[f.bot,f.a]),/not transferable/);
  await f.pg.exec('BEGIN');
  await f.pg.query("INSERT INTO public.academies (id,name,master_person_id) VALUES ($1,'Invalid',$2)",[randomUUID(),randomUUID()]);
  await assert.rejects(f.pg.exec('COMMIT'),/foreign key/);
  await f.pg.exec('ROLLBACK');
});
check('refuses a privileged database connection even with a valid bearer', async f => {
  const unsafe: Database = { async connect(){ return { async query<Row>(sql:string,params?:unknown[]) { const r=await f.pg.query(sql,params);return { rows:r.rows as Row[] }; },release(){} }; } };
  const response=await createApi(unsafe)(new Request('https://academy.example/api/v1/hubs',{headers:{authorization:`Bearer ${f.token}`}}),'hubs');
  assert.equal(response.status,503);
  assert.doesNotMatch(await response.text(),/UNSAFE_DATABASE_ROLE|token_hash|postgres/);
});
check('refuses runtime credentials that inherit table ownership', async f => {
  // Roles are cluster-wide even though each fixture database is disposable.
  // Use an exact generated name and clean up on assertion failure as well.
  const owner='synthetic_owner_'+randomUUID().replaceAll('-','');
  await f.pg.exec(`CREATE ROLE ${owner} NOLOGIN`);
  try{
    await f.pg.exec(`ALTER TABLE public.people OWNER TO ${owner}; GRANT ${owner} TO kavosh_runtime`);
    assert.equal((await f.request('hubs')).status,503);
  }finally{
    await f.pg.exec(`RESET ROLE; REVOKE ${owner} FROM kavosh_runtime; ALTER TABLE public.people OWNER TO CURRENT_USER; DROP ROLE ${owner}`);
  }
  assert.equal((await f.pg.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[owner])).rows.length,0);
});
check('refuses a runtime identity that owns the public schema', async f => {
  await f.pg.exec('ALTER SCHEMA public OWNER TO kavosh_runtime');
  assert.equal((await f.request('hubs')).status,503);
});
check('GET only returns this academy; query/header cannot override tenant', async f => {
  const response=await f.request('hubs',{headers:{'x-academy-id':f.b}});
  assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.data.length,2);
  assert.ok(body.data.every((r:{id:string})=>r.id!==f.foreignHub));
  assert.equal((await f.request(`hubs?academyId=${f.b}`)).status,400);
});
check('creates a hub with atomic audit/outbox and durable idempotency', async f => {
  const key=randomUUID(), body={name:'New hub',city:'Ottawa',countryCode:'CA'};
  const first=await f.request('hubs',{method:'POST',body,key});assert.equal(first.status,201);
  const created=await first.json();
  const replay=await f.request('hubs',{method:'POST',body,key});assert.deepEqual(await replay.json(),created);
  assert.equal((await f.pg.query('SELECT * FROM public.audit_events')).rows.length,1);
  assert.equal((await f.pg.query('SELECT * FROM public.outbox_events')).rows.length,1);
  assert.equal((await f.request('hubs',{method:'POST',body:{...body,name:'Different'},key})).status,409);
});
check('a failed reference rolls back mutation, request key and audit/outbox', async f => {
  const response=await f.request('people',{method:'POST',body:{name:'Synthetic student',hubId:f.foreignHub}});
  assert.equal(response.status,400);
  for (const table of ['audit_events','outbox_events','request_keys']) assert.equal((await f.pg.query(`SELECT * FROM public.${table}`)).rows.length,0);
});
check('an outbox failure rolls back an already inserted person and audit event', async f => {
  await f.pg.exec(`CREATE FUNCTION public.simulate_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic failure'; END $$;
    CREATE TRIGGER simulate_failure BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.simulate_outbox_failure()`);
  assert.equal((await f.request('people',{method:'POST',body:{name:'Rollback student',hubId:f.hub}})).status,503);
  assert.equal((await f.pg.query("SELECT * FROM public.people WHERE name='Rollback student'")).rows.length,0);
  assert.equal((await f.pg.query('SELECT * FROM public.audit_events')).rows.length,0);
  assert.equal((await f.pg.query('SELECT * FROM public.request_keys')).rows.length,0);
});
check('new API instance reads persistent records; cursor pagination is bounded', async f => {
  const created=await f.request('people',{method:'POST',body:{name:'Synthetic student',hubId:f.hub}});
  assert.equal(created.status,201);
  const person=(await created.json()).data;
  const nextApi=createApi(f.database);
  const response=await nextApi(new Request('https://academy.example/api/v1/people',{headers:{authorization:`Bearer ${f.token}`}}),'people');
  await f.pg.exec('RESET ROLE');
  assert.ok((await response.json()).data.some((r:{id:string})=>r.id===person.id));
  const first=await (await f.request('hubs?limit=1')).json();
  const second=await (await f.request(`hubs?limit=1&after=${first.nextCursor}`)).json();
  assert.equal(first.data.length,1);assert.equal(second.data.length,1);
  assert.notEqual(first.data[0].id,second.data[0].id);assert.equal(second.nextCursor,null);
});
check('permission revocation applies immediately and cannot be bypassed by idempotency replay', async f => {
  const key=randomUUID(),body={name:'New hub',city:'Ottawa',countryCode:'CA'};
  assert.equal((await f.request('hubs',{method:'POST',key,body})).status,201);
  await f.pg.query("UPDATE public.role_permissions SET effect='deny' WHERE role_id=$1 AND capability='hubs.edit'",[f.role]);
  assert.equal((await f.request('hubs',{method:'POST',key,body})).status,403);
});
check('hub-limited roles can list/create only in their scope and cannot create hubs', async f => {
  await f.pg.query('UPDATE public.role_assignments SET all_hubs=false WHERE id=$1',[f.assignment]);
  await f.pg.query('INSERT INTO public.assignment_hubs VALUES ($1,$2,$3)',[f.a,f.assignment,f.hub]);
  assert.equal((await (await f.request('hubs')).json()).data.length,1);
  assert.equal((await f.request('people',{method:'POST',body:{name:'Student',hubId:f.otherHub}})).status,403);
  assert.equal((await f.request('people',{method:'POST',body:{name:'Student',hubId:f.hub}})).status,201);
  assert.equal((await f.request('hubs',{method:'POST',body:{name:'New hub',city:'Toronto',countryCode:'CA'}})).status,403);
});
check('credential scope cannot widen the assigned role and vice versa', async f => {
  await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);
  await f.pg.query('INSERT INTO auth_private.credential_hubs VALUES ($1,$2,$3)',[f.credential,f.a,f.hub]);
  assert.equal((await (await f.request('hubs')).json()).data.length,1);
  await f.pg.query('UPDATE public.role_assignments SET all_hubs=false WHERE id=$1',[f.assignment]);
  await f.pg.query('INSERT INTO public.assignment_hubs VALUES ($1,$2,$3)',[f.a,f.assignment,f.otherHub]);
  assert.equal((await f.request('hubs')).status,403);
});
check('current runtime cannot read identity secrets, rewrite audit or proposal payloads, issue credentials or cross tenant policy boundaries', async f => {
  await f.pg.exec('SET ROLE kavosh_runtime');
  for (const sql of ['SELECT * FROM auth_private.credentials','SELECT * FROM identity.account','DELETE FROM public.audit_events',"UPDATE public.approval_requests SET payload='{}'"])
    await assert.rejects(f.pg.exec(sql),/permission denied/);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  // Approved role editing intentionally has runtime write privileges since 006;
  // tenant isolation and the API approval/delegation tests protect those writes.
  await assert.rejects(f.pg.query("INSERT INTO public.roles(academy_id,id,name) VALUES($1,$2,'Wrong tenant')",[f.b,randomUUID()]),/row-level security/);
  await f.pg.exec('RESET ROLE');
});
check('read-only, provisioning, suspended and disabled actors fail closed', async f => {
  await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);
  assert.equal((await f.request('hubs')).status,200);
  assert.equal((await f.request('hubs',{method:'POST',body:{name:'Hub',city:'Toronto',countryCode:'CA'}})).status,403);
  for (const status of ['provisioning','suspended']) {
    await f.pg.query('UPDATE public.academies SET status=$1 WHERE id=$2',[status,f.a]);
    assert.equal((await f.request('hubs')).status,403);
  }
  await f.pg.query("UPDATE public.academies SET status='active' WHERE id=$1",[f.a]);
  await f.pg.query("UPDATE public.people SET status='disabled' WHERE id=$1",[f.bot]);
  assert.equal((await f.request('hubs')).status,401);
});
check('unknown fields, invalid limits, oversized payloads and wrong media types are rejected', async f => {
  assert.equal((await f.request('people',{method:'POST',body:{name:'Bad',hubId:f.hub,status:'active'}})).status,400);
  assert.equal((await f.request('hubs?limit=101')).status,400);
  assert.equal((await f.request('hubs',{method:'POST',body:{name:'x'.repeat(17000)}})).status,413);
  assert.equal((await f.request('hubs',{method:'POST',body:{},headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await f.request('hubs',{method:'POST',body:{name:'Name',city:'City',countryCode:'CA'},headers:{'idempotency-key':''}})).status,400);
});
check('shared database rate limits survive failed requests and new API instances', async f => {
  await f.pg.query("INSERT INTO auth_private.rate_windows VALUES ($1,date_trunc('minute',now()),119)",[f.credential]);
  assert.equal((await f.request('hubs?limit=101')).status,400);
  const response=await f.request('hubs');assert.equal(response.status,429);
  assert.equal(response.headers.get('retry-after'),'60');
});
check('revocation is immediate, tenant-scoped, audited and cannot revoke the current credential', async f => {
  assert.equal((await f.request(`credentials/${f.credentialB}/revoke`,{method:'POST',body:{}})).status,404);
  assert.equal((await f.pg.query('SELECT * FROM public.audit_events')).rows.length,0);
  assert.equal((await f.request(`credentials/${f.credential}/revoke`,{method:'POST',body:{}})).status,409);
  await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);
  assert.equal((await f.request(`credentials/${f.secondCredential}/revoke`,{method:'POST',body:{}})).status,200);
  assert.equal((await f.request('hubs',{token:f.secondToken})).status,401);
  assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='credential.revoked'")).rows.length,1);
});
check('transaction-local tenant context does not leak to the next pooled request', async f => {
  assert.equal((await f.request('hubs')).status,200);
  await f.pg.exec('SET ROLE kavosh_runtime');
  assert.equal((await f.pg.query('SELECT * FROM public.hubs')).rows.length,0);
  await f.pg.exec('RESET ROLE');
  assert.equal((await f.request('hubs',{token:f.tokenB})).status,403);
});

if (process.env.TEST_DATABASE_URL) check('real PostgreSQL: simultaneous retries commit one mutation and one audit event', async f => {
  const api=createApi(f.database),key=randomUUID();
  const call=()=>api(new Request('https://academy.example/api/v1/hubs',{
    method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json','idempotency-key':key},
    body:JSON.stringify({name:'Concurrent hub',city:'Toronto',countryCode:'CA'})
  }),'hubs');
  const [a,b]=await Promise.all([call(),call()]);
  assert.equal(a.status,201);assert.equal(b.status,201);
  assert.deepEqual(await a.json(),await b.json());
  assert.equal((await f.pg.query("SELECT * FROM public.hubs WHERE name='Concurrent hub'")).rows.length,1);
  assert.equal((await f.pg.query('SELECT * FROM public.audit_events')).rows.length,1);
  assert.equal((await f.pg.query('SELECT * FROM public.outbox_events')).rows.length,1);
});

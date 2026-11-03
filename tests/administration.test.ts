import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { scopeFor,requireScope,type Capability } from '../src/core/policy.ts';
import { assertSchemaReady } from '../src/core/database.ts';

import { operationsFixture as fixture } from './operations-fixture.ts';

type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(fixture:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

test('scoped denials exclude only their hub and cannot grant academy-wide authority',()=>{
  const credential={token_id:'t',academy_id:'a',person_id:'p',capabilities:['people.view'] as Capability[],all_hubs:true,hub_ids:[],allowed:true};
  const grants=[{capability:'people.view' as const,effect:'allow' as const,allHubs:true,hubIds:[]},{capability:'people.view' as const,effect:'deny' as const,allHubs:false,hubIds:['private']}];
  const scope=scopeFor(credential,grants,'people.view');assert.deepEqual(scope,{all:true,hubs:[],excludedHubs:['private']});
  requireScope(scope,'allowed');assert.throws(()=>requireScope(scope,'private'));assert.throws(()=>requireScope(scope));
  assert.deepEqual(scopeFor({...credential,all_hubs:false,hub_ids:['allowed','private']},grants,'people.view'),{all:false,hubs:['allowed']});
});
check('master receives all registered capabilities and self-approved changes are durable and audited',async f=>{
  const access=await f.request('me/access');assert.equal(access.response.status,200);assert.equal(access.body.master,true);
  assert.ok(access.body.data.some((r:{capability:string;scope:{all:boolean}})=>r.capability==='access.edit'&&r.scope.all));
  const result=await f.request('roles',f.roleInput);assert.equal(result.response.status,201);assert.equal(result.body.approval.status,'applied');
  const row=(await f.pg.query<{status:string;reviewer_id:string}>('SELECT status,reviewer_id FROM public.approval_requests WHERE id=$1',[result.body.approval.id])).rows[0];
  assert.equal(row.status,'applied');assert.equal(row.reviewer_id,f.actors.master.person);
  assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action IN ('role.create','approval.applied')")).rows.length,2);
});
check('role create/update/duplicate use validation, optimistic versions and safe retry semantics',async f=>{
  const key=randomUUID();
  const first=await f.request('roles',f.roleInput,'master',{key});const retry=await f.request('roles',f.roleInput,'master',{key});
  assert.deepEqual(retry.body,first.body);assert.equal(first.response.status,201);
  const role=first.body.data;
  const update={...f.roleInput,name:'Updated viewer',expectedVersion:1};
  const changed=await f.request('roles/'+role.id+'/update',update);assert.equal(changed.response.status,200);assert.equal(changed.body.data.version,2);
  assert.equal((await f.request('roles/'+role.id+'/update',update)).response.status,409);
  const copy=await f.request('roles/'+role.id+'/duplicate',{name:'Copied viewer'});assert.equal(copy.response.status,201);assert.notEqual(copy.body.data.id,role.id);
  assert.deepEqual(copy.body.data.permissions,changed.body.data.permissions);
  assert.equal((await f.request('roles',{...f.roleInput,permissions:[{capability:'invented.execute',effect:'allow'}]})).response.status,400);
  assert.equal((await f.request('roles',{...f.roleInput,permissions:[...f.roleInput.permissions,...f.roleInput.permissions]})).response.status,400);
  assert.equal((await f.request('roles',{...f.roleInput,name:'Cannot delegate',permissions:[{capability:'credentials.revoke',effect:'allow'}]},'manager')).response.status,403);
});
check('non-master change waits for human upper approval and cannot self-approve',async f=>{
  const p=await f.proposal();
  assert.equal((await f.pg.query("SELECT * FROM public.roles WHERE name='Proposed viewer'")).rows.length,0);
  assert.equal((await f.approve(p.id,'manager')).response.status,403);
  assert.equal((await f.approve(p.id,'peer')).response.status,404);
  const accepted=await f.approve(p.id);assert.equal(accepted.response.status,200);assert.equal(accepted.body.approval.status,'applied');
  assert.equal((await f.pg.query("SELECT * FROM public.roles WHERE name='Proposed viewer'")).rows.length,1);
  assert.equal((await f.approve(p.id)).response.status,409);
});
check('approval ownership and tenant scope cannot be bypassed through URLs or academy headers',async f=>{
  const p=await f.proposal();
  assert.equal((await f.request('approvals/'+p.id,undefined,'staff')).response.status,404);
  assert.equal((await f.request('approvals/'+p.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
  assert.equal((await f.request('approvals/'+p.id,undefined,'master',{academy:f.b})).response.status,401);
  assert.equal((await f.request('people/'+f.actors.foreignMaster.person+'/access')).response.status,404);
  const list=await f.request('approvals',undefined,'manager');assert.equal(list.body.data.length,1);
  assert.equal(list.body.data[0].credential_snapshot,undefined);assert.equal(list.body.data[0].grants_hash,undefined);
});
check('withdrawal and rejection retain history and never apply the proposed change',async f=>{
  const p=await f.proposal('Withdrawn viewer');
  assert.equal((await f.request('approvals/'+p.id+'/withdraw',{expectedVersion:1,reason:'Changed requirements'},'master')).response.status,403);
  const withdrawn=await f.request('approvals/'+p.id+'/withdraw',{expectedVersion:1,reason:'Changed requirements'},'manager');
  assert.equal(withdrawn.response.status,200);assert.equal((await f.approve(p.id)).response.status,409);
  const other=await f.proposal('Rejected viewer');
  const rejected=await f.request('approvals/'+other.id+'/decide',{expectedVersion:1,decision:'reject',reason:'Not appropriate for this hub'});
  assert.equal(rejected.body.approval.status,'rejected');
  const history=await f.request('approvals/'+other.id,undefined,'manager');
  assert.equal(history.body.data.reason,'Not appropriate for this hub');assert.equal(history.body.data.reviewerId,f.actors.master.person);assert.ok(history.body.data.decidedAt);
  assert.equal((await f.pg.query("SELECT * FROM public.roles WHERE name IN ('Withdrawn viewer','Rejected viewer')")).rows.length,0);
});
check('target changes invalidate an earlier proposal instead of silently overwriting newer work',async f=>{
  const r=await f.newRole('Editable preset');
  const p=await f.request('roles/'+r.id+'/update',{...f.roleInput,name:'Proposed edit',expectedVersion:1},'manager');assert.equal(p.response.status,202);
  assert.equal((await f.request('roles/'+r.id+'/update',{...f.roleInput,name:'Newer master edit',expectedVersion:1})).response.status,200);
  const result=await f.approve(p.body.approval.id);assert.equal(result.response.status,409);assert.equal(result.body.approval.status,'stale');
  assert.equal(result.body.approval.decisionCode,'TARGET_CHANGED');
  assert.equal((await f.request('roles/'+r.id)).body.data.name,'Newer master edit');
  assert.equal((await f.pg.query<{status:string}>('SELECT status FROM public.approval_requests WHERE id=$1',[p.body.approval.id])).rows[0].status,'stale');
});
check('assignment approval is bound to the exact role template and review context originally proposed',async f=>{
  const role=await f.newRole('Versioned grant');
  const p=await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:1,assignments:[{roleId:role.id,allHubs:false,hubIds:[f.hub]}]},'manager');
  assert.equal(p.response.status,202);
  const before=await f.request('approvals/'+p.body.approval.id);assert.equal(before.body.data.reviewContext.roles.find((r:{id:string})=>r.id===role.id).version,1);
  const edit=await f.request('roles/'+role.id+'/update',{...f.roleInput,name:'Versioned grant',expectedVersion:1,permissions:[...f.roleInput.permissions,{capability:'people.edit',effect:'allow'}]});
  assert.equal(edit.response.status,200);
  const reviewed=await f.approve(p.body.approval.id);assert.equal(reviewed.response.status,409);assert.equal(reviewed.body.approval.decisionCode,'DEPENDENCIES_CHANGED');
  const current=await f.request('people/'+f.actors.staff.person+'/access');assert.equal(current.body.data.version,1);
  assert.equal(current.body.data.assignments[0].role_id,f.staffRole);
});
check('permission revocation invalidates pending requests and takes effect on subsequent calls',async f=>{
  const p=await f.proposal();
  const result=await f.request('people/'+f.actors.manager.person+'/access',{expectedVersion:1,assignments:[{roleId:f.managerRole,allHubs:false,hubIds:[f.hub]}]});assert.equal(result.response.status,200);
  assert.equal((await f.request('roles',{...f.roleInput,name:'Not permitted anymore'},'manager')).response.status,403);
  const approval=await f.approve(p.id);assert.equal(approval.response.status,409);assert.equal(approval.body.approval.status,'stale');
});
check('access viewer sees only permitted assignment segments and cannot remove hidden assignments',async f=>{
  const result=await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:1,assignments:[{roleId:f.staffRole,allHubs:false,hubIds:[f.hub,f.otherHub]}]});
  assert.equal(result.response.status,200);
  const local=await f.request('people/'+f.actors.staff.person+'/access',undefined,'manager');assert.equal(local.response.status,200);
  assert.equal(local.body.data.partiallyHidden,true);assert.deepEqual(local.body.data.assignments[0].hub_ids,[f.hub]);
  assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:2,assignments:[]},'manager')).response.status,403);
  const full=await f.request('people/'+f.actors.staff.person+'/access');assert.equal(full.body.data.partiallyHidden,false);
  assert.equal(full.body.data.assignments[0].hub_ids.length,2);
});
check('hub-specific denial filters API reads without suppressing permitted hubs or allowing global writes',async f=>{
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'hubs.view','allow'),($1,$2,'hubs.edit','allow')",[f.a,f.policyRole]);
  const role=randomUUID(),assigned=randomUUID();
  await f.pg.query("INSERT INTO public.roles(academy_id,id,name) VALUES($1,$2,'Scoped restriction')",[f.a,role]);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'hubs.view','deny'),($1,$2,'hubs.edit','deny')",[f.a,role]);
  await f.pg.query('INSERT INTO public.role_assignments VALUES($1,$2,$3,$4,false)',[f.a,assigned,f.actors.manager.person,role]);
  await f.pg.query('INSERT INTO public.assignment_hubs VALUES($1,$2,$3)',[f.a,assigned,f.otherHub]);
  const hubs=await f.request('hubs',undefined,'manager');assert.equal(hubs.response.status,200);assert.deepEqual(hubs.body.data.map((h:{id:string})=>h.id),[f.hub]);
  assert.equal((await f.request('hubs',{name:'Forbidden global creation',city:'Toronto',countryCode:'CA'},'manager')).response.status,403);
});
check('scoped assignments enforce supervisor hierarchy, prevent self-escalation and reject foreign hubs',async f=>{
  const input={expectedVersion:1,assignments:[{roleId:f.staffRole,allHubs:false,hubIds:[f.hub]}]};
  assert.equal((await f.request('people/'+f.actors.manager.person+'/access',input,'manager')).response.status,403);
  assert.equal((await f.request('people/'+f.actors.peer.person+'/access',input,'manager')).response.status,403);
  assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{...input,assignments:[{...input.assignments[0],allHubs:true,hubIds:[]}]},'manager')).response.status,403);
  assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{...input,assignments:[{...input.assignments[0],hubIds:[f.otherHub]}]},'manager')).response.status,403);
  assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{...input,assignments:[{...input.assignments[0],hubIds:[f.foreignHub]}]})).response.status,400);
  const p=await f.request('people/'+f.actors.staff.person+'/access',input,'manager');assert.equal(p.response.status,202);
  const accepted=await f.approve(p.body.approval.id);assert.equal(accepted.response.status,200);assert.equal(accepted.body.data.version,2);
});
check('scoped administrator cannot edit a template assigned to self or a peer',async f=>{
  const input={...f.roleInput,name:'Privilege escalation attempt',expectedVersion:1};
  assert.equal((await f.request('roles/'+f.policyRole+'/update',input,'manager')).response.status,403);
  assert.equal((await f.request('roles/'+f.managerRole+'/update',input,'manager')).response.status,403);
  assert.equal((await f.request('roles/'+f.systemRole+'/update',input)).response.status,403);
});
check('supervisor edits are master-only, non-transferable and cycle-safe',async f=>{
  const manager=f.actors.manager.person,staff=f.actors.staff.person;
  assert.equal((await f.request('people/'+staff+'/supervisor',{expectedVersion:1,supervisorId:null},'manager')).response.status,403);
  assert.equal((await f.request('people/'+f.actors.master.person+'/supervisor',{expectedVersion:1,supervisorId:manager})).response.status,403);
  assert.equal((await f.request('people/'+manager+'/supervisor',{expectedVersion:1,supervisorId:staff})).response.status,400);
  assert.equal((await f.request('people/'+staff+'/supervisor',{expectedVersion:1,supervisorId:f.actors.peer.person})).response.status,200);
  assert.equal((await f.request('people/'+staff+'/access',{expectedVersion:2,assignments:[]},'manager')).response.status,403);
});
check('bots propose through scoped API but cannot approve or acquire owner/master authority',async f=>{
  const p=await f.proposal('Agent proposal','bot');
  assert.equal((await f.approve(p.id,'bot')).response.status,403);
  assert.equal((await f.approve(p.id)).response.status,200);
  const input={expectedVersion:1,assignments:[{roleId:f.staffRole,allHubs:false,hubIds:[f.hub]}]};
  const assign=await f.request('people/'+f.actors.staff.person+'/access',input,'bot');assert.equal(assign.response.status,202);
  const accepted=await f.approve(assign.body.approval.id,'manager');assert.equal(accepted.response.status,200);
  assert.equal((await f.request('people/'+f.actors.manager.person+'/access',input,'bot')).response.status,403);
});
check('revoking a bot credential invalidates its unexecuted proposals',async f=>{
  const p=await f.proposal('Revoked agent request','bot');
  assert.equal((await f.request('credentials/'+f.credential+'/revoke',{})).response.status,200);
  const result=await f.approve(p.id);assert.equal(result.response.status,409);assert.equal(result.body.approval.status,'stale');
  assert.equal((await f.pg.query("SELECT * FROM public.roles WHERE name='Revoked agent request'")).rows.length,0);
});
check('approval application rolls back domain writes and audit if the outbox fails',async f=>{
  const p=await f.proposal('Atomic approved role');
  await f.pg.exec(`CREATE FUNCTION public.synthetic_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic outbox outage'; END $$;
    CREATE TRIGGER synthetic_fail_outbox BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.synthetic_fail_outbox()`);
  const key=randomUUID();
  const failed=await f.request('approvals/'+p.id+'/decide',{expectedVersion:1,decision:'approve',reason:'Reviewed'},'master',{key});assert.equal(failed.response.status,503);
  assert.equal((await f.pg.query("SELECT * FROM public.roles WHERE name='Atomic approved role'")).rows.length,0);
  assert.equal((await f.pg.query<{status:string}>('SELECT status FROM public.approval_requests WHERE id=$1',[p.id])).rows[0].status,'pending');
  await f.pg.exec('DROP TRIGGER synthetic_fail_outbox ON public.outbox_events; DROP FUNCTION public.synthetic_fail_outbox()');
  assert.equal((await f.request('approvals/'+p.id+'/decide',{expectedVersion:1,decision:'approve',reason:'Reviewed'},'master',{key})).response.status,200);
});
check('runtime cannot rewrite submitted proposal payloads or reach another academy through raw SQL',async f=>{
  const p=await f.proposal();await f.pg.exec('SET ROLE kavosh_runtime');
  try {
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    await assert.rejects(f.pg.query("UPDATE public.approval_requests SET payload='{}'::jsonb WHERE id=$1",[p.id]),/permission denied/);
    assert.equal((await f.pg.query('SELECT * FROM public.people WHERE academy_id=$1',[f.b])).rows.length,0);
  }finally{await f.pg.exec('RESET ROLE');}
});
check('schema readiness rejects an older migration level and reserved master templates stay protected',async f=>{
  const connection={async query<Row>(sql:string,params?:unknown[]){const result=await f.pg.query<Row>(sql,params);return {rows:result.rows};},release(){}};
  await f.pg.exec('SET ROLE kavosh_runtime');
  try{await assertSchemaReady(connection);}finally{await f.pg.exec('RESET ROLE');}
  await f.pg.exec("CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 6 $$");
  await f.pg.exec('SET ROLE kavosh_runtime');
  try{await assert.rejects(assertSchemaReady(connection),/SCHEMA_NOT_CURRENT/);}finally{await f.pg.exec('RESET ROLE');}
  await assert.rejects(f.pg.query("UPDATE public.roles SET name='Transferred root' WHERE id=$1",[f.systemRole]),/Reserved role/);
});

if(process.env.TEST_DATABASE_URL)check('concurrent human reviewers cannot apply the same approved change twice',async f=>{
  const p=await f.proposal('Concurrent role approval');
  const results=await Promise.all([f.approve(p.id),f.approve(p.id)]);
  assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);
  assert.equal((await f.pg.query("SELECT * FROM public.roles WHERE name='Concurrent role approval'")).rows.length,1);
  assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='role.create'")).rows.length,1);
});

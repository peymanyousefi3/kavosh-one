import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { ruleSample } from '../src/core/automation-rules.ts';

async function fixture(){const f=await operationsFixture();try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['automations.view','automations.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const definition={name:'Delayed session report',enabled:true,trigger:{kind:'domain_event',eventTypes:['session.report.*']},condition:{op:'all',conditions:[{op:'eq',field:'severity',value:'critical'},{op:'decimal_gte',field:'attributes.delayMinutes',value:'60'}]},actions:[{kind:'notify',channels:['portal','email'],audience:{kind:'actor_supervisors'},severity:'inherit',title:{en:'Review {{eventType}}',fr:'Réviser {{eventType}}','zh-CN':'检查 {{eventType}}'},body:{en:'Review record {{entityId}}'}}]},input={hubId:f.hub,code:'DELAYED-REPORT',definition,reason:'Configure scoped late-report notifications'},sample={eventType:'session.report.delayed',entityId:randomUUID(),hubId:f.hub,actorId:f.actors.staff.person,actorKind:'human',severity:'critical',occurredAt:'2026-11-04T12:00:00Z',attributes:{delayMinutes:'90'}};
 const create=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('automations/rules',{...input,...patch},as,{key});
 const change=(id:string,patch:Record<string,unknown>={},as='master')=>f.request('automations/rules/'+id+'/change',{expectedVersion:1,definition,reason:'Review exact rule amendment',...patch},as);
 return {...f,definition,input,sample,create,change};
}catch(error){await f.pg.close();throw error;}}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('rule queries reject repeated selectors instead of silently choosing the last value',async f=>{
 const r=(await f.create()).body.data,before=(await f.pg.query('SELECT * FROM public.request_keys ORDER BY key')).rows;
 for(const path of ['automations/rules?limit=1&limit=2','automations/rules?enabled=false&enabled=true','automations/rules/'+r.id+'?version=2&version=1','automations/rules/'+r.id+'/history?limit=1&limit=2']){const result=await f.request(path);assert.equal(result.response.status,400,path);assert.equal(result.body.error.code,'DUPLICATE_QUERY');}
 assert.deepEqual((await f.pg.query('SELECT * FROM public.request_keys ORDER BY key')).rows,before);assert.equal((await f.pg.query('SELECT * FROM public.automation_rule_revisions')).rows.length,1);
});
check('rules persist reviewed definitions, immutable versions, idempotent creates and disabled independent duplicates without claiming delivery',async f=>{
 const key=randomUUID(),created=await f.create({},'master',key);assert.equal(created.response.status,201,JSON.stringify(created.body));const r=created.body.data;assert.equal(r.autonomousEventFanoutEnabled,false);assert.equal(r.workerLiveness,'not_observed');assert.equal(r.definition.execution.mode,'dry_run');assert.equal((await f.create({},'master',key)).body.data.id,r.id);
 assert.equal((await f.change(r.id,{definition:{...f.definition,name:'Updated rule'}})).response.status,200);assert.equal((await f.request('automations/rules/'+r.id+'?version=1')).body.data.definition.name,f.definition.name);
 const copyKey=randomUUID(),copyInput={sourceVersion:2,hubId:f.hub,code:'COPY',name:'Independent copy',reason:'Duplicate preset for editing'},copy=await f.request('automations/rules/'+r.id+'/duplicate',copyInput,'master',{key:copyKey});assert.equal(copy.response.status,201,JSON.stringify(copy.body));assert.equal(copy.body.data.definition.enabled,false);assert.notEqual(copy.body.data.id,r.id);
 assert.equal((await f.change(r.id,{expectedVersion:2,definition:{...f.definition,name:'Later source edit'}})).response.status,200);assert.equal((await f.request('automations/rules/'+r.id+'/duplicate',copyInput,'master',{key:copyKey})).body.data.id,copy.body.data.id);
 const history=await f.request('automations/rules/'+r.id+'/history');assert.equal(history.body.data.length,3);assert.equal(history.body.data[0].reason,f.input.reason);
 const audit=JSON.stringify((await f.pg.query("SELECT changes FROM public.audit_events WHERE action LIKE 'automation.%'")).rows);assert.doesNotMatch(audit,/Delayed session|delayMinutes|Réviser|Review record/);
});
check('non-master and bot rule proposals require upper human approval and revoked rule viewing hides private approvals',async f=>{
 const p=await f.create({},'staff');assert.equal(p.response.status,202,JSON.stringify(p.body));assert.equal((await f.pg.query('SELECT * FROM public.automation_rules')).rows.length,0);assert.equal((await f.approve(p.body.approval.id,'staff')).response.status,403);assert.equal((await f.approve(p.body.approval.id,'manager')).response.status,200);
 const bot=await f.create({code:'BOT'},'bot');assert.equal(bot.response.status,202);assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
 const privateCase=await f.create({code:'PRIVATE'},'staff');assert.equal(privateCase.response.status,202);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='automations.view'",[f.staffRole]);assert.equal((await f.request('approvals/'+privateCase.body.approval.id,undefined,'staff')).response.status,404);
});
check('rule list/detail scopes apply before pagination and a bot cannot broaden its hub ceiling',async f=>{
 const own=(await f.create()).body.data,other=(await f.create({hubId:f.otherHub,code:'OTHER'})).body.data;
 const selected=await f.request('automations/rules?limit=1',undefined,'staff');assert.equal(selected.response.status,200);assert.equal(selected.body.data.length,1);assert.equal(selected.body.data[0].id,own.id);assert.equal(selected.body.nextCursor,null);assert.equal((await f.request('automations/rules/'+other.id,undefined,'staff')).response.status,404);
 await f.pg.query('UPDATE auth_private.credentials SET all_hubs=false WHERE id=$1',[f.credential]);await f.pg.query('INSERT INTO auth_private.credential_hubs(credential_id,academy_id,hub_id) VALUES($1,$2,$3)',[f.credential,f.a,f.hub]);assert.equal((await f.request('automations/rules?hubId='+f.otherHub,undefined,'bot')).body.data.length,0);
 assert.equal((await f.request('automations/rules',undefined,'foreignMaster',{academy:f.b})).body.data.length,0);
});
check('read-only simulations use explicit caller samples with no queued events, request keys or recipient claims',async f=>{
 const r=(await f.create()).body.data,count=(await f.pg.query('SELECT * FROM public.outbox_events')).rows.length,keys=(await f.pg.query('SELECT * FROM public.request_keys')).rows.length;
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);const preview=await f.request('automations/rules/'+r.id+'/preview',{sample:f.sample,locale:'zh-CN'},'staff');assert.equal(preview.response.status,200,JSON.stringify(preview.body));assert.equal(preview.body.data.eligibleByConfiguration,true);assert.equal(preview.body.data.queued,false);assert.equal(preview.body.data.sampleSource,'caller_supplied_unverified');assert.equal(preview.body.data.actions[0].title,'检查 session.report.delayed');assert.equal(preview.body.data.recipientSelectionResolved,false);
 assert.equal((await f.pg.query('SELECT * FROM public.outbox_events')).rows.length,count);assert.equal((await f.pg.query('SELECT * FROM public.request_keys')).rows.length,keys);assert.equal((await f.create({code:'BLOCKED'})).response.status,403);
});
check('named audiences are current authorized humans and cross-hub or foreign people cannot be smuggled into a rule',async f=>{
 const action=f.definition.actions[0],named=(personId:string)=>({...f.definition,actions:[{...action,audience:{kind:'people',personIds:[personId]}}]});
 for(const [person,status] of [[f.actors.peer.person,400],[f.actors.foreignMaster.person,404],[f.bot,400]] as const)assert.equal((await f.create({definition:named(person)})).response.status,status);
 const pending=await f.create({definition:named(f.actors.staff.person)},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));await f.pg.query('UPDATE public.people SET hub_id=$2 WHERE id=$1',[f.actors.staff.person,f.otherHub]);assert.equal((await f.approve(pending.body.approval.id)).response.status,409);
});
check('native rules reject ownership/history/timestamp forgery and tenant disclosure while audit/outbox failures roll back the whole change',async f=>{
 const created=await f.create();assert.equal(created.response.status,201,JSON.stringify(created.body));const id=created.body.data.id;
 await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');for(const sql of ["UPDATE public.automation_rules SET hub_id=NULL WHERE id=$1","DELETE FROM public.automation_rules WHERE id=$1","UPDATE public.automation_rule_revisions SET definition='{}'::jsonb WHERE rule_id=$1","UPDATE public.automation_rule_revisions SET created_at=now() WHERE rule_id=$1","UPDATE public.automation_rules SET version=version WHERE id=$1"]){await f.pg.exec('SAVEPOINT hostile');await assert.rejects(f.pg.query(sql,[id]));await f.pg.exec('ROLLBACK TO SAVEPOINT hostile');}await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.automation_rules')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.automation_rule_revisions')).rows.length,0);}finally{await f.pg.exec('ROLLBACK');}
 await f.pg.exec("CREATE FUNCTION public.reject_automation_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='automation.rule.change' THEN RAISE EXCEPTION 'synthetic event failure';END IF;RETURN NEW;END $$;CREATE TRIGGER reject_automation_event BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.reject_automation_event()");assert.equal((await f.change(id)).response.status,503);assert.equal((await f.pg.query('SELECT * FROM public.automation_rule_revisions')).rows.length,1);
});
test('brief concurrent rule edits preserve one exact version instead of silently overwriting another',async t=>{
 const f=await fixture();try{if(!f.pg.runtime){t.skip('Independent native PostgreSQL connections required');return;}const id=(await f.create()).body.data.id,start=performance.now(),r=await Promise.all([f.change(id,{definition:{...f.definition,name:'First'}}),f.change(id,{definition:{...f.definition,name:'Second'}})]);assert.deepEqual(r.map(r=>r.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.automation_rule_revisions')).rows.length,2);console.log(JSON.stringify({measurement:'brief-automation-rule-race',requests:2,winners:1,elapsedMs:Math.ceil(performance.now()-start)}));}finally{await f.pg.close();}
});
check('native condition validation independently rejects code, invalid decimal types, excessive nesting and extra keys',async f=>{
 let deep:unknown={op:'exists',field:'severity'};for(let i=0;i<20;i++)deep={op:'not',condition:deep};
 for(const condition of [{op:'eval',field:'severity',value:'script'},{op:'eq',field:'attributes.constructor.name',value:'x'},{op:'decimal_gt',field:'attributes.amount',value:1},{op:'exists',field:'severity',value:true},{op:'all',conditions:[]},deep])assert.equal((await f.pg.query<{valid:boolean}>('SELECT public.automation_condition_valid($1::jsonb) AS valid',[JSON.stringify(condition)])).rows[0].valid,false);
 assert.equal((await f.pg.query<{valid:boolean}>('SELECT public.automation_condition_valid($1::jsonb) AS valid',[JSON.stringify(f.definition.condition)])).rows[0].valid,true);
 for(const occurredAt of ['2026-11-04T12:00Z','2026-11-04T12:00:00.123-05:00','2026-02-30T12:00:00Z','2026-11-04T24:00:00Z','2026-11-04T12:00:00.1234Z','2026-11-04T12:00:00+16:00','0000-01-01T00:00:00Z'])assert.equal((await f.pg.query<{valid:boolean}>('SELECT public.automation_instant_valid($1::jsonb) AS valid',[JSON.stringify(occurredAt)])).rows[0].valid,ruleSample.safeParse({...f.sample,occurredAt}).success,occurredAt);
});
check('an upper-reviewed disable-only change remains possible after a named recipient leaves the visible hub',async f=>{
 const definition={...f.definition,actions:[{...f.definition.actions[0],audience:{kind:'people',personIds:[f.actors.staff.person]}}]},created=await f.create({definition});assert.equal(created.response.status,201,JSON.stringify(created.body));
 await f.pg.query('UPDATE public.people SET hub_id=$2 WHERE id=$1',[f.actors.staff.person,f.otherHub]);
 const stopped=await f.change(created.body.data.id,{definition:{...definition,enabled:false}},'manager');assert.equal(stopped.response.status,202,JSON.stringify(stopped.body));assert.equal((await f.approve(stopped.body.approval.id)).response.status,200);assert.equal((await f.request('automations/rules/'+created.body.data.id)).body.data.definition.enabled,false);
 const reenabled=await f.change(created.body.data.id,{expectedVersion:2,definition},'manager');assert.equal(reenabled.response.status,404,'re-enabling must recheck the now-hidden named audience');
});

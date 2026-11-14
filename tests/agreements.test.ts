import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { jsonBody } from '../src/core/api.ts';

async function fixture() {
  const f=await operationsFixture();
  for(const role of [f.staffRole,f.managerRole])for(const cap of ['agreements.view','agreements.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
  const input={name:'Unified enrollment',legalEntityName:'Kavosh Al and Robotics Academy Inc.',countryCode:'CA',jurisdiction:'Ontario',hubId:f.hub,
    languages:[{locale:'en',title:'Enrollment agreement, waiver and consent',body:'  Exact unified contract text.\nKeep line endings.  '},{locale:'fr',title:'Inscription',body:'Texte français.'},{locale:'zh-CN',title:'注册协议',body:'统一协议文本。'}],reason:'Private agreement review note'};
  async function create(body:unknown=input,as='master',key?:string){return f.request('agreements',body,as,key?{key}:{});}
  return {...f,input,create};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('unified agreement definitions preserve exact multilingual text, canonical definition hashes and immutable reviewed revisions',async f=>{
  const made=await f.create();assert.equal(made.response.status,201,JSON.stringify(made.body));const t=made.body.data;
  assert.equal(t.available,false);assert.equal(t.definition.kind,'unified_enrollment');assert.equal(t.definition.format,'plain_text');assert.deepEqual(t.definition.languages,f.input.languages);
  const canonical={name:f.input.name,legalEntityName:f.input.legalEntityName,countryCode:'CA',jurisdiction:'Ontario',languages:f.input.languages,provider:null,kind:'unified_enrollment',format:'plain_text',available:false};
  assert.equal(t.definition_hash,createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));assert.equal(t.definition.reason,undefined);
  const change=await f.request('agreements/'+t.id+'/change',{expectedVersion:1,name:'Renamed template',reason:'Rename without erasing terms'});assert.equal(change.response.status,200,JSON.stringify(change.body));assert.deepEqual(change.body.data.definition.languages,f.input.languages);assert.equal(change.body.data.available,false);assert.equal(change.body.data.definition.legalEntityName,f.input.legalEntityName);
  const link=await f.request('agreements/'+t.id+'/change',{expectedVersion:2,provider:{region:'CA',templateId:randomUUID()},available:true,reason:'Configure provider mapping only'});assert.equal(link.response.status,200);assert.equal(link.body.data.eligible,undefined);assert.equal(link.body.data.signed,undefined);
  const history=await f.request('agreements/'+t.id+'/history?limit=1');assert.equal(history.body.data[0].definition.name,f.input.name);assert.equal(history.body.data[0].definition_hash,t.definition_hash);assert.equal(history.body.nextVersion,1);
  assert.equal((await f.request('agreements/'+t.id+'/history?afterVersion=1')).body.data.length,2);
  const audit=JSON.stringify((await f.request('audit-events')).body.data.filter((e:{action:string})=>e.action.startsWith('agreement.template.')));assert.ok(!audit.includes(f.input.languages[0].body));assert.ok(!audit.includes(f.input.reason));
});
check('agreement changes wait for upper human approval, bind exact revisions and remain hidden after private-view revocation',async f=>{
  const pending=await f.create(f.input,'staff');assert.equal(pending.response.status,202);assert.equal((await f.request('agreements')).body.data.length,0);
  assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);
  const approved=await f.approve(pending.body.approval.id,'manager');assert.equal(approved.response.status,200,JSON.stringify(approved.body));const id=approved.body.data.id;
  const change=await f.request('agreements/'+id+'/change',{expectedVersion:1,available:true,reason:'Propose selection availability'},'staff');assert.equal(change.response.status,202);
  assert.equal((await f.request('agreements/'+id+'/change',{expectedVersion:1,name:'Intervening correction',reason:'Fresh correction'})).response.status,200);
  const stale=await f.approve(change.body.approval.id,'manager');assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');
  const privateCase=await f.create({...f.input,name:'Private queued definition'},'staff');assert.equal(privateCase.response.status,202);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='agreements.view'",[f.managerRole]);
  assert.equal((await f.request('approvals/'+privateCase.body.approval.id,undefined,'manager')).response.status,404);assert.equal((await f.approve(privateCase.body.approval.id,'manager')).response.status,404);
});
check('agreement view/edit scopes separate hub, academy-wide, explicit-deny and foreign-school definitions',async f=>{
  const own=await f.create(),other=await f.create({...f.input,hubId:f.otherHub}),shared=await f.create({...f.input,hubId:null});for(const r of [own,other,shared])assert.equal(r.response.status,201);
  const list=await f.request('agreements',undefined,'staff');assert.deepEqual(list.body.data.map((r:{id:string})=>r.id),[own.body.data.id]);assert.equal(list.body.data[0].definition,undefined);
  for(const r of [other,shared])for(const suffix of ['', '/history'])assert.equal((await f.request('agreements/'+r.body.data.id+suffix,undefined,'staff')).response.status,404);
  assert.equal((await f.create({...f.input,hubId:null},'staff')).response.status,403);
  assert.equal((await f.request('agreements/'+own.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
  const role=await f.request('roles',{name:'Agreement hub exclusion',permissions:[{capability:'agreements.view',effect:'deny'}]});assert.equal(role.response.status,201);
  const before=await f.request('people/'+f.actors.staff.person+'/access');assert.equal((await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:before.body.data.version,assignments:[{roleId:f.staffRole,allHubs:true},{roleId:role.body.data.id,allHubs:false,hubIds:[f.otherHub]}]})).response.status,200);
  assert.equal((await f.request('agreements/'+shared.body.data.id,undefined,'staff')).response.status,404,'excluding any hub must not become academy-wide shared access');
  assert.equal((await f.request('agreements/'+other.body.data.id,undefined,'staff')).response.status,404);
});
check('copying a pinned agreement revision preserves old content, requires source and destination rights, and never activates the copy',async f=>{
  const source=await f.create({...f.input,hubId:f.otherHub,available:true});assert.equal(source.response.status,201);const id=source.body.data.id;
  assert.equal((await f.request('agreements/'+id+'/change',{expectedVersion:1,languages:[{locale:'en',title:'New text',body:'Replacement text'}],reason:'Replace current wording'})).response.status,200);
  const duplicate={sourceVersion:1,name:'Pinned copy',hubId:f.hub,reason:'Copy reviewed old definition'};
  assert.equal((await f.request('agreements/'+id+'/duplicate',duplicate,'staff')).response.status,404);
  const copied=await f.request('agreements/'+id+'/duplicate',duplicate);assert.equal(copied.response.status,201,JSON.stringify(copied.body));assert.deepEqual(copied.body.data.definition.languages,f.input.languages);assert.equal(copied.body.data.available,false);
  const view=await f.request('roles',{name:'Source agreement viewing',permissions:[{capability:'agreements.view',effect:'allow'}]});assert.equal(view.response.status,201);
  for(const actor of ['staff','manager']) {
    const person=f.actors[actor].person,prior=await f.request('people/'+person+'/access');
    assert.equal((await f.request('people/'+person+'/access',{expectedVersion:prior.body.data.version,assignments:[{roleId:actor==='staff'?f.staffRole:f.managerRole,allHubs:false,hubIds:[f.hub]},{roleId:view.body.data.id,allHubs:false,hubIds:[f.otherHub]}]})).response.status,200);
  }
  const pending=await f.request('agreements/'+id+'/duplicate',duplicate,'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));
  assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'manager')).response.status,404,'destination-only approval scope cannot expose the other hub source text');
  assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,404);assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
});
check('agreement strict inputs and text budgets reject forgery, duplicate locales, silent reparenting and invented signing clearance',async f=>{
  for(const patch of [{kind:'waiver_only'},{format:'html'},{signed:true},{eligible:true},{definition_hash:'f'.repeat(64)},{source:{templateId:randomUUID(),version:1}},
    {languages:[f.input.languages[0],f.input.languages[0]]},{languages:[{locale:'en',title:'Empty',body:'   '}]},{languages:[{locale:'en',title:'Oversized',body:'x'.repeat(32001)}]},
    {name:'Malformed\ud800'},{languages:[{locale:'en',title:'Invalid Unicode',body:'Null\0character'}]},{languages:[{locale:'en',title:'Invalid Unicode',body:'Unpaired\udc00'}]},
    {provider:{region:'https://localhost',templateId:randomUUID()}},{provider:{region:'CA',templateId:randomUUID(),apiKey:'not-a-template-field'}},{reason:''}])
    assert.equal((await f.create({...f.input,...patch})).response.status,400,JSON.stringify(patch).slice(0,120));
  const made=await f.create();assert.equal(made.response.status,201);const id=made.body.data.id;
  for(const patch of [{hubId:f.otherHub},{reason:'No editable fields'}, {languages:[]}])assert.equal((await f.request('agreements/'+id+'/change',{expectedVersion:1,reason:'Correction',...patch})).response.status,400);
  assert.equal((await f.request('agreements?limit=101')).response.status,400);assert.equal((await f.request('agreements/'+id+'/history?afterVersion=-1')).response.status,400);
  assert.equal((await f.request('agreements/'+id+'/duplicate',{sourceVersion:99,name:'Missing revision',hubId:f.hub,reason:'No such revision'})).response.status,404);
});
check('full multilingual legal text fits the explicit byte budget and directory paging never includes its body',async f=>{
  const languages=f.input.languages.map(l=>({...l,body:'中'.repeat(20000)})),large=await f.create({...f.input,languages});assert.equal(large.response.status,201,JSON.stringify(large.body));
  assert.deepEqual(large.body.data.definition.languages,languages);assert.equal((await f.create({...f.input,languages:languages.map(l=>({...l,body:l.body+'中'.repeat(2000)}))})).response.status,400);
  const made=await f.create({...f.input,name:'Second definition'});assert.equal(made.response.status,201);
  const first=await f.request('agreements?limit=1');assert.equal(first.body.data.length,1);assert.ok(first.body.nextCursor);assert.equal(first.body.data[0].definition,undefined);
  const next=await f.request('agreements?limit=1&after='+first.body.nextCursor);assert.equal(next.body.data.length,1);assert.notEqual(next.body.data[0].id,first.body.data[0].id);
  assert.equal((await f.request('agreements?q=Second')).body.data[0].id,made.body.data.id);
});
check('management bots can propose agreement changes but cannot approve or bypass their hub ceiling',async f=>{
  const proposed=await f.create(f.input,'bot');assert.equal(proposed.response.status,202,JSON.stringify(proposed.body));assert.equal((await f.approve(proposed.body.approval.id,'bot')).response.status,403);
  const applied=await f.approve(proposed.body.approval.id);assert.equal(applied.response.status,200);
  assert.equal((await f.create({...f.input,hubId:f.otherHub},'bot')).response.status,403);
});
test('business JSON parsing rejects invalid UTF-8 rather than silently changing signed agreement source text',async()=>{
  const make=(body:Uint8Array)=>new Request('https://academy.example',{method:'POST',headers:{'content-type':'application/json'},body:Buffer.from(body)});
  const valid=Buffer.from('{"text":"中文 — Français"}');assert.deepEqual(await jsonBody(make(valid)),{text:'中文 — Français'});
  const corrupt=Buffer.concat([Buffer.from('{"text":"'),Buffer.from([0xff]),Buffer.from('"}')]);await assert.rejects(jsonBody(make(corrupt)),{code:'INVALID_JSON',status:400});
  await assert.rejects(jsonBody(make(valid),valid.byteLength-1),{code:'BODY_TOO_LARGE',status:413});
});
check('agreement availability requires an active hub and pending copies are invalidated when source access is revoked',async f=>{
  await f.pg.query('UPDATE public.hubs SET active=false WHERE id=$1',[f.hub]);
  assert.equal((await f.create({...f.input,available:true})).response.status,409);const draft=await f.create();assert.equal(draft.response.status,201);
  assert.equal((await f.request('agreements/'+draft.body.data.id+'/change',{expectedVersion:1,available:true,reason:'Cannot enable inactive hub'})).response.status,409);
  await f.pg.query('UPDATE public.hubs SET active=true WHERE id=$1',[f.hub]);
  const copy=await f.request('agreements/'+draft.body.data.id+'/duplicate',{sourceVersion:1,name:'Pending copy',hubId:f.hub,reason:'Needs source authority'},'staff');assert.equal(copy.response.status,202);
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='agreements.view'",[f.staffRole]);assert.equal((await f.approve(copy.body.approval.id)).response.status,409);
});
check('private approval review and withdrawal notes stay in authorized cases, never general audit, including legacy stored notes',async f=>{
  const note='Private reviewer narrative',why='Private withdrawal narrative',legacy='Private legacy audit narrative';
  const pending=await f.create(f.input,'staff');assert.equal(pending.response.status,202);
  assert.equal((await f.request('approvals/'+pending.body.approval.id+'/decide',{expectedVersion:1,decision:'reject',reason:note},'manager')).response.status,200);
  assert.equal((await f.request('approvals/'+pending.body.approval.id)).body.data.reason,note);
  const withdrawn=await f.create(f.input,'staff');assert.equal(withdrawn.response.status,202);assert.equal((await f.request('approvals/'+withdrawn.body.approval.id+'/withdraw',{expectedVersion:1,reason:why},'staff')).response.status,200);
  assert.equal((await f.request('approvals/'+withdrawn.body.approval.id)).body.data.reason,why);
  const stored=(await f.pg.query<{changes:Record<string,unknown>}>("SELECT changes FROM public.audit_events WHERE action IN ('approval.rejected','approval.withdrawn')")).rows;
  for(const row of stored){assert.equal(row.changes.reason,undefined);assert.equal(row.changes.hasReason,true);}
  const legacyId=randomUUID();
  await f.pg.query(`INSERT INTO public.audit_events(academy_id,id,actor_id,session_id,actor_kind,request_id,action,entity_id,hub_id,changes)
    VALUES($1,$2,$3,$4,'human',$5,'approval.rejected',$6,NULL,$7::jsonb)`,[f.a,legacyId,f.actors.master.person,f.actors.master.session,randomUUID(),pending.body.approval.id,JSON.stringify({reason:legacy})]);
  const audit=(await f.request('audit-events')).body.data,legacyView=audit.find((r:{id:string})=>r.id===legacyId);assert.ok(legacyView);assert.equal(legacyView.changes.reason,undefined);assert.equal(legacyView.changes.hasReason,true);
  for(const text of [note,why,legacy])assert.ok(!JSON.stringify(audit).includes(text));
  assert.equal((await f.pg.query<{changes:{reason:string}}>('SELECT changes FROM public.audit_events WHERE id=$1',[legacyId])).rows[0].changes.reason,legacy,'append-only storage is not rewritten for read redaction');
  const ordinary=await f.proposal('Non-private policy case');
  assert.equal((await f.request('approvals/'+ordinary.id+'/decide',{expectedVersion:1,decision:'reject',reason:'Non-private policy review'})).response.status,200);
  const normal=(await f.request('audit-events')).body.data.find((r:{entity_id:string;action:string})=>r.entity_id===ordinary.id&&r.action==='approval.rejected');assert.equal(normal.changes.reason,'Non-private policy review','non-private policy history keeps its ordinary review reason');
});
check('agreement storage is tenant-bound, immutable in history and atomic with retries, audit and outbox',async f=>{
  const key=randomUUID(),made=await f.create(f.input,'master',key);assert.equal(made.response.status,201);assert.deepEqual((await f.create(f.input,'master',key)).body,made.body);const id=made.body.data.id;
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.request('agreements/'+id+'/change',{expectedVersion:1,available:true,reason:'Rollback on event failure'})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.request('agreements/'+id)).body.data.version,1);assert.equal((await f.pg.query('SELECT * FROM public.agreement_template_revisions')).rows.length,1);
  await assert.rejects(f.pg.query('UPDATE public.agreement_templates SET hub_id=$2 WHERE id=$1',[id,f.foreignHub]),/foreign key/i);
  await assert.rejects(f.pg.query('UPDATE public.agreement_templates SET version=99 WHERE id=$1',[id]),/foreign key/i);
  await f.pg.exec('SET ROLE kavosh_runtime');try{
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.agreement_templates')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.agreement_template_revisions')).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.query('UPDATE public.agreement_templates SET hub_id=$2 WHERE id=$1',[id,f.otherHub]),/permission denied/i);await assert.rejects(f.pg.query("UPDATE public.agreement_template_revisions SET definition='{}' WHERE template_id=$1",[id]),/permission denied/i);
  }finally{await f.pg.exec('RESET ROLE');}
});
if(process.env.TEST_DATABASE_URL)check('concurrent agreement corrections preserve one current revision without lost history',async f=>{
  const made=await f.create();assert.equal(made.response.status,201);const id=made.body.data.id;
  const changed=await Promise.all(['First','Second'].map(name=>f.request('agreements/'+id+'/change',{expectedVersion:1,name,reason:'Concurrent correction'})));assert.deepEqual(changed.map(r=>r.response.status).sort(),[200,409]);assert.equal((await f.pg.query('SELECT * FROM public.agreement_template_revisions')).rows.length,2);
});
if(process.env.TEST_DATABASE_URL)check('an agreement correction waiting behind a committed revision returns a version conflict, never a false missing record',async f=>{
  const made=await f.create();assert.equal(made.response.status,201);const current=made.body.data,id=current.id;
  await f.pg.exec('BEGIN');let open=true;
  await f.pg.query('SELECT id FROM public.agreement_templates WHERE id=$1 FOR UPDATE',[id]);
  const pending=f.request('agreements/'+id+'/change',{expectedVersion:1,name:'Stale waiting correction',reason:'Must see the committed revision'});
  try {
    let waiting=false;
    for(let attempt=0;attempt<200;attempt++) {
      await f.pg.query('SELECT pg_stat_clear_snapshot()');
      const blocked=await f.pg.query<{count:number}>(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock' AND query LIKE '%agreement_templates%' AND query LIKE '%FOR UPDATE%'`);
      if(blocked.rows[0].count>0){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(waiting,true,'prove the request reached its row-lock wait before changing the revision');
    // Test-only owner write models the earlier transaction's complete commit;
    // the deferred current-revision FK still has to be satisfied atomically.
    await f.pg.query('UPDATE public.agreement_templates SET version=2 WHERE id=$1',[id]);
    await f.pg.query(`INSERT INTO public.agreement_template_revisions(academy_id,template_id,version,definition,definition_hash,changed_by,approval_id,reason)
      VALUES($1,$2,2,$3::jsonb,$4,$5,$6,'Coordinated earlier transaction')`,[f.a,id,JSON.stringify(current.definition),current.definition_hash,f.actors.master.person,current.last_approval_id]);
    await f.pg.exec('COMMIT');open=false;
    const result=await pending;assert.equal(result.response.status,409,JSON.stringify(result.body));assert.equal(result.body.error.code,'TARGET_CHANGED');
    assert.equal((await f.request('agreements/'+id)).body.data.version,2);assert.equal((await f.pg.query('SELECT * FROM public.agreement_template_revisions WHERE template_id=$1',[id])).rows.length,2);
  }finally{if(open)await f.pg.exec('ROLLBACK');await pending;}
});

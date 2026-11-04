import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture(){
  const f=await operationsFixture();
  for(const capability of ['periods.view','periods.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.policyRole,capability]);
  const period=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/periods',{name:'Synthetic fiscal 2026',startsOn:'2026-01-01',endsOn:'2026-12-31',reason:'Synthetic fiscal setup',...patch},as,{key});
  return {...f,period};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('explicit fiscal periods support calendar and non-calendar years with exact inclusive lookup and real persisted history',async f=>{
  const p=await f.period();assert.equal(p.response.status,201,JSON.stringify(p.body));assert.equal(p.body.data.startsOn,'2026-01-01');assert.equal(p.body.data.endsOn,'2026-12-31');assert.equal(p.body.data.state,'open');
  assert.equal((await f.request('finance/periods?on=2026-01-01')).body.data.length,1);assert.equal((await f.request('finance/periods?on=2026-12-31')).body.data.length,1);assert.equal((await f.request('finance/periods?on=2027-01-01')).body.data.length,0);
  assert.equal((await f.period({name:'Custom fiscal year',startsOn:'2027-04-01',endsOn:'2028-03-31'})).response.status,201);
  const history=await f.request('finance/periods/'+p.body.data.id+'/history');assert.equal(history.body.data[0].approvalId,p.body.approval.id);assert.equal(history.body.data[0].reason,'Synthetic fiscal setup');
});
check('closing, reopening and voiding are reviewed append-only transitions rather than deletion or silent date changes',async f=>{
  const p=await f.period({translations:{en:'Fiscal year',fr:'Exercice','zh-CN':'会计年度'}}),id=p.body.data.id;
  assert.equal((await f.request('finance/periods/'+id+'/change',{expectedVersion:1,state:'void',reason:'Cannot void an open period'})).body.error.code,'PERIOD_TRANSITION_INVALID');
  const close=await f.request('finance/periods/'+id+'/change',{expectedVersion:1,state:'closed',reason:'Synthetic close'});assert.equal(close.response.status,200,JSON.stringify(close.body));
  assert.equal((await f.request('finance/periods/'+id+'/change',{expectedVersion:1,state:'open',reason:'Stale reopen'})).body.error.code,'TARGET_CHANGED');
  const reopen=await f.request('finance/periods/'+id+'/change',{expectedVersion:2,state:'open',translations:{fr:null},reason:'Reviewed reopen'});assert.equal(reopen.response.status,200);assert.equal(reopen.body.data.name,'Synthetic fiscal 2026');assert.deepEqual(reopen.body.data.translations,{en:'Fiscal year','zh-CN':'会计年度'});
  await f.request('finance/periods/'+id+'/change',{expectedVersion:3,state:'closed',reason:'Close before void'});
  const voided=await f.request('finance/periods/'+id+'/change',{expectedVersion:4,state:'void',reason:'Synthetic empty period replacement'});assert.equal(voided.response.status,200);assert.equal(voided.body.data.state,'void');
  assert.equal((await f.request('finance/periods/'+id+'/change',{expectedVersion:5,state:'open',reason:'Must not restore void'})).body.error.code,'PERIOD_TRANSITION_INVALID');
  assert.equal((await f.period({name:'Corrected empty period'})).response.status,201);assert.equal((await f.request('finance/periods/'+id+'/history')).body.data.length,5);
});
check('financial period writes require upper human approval and current school-wide rights; viewers do not receive private history',async f=>{
  const pending=await f.period({},'manager');assert.equal(pending.response.status,202);assert.equal((await f.request('finance/periods')).body.data.length,0);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,403);
  const approved=await f.approve(pending.body.approval.id);assert.equal(approved.response.status,200,JSON.stringify(approved.body));const id=approved.body.data.id;
  await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='periods.edit'",[f.policyRole]);assert.equal((await f.request('finance/periods',undefined,'manager')).response.status,200);assert.equal((await f.request('finance/periods/'+id+'/history',undefined,'manager')).response.status,403);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'periods.view','allow')",[f.a,f.staffRole]);assert.equal((await f.request('finance/periods',undefined,'staff')).response.status,403);assert.equal((await f.request('finance/periods/'+id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
});
check('period setup rejects overlaps, malformed dates, client state injection and ownership changes; retries and event rollback remain atomic',async f=>{
  const key=randomUUID(),p=await f.period({},'master',key);assert.deepEqual((await f.period({},'master',key)).body,p.body);const id=p.body.data.id;
  assert.equal((await f.period({startsOn:'2026-12-31',endsOn:'2027-01-31'})).body.error.code,'PERIOD_OVERLAP');assert.equal((await f.period({startsOn:'2027-01-01',endsOn:'2027-01-31'})).response.status,201);
  for(const patch of [{startsOn:'2026-02-30'},{startsOn:'0000-01-01'},{startsOn:'2027-01-01'},{state:'closed'},{balance:'1'},{translations:{de:'Jahr'}}])assert.equal((await f.period(patch)).response.status,400);
  assert.equal((await f.request('finance/periods/'+id+'/change',{expectedVersion:1,startsOn:'2026-02-01',reason:'Immutable dates'})).response.status,400);
  await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.request('finance/periods/'+id+'/change',{expectedVersion:1,state:'closed',reason:'Must roll back'})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
  assert.equal((await f.request('finance/periods/'+id)).body.data.state,'open');assert.equal((await f.request('finance/periods/'+id+'/history')).body.data.length,1);
});
check('native periods enforce immutable dates/history, tenant isolation, overlap exclusion and matching contiguous current revisions',async f=>{
  const p=await f.period(),id=p.body.data.id;
  await f.pg.exec('SET ROLE kavosh_runtime');try{
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.finance_period_catalogue')).rows.length,0);
    await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
    for(const sql of ['UPDATE public.finance_periods SET starts_on=starts_on+1','DELETE FROM public.finance_periods','DELETE FROM public.finance_period_revisions',"UPDATE public.finance_period_revisions SET reason='tamper'"])await assert.rejects(f.pg.exec(sql),/permission denied/i);
    await assert.rejects(f.pg.query("UPDATE public.finance_periods SET version=3,state='closed' WHERE id=$1",[id]),/FINANCE_VERSION_SEQUENCE/);
    await assert.rejects(f.pg.query("UPDATE public.finance_periods SET version=2,state='closed' WHERE id=$1",[id]),/foreign key|finance_period_current_revision/i);
    await assert.rejects(f.pg.query("INSERT INTO public.finance_periods(academy_id,id,starts_on,ends_on,created_by) VALUES($1,$2,'2026-02-01','2026-03-01',$3)",[f.a,randomUUID(),f.actors.master.person]),/exclusion|conflicting key/i);
  }finally{await f.pg.exec('RESET ROLE');}
});
check('pending period controls become stale after another revision and a bot cannot apply its own period proposal',async f=>{
  const p=await f.period(),id=p.body.data.id,pending=await f.request('finance/periods/'+id+'/change',{expectedVersion:1,state:'closed',reason:'Pending close'},'manager');assert.equal(pending.response.status,202);
  await f.request('finance/periods/'+id+'/change',{expectedVersion:1,name:'Revised title',reason:'Invalidate pending close'});const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');assert.equal((await f.request('finance/periods/'+id)).body.data.state,'open');
  const bot=await f.period({startsOn:'2027-01-01',endsOn:'2027-12-31'},'bot');assert.equal(bot.response.status,202);assert.equal((await f.approve(bot.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
});
if(process.env.TEST_DATABASE_URL)check('concurrent overlapping period creation commits one period and leaves no losing approval or history',async f=>{
  const results=await Promise.all([f.period(),f.period({startsOn:'2026-06-01',endsOn:'2027-05-31'})]);assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);assert.equal(results.find(r=>r.response.status===409)!.body.error.code,'PERIOD_OVERLAP');assert.equal((await f.request('finance/periods')).body.data.length,1);assert.equal((await f.pg.query('SELECT * FROM public.finance_period_revisions')).rows.length,1);
});

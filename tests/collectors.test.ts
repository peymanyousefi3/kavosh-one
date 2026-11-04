import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';

async function fixture(){
 const f=await operationsFixture(),made=async(path:string,input:unknown)=>{const r=await f.request(path,input);assert.equal(r.response.status,201,JSON.stringify({path,body:r.body,failures:f.metrics.queryFailures}));return r.body.data;};
 const currency=await made('finance/currencies',{code:'CAD',name:'Canadian dollar',unitScale:2,reason:'Synthetic currency'});
 const account=async(code:string,operationalRole:string,hubId:string|null=f.hub)=>made('finance/accounts',{code,name:'Synthetic '+code,kind:'asset',operationalRole,hubId,currencyId:currency.id,currencyVersion:1,reason:'Synthetic holding account'});
 const bank=await account('BANK','bank'),third=await account('DUE','collector_receivable'),globalBank=await account('SCHOOL','bank',null);
 const base={hubId:f.hub,code:'HUB',kind:'hub',custody:'third_party',name:'Synthetic hub collector',accounts:[{id:third.id,version:1}],reason:'Private collector review evidence'};
 const create=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('finance/collectors',{...base,...patch},as,{key});
 const grant=async(as='staff',caps=['collectors.view','collectors.edit','accounts.view','people.view'])=>{for(const cap of caps)await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,as==='manager'?f.managerRole:f.staffRole,cap]);};
 return {...f,made,currency,bank,third,globalBank,account,base,create,grant};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('collectors preserve explicit custody, authorized currency mappings and immutable versions without creating money',async f=>{
 const r=await f.create();assert.equal(r.response.status,201,JSON.stringify(r.body));assert.equal(r.body.data.custody,'third_party');assert.equal(r.body.data.accounts[0].id,f.third.id);assert.equal(r.body.data.paymentReceived,false);
 const changed=await f.request('finance/collectors/'+r.body.data.id+'/change',{expectedVersion:1,name:'New collector label',active:false,accounts:f.base.accounts,reason:'Retire with history'});assert.equal(changed.response.status,200,JSON.stringify(changed.body));
 const first=await f.request('finance/collectors/'+r.body.data.id+'/history?limit=1');assert.equal(first.body.data[0].name,f.base.name);assert.equal(first.body.nextVersion,1);assert.equal((await f.request('finance/collectors/'+r.body.data.id+'/history?afterVersion=1&limit=1')).body.data[0].name,'New collector label');
 assert.equal((await f.pg.query('SELECT * FROM public.finance_journals')).rows.length,0);assert.equal((await f.request('finance/collectors/'+r.body.data.id+'/change',{expectedVersion:2,name:'Forbidden owner change',active:true,accounts:f.base.accounts,custody:'academy_funds',reason:'Cannot change custody'})).response.status,400);
});
check('third-party money cannot use academy cash or student receivables, duplicate currencies or foreign-hub accounts',async f=>{
 const studentAR=await f.account('STUDENT','receivable'),otherBank=await f.account('OTHER','collector_receivable',f.otherHub);
 for(const id of [f.bank.id,studentAR.id,otherBank.id])assert.equal((await f.create({accounts:[{id,version:1}]})).response.status,400);
 const sameCurrency=await f.account('DUE2','collector_receivable');assert.equal((await f.create({accounts:[...f.base.accounts,{id:sameCurrency.id,version:1}]})).response.status,400);
 assert.equal((await f.create({accounts:[{id:f.third.id,version:99}]})).response.status,409);assert.equal((await f.create({kind:'academy',hubId:null,custody:'third_party'})).response.status,400);
 const good=await f.create({code:'SCHOOL',kind:'academy',hubId:null,custody:'academy_funds',accounts:[{id:f.globalBank.id,version:1}]});assert.equal(good.response.status,201,JSON.stringify(good.body));
});
check('shared collectors are selectable without exposing unauthorized account mappings, balances or history',async f=>{
 const shared=await f.create({code:'SHARED',kind:'academy',hubId:null,custody:'academy_funds',accounts:[{id:f.globalBank.id,version:1}]});assert.equal(shared.response.status,201);const hub=await f.create();assert.equal(hub.response.status,201);
 await f.grant('staff',['collectors.view']);const list=await f.request('finance/collectors',undefined,'staff');assert.equal(list.response.status,200);assert.equal(list.body.data.length,2);assert.ok(!JSON.stringify(list.body).includes(f.globalBank.id));
 const detail=await f.request('finance/collectors/'+shared.body.data.id,undefined,'staff');assert.deepEqual(detail.body.data.accounts,[]);assert.equal(detail.body.data.accountMappingsRestricted,true);assert.equal((await f.request('finance/collectors/'+shared.body.data.id+'/history',undefined,'staff')).response.status,403);
 await f.grant('staff',['collectors.edit']);const hist=await f.request('finance/collectors/'+hub.body.data.id+'/history',undefined,'staff');assert.equal(hist.response.status,200);assert.deepEqual(hist.body.data[0].accounts,[]);assert.equal(hist.body.data[0].accountMappingsRestricted,true);
 assert.equal((await f.request('finance/collectors/'+hub.body.data.id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
});
check('collector creation needs an upper human reviewer and cannot silently replace changed account metadata',async f=>{
 await f.grant();await f.grant('manager');const pending=await f.create({},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.pg.query('SELECT * FROM public.finance_collectors')).rows.length,0);
 assert.equal((await f.approve(pending.body.approval.id,'staff')).response.status,403);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);
 const stale=await f.create({code:'STALE'},'staff');assert.equal(stale.response.status,202);assert.equal((await f.request('finance/accounts/'+f.third.id+'/change',{expectedVersion:1,name:'Changed mapped account',reason:'Synthetic later revision'})).response.status,200);
 const refused=await f.approve(stale.body.approval.id,'manager');assert.equal(refused.response.status,409,JSON.stringify(refused.body));assert.equal((await f.pg.query('SELECT * FROM public.finance_collectors')).rows.length,1);
});
check('collector mutations are retry-safe, atomic, tenant-bound and append-only even at the native role boundary',async f=>{
 const key=randomUUID(),r=await f.create({},'master',key);assert.equal(r.response.status,201);assert.deepEqual((await f.create({},'master',key)).body,r.body);
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.create({code:'ROLLBACK'})).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.pg.query('SELECT * FROM public.finance_collectors')).rows.length,1);
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.finance_collectors')).rows.length,0);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);for(const sql of ["UPDATE public.finance_collectors SET custody='academy_funds'",'DELETE FROM public.finance_collectors',"UPDATE public.finance_collector_revisions SET name='Rewritten'"])await assert.rejects(f.pg.exec(sql),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
 const audit=JSON.stringify((await f.request('audit-events')).body);assert.ok(!audit.includes(f.base.reason));
});
check('person collectors bind existing active humans, prevent beneficiary review and hide revoked private proposals',async f=>{
 await f.grant();await f.grant('manager');const pending=await f.create({code:'PERSON',kind:'person',personId:f.actors.manager.person},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.approve(pending.body.approval.id,'manager')).body.error.code,'BENEFICIARY_REVIEW_FORBIDDEN');assert.equal((await f.approve(pending.body.approval.id)).response.status,200);
 const next=await f.create({code:'REVOKED'},'staff');assert.equal(next.response.status,202);await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='collectors.edit'",[f.staffRole]);assert.equal((await f.request('approvals/'+next.body.approval.id,undefined,'staff')).response.status,404);
 const botPerson=await f.create({code:'BOT',kind:'person',personId:f.bot});assert.equal(botPerson.response.status,400);assert.equal(botPerson.body.error.code,'HUMAN_PROFILE_REQUIRED');
 const botProposal=await f.create({code:'BOT-PROPOSAL'},'bot');assert.equal(botProposal.response.status,202,JSON.stringify(botProposal.body));assert.equal((await f.approve(botProposal.body.approval.id,'bot')).response.status,403);assert.equal((await f.approve(botProposal.body.approval.id)).response.status,200);
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.create({code:'CLOSED'})).response.status,403);
});

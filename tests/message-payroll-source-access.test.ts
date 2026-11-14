import assert from 'node:assert/strict';
import { test } from 'node:test';
import { t4aRecordFixture } from './t4a-record-fixture.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';
import { assertRuntimeRole } from '../src/core/database.ts';

test('actual382to383 preserves payrun facts while sender gets only a tenant-bound payroll permission boolean',async()=>{
 const f=await t4aRecordFixture({throughSchema:382});try{
 const before=(await f.pg.query('SELECT * FROM public.payrun_groups ORDER BY id')).rows,meta=(await f.pg.query("SELECT oid,proconfig FROM pg_proc WHERE oid='public.payrun_net_source_allows(uuid,text,jsonb)'::regprocedure")).rows;await upgradeToCurrent(f.pg);assert.deepEqual((await f.pg.query('SELECT * FROM public.payrun_groups ORDER BY id')).rows,before);assert.deepEqual((await f.pg.query("SELECT oid,proconfig FROM pg_proc WHERE oid='public.payrun_net_source_allows(uuid,text,jsonb)'::regprocedure")).rows,meta);const m=(await f.pg.query("SELECT proowner::regrole::text owner,prosecdef FROM pg_proc WHERE oid='public.payrun_net_source_allows(uuid,text,jsonb)'::regprocedure")).rows[0];assert.equal(m.owner,'kavosh_runtime');assert.equal(m.prosecdef,true);
 await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_message_worker');await assertRuntimeRole({query:f.pg.query.bind(f.pg),release(){}},'message_worker');assert.equal((await f.pg.query("SELECT has_table_privilege(current_user,'public.payrun_groups','SELECT') allowed")).rows[0].allowed,false);assert.equal((await f.pg.query("SELECT has_column_privilege(current_user,'public.payrun_groups','source_snapshot','SELECT') allowed")).rows[0].allowed,false);assert.equal((await f.pg.query('SELECT public.payrun_net_source_allows($1,$2,$3::jsonb) allowed',[f.run.id,'work-pay.view',JSON.stringify({all:true,hubs:[]})])).rows[0].allowed,true);for(const [cap,scope]of [[null,{all:true,hubs:[]}],['not-a-permission',{all:true,hubs:[]}],['work-pay.view',null],['work-pay.view',{all:false,hubs:[]}]])assert.equal((await f.pg.query('SELECT public.payrun_net_source_allows($1,$2,$3::jsonb) allowed',[f.run.id,cap,JSON.stringify(scope)])).rows[0].allowed,false);await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);assert.equal((await f.pg.query('SELECT public.payrun_net_source_allows($1,$2,$3::jsonb) allowed',[f.run.id,'work-pay.view',JSON.stringify({all:true,hubs:[]})])).rows[0].allowed,false);
 }finally{await f.pg.exec('ROLLBACK');}
 }finally{await f.pg.close();}
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { operationsFixture } from './operations-fixture.ts';

test('invitation lock upgrade preserves existing identity data and helper ownership',async()=>{
 const f=await operationsFixture({throughSchema:159});
 try{
  const snapshot=async()=>({users:(await f.pg.query('SELECT * FROM identity."user" ORDER BY id')).rows,sessions:(await f.pg.query('SELECT * FROM identity.session ORDER BY id')).rows,people:(await f.pg.query('SELECT * FROM public.people ORDER BY academy_id,id')).rows,helper:(await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid='identity.accept_invite(text,uuid,uuid)'::regprocedure")).rows});
  const before=await snapshot();await f.pg.exec(await readFile(new URL('../db/migrations/160_invitation_identity_locking.sql',import.meta.url),'utf8'));assert.deepEqual(await snapshot(),before);
 }finally{await f.pg.close();}
});
test('invitation cannot bind the former email after a pending profile contact correction',async()=>{
 const f=await operationsFixture();
 try{
  const user=f.actors.foreignMaster,person=randomUUID(),hash=randomUUID().replaceAll('-','').repeat(2);
  await f.pg.query("INSERT INTO public.people(academy_id,id,kind,name,email,hub_id,status) VALUES($1,$2,'human','Corrected recipient','corrected@example.test',$3,'pending')",[f.a,person,f.hub]);
  await f.pg.query("INSERT INTO identity.invites VALUES($1,$2,$3,'foreignmaster@example.test',false,now()+interval '1 day',NULL)",[hash,f.a,person]);
  await f.pg.exec('SET ROLE kavosh_identity');
  assert.equal((await f.pg.query<{code:string}>('SELECT * FROM identity.accept_invite($1,$2,$3)',[hash,user.user,user.session])).rows[0].code,'INVALID_INVITATION');
  await f.pg.exec('RESET ROLE');assert.equal((await f.pg.query<{auth_user_id:string|null}>('SELECT auth_user_id FROM public.people WHERE id=$1',[person])).rows[0].auth_user_id,null);
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

test('existing verified user becomes mandatory-MFA master before academy locking,without activation',async()=>{
 const f=await operationsFixture();let lock:Awaited<ReturnType<NonNullable<typeof f.pg.runtime>['connect']>>|undefined;
 try{
  const user=f.actors.staff,school=randomUUID(),person=randomUUID(),hash=randomUUID().replaceAll('-','').repeat(2);
  await f.pg.exec('BEGIN');await f.pg.query("INSERT INTO public.academies(id,name,master_person_id) VALUES($1,'Existing user invitation',$2)",[school,person]);
  await f.pg.query("INSERT INTO public.people(academy_id,id,kind,name,email,status) VALUES($1,$2,'human','New master','staff@example.test','pending')",[school,person]);await f.pg.exec('COMMIT');
  await f.pg.query("INSERT INTO identity.invites VALUES($1,$2,$3,'staff@example.test',true,now()+interval '1 day',NULL)",[hash,school,person]);
  await f.pg.query("UPDATE public.academies SET status='suspended' WHERE id=$1",[school]);await f.pg.exec('SET ROLE kavosh_identity');
  assert.equal((await f.pg.query<{code:string}>('SELECT * FROM identity.accept_invite($1,$2,$3)',[hash,user.user,user.session])).rows[0].code,'ACADEMY_UNAVAILABLE');await f.pg.exec('RESET ROLE');
  assert.equal((await f.pg.query<{mfaRequired:boolean}>('SELECT "mfaRequired" FROM identity."user" WHERE id=$1',[user.user])).rows[0].mfaRequired,false);
  assert.equal((await f.pg.query('SELECT * FROM identity.session WHERE "userId"=$1',[user.user])).rows.length,1);
  await f.pg.query("UPDATE public.academies SET status='provisioning' WHERE id=$1",[school]);
  if(f.pg.runtime){lock=await f.pg.runtime.connect();await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8))',[school]);}
  await f.pg.exec('SET ROLE kavosh_identity');await f.pg.query("SELECT set_config('lock_timeout','1500ms',false)");
  assert.equal((await f.pg.query<{code:string}>('SELECT * FROM identity.accept_invite($1,$2,$3)',[hash,user.user,user.session])).rows[0].code,'MFA_REQUIRED');
  await f.pg.exec('RESET ROLE');
  assert.equal((await f.pg.query<{mfaRequired:boolean}>('SELECT "mfaRequired" FROM identity."user" WHERE id=$1',[user.user])).rows[0].mfaRequired,true);
  assert.equal((await f.pg.query('SELECT * FROM identity.session WHERE "userId"=$1',[user.user])).rows.length,0);
  assert.equal((await f.pg.query<{status:string}>('SELECT status FROM public.academies WHERE id=$1',[school])).rows[0].status,'provisioning');
  assert.equal((await f.pg.query<{auth_user_id:string|null}>('SELECT auth_user_id FROM public.people WHERE id=$1',[person])).rows[0].auth_user_id,null);
  assert.equal((await f.pg.query('SELECT * FROM identity.invites WHERE token_hash=$1 AND consumed_at IS NULL',[hash])).rows.length,1);
 }finally{if(lock){await lock.query('ROLLBACK');lock.release();}await f.pg.exec('RESET ROLE');await f.pg.close();}
});

for(const duplicate of [false,true])test('native '+(duplicate?'duplicate-profile':'already-bound')+' invitation fails without waiting for the signed-in user',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await operationsFixture();let active:Awaited<ReturnType<NonNullable<typeof f.pg.runtime>['connect']>>|undefined,accept:typeof active;
 try{
  const user=f.actors.master,person=duplicate?randomUUID():user.person,hash=randomUUID().replaceAll('-','').repeat(2);
  if(duplicate)await f.pg.query("INSERT INTO public.people(academy_id,id,kind,name,email,hub_id,status) VALUES($1,$2,'human','Duplicate pending profile','master@example.test',$3,'pending')",[f.a,person,f.hub]);
  await f.pg.query("INSERT INTO identity.invites VALUES($1,$2,$3,'master@example.test',$4,now()+interval '1 day',NULL)",[hash,f.a,person,!duplicate]);
  active=await f.pg.runtime!.connect();await active.query('BEGIN');await active.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
  assert.equal((await active.query<{valid:boolean}>('SELECT public.lock_human($1,$2) AS valid',[user.session,user.user])).rows[0].valid,true);
  accept=await f.pg.runtime!.connect();await accept.query('SET ROLE kavosh_identity');await accept.query("SET lock_timeout='1500ms'");
  const result=await accept.query<{code:string}>('SELECT * FROM identity.accept_invite($1,$2,$3)',[hash,user.user,user.session]);
  assert.equal(result.rows[0].code,'INVALID_INVITATION');
  assert.equal((await f.pg.query<{auth_user_id:string|null}>('SELECT auth_user_id FROM public.people WHERE id=$1',[person])).rows[0].auth_user_id,duplicate?null:user.user);
  assert.equal((await f.pg.query('SELECT * FROM identity.invites WHERE token_hash=$1 AND consumed_at IS NULL',[hash])).rows.length,1);
 }finally{if(active){await active.query('ROLLBACK');active.release();}accept?.release();await f.pg.close();}
});

test('native valid pending invitation shares verified identity locks with work in another school',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await operationsFixture();let active:Awaited<ReturnType<NonNullable<typeof f.pg.runtime>['connect']>>|undefined,accept:typeof active;
 try{
  const user=f.actors.foreignMaster,person=randomUUID(),hash=randomUUID().replaceAll('-','').repeat(2);
  await f.pg.query("INSERT INTO public.people(academy_id,id,kind,name,email,hub_id,status) VALUES($1,$2,'human','New school profile','foreignmaster@example.test',$3,'pending')",[f.a,person,f.hub]);
  await f.pg.query("INSERT INTO identity.invites VALUES($1,$2,$3,'foreignmaster@example.test',false,now()+interval '1 day',NULL)",[hash,f.a,person]);
  active=await f.pg.runtime!.connect();await active.query('BEGIN');await active.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);
  assert.equal((await active.query<{valid:boolean}>('SELECT public.lock_human($1,$2) AS valid',[user.session,user.user])).rows[0].valid,true);
  accept=await f.pg.runtime!.connect();await accept.query('SET ROLE kavosh_identity');await accept.query("SET lock_timeout='1500ms'");
  assert.equal((await accept.query<{code:string}>('SELECT * FROM identity.accept_invite($1,$2,$3)',[hash,user.user,user.session])).rows[0].code,'ACCEPTED');
  assert.equal((await f.pg.query<{auth_user_id:string}>('SELECT auth_user_id FROM public.people WHERE id=$1',[person])).rows[0].auth_user_id,user.user);
 }finally{if(active){await active.query('ROLLBACK');active.release();}accept?.release();await f.pg.close();}
});

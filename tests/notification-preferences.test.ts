import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { operationsFixture } from './operations-fixture.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';

type F=Awaited<ReturnType<typeof operationsFixture>>;
const path='me/notification-preferences';
const choice=(expectedVersion=0)=>({expectedVersion,emailEnabled:true,smsEnabled:true,locale:'fr',acknowledgedNoticeVersion:1});
function privateReply(body:unknown){assert.doesNotMatch(JSON.stringify(body),/owner_epoch|ownerEpoch|email_epoch|emailEpoch|phone_epoch|phoneEpoch|auth_user_id|example[.]test|[+]1647/);}
function check(name:string,run:(f:F)=>Promise<void>){test(name,async()=>{const f=await operationsFixture();try{await run(f);}finally{await f.pg.close();}});}
async function login(f:F,as='staff'){const a=f.actors[as];a.session=randomUUID();await f.pg.query('INSERT INTO identity.session(id,token,"userId","expiresAt","updatedAt","mfaVerified") VALUES($1,$2,$3,now()+interval \'1 day\',now(),true)',[a.session,'synthetic-new-login-'+randomUUID(),a.user]);}

check('operational preferences default off and preserve mandatory portal notices with durable self-only history',async f=>{
 const first=await f.request(path,undefined,'staff');assert.equal(first.response.status,200);assert.equal(first.body.data.version,0);assert.deepEqual(first.body.data.email,{enabled:false,effective:false,renewalRequired:false});assert.equal(first.body.portalNoticesMandatory,true);assert.equal(first.body.externalDeliveryEnabled,false);privateReply(first.body);
 const key=randomUUID(),saved=await f.request(path,choice(),'staff',{key});assert.equal(saved.response.status,201,JSON.stringify(saved.body));assert.equal(saved.body.data.version,1);assert.equal(saved.body.data.email.effective,true);assert.equal(saved.body.data.sms.effective,true);assert.equal(saved.body.marketingConsentGranted,false);privateReply(saved.body);
 assert.deepEqual((await f.request(path,choice(),'staff',{key})).body,saved.body);
 assert.equal((await f.request(path,{...choice(),locale:'en'},'staff',{key})).response.status,409);
 assert.equal((await f.request(path,choice(),'staff')).response.status,409);
 const edited=await f.request(path,{...choice(1),smsEnabled:false,locale:'zh-CN'},'staff');assert.equal(edited.response.status,200);assert.equal(edited.body.data.sms.effective,false);
 assert.equal((await f.request(path,choice(),'staff',{key})).response.status,409,'an old opt-in receipt must not present superseded preferences as current');
 const history=await f.request(path+'/history?limit=1',undefined,'staff');assert.equal(history.body.data[0].version,2);assert.equal(history.body.nextCursor,2);privateReply(history.body);
 const next=await f.request(path+'/history?beforeVersion=2&limit=1',undefined,'staff');assert.equal(next.body.data[0].version,1);assert.equal(next.body.nextCursor,null);privateReply(next.body);
 assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE action='notification-preferences.changed'")).rows.length,2);assert.equal((await f.pg.query("SELECT * FROM public.outbox_events WHERE event_type='notification-preferences.changed'")).rows.length,2);
 assert.equal((await f.pg.query('SELECT * FROM identity.delivery_outbox')).rows.length,0,'preference writes must not send external messages');
 assert.equal((await f.request(path,undefined,'manager')).body.data.version,0);assert.equal((await f.request(path+'/history',undefined,'manager')).body.data.length,0);
});

check('preferences cannot be opted in by bots or administrators for another person and strict boundaries fail closed',async f=>{
 for(const as of ['bot'])for(const suffix of ['', '/disable','/history'])assert.equal((await f.request(path+suffix,suffix==='/history'?undefined:choice(),as)).response.status,403);
 assert.equal((await f.request('people/'+f.actors.staff.person+'/notification-preferences',choice())).response.status,404);
 for(const body of [{...choice(),personId:f.actors.staff.person},{...choice(),academyId:f.b},{...choice(),acknowledgedNoticeVersion:2},{...choice(),emailEnabled:'true'},{...choice(),expectedVersion:-1},{...choice(),locale:'zh-TW'}])assert.equal((await f.request(path,body,'master')).response.status,400);
 for(const suffix of ['?personId='+f.actors.master.person,'?limit=1','/history?limit=51','/history?limit=1&limit=2','/history?beforeVersion=0'])assert.equal((await f.request(path+suffix,undefined,'staff')).response.status,400);
 assert.equal((await f.request(path,undefined,'staff',{method:'DELETE'})).response.status,405);assert.equal((await f.request(path+'/disable',undefined,'staff')).response.status,405);
 assert.equal((await f.request(path,undefined,'staff',{academy:f.b})).response.status,401);
 await f.pg.query('UPDATE identity."user" SET "emailVerified"=false WHERE id=$1',[f.actors.staff.user]);assert.equal((await f.request(path,choice(),'staff')).response.status,401);
 assert.equal((await f.pg.query('SELECT * FROM public.notification_preferences')).rows.length,0);
});

check('native synchronous contact changes invalidate only the affected channel before notification publication and never revive old consent',async f=>{
 assert.equal((await f.request(path,choice(),'staff')).response.status,201);
 await f.pg.query('UPDATE identity."user" SET "phoneNumber"=$2 WHERE id=$1',[f.actors.staff.user,'+16479990888']);await login(f);
 assert.equal((await f.pg.query('SELECT * FROM public.account_security_events')).rows.length,0,'no background publication needed for invalidation');
 let data=(await f.request(path,undefined,'staff')).body.data;assert.equal(data.email.effective,true);assert.deepEqual(data.sms,{enabled:true,effective:false,renewalRequired:true});
 const renewed=await f.request(path,choice(1),'staff');assert.equal(renewed.response.status,200);assert.equal(renewed.body.data.sms.effective,true);
 await f.pg.query('UPDATE identity."user" SET email=$2 WHERE id=$1',[f.actors.staff.user,'new-notification@example.test']);await login(f);
 data=(await f.request(path,undefined,'staff')).body.data;assert.equal(data.email.effective,false);assert.equal(data.sms.effective,true);assert.equal(data.email.renewalRequired,true);
 await f.pg.query('UPDATE identity."user" SET email=$2 WHERE id=$1',[f.actors.staff.user,'staff@example.test']);await login(f);
 assert.equal((await f.request(path,undefined,'staff')).body.data.email.effective,false,'returning to an old address must not resurrect the former choice');
 assert.equal((await f.request(path+'/disable',{expectedVersion:2},'staff')).response.status,200);data=(await f.request(path,undefined,'staff')).body.data;assert.equal(data.email.enabled,false);assert.equal(data.sms.enabled,false);privateReply(data);
});

check('withdrawal remains available for read-only schools without enabling messages or altering mandatory alerts',async f=>{
 await f.request(path,choice(),'staff');const proposal=await f.proposal('Critical floor remains');assert.ok(proposal.id);
 const before=(await f.pg.query('SELECT id,title,body,severity,origin FROM public.portal_notifications ORDER BY id')).rows;
 await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);assert.equal((await f.request(path,{...choice(1),smsEnabled:false},'staff')).response.status,403);
 assert.equal((await f.request(path+'/disable',{expectedVersion:1,emailEnabled:true},'staff')).response.status,400);
 const key=randomUUID(),r=await f.request(path+'/disable',{expectedVersion:1},'staff',{key});assert.equal(r.response.status,200);assert.equal(r.body.data.email.effective,false);assert.equal(r.body.data.sms.effective,false);assert.deepEqual((await f.request(path+'/disable',{expectedVersion:1},'staff',{key})).body,r.body);
 assert.deepEqual((await f.pg.query('SELECT id,title,body,severity,origin FROM public.portal_notifications ORDER BY id')).rows,before);
});

check('replacement identity and other school memberships cannot inherit another identity or academy preferences',async f=>{
 await f.request(path,choice(),'staff');const extra=randomUUID();await f.pg.query("INSERT INTO public.people(academy_id,id,kind,name,auth_user_id) VALUES($1,$2,'human','Other school member',$3)",[f.b,extra,f.actors.staff.user]);
 assert.equal((await f.request(path,undefined,'staff',{academy:f.b})).body.data.version,0);
 const newUser=randomUUID();await f.pg.query('INSERT INTO identity."user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","mfaRequired") VALUES($1,\'Replacement\',\'replacement-notify@example.test\',true,\'+16479990998\',true,false)',[newUser]);
 await f.pg.query('UPDATE public.people SET auth_user_id=$3 WHERE academy_id=$1 AND id=$2',[f.a,f.actors.staff.person,newUser]);f.actors.staff.user=newUser;await login(f);
 assert.equal((await f.request(path,undefined,'staff')).body.data.version,0);assert.deepEqual((await f.request(path+'/history',undefined,'staff')).body.data,[]);assert.equal((await f.request(path,choice(),'staff')).response.status,201);assert.equal((await f.pg.query('SELECT * FROM public.notification_preferences')).rows.length,2);
});

check('native revision audit and outbox suppression roll back the preference and permit the same request key after repair',async f=>{
 for(const table of ['notification_preference_revisions','audit_events','outbox_events']){
  await f.pg.exec('CREATE FUNCTION public.suppress_preference_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$;CREATE TRIGGER suppress_preference_test BEFORE INSERT ON public.'+table+' FOR EACH ROW EXECUTE FUNCTION public.suppress_preference_test()');
  const count=(await f.pg.query('SELECT * FROM public.notification_preferences')).rows.length,key=randomUUID(),bad=await f.request(path,choice(),'staff',{key});assert.equal(bad.response.status,503,table+JSON.stringify(bad.body));assert.equal((await f.pg.query('SELECT * FROM public.notification_preferences')).rows.length,count);
  await f.pg.exec('DROP TRIGGER suppress_preference_test ON public.'+table+';DROP FUNCTION public.suppress_preference_test()');
  assert.equal((await f.request(path,choice(),'staff',{key})).response.status,201);assert.equal((await f.request(path+'/disable',{expectedVersion:1},'staff')).response.status,200);
  // Use another actual fixture identity for the next independent first-write test.
  f.actors.staff=f.actors[table==='notification_preference_revisions'?'manager':'peer'];
 }
 for(const table of ['notification_preferences','notification_preference_revisions']){
  await f.pg.exec('BEGIN');try{await assert.rejects(f.pg.exec('DELETE FROM public.'+table),/HISTORY_REQUIRED|EXACT_REVISION_REQUIRED/);}finally{await f.pg.exec('ROLLBACK');}
 }
});

test('native two-session first-write race produces one choice and one revision,not overwritten consent',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await operationsFixture();try{f.actors.parallelStaff={...f.actors.staff};await login(f,'parallelStaff');assert.notEqual(f.actors.parallelStaff.session,f.actors.staff.session);const start=performance.now(),r=await Promise.all([f.request(path,choice(),'staff'),f.request(path,{...choice(),smsEnabled:false},'parallelStaff')]);assert.deepEqual(r.map(v=>v.response.status).sort(),[201,409]);assert.equal((await f.pg.query('SELECT * FROM public.notification_preferences')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.notification_preference_revisions')).rows.length,1);console.log('Two preference writes completed in '+Math.ceil(performance.now()-start)+'ms;correctness only,not a load/SLO test.');}finally{await f.pg.close();}
});

check('native guards reject a different human approving another user choice and keep private contact queues inaccessible',async f=>{
 await f.pg.exec('BEGIN');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
  assert.equal((await f.pg.query<{v:null}>('SELECT public.notification_preference_identity($1,$2) v',[f.actors.staff.person,f.actors.master.session])).rows[0].v,null);
  for(const sql of ['SELECT * FROM identity.contact_change_events','SELECT * FROM public.outbox_events']){await f.pg.exec('SAVEPOINT private_read');await assert.rejects(f.pg.exec(sql),/permission denied/);await f.pg.exec('ROLLBACK TO SAVEPOINT private_read');}
  const proof=(await f.pg.query<{v:{ownerEpoch:string;emailEpoch:string;phoneEpoch:string}}>('SELECT public.notification_preference_identity($1,$2) v',[f.actors.staff.person,f.actors.staff.session])).rows[0].v;
  await f.pg.query("INSERT INTO public.notification_preferences(academy_id,person_id,owner_epoch,version,email_enabled,sms_enabled,locale,email_epoch,phone_epoch,notice_version) VALUES($1,$2,$3,1,true,true,'en',$4,$5,1)",[f.a,f.actors.staff.person,proof.ownerEpoch,proof.emailEpoch,proof.phoneEpoch]);
  await f.pg.exec('INSERT INTO public.notification_preference_revisions SELECT academy_id,person_id,owner_epoch,version,to_jsonb(p) FROM public.notification_preferences p');
  const request=randomUUID();await f.pg.query("INSERT INTO public.audit_events(academy_id,id,actor_id,actor_kind,session_id,request_id,action,entity_id,changes) SELECT academy_id,gen_random_uuid(),$1,'human',$2,$3,'notification-preferences.changed',person_id,jsonb_build_object('version',version,'revisionSha256',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')) FROM public.notification_preferences p",[f.actors.master.person,f.actors.master.session,request]);
  await f.pg.query("INSERT INTO public.outbox_events(academy_id,id,event_type,entity_id,request_id) VALUES($1,gen_random_uuid(),'notification-preferences.changed',$2,$3)",[f.a,f.actors.staff.person,request]);
  await assert.rejects(f.pg.exec('COMMIT'),/NOTIFICATION_PREFERENCE_SELF_RECEIPT_REQUIRED/);
 }finally{await f.pg.exec('ROLLBACK');}
 assert.equal((await f.pg.query('SELECT * FROM public.notification_preferences')).rows.length,0);
 assert.equal((await f.request(path,choice(),'staff')).response.status,201);
 await f.pg.exec('BEGIN');try{await assert.rejects(f.pg.exec('UPDATE public.notification_preferences SET version=version+2'),/NOTIFICATION_PREFERENCE_VERSION_REQUIRED/);}finally{await f.pg.exec('ROLLBACK');}
});

test('actual231to232 upgrade preserves existing people permissions and alerts without inferring any delivery permission',async()=>{
 const f=await operationsFixture({throughSchema:231});try{await f.proposal('Existing approval');const tables=['public.people','public.role_permissions','public.audit_events','public.outbox_events','public.portal_notifications'];async function snapshot(){const result=[];for(const t of tables)result.push((await f.pg.query('SELECT to_jsonb(x) r FROM '+t+' x ORDER BY to_jsonb(x)::text')).rows);return result;}const before=await snapshot();await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);assert.equal((await f.pg.query('SELECT * FROM public.notification_preferences')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.notification_preference_revisions')).rows.length,0);assert.equal((await f.request(path,undefined,'staff')).body.data.email.enabled,false);}finally{await f.pg.close();}
});

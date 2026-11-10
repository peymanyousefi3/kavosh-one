import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { agreementFixture } from './agreement-fixture.ts';
import { record } from '../src/core/api.ts';
import type { Credential } from '../src/core/policy.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';
type Fixture=Awaited<ReturnType<typeof agreementFixture>>;
const base=(f:Fixture)=>'students/'+f.student+'/profile-consents';
const withdraw=(f:Fixture,as='staff',key?:string,purpose='public_profile',body:unknown={})=>f.request(base(f)+'/'+purpose+'/withdraw',body,as,{key});
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await agreementFixture();try{await run(f);}finally{await f.pg.close();}});}

check('privacy withdrawals publish a nonoptional upper inbox floor with current scopes and a redacted persistent record',async f=>{
 for(const capability of ['profiles.view','student-profiles.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.managerRole,capability]);
 await f.pg.query('UPDATE public.people SET supervisor_person_id=$1 WHERE academy_id=$2 AND id=$3',[f.actors.manager.person,f.a,f.student]);
 const key=randomUUID(),made=await withdraw(f,'staff',key,'public_profile',{reason:'PRIVATE family explanation must not escape'});assert.equal(made.response.status,200,JSON.stringify({body:made.body,errors:f.metrics.queryFailures}));
 const event=(await f.pg.query<{event_id:string}>("SELECT event_id FROM public.automation_event_sources WHERE event_type='profile-consent.withdraw'")).rows[0].event_id;
 const recipients=(await f.pg.query<{person_id:string}>("SELECT person_id FROM public.portal_notifications WHERE event_id=$1 AND origin='mandatory' ORDER BY person_id",[event])).rows.map(r=>r.person_id);assert.deepEqual(recipients,[f.actors.master.person,f.actors.manager.person].sort());
 assert.deepEqual((await withdraw(f,'staff',key,'public_profile',{reason:'PRIVATE family explanation must not escape'})).body,made.body);assert.equal((await f.pg.query('SELECT * FROM public.profile_consent_withdrawals')).rows.length,1);
 const recordPath='community/profile-privacy-events/'+event,detail=await f.request(recordPath,undefined,'manager');assert.equal(detail.response.status,200,JSON.stringify(detail.body));assert.equal(detail.body.data.studentId,f.student);assert.equal(detail.body.data.version,1);assert.equal(detail.body.data.purpose,'public_profile');assert.equal(detail.body.consentRestoredByReading,false);assert.doesNotMatch(JSON.stringify(detail.body),/PRIVATE|actor|session|requestId|signer|source_basis|reason|evidenceId/);
 for(const as of ['master','manager']){const inbox=await f.request('notifications?origin=mandatory',undefined,as);assert.equal(inbox.response.status,200,JSON.stringify(inbox.body));const notice=inbox.body.data.find((n:{eventId:string})=>n.eventId===event);assert.ok(notice);assert.equal(notice.severity,'critical');assert.equal(notice.source.recordPath,'/api/v1/'+recordPath);assert.equal(notice.source.studentId,f.student);assert.equal(notice.source.consentRestoredByReading,false);assert.equal(notice.contentType,'text/plain');assert.doesNotMatch(JSON.stringify(notice),/PRIVATE|family explanation|signer|source_basis|session_id|relationshipId/);
  for(const language of ['fr','zh-CN']){const translated=await f.request('notifications/'+notice.id+'?locale='+language,undefined,as);assert.equal(translated.response.status,200);assert.equal(translated.body.data.locale,language);assert.notEqual(translated.body.data.title,notice.title);}
  const before=(await f.pg.query('SELECT * FROM public.profile_consent_withdrawals')).rows;assert.equal((await f.request('notifications/'+notice.id+'/read',{},as)).response.status,200);assert.deepEqual((await f.pg.query('SELECT * FROM public.profile_consent_withdrawals')).rows,before);
 }
 for(const as of ['staff','peer']){assert.equal((await f.request(recordPath,undefined,as)).response.status,404);assert.equal((await f.request('notifications?origin=mandatory',undefined,as)).body.data.filter((n:{eventId:string})=>n.eventId===event).length,0);}
 assert.equal((await f.request(recordPath,undefined,'bot')).response.status,403);assert.equal((await f.request(recordPath,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const ownNotice=(await f.request('notifications?origin=mandatory',undefined,'manager')).body.data.find((n:{eventId:string})=>n.eventId===event);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='student-profiles.view'",[f.managerRole]);assert.equal((await f.request(recordPath,undefined,'manager')).response.status,404);assert.equal((await f.request('notifications/'+ownNotice.id,undefined,'manager')).response.status,404);assert.equal((await f.request('notifications?origin=mandatory&limit=1',undefined,'manager')).body.data.length,0);
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'student-profiles.view','allow')",[f.a,f.managerRole]);await f.pg.query('UPDATE public.people SET hub_id=$1 WHERE academy_id=$2 AND id=$3',[f.otherHub,f.a,f.student]);assert.equal((await f.request(recordPath,undefined,'manager')).response.status,404);assert.equal((await f.request('notifications/'+ownNotice.id,undefined,'manager')).response.status,404);assert.equal((await f.request(recordPath)).response.status,200,'master still reads the immutable fact after a hub move');
 await f.pg.query('UPDATE public.people SET hub_id=$1,supervisor_person_id=$2 WHERE academy_id=$3 AND id=$4',[f.hub,f.actors.master.person,f.a,f.student]);assert.equal((await f.request(recordPath,undefined,'manager')).response.status,200,'ordinary scoped privacy review is separate from mandatory upper inbox ownership');assert.equal((await f.request('notifications/'+ownNotice.id,undefined,'manager')).response.status,404,'old upper cannot retain a mandatory notice after hierarchy changes');
});

check('withdrawal requires its native source and mandatory notices even when rows or the publisher are silently suppressed',async f=>{
 const counts=async()=>(await f.pg.query("SELECT(SELECT count(*) FROM public.profile_consent_withdrawals) withdrawals,(SELECT count(*) FROM public.audit_events) audits,(SELECT count(*) FROM public.outbox_events) events,(SELECT count(*) FROM public.automation_event_sources) sources,(SELECT count(*) FROM public.portal_notifications) notices,(SELECT count(*) FROM public.request_keys) receipts")).rows;
 for(const target of ['automation_event_sources','portal_notifications','publisher']){
  const before=await counts(),key=randomUUID();
  if(target==='publisher')await f.pg.exec('ALTER TABLE public.automation_event_sources DISABLE TRIGGER publish_profile_consent_alert');
  else{const condition=target==='portal_notifications'?"NEW.origin='mandatory' AND NEW.title='Profile sharing consent withdrawn'":"NEW.event_type='profile-consent.withdraw'";await f.pg.exec('CREATE FUNCTION public.synthetic_skip_privacy_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF '+condition+' THEN RETURN NULL;END IF;RETURN NEW;END $$;CREATE TRIGGER synthetic_skip_privacy_alert BEFORE INSERT ON public.'+target+' FOR EACH ROW EXECUTE FUNCTION public.synthetic_skip_privacy_alert()');}
  try{const failed=await withdraw(f,'staff',key);assert.equal(failed.response.status,503,JSON.stringify(failed.body));assert.deepEqual(await counts(),before,'withdrawal,audit,event,source,notices and retry receipt roll back together');}
  finally{if(target==='publisher')await f.pg.exec('ALTER TABLE public.automation_event_sources ENABLE TRIGGER publish_profile_consent_alert');else await f.pg.exec('DROP TRIGGER synthetic_skip_privacy_alert ON public.'+target+';DROP FUNCTION public.synthetic_skip_privacy_alert()');}
  const retry=await withdraw(f,'staff',key);assert.equal(retry.response.status,200,JSON.stringify(retry.body));assert.deepEqual((await withdraw(f,'staff',key)).body,retry.body);
 }
});

check('purpose-bound privacy automation reuses existing rules but audit grants or bot ceilings cannot replace student source rights',async f=>{
 for(const capability of ['audit.view','automations.view','automations.edit','automations.execute'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,f.managerRole,capability]);
 const definition={name:'Privacy review follow-up',enabled:false,trigger:{kind:'domain_event',eventTypes:['profile-consent.withdraw']},condition:{op:'eq',field:'attributes.purpose',value:'public_profile'},actions:[{kind:'notify',channels:['portal'],audience:{kind:'people',personIds:[f.actors.manager.person,f.actors.staff.person]},title:{en:'Privacy update'},body:{en:'Review the privacy record.'}}],execution:{mode:'automatic',maxRecipientsPerEvent:10,maxDailyDeliveries:10,maxDailySms:0,cooldownSeconds:0,maxChainDepth:1}};
 const disabled=await f.request('automations/rules',{hubId:f.hub,code:'PRIVACY_OFF',definition,reason:'Optional rule cannot disable mandatory floor'});assert.equal(disabled.response.status,201,JSON.stringify(disabled.body));
 assert.equal((await withdraw(f)).response.status,200);const event=(await f.pg.query<{event_id:string}>("SELECT event_id FROM public.automation_event_sources WHERE event_type='profile-consent.withdraw'")).rows[0].event_id,path='automations/events/'+event;
 const source=await f.request(path);assert.equal(source.response.status,200,JSON.stringify(source.body));assert.equal(source.body.data.sample.attributes.purpose,'public_profile');assert.equal(source.body.data.sample.attributes.withdrawalVersion,1);assert.doesNotMatch(JSON.stringify(source.body),/PRIVATE|reason|session_id|source_basis/);
 assert.equal((await f.request(path,undefined,'manager')).response.status,404,'audit.view alone cannot expose privacy sources');await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'profiles.view','allow')",[f.a,f.managerRole]);assert.equal((await f.request(path,undefined,'manager')).response.status,404);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'student-profiles.view','allow')",[f.a,f.managerRole]);assert.equal((await f.request(path,undefined,'manager')).response.status,200);
 await f.pg.query("UPDATE auth_private.credentials SET capabilities=array_remove(capabilities,'student-profiles.view') WHERE id=$1",[f.credential]);assert.equal((await f.request(path,undefined,'bot')).response.status,404,'the real credential ceiling applies to the new source right');
 const dispatch=(rule:string)=>f.request('automations/rules/'+rule+'/dispatch',{eventId:event,expectedVersion:1});const skipped=await dispatch(disabled.body.data.id);assert.equal(skipped.response.status,201,JSON.stringify(skipped.body));assert.equal(skipped.body.data.outcome,'not_matched');assert.equal((await f.pg.query("SELECT * FROM public.portal_notifications WHERE event_id=$1 AND origin='mandatory'",[event])).rows.length,1);
 const enabled=await f.request('automations/rules',{hubId:f.hub,code:'PRIVACY_ON',definition:{...definition,enabled:true},reason:'Approved purpose-specific follow-up'});assert.equal(enabled.response.status,201,JSON.stringify(enabled.body));const sent=await dispatch(enabled.body.data.id);assert.equal(sent.response.status,201,JSON.stringify(sent.body));assert.equal(sent.body.data.summary.portalNotifications,1,'unauthorized family recipient is excluded despite being explicitly listed');
 const inbox=await f.request('notifications?origin=automation',undefined,'manager');assert.equal(inbox.response.status,200);const notice=inbox.body.data.find((n:{eventId:string})=>n.eventId===event);assert.ok(notice);assert.equal(notice.source.recordPath,'/api/v1/community/profile-privacy-events/'+event);assert.equal((await f.request('notifications?origin=automation',undefined,'staff')).body.data.length,0);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='profiles.view'",[f.managerRole]);assert.equal((await f.request('notifications/'+notice.id,undefined,'manager')).response.status,404);assert.equal((await f.request(path,undefined,'manager')).response.status,404);
});

check('privacy event records reject over-sharing native output and service readers gain no private withdrawal fields',async f=>{
 assert.equal((await withdraw(f)).response.status,200);const event=(await f.pg.query<{event_id:string}>("SELECT event_id FROM public.automation_event_sources WHERE event_type='profile-consent.withdraw'")).rows[0].event_id,path='community/profile-privacy-events/'+event;
 for(const query of ['?granted=true','?scope=all','?studentId='+f.student,'?signedAt=2026-01-01'])assert.equal((await f.request(path+query)).response.status,400);assert.equal((await f.request(path,{})).response.status,405);assert.equal((await f.request('community/profile-privacy-events/'+randomUUID())).response.status,404);
 await f.pg.exec('SET ROLE kavosh_runtime');try{await assert.rejects(f.pg.exec('SELECT public.publish_profile_consent_alert()'),/permission denied/);await assert.rejects(f.pg.exec('SELECT public.require_profile_consent_notice()'),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('SET ROLE kavosh_event_policy');try{
  for(const sql of ['SELECT reason FROM public.profile_consent_withdrawals','SELECT source_basis FROM public.profile_consent_withdrawals'])await assert.rejects(f.pg.exec(sql),/permission denied/);
  for(const [recipient,title] of [[f.actors.staff.person,'Profile sharing consent withdrawn'],[f.actors.master.person,'PRIVATE forged content']])await assert.rejects(f.pg.query("INSERT INTO public.portal_notifications(academy_id,id,event_id,person_id,action_index,severity,title,body,locale,origin) VALUES($1,$2,$3,$4,0,'critical',$5,'Open the linked privacy record to review this withdrawal. Reading this notice does not restore consent or republish a profile.','en','mandatory')",[f.a,randomUUID(),event,recipient,title]),/MANDATORY_ALERT_SOURCE_INVALID/);
 }finally{await f.pg.exec('RESET ROLE');}
 const before=(await f.pg.query("SELECT count(*)::integer n FROM public.automation_event_sources WHERE event_type='profile-consent.withdraw'")).rows[0].n;
 await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);const c:Credential={kind:'human',token_id:f.actors.master.session,academy_id:f.a,person_id:f.actors.master.person,capabilities:[],all_hubs:true,hub_ids:[],allowed:true};await assert.rejects(record({query:f.pg.query.bind(f.pg),release(){}},c,randomUUID(),'profile-consent.withdraw',f.student,f.hub,{purpose:'public_profile',version:2,severity:'critical',privateContentRedacted:true}),/PROFILE_PRIVACY_SOURCE_REQUIRED/);}finally{await f.pg.exec('ROLLBACK');}assert.equal((await f.pg.query("SELECT count(*)::integer n FROM public.automation_event_sources WHERE event_type='profile-consent.withdraw'")).rows[0].n,before,'audit metadata alone cannot fabricate a privacy withdrawal');
 for(const role of ['kavosh_public_profile_service','kavosh_signature_completion_worker']){await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT public.profile_consent_notice_basis($1)',[event]),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}}
 const scopes=JSON.stringify({'profiles.view':{all:true,hubs:[]},'student-profiles.view':{all:true,hubs:[]}});
 for(const role of ['kavosh_message_worker','kavosh_message_policy']){await f.pg.exec('SET ROLE '+role);try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);assert.equal((await f.pg.query<{allowed:boolean}>('SELECT public.profile_consent_notice_allows($1,$2::jsonb) allowed',[event,scopes])).rows[0].allowed,true);assert.equal((await f.pg.query<{allowed:boolean}>('SELECT public.profile_consent_notice_allows($1,$2::jsonb) allowed',[event,'{}'])).rows[0].allowed,false);await assert.rejects(f.pg.exec('SELECT reason FROM public.profile_consent_withdrawals'),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}}
 const source=(await f.pg.query<{source:string}>("SELECT pg_get_functiondef('public.profile_consent_notice_basis(uuid)'::regprocedure) source")).rows[0].source;
 await f.pg.exec("CREATE OR REPLACE FUNCTION public.profile_consent_notice_basis(p_event uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('studentId','"+f.student+"','purpose','public_profile','version',1,'withdrawnAt','2026-01-01T00:00:00Z','hubId','"+f.hub+"','privateExplanation','PRIVATE must never escape') $$");
 try{const failed=await f.request(path);assert.equal(failed.response.status,503,JSON.stringify(failed.body));assert.doesNotMatch(JSON.stringify(failed.body),/PRIVATE|privateExplanation/);}finally{await f.pg.exec(source);}
 assert.equal((await f.request(path)).response.status,200);
});

test('actual325to326 preserves historical withdrawal sources and credentials without inventing old alerts or consent',async()=>{
 const f=await agreementFixture(325);try{
  const requestId=randomUUID(),credential:Credential={kind:'human',token_id:f.actors.staff.session,academy_id:f.a,person_id:f.signer,capabilities:[],all_hubs:false,hub_ids:[],allowed:true};
  await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.query('INSERT INTO public.profile_consent_withdrawals(academy_id,student_id,purpose,version,actor_id,session_id,request_id,source_basis,reason) VALUES($1,$2,$3,1,$4,$5,$6,public.profile_consent_actor_basis($2,$4),$7)',[f.a,f.student,'public_profile',f.signer,f.actors.staff.session,requestId,'PRIVATE old withdrawal']);await record({query:f.pg.query.bind(f.pg),release(){}},credential,requestId,'profile-consent.withdraw',f.student,f.hub,{purpose:'public_profile',version:1,severity:'critical',privateContentRedacted:true});await f.pg.exec('COMMIT');}catch(e){await f.pg.exec('ROLLBACK');throw e;}
  const snapshot=async()=>(await f.pg.query("SELECT jsonb_build_object('withdrawals',(SELECT jsonb_agg(to_jsonb(w) ORDER BY student_id,purpose,version) FROM public.profile_consent_withdrawals w),'sources',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM public.automation_event_sources e),'notices',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM public.portal_notifications n),'credentials',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM auth_private.credentials c)) snapshot")).rows,before=await snapshot();await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(),before);
  const current=await withdraw(f);assert.equal(current.response.status,200,JSON.stringify(current.body));assert.equal(current.body.data.version,2);assert.equal((await f.pg.query("SELECT * FROM public.portal_notifications WHERE origin='mandatory' AND title='Profile sharing consent withdrawn'")).rows.length,1);
 }finally{await f.pg.close();}
});

check('verified family withdrawal is immediate,purpose-specific,immutable and never alters enrollment or requires an approval',async f=>{
 const approvals=(await f.pg.query('SELECT count(*)::integer n FROM public.approval_requests')).rows[0].n,before=(await f.pg.query('SELECT * FROM public.class_enrollments')).rows;
 const empty=await f.request(base(f),undefined,'staff');assert.equal(empty.response.status,200,JSON.stringify(empty.body));assert.equal(empty.body.consentGrantEvaluated,true);assert.deepEqual(empty.body.data.map((r:{version:number})=>r.version),[0,0]);assert.ok(empty.body.data.every((r:{consentEligible:boolean})=>r.consentEligible===false));assert.equal(empty.body.publicationEvaluated,false);
 const key=randomUUID(),made=await withdraw(f,'staff',key);assert.equal(made.response.status,200,JSON.stringify({body:made.body,failures:f.metrics.queryFailures}));assert.equal(made.body.data.version,1);assert.equal(made.body.data.upperApprovalRequired,false);assert.equal(made.body.consentGranted,false);assert.deepEqual((await withdraw(f,'staff',key)).body,made.body);
 const row=(await f.pg.query<{actor_id:string;source_basis:{authority:string}}>('SELECT * FROM public.profile_consent_withdrawals')).rows[0];assert.equal(row.actor_id,f.signer);assert.equal(row.source_basis.authority,'current_guardian');
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.approval_requests')).rows[0].n,approvals);assert.deepEqual((await f.pg.query('SELECT * FROM public.class_enrollments')).rows,before);
 const history=await f.request(base(f)+'/public_profile/withdrawals',undefined,'peer');assert.equal(history.response.status,200);assert.equal(history.body.data[0].withdrawnByYou,false);assert.doesNotMatch(JSON.stringify(history.body),/reason|actor_id|relationship|session_id|source_basis|PRIVATE/);
 assert.equal((await withdraw(f,'peer',undefined,'verified_member_profile',{reason:'PRIVATE privacy explanation'})).response.status,200);const state=await f.request(base(f),undefined,'staff');assert.deepEqual(state.body.data.map((r:{version:number})=>r.version),[1,1]);
 const events=(await f.pg.query<{source_kind:string;projection:{severity:string}}>("SELECT source_kind,projection FROM public.automation_event_sources WHERE event_type='profile-consent.withdraw'")).rows;assert.equal(events.length,2);assert.ok(events.every(e=>e.source_kind==='audit'&&e.projection.severity==='critical'));assert.doesNotMatch(JSON.stringify(events),/PRIVATE|reason|source_basis|relationshipId/);
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.profile_publication_changes')).rows[0].n,0);
});
check('consent summary refuses an over-sharing native result and service readers gain no new eligibility authority',async f=>{
 const original=(await f.pg.query<{body:string}>("SELECT pg_get_functiondef('public.student_profile_consent(uuid,text)'::regprocedure) body")).rows[0].body;
 await f.pg.exec("CREATE OR REPLACE FUNCTION public.student_profile_consent(p_student uuid,p_purpose text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('eligible',true,'reason',NULL,'purpose',$2,'requiresGuardian',true,'evidenceId',gen_random_uuid(),'reviewVersion',1,'providerFreshlyChecked',false,'legalValidityCertified',false,'privateSignerEmail','PRIVATE@example.test') $$");
 try{const r=await f.request(base(f),undefined,'staff');assert.equal(r.response.status,503);assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE|privateSigner|evidenceId/);
  await f.pg.exec("CREATE OR REPLACE FUNCTION public.student_profile_consent(p_student uuid,p_purpose text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('eligible',false,'reason','PRIVATE@example.test','purpose',$2,'requiresGuardian',true,'evidenceId',NULL,'reviewVersion',NULL,'providerFreshlyChecked',false,'legalValidityCertified',false) $$");
  const reason=await f.request(base(f),undefined,'staff');assert.equal(reason.response.status,503,'unexpected free-text native reason must not pass the private response boundary');assert.doesNotMatch(JSON.stringify(reason.body),/PRIVATE/);
 }finally{await f.pg.exec(original);}
 for(const role of ['kavosh_public_profile_service','kavosh_signature_completion_worker','kavosh_signature_evidence_worker']){await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT public.student_profile_consent($1,$2)',[f.student,'public_profile']),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}}
 await f.pg.exec('SET ROLE kavosh_signature_evidence_policy');try{await assert.rejects(f.pg.exec('SELECT reason FROM public.profile_consent_withdrawals'),/permission denied/);await assert.rejects(f.pg.exec('SELECT source_basis,actor_id,session_id FROM public.profile_consent_withdrawals'),/permission denied/);await f.pg.exec('SELECT withdrawn_at FROM public.profile_consent_withdrawals');}finally{await f.pg.exec('RESET ROLE');}
 const r=await f.request(base(f),undefined,'staff');assert.equal(r.response.status,200);assert.doesNotMatch(JSON.stringify(r.body),/evidenceId|reviewVersion|sourceFingerprint|signerId/);
});
test('actual323to324 upgrade preserves a real native withdrawal and its audit/event history without creating consent',async()=>{
 const f=await agreementFixture(323);try{
  const requestId=randomUUID(),credential:Credential={kind:'human',token_id:f.actors.staff.session,academy_id:f.a,person_id:f.signer,capabilities:[],all_hubs:false,hub_ids:[],allowed:true};
  // Historical native323 protocol,not a spoofed current HTTP schema gate.
  await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
   await f.pg.query('INSERT INTO public.profile_consent_withdrawals(academy_id,student_id,purpose,version,actor_id,session_id,request_id,source_basis,reason) VALUES($1,$2,$3,1,$4,$5,$6,public.profile_consent_actor_basis($2,$4),$7)',[f.a,f.student,'public_profile',f.signer,f.actors.staff.session,requestId,'PRIVATE historical withdrawal']);
   await record({query:f.pg.query.bind(f.pg),release(){}},credential,requestId,'profile-consent.withdraw',f.student,f.hub,{purpose:'public_profile',version:1,severity:'critical',privateContentRedacted:true});await f.pg.exec('COMMIT');
  }catch(e){await f.pg.exec('ROLLBACK');throw e;}
  const snapshot="SELECT jsonb_build_object('withdrawals',(SELECT jsonb_agg(to_jsonb(w) ORDER BY student_id,purpose,version) FROM public.profile_consent_withdrawals w),'audits',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_events a),'events',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.outbox_events o),'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p)) snapshot",before=(await f.pg.query(snapshot)).rows;
  assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.profile_consent_withdrawals')).rows[0].n,1);
  await f.pg.exec(await readFile(new URL('../db/migrations/324_student_profile_consent_eligibility.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query(snapshot)).rows,before);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);const data=(await f.pg.query<{data:{eligible:boolean}}>('SELECT public.student_profile_consent($1,$2) data',[f.student,'public_profile'])).rows[0].data;assert.equal(data.eligible,false);
 }finally{await f.pg.close();}
});
check('privacy withdrawal survives missing profile permissions and read-only school but never grants administrator,bot or other-school authority',async f=>{
 await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1',[f.staffRole]);await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);
 assert.equal((await withdraw(f)).response.status,200);assert.equal((await withdraw(f,'master')).response.status,404);assert.equal((await withdraw(f,'manager')).response.status,404);assert.equal((await withdraw(f,'bot')).response.status,403);
 const foreign=await f.request(base(f)+'/public_profile/withdraw',{},'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,404);
 assert.equal((await f.request(base(f),undefined,'manager')).response.status,404);assert.equal((await f.request(base(f),undefined,'bot')).response.status,403);
 assert.equal((await f.request('students/'+f.student+'/update',{expectedVersion:1,legalName:'Unauthorized read-only change'})).response.status,403);
});
check('guardian authority expires when the student becomes adult or the approved legal relationship changes;self withdrawal remains possible',async f=>{
 const key=randomUUID();assert.equal((await withdraw(f,'staff',key)).response.status,200);
 assert.equal((await f.request('students/'+f.student+'/update',{expectedVersion:1,dateOfBirth:'2000-03-20',reason:'Correct adult date'})).response.status,200);
 assert.equal((await withdraw(f)).response.status,404);assert.equal((await withdraw(f,'staff',key)).response.status,404);assert.equal((await f.request(base(f),undefined,'staff')).response.status,404);assert.equal((await withdraw(f,'peer')).response.status,200);
 assert.equal((await f.request('students/'+f.student+'/update',{expectedVersion:2,dateOfBirth:'2014-03-20',reason:'Restore minor test date'})).response.status,200);
 assert.equal((await f.request('family-relationships/'+f.relationship.id+'/change',{expectedVersion:1,relationship:'authorized_contact',reason:'No legal guardian authority'})).response.status,200);
 assert.equal((await withdraw(f)).response.status,404);assert.equal((await withdraw(f,'peer')).response.status,200);
});
check('old signing requests stay behind the withdrawal cutoff and a future clock cannot be supplied to restore consent',async f=>{
 const old=(await f.pg.query<{at:string}>('SELECT clock_timestamp() at')).rows[0].at;assert.equal((await withdraw(f)).response.status,200);
 await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
 const status=async(at:string,purpose='public_profile')=>(await f.pg.query<{current:boolean}>('SELECT public.profile_consent_dispatch_current($1,$2,$3) current',[f.student,purpose,at])).rows[0].current;
 assert.equal(await status(old),false);assert.equal(await status(old,'verified_member_profile'),true);
 const newer=(await f.pg.query<{at:string}>('SELECT clock_timestamp() at')).rows[0].at;assert.equal(await status(newer),true);assert.equal(await status('2100-01-01T00:00:00Z'),false);assert.equal(await status(newer,'unknown'),false);
 assert.equal((await f.pg.query<{current:boolean}>('SELECT public.profile_consent_dispatch_current(student_id,purpose,withdrawn_at) current FROM public.profile_consent_withdrawals')).rows[0].current,false,'exact native timestamp equality is not a fresh post-withdrawal request');
 for(const args of [[f.student,null,newer],[null,'public_profile',newer],[f.student,'public_profile',null],[f.student,'public_profile','-infinity'],[randomUUID(),'public_profile',newer]])assert.equal((await f.pg.query<{current:boolean}>('SELECT public.profile_consent_dispatch_current($1,$2,$3) current',args)).rows[0].current,false,'invalid native barrier input must be false,never unknown');
 for(const body of [{granted:true},{signedAt:old},{withdrawnAt:old},{actorId:f.signer},{reason:'\u0000'},{reason:'PRIVATE\nheader'}])assert.equal((await withdraw(f,'staff',undefined,'public_profile',body)).response.status,400);
});
check('expired,future and suspended family authority and unverified sessions cannot submit a privacy withdrawal',async f=>{
 const change=(expectedVersion:number,patch:Record<string,unknown>)=>f.request('family-relationships/'+f.relationship.id+'/change',{expectedVersion,...patch,reason:'Current authority regression'}),day=86400000,at=Date.now();
 assert.equal((await change(1,{validFrom:new Date(at-2*day).toISOString(),validUntil:new Date(at-day).toISOString()})).response.status,200);assert.equal((await withdraw(f)).response.status,404);
 assert.equal((await change(2,{validFrom:new Date(at+day).toISOString(),validUntil:null})).response.status,200);assert.equal((await withdraw(f)).response.status,404);
 assert.equal((await change(3,{validFrom:new Date(at-day).toISOString(),validUntil:null})).response.status,200);assert.equal((await withdraw(f)).response.status,200);
 assert.equal((await f.request('family-relationships/'+f.relationship.id+'/suspend',{expectedVersion:4,reason:'Immediate guardian restriction'})).response.status,200);assert.equal((await withdraw(f)).response.status,404);
 for(const flag of ['emailVerified','phoneNumberVerified']){await f.pg.query('UPDATE identity."user" SET "'+flag+'"=false WHERE id=$1',[f.actors.staff.user]);try{assert.equal((await withdraw(f)).response.status,401);}finally{await f.pg.query('UPDATE identity."user" SET "'+flag+'"=true WHERE id=$1',[f.actors.staff.user]);}}
});
check('native withdrawal guard rejects another session,missing audit,mutable history and cross-school rows',async f=>{
 const made=await withdraw(f);assert.equal(made.response.status,200);await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  const insert='INSERT INTO public.profile_consent_withdrawals(academy_id,student_id,purpose,version,actor_id,session_id,request_id,source_basis,reason) VALUES($1,$2,$3,$4,$5,$6,$7,public.profile_consent_actor_basis($2,$5),$8)';
  const args=[f.a,f.student,'public_profile',2,f.signer,f.actors.staff.session,randomUUID(),'PRIVATE native attempt'];
  await assert.rejects(f.pg.query(insert,args.map((v,n)=>n===5?f.actors.peer.session:v)),/PROFILE_CONSENT_CURRENT_HUMAN_REQUIRED/);
  await assert.rejects(f.pg.query(insert,args),/PROFILE_CONSENT_WITHDRAWAL_AUDIT_REQUIRED/);
  await assert.rejects(f.pg.exec('UPDATE public.profile_consent_withdrawals SET reason=\'forged\''),/permission denied/);await assert.rejects(f.pg.exec('DELETE FROM public.profile_consent_withdrawals'),/permission denied/);
  await assert.rejects(f.pg.exec('SELECT * FROM public.outbox_events'),/permission denied/);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.profile_consent_withdrawals')).rows.length,0);
 }finally{await f.pg.exec('RESET ROLE');}
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.profile_consent_withdrawals')).rows[0].n,1);
});
check('missing receipt,audit or outbox acknowledgements roll back withdrawal and exact retry succeeds after repair',async f=>{
 const counts=async()=>(await f.pg.query("SELECT (SELECT count(*)::integer FROM public.profile_consent_withdrawals) receipts,(SELECT count(*)::integer FROM public.audit_events) audits,(SELECT count(*)::integer FROM public.outbox_events) events,(SELECT count(*)::integer FROM public.request_keys) keys")).rows[0];
 await f.pg.exec('CREATE FUNCTION public.skip_consent_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL;END $$');
 for(const table of ['profile_consent_withdrawals','audit_events','outbox_events']){
  const key=randomUUID(),before=await counts();await f.pg.exec('CREATE TRIGGER zz_skip_consent BEFORE INSERT ON public.'+table+' FOR EACH ROW EXECUTE FUNCTION public.skip_consent_test()');
  try{assert.equal((await withdraw(f,'staff',key)).response.status,503,table);}finally{await f.pg.exec('DROP TRIGGER zz_skip_consent ON public.'+table);}
  assert.deepEqual(await counts(),before,table);assert.equal((await withdraw(f,'staff',key)).response.status,200,table);
 }
});
check('short concurrent retries retain one withdrawal and independent later withdrawals advance monotonic versions',async f=>{
 if(!f.pg.runtime)return;const key=randomUUID(),started=performance.now(),same=await Promise.all([withdraw(f,'staff',key),withdraw(f,'staff',key)]);assert.deepEqual(same.map(r=>r.response.status),[200,200]);assert.deepEqual(same[0].body,same[1].body);
 const later=await Promise.all([withdraw(f),withdraw(f,'peer')]);assert.deepEqual(later.map(r=>r.response.status),[200,200]);assert.deepEqual(later.map(r=>r.body.data.version).sort(),[2,3]);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.profile_consent_withdrawals')).rows[0].n,3);
 console.log(JSON.stringify({case:'consent-withdrawal-short-race',elapsedMs:Math.round(performance.now()-started),receipts:3}));
});
check('direct native consent evaluation holds the same read barrier as API readers until its transaction ends',async f=>{
 if(!f.pg.runtime)return;const c=await f.pg.runtime.connect();let writing:ReturnType<typeof withdraw>|undefined,settled=false;const started=performance.now();
 try{await c.query('BEGIN');await c.query('SET LOCAL ROLE kavosh_runtime');await c.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await c.query('SELECT public.student_profile_consent($1,$2)',[f.student,'public_profile']);
  writing=withdraw(f).then(r=>{settled=true;return r;});let waiting=false;
  for(let n=0;n<50;n++){waiting=(await f.pg.query<{waiting:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND mode='ExclusiveLock' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) waiting")).rows[0].waiting;if(waiting)break;await new Promise(r=>setTimeout(r,2));}
  assert.equal(waiting,true,'observe the actual waiting native lock,not a guessed sleep');assert.equal(settled,false);await c.query('COMMIT');assert.equal((await writing).response.status,200);
  console.log(JSON.stringify({case:'native-consent-read-withdrawal-barrier',elapsedMs:Math.round(performance.now()-started)}));
 }finally{await c.query('ROLLBACK');c.release();await writing;}
});
test('actual322to323 upgrade preserves signed observations,publication state and identity without creating withdrawal history',async()=>{
 const f=await agreementFixture(322);try{const before=(await f.pg.query("SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.community_profiles p),'evidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.signature_completion_evidence e),'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p)) snapshot")).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/323_profile_consent_withdrawals.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query("SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.community_profiles p),'evidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.signature_completion_evidence e),'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p)) snapshot")).rows,before);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.profile_consent_withdrawals')).rows[0].n,0);
 }finally{await f.pg.close();}
});

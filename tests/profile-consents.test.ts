import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { agreementFixture } from './agreement-fixture.ts';
type Fixture=Awaited<ReturnType<typeof agreementFixture>>;
const base=(f:Fixture)=>'students/'+f.student+'/profile-consents';
const withdraw=(f:Fixture,as='staff',key?:string,purpose='public_profile',body:unknown={})=>f.request(base(f)+'/'+purpose+'/withdraw',body,as,{key});
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await agreementFixture();try{await run(f);}finally{await f.pg.close();}});}

check('verified family withdrawal is immediate,purpose-specific,immutable and never alters enrollment or requires an approval',async f=>{
 const approvals=(await f.pg.query('SELECT count(*)::integer n FROM public.approval_requests')).rows[0].n,before=(await f.pg.query('SELECT * FROM public.class_enrollments')).rows;
 const empty=await f.request(base(f),undefined,'staff');assert.equal(empty.response.status,200,JSON.stringify(empty.body));assert.equal(empty.body.consentGrantEvaluated,false);assert.deepEqual(empty.body.data.map((r:{version:number})=>r.version),[0,0]);
 const key=randomUUID(),made=await withdraw(f,'staff',key);assert.equal(made.response.status,200,JSON.stringify({body:made.body,failures:f.metrics.queryFailures}));assert.equal(made.body.data.version,1);assert.equal(made.body.data.upperApprovalRequired,false);assert.equal(made.body.consentGranted,false);assert.deepEqual((await withdraw(f,'staff',key)).body,made.body);
 const row=(await f.pg.query<{actor_id:string;source_basis:{authority:string}}>('SELECT * FROM public.profile_consent_withdrawals')).rows[0];assert.equal(row.actor_id,f.signer);assert.equal(row.source_basis.authority,'current_guardian');
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.approval_requests')).rows[0].n,approvals);assert.deepEqual((await f.pg.query('SELECT * FROM public.class_enrollments')).rows,before);
 const history=await f.request(base(f)+'/public_profile/withdrawals',undefined,'peer');assert.equal(history.response.status,200);assert.equal(history.body.data[0].withdrawnByYou,false);assert.doesNotMatch(JSON.stringify(history.body),/reason|actor_id|relationship|session_id|source_basis|PRIVATE/);
 assert.equal((await withdraw(f,'peer',undefined,'verified_member_profile',{reason:'PRIVATE privacy explanation'})).response.status,200);const state=await f.request(base(f),undefined,'staff');assert.deepEqual(state.body.data.map((r:{version:number})=>r.version),[1,1]);
 const events=(await f.pg.query<{source_kind:string;projection:{severity:string}}>("SELECT source_kind,projection FROM public.automation_event_sources WHERE event_type='profile-consent.withdraw'")).rows;assert.equal(events.length,2);assert.ok(events.every(e=>e.source_kind==='audit'&&e.projection.severity==='critical'));assert.doesNotMatch(JSON.stringify(events),/PRIVATE|reason|source_basis|relationshipId/);
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.profile_publication_changes')).rows[0].n,0);
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
test('actual322to323 upgrade preserves signed observations,publication state and identity without creating withdrawal history',async()=>{
 const f=await agreementFixture(322);try{const before=(await f.pg.query("SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.community_profiles p),'evidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.signature_completion_evidence e),'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p)) snapshot")).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/323_profile_consent_withdrawals.sql',import.meta.url),'utf8'));assert.deepEqual((await f.pg.query("SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.community_profiles p),'evidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.signature_completion_evidence e),'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p)) snapshot")).rows,before);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.profile_consent_withdrawals')).rows[0].n,0);
 }finally{await f.pg.close();}
});

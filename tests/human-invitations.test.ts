import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { operationsFixture } from './operations-fixture.ts';

const secret='synthetic-school-invitation-secret-not-for-production-000000';
async function fixture(configured=true,throughSchema?:number){
 const f=await operationsFixture({invitationSecret:configured?secret:undefined,throughSchema});
 await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'invitations.view','allow'),($1,$2,'invitations.edit','allow')",[f.a,f.managerRole]);
 async function person(hub=f.hub){const response=await f.request('people',{name:'Invited person',email:randomUUID()+'@example.test',hubId:hub});assert.equal(response.response.status,201);return response.body.data.id as string;}
 async function prepare(id:string,as='master',key=randomUUID()){const detail=await f.request('invitations/people/'+id,undefined,as);assert.equal(detail.response.status,200);return f.request('invitations',{personId:id,expectedPersonVersion:detail.body.data.version,reason:'Approved private onboarding'},as,{key});}
 const token=(id:string,as='master',key=randomUUID())=>f.request('invitations/'+id+'/token',{},as,{key});
 return{...f,person,prepare,token};
}
test('school master approves an exact pending recipient and retrieves a private idempotent token without storing plaintext',async()=>{
 const f=await fixture();try{
  const person=await f.person(),key=randomUUID(),prepared=await f.prepare(person,'master',key);assert.equal(prepared.response.status,201,JSON.stringify(prepared.body));const id=prepared.body.data.id;
  assert.equal((await f.prepare(person,'master',key)).body.data.id,id);
  const tokenKey=randomUUID(),first=await f.token(id,'master',tokenKey);assert.equal(first.response.status,201,JSON.stringify(first.body));assert.match(first.body.data.privateInvitation,/^kvi_[A-Za-z0-9_-]{43}$/);assert.equal(first.body.data.activationPerformed,false);assert.equal(first.response.headers.get('cache-control'),'no-store');
  assert.deepEqual((await f.token(id,'master',tokenKey)).body,first.body);
  assert.deepEqual((await f.token(id)).body,first.body,'a new HTTP key cannot extend this preparation expiry');
  assert.equal((await f.pg.query('SELECT * FROM identity.invites WHERE academy_id=$1 AND person_id=$2',[f.a,person])).rows.length,1);
  for(const table of ['public.request_keys','public.audit_events','public.approval_requests','public.human_invitation_preparations','identity.invites','identity.human_invitation_issues']){const rows=(await f.pg.query('SELECT row_to_json(r)::text AS data FROM '+table+' r')).rows;assert.ok(rows.every(r=>!String(r.data).includes(first.body.data.privateInvitation)),table);}
  const source=(await f.pg.query<{status:string;auth_user_id:string|null}>('SELECT status,auth_user_id FROM public.people WHERE id=$1',[person])).rows[0];assert.deepEqual(source,{status:'pending',auth_user_id:null});
  const view=await f.request('invitations/'+id);assert.equal(view.response.status,200);assert.equal(view.body.data.source_current,true);assert.equal(JSON.stringify(view.body).includes(first.body.data.privateInvitation),false);
  assert.equal(view.body.data.issue.status,'active');
  const event=(await f.pg.query<{projection:Record<string,unknown>}>("SELECT e.projection FROM public.automation_event_sources e JOIN public.audit_events a ON a.academy_id=e.academy_id AND a.id=e.audit_id WHERE a.entity_id=$1 AND a.action='human-invitation.token.issued' LIMIT 1",[id])).rows[0];assert.equal(event.projection.severity,'critical');assert.equal(JSON.stringify(event).includes(first.body.data.privateInvitation),false);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  await assert.rejects(f.pg.query('SELECT public.issue_human_invitation($1,$2,$3,$4)',[id,f.actors.master.person,f.actors.master.session,'f'.repeat(64)]),/INVITATION_TOKEN_KEY_CHANGED/);
  await assert.rejects(f.pg.query("UPDATE identity.human_invitation_issues SET expires_at=now() WHERE preparation_id=$1",[id]),/INVITATION_ISSUE_IMMUTABLE/);
  await assert.rejects(f.pg.query('UPDATE public.human_invitation_preparations SET reason=$2 WHERE id=$1',[id,'Rewrite']),/INVITATION_PREPARATION_IMMUTABLE/);
 }finally{await f.pg.close();}
});
test('token audit failure restores an existing invitation and leaves no issued cache or receipt',async()=>{
 const f=await fixture();try{
  const person=await f.person(),first=await f.prepare(person),original=await f.token(first.body.data.id);assert.equal(original.response.status,201);
  const next=await f.prepare(person),id=next.body.data.id,before=(await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows,key=randomUUID();
  await f.pg.exec("CREATE FUNCTION public.synthetic_invitation_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_INVITATION_AUDIT_FAILURE';END $$; CREATE TRIGGER synthetic_invitation_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW WHEN(NEW.action='human-invitation.token.issued') EXECUTE FUNCTION public.synthetic_invitation_audit_failure()");
  assert.equal((await f.token(id,'master',key)).response.status,503);
  assert.deepEqual((await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows,before);
  assert.equal((await f.pg.query('SELECT * FROM identity.human_invitation_issues WHERE preparation_id=$1',[id])).rows.length,0);
  assert.equal((await f.pg.query('SELECT * FROM public.request_keys WHERE key=$1',[key])).rows.length,0);
  await f.pg.exec('DROP TRIGGER synthetic_invitation_audit_failure ON public.audit_events; DROP FUNCTION public.synthetic_invitation_audit_failure()');
  assert.equal((await f.token(first.body.data.id)).response.status,201);
 }finally{await f.pg.close();}
});
test('native simultaneous retrieval returns one token, expiry, private cache and audit effect',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
  const person=await f.person(),prepared=await f.prepare(person),id=prepared.body.data.id,key=randomUUID();const [a,b]=await Promise.all([f.token(id,'master',key),f.token(id,'master',key)]);
  assert.equal(a.response.status,201,JSON.stringify(a.body));assert.equal(b.response.status,201,JSON.stringify(b.body));assert.deepEqual(a.body,b.body);
  assert.equal((await f.pg.query('SELECT * FROM identity.human_invitation_issues WHERE preparation_id=$1',[id])).rows.length,1);
  assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE entity_id=$1 AND action='human-invitation.token.issued'",[id])).rows.length,1);
 }finally{await f.pg.close();}
});
test('lower-level invitations need upper approval and current source permissions; bots cannot retrieve secrets',async()=>{
 const f=await fixture();try{
  const person=await f.person(),proposal=await f.prepare(person,'manager');assert.equal(proposal.response.status,202,JSON.stringify(proposal.body));assert.equal((await f.pg.query('SELECT * FROM public.human_invitation_preparations')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM identity.invites')).rows.length,0);
  const review=await f.approve(proposal.body.approval.id);assert.equal(review.response.status,200,JSON.stringify(review.body));const id=review.body.data.id;
  assert.equal((await f.token(id,'manager')).response.status,201);
  assert.equal((await f.token(id,'bot')).response.status,403);
  assert.equal((await f.request('invitations/'+id,undefined,'peer')).response.status,404);
  assert.equal((await f.request('invitations/'+id,undefined,'foreignMaster',{academy:f.b})).response.status,404);
  const botProposal=await f.prepare(await f.person(),'bot');assert.equal(botProposal.response.status,202);const botReview=await f.approve(botProposal.body.approval.id);assert.equal(botReview.response.status,200);assert.equal((await f.token(botReview.body.data.id,'bot')).response.status,403);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'invitations.view','allow'),($1,$2,'invitations.edit','allow')",[f.a,f.staffRole]);
  const staffRequest=await f.prepare(await f.person(),'staff');assert.equal(staffRequest.response.status,202);const managerReview=await f.approve(staffRequest.body.approval.id,'manager');assert.equal(managerReview.response.status,200,JSON.stringify(managerReview.body));assert.equal((await f.token(managerReview.body.data.id,'staff')).response.status,201);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'invitations.view','deny') ON CONFLICT(academy_id,role_id,capability) DO UPDATE SET effect='deny'",[f.a,f.managerRole]);
  assert.equal((await f.token(id,'manager')).response.status,404);
 }finally{await f.pg.close();}
});
test('recipient role changes stale a pending approval and an approved preparation without exposing role details',async()=>{
 const f=await fixture();try{
  const person=await f.person();await f.pg.query('INSERT INTO public.role_assignments VALUES($1,$2,$3,$4,false)',[f.a,randomUUID(),person,f.staffRole]);
  const pending=await f.prepare(person,'manager');assert.equal(pending.response.status,202);
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'hubs.view','allow')",[f.a,f.staffRole]);
  const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');
  const prepared=await f.prepare(person);assert.equal(prepared.response.status,201);const id=prepared.body.data.id;
  await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'courses.view','allow')",[f.a,f.staffRole]);
  assert.equal((await f.token(id)).response.status,409);assert.equal((await f.pg.query('SELECT * FROM identity.invites')).rows.length,0);
 }finally{await f.pg.close();}
});
test('moved recipients require current and original hub scope,while explicit selected-person access follows the person',async()=>{
 const f=await fixture();try{
  const person=await f.person(),prepared=await f.prepare(person),id=prepared.body.data.id;
  await f.pg.query('UPDATE public.people SET hub_id=$2 WHERE id=$1',[person,f.otherHub]);
  for(const as of ['manager','peer']){assert.equal((await f.request('invitations/'+id,undefined,as)).response.status,404);const page=await f.request('invitations?limit=1',undefined,as);assert.equal(page.response.status,200);assert.deepEqual(page.body.data,[]);}
  const assignment=(await f.pg.query<{id:string}>('SELECT id FROM public.role_assignments WHERE person_id=$1 AND role_id=$2',[f.actors.peer.person,f.managerRole])).rows[0].id;
  await f.pg.query('INSERT INTO public.assignment_people VALUES($1,$2,$3)',[f.a,assignment,person]);
  assert.equal((await f.request('invitations/'+id,undefined,'peer')).response.status,200);
  assert.equal((await f.request('invitations?limit=1',undefined,'peer')).body.data[0].id,id);
  assert.equal((await f.token(id)).response.status,409,'a current master cannot issue from stale recipient geography');
 }finally{await f.pg.close();}
});
test('replacement and expiry invalidate old token replays; key conflicts roll back a newly attempted replacement',async()=>{
 const f=await fixture();try{
  const person=await f.person(),first=await f.prepare(person),id=first.body.data.id,key=randomUUID();const issued=await f.token(id,'master',key);assert.equal(issued.response.status,201);
  const next=await f.prepare(person),nextId=next.body.data.id;
  assert.equal((await f.request('invitations/'+nextId)).body.data.issue.status,'unissued');
  assert.equal((await f.token(nextId,'master',key)).response.status,409);
  assert.equal((await f.token(id)).response.status,201,'failed replacement did not invalidate the first invite');
  assert.equal((await f.token(nextId)).response.status,201);assert.equal((await f.token(id,'master',key)).response.status,409);
  assert.equal((await f.request('invitations/'+id)).body.data.issue.status,'superseded');
  await f.pg.query("UPDATE identity.invites SET expires_at=clock_timestamp()-interval '1 second' WHERE academy_id=$1 AND person_id=$2",[f.a,person]);
  assert.equal((await f.token(nextId)).response.status,409);
  const past=(await f.prepare(person)).body.data.id,missing=(await f.prepare(person)).body.data.id;
  // Rolled-back historical metadata exercises time-dependent status branches
  // without waiting48hours or modifying immutable persisted issue records.
  await f.pg.exec('BEGIN');try{
   await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
   await f.pg.query("INSERT INTO identity.human_invitation_issues(academy_id,preparation_id,token_hash,expires_at,issued_by) VALUES($1,$2,$3,now()-interval '1 hour',$4),($1,$5,$6,now()+interval '1 hour',$4)",[f.a,past,'3'.repeat(64),f.actors.master.person,missing,'4'.repeat(64)]);
   assert.equal((await f.pg.query<{issue:{status:string}}>('SELECT public.human_invitation_issue_status($1) AS issue',[past])).rows[0].issue.status,'expired');
   assert.equal((await f.pg.query<{issue:{status:string}}>('SELECT public.human_invitation_issue_status($1) AS issue',[missing])).rows[0].issue.status,'unavailable');
  }finally{await f.pg.exec('ROLLBACK');}
 }finally{await f.pg.close();}
});
test('missing secret, forged body, master/bot/active recipient and unauthorised school are rejected without invitations',async()=>{
 const f=await fixture(false);try{
  const person=await f.person(),created=await f.prepare(person);assert.equal(created.response.status,201);assert.equal((await f.token(created.body.data.id)).response.status,503);
  assert.equal((await f.request('invitations',{personId:person,expectedPersonVersion:1,reason:'Test',email:'other@example.test'})).response.status,400);
  assert.equal((await f.request('invitations',{personId:person,expectedPersonVersion:1,reason:'Invalid\0reason'})).response.status,400);
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  await assert.rejects(f.pg.query("INSERT INTO public.human_invitation_preparations(academy_id,id,person_id,hub_id,source_basis,changed_by,approval_id,reason) VALUES($1,$2,$3,$4,public.human_invitation_basis($3),$5,$6,'Forged native preparation')",[f.a,randomUUID(),person,f.hub,f.actors.master.person,randomUUID()]),/INVITATION_EXACT_APPROVAL_REQUIRED/);
  await assert.rejects(f.pg.query('SELECT public.issue_human_invitation($1,$2,$3,$4)',[created.body.data.id,f.actors.master.person,f.actors.master.session,'0'.repeat(64)]),/INVITATION_TOKEN_AUDIT_REQUIRED/);
  for(const who of [f.actors.master.person,f.actors.staff.person]){const detail=await f.request('invitations/people/'+who);assert.equal(detail.response.status,200);assert.equal(detail.body.data.eligible,false);assert.equal((await f.prepare(who)).response.status,409);}
  assert.equal((await f.request('invitations/people/'+f.bot)).response.status,400);
  assert.equal((await f.request('invitations/people/'+person,undefined,'foreignMaster',{academy:f.b})).response.status,404);
  assert.equal((await f.pg.query('SELECT * FROM identity.invites')).rows.length,0);
  await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);
  const blocked=await f.request('invitations/people/'+person);assert.equal(blocked.response.status,200);assert.equal(blocked.body.data.eligible,false);assert.equal(blocked.body.data.schoolStatus,'read_only');assert.equal((await f.token(created.body.data.id)).response.status,403);
 }finally{await f.pg.close();}
});
test('schema161 preserves old identity and approval rows and private cache is not accessible to web SQL',async()=>{
 const f=await operationsFixture({throughSchema:160});try{
  const snapshot=async()=>({people:(await f.pg.query('SELECT * FROM public.people ORDER BY academy_id,id')).rows,users:(await f.pg.query('SELECT * FROM identity."user" ORDER BY id')).rows,approvals:(await f.pg.query('SELECT * FROM public.approval_requests ORDER BY id')).rows});const before=await snapshot();
  await f.pg.exec(await readFile(new URL('../db/migrations/161_human_invitation_preparations.sql',import.meta.url),'utf8'));assert.deepEqual(await snapshot(),before);
  assert.equal((await f.pg.query<{allowed:boolean}>("SELECT has_column_privilege('kavosh_runtime','public.human_invitation_preparations','created_at','INSERT') AS allowed")).rows[0].allowed,false);
  await f.pg.exec('SET ROLE kavosh_runtime');await assert.rejects(f.pg.query('SELECT * FROM identity.human_invitation_issues'),/permission denied/);await f.pg.exec('RESET ROLE');
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

test('master revokes issued and unissued invitations with immutable history and no account changes',async()=>{
 const f=await fixture();try{
  for(const issued of [false,true]){
   const person=await f.person(),prepared=await f.prepare(person),id=prepared.body.data.id,tokenKey=randomUUID();if(issued)assert.equal((await f.token(id,'master',tokenKey)).response.status,201);
   const snapshot=async()=>({people:(await f.pg.query('SELECT * FROM public.people ORDER BY academy_id,id')).rows,users:(await f.pg.query('SELECT * FROM identity."user" ORDER BY id')).rows,sessions:(await f.pg.query('SELECT * FROM identity.session ORDER BY id')).rows,issues:(await f.pg.query('SELECT * FROM identity.human_invitation_issues ORDER BY preparation_id')).rows});const before=await snapshot(),key=randomUUID(),path='invitations/'+id+'/revoke',body={reason:'Cancel this private invitation'};
   const revoked=await f.request(path,body,'master',{key});assert.equal(revoked.response.status,201,JSON.stringify(revoked.body));assert.equal(revoked.body.data.revoked,true);assert.equal(revoked.body.data.accountDisabled,false);
   assert.deepEqual((await f.request(path,body,'master',{key})).body,revoked.body);const duplicate=await f.request(path,body);assert.equal(duplicate.response.status,200);assert.equal(duplicate.body.data.alreadyRevoked,true);
   assert.deepEqual(await snapshot(),before);
   const detail=(await f.request('invitations/'+id)).body.data;assert.equal(detail.issue.status,'revoked');assert.equal(detail.revocation.id,revoked.body.data.id);assert.equal(detail.revocation.reason,body.reason);
   assert.equal((await f.request('invitations')).body.data.find((r:{id:string})=>r.id===id).revoked,true);
   const handoff=await f.token(id,'master',tokenKey);assert.equal(handoff.response.status,409);assert.equal(handoff.body.error.code,'INVITATION_REVOKED');
   await assert.rejects(f.pg.query('UPDATE public.human_invitation_revocations SET reason=$2 WHERE id=$1',[revoked.body.data.id,'Rewrite']),/INVITATION_REVOCATION_IMMUTABLE/);
   if(issued)assert.equal((await f.pg.query<{expired:boolean}>('SELECT expires_at<=clock_timestamp() AS expired FROM identity.invites WHERE academy_id=$1 AND person_id=$2',[f.a,person])).rows[0].expired,true);
  }
 }finally{await f.pg.close();}
});

test('upper-approved cancellation works in read-only school without enabling unrelated writes or approvals',async()=>{
 const f=await fixture();try{
  const person=await f.person(),prepared=await f.prepare(person),id=prepared.body.data.id;assert.equal((await f.token(id)).response.status,201);
  const request=await f.request('invitations/'+id+'/revoke',{reason:'Upper review required'},'manager');assert.equal(request.response.status,202);assert.equal((await f.request('invitations/'+id)).body.data.issue.status,'active');
  const notices=(await f.pg.query<{person_id:string;severity:string}>("SELECT n.person_id,n.severity FROM public.portal_notifications n JOIN public.automation_event_sources e ON e.academy_id=n.academy_id AND e.event_id=n.event_id WHERE e.approval_id=$1 AND e.event_type='approval.requested' AND n.origin='mandatory'",[request.body.approval.id])).rows;assert.ok(notices.some(n=>n.person_id===f.actors.master.person&&n.severity==='critical'));
  const unrelated=await f.proposal('Unrelated role change');await f.pg.query("UPDATE public.academies SET status='read_only' WHERE id=$1",[f.a]);
  assert.equal((await f.approve(unrelated.id)).response.status,403);
  assert.equal((await f.request('approvals/'+unrelated.id+'/decide',{expectedVersion:1,decision:'approve',reason:'Cannot spoof a security exception',securityRevocation:true})).response.status,403);
  assert.equal((await f.request('roles',{...f.roleInput,name:'Forbidden while read-only'})).response.status,403);
  assert.equal((await f.request('invitations',{personId:person,expectedPersonVersion:1,reason:'Forbidden issue'})).response.status,403);
  const applied=await f.approve(request.body.approval.id);assert.equal(applied.response.status,200,JSON.stringify(applied.body));assert.equal(applied.body.data.revoked,true);
  assert.equal((await f.request('invitations/'+id)).body.data.issue.status,'revoked');assert.equal((await f.token(id)).response.status,403);
  assert.equal((await f.request('people',{name:'Blocked',email:'blocked@example.test',hubId:f.hub})).response.status,403);
 }finally{await f.pg.close();}
});

test('revoking an older preparation leaves a newer replacement usable and audit failure restores the old token',async()=>{
 const f=await fixture();try{
  const person=await f.person(),old=(await f.prepare(person)).body.data.id;await f.token(old);const next=(await f.prepare(person)).body.data.id;await f.token(next);
  assert.equal((await f.request('invitations/'+old+'/revoke',{reason:'Cancel old link only'})).response.status,201);assert.equal((await f.token(next)).response.status,201);
  const before=(await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows;
  await f.pg.exec("CREATE FUNCTION public.synthetic_revoke_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_REVOKE_AUDIT_FAILURE';END $$; CREATE TRIGGER synthetic_revoke_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW WHEN(NEW.action='human-invitation.revoke') EXECUTE FUNCTION public.synthetic_revoke_audit_failure()");
  assert.equal((await f.request('invitations/'+next+'/revoke',{reason:'Failed revoke'})).response.status,503);assert.deepEqual((await f.pg.query('SELECT * FROM identity.invites ORDER BY token_hash')).rows,before);
  assert.equal((await f.pg.query('SELECT * FROM public.human_invitation_revocations WHERE preparation_id=$1',[next])).rows.length,0);
  await f.pg.exec('DROP TRIGGER synthetic_revoke_audit_failure ON public.audit_events; DROP FUNCTION public.synthetic_revoke_audit_failure()');assert.equal((await f.token(next)).response.status,201);
 }finally{await f.pg.close();}
});

test('consumption evidence survives auth cleanup and prevents account-disabling revocation',async()=>{
 const f=await fixture();try{
  const person=(await f.request('people',{name:'Existing verified user',email:'foreignmaster@example.test',hubId:f.hub})).body.data.id,id=(await f.prepare(person)).body.data.id,token=(await f.token(id)).body.data.privateInvitation;
  const hash=createHmac('sha256',secret).update(token).digest('hex'),user=f.actors.foreignMaster;
  await f.pg.exec('SET ROLE kavosh_identity');assert.equal((await f.pg.query<{code:string}>('SELECT * FROM identity.accept_invite($1,$2,$3)',[hash,user.user,user.session])).rows[0].code,'ACCEPTED');await f.pg.exec('RESET ROLE');
  assert.equal((await f.pg.query('SELECT * FROM identity.human_invitation_consumptions WHERE preparation_id=$1',[id])).rows.length,1);
  await f.pg.query("UPDATE identity.invites SET expires_at=clock_timestamp()-interval '8 days' WHERE token_hash=$1",[hash]);await f.pg.query('SELECT identity.cleanup_expired_auth()');assert.equal((await f.pg.query('SELECT * FROM identity.invites WHERE token_hash=$1',[hash])).rows.length,0);
  assert.equal((await f.request('invitations/'+id)).body.data.issue.status,'consumed');const denied=await f.request('invitations/'+id+'/revoke',{reason:'Must not disable account'});assert.equal(denied.response.status,409);assert.equal(denied.body.error.code,'INVITATION_ALREADY_CONSUMED');
  assert.equal((await f.pg.query<{status:string;auth_user_id:string}>('SELECT status,auth_user_id FROM public.people WHERE id=$1',[person])).rows[0].auth_user_id,user.user);
  await assert.rejects(f.pg.query('DELETE FROM identity.human_invitation_consumptions WHERE preparation_id=$1',[id]),/INVITATION_ISSUE_IMMUTABLE/);
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

test('schema162 preserves old fields and helper ACLs,backfills known consumption and labels lost legacy evidence unknown',async()=>{
 const f=await fixture(true,161);try{
  const person=(await f.request('people',{name:'Legacy verified recipient',email:'foreignmaster@example.test',hubId:f.hub})).body.data.id;
  const lost=(await f.prepare(person)).body.data.id,lostToken=(await f.token(lost)).body.data.privateInvitation;
  const retained=(await f.prepare(person)).body.data.id,token=(await f.token(retained)).body.data.privateInvitation,user=f.actors.foreignMaster;
  const hash=(value:string)=>createHmac('sha256',secret).update(value).digest('hex');
  await f.pg.exec('SET ROLE kavosh_identity');assert.equal((await f.pg.query<{code:string}>('SELECT * FROM identity.accept_invite($1,$2,$3)',[hash(token),user.user,user.session])).rows[0].code,'ACCEPTED');await f.pg.exec('RESET ROLE');
  await f.pg.query("UPDATE identity.invites SET expires_at=clock_timestamp()-interval '8 days' WHERE token_hash=$1",[hash(lostToken)]);await f.pg.query('SELECT identity.cleanup_expired_auth()');
  const snapshot=async()=>({people:(await f.pg.query('SELECT * FROM public.people ORDER BY academy_id,id')).rows,users:(await f.pg.query('SELECT * FROM identity."user" ORDER BY id')).rows,issues:(await f.pg.query("SELECT to_jsonb(c)-'consumption_tracked' AS data FROM identity.human_invitation_issues c ORDER BY preparation_id")).rows,preparations:(await f.pg.query('SELECT * FROM public.human_invitation_preparations ORDER BY id')).rows,helpers:(await f.pg.query("SELECT oid,proowner,proacl FROM pg_proc WHERE oid IN('public.issue_human_invitation(uuid,uuid,uuid,text)'::regprocedure,'public.human_invitation_issue_status(uuid)'::regprocedure) ORDER BY oid")).rows});
  const before=await snapshot();await f.pg.exec(await readFile(new URL('../db/migrations/162_human_invitation_revocations.sql',import.meta.url),'utf8'));assert.deepEqual(await snapshot(),before);
  // Structural access-path check only,not a throughput benchmark. Force index
  // consideration on this tiny fixture; production keeps its normal planner.
  await f.pg.exec('BEGIN');try{
   await f.pg.query("SELECT set_config('enable_seqscan','off',true)");
   const lookup=await f.pg.query('EXPLAIN (FORMAT JSON) SELECT preparation_id FROM identity.human_invitation_issues WHERE academy_id=$1 AND token_hash=$2',[f.a,hash(token)]);assert.ok(JSON.stringify(lookup.rows).includes('human_invitation_issue_hash'));
   const open=await f.pg.query('EXPLAIN (FORMAT JSON) SELECT token_hash FROM identity.invites WHERE academy_id=$1 AND person_id=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()',[f.a,person]);assert.ok(JSON.stringify(open.rows).includes('invites_unconsumed_person'));
  }finally{await f.pg.exec('ROLLBACK');}
  assert.equal((await f.pg.query('SELECT * FROM identity.human_invitation_consumptions WHERE preparation_id=$1',[retained])).rows.length,1);
  assert.equal((await f.request('invitations/'+lost)).body.data.issue.status,'consumption_unknown');const denied=await f.request('invitations/'+lost+'/revoke',{reason:'Unknown legacy history'});assert.equal(denied.response.status,409);assert.equal(denied.body.error.code,'INVITATION_CONSUMPTION_UNKNOWN');
  await f.pg.query("UPDATE identity.invites SET expires_at=clock_timestamp()-interval '8 days' WHERE token_hash=$1",[hash(token)]);await f.pg.query('SELECT identity.cleanup_expired_auth()');assert.equal((await f.request('invitations/'+retained)).body.data.issue.status,'consumed');
  const fresh=(await f.prepare(await f.person())).body.data.id;assert.equal((await f.token(fresh)).response.status,201);assert.equal((await f.pg.query<{consumption_tracked:boolean}>('SELECT consumption_tracked FROM identity.human_invitation_issues WHERE preparation_id=$1',[fresh])).rows[0].consumption_tracked,true);
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

test('native cancellation races acceptance without disabling a completed account',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
  const person=(await f.request('people',{name:'Race recipient',email:'foreignmaster@example.test',hubId:f.hub})).body.data.id,id=(await f.prepare(person)).body.data.id,token=(await f.token(id)).body.data.privateInvitation,user=f.actors.foreignMaster;
  const hash=createHmac('sha256',secret).update(token).digest('hex');
  const accept=async()=>{const db=await f.pg.runtime!.connect();try{await db.query('SET ROLE kavosh_identity');return(await db.query<{code:string}>('SELECT * FROM identity.accept_invite($1,$2,$3)',[hash,user.user,user.session])).rows[0].code;}finally{db.release();}};
  const [accepted,revoked]=await Promise.all([accept(),f.request('invitations/'+id+'/revoke',{reason:'Concurrent cancellation'})]);
  const state=(await f.pg.query<{status:string;auth_user_id:string|null}>('SELECT status,auth_user_id FROM public.people WHERE id=$1',[person])).rows[0];
  if(accepted==='ACCEPTED'){assert.equal(revoked.response.status,409,JSON.stringify(revoked.body));assert.deepEqual(state,{status:'active',auth_user_id:user.user});assert.equal((await f.request('invitations/'+id)).body.data.issue.status,'consumed');}
  else{assert.equal(accepted,'INVALID_INVITATION');assert.equal(revoked.response.status,201,JSON.stringify(revoked.body));assert.deepEqual(state,{status:'pending',auth_user_id:null});assert.equal((await f.request('invitations/'+id)).body.data.issue.status,'revoked');}
 }finally{await f.pg.close();}
});

test('cancellation stays scoped,requires upper review for bots and invalidates pending review after acceptance',async()=>{
 const f=await fixture();try{
  const person=await f.person(),id=(await f.prepare(person)).body.data.id;await f.token(id);
  assert.equal((await f.request('invitations/'+id+'/revoke',{reason:'Outside hub'},'peer')).response.status,404);
  assert.equal((await f.request('invitations/'+id+'/revoke',{reason:'Other school'},'foreignMaster',{academy:f.b})).response.status,404);
  assert.equal((await f.request('invitations/'+id+'/revoke',{reason:'Cannot switch target',invitationId:randomUUID()})).response.status,400);
  const bot=await f.request('invitations/'+id+'/revoke',{reason:'Bot requests human review'},'bot');assert.equal(bot.response.status,202);assert.equal((await f.request('invitations/'+id)).body.data.issue.status,'active');assert.equal((await f.approve(bot.body.approval.id)).response.status,200);
  const nextPerson=(await f.request('people',{name:'Accepted before review',email:'foreignmaster@example.test',hubId:f.hub})).body.data.id,nextId=(await f.prepare(nextPerson)).body.data.id,token=(await f.token(nextId)).body.data.privateInvitation;
  const pending=await f.request('invitations/'+nextId+'/revoke',{reason:'Review will be too late'},'manager');assert.equal(pending.response.status,202);
  const user=f.actors.foreignMaster,hash=createHmac('sha256',secret).update(token).digest('hex');await f.pg.exec('SET ROLE kavosh_identity');assert.equal((await f.pg.query<{code:string}>('SELECT * FROM identity.accept_invite($1,$2,$3)',[hash,user.user,user.session])).rows[0].code,'ACCEPTED');await f.pg.exec('RESET ROLE');
  const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.status,'stale');assert.equal((await f.pg.query('SELECT * FROM public.human_invitation_revocations WHERE preparation_id=$1',[nextId])).rows.length,0);
  assert.equal((await f.request('invitations/'+nextId)).body.data.issue.status,'consumed');
 }finally{await f.pg.exec('RESET ROLE');await f.pg.close();}
});

test('native simultaneous cancellation retries preserve one revocation and approval effect',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
  const id=(await f.prepare(await f.person())).body.data.id;await f.token(id);const key=randomUUID(),path='invitations/'+id+'/revoke',body={reason:'Same cancellation retry'};
  const [a,b]=await Promise.all([f.request(path,body,'master',{key}),f.request(path,body,'master',{key})]);assert.equal(a.response.status,201,JSON.stringify(a.body));assert.equal(b.response.status,201,JSON.stringify(b.body));assert.deepEqual(a.body,b.body);
  assert.equal((await f.pg.query('SELECT * FROM public.human_invitation_revocations WHERE preparation_id=$1',[id])).rows.length,1);assert.equal((await f.pg.query("SELECT * FROM public.audit_events WHERE entity_id=$1 AND action='human-invitation.revoke'",[a.body.data.id])).rows.length,1);
 }finally{await f.pg.close();}
});

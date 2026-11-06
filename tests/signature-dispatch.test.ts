import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { agreementFixture,reviewedAgreementContent } from './agreement-fixture.ts';

async function fixture(){
 const f=await agreementFixture();
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['signature-sends.view','signature-sends.edit','signature-sends.execute','signature-dispatch.execute'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const binding=await reviewedAgreementContent(f),pkg=await f.prepare();assert.equal(pkg.response.status,201);
 const linked=await f.request('agreement-packages/'+pkg.body.data.id+'/content',{bindingId:binding.id,reason:'Reviewed exact test source'});assert.equal(linked.response.status,201);
 const send=await f.request('agreement-packages/'+pkg.body.data.id+'/send-requests',{attachmentId:linked.body.data.id,options:{title:'Test agreement',message:'Review',expiryDays:30},dispatchWithinMinutes:60,reason:'Test approved intention'});assert.equal(send.response.status,201);
 // Synthetic attested manifest only; no real agreement or provider invocation.
 const manifest={requestSha256:'a'.repeat(64),requestBytes:1000,documentSha256:binding.sha256},requestId=send.body.data.id;
 const reserved=await f.request('signature-send-requests/'+requestId+'/attempts',manifest);assert.equal(reserved.response.status,201);
 const attemptId=reserved.body.data.id,path='signature-send-requests/'+requestId+'/attempts/'+attemptId+'/dispatch';
 return {...f,binding,manifest,requestId,attemptId,path,start:(as='master',key?:string,input:unknown=manifest)=>f.request(path,input,as,key?{key}:{}),outcome:(input:unknown,as='master',key?:string)=>f.request(path+'/outcome',input,as,key?{key}:{})};
}
function check(name:string,run:(f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>,native=false){test(name,{skip:native&&!process.env.TEST_DATABASE_URL},async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('durable start is consumed once across retry keys and outcome observations never claim delivery or admission',async f=>{
 assert.equal((await f.request(f.path)).body.data.state,'not_started');const key=randomUUID(),made=await f.start('master',key);assert.equal(made.response.status,201,JSON.stringify(made.body));assert.equal(made.body.data.externalRequestMade,false);
 for(const k of [key,randomUUID()]){const repeated=await f.start('master',k);assert.equal(repeated.response.status,409);assert.equal(repeated.body.error.code,'SIGNATURE_DISPATCH_ALREADY_STARTED');}
 assert.equal((await f.request(f.path)).body.data.state,'started_outcome_unrecorded');const documentId=randomUUID(),outcomeKey=randomUUID(),observed=await f.outcome({state:'accepted_for_processing',documentId},'master',outcomeKey);assert.equal(observed.response.status,201,JSON.stringify(observed.body));
 assert.equal((await f.request('signature-send-requests/'+f.requestId)).body.data.state,'accepted_for_processing');assert.equal((await f.request('signature-send-requests/'+f.requestId+'/attempts')).body.externalRequestMade,null,'history cannot claim no external effect after a dispatch start');
 for(const name of ['deliveryVerified','admissionCleared','providerVerified','automaticRetryAllowed','readyToSend'])assert.equal(observed.body.data[name],false);
 assert.equal(observed.body.data.source_current,true);assert.equal(observed.body.data.document_id,documentId);assert.deepEqual((await f.outcome({state:'accepted_for_processing',documentId},'master',outcomeKey)).body,observed.body);
 assert.equal((await f.outcome({state:'outcome_unknown'})).response.status,409);assert.equal((await f.start()).response.status,409);
 const read=await f.request(f.path);assert.equal(read.body.data.state,'accepted_for_processing');assert.equal(read.body.data.reconciliationRequired,true);
 assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_starts')).rows.length,1);assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_outcomes')).rows.length,1);
});
check('unattempted and ambiguous observations both keep the durable start consumed',async f=>{
 assert.equal((await f.start('bot')).response.status,201);const observed=await f.outcome({state:'not_attempted'},'bot');assert.equal(observed.response.status,201,JSON.stringify(observed.body));assert.equal(observed.body.data.reconciliationRequired,false);assert.equal(observed.body.data.automaticRetryAllowed,false);assert.equal((await f.start('bot')).response.status,409);
});
check('a late outcome records changed authorization without silently discarding possible external effects',async f=>{
 assert.equal((await f.start()).response.status,201);
 await f.pg.query("UPDATE public.signature_send_requests SET created_at=transaction_timestamp()-interval '2 hours',authorization_until=transaction_timestamp()-interval '1 hour' WHERE id=$1",[f.requestId]);
 const result=await f.outcome({state:'outcome_unknown'});assert.equal(result.response.status,201,JSON.stringify(result.body));assert.equal(result.body.data.source_current,false);assert.equal(result.body.data.reconciliationRequired,true);assert.equal((await f.start()).response.status,409);
});
check('separate execution rights, current private sources, starter identity and tenant isolation protect starts and observations',async f=>{
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='signature-dispatch.execute'",[f.staffRole]);assert.equal((await f.start('staff')).response.status,404,'old manifest reservation permission must not grant transport coordination');
 assert.equal((await f.start('bot')).response.status,201);assert.equal((await f.outcome({state:'outcome_unknown'},'master')).response.status,404,'even master cannot impersonate the worker observation');
 assert.equal((await f.request(f.path,undefined,'foreignMaster',{academy:f.b})).response.status,404);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='files.view'",[f.managerRole]);assert.ok([403,404].includes((await f.outcome({state:'outcome_unknown'},'bot')).response.status));assert.ok([403,404].includes((await f.request(f.path,undefined,'bot')).response.status));
});
check('manifest and input validation reject before any durable consumption; an expired request cannot start',async f=>{
 for(const input of [{...f.manifest,requestSha256:'b'.repeat(64)},{...f.manifest,requestBytes:1001},{...f.manifest,documentSha256:'b'.repeat(64)}])assert.equal((await f.start('master',undefined,input)).response.status,409);
 for(const input of [{...f.manifest,url:'https://localhost'},{...f.manifest,requestBytes:0},{...f.manifest,delivered:true}])assert.equal((await f.start('master',undefined,input)).response.status,400);
 assert.equal((await f.outcome({state:'outcome_unknown'})).response.status,404);
 for(const input of [{state:'accepted_for_processing'},{state:'outcome_unknown',documentId:randomUUID()},{state:'completed'},{state:'not_attempted',source_current:true}])assert.equal((await f.outcome(input)).response.status,400);
 assert.equal((await f.request(f.path+'?extra=1')).response.status,400);assert.equal((await f.request(f.path,undefined,'master',{method:'DELETE'})).response.status,405);
 await f.pg.query("UPDATE public.signature_send_requests SET created_at=transaction_timestamp()-interval '2 hours',authorization_until=transaction_timestamp()-interval '1 hour' WHERE id=$1",[f.requestId]);assert.equal((await f.start()).body.error.code,'SIGNATURE_SEND_NOT_CURRENT');assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_starts')).rows.length,0);
});
check('audit/outbox failure rolls back complete start and outcome and allows exact-key retry',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.signature_dispatch_starts) starts,(SELECT count(*)::int FROM public.signature_dispatch_outcomes) outcomes,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events')).rows[0];
 for(const phase of ['start','outcome']){const before=await counts(),key=randomUUID(),run=()=>phase==='start'?f.start('master',key):f.outcome({state:'outcome_unknown'},'master',key);await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await run()).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}assert.deepEqual(await counts(),before);assert.equal((await run()).response.status,201);}
});
check('native records are tenant-bound, append-only, server-dated and cannot bypass audit provenance',async f=>{
 const made=await f.start();assert.equal(made.response.status,201);await f.pg.exec('SET ROLE kavosh_runtime');try{
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);
  await assert.rejects(f.pg.query('INSERT INTO public.signature_dispatch_outcomes(academy_id,id,start_id,actor_id,audit_id,state) VALUES($1,$2,$3,$4,$5,$6)',[f.a,randomUUID(),made.body.data.id,f.actors.master.person,randomUUID(),'outcome_unknown']),/SIGNATURE_DISPATCH_INVALID/);
  for(const table of ['signature_dispatch_starts','signature_dispatch_outcomes']){await assert.rejects(f.pg.exec('DELETE FROM public.'+table),/permission denied/i);await assert.rejects(f.pg.exec('UPDATE public.'+table+' SET created_at=now()'),/permission denied/i);}
  await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_starts')).rows.length,0);
 }finally{await f.pg.exec('RESET ROLE');}
});
check('tiny simultaneous starts have exactly one winner even with the same retry key',async f=>{
 const key=randomUUID(),start=performance.now(),results=await Promise.all([f.start('master',key),f.start('master',key)]);assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);assert.equal((await f.pg.query('SELECT * FROM public.signature_dispatch_starts')).rows.length,1);console.log(JSON.stringify({case:'signature-dispatch-two-request-race',elapsedMs:Math.round(performance.now()-start)}));
},true);
check('native final guard catches a signer change after API authorization and rolls back the complete start',async f=>{
 const counts=async()=>(await f.pg.query('SELECT(SELECT count(*)::int FROM public.signature_dispatch_starts) starts,(SELECT count(*)::int FROM public.audit_events) audits,(SELECT count(*)::int FROM public.outbox_events) events')).rows[0],before=await counts(),key=randomUUID();
 // Disposable database only: a real identity change between API check/INSERT.
 await f.pg.exec(`CREATE FUNCTION public.synthetic_dispatch_signer_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN UPDATE identity."user" SET "phoneNumberVerified"=false WHERE id='${f.actors.staff.user}';RETURN NEW;END $$;CREATE TRIGGER aa_synthetic_dispatch_signer_change BEFORE INSERT ON public.signature_dispatch_starts FOR EACH ROW EXECUTE FUNCTION public.synthetic_dispatch_signer_change()`);
 try{const denied=await f.start('master',key);assert.equal(denied.response.status,409,JSON.stringify(denied.body));assert.equal(denied.body.error.code,'SIGNATURE_DISPATCH_SOURCE_CHANGED');}finally{await f.pg.exec('DROP TRIGGER aa_synthetic_dispatch_signer_change ON public.signature_dispatch_starts;DROP FUNCTION public.synthetic_dispatch_signer_change()');}
 assert.deepEqual(await counts(),before);assert.equal((await f.start('master',key)).response.status,201);
},true);
